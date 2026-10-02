// Workers da fila (ADR 0005; CIT-56): `jobs` roda os handlers com log correlacionado e,
// quando um job chega a `failed`, enfileira o alerta em `alertas`, que envia com
// limite por minuto (o excedente espera; nada é descartado, ADR 0011).
import { Job, UnrecoverableError, Worker } from 'bullmq'
import { executarJob } from '../jobs/executar.js'
import { jobExemplo } from '../jobs/exemplo.js'
import { pedidoSeguro } from '../alertas/telegram.js'

// Handlers fora de produção. Em produção (`nodeEnv === 'production'`) o job de
// exemplo não é registrado: enfileirado lá, vai a `failed` como job desconhecido.
export const handlersPadrao = { exemplo: jobExemplo }

// 20 por minuto: o limite do Telegram por grupo.
export const LIMITE_ALERTAS = { max: 20, duration: 60000 }

// Erro do ioredis traz host e porta: só `err.name` vai ao log.
function registrarErroDoWorker(worker, log) {
  worker.on('error', (err) => log.error({ erro: err?.name, fila: worker.name }, 'erro no worker'))
}

// `pedidoId` do alerta passa por `pedidoSeguro` (UUID estrito ou `-`): o job de alerta
// também fica no Redis. Decide pelo estado (não por `attemptsMade >= attempts`): cobre tentativas esgotadas
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
        { jobId: job.id, job: job.name, pedidoId: pedidoSeguro(job.data?.pedidoId) },
        { jobId: `alerta-${job.id}-${finalizadoEm}` })
    } catch (err) {
      log.error({ erro: err?.name, jobId: job?.id }, 'alerta não enfileirado')
    }
  }
}

/**
 * Cria os workers de `jobs` e `alertas`. `opcoesWorker` (`lockDuration`,
 * `stalledInterval`, `limiter`...) só nos testes; em produção, os padrões do BullMQ
 * e o limite de alertas acima. Sem `handlers`, usa `handlersPadrao`, exceto com
 * `nodeEnv === 'production'` (nenhum handler por enquanto).
 * `close()` fecha os workers (esperando o job ativo) e depois espera os listeners de
 * `failed` ainda em curso, para o alerta não se perder num encerramento normal.
 *
 * @returns {{ jobs: Worker, alertas: Worker, close: () => Promise<void> }}
 */
export function criarWorkers({
  conexao, filas, prefixo, log, nodeEnv,
  handlers = nodeEnv === 'production' ? {} : handlersPadrao,
  enviarAlerta, opcoesWorker = {}
}) {
  const { limiter = LIMITE_ALERTAS, ...opcoesComuns } = opcoesWorker
  // Listeners de `failed` em curso (nunca rejeitam): `close()` espera por eles.
  const pendentes = new Set()
  const rastreado = (listener) => (...args) => {
    const promessa = listener(...args)
    pendentes.add(promessa)
    promessa.finally(() => pendentes.delete(promessa))
  }

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

  jobs.on('failed', rastreado(criarAvisoDeEsgotado({ filas, log })))
  alertas.on('failed', rastreado(async (job) => {
    try {
      if (typeof job?.getState !== 'function') return
      if (await job.getState() === 'failed') {
        log.error({ jobId: job.data?.jobId }, 'alerta falhou')
      }
    } catch (err) {
      log.error({ erro: err?.name }, 'alerta falhou')
    }
  }))
  registrarErroDoWorker(jobs, log)
  registrarErroDoWorker(alertas, log)

  return {
    jobs,
    alertas,
    async close() {
      await Promise.all([jobs.close(), alertas.close()])
      while (pendentes.size > 0) {
        await Promise.allSettled([...pendentes])
      }
    }
  }
}
