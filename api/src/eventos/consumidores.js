// Consumidores de eventos de domínio (ADR 0005; CIT-166). Cada consumidor recebe o
// evento num job próprio (`name = <consumidor>`, `jobId = <consumidor>-<eventoId>`) e
// é idempotente: a marca em `evento_processado` e o efeito no banco vão na mesma
// transação. Efeito externo (e-mail, Skymail) não é transacional: consultar antes de criar.
import { UnrecoverableError } from 'bullmq'
import { tarefaRegistroDominio } from '../dominios/consumidor-tarefa-registro.js'
import { emailCompraConfirmada } from '../email/consumidor-compra-confirmada.js'
import { handlersPadrao } from '../fila/worker.js'
import { senhaPrimeiroAcesso } from '../senhas/consumidor-primeiro-acesso.js'
import { buscarEvento, marcarProcessado } from './repositorio.js'
import { NOMES_EVENTOS } from './vocabulario.js'

// Sem hífen: é o separador do `jobId`. Mesmo formato do CHECK de `evento_processado`.
const NOME_CONSUMIDOR = /^[a-z][a-z0-9_]{0,47}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Registro dos consumidores: `{ <consumidor>: { eventos: [<nome>...], tratar } }`, com
 * `tratar: async ({ cliente, evento, log }) => {}`. `cliente` é o da transação que grava
 * a marca; `evento` é a linha de `evento`. `email_compra_confirmada` (CIT-66) consome
 * `pedido_pago` e `tarefa_registro_dominio` (CIT-77), `dominio_pago`; os demais de negócio
 * chegam com as próximas histórias.
 */
export const consumidoresPadrao = Object.freeze({
  email_compra_confirmada: emailCompraConfirmada,
  tarefa_registro_dominio: tarefaRegistroDominio
})

/**
 * Consumidores do processo: os padrão e, com `PAINEL_HABILITADO` (CIT-71),
 * `senha_primeiro_acesso`, que cria a solicitação de primeiro acesso a cada
 * `conta_titular_criada` (desligada, não nascem solicitações que venceriam sem envio).
 */
export function consumidoresDoAmbiente({ painelHabilitado }) {
  return painelHabilitado
    ? Object.freeze({ ...consumidoresPadrao, senha_primeiro_acesso: senhaPrimeiroAcesso })
    : consumidoresPadrao
}

function invalido(motivo) {
  return new TypeError(`consumidores: ${motivo}`)
}

/**
 * Confere o registro de consumidores e lança TypeError no primeiro problema: nome fora
 * do formato, `eventos` vazio ou com nome fora do vocabulário, `tratar` ausente.
 */
export function validarConsumidores(consumidores) {
  if (typeof consumidores !== 'object' || consumidores === null || Array.isArray(consumidores)) {
    throw invalido('registro inválido')
  }
  for (const [nome, consumidor] of Object.entries(consumidores)) {
    if (!NOME_CONSUMIDOR.test(nome)) throw invalido(`nome inválido: ${nome.slice(0, 64)}`)
    const eventos = consumidor?.eventos
    if (!Array.isArray(eventos) || eventos.length === 0) throw invalido(`${nome}: eventos vazio`)
    if (!eventos.every((evento) => NOMES_EVENTOS.includes(evento))) {
      throw invalido(`${nome}: evento fora da lista`)
    }
    if (typeof consumidor.tratar !== 'function') throw invalido(`${nome}: tratar ausente`)
  }
}

/**
 * Processa um evento para um consumidor, uma vez só: `BEGIN`, lê o evento, grava a
 * marca em `evento_processado` e roda `tratar` no mesmo cliente; `COMMIT`. Marca já
 * gravada → `evento já processado`, sem `tratar`. `eventoId` fora do formato UUID ou
 * evento inexistente → `UnrecoverableError` (o job vai a `failed` sem novas
 * tentativas). Outro erro → `ROLLBACK` (a marca não fica) e relança (nova tentativa).
 * `tratar` não pode engolir erro SQL (try/catch em volta de query) nem emitir
 * `COMMIT`/`ROLLBACK` próprio: a transação é deste processamento; transação abortada
 * no `COMMIT` vira erro recuperável e a fila tenta de novo.
 */
export async function processarEvento({ pool, consumidor, tratar, log }, { eventoId } = {}) {
  if (typeof eventoId !== 'string' || !UUID.test(eventoId)) {
    throw new UnrecoverableError('eventoId inválido')
  }
  const cliente = await pool.connect()
  let erroDoCliente
  try {
    await cliente.query('BEGIN')
    const evento = await buscarEvento(cliente, eventoId)
    if (!evento) throw new UnrecoverableError('evento inexistente')
    let marcado
    try {
      marcado = await marcarProcessado(cliente, consumidor, eventoId)
    } catch (err) {
      // Evento apagado entre o SELECT e o INSERT.
      if (err?.code === '23503') throw new UnrecoverableError('evento inexistente')
      throw err
    }
    if (!marcado) {
      await cliente.query('COMMIT')
      log.info({ eventoId, consumidor }, 'evento já processado')
      return
    }
    await tratar({ cliente, evento, log })
    // Transação abortada (`tratar` engoliu erro SQL): o COMMIT vira ROLLBACK sem lançar.
    const fim = await cliente.query('COMMIT')
    if (fim.command === 'ROLLBACK') throw new Error('transação do consumidor abortada')
  } catch (err) {
    try {
      await cliente.query('ROLLBACK')
    } catch (erroRollback) {
      // Cliente em estado incerto: descartado do pool no release.
      erroDoCliente = erroRollback
    }
    throw err
  } finally {
    cliente.release(erroDoCliente)
  }
}

/**
 * Monta os handlers da fila `jobs`, um por consumidor (`criarWorkers({ handlers })`).
 * Lança na criação se o registro for inválido ou se um consumidor tiver o nome de um
 * handler de `handlersPadrao`.
 */
export function criarHandlersDeConsumidores({ pool, consumidores = consumidoresPadrao }) {
  validarConsumidores(consumidores)
  const handlers = {}
  for (const [consumidor, { tratar }] of Object.entries(consumidores)) {
    if (Object.hasOwn(handlersPadrao, consumidor)) {
      throw invalido(`${consumidor}: nome já usado por outro job`)
    }
    handlers[consumidor] = ({ log }, dados) => processarEvento({ pool, consumidor, tratar, log }, dados)
  }
  return handlers
}
