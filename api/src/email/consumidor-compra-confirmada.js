// Consumidor `email_compra_confirmada` (E7-H2; CIT-66): para cada `pedido_pago`, pede o
// e-mail `compra_confirmada` na transação do outbox. A chave é por pedido, não por evento:
// cobre o reprocessamento e um eventual segundo `pedido_pago` do mesmo pedido. Fatura
// retida, cancelado e não pago são conferidos no envio (`carregar` do modelo), não aqui.
import { UnrecoverableError } from 'bullmq'
import { solicitarEmail } from './servico.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const emailCompraConfirmada = {
  eventos: ['pedido_pago'],
  async tratar({ cliente, evento, log }) {
    const pedidoId = evento.agregado_id
    if (evento.agregado_tipo !== 'pedido') throw new UnrecoverableError('agregado do evento não é pedido')
    if (typeof pedidoId !== 'string' || !UUID.test(pedidoId)) throw new UnrecoverableError('pedidoId inválido')
    if (evento.payload?.pedidoId !== pedidoId) throw new UnrecoverableError('pedidoId diverge do agregado')
    const { id: envioId, criado } = await solicitarEmail(cliente, {
      eventoId: evento.id,
      chaveIdempotencia: `compra_confirmada-${pedidoId}`,
      modelo: 'compra_confirmada',
      refs: { pedidoId }
    })
    log.info({ pedidoId, envioId, criado }, 'e-mail de compra confirmada solicitado')
  }
}
