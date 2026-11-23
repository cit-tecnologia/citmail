// Acesso às tabelas `evento` e `evento_processado` (CIT-166). `executor` é um Pool ou
// um Client; a gravação do evento e a marca do consumidor vão sempre pelo Client da
// transação do chamador.

// Grava o evento; com a chave de idempotência já gravada, devolve o id existente.
export async function inserirEvento(executor, linha) {
  const resultado = await executor.query(
    `INSERT INTO evento (nome, versao, agregado_tipo, agregado_id, chave_idempotencia, payload, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (chave_idempotencia) DO NOTHING
     RETURNING id`,
    [linha.nome, linha.versao, linha.agregadoTipo, linha.agregadoId, linha.chaveIdempotencia, linha.payload, linha.requestId]
  )
  if (resultado.rows.length > 0) return { id: resultado.rows[0].id, criado: true }
  const existente = await executor.query(
    'SELECT id FROM evento WHERE chave_idempotencia = $1',
    [linha.chaveIdempotencia]
  )
  return { id: existente.rows[0].id, criado: false }
}

export async function buscarEvento(executor, id) {
  const resultado = await executor.query(
    `SELECT id, nome, versao, agregado_tipo, agregado_id, chave_idempotencia, payload, request_id, ocorrido_em
       FROM evento WHERE id = $1`,
    [id]
  )
  return resultado.rows[0] ?? null
}

// Pendentes do publicador, na ordem de ocorrência (índice `evento_pendente_idx`).
export async function buscarPendentes(executor, lote) {
  const resultado = await executor.query(
    `SELECT id, nome, request_id FROM evento
      WHERE publicado_em IS NULL
      ORDER BY ocorrido_em, id
      LIMIT $1`,
    [lote]
  )
  return resultado.rows
}

// true se a marca foi gravada agora; false se o consumidor já tinha processado o evento.
// Entrega concorrente: a 2ª espera o bloqueio da linha única e cai no DO NOTHING.
export async function marcarProcessado(executor, consumidor, eventoId) {
  const resultado = await executor.query(
    `INSERT INTO evento_processado (consumidor, evento_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [consumidor, eventoId]
  )
  return resultado.rows.length > 0
}

export async function marcarPublicados(executor, ids) {
  await executor.query('UPDATE evento SET publicado_em = now() WHERE id = ANY($1)', [ids])
}

export async function contarFalhaDePublicacao(executor, ids) {
  await executor.query(
    'UPDATE evento SET tentativas_publicacao = tentativas_publicacao + 1 WHERE id = ANY($1)',
    [ids]
  )
}
