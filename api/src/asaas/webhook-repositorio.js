// Acesso a `asaas_webhook_evento` (evento bruto do webhook do Asaas) e às leituras de
// pedido e assinatura do processamento (ADR 0015; CIT-64). `executor` é um Pool ou o
// Client de uma transação. Datas `date` saem em texto (`::text`): o `pg` as converteria
// em Date no fuso local.

// Lista branca (decisão 4 do plano): só estas colunas recebem dados do corpo.
// null se o `asaas_evento_id` já foi gravado (evento repetido).
export async function inserirBruto(executor, bruto) {
  const resultado = await executor.query(
    `INSERT INTO asaas_webhook_evento (asaas_evento_id, evento, request_id, pagamento_id, assinatura_id,
                                       referencia_externa, status, billing_type, valor_centavos, vencimento, pago_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date)
     ON CONFLICT (asaas_evento_id) DO NOTHING
     RETURNING id`,
    [
      bruto.asaasEventoId, bruto.evento, bruto.requestId, bruto.pagamentoId, bruto.assinaturaId,
      bruto.referenciaExterna, bruto.status, bruto.billingType, bruto.valorCentavos, bruto.vencimento, bruto.pagoEm
    ]
  )
  return resultado.rows[0]?.id ?? null
}

const COLUNAS_BRUTO = `id, asaas_evento_id, evento, request_id, pagamento_id, assinatura_id, referencia_externa,
  status, valor_centavos, vencimento::text AS vencimento, situacao`

export async function buscarBruto(executor, id) {
  const resultado = await executor.query(`SELECT ${COLUNAS_BRUTO} FROM asaas_webhook_evento WHERE id = $1`, [id])
  return resultado.rows[0] ?? null
}

// Trava do bruto na transação do efeito; a `situacao` é relida depois da trava.
export async function travarBruto(executor, id) {
  const resultado = await executor.query(
    'SELECT situacao FROM asaas_webhook_evento WHERE id = $1 FOR UPDATE',
    [id]
  )
  return resultado.rows[0] ?? null
}

// Resultado terminal. Só sai de `pendente`: false se outro processamento já gravou.
export async function marcarResultado(executor, id, situacao, codigo) {
  const resultado = await executor.query(
    `UPDATE asaas_webhook_evento SET situacao = $2, codigo = $3, processado_em = now()
      WHERE id = $1 AND situacao = 'pendente'`,
    [id, situacao, codigo]
  )
  return resultado.rowCount > 0
}

// Enfileirador: os ainda não enfileirados, na ordem de chegada (índice parcial).
export async function buscarNaoEnfileirados(executor, lote) {
  const resultado = await executor.query(
    `SELECT id, request_id FROM asaas_webhook_evento
      WHERE enfileirado_em IS NULL
      ORDER BY recebido_em, id
      LIMIT $1`,
    [lote]
  )
  return resultado.rows
}

export async function marcarEnfileirados(executor, ids) {
  await executor.query('UPDATE asaas_webhook_evento SET enfileirado_em = now() WHERE id = ANY($1)', [ids])
}

// Brutos `pendente` ainda sem alerta (`webhook_parado`): enfileirados há mais de 1 hora
// ou recebidos há mais de 1 hora e nunca enfileirados (Redis fora por muito tempo).
export async function buscarParados(executor, lote) {
  const resultado = await executor.query(
    `SELECT id FROM asaas_webhook_evento
      WHERE situacao = 'pendente' AND alertado_pendente_em IS NULL
        AND (enfileirado_em < now() - interval '1 hour'
             OR (enfileirado_em IS NULL AND recebido_em < now() - interval '1 hour'))
      ORDER BY recebido_em, id
      LIMIT $1`,
    [lote]
  )
  return resultado.rows
}

// true se outro bruto de evento pago do mesmo pagamento já foi processado com efeito.
export async function pagamentoJaAplicado(executor, pagamentoId, brutoId) {
  const resultado = await executor.query(
    `SELECT 1 FROM asaas_webhook_evento
      WHERE pagamento_id = $1 AND id <> $2 AND situacao = 'processado'
        AND evento IN ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED')
      LIMIT 1`,
    [pagamentoId, brutoId]
  )
  return resultado.rows.length > 0
}

export async function marcarAlertadoPendente(executor, ids) {
  await executor.query('UPDATE asaas_webhook_evento SET alertado_pendente_em = now() WHERE id = ANY($1)', [ids])
}

// Assinatura local pelo id do Asaas, com o estado do pedido (leitura sem trava).
export async function buscarAssinaturaPorAsaasId(executor, asaasAssinaturaId) {
  const resultado = await executor.query(
    `SELECT a.id, a.pedido_id, a.cliente_id, a.tipo, a.ciclo, a.valor_centavos, a.asaas_assinatura_id,
            p.estado AS pedido_estado
       FROM assinatura a JOIN pedido p ON p.id = a.pedido_id
      WHERE a.asaas_assinatura_id = $1`,
    [asaasAssinaturaId]
  )
  return resultado.rows[0] ?? null
}

export async function buscarEstadoDoPedido(executor, pedidoId) {
  const resultado = await executor.query('SELECT estado FROM pedido WHERE id = $1', [pedidoId])
  return resultado.rows[0]?.estado ?? null
}

// Trava do pedido na transação do efeito, relendo o estado.
export async function travarPedido(executor, pedidoId) {
  const resultado = await executor.query(
    `SELECT id, cliente_id, estado, ciclo, fatura_retida, dominio_pago_em, contato_email,
            EXISTS (SELECT 1 FROM pedido_dominio WHERE pedido_id = pedido.id AND tipo = 'novo') AS tem_dominio_novo
       FROM pedido WHERE id = $1 FOR UPDATE`,
    [pedidoId]
  )
  return resultado.rows[0] ?? null
}

export async function mudarEstadoDoPedido(executor, pedidoId, estado) {
  await executor.query('UPDATE pedido SET estado = $2 WHERE id = $1', [pedidoId, estado])
}

// 1º pagamento dos domínios; com o pedido em `aguardando_pagamento_do_dominio`, passa
// a `aguardando_registro_de_dominio` no mesmo comando.
export async function marcarDominioPago(executor, pedidoId) {
  await executor.query(
    `UPDATE pedido SET dominio_pago_em = now(),
            estado = CASE WHEN estado = 'aguardando_pagamento_do_dominio' THEN 'aguardando_registro_de_dominio' ELSE estado END
      WHERE id = $1`,
    [pedidoId]
  )
}
