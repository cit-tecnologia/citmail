// CIT-77, CA1: o consumidor `tarefa_registro_dominio` abre uma tarefa `registro` por domínio
// novo ao processar `dominio_pago` (banco migrado, papel da aplicação), sem duplicar no
// reprocessamento. Só dados fictícios.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { UnrecoverableError } from 'bullmq'
import { criarLogger } from '../src/log.js'
import { consumidoresPadrao, processarEvento } from '../src/eventos/consumidores.js'
import { criarCapturaDeLog } from './auxiliares.js'
import { DOMINIO_UM, DOMINIO_DOIS, gravarDominioPago, semearComTarefas, tarefasDe, TRUNCAR } from './dominio-fixtures.js'
import { criarBancoWebhook } from './webhook-fixtures.js'

let banco
let captura
let log

before(async () => {
  banco = await criarBancoWebhook()
})

after(async () => {
  await banco.fechar()
})

beforeEach(async () => {
  await banco.admin.query(TRUNCAR)
  captura = criarCapturaDeLog()
  log = criarLogger({ level: 'info', stream: captura.stream })
})

const consumir = (eventoId) => processarEvento({
  pool: banco.app, consumidor: 'tarefa_registro_dominio', tratar: consumidoresPadrao.tarefa_registro_dominio.tratar, log
}, { eventoId })

const semear = (opcoes) => semearComTarefas(banco.admin, { tarefas: false, ...opcoes })

test('CA1: dominio_pago de pedido com 2 domínios novos abre 2 tarefas de registro abertas', async () => {
  const { pedidoId } = await semear()
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  const tarefas = await tarefasDe(banco.admin)
  assert.equal(tarefas.length, 2)
  for (const tarefa of tarefas) {
    assert.equal(tarefa.tipo, 'registro')
    assert.equal(tarefa.concluida_em, null)
    assert.equal(tarefa.referencia_expira_em, null)
    assert.equal(tarefa.situacao_fatura, null)
    assert.equal(tarefa.alertada_em, null)
  }
})

test('CA1: o pedido continua em aguardando_registro_de_dominio', async () => {
  const { pedidoId } = await semear()
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  const { rows } = await banco.admin.query('SELECT estado FROM pedido WHERE id = $1', [pedidoId])
  assert.equal(rows[0].estado, 'aguardando_registro_de_dominio')
})

test('CA1: reprocessar o mesmo evento (consumidor chamado 2x) mantém 2 tarefas', async () => {
  const { pedidoId } = await semear()
  const eventoId = await gravarDominioPago(banco.admin, pedidoId)
  await consumir(eventoId)
  await banco.admin.query('TRUNCATE evento_processado')
  await consumir(eventoId)
  assert.equal((await tarefasDe(banco.admin)).length, 2)
})

test('CA1: um segundo dominio_pago do mesmo pedido não duplica as tarefas', async () => {
  const { pedidoId } = await semear()
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  assert.equal((await tarefasDe(banco.admin)).length, 2)
})

test('CA1: pedido cancelado não abre tarefa', async () => {
  const { pedidoId } = await semear({ estado: 'cancelado' })
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  assert.equal((await tarefasDe(banco.admin)).length, 0)
})

test('CA1: pedido cancelado registra no log só ids, sem o nome do domínio', async () => {
  const { pedidoId } = await semear({ estado: 'cancelado' })
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  const texto = captura.texto()
  assert.match(texto, /pedido cancelado: tarefa não aberta/)
  assert.ok(!texto.includes(DOMINIO_UM))
})

test('CA1: pedido com fatura retida abre as 2 tarefas', async () => {
  const { pedidoId } = await semear({ faturaRetida: true })
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  assert.equal((await tarefasDe(banco.admin)).length, 2)
})

test('CA1: domínio principal existente com 1 extra novo abre só 1 tarefa, a do extra', async () => {
  const { pedidoId } = await semear({
    dominios: [{ nome: DOMINIO_UM, tipo: 'existente', papel: 'principal' }, { nome: DOMINIO_DOIS, tipo: 'novo', papel: 'extra' }]
  })
  await consumir(await gravarDominioPago(banco.admin, pedidoId))
  const tarefas = await tarefasDe(banco.admin)
  assert.equal(tarefas.length, 1)
  const { rows } = await banco.admin.query('SELECT nome FROM pedido_dominio WHERE id = $1', [tarefas[0].pedido_dominio_id])
  assert.equal(rows[0].nome, DOMINIO_DOIS)
})

test('CA1: o consumidor está no registro de produção e escuta só dominio_pago', () => {
  assert.deepEqual(consumidoresPadrao.tarefa_registro_dominio.eventos, ['dominio_pago'])
})

test('CA1: agregado que não é pedido lança UnrecoverableError, sem tarefa', async () => {
  const { pedidoId } = await semear()
  const eventoId = await gravarDominioPago(banco.admin, pedidoId, { agregadoTipo: 'assinatura' })
  await assert.rejects(consumir(eventoId), UnrecoverableError)
  assert.equal((await tarefasDe(banco.admin)).length, 0)
})

test('CA1: agregado_id fora do formato UUID lança UnrecoverableError, sem tarefa', async () => {
  const { pedidoId } = await semear()
  const eventoId = await gravarDominioPago(banco.admin, pedidoId, { agregadoId: 'nao-e-uuid', payload: { pedidoId: 'nao-e-uuid' } })
  await assert.rejects(consumir(eventoId), UnrecoverableError)
  assert.equal((await tarefasDe(banco.admin)).length, 0)
})

test('CA1: payload.pedidoId diferente do agregado lança UnrecoverableError, sem tarefa', async () => {
  const { pedidoId } = await semear()
  const eventoId = await gravarDominioPago(banco.admin, pedidoId, { payload: { pedidoId: '00000000-0000-4000-8000-000000000000' } })
  await assert.rejects(consumir(eventoId), UnrecoverableError)
  assert.equal((await tarefasDe(banco.admin)).length, 0)
})

test('CA1: pedido inexistente lança UnrecoverableError', async () => {
  const inexistente = '00000000-0000-4000-8000-000000000001'
  const eventoId = await gravarDominioPago(banco.admin, inexistente)
  await assert.rejects(consumir(eventoId), UnrecoverableError)
})
