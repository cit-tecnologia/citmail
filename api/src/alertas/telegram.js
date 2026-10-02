// Alerta de job esgotado pelo Telegram (ADR 0011; CIT-56). O texto leva só ids, nunca
// dado pessoal. O token vai na URL: nunca entra em log nem no erro lançado (erro novo,
// sem `cause`, porque a `cause` do `fetch` pode repetir a URL).

const UUID_ESTRITO = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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

export function montarTextoAlerta({ jobId, job, pedidoId } = {}) {
  return `Job falhou: job=${jobId} tipo=${job} pedido=${pedidoSeguro(pedidoId)}`
}

/**
 * Devolve `enviarAlerta({ jobId, job, pedidoId })`. Sem token ou chat id (só fora de
 * produção; o worker exige os dois em produção), o alerta sai só no log.
 * Erro de rede ou status não 2xx: `warn` só com o nome do erro ou o status e lança
 * `ErroTelegram` (a fila de alertas tenta de novo com backoff).
 */
export function criarEnvioTelegram({ token, chatId, fetch = globalThis.fetch, log }) {
  return async function enviarAlerta({ jobId, job, pedidoId } = {}) {
    if (!token || !chatId) {
      log.warn({ jobId, job, pedido: pedidoSeguro(pedidoId) }, 'alerta sem telegram')
      return
    }
    let resposta
    try {
      resposta = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: montarTextoAlerta({ jobId, job, pedidoId }) }),
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
