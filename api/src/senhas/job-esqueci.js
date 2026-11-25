// Job `senha_esqueci` (E5-H2; CIT-71; ADR 0008): o "esqueci a senha" responde 202 na hora
// e a busca da conta e a gravação ficam aqui, fora do caminho da resposta.
// Exceção documentada à regra "só ids em `job.data`" (`fila/filas.js`): o job leva o e-mail
// digitado (`{ email, requestId }`) e por isso nasce com `removeOnComplete` e `removeOnFail`
// (o e-mail fica no Redis, e no AOF/RDB, só enquanto o job espera ou tenta). Como o job
// falho é apagado antes do aviso de esgotamento do worker, o próprio handler enfileira o
// alerta na última tentativa, só com o `jobId` e o nome. Registrado só com `PAINEL_HABILITADO`.
// No limite de pedidos, reemite o link da aberta mais recente (CIT-72, `reemitir`).
import { randomUUID } from 'node:crypto'
import { UnrecoverableError } from 'bullmq'
import { MODELO_POR_TIPO } from '../email/modelos/senha.js'
import { solicitarEmail } from '../email/servico.js'
import { comPrazo } from '../fila/prazo.js'
import { buscarAbertaMaisRecente, buscarContaIdPorEmail, situacaoDoEnvio } from './repositorio.js'
import { criarSolicitacao, UUID } from './servico.js'

export const JOB_SENHA_ESQUECI = 'senha_esqueci'
export const OPCOES_JOB_ESQUECI = Object.freeze({ removeOnComplete: true, removeOnFail: true })

const ID_JOB = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Reemissão no limite (CIT-72; contrato (e) do ADR 0008), no `BEGIN` do pedido, com a conta
 * já travada por `criarSolicitacao` (dois "esqueci" da mesma conta se serializam): pede de
 * novo o e-mail da aberta mais recente, salvo se o anti-spam pelo `email_envio` dela
 * descarta. Descartes: `sem_aberta`, `envio_pendente` (pendente vivo, ou nenhum envio com a
 * solicitação ainda na janela do outbox) e `reenvio_recente` (enviado há menos de 5 min).
 */
async function reemitir(cliente, contaId, idPedido) {
  const aberta = await buscarAbertaMaisRecente(cliente, contaId)
  if (!aberta) return { motivo: 'sem_aberta' }
  const envio = await situacaoDoEnvio(cliente, aberta.id)
  if (envio.pendentes_vivos > 0 || (envio.total === 0 && aberta.recente)) {
    return { motivo: 'envio_pendente', solicitacaoId: aberta.id }
  }
  if (envio.enviados_recentes > 0) return { motivo: 'reenvio_recente', solicitacaoId: aberta.id }
  const { id: envioId, criado } = await solicitarEmail(cliente, {
    chaveIdempotencia: `senha_reenvio-${aberta.id}-${idPedido}`,
    modelo: MODELO_POR_TIPO[aberta.tipo],
    refs: { solicitacaoId: aberta.id }
  })
  return { solicitacaoId: aberta.id, envioId, criado }
}

// Busca a conta pelo e-mail normalizado e cria a solicitação numa transação; no limite,
// tenta a reemissão na mesma transação. E-mail inexistente termina sem efeito. Nada do
// e-mail vai ao log.
async function processar(pool, { email, requestId }, log, jobId) {
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
    let reemissao
    if (!resultado.criada && resultado.motivo === 'limite') {
      // Chave por pedido: o `requestId` (UUID) do job; fora do formato, o id do job.
      const idPedido = typeof requestId === 'string' && UUID.test(requestId)
        ? requestId
        : typeof jobId === 'string' && ID_JOB.test(jobId) ? jobId : randomUUID()
      reemissao = await reemitir(cliente, contaId, idPedido)
    }
    await cliente.query('COMMIT')
    log.info({ contaId, criada: resultado.criada, motivo: resultado.motivo, solicitacaoId: resultado.solicitacaoId },
      'esqueci a senha processado')
    if (reemissao?.motivo) {
      log.info({ contaId, solicitacaoId: reemissao.solicitacaoId, motivo: reemissao.motivo }, 'reemissão do link descartada')
    } else if (reemissao) {
      log.info({ contaId, solicitacaoId: reemissao.solicitacaoId, envioId: reemissao.envioId, criado: reemissao.criado },
        'link reemitido')
    }
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
      await processar(pool, dados, log, jobId)
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
