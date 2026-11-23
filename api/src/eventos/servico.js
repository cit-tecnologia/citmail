// Registro de eventos de domínio no outbox (ADR 0005; CIT-166). Entrada inválida lança
// TypeError antes de qualquer consulta; a mensagem cita o campo, nunca o valor.
import pg from 'pg'
import { camposSensiveis } from '../log.js'
import { inserirEvento } from './repositorio.js'
import { NOMES_EVENTOS } from './vocabulario.js'

const PAYLOAD_MAX_BYTES = 2048
const REQUEST_ID_MAX = 128
const VERSAO_MAX = 2147483647
const AGREGADO_ID = /^[A-Za-z0-9_-]{1,64}$/
const CHAVE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{1,200}$/
const CAMPOS_SENSIVEIS = new Set(camposSensiveis.map((campo) => campo.toLowerCase()))

function invalido(motivo) {
  return new TypeError(`evento: ${motivo}`)
}

function ehObjetoSimples(valor) {
  if (typeof valor !== 'object' || valor === null) return false
  const prototipo = Object.getPrototypeOf(valor)
  return prototipo === Object.prototype || prototipo === null
}

// O text recusa \0 (22021) e o jsonb, surrogate solitário (22P05).
function textoAceito(texto) {
  return !texto.includes('\0') && texto.isWellFormed()
}

// Olha só os nomes de chave (em qualquer nível, inclusive dentro de arrays), não os
// valores: limite conhecido (ADR 0005); o esquema por evento de cada emissor fecha isso.
function inspecionar(valor) {
  if (typeof valor === 'string') {
    if (!textoAceito(valor)) throw invalido('payload com caractere inválido')
    return
  }
  if (typeof valor !== 'object' || valor === null) return
  if (Array.isArray(valor)) {
    for (const item of valor) inspecionar(item)
    return
  }
  for (const [chave, item] of Object.entries(valor)) {
    if (!textoAceito(chave)) throw invalido('payload com caractere inválido')
    if (CAMPOS_SENSIVEIS.has(chave.toLowerCase())) throw invalido('payload com campo sensível')
    inspecionar(item)
  }
}

// Normaliza por JSON (toJSON não escapa da checagem) e devolve o texto serializado
// que vai ao INSERT, o mesmo que foi validado.
function normalizarPayload(payload) {
  if (payload === undefined) return '{}'
  if (!ehObjetoSimples(payload)) throw invalido('payload deve ser objeto simples')
  let normalizado
  try {
    normalizado = JSON.parse(JSON.stringify(payload))
  } catch {
    throw invalido('payload não serializável')
  }
  inspecionar(normalizado)
  const texto = JSON.stringify(normalizado)
  if (Buffer.byteLength(texto) > PAYLOAD_MAX_BYTES) throw invalido('payload grande demais')
  return texto
}

/**
 * Grava um evento de domínio no outbox e devolve `{ id, criado }`. A mesma
 * `chaveIdempotencia` repetida devolve o id já gravado com `criado: false`.
 *
 * `cliente` DEVE ser o `pg.Client` da transação da mudança de estado (`BEGIN` aberto
 * pelo chamador): o evento só existe se a mudança for confirmada, e o `ROLLBACK` do
 * chamador o desfaz. A função recusa um `Pool`, mas não tem como conferir se há
 * transação aberta no cliente.
 *
 * Dados: `{ nome, agregado: { tipo, id }, chaveIdempotencia, payload, requestId, versao = 1 }`.
 * `nome` é do vocabulário (`vocabulario.js`); `chaveIdempotencia` começa com `<nome>-`;
 * `payload` só com ids e dados não pessoais (chave de `camposSensiveis` é recusada),
 * até 2048 bytes; `requestId` é o `reqId` de origem (ADR 0013, item 8).
 *
 * @param {import('pg').PoolClient} cliente
 * @returns {Promise<{ id: string, criado: boolean }>}
 */
export async function registrarEvento(cliente, dados) {
  if (cliente instanceof pg.Pool || typeof cliente?.query !== 'function') {
    throw invalido('use o cliente da transação, não o Pool')
  }
  if (!ehObjetoSimples(dados)) throw invalido('dados inválidos')
  const { nome, agregado, chaveIdempotencia, payload, requestId, versao = 1 } = dados

  if (!NOMES_EVENTOS.includes(nome)) throw invalido('nome fora da lista')
  if (!ehObjetoSimples(agregado)) throw invalido('agregado inválido')
  if (typeof agregado.tipo !== 'string' || agregado.tipo.length === 0 || !textoAceito(agregado.tipo)) {
    throw invalido('agregado.tipo inválido')
  }
  if (typeof agregado.id !== 'string' || !AGREGADO_ID.test(agregado.id)) throw invalido('agregado.id inválido')
  if (typeof chaveIdempotencia !== 'string' || !chaveIdempotencia.startsWith(`${nome}-`) ||
      !CHAVE_IDEMPOTENCIA.test(chaveIdempotencia)) {
    throw invalido('chaveIdempotencia inválida')
  }
  if (requestId === undefined || requestId === null) throw invalido('requestId obrigatório')
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > REQUEST_ID_MAX ||
      !textoAceito(requestId)) {
    throw invalido('requestId inválido')
  }
  if (!Number.isInteger(versao) || versao < 1 || versao > VERSAO_MAX) throw invalido('versao inválida')

  return inserirEvento(cliente, {
    nome,
    versao,
    agregadoTipo: agregado.tipo,
    agregadoId: agregado.id,
    chaveIdempotencia,
    payload: normalizarPayload(payload),
    requestId
  })
}
