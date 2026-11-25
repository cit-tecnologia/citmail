// Enfileirador do e-mail transacional no worker (ADR 0010; CIT-65), na forma do
// enfileirador do webhook do Asaas (CIT-64): um laço que cria um job `email_enviar` por
// linha `pendente` ainda não enfileirada e, no mesmo ciclo, alerta uma vez cada linha
// parada (`email_parado`). O job nasce só depois do COMMIT do consumidor que gravou a
// linha: nunca fica órfão por ROLLBACK.
import { LIMITE_PUBLICACAO_MS } from '../eventos/publicador.js'
import {
  buscarParados, buscarPendentesNaoEnfileirados, marcarAlertadoParado, marcarEnfileirados
} from './repositorio.js'
import { JOB_EMAIL } from './servico.js'

export const INTERVALO_PADRAO_MS = 2000
export const LOTE_PADRAO = 50
export const PARADO_HORAS_PADRAO = 6

// Prazo do `add`/`addBulk`: com o Redis fora, o BullMQ espera a conexão indefinidamente.
// Também no "esqueci a senha" (CIT-71).
export async function comPrazo(promessa) {
  let timer
  try {
    return await Promise.race([
      promessa,
      new Promise((_, rejeitar) => {
        timer = setTimeout(() => {
          rejeitar(Object.assign(new Error('limite da fila'), { name: 'TimeoutError' }))
        }, LIMITE_PUBLICACAO_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** `jobId` do envio: a geração entra no id, e o reenvio (geração + 1) cria job novo. */
export function jobIdEmail(envioId, geracao) {
  return `${JOB_EMAIL}-${envioId}-${geracao}`
}

/**
 * Um ciclo do enfileirador: lê até `lote` linhas `pendente` não enfileiradas e cria um
 * job `email_enviar` por linha (`jobId = email_enviar-<id>-<geracao>`, `data = { envioId,
 * geracao }`) num só `addBulk` com prazo de 2 s; depois grava `enfileirado_em`. Falha: a
 * marca fica nula e o lote volta no próximo ciclo (o `jobId` repetido não duplica). No
 * mesmo ciclo, linha `pendente` enfileirada há mais de `paradoHoras`, ou criada há mais
 * que isso e nunca enfileirada, gera um alerta `email_parado` (uma vez por geração:
 * `alertado_parado_em`). Nunca lança.
 *
 * @returns {Promise<{ enfileirados: number, parados: number }>}
 */
export async function enfileirarEmails({ pool, filas, log, paradoHoras = PARADO_HORAS_PADRAO, lote = LOTE_PADRAO }) {
  const resultado = { enfileirados: 0, parados: 0 }
  try {
    const envios = await buscarPendentesNaoEnfileirados(pool, lote)
    if (envios.length > 0) {
      const ids = envios.map((envio) => envio.id)
      try {
        await comPrazo(filas.jobs.addBulk(envios.map((envio) => ({
          name: JOB_EMAIL,
          data: { envioId: envio.id, geracao: envio.geracao },
          opts: { jobId: jobIdEmail(envio.id, envio.geracao) }
        }))))
        await marcarEnfileirados(pool, ids)
        resultado.enfileirados = ids.length
      } catch (err) {
        // Erro do ioredis traz host e porta: só o nome.
        log.warn({ erro: err?.name, codigo: err?.code, envios: ids.length }, 'enfileiramento de e-mail falhou')
      }
    }
  } catch (err) {
    log.error({ erro: err?.name, codigo: err?.code }, 'leitura de e-mails falhou')
  }

  try {
    const parados = await buscarParados(pool, paradoHoras, lote)
    if (parados.length > 0) {
      await comPrazo(filas.alertas.addBulk(parados.map((envio) => ({
        name: 'email_parado',
        data: { tipo: 'email_parado', envioId: envio.id },
        opts: { jobId: `alerta-email_parado-${envio.id}-${envio.geracao}` }
      }))))
      await marcarAlertadoParado(pool, parados)
      resultado.parados = parados.length
    }
  } catch (err) {
    log.warn({ erro: err?.name, codigo: err?.code }, 'alerta de e-mail parado falhou')
  }
  return resultado
}

/**
 * Inicia o laço do enfileirador, na forma de `iniciarEnfileiradorWebhook`: um ciclo logo
 * ao iniciar e os seguintes a cada `intervaloMs` depois do fim do anterior. `aoCiclo` só
 * nos testes. `close()` cancela o próximo ciclo e espera o que estiver em curso.
 *
 * @returns {{ close: () => Promise<void> }}
 */
export function iniciarEnfileiradorEmail({
  pool, filas, log, intervaloMs = INTERVALO_PADRAO_MS, paradoHoras = PARADO_HORAS_PADRAO, lote = LOTE_PADRAO, aoCiclo
}) {
  let parado = false
  let timer
  let emCurso = null

  async function rodar() {
    try {
      const resultado = await enfileirarEmails({ pool, filas, log, paradoHoras, lote })
      aoCiclo?.(resultado)
    } catch (err) {
      log.error({ erro: err?.name }, 'ciclo do enfileirador de e-mail falhou')
    }
  }

  function agendar(atrasoMs) {
    timer = setTimeout(() => {
      emCurso = rodar().finally(() => {
        emCurso = null
        if (!parado) agendar(intervaloMs)
      })
    }, atrasoMs)
  }

  agendar(0)
  log.info({ intervaloMs }, 'enfileirador de e-mail iniciado')

  return {
    async close() {
      parado = true
      clearTimeout(timer)
      if (emCurso) await emCurso
    }
  }
}
