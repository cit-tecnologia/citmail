// Gravação na tabela `auditoria` (só inclusão). `executor` é um Pool ou um Client:
// com Client em transação, o registro é atômico com a ação do chamador.
export async function inserirAuditoria(executor, linha) {
  const resultado = await executor.query(
    `INSERT INTO auditoria
       (autor_tipo, autor_id, acao, alvo_tipo, alvo_id, resultado, ip, request_id, detalhes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      linha.autorTipo,
      linha.autorId,
      linha.acao,
      linha.alvoTipo,
      linha.alvoId,
      linha.resultado,
      linha.ip,
      linha.requestId,
      linha.detalhes
    ]
  )
  // bigint chega do pg como string.
  return resultado.rows[0].id
}
