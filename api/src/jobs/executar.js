import { randomUUID } from 'node:crypto'
import { UnrecoverableError } from 'bullmq'

// Nome e código do erro só entram no erro saneado neste formato (sem texto livre).
const IDENTIFICADOR = /^[\w.-]{1,64}$/

/**
 * Erro devolvido à fila no lugar do original: a mensagem vira `failedReason` e o
 * evento `failed` no Redis (até 30 dias) e pode trazer dado pessoal. Leva só o nome
 * (`name`, fora do formato → `Error`) e o `code` (string ou número), se houver:
 * mensagem `<name>` ou `<name> (<code>)`. `UnrecoverableError` continua
 * `UnrecoverableError` (o BullMQ pula as tentativas restantes).
 */
export function erroSaneado(err) {
  const nome = typeof err?.name === 'string' && IDENTIFICADOR.test(err.name) ? err.name : 'Error'
  const codigoBruto = err?.code
  const codigo = (typeof codigoBruto === 'string' || typeof codigoBruto === 'number') &&
    IDENTIFICADOR.test(String(codigoBruto))
    ? String(codigoBruto)
    : undefined
  const mensagem = codigo === undefined ? nome : `${nome} (${codigo})`
  const irrecuperavel = err instanceof UnrecoverableError || nome === 'UnrecoverableError'
  const saneado = irrecuperavel ? new UnrecoverableError(mensagem) : new Error(mensagem)
  saneado.name = nome
  if (codigo !== undefined) saneado.code = codigo
  return saneado
}

/**
 * Roda um job com log correlacionado (ADR 0013, item 8; CIT-55): `job iniciado`,
 * `job concluído` (com `duracaoMs`) ou `job falhou`, todas com `reqId` e `job`.
 * Os dados do job nunca são logados aqui. O erro original vai ao log (pelo
 * serializador) e é relançado SANEADO (`erroSaneado`): a fila precisa de um erro
 * para a nova tentativa, mas não guarda a mensagem original.
 *
 * @param {object} opcoes
 * @param {string} opcoes.nome Nome do job (campo `job` do log).
 * @param {string} [opcoes.correlacaoId] `reqId` da requisição de origem; ausente → UUID novo.
 * @param {import('fastify').FastifyBaseLogger} opcoes.log Logger RAIZ (`app.log` ou o do
 *   worker), nunca `request.log`: este já tem `reqId` e o `child` repetiria a chave
 *   (lança `TypeError`).
 * @param {(contexto: { log: import('fastify').FastifyBaseLogger }) => Promise<unknown>} fn
 *   Corpo do job; deve logar só pelo `log` recebido, para manter o `reqId`.
 */
export async function executarJob({ nome, correlacaoId, log }, fn) {
  if (log.bindings?.()?.reqId !== undefined) {
    throw new TypeError('executarJob: use o logger raiz, não request.log')
  }
  const filho = log.child({ reqId: correlacaoId ?? randomUUID(), job: nome })
  const inicio = performance.now()
  filho.info('job iniciado')
  try {
    const resultado = await fn({ log: filho })
    filho.info({ duracaoMs: Math.max(0, Math.round(performance.now() - inicio)) }, 'job concluído')
    return resultado
  } catch (err) {
    filho.error({ err }, 'job falhou')
    throw erroSaneado(err)
  }
}
