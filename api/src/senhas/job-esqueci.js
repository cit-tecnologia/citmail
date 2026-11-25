// Job `senha_esqueci` (E5-H2; CIT-71; ADR 0008): o "esqueci a senha" responde 202 na hora
// e a busca da conta e a gravação ficam aqui, fora do caminho da resposta.
// Exceção documentada à regra "só ids em `job.data`" (`fila/filas.js`): o job leva o e-mail
// digitado (`{ email, requestId }`) e por isso nasce com `removeOnComplete` e `removeOnFail`
// (o e-mail fica no Redis, e no AOF/RDB, só enquanto o job espera ou tenta). Como o job
// falho é apagado antes do aviso de esgotamento do worker, o próprio handler enfileira o
// alerta na última tentativa, só com o `jobId` e o nome. Registrado só com `PAINEL_HABILITADO`.
import { UnrecoverableError } from 'bullmq'
import { comPrazo } from '../email/enfileirador.js'
import { buscarContaIdPorEmail } from './repositorio.js'
import { criarSolicitacao } from './servico.js'

export const JOB_SENHA_ESQUECI = 'senha_esqueci'
export const OPCOES_JOB_ESQUECI = Object.freeze({ removeOnComplete: true, removeOnFail: true })

// Busca a conta pelo e-mail normalizado e cria a solicitação numa transação. E-mail
// inexistente termina sem efeito. Nada do e-mail vai ao log.
async function processar(pool, { email, requestId }, log) {
  const contaId = await buscarContaIdPorEmail(pool, email)
  if (!contaId) {
    log.info('esqueci a senha sem conta')
    return
  }
  const cliente = await pool.connect()
  let erroDoCliente
  try {
    await cliente.query('BEGIN')
    const resultado = await criarSolicitacao(cliente, contaId, { requestId })
    await cliente.query('COMMIT')
    log.info({ contaId, criada: resultado.criada, motivo: resultado.motivo, solicitacaoId: resultado.solicitacaoId },
      'esqueci a senha processado')
  } catch (erro) {
    try {
      await cliente.query('ROLLBACK')
    } catch (erroRollback) {
      erroDoCliente = erroRollback
    }
    throw erro
  } finally {
    cliente.release(erroDoCliente)
  }
}

/**
 * Handler do job (`criarWorkers({ handlers })`). `filas` com falha rápida (as do
 * publicador no worker): o alerta da última tentativa tem prazo de 2 s; se falhar, vai
 * ao log e o erro original sobe do mesmo jeito.
 */
export function criarHandlerEsqueci({ pool, filas }) {
  return async function senhaEsqueci({ log, tentativa, jobId } = {}, dados = {}) {
    try {
      if (typeof dados.email !== 'string') throw new UnrecoverableError('email ausente')
      await processar(pool, dados, log)
    } catch (erro) {
      const ultima = erro instanceof UnrecoverableError ||
        (tentativa !== undefined && tentativa.feita + 1 >= tentativa.maxima)
      if (ultima) {
        try {
          await comPrazo(filas.alertas.add('job_esgotado', { jobId, job: JOB_SENHA_ESQUECI },
            { jobId: `alerta-${JOB_SENHA_ESQUECI}-${jobId}` }))
        } catch (erroAlerta) {
          log.error({ erro: erroAlerta?.name, jobId }, 'alerta não enfileirado')
        }
      }
      throw erro
    }
  }
}

/** Handlers do "esqueci": só com `PAINEL_HABILITADO`; desligada, nenhum. */
export function criarHandlersSenha({ pool, filas, painelHabilitado }) {
  return painelHabilitado ? { [JOB_SENHA_ESQUECI]: criarHandlerEsqueci({ pool, filas }) } : {}
}
