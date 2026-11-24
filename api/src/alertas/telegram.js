// Alertas pelo Telegram (ADR 0011): job esgotado (CIT-56), resultado do webhook do
// Asaas (`tipo: 'webhook'`, CIT-64) e e-mail parado (`tipo: 'email_parado'`, CIT-65). O texto leva só ids e códigos, nunca dado pessoal.
// O token vai na URL: nunca entra em log nem no erro lançado (erro novo, sem `cause`,
// porque a `cause` do `fetch` pode repetir a URL).

const UUID_ESTRITO = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CODIGO = /^[a-z][a-z0-9_]{0,47}$/
const LIMITE_MS = 10000

export class ErroTelegram extends Error {
  constructor(mensagem) {
    super(mensagem)
    this.name = 'ErroTelegram'
  }
}

// `pedidoId` fora do formato UUID estrito vira `-`: o campo não carrega texto livre.
export function pedidoSeguro(pedidoId) {
  return typeof pedidoId === 'string' && UUID_ESTRITO.test(pedidoId) ? pedidoId : '-'
}

// `codigo` fora do padrão de código vira `-`.
export function codigoSeguro(codigo) {
  return typeof codigo === 'string' && CODIGO.test(codigo) ? codigo : '-'
}

// Três formatos: `{ jobId, job, pedidoId }` (job esgotado),
// `{ tipo: 'webhook', codigo, brutoId, pedidoId }` (webhook do Asaas) e
// `{ tipo: 'email_parado', envioId }` (e-mail pendente há mais de `EMAIL_PARADO_HORAS`),
// com os ids validados.
export function montarTextoAlerta(dados = {}) {
  if (dados.tipo === 'email_parado') {
    return `E-mail parado: envio=${pedidoSeguro(dados.envioId)}`
  }
  if (dados.tipo === 'webhook') {
    return `Webhook do Asaas: codigo=${codigoSeguro(dados.codigo)} bruto=${pedidoSeguro(dados.brutoId)} ` +
      `pedido=${pedidoSeguro(dados.pedidoId)}`
  }
  const { jobId, job, pedidoId } = dados
  return `Job falhou: job=${jobId} tipo=${job} pedido=${pedidoSeguro(pedidoId)}`
}

// Campos do log sem Telegram, com os mesmos ids validados do texto.
function camposDoLog(dados) {
  if (dados.tipo === 'email_parado') {
    return { tipo: 'email_parado', envio: pedidoSeguro(dados.envioId) }
  }
  if (dados.tipo === 'webhook') {
    return {
      tipo: 'webhook',
      codigo: codigoSeguro(dados.codigo),
      bruto: pedidoSeguro(dados.brutoId),
      pedido: pedidoSeguro(dados.pedidoId)
    }
  }
  return { jobId: dados.jobId, job: dados.job, pedido: pedidoSeguro(dados.pedidoId) }
}

/**
 * Devolve `enviarAlerta(dados)`, com `dados` num dos três formatos de `montarTextoAlerta`.
 * Sem token ou chat id (só fora de produção; o worker exige os dois em produção), o
 * alerta sai só no log.
 * Erro de rede ou status não 2xx: `warn` só com o nome do erro ou o status e lança
 * `ErroTelegram` (a fila de alertas tenta de novo com backoff).
 */
export function criarEnvioTelegram({ token, chatId, fetch = globalThis.fetch, log }) {
  return async function enviarAlerta(dados = {}) {
    if (!token || !chatId) {
      log.warn(camposDoLog(dados), 'alerta sem telegram')
      return
    }
    let resposta
    try {
      resposta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: montarTextoAlerta(dados) }),
        signal: AbortSignal.timeout(LIMITE_MS)
      })
    } catch (err) {
      log.warn({ erro: err?.name }, 'envio ao telegram falhou')
      throw new ErroTelegram('telegram indisponível (rede)')
    }
    // Corpo descartado: só o status interessa.
    resposta.body?.cancel?.().catch(() => {})
    if (!resposta.ok) {
      log.warn({ status: resposta.status }, 'envio ao telegram falhou')
      throw new ErroTelegram(`telegram respondeu ${resposta.status}`)
    }
  }
}
