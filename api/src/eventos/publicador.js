// Publicador do outbox (ADR 0005; CIT-166): laço no processo do worker que lê os
// eventos pendentes e cria um job por consumidor inscrito. Não é job repetível do
// BullMQ: encheria `completed` no Redis (`noeviction`) e, com o Redis fora, nem rodaria.
// Uma instância só (ADR 0006), sem bloqueio de linha: uma publicação dupla é absorvida
// pelo `jobId` determinístico e pelo `evento_processado`.
import { validarConsumidores } from './consumidores.js'
import { buscarPendentes, contarFalhaDePublicacao, marcarPublicados } from './repositorio.js'

// Prazo total do `addBulk` por ciclo: com o Redis fora, o BullMQ espera a conexão
// indefinidamente. O comando pode valer depois do prazo (job fantasma, ADR 0005).
export const LIMITE_PUBLICACAO_MS = 2000
export const INTERVALO_PADRAO_MS = 2000
export const LOTE_PADRAO = 50

function limiteDaPublicacao(timer) {
  return new Promise((_, rejeitar) => {
    timer.id = setTimeout(() => {
      const erro = new Error('limite da publicação')
      erro.name = 'TimeoutError'
      rejeitar(erro)
    }, LIMITE_PUBLICACAO_MS)
  })
}

// nome do evento → consumidores inscritos.
function inscritosPorEvento(consumidores) {
  const mapa = new Map()
  for (const [consumidor, { eventos }] of Object.entries(consumidores)) {
    for (const nome of eventos) {
      if (!mapa.has(nome)) mapa.set(nome, [])
      mapa.get(nome).push(consumidor)
    }
  }
  return mapa
}

/**
 * Um ciclo do publicador: lê até `lote` eventos pendentes, cria um job por consumidor
 * inscrito (`name = <consumidor>`, `data = { eventoId, requestId }`, `jobId =
 * <consumidor>-<eventoId>`) num só `addBulk` com prazo de 2 s e marca `publicado_em`
 * em todo o lote (evento sem consumidor inclusive). Falha ou prazo estourado: soma 1 a
 * `tentativas_publicacao` e o lote fica para o próximo ciclo. Nunca lança.
 *
 * @returns {Promise<{ lidos: number, publicados: number }>}
 */
export async function publicarPendentes({ pool, filas, consumidores, log, lote = LOTE_PADRAO }) {
  let eventos
  try {
    eventos = await buscarPendentes(pool, lote)
  } catch (err) {
    log.error({ erro: err?.name, codigo: err?.code }, 'leitura de eventos falhou')
    return { lidos: 0, publicados: 0 }
  }
  if (eventos.length === 0) return { lidos: 0, publicados: 0 }

  const inscritos = inscritosPorEvento(consumidores)
  const jobs = []
  for (const evento of eventos) {
    const destinos = inscritos.get(evento.nome) ?? []
    if (destinos.length === 0) {
      log.info({ eventoId: evento.id, nome: evento.nome }, 'evento sem consumidor')
    }
    for (const consumidor of destinos) {
      jobs.push({
        name: consumidor,
        data: { eventoId: evento.id, requestId: evento.request_id },
        opts: { jobId: `${consumidor}-${evento.id}` }
      })
    }
  }
  const ids = eventos.map((evento) => evento.id)

  if (jobs.length > 0) {
    const timer = {}
    try {
      await Promise.race([filas.jobs.addBulk(jobs), limiteDaPublicacao(timer)])
    } catch (err) {
      // Erro do ioredis traz host e porta: só o nome.
      log.warn({ erro: err?.name, eventos: eventos.length }, 'publicação falhou')
      try {
        await contarFalhaDePublicacao(pool, ids)
      } catch (erroBanco) {
        log.error({ erro: erroBanco?.name, codigo: erroBanco?.code }, 'registro de falha de publicação falhou')
      }
      return { lidos: eventos.length, publicados: 0 }
    } finally {
      clearTimeout(timer.id)
    }
  }

  try {
    await marcarPublicados(pool, ids)
  } catch (err) {
    // Jobs criados, marca não gravada: o próximo ciclo republica (mesmo `jobId`, sem duplicar).
    log.error({ erro: err?.name, codigo: err?.code }, 'marcação de publicados falhou')
    return { lidos: eventos.length, publicados: 0 }
  }
  return { lidos: eventos.length, publicados: eventos.length }
}

/**
 * Inicia o laço do publicador: um ciclo logo ao iniciar e os seguintes a cada
 * `intervaloMs` depois do fim do anterior (`setTimeout` encadeado, sem sobreposição).
 * `aoCiclo` (só nos testes) é chamado ao fim de cada ciclo com o resultado.
 * `close()` cancela o próximo ciclo e espera o que estiver em curso (que termina em
 * até 2 s mais o `UPDATE`; o `add` fantasma depois do prazo não é esperado).
 *
 * @returns {{ close: () => Promise<void> }}
 */
export function iniciarPublicador({
  pool, filas, consumidores, log, intervaloMs = INTERVALO_PADRAO_MS, lote = LOTE_PADRAO, aoCiclo
}) {
  validarConsumidores(consumidores)
  let parado = false
  let timer
  let emCurso = null

  async function rodar() {
    try {
      const resultado = await publicarPendentes({ pool, filas, consumidores, log, lote })
      aoCiclo?.(resultado)
    } catch (err) {
      log.error({ erro: err?.name }, 'ciclo do publicador falhou')
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
  log.info({ intervaloMs }, 'publicador iniciado')

  return {
    async close() {
      parado = true
      clearTimeout(timer)
      if (emCurso) await emCurso
    }
  }
}
