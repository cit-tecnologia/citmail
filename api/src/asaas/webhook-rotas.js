// POST /api/asaas/webhook (ADR 0015; CIT-64): recebe o evento do Asaas, grava o bruto
// (só a lista branca) e responde 200. Nenhuma chamada ao Asaas nem mudança de pedido
// aqui: o worker enfileira e processa (`webhook-processamento.js`). Registrada só com
// `WEBHOOK_ASAAS_HABILITADO` (app.js).
import { createHash, timingSafeEqual } from 'node:crypto'
import { resumoEventoAsaas } from './resumo.js'
import { inserirBruto } from './webhook-repositorio.js'

// 16 KiB: um evento do Asaas cabe com folga; o limite global do app é 64 KiB.
export const LIMITE_CORPO_WEBHOOK = 16384

// Formato do id do evento do Asaas: premissa a confirmar no sandbox (#57, CA16).
export const ID_EVENTO_ASAAS = '^evt_[A-Za-z0-9_&.-]{1,120}$'

const ID_ASAAS = /^[A-Za-z0-9_]{1,64}$/
const STATUS = /^[A-Z_]{1,64}$/
const DATA = /^\d{4}-\d{2}-\d{2}$/
const REFERENCIA_MAX = 100
// Maior inteiro do `integer` do Postgres.
const CENTAVOS_MAX = 2147483647

// `additionalProperties` livre em todos os níveis: o Asaas acrescenta campos.
const corpoWebhook = {
  type: 'object',
  required: ['id', 'event'],
  properties: {
    id: { type: 'string', pattern: ID_EVENTO_ASAAS },
    event: { type: 'string', minLength: 1, maxLength: 64 },
    payment: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', pattern: ID_ASAAS.source } }
    }
  }
}

const tipoTexto = { type: 'string' }
const respostaErro = { type: 'object', additionalProperties: false, required: ['erro'], properties: { erro: tipoTexto } }
const respostas = {
  200: {
    type: 'object',
    additionalProperties: false,
    required: ['recebido'],
    properties: { recebido: { type: 'boolean' } }
  },
  401: respostaErro,
  503: respostaErro
}

function sha256(texto) {
  return createHash('sha256').update(texto, 'utf8').digest()
}

function textoNoFormato(valor, formato) {
  return typeof valor === 'string' && formato.test(valor) ? valor : null
}

// Data `AAAA-MM-DD` existente no calendário; senão null (o `::date` recusaria e daria 500).
function dataValida(valor) {
  if (typeof valor !== 'string' || !DATA.test(valor)) return null
  const data = new Date(`${valor}T00:00:00Z`)
  return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === valor ? valor : null
}

// `value` em reais → centavos inteiros; fora de número finito e não negativo, null.
function centavos(valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) return null
  const resultado = Math.round(valor * 100)
  return resultado <= CENTAVOS_MAX ? resultado : null
}

/**
 * Lista branca do evento bruto (decisão 4 do plano): ids, tipo, estado, valor e datas.
 * Valor fora do formato vira null. Nunca copia `customer`, `description`, `observations`,
 * `invoiceUrl`, `bankSlipUrl`, `creditCard*` nem o corpo inteiro.
 */
export function extrairCamposBrutos(corpo) {
  const pagamento = corpo.payment ?? {}
  const referencia = pagamento.externalReference
  return {
    asaasEventoId: corpo.id,
    evento: corpo.event,
    pagamentoId: textoNoFormato(pagamento.id, ID_ASAAS),
    assinaturaId: textoNoFormato(pagamento.subscription, ID_ASAAS),
    referenciaExterna: typeof referencia === 'string' && referencia.length <= REFERENCIA_MAX ? referencia : null,
    status: textoNoFormato(pagamento.status, STATUS),
    billingType: textoNoFormato(pagamento.billingType, STATUS),
    valorCentavos: centavos(pagamento.value),
    vencimento: dataValida(pagamento.dueDate),
    pagoEm: dataValida(pagamento.paymentDate) ?? dataValida(pagamento.confirmedDate)
  }
}

export default async function rotasWebhookAsaas(app, { token }) {
  const digestEsperado = token ? sha256(token) : null

  // Antes do parse do corpo e de qualquer acesso ao banco. Toda recusa responde igual
  // (mesmo corpo e cabeçalhos): nada revela o tamanho do token esperado.
  async function autenticar(request, reply) {
    if (!digestEsperado) return reply.code(503).send({ erro: 'webhook_indisponivel' })
    const recebido = request.headers['asaas-access-token']
    if (typeof recebido !== 'string' || recebido === '' ||
        !timingSafeEqual(sha256(recebido), digestEsperado)) {
      return reply.code(401).send({ erro: 'nao_autorizado' })
    }
  }

  app.post('/asaas/webhook', {
    bodyLimit: LIMITE_CORPO_WEBHOOK,
    onRequest: autenticar,
    schema: { body: corpoWebhook, response: respostas }
  }, async (request) => {
    const brutoId = await inserirBruto(app.banco, { ...extrairCamposBrutos(request.body), requestId: request.id })
    // Só o resumo (ADR 0013, item 8): nunca o corpo nem o cabeçalho do token.
    request.log.info({ ...resumoEventoAsaas(request.body), brutoId, repetido: brutoId === null }, 'webhook do asaas recebido')
    return { recebido: true }
  })
}
