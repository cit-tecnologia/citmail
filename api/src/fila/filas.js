// Filas da aplicação (ADR 0005; CIT-56): `jobs` (negócio) e `alertas` (Telegram).
// Fila própria para alerta porque o limitador do BullMQ vale por fila: o limite de
// alertas por minuto não pode frear jobs de negócio.
// `job.data` leva só ids (`requestId`, `pedidoId`...), nunca dado pessoal: falhos
// ficam até 30 dias no Redis.
import { Queue } from 'bullmq'

const UM_DIA_S = 86400
const TRINTA_DIAS_S = 2592000

// Erro do ioredis traz host e porta: só `err.name` vai ao log.
export function registrarErroDaFila(fila, log) {
  fila.on('error', (err) => log.error({ erro: err?.name, fila: fila.name }, 'erro na fila'))
}

/**
 * Cria as filas `jobs` e `alertas` com tentativas, backoff exponencial e retenção
 * (Redis em `noeviction` não pode crescer sem limite). `log` é obrigatório: sem
 * listener de `error`, o BullMQ manda o erro do ioredis (com host e porta) ao console.
 *
 * @returns {{ jobs: Queue, alertas: Queue, close: () => Promise<void> }}
 */
export function criarFilas({ conexao, prefixo, tentativas, backoffMs, alertaTentativas = 5, alertaBackoffMs = 30000, log }) {
  const jobs = new Queue('jobs', {
    connection: conexao,
    prefix: prefixo,
    defaultJobOptions: {
      attempts: tentativas,
      backoff: { type: 'exponential', delay: backoffMs },
      removeOnComplete: { age: UM_DIA_S, count: 1000 },
      removeOnFail: { age: TRINTA_DIAS_S, count: 10000 }
    }
  })
  const alertas = new Queue('alertas', {
    connection: conexao,
    prefix: prefixo,
    defaultJobOptions: {
      attempts: alertaTentativas,
      backoff: { type: 'exponential', delay: alertaBackoffMs },
      removeOnComplete: { age: UM_DIA_S, count: 1000 },
      removeOnFail: { age: TRINTA_DIAS_S, count: 1000 }
    }
  })
  registrarErroDaFila(jobs, log)
  registrarErroDaFila(alertas, log)
  return {
    jobs,
    alertas,
    async close() {
      await Promise.all([jobs.close(), alertas.close()])
    }
  }
}
