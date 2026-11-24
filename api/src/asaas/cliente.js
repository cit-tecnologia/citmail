// Adaptador HTTP da API v3 do Asaas (ADR 0014, D4; CIT-61). Injetável em
// `construirApp(config, { asaas })`; os testes usam só um stub local.
// Erros saem como `ErroAsaas` com `tipo` e `status`, nunca com corpo ou mensagem do
// Asaas. Premissas P1–P8 do ADR 0014, a confirmar no sandbox (#57).

const ID = /^[A-Za-z0-9_]{1,64}$/
const STATUS_PAGAMENTO = /^[A-Z_]{1,64}$/
const DATA = /^\d{4}-\d{2}-\d{2}$/
const URL_FATURA_MAX = 2048
const USER_AGENT = 'citmail-api'

export class ErroAsaas extends Error {
  constructor(tipo, status) {
    super(`asaas: ${tipo}`)
    this.name = 'ErroAsaas'
    this.tipo = tipo
    this.status = status
  }
}

// Valores do Asaas em reais. Exato para centavos inteiros (CA17).
export function centavosParaReais(centavos) {
  return centavos / 100
}

function idValido(valor) {
  if (typeof valor !== 'string' || !ID.test(valor)) throw new ErroAsaas('resposta_invalida')
  return valor
}

// Itens removidos (`deleted: true`) nunca são reaproveitados (P7).
function ativos(corpo) {
  if (!Array.isArray(corpo?.data)) throw new ErroAsaas('resposta_invalida')
  return corpo.data.filter((item) => item?.deleted !== true)
}

function primeiroAtivo(corpo) {
  return ativos(corpo)[0] ?? null
}

// Ordem determinística: `dateCreated` crescente e, no empate, id crescente. O
// `dateCreated` pode vir só com a data (`AAAA-MM-DD`): no mesmo dia, decide o id, que
// não é necessariamente a ordem de criação.
function maisAntigaPrimeiro(a, b) {
  const dataA = typeof a?.dateCreated === 'string' ? a.dateCreated : ''
  const dataB = typeof b?.dateCreated === 'string' ? b.dateCreated : ''
  if (dataA !== dataB) return dataA < dataB ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function urlHttps(valor) {
  if (typeof valor !== 'string' || valor.length > URL_FATURA_MAX || !valor.startsWith('https://')) return null
  try {
    return new URL(valor).protocol === 'https:' ? valor : null
  } catch {
    return null
  }
}

/**
 * @param {{ baseUrl: string, apiKey: string, timeoutMs: number, fetch?: typeof fetch }} opcoes
 */
export function criarClienteAsaas({ baseUrl, apiKey, timeoutMs, fetch = globalThis.fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '')

  // Cada chamada tem o próprio timeout, combinado ao `signal` do chamador (prazo global).
  async function chamar(metodo, caminho, { corpo, signal } = {}) {
    const sinais = [AbortSignal.timeout(timeoutMs)]
    if (signal) sinais.push(signal)
    const sinal = AbortSignal.any(sinais)
    let resposta
    try {
      resposta = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers: {
          access_token: apiKey,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT
        },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        redirect: 'error',
        signal: sinal
      })
    } catch {
      // Com `redirect: 'error'`, um 302 também cai aqui (TypeError) e vira `rede`.
      throw new ErroAsaas(sinal.aborted ? 'timeout' : 'rede')
    }

    const { status } = resposta
    if (status < 200 || status > 299) {
      // O corpo de erro nunca é lido: não chega a log nem a resposta.
      resposta.body?.cancel().catch(() => {})
      if (status >= 400 && status <= 499) throw new ErroAsaas('http_4xx', status)
      if (status >= 500) throw new ErroAsaas('http_5xx', status)
      throw new ErroAsaas('resposta_invalida', status)
    }
    let texto
    try {
      texto = await resposta.text()
    } catch {
      throw new ErroAsaas(sinal.aborted ? 'timeout' : 'rede', status)
    }
    if (texto === '') return null
    try {
      return JSON.parse(texto)
    } catch {
      throw new ErroAsaas('resposta_invalida', status)
    }
  }

  return {
    // GET /customers?cpfCnpj= → `{ id, nome, email }` do primeiro cliente não removido,
    // ou null (P2). `nome` e `email` só servem para conferir o contato do pedido (nunca
    // vão a log nem a resposta); fora de texto, viram null.
    async buscarClientePorDocumento(documento, { signal } = {}) {
      const corpo = await chamar('GET', `/customers?${new URLSearchParams({ cpfCnpj: documento })}`, { signal })
      const item = primeiroAtivo(corpo)
      if (!item) return null
      return {
        id: idValido(item.id),
        nome: typeof item.name === 'string' ? item.name : null,
        email: typeof item.email === 'string' ? item.email : null
      }
    },

    // POST /customers com notificações do Asaas desligadas (ADR 0014, decisão 8).
    // Telefone com 10 dígitos vai em `phone`; com 11, em `mobilePhone` (P8).
    async criarCliente({ nome, email, telefone, documento, referencia }, { signal } = {}) {
      const campoTelefone = telefone.length === 11 ? 'mobilePhone' : 'phone'
      const corpo = await chamar('POST', '/customers', {
        signal,
        corpo: {
          name: nome,
          cpfCnpj: documento,
          email,
          [campoTelefone]: telefone,
          externalReference: referencia,
          notificationDisabled: true
        }
      })
      return idValido(corpo?.id)
    },

    // GET /subscriptions?externalReference= → ids de todas as não removidas, da mais
    // antiga para a mais nova (P3); lista vazia se não houver.
    async listarAssinaturasPorReferencia(referencia, { signal } = {}) {
      const corpo = await chamar('GET', `/subscriptions?${new URLSearchParams({ externalReference: referencia })}`, { signal })
      return ativos(corpo).map((item) => ({ ...item, id: idValido(item?.id) })).sort(maisAntigaPrimeiro).map((item) => item.id)
    },

    // POST /subscriptions; o comprador escolhe a forma de pagamento na fatura (P4).
    async criarAssinatura({ cliente, valorCentavos, vencimento, ciclo, referencia }, { signal } = {}) {
      const corpo = await chamar('POST', '/subscriptions', {
        signal,
        corpo: {
          customer: cliente,
          billingType: 'UNDEFINED',
          value: centavosParaReais(valorCentavos),
          nextDueDate: vencimento,
          cycle: ciclo,
          description: referencia,
          externalReference: referencia
        }
      })
      return idValido(corpo?.id)
    },

    // URL da 1ª cobrança (GET /subscriptions/{id}/payments); só `https://`, senão null.
    async urlPrimeiraFatura(assinaturaId, { signal } = {}) {
      const corpo = await chamar('GET', `/subscriptions/${idValido(assinaturaId)}/payments`, { signal })
      const item = primeiroAtivo(corpo)
      return item ? urlHttps(item.invoiceUrl) : null
    },

    // GET /payments/{id} (conferência do webhook, ADR 0015; CIT-64) → `{ id, subscription,
    // status, value, dueDate, externalReference }` validados (`value` em reais; campo
    // opcional ausente → null). 404 → `ErroAsaas('nao_encontrado', 404)`.
    async buscarPagamento(pagamentoId, { signal } = {}) {
      let corpo
      try {
        corpo = await chamar('GET', `/payments/${idValido(pagamentoId)}`, { signal })
      } catch (err) {
        if (err instanceof ErroAsaas && err.status === 404) throw new ErroAsaas('nao_encontrado', 404)
        throw err
      }
      if (typeof corpo !== 'object' || corpo === null) throw new ErroAsaas('resposta_invalida')
      const { subscription, status, value, dueDate, externalReference } = corpo
      if (typeof status !== 'string' || !STATUS_PAGAMENTO.test(status)) throw new ErroAsaas('resposta_invalida')
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ErroAsaas('resposta_invalida')
      if (dueDate != null && (typeof dueDate !== 'string' || !DATA.test(dueDate))) throw new ErroAsaas('resposta_invalida')
      if (externalReference != null && typeof externalReference !== 'string') throw new ErroAsaas('resposta_invalida')
      return {
        id: idValido(corpo.id),
        subscription: subscription == null ? null : idValido(subscription),
        status,
        value,
        dueDate: dueDate ?? null,
        externalReference: externalReference ?? null
      }
    },

    // DELETE /subscriptions/{id}: remove a assinatura e as cobranças pendentes (P5).
    async removerAssinatura(assinaturaId, { signal } = {}) {
      await chamar('DELETE', `/subscriptions/${idValido(assinaturaId)}`, { signal })
    }
  }
}
