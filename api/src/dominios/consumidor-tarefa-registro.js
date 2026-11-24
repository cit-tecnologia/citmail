// Consumidor `tarefa_registro_dominio` (E4-H4; CIT-77): para cada `dominio_pago`, abre na
// transação do outbox uma tarefa `registro` por domínio novo do pedido (`ON CONFLICT DO
// NOTHING`: o reprocessamento não duplica). Pedido cancelado não abre; fatura retida abre
// (o domínio foi pago). O aviso à equipe sai do laço do worker (`laco.js`), não daqui: a
// fila não é transacional.
import { UnrecoverableError } from 'bullmq'
import { buscarEstadoDoPedido } from '../asaas/webhook-repositorio.js'
import { inserirTarefasRegistro } from './repositorio.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const tarefaRegistroDominio = {
  eventos: ['dominio_pago'],
  async tratar({ cliente, evento, log }) {
    const pedidoId = evento.agregado_id
    if (evento.agregado_tipo !== 'pedido') throw new UnrecoverableError('agregado do evento não é pedido')
    if (typeof pedidoId !== 'string' || !UUID.test(pedidoId)) throw new UnrecoverableError('pedidoId inválido')
    if (evento.payload?.pedidoId !== pedidoId) throw new UnrecoverableError('pedidoId diverge do agregado')
    const estado = await buscarEstadoDoPedido(cliente, pedidoId)
    if (estado === null) throw new UnrecoverableError('pedido inexistente')
    if (estado === 'cancelado') {
      log.info({ pedidoId, eventoId: evento.id }, 'pedido cancelado: tarefa não aberta')
      return
    }
    const tarefas = await inserirTarefasRegistro(cliente, pedidoId)
    log.info({ pedidoId, eventoId: evento.id, tarefas }, 'tarefas de registro de domínio abertas')
  }
}
