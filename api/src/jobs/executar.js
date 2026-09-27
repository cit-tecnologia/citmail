import { randomUUID } from 'node:crypto'

/**
 * Roda um job com log correlacionado (ADR 0013, item 8; CIT-55): `job iniciado`,
 * `job concluído` (com `duracaoMs`) ou `job falhou`, todas com `reqId` e `job`.
 * Os dados do job nunca são logados aqui. O erro é relançado (a fila precisa dele
 * para a nova tentativa).
 *
 * @param {object} opcoes
 * @param {string} opcoes.nome Nome do job (campo `job` do log).
 * @param {string} [opcoes.correlacaoId] `reqId` da requisição de origem; ausente → UUID novo.
 * @param {import('fastify').FastifyBaseLogger} opcoes.log Logger RAIZ (`app.log` ou o do
 *   worker), nunca `request.log`: este já tem `reqId` e o `child` repetiria a chave.
 * @param {(contexto: { log: import('fastify').FastifyBaseLogger }) => Promise<unknown>} fn
 *   Corpo do job; deve logar só pelo `log` recebido, para manter o `reqId`.
 */
export async function executarJob({ nome, correlacaoId, log }, fn) {
  const filho = log.child({ reqId: correlacaoId ?? randomUUID(), job: nome })
  const inicio = performance.now()
  filho.info('job iniciado')
  try {
    const resultado = await fn({ log: filho })
    filho.info({ duracaoMs: Math.max(0, Math.round(performance.now() - inicio)) }, 'job concluído')
    return resultado
  } catch (err) {
    filho.error({ err }, 'job falhou')
    throw err
  }
}
