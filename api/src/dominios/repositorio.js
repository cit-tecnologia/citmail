// Acesso a `tarefa_dominio` e às datas de registro de `pedido_dominio` e `pedido`
// (E4-H4; CIT-77). `executor` é um Pool ou o Client de uma transação. Datas `date` saem
// em texto (`::text`): o `pg` as converteria em Date no fuso local. Nenhuma função loga.

// Situação da fatura anual dos domínios para a referência `ref` (decisão 8 do plano):
// `paga` se o bruto do webhook guarda um pagamento recebido da assinatura `dominios` do
// pedido `p` vencendo entre `ref - 60` e `ref + 30` dias; senão `pendente`.
function situacaoFaturaSql(ref) {
  return `CASE WHEN EXISTS (
            SELECT 1 FROM assinatura a JOIN asaas_webhook_evento e ON e.assinatura_id = a.asaas_assinatura_id
             WHERE a.pedido_id = p.id AND a.tipo = 'dominios'
               AND e.status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
               AND e.vencimento BETWEEN ${ref} - 60 AND ${ref} + 30
          ) THEN 'paga' ELSE 'pendente' END`
}

// Consumidor de `dominio_pago`: uma tarefa `registro` por domínio novo do pedido. Devolve
// quantas foram criadas (0 no reprocessamento).
export async function inserirTarefasRegistro(executor, pedidoId) {
  const resultado = await executor.query(
    `INSERT INTO tarefa_dominio (pedido_dominio_id, tipo)
     SELECT id, 'registro' FROM pedido_dominio WHERE pedido_id = $1 AND tipo = 'novo'
     ON CONFLICT DO NOTHING`,
    [pedidoId]
  )
  return resultado.rowCount
}

// Aviso de abertura: pedidos com tarefa `registro` ainda não alertada, com as tarefas do grupo.
export async function buscarRegistrosNaoAlertados(executor, lote) {
  const resultado = await executor.query(
    `SELECT pd.pedido_id, p.estado AS pedido_estado, array_agg(t.id ORDER BY t.id) AS tarefas
       FROM tarefa_dominio t
       JOIN pedido_dominio pd ON pd.id = t.pedido_dominio_id
       JOIN pedido p ON p.id = pd.pedido_id
      WHERE t.tipo = 'registro' AND t.alertada_em IS NULL
      GROUP BY pd.pedido_id, p.estado
      ORDER BY min(t.aberta_em), pd.pedido_id
      LIMIT $1`,
    [lote]
  )
  return resultado.rows
}

export async function marcarAlertadas(executor, ids, agora) {
  await executor.query(
    'UPDATE tarefa_dominio SET alertada_em = $2 WHERE id = ANY($1) AND alertada_em IS NULL',
    [ids, agora]
  )
}

// Lembrete: tarefas `registro` abertas de pedido em `aguardando_registro_de_dominio`, sem
// lembrete na data local `hoje`. A regra dos dias úteis é aplicada pelo laço.
export async function buscarCandidatosLembrete(executor, hoje, lote) {
  const resultado = await executor.query(
    `SELECT t.id, pd.pedido_id, t.aberta_em
       FROM tarefa_dominio t
       JOIN pedido_dominio pd ON pd.id = t.pedido_dominio_id
       JOIN pedido p ON p.id = pd.pedido_id
      WHERE t.tipo = 'registro' AND t.concluida_em IS NULL
        AND p.estado = 'aguardando_registro_de_dominio'
        AND (t.ultimo_lembrete_em IS NULL
             OR (t.ultimo_lembrete_em AT TIME ZONE 'America/Sao_Paulo')::date < $1::date)
      ORDER BY t.ultimo_lembrete_em NULLS FIRST, t.aberta_em, t.id
      LIMIT $2`,
    [hoje, lote]
  )
  return resultado.rows
}

export async function marcarLembrete(executor, ids, agora) {
  await executor.query('UPDATE tarefa_dominio SET ultimo_lembrete_em = $2 WHERE id = ANY($1)', [ids, agora])
}

// Renovação D-30: abre uma tarefa `renovacao` por domínio com vencimento até `hoje + 30`,
// de pedido não cancelado, ainda sem tarefa para essa referência. Devolve quantas abriu.
export async function abrirRenovacoes(executor, hoje, lote) {
  const resultado = await executor.query(
    `INSERT INTO tarefa_dominio (pedido_dominio_id, tipo, referencia_expira_em, situacao_fatura)
     SELECT pd.id, 'renovacao', pd.registro_expira_em, ${situacaoFaturaSql('pd.registro_expira_em')}
       FROM pedido_dominio pd JOIN pedido p ON p.id = pd.pedido_id
      WHERE pd.registro_expira_em IS NOT NULL AND pd.registro_expira_em - 30 <= $1::date
        AND p.estado <> 'cancelado'
        AND NOT EXISTS (
          SELECT 1 FROM tarefa_dominio t
           WHERE t.pedido_dominio_id = pd.id AND t.tipo = 'renovacao' AND t.referencia_expira_em = pd.registro_expira_em
        )
      ORDER BY pd.registro_expira_em, pd.id
      LIMIT $2
     ON CONFLICT DO NOTHING`,
    [hoje, lote]
  )
  return resultado.rowCount
}

// Aviso da renovação: tarefas `renovacao` ainda não alertadas.
export async function buscarRenovacoesNaoAlertadas(executor, lote) {
  const resultado = await executor.query(
    `SELECT t.id, pd.pedido_id, p.estado AS pedido_estado, t.situacao_fatura
       FROM tarefa_dominio t
       JOIN pedido_dominio pd ON pd.id = t.pedido_dominio_id
       JOIN pedido p ON p.id = pd.pedido_id
      WHERE t.tipo = 'renovacao' AND t.alertada_em IS NULL
      ORDER BY t.aberta_em, t.id
      LIMIT $1`,
    [lote]
  )
  return resultado.rows
}

// `listar`: tarefas abertas, sem dado do titular; `todas` inclui as de pedido cancelado.
export async function listarAbertas(executor, { todas = false } = {}) {
  const resultado = await executor.query(
    `SELECT t.id, t.tipo, pd.pedido_id, p.estado AS pedido_estado, pd.nome AS dominio, t.aberta_em,
            t.referencia_expira_em::text AS referencia_expira_em
       FROM tarefa_dominio t
       JOIN pedido_dominio pd ON pd.id = t.pedido_dominio_id
       JOIN pedido p ON p.id = pd.pedido_id
      WHERE t.concluida_em IS NULL AND ($1 OR p.estado <> 'cancelado')
      ORDER BY t.aberta_em, t.id`,
    [todas]
  )
  return resultado.rows
}

// `mostrar`: domínio, vencimento, situação da fatura recalculada (só na renovação) e titular.
export async function buscarDetalheTarefa(executor, tarefaId) {
  const resultado = await executor.query(
    `SELECT t.id, t.tipo, t.concluida_em, t.aberta_em, t.referencia_expira_em::text AS referencia_expira_em,
            pd.pedido_id, p.estado AS pedido_estado, pd.nome AS dominio, pd.registro_expira_em::text AS registro_expira_em,
            CASE WHEN t.tipo = 'renovacao' THEN ${situacaoFaturaSql('t.referencia_expira_em')} END AS situacao_fatura,
            c.id AS cliente_id, c.nome AS titular_nome, c.tipo_pessoa AS titular_tipo_pessoa,
            c.documento AS titular_documento, c.email AS titular_email, c.telefone AS titular_telefone
       FROM tarefa_dominio t
       JOIN pedido_dominio pd ON pd.id = t.pedido_dominio_id
       JOIN pedido p ON p.id = pd.pedido_id
       JOIN cliente c ON c.id = p.cliente_id
      WHERE t.id = $1`,
    [tarefaId]
  )
  return resultado.rows[0] ?? null
}

// Leitura sem trava (passo a da decisão 4), para saber qual pedido travar.
export async function buscarTarefa(executor, tarefaId) {
  const resultado = await executor.query(
    `SELECT t.id, t.tipo, t.pedido_dominio_id, pd.pedido_id
       FROM tarefa_dominio t JOIN pedido_dominio pd ON pd.id = t.pedido_dominio_id
      WHERE t.id = $1`,
    [tarefaId]
  )
  return resultado.rows[0] ?? null
}

// Releitura com trava, depois da trava do pedido (mesma ordem no webhook e na CLI).
export async function travarTarefa(executor, tarefaId) {
  const resultado = await executor.query(
    'SELECT id, tipo, pedido_dominio_id, concluida_em FROM tarefa_dominio WHERE id = $1 FOR UPDATE',
    [tarefaId]
  )
  return resultado.rows[0] ?? null
}

export async function concluirTarefa(executor, tarefaId) {
  await executor.query('UPDATE tarefa_dominio SET concluida_em = now() WHERE id = $1', [tarefaId])
}

// Registro: grava a data do registro e o vencimento no Registro.br.
export async function marcarDominioRegistrado(executor, pedidoDominioId, expiraEm) {
  await executor.query(
    'UPDATE pedido_dominio SET registrado_em = now(), registro_expira_em = $2::date WHERE id = $1',
    [pedidoDominioId, expiraEm]
  )
}

// Renovação: só o novo vencimento (`registrado_em` guarda o registro original).
export async function marcarDominioRenovado(executor, pedidoDominioId, expiraEm) {
  await executor.query('UPDATE pedido_dominio SET registro_expira_em = $2::date WHERE id = $1', [pedidoDominioId, expiraEm])
}

// Domínios novos do pedido ainda sem registro (contados dentro da trava do pedido).
export async function contarNovosNaoRegistrados(executor, pedidoId) {
  const resultado = await executor.query(
    `SELECT count(*)::int AS total FROM pedido_dominio
      WHERE pedido_id = $1 AND tipo = 'novo' AND registrado_em IS NULL`,
    [pedidoId]
  )
  return resultado.rows[0].total
}

export async function marcarPedidoDominioRegistrado(executor, pedidoId) {
  await executor.query('UPDATE pedido SET dominio_registrado_em = now() WHERE id = $1', [pedidoId])
}
