// Trilha de auditoria das ações críticas (ADR 0013, item 7; CIT-58). Entrada inválida
// lança TypeError antes de qualquer consulta; a mensagem cita o campo, nunca o valor.
// Registro de falha vai pelo pool, fora da transação que vai sofrer rollback.
import { isIP } from 'node:net'
import { inserirAuditoria } from './repositorio.js'
import { ACOES, ALVOS, AUTORES, CHAVES_PROIBIDAS, RESULTADOS, TRECHOS_PROIBIDOS } from './vocabulario.js'

const DETALHES_MAX_BYTES = 2048
const DETALHES_MAX_PROFUNDIDADE = 4
const ID_MAX = 64
const REQUEST_ID_MAX = 128
const CHAVE_NA_MENSAGEM_MAX = 64
// Faixa de número aceita em detalhes: o jsonb::text escreve 1e300 com 301 dígitos
// e estouraria o CHECK de 4096 bytes no banco.
const NUMERO_MAX = 1e15
const NUMERO_MIN = 1e-6

function invalido(motivo) {
  return new TypeError(`auditoria: ${motivo}`)
}

function ehObjeto(valor) {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
}

function exigirNoVocabulario(valor, lista, campo) {
  if (!lista.includes(valor)) throw invalido(`${campo} fora do vocabulário`)
}

// O text recusa \0 (22021) e o jsonb, surrogate solitário (22P05).
function textoAceito(texto) {
  return !texto.includes('\0') && texto.isWellFormed()
}

// id string de 1 a 64 caracteres, ou null quando `nuloPermitido`.
function validarId(id, campo, nuloPermitido) {
  if (id === null || id === undefined) {
    if (nuloPermitido) return null
    throw invalido(`${campo} obrigatório`)
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX || !textoAceito(id)) {
    throw invalido(`${campo} inválido`)
  }
  return id
}

// IPv4 ou IPv6 sem zona (o inet recusa `fe80::1%eth0`); nulo só com autor sistema.
function validarIp(ip, autorTipo) {
  if (ip === null || ip === undefined) {
    if (autorTipo === 'sistema') return null
    throw invalido('ip obrigatório')
  }
  if (typeof ip !== 'string' || ip.includes('%') || isIP(ip) === 0) throw invalido('ip inválido')
  return ip
}

function chaveProibida(chave) {
  const minuscula = chave.toLowerCase()
  return CHAVES_PROIBIDAS.includes(minuscula) || TRECHOS_PROIBIDOS.some((trecho) => minuscula.includes(trecho))
}

// Profundidade = contêineres aninhados (objeto ou array), com a raiz contando 1.
// Confere o caractere real em chaves e valores, não o texto `\u0000` serializado.
function inspecionar(valor, profundidade) {
  if (typeof valor === 'string') {
    if (!textoAceito(valor)) throw invalido('detalhes com caractere inválido')
    return
  }
  if (typeof valor === 'number') {
    const absoluto = Math.abs(valor)
    if (absoluto >= NUMERO_MAX || (absoluto > 0 && absoluto < NUMERO_MIN)) throw invalido('detalhes com número fora da faixa')
    return
  }
  if (typeof valor !== 'object' || valor === null) return
  if (profundidade > DETALHES_MAX_PROFUNDIDADE) throw invalido('detalhes aninhados demais')
  if (Array.isArray(valor)) {
    for (const item of valor) inspecionar(item, profundidade + 1)
    return
  }
  for (const [chave, item] of Object.entries(valor)) {
    if (!textoAceito(chave)) throw invalido('detalhes com caractere inválido')
    if (chaveProibida(chave)) throw invalido(`chave proibida em detalhes: ${chave.slice(0, CHAVE_NA_MENSAGEM_MAX)}`)
    inspecionar(item, profundidade + 1)
  }
}

// Normaliza por JSON (toJSON e instâncias de classe não escapam da checagem) e
// devolve o texto serializado que vai ao INSERT, o mesmo que foi validado.
function normalizarDetalhes(detalhes) {
  if (detalhes === undefined) return '{}'
  let normalizado
  try {
    normalizado = JSON.parse(JSON.stringify(detalhes))
  } catch {
    throw invalido('detalhes não serializável')
  }
  if (!ehObjeto(normalizado)) throw invalido('detalhes deve ser objeto')
  inspecionar(normalizado, 1)
  const texto = JSON.stringify(normalizado)
  if (Buffer.byteLength(texto) > DETALHES_MAX_BYTES) throw invalido('detalhes grandes demais')
  return texto
}

/**
 * Grava um registro de auditoria e devolve o id (string). `executor` é um Pool ou
 * um Client (com Client em transação, o rollback do chamador apaga o registro).
 * Dados: `{ autor: { tipo, id }, acao, alvo: { tipo, id }, resultado, ip, requestId?, detalhes? }`.
 */
export async function registrarAuditoria(executor, dados) {
  if (!ehObjeto(dados)) throw invalido('dados inválidos')
  const { autor, acao, alvo, resultado, ip, requestId, detalhes } = dados
  if (!ehObjeto(autor)) throw invalido('autor inválido')
  if (!ehObjeto(alvo)) throw invalido('alvo inválido')

  exigirNoVocabulario(acao, ACOES, 'acao')
  exigirNoVocabulario(autor.tipo, AUTORES, 'autor.tipo')
  exigirNoVocabulario(alvo.tipo, ALVOS, 'alvo.tipo')
  exigirNoVocabulario(resultado, RESULTADOS, 'resultado')

  // Falha de login com e-mail inexistente: sem autor nem alvo identificados (D4).
  const autorId = validarId(autor.id, 'autor.id', autor.tipo === 'sistema' || acao === 'login_falhou')
  const alvoId = validarId(alvo.id, 'alvo.id', acao === 'login_falhou')

  let requestIdValido = null
  if (requestId !== undefined && requestId !== null) {
    if (typeof requestId !== 'string' || requestId.length > REQUEST_ID_MAX || !textoAceito(requestId)) {
      throw invalido('requestId inválido')
    }
    requestIdValido = requestId
  }

  return inserirAuditoria(executor, {
    autorTipo: autor.tipo,
    autorId,
    acao,
    alvoTipo: alvo.tipo,
    alvoId,
    resultado,
    ip: validarIp(ip, autor.tipo),
    requestId: requestIdValido,
    detalhes: normalizarDetalhes(detalhes)
  })
}
