// E-mail transacional por fila (ADR 0010; CIT-65), em duas etapas. (1) O consumidor de
// um evento chama `solicitarEmail` na transação que grava a marca do outbox: grava a linha
// `pendente` em `email_envio`. (2) O enfileirador do worker cria o job `email_enviar`
// (`enfileirador.js`), e o handler abaixo lê destinatário e variáveis, renderiza o modelo
// e envia. Entrega "ao menos uma vez": um crash entre o aceite do SMTP e o UPDATE reenvia.
// Endereço, assunto e corpo nunca vão ao log, à fila nem à tabela (só a máscara).
import pg from 'pg'
import { UnrecoverableError } from 'bullmq'
import { camposSensiveis } from '../log.js'
import { ehHtmlSeguro, limparLinha } from './html.js'
import { mascararEmail } from './mascara.js'
import { modelosDoAmbiente, validarModelos } from './modelos/index.js'
import { buscarEnvio, inserirEnvioSeNovo, marcarEnviado, marcarFalha, marcarNaoEnviado } from './repositorio.js'

export const JOB_EMAIL = 'email_enviar'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHAVE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{1,200}$/
const CHAVE_REF = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const VALOR_REF = /^[A-Za-z0-9_-]{1,64}$/
const REFS_MAX_BYTES = 1024
const CODIGO_ERRO = /^[A-Z0-9_]{1,32}$/
const MESSAGE_ID_MAX = 255
// Um único addr-spec: sem lista (`,` `;`), nome de exibição (`<` `>` `"`), comentário,
// espaço nem segundo `@`. O envelope SMTP leva só ele.
const ENDERECO = /^[^\s,;<>"()[\]\\@]{1,64}@[^\s,;<>"()[\]\\@]{1,253}$/
const CAMPOS_SENSIVEIS = new Set(camposSensiveis.map((campo) => campo.toLowerCase()))

// Classificação do erro do `nodemailer` (decisão 8 do plano; revisar no smoke da #57).
// Só 5xx em RCPT/DATA é definitivo; o resto (4xx, rede, timeout, autenticação) tenta de novo.
const CODIGOS_DEFINITIVOS_5XX = new Set(['EENVELOPE', 'EMESSAGE'])

/**
 * Erro do envio relançado à fila no lugar do erro do `nodemailer`, que repete o endereço
 * em `message`, `response` e `rejected`. Só `code` (do `nodemailer`) e `responseCode`
 * (SMTP), sem `cause` nem a mensagem original.
 */
export class ErroEmail extends Error {
  constructor({ code, responseCode } = {}) {
    super('falha no envio de e-mail')
    this.name = 'ErroEmail'
    if (code !== undefined) this.code = code
    if (responseCode !== undefined) this.responseCode = responseCode
  }
}

// Mesmo erro, definitivo: o BullMQ pula as tentativas restantes (`UnrecoverableError`).
export class ErroEmailDefinitivo extends UnrecoverableError {
  constructor({ code, responseCode } = {}) {
    super('falha definitiva no envio de e-mail')
    this.name = 'ErroEmail'
    if (code !== undefined) this.code = code
    if (responseCode !== undefined) this.responseCode = responseCode
  }
}

/** `{ code, responseCode, erroCodigo, definitivo }` do erro do `nodemailer`, só com códigos. */
export function classificarErroEmail(err) {
  const code = typeof err?.code === 'string' && CODIGO_ERRO.test(err.code) ? err.code : undefined
  const responseCode = Number.isInteger(err?.responseCode) && err.responseCode >= 100 && err.responseCode <= 599
    ? err.responseCode
    : undefined
  const definitivo = CODIGOS_DEFINITIVOS_5XX.has(code) && responseCode >= 500
  const erroCodigo = responseCode !== undefined ? String(responseCode) : code ?? 'ERRO_DESCONHECIDO'
  return { code, responseCode, erroCodigo, definitivo }
}

// Endereço do remetente para o envelope (`MAIL FROM`): o de `Nome <addr>` ou o próprio valor.
function enderecoDoRemetente(remetente) {
  const entre = /<([^<>]+)>\s*$/.exec(remetente ?? '')
  return (entre ? entre[1] : String(remetente ?? '')).trim()
}

function invalido(motivo) {
  return new TypeError(`email: ${motivo}`)
}

function ehObjetoSimples(valor) {
  if (typeof valor !== 'object' || valor === null) return false
  const prototipo = Object.getPrototypeOf(valor)
  return prototipo === Object.prototype || prototipo === null
}

// `refs` só com ids: chave no formato de identificador (fora de `camposSensiveis`) e
// valor texto de id ou inteiro.
function normalizarRefs(refs) {
  if (refs === undefined) return '{}'
  if (!ehObjetoSimples(refs)) throw invalido('refs deve ser objeto simples')
  for (const [chave, valor] of Object.entries(refs)) {
    if (!CHAVE_REF.test(chave) || CAMPOS_SENSIVEIS.has(chave.toLowerCase())) throw invalido('refs com chave inválida')
    if (!(Number.isSafeInteger(valor) || (typeof valor === 'string' && VALOR_REF.test(valor)))) {
      throw invalido('refs com valor que não é id')
    }
  }
  const texto = JSON.stringify(refs)
  if (Buffer.byteLength(texto) > REFS_MAX_BYTES) throw invalido('refs grande demais')
  return texto
}

/**
 * Pede um e-mail: grava a linha `pendente` em `email_envio` com a versão atual do modelo
 * e devolve `{ id, criado }`. A mesma `chaveIdempotencia` repetida não grava de novo
 * (`criado: false`). Entrada inválida ou modelo fora do registro lança TypeError antes de
 * qualquer consulta (a transação do consumidor falha); a mensagem cita o campo, nunca o valor.
 *
 * `cliente` DEVE ser o `pg.Client` da transação do consumidor (`tratar`): a linha só existe
 * se a marca do outbox for confirmada. `modelos` padrão: os do ambiente (`NODE_ENV`
 * ausente conta como produção, sem o `teste_exemplo`).
 *
 * @param {import('pg').PoolClient} cliente
 * @param {{ eventoId?: string|null, chaveIdempotencia: string, modelo: string, refs?: object }} dados
 */
export async function solicitarEmail(cliente, dados, modelos = modelosDoAmbiente(process.env.NODE_ENV)) {
  if (cliente instanceof pg.Pool || typeof cliente?.query !== 'function') {
    throw invalido('use o cliente da transação, não o Pool')
  }
  if (!ehObjetoSimples(dados)) throw invalido('dados inválidos')
  const { eventoId = null, chaveIdempotencia, modelo, refs } = dados
  if (eventoId !== null && (typeof eventoId !== 'string' || !UUID.test(eventoId))) throw invalido('eventoId inválido')
  if (typeof chaveIdempotencia !== 'string' || !CHAVE_IDEMPOTENCIA.test(chaveIdempotencia)) {
    throw invalido('chaveIdempotencia inválida')
  }
  if (typeof modelo !== 'string' || !Object.hasOwn(modelos, modelo)) throw invalido('modelo fora do registro')
  return inserirEnvioSeNovo(cliente, {
    eventoId,
    chaveIdempotencia,
    modelo,
    versaoModelo: modelos[modelo].versao,
    refs: normalizarRefs(refs)
  })
}

/**
 * Handler do job `email_enviar` (`data = { envioId, geracao, requestId? }`, só ids), sem
 * transação longa. `envioId` ou `geracao` fora do formato, linha inexistente ou modelo
 * fora do registro → `UnrecoverableError`. Job de outra geração ou linha fora de
 * `pendente` → conclui sem enviar. Transporte desligado → `nao_enviado`; modelo sem
 * destinatário → `nao_enviado` com `SEM_DESTINATARIO` (sem retry nem alerta).
 * Erro do SMTP: grava o código e relança `ErroEmail` (nova tentativa) ou, com 5xx em
 * RCPT/DATA, grava `falhou` e lança `ErroEmailDefinitivo`; na última tentativa
 * (`contexto.tentativa`), grava `falhou` antes de relançar.
 */
export function criarHandlerEmail({ pool, modelos, transporte, remetente, responderPara, log: logRaiz }) {
  validarModelos(modelos)
  const envelopeFrom = enderecoDoRemetente(remetente)
  return async function enviarEmail({ log = logRaiz, tentativa } = {}, { envioId, geracao } = {}) {
    if (typeof envioId !== 'string' || !UUID.test(envioId)) throw new UnrecoverableError('envioId inválido')
    if (!Number.isInteger(geracao) || geracao < 1) throw new UnrecoverableError('geracao inválida')
    const envio = await buscarEnvio(pool, envioId)
    if (!envio) throw new UnrecoverableError('envio inexistente')
    if (envio.geracao !== geracao) {
      log.info({ envioId, geracao }, 'e-mail de outra geração')
      return
    }
    if (envio.estado !== 'pendente') {
      log.info({ envioId, estado: envio.estado }, 'e-mail já tratado')
      return
    }
    if (!Object.hasOwn(modelos, envio.modelo)) throw new UnrecoverableError('modelo fora do registro')
    const modelo = modelos[envio.modelo]
    const campos = { envioId, modelo: envio.modelo }

    if (!transporte.ligado) {
      await marcarNaoEnviado(pool, envioId, geracao)
      log.info({ ...campos, estado: 'nao_enviado' }, 'e-mail não enviado: transporte desligado')
      return
    }

    const dados = await modelo.carregar(pool, envio.refs)
    const destinatario = limparLinha(dados?.destinatario)
    if (!ENDERECO.test(destinatario)) {
      await marcarNaoEnviado(pool, envioId, geracao, 'SEM_DESTINATARIO')
      log.info({ ...campos, estado: 'nao_enviado', erro_codigo: 'SEM_DESTINATARIO' }, 'e-mail sem destinatário')
      return
    }
    const variaveis = dados.variaveis ?? {}
    // HTML montado fora do tagged template `html` não tem escape garantido: erro do modelo.
    const corpoHtml = modelo.html(variaveis)
    if (!ehHtmlSeguro(corpoHtml)) throw new UnrecoverableError('modelo sem escape')
    const mensagem = {
      from: remetente,
      to: destinatario,
      envelope: { from: envelopeFrom, to: [destinatario] },
      subject: limparLinha(modelo.assunto(variaveis)),
      html: corpoHtml.toString(),
      text: String(modelo.texto(variaveis))
    }
    if (responderPara) mensagem.replyTo = responderPara
    const destinatarioMascarado = mascararEmail(destinatario)

    let info
    try {
      info = await transporte.enviar(mensagem)
    } catch (err) {
      // O erro original (com o endereço) não sai daqui: nem log, nem fila, nem `cause`.
      const { code, responseCode, erroCodigo, definitivo } = classificarErroEmail(err)
      const ultima = tentativa !== undefined && tentativa.feita + 1 >= tentativa.maxima
      const estado = definitivo || ultima ? 'falhou' : 'pendente'
      await marcarFalha(pool, envioId, geracao, { erroCodigo, destinatarioMascarado, definitiva: estado === 'falhou' })
      log.warn({ ...campos, estado, erro_codigo: erroCodigo }, 'envio de e-mail falhou')
      throw definitivo ? new ErroEmailDefinitivo({ code, responseCode }) : new ErroEmail({ code, responseCode })
    }

    const messageId = typeof info?.messageId === 'string' ? info.messageId.slice(0, MESSAGE_ID_MAX) : null
    const gravado = await marcarEnviado(pool, envioId, geracao, { destinatarioMascarado, messageId })
    if (!gravado) {
      log.warn({ ...campos }, 'e-mail enviado, mas a linha mudou antes do registro')
      return
    }
    log.info({ ...campos, estado: 'enviado' }, 'e-mail enviado')
  }
}
