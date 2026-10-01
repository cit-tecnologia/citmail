// Workers da fila (ADR 0005; CIT-56): `jobs` roda os handlers com log correlacionado e,
// quando um job chega a `failed`, enfileira o alerta em `alertas`, que envia com
// limite por minuto (o excedente espera; nada é descartado, ADR 0011).
import { Job, UnrecoverableError, Worker } from 'bullmq'
import { executarJob } from '../jobs/executar.js'
import { jobExemplo } from '../jobs/exemplo.js'

export const handlersPadrao = { exemplo: jobExemplo }

// 20 por minuto: o limite do Telegram por grupo.
export const LIMITE_ALERTAS = { max: 20, duration: 60000 }

// Erro do ioredis traz host e porta: só `err.name` vai ao log.
function registrarErroDoWorker(worker, log) {
  worker.on('error', (err) => log.error({ erro: err?.name, fila: worker.name }, 'erro no worker'))
}

// Decide pelo estado (não por `attemptsMade >= attempts`): cobre tentativas esgotadas
// e `UnrecoverableError`. Nunca rejeita (listener de evento).
export function criarAvisoDeEsgotado({ filas, log }) {
  return async function aoFalhar(job) {
    try {
      // No stalled o evento pode trazer só o id: sem `Job`, o alerta se perde (risco
      // aceito no ADR 0005; o job continua em `failed` e reprocessável).
      if (typeof job?.getState !== 'function') return
      if (await job.getState() !== 'failed') return
      let finalizadoEm = job.finishedOn
      if (!finalizadoEm) {
        finalizadoEm = (await Job.fromId(filas.jobs, job.id))?.finishedOn
      }
      if (!finalizadoEm) {
        log.error({ jobId: job.id }, 'alerta não enfileirado')
        return
      }
      // `jobId` deduplica o mesmo esgotamento; reprocessado e esgotado de novo, alerta novo.
      await filas.alertas.add('job_esgotado',
        { jobId: job.id, job: job.name, pedidoId: job.data?.pedidoId },
        { jobId: `alerta-${job.id}-${finalizadoEm}` })
    } catch (err) {
      log.error({ erro: err?.name, jobId: job?.id }, 'alerta não enfileirado')
    }
  }
}

/**
 * Cria os workers de `jobs` e `alertas`. `opcoesWorker` (`lockDuration`,
 * `stalledInterval`, `limiter`...) só nos testes; em produção, os padrões do BullMQ
 * e o limite de alertas acima.
 *
 * @returns {{ jobs: Worker, alertas: Worker, close: () => Promise<void> }}
 */
export function criarWorkers({ conexao, filas, prefixo, log, handlers = handlersPadrao, enviarAlerta, opcoesWorker = {} }) {
  const { limiter = LIMITE_ALERTAS, ...opcoesComuns } = opcoesWorker

  const jobs = new Worker('jobs', async (job) => {
    const handler = Object.hasOwn(handlers, job.name) ? handlers[job.name] : undefined
    if (typeof handler !== 'function') {
      // Vai a `failed` na hora (sem as tentativas) e gera alerta.
      log.error({ jobId: job.id }, 'job desconhecido')
      throw new UnrecoverableError('job desconhecido')
    }
    return executarJob({ nome: job.name, correlacaoId: job.data?.requestId, log },
      (contexto) => handler(contexto, job.data))
  }, { ...opcoesComuns, connection: conexao, prefix: prefixo })

  // Sem listener de esgotado aqui: alerta que falha não gera outro alerta.
  const alertas = new Worker('alertas', async (job) => {
    await enviarAlerta(job.data)
  }, { ...opcoesComuns, limiter, connection: conexao, prefix: prefixo })

  jobs.on('failed', criarAvisoDeEsgotado({ filas, log }))
  alertas.on('failed', async (job) => {
    try {
      if (typeof job?.getState !== 'function') return
      if (await job.getState() === 'failed') {
        log.error({ jobId: job.data?.jobId }, 'alerta falhou')
      }
    } catch (err) {
      log.error({ erro: err?.name }, 'alerta falhou')
    }
  })
  registrarErroDoWorker(jobs, log)
  registrarErroDoWorker(alertas, log)

  return {
    jobs,
    alertas,
    async close() {
      await Promise.all([jobs.close(), alertas.close()])
    }
  }
}
