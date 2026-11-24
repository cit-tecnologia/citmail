// Acesso a `email_envio` (ADR 0010; CIT-65). `executor` é um Pool ou o Client de uma
// transação. Nenhuma função recebe ou grava endereço em claro, assunto ou corpo.

// Grava o pedido de envio; a mesma `chave_idempotencia` repetida não grava de novo.
// Devolve `{ id, criado }`.
export async function inserirEnvioSeNovo(executor, { eventoId, chaveIdempotencia, modelo, versaoModelo, refs }) {
  const resultado = await executor.query(
    `INSERT INTO email_envio (evento_id, chave_idempotencia, modelo, versao_modelo, refs)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (chave_idempotencia) DO NOTHING
     RETURNING id`,
    [eventoId, chaveIdempotencia, modelo, versaoModelo, refs]
  )
  if (resultado.rows.length > 0) return { id: resultado.rows[0].id, criado: true }
  const existente = await executor.query('SELECT id FROM email_envio WHERE chave_idempotencia = $1', [chaveIdempotencia])
  return { id: existente.rows[0]?.id ?? null, criado: false }
}

// Enfileirador: os pendentes ainda não enfileirados, na ordem de criação.
export async function buscarPendentesNaoEnfileirados(executor, lote) {
  const resultado = await executor.query(
    `SELECT id, geracao FROM email_envio
      WHERE estado = 'pendente' AND enfileirado_em IS NULL
      ORDER BY criado_em, id
      LIMIT $1`,
    [lote]
  )
  return resultado.rows
}

export async function marcarEnfileirados(executor, ids) {
  await executor.query(
    `UPDATE email_envio SET enfileirado_em = now()
      WHERE id = ANY($1) AND estado = 'pendente' AND enfileirado_em IS NULL`,
    [ids]
  )
}

export async function buscarEnvio(executor, id) {
  const resultado = await executor.query(
    `SELECT id, modelo, versao_modelo, refs, estado, geracao, tentativas
       FROM email_envio WHERE id = $1`,
    [id]
  )
  return resultado.rows[0] ?? null
}

// Aceite do SMTP. Só sai de `pendente` na mesma geração: false se outra execução ou um
// reset já mudou a linha.
export async function marcarEnviado(executor, id, geracao, { destinatarioMascarado, messageId }) {
  const resultado = await executor.query(
    `UPDATE email_envio
        SET estado = 'enviado', enviado_em = now(), message_id = $3, destinatario_mascarado = $4,
            tentativas = tentativas + 1, erro_codigo = NULL
      WHERE id = $1 AND estado = 'pendente' AND geracao = $2
      RETURNING id`,
    [id, geracao, messageId, destinatarioMascarado]
  )
  return resultado.rowCount > 0
}

// Falha de envio: soma a tentativa e grava o código. `definitiva` → `falhou`; senão a
// linha continua `pendente` (nova tentativa pela fila).
export async function marcarFalha(executor, id, geracao, { erroCodigo, destinatarioMascarado, definitiva }) {
  const resultado = await executor.query(
    `UPDATE email_envio
        SET estado = CASE WHEN $5 THEN 'falhou' ELSE estado END,
            tentativas = tentativas + 1, erro_codigo = $3,
            destinatario_mascarado = COALESCE($4, destinatario_mascarado)
      WHERE id = $1 AND estado = 'pendente' AND geracao = $2
      RETURNING id`,
    [id, geracao, erroCodigo, destinatarioMascarado ?? null, definitiva === true]
  )
  return resultado.rowCount > 0
}

// Sem envio: transporte desligado (`erroCodigo` nulo) ou modelo sem destinatário
// (`SEM_DESTINATARIO`). Não soma tentativa.
export async function marcarNaoEnviado(executor, id, geracao, erroCodigo = null) {
  const resultado = await executor.query(
    `UPDATE email_envio SET estado = 'nao_enviado', erro_codigo = $3
      WHERE id = $1 AND estado = 'pendente' AND geracao = $2
      RETURNING id`,
    [id, geracao, erroCodigo]
  )
  return resultado.rowCount > 0
}

// Pendentes ainda sem alerta (`email_parado`): enfileirados há mais de `horas`, ou
// criados há mais de `horas` e nunca enfileirados (Redis fora por muito tempo).
export async function buscarParados(executor, horas, lote) {
  const resultado = await executor.query(
    `SELECT id, geracao FROM email_envio
      WHERE estado = 'pendente' AND alertado_parado_em IS NULL
        AND (enfileirado_em < now() - make_interval(hours => $1)
             OR (enfileirado_em IS NULL AND criado_em < now() - make_interval(hours => $1)))
      ORDER BY criado_em, id
      LIMIT $2`,
    [horas, lote]
  )
  return resultado.rows
}

export async function marcarAlertadoParado(executor, ids) {
  await executor.query('UPDATE email_envio SET alertado_parado_em = now() WHERE id = ANY($1)', [ids])
}

// Reenvio por geração (decisão 10): só `falhou` ou `nao_enviado`. false se a linha não
// existe ou está em outro estado. A equipe usa o mesmo UPDATE por SQL (api/README.md).
export async function reiniciarEnvio(executor, id) {
  const resultado = await executor.query(
    `UPDATE email_envio
        SET estado = 'pendente', geracao = geracao + 1, enfileirado_em = NULL, tentativas = 0,
            erro_codigo = NULL, alertado_parado_em = NULL
      WHERE id = $1 AND estado IN ('falhou', 'nao_enviado')`,
    [id]
  )
  return resultado.rowCount > 0
}
