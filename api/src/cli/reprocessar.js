// Reprocessamento de job em `failed` (ADR 0005; CIT-56): `npm run reprocessar -- <jobId>`.
// Devolve o job para `waiting` com o mesmo id e as tentativas zeradas. Não usa banco
// nem CORS e nunca imprime `job.data`.
import { pathToFileURL } from 'node:url'
import { Job } from 'bullmq'
import { carregarConfigFila } from '../config.js'
import { criarConexaoProdutor } from '../fila/conexao.js'
import { criarFilas } from '../fila/filas.js'

// Ids do BullMQ (números ou `jobId` próprio, ex.: `alerta-<id>-<ts>`); outro formato
// nem chega ao Redis.
const JOB_ID_VALIDO = /^[\w-]{1,64}$/

// Com o Redis fora, o BullMQ espera a conexão indefinidamente: a CLI desiste antes.
const LIMITE_MS = 10000

/**
 * @returns {Promise<number>} 0 reenfileirado; 1 uso, `jobId` inválido ou job não
 *   encontrado; 2 fora de `failed`.
 */
export async function reprocessar({ filas, jobId, saida = process.stdout }) {
  if (!jobId) {
    saida.write('uso: npm run reprocessar -- <jobId>\n')
    return 1
  }
  if (!JOB_ID_VALIDO.test(jobId)) {
    saida.write('jobId inválido: use só letras, números, _ e - (até 64 caracteres)\n')
    return 1
  }
  const job = await Job.fromId(filas.jobs, jobId)
  if (!job) {
    saida.write('job não encontrado\n')
    return 1
  }
  const estado = await job.getState()
  if (estado !== 'failed') {
    saida.write(`job não está em failed (estado: ${estado})\n`)
    return 2
  }
  await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true })
  saida.write(`job ${job.id} reenfileirado\n`)
  return 0
}

async function main() {
  let config
  try {
    config = carregarConfigFila()
  } catch (erro) {
    console.error(`Configuração inválida: ${erro.message}`)
    return 1
  }
  const conexao = criarConexaoProdutor(config.redisUrl)
  // Erro do ioredis traz host e porta: só o nome vai à saída de erro.
  const log = { error: (campos, mensagem) => console.error(`${mensagem}: ${campos.erro}`) }
  const filas = criarFilas({
    conexao,
    prefixo: config.filaPrefixo,
    tentativas: config.filaTentativas,
    backoffMs: config.filaBackoffMs,
    log
  })
  let timer
  try {
    return await Promise.race([
      reprocessar({ filas, jobId: process.argv[2] }),
      new Promise((_, rejeitar) => {
        timer = setTimeout(() => rejeitar(Object.assign(new Error('limite'), { name: 'TimeoutError' })), LIMITE_MS)
      })
    ])
  } catch (erro) {
    console.error(`falha ao reprocessar: ${erro?.name}`)
    return 1
  } finally {
    clearTimeout(timer)
    conexao.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
