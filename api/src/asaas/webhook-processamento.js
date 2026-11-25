// Processamento do webhook do Asaas no worker (ADR 0015; CIT-64). O enfileirador é um
// laço (mesma forma do publicador do outbox) que cria um job `asaas_webhook` por bruto
// ainda não enfileirado; o handler confere o pagamento no Asaas, decide pela matriz
// evento × status atual e aplica o efeito numa transação: pedido, conta do titular,
// eventos pelo outbox e resultado do bruto. Erro recuperável lança: a fila tenta de novo,
// alerta o esgotado e aceita `npm run reprocessar -- asaas_webhook-<brutoId>`.
import { UnrecoverableError } from 'bullmq'
import { comPrazo } from '../fila/prazo.js'
import { registrarEvento } from '../eventos/servico.js'
import { buscarContaPorClienteOuEmail, inserirContaSeNova } from '../contas/repositorio.js'
import { ErroAsaas } from './cliente.js'
import {
  buscarAssinaturaPorAsaasId, buscarBruto, buscarEstadoDoPedido, buscarNaoEnfileirados, buscarParados,
  marcarAlertadoPendente, marcarDominioPago, pagamentoJaAplicado, marcarEnfileirados, marcarResultado, mudarEstadoDoPedido,
  travarBruto, travarPedido
} from './webhook-repositorio.js'

export const JOB_WEBHOOK = 'asaas_webhook'
export const INTERVALO_PADRAO_MS = 2000
export const LOTE_PADRAO = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REFERENCIA_PEDIDO = /^pedido:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(contas|dominios)$/

const EVENTOS_PAGO = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'])
const EVENTO_VENCIDO = 'PAYMENT_OVERDUE'
const STATUS_PAGO = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'])
const STATUS_NAO_CONFIRMADO = new Set(['PENDING', 'AWAITING_RISK_ANALYSIS'])
const STATUS_ESTORNO = new Set([
  'REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE',
  'AWAITING_CHARGEBACK_REVERSAL'
])

// Pedido nesses estados nunca recebe efeito de pagamento nem de vencimento.
const ESTADOS_SEM_EFEITO = new Set(['falhou_na_criacao', 'cancelado'])

// Alerta do resultado do bruto, depois do COMMIT: um por bruto (`alerta-wh-<brutoId>`).
// Falha só vai ao log (o bruto já guarda situação e código).
async function enfileirarAlerta({ filas, log }, { codigo, brutoId, pedidoId }) {
  try {
    await comPrazo(filas.alertas.add('webhook',
      { tipo: 'webhook', codigo, brutoId, pedidoId: pedidoId ?? null },
      { jobId: `alerta-wh-${brutoId}` }))
  } catch (err) {
    log.error({ erro: err?.name, brutoId, codigo }, 'alerta não enfileirado')
  }
}

// Matriz evento × status atual no Asaas (decisão 6 d do plano). `pago` e `vencido` são
// os únicos com efeito; o resto devolve `{ situacao, codigo, alerta }`.
function decidirPelaMatriz(evento, status) {
  if (STATUS_ESTORNO.has(status)) return { situacao: 'ignorado', codigo: 'estornado', alerta: true }
  if (EVENTOS_PAGO.has(evento)) {
    if (STATUS_PAGO.has(status)) return { efeito: 'pago' }
    if (STATUS_NAO_CONFIRMADO.has(status)) return { situacao: 'ignorado', codigo: 'pagamento_nao_confirmado', alerta: true }
    if (status === 'OVERDUE') return { situacao: 'ignorado', codigo: 'status_divergente', alerta: true }
    return { situacao: 'ignorado', codigo: 'status_desconhecido', alerta: true }
  }
  if (status === 'OVERDUE') return { efeito: 'vencido' }
  if (STATUS_PAGO.has(status)) return { situacao: 'ignorado', codigo: 'ja_pago', alerta: false }
  if (STATUS_NAO_CONFIRMADO.has(status)) return { situacao: 'ignorado', codigo: 'status_divergente', alerta: false }
  return { situacao: 'ignorado', codigo: 'status_desconhecido', alerta: true }
}

/**
 * Handler do job `asaas_webhook` (`data = { brutoId, requestId }`). `asaas` é o adaptador
 * (`criarClienteAsaas`); `filas` recebe os alertas (as do publicador no worker). Bruto já
 * fora de `pendente` → sem efeito. `brutoId` inválido ou bruto inexistente →
 * `UnrecoverableError`. Rede, 5xx, timeout ou pedido ainda em `criando` → lança (nova
 * tentativa). Divergência, evento fora da lista e status sem efeito → resultado terminal
 * no bruto, com alerta quando a matriz pede, sem lançar.
 */
export function criarHandlerWebhook({ pool, asaas, filas, log: logRaiz }) {
  return async function tratarWebhook({ log = logRaiz } = {}, { brutoId, requestId } = {}) {
    if (typeof brutoId !== 'string' || !UUID.test(brutoId)) throw new UnrecoverableError('brutoId inválido')
    const bruto = await buscarBruto(pool, brutoId)
    if (!bruto) throw new UnrecoverableError('bruto inexistente')
    if (bruto.situacao !== 'pendente') {
      log.info({ brutoId }, 'webhook já processado')
      return
    }

    // Resultado sem efeito: só sai de `pendente` uma vez (UPDATE condicional), e só então alerta.
    async function terminar(situacao, codigo, { alerta = false, pedidoId = null } = {}) {
      const gravado = await marcarResultado(pool, brutoId, situacao, codigo)
      if (!gravado) {
        log.info({ brutoId }, 'webhook já processado por outra execução')
        return
      }
      log.info({ brutoId, situacao, codigo }, 'webhook sem efeito')
      if (alerta) await enfileirarAlerta({ filas, log }, { codigo, brutoId, pedidoId })
    }

    if (!(EVENTOS_PAGO.has(bruto.evento) || bruto.evento === EVENTO_VENCIDO) || !bruto.pagamento_id) {
      return terminar('ignorado', 'evento_fora_da_lista')
    }

    // (b) Achar o pedido: pela assinatura local; sem ela, pela referência externa.
    const assinatura = bruto.assinatura_id ? await buscarAssinaturaPorAsaasId(pool, bruto.assinatura_id) : null
    if (!assinatura) {
      const referencia = REFERENCIA_PEDIDO.exec(bruto.referencia_externa ?? '')
      const estado = referencia ? await buscarEstadoDoPedido(pool, referencia[1]) : null
      if (!estado) return terminar('ignorado', 'assinatura_desconhecida', { alerta: true })
      const pedidoId = referencia[1]
      // A assinatura local nasce quando a criação concluir: nova tentativa pela fila.
      if (estado === 'criando') throw new Error('pedido em criação')
      if (estado === 'falhou_na_criacao') {
        return terminar('ignorado', 'pedido_falhou_na_criacao', { alerta: true, pedidoId })
      }
      return terminar('divergente', 'assinatura_divergente', { alerta: true, pedidoId })
    }
    const pedidoId = assinatura.pedido_id
    if (assinatura.pedido_estado === 'criando') throw new Error('pedido em criação')
    if (ESTADOS_SEM_EFEITO.has(assinatura.pedido_estado)) {
      return terminar('ignorado', `pedido_${assinatura.pedido_estado}`, { alerta: true, pedidoId })
    }

    // (c) Conferência no Asaas, fora da transação. Rede, 5xx e timeout lançam. Sem
    // adaptador (fora de produção, sem chave), também: o bruto fica para reenvio.
    if (!asaas) throw new Error('asaas não configurado')
    let pagamento
    try {
      pagamento = await asaas.buscarPagamento(bruto.pagamento_id)
    } catch (err) {
      if (err instanceof ErroAsaas && err.tipo === 'nao_encontrado') {
        return terminar('divergente', 'pagamento_inexistente', { alerta: true, pedidoId })
      }
      throw err
    }
    if (pagamento.subscription !== assinatura.asaas_assinatura_id) {
      return terminar('divergente', 'assinatura_divergente', { alerta: true, pedidoId })
    }
    if (pagamento.externalReference !== null &&
        pagamento.externalReference !== `pedido:${pedidoId}:${assinatura.tipo}`) {
      return terminar('divergente', 'referencia_divergente', { alerta: true, pedidoId })
    }

    // (d) Matriz pelo status atual, não pelo do bruto.
    const decisao = decidirPelaMatriz(bruto.evento, pagamento.status)
    if (!decisao.efeito) {
      return terminar(decisao.situacao, decisao.codigo, { alerta: decisao.alerta, pedidoId })
    }
    if (decisao.efeito === 'pago' && Math.round(pagamento.value * 100) !== assinatura.valor_centavos) {
      return terminar('divergente', 'valor_divergente', { alerta: true, pedidoId })
    }

    // (e) Efeito numa transação, sem try/catch em volta de query.
    const contexto = {
      bruto, assinatura, pedidoId, pagamento, requestId: bruto.request_id ?? requestId
    }
    const cliente = await pool.connect()
    let erroDoCliente
    let alerta = null
    try {
      await cliente.query('BEGIN')
      const travado = await travarBruto(cliente, brutoId)
      if (travado?.situacao !== 'pendente') {
        await cliente.query('COMMIT')
        log.info({ brutoId }, 'webhook já processado')
        return
      }
      const pedido = await travarPedido(cliente, pedidoId)
      // Estado relido depois da trava: o pedido pode ter mudado desde a leitura sem trava.
      // `criando` lança (o ROLLBACK abaixo); cancelado ou falho não tem efeito.
      if (pedido.estado === 'criando') throw new Error('pedido em criação')
      const resultado = ESTADOS_SEM_EFEITO.has(pedido.estado)
        ? { situacao: 'ignorado', codigo: `pedido_${pedido.estado}`, alerta: `pedido_${pedido.estado}` }
        : decisao.efeito === 'vencido'
          ? await aplicarVencido(cliente, contexto, pedido)
          : assinatura.tipo === 'contas'
            ? await aplicarContasPagas(cliente, contexto, pedido)
            : await aplicarDominiosPagos(cliente, contexto, pedido)
      await marcarResultado(cliente, brutoId, resultado.situacao, resultado.codigo)
      const fim = await cliente.query('COMMIT')
      if (fim.command === 'ROLLBACK') throw new Error('transação do webhook abortada')
      log.info({ brutoId, situacao: resultado.situacao, codigo: resultado.codigo }, 'webhook processado')
      alerta = resultado.alerta ?? null
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
    if (alerta) await enfileirarAlerta({ filas, log }, { codigo: alerta, brutoId, pedidoId })
  }
}

// Efeito de pago já aplicado: o mesmo pagamento (outro evento do Asaas, ex.: CONFIRMED e
// depois RECEIVED) é `pagamento_repetido`; outro pagamento é `pagamento_seguinte`.
async function pagamentoJaVisto(cliente, bruto) {
  const repetido = await pagamentoJaAplicado(cliente, bruto.pagamento_id, bruto.id)
  return { situacao: 'ignorado', codigo: repetido ? 'pagamento_repetido' : 'pagamento_seguinte' }
}

// Pago, assinatura de contas: só o 1º pagamento (pedido em `aguardando_pagamento`). Com
// domínio novo já pago e registrado pela equipe (CIT-77, registro antes das contas), vai
// direto a `pago` e emite também `dominio_registrado`, na mesma transação.
async function aplicarContasPagas(cliente, { bruto, assinatura, pedidoId, requestId }, pedido) {
  if (pedido.estado !== 'aguardando_pagamento') return pagamentoJaVisto(cliente, bruto)
  const temDominioNovo = pedido.tem_dominio_novo
  const dominioRegistrado = temDominioNovo && pedido.dominio_pago_em !== null && pedido.dominio_registrado_em !== null
  const novoEstado = !temDominioNovo || dominioRegistrado
    ? 'pago'
    : pedido.dominio_pago_em === null ? 'aguardando_pagamento_do_dominio' : 'aguardando_registro_de_dominio'
  await mudarEstadoDoPedido(cliente, pedidoId, novoEstado)
  await registrarEvento(cliente, {
    nome: 'pedido_pago',
    agregado: { tipo: 'pedido', id: pedidoId },
    chaveIdempotencia: `pedido_pago-${pedidoId}`,
    payload: {
      pedidoId, clienteId: pedido.cliente_id, assinaturaId: assinatura.id, ciclo: pedido.ciclo, temDominioNovo
    },
    requestId
  })
  if (dominioRegistrado) {
    await registrarEvento(cliente, {
      nome: 'dominio_registrado',
      agregado: { tipo: 'pedido', id: pedidoId },
      chaveIdempotencia: `dominio_registrado-${pedidoId}`,
      payload: { pedidoId, clienteId: pedido.cliente_id },
      requestId
    })
  }

  // Conta do titular (decisão 9): com a fatura retida, não nasce; a equipe resolve o contato.
  if (pedido.fatura_retida) {
    return { situacao: 'processado', codigo: 'conta_nao_criada_fatura_retida', alerta: 'contato_divergente' }
  }
  // O e-mail do contato nunca vai a log nem a evento.
  const email = pedido.contato_email
  const contaId = await inserirContaSeNova(cliente, pedido.cliente_id, email)
  if (contaId) {
    await registrarEvento(cliente, {
      nome: 'conta_titular_criada',
      agregado: { tipo: 'conta_titular', id: contaId },
      chaveIdempotencia: `conta_titular_criada-${contaId}`,
      payload: { contaId, clienteId: pedido.cliente_id, pedidoId },
      requestId
    })
    return { situacao: 'processado', codigo: null }
  }
  const existentes = await buscarContaPorClienteOuEmail(cliente, pedido.cliente_id, email)
  if (existentes.some((conta) => conta.cliente_id === pedido.cliente_id)) {
    return { situacao: 'processado', codigo: null }
  }
  return { situacao: 'processado', codigo: 'conta_email_em_uso', alerta: 'conta_email_em_uso' }
}

// Pago, assinatura de domínios: só o 1º pagamento (`dominio_pago_em` nulo).
async function aplicarDominiosPagos(cliente, { bruto, assinatura, pedidoId, requestId }, pedido) {
  if (pedido.dominio_pago_em !== null) return pagamentoJaVisto(cliente, bruto)
  await marcarDominioPago(cliente, pedidoId)
  await registrarEvento(cliente, {
    nome: 'dominio_pago',
    agregado: { tipo: 'pedido', id: pedidoId },
    chaveIdempotencia: `dominio_pago-${pedidoId}`,
    payload: { pedidoId, assinaturaId: assinatura.id, temDominioNovo: pedido.tem_dominio_novo },
    requestId
  })
  return { situacao: 'processado', codigo: null }
}

// Vencido: só o evento; pedido e conta não mudam.
async function aplicarVencido(cliente, { bruto, assinatura, pagamento, requestId }, pedido) {
  await registrarEvento(cliente, {
    nome: 'cobranca_vencida',
    agregado: { tipo: 'assinatura', id: assinatura.id },
    chaveIdempotencia: `cobranca_vencida-${bruto.pagamento_id}`,
    payload: {
      clienteId: pedido.cliente_id,
      assinaturaId: assinatura.id,
      cobrancaAsaasId: bruto.pagamento_id,
      vencimento: pagamento.dueDate ?? bruto.vencimento
    },
    requestId
  })
  return { situacao: 'processado', codigo: null }
}

/**
 * Um ciclo do enfileirador: lê até `lote` brutos não enfileirados e cria um job
 * `asaas_webhook` por bruto (`jobId = asaas_webhook-<brutoId>`, `data = { brutoId,
 * requestId }`) num só `addBulk` com prazo de 2 s; depois marca `enfileirado_em`. Falha:
 * `enfileirado_em` fica nulo e o lote volta no próximo ciclo. No mesmo ciclo, bruto
 * `pendente` enfileirado há mais de 1 hora, ou recebido há mais de 1 hora e nunca
 * enfileirado, gera um alerta `webhook_parado` (uma vez: `alertado_pendente_em`).
 * Nunca lança.
 *
 * @returns {Promise<{ enfileirados: number, parados: number }>}
 */
export async function enfileirarPendentes({ pool, filas, log, lote = LOTE_PADRAO }) {
  const resultado = { enfileirados: 0, parados: 0 }
  try {
    const brutos = await buscarNaoEnfileirados(pool, lote)
    if (brutos.length > 0) {
      const ids = brutos.map((bruto) => bruto.id)
      try {
        await comPrazo(filas.jobs.addBulk(brutos.map((bruto) => ({
          name: JOB_WEBHOOK,
          data: { brutoId: bruto.id, requestId: bruto.request_id },
          opts: { jobId: `${JOB_WEBHOOK}-${bruto.id}` }
        }))))
        // Jobs criados e marca não gravada: o próximo ciclo repete o `jobId`, sem duplicar.
        await marcarEnfileirados(pool, ids)
        resultado.enfileirados = ids.length
      } catch (err) {
        // Erro do ioredis traz host e porta: só o nome.
        log.warn({ erro: err?.name, codigo: err?.code, brutos: ids.length }, 'enfileiramento do webhook falhou')
      }
    }
  } catch (err) {
    log.error({ erro: err?.name, codigo: err?.code }, 'leitura de webhooks falhou')
  }

  try {
    const parados = await buscarParados(pool, lote)
    if (parados.length > 0) {
      const ids = parados.map((bruto) => bruto.id)
      await comPrazo(filas.alertas.addBulk(ids.map((brutoId) => ({
        name: 'webhook',
        data: { tipo: 'webhook', codigo: 'webhook_parado', brutoId, pedidoId: null },
        opts: { jobId: `alerta-whp-${brutoId}` }
      }))))
      await marcarAlertadoPendente(pool, ids)
      resultado.parados = ids.length
    }
  } catch (err) {
    log.warn({ erro: err?.name, codigo: err?.code }, 'alerta de webhook parado falhou')
  }
  return resultado
}

/**
 * Inicia o laço do enfileirador, na forma de `iniciarPublicador`: um ciclo logo ao
 * iniciar e os seguintes a cada `intervaloMs` depois do fim do anterior. `aoCiclo` só
 * nos testes. `close()` cancela o próximo ciclo e espera o que estiver em curso.
 *
 * @returns {{ close: () => Promise<void> }}
 */
export function iniciarEnfileiradorWebhook({
  pool, filas, log, intervaloMs = INTERVALO_PADRAO_MS, lote = LOTE_PADRAO, aoCiclo
}) {
  let parado = false
  let timer
  let emCurso = null

  async function rodar() {
    try {
      // Fora do encadeamento opcional: sem aoCiclo, o argumento não seria avaliado.
      const resultado = await enfileirarPendentes({ pool, filas, log, lote })
      aoCiclo?.(resultado)
    } catch (err) {
      log.error({ erro: err?.name }, 'ciclo do enfileirador falhou')
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
  log.info({ intervaloMs }, 'enfileirador do webhook iniciado')

  return {
    async close() {
      parado = true
      clearTimeout(timer)
      if (emCurso) await emCurso
    }
  }
}
