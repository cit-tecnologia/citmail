// CIT-77, CA2, CA6 e CA7: laço das tarefas de domínio (aviso de abertura, lembrete por dias
// úteis, renovação em D-30 e o aviso dela), com relógio injetado, filas falsas e banco migrado
// com o papel da aplicação. Só dados fictícios.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { executarCicloDominio, iniciarTarefasDominio } from '../src/dominios/laco.js'
import { buscarCandidatosLembrete } from '../src/dominios/repositorio.js'
import { montarTextoAlerta } from '../src/alertas/telegram.js'
import { somarDias } from '../src/dominios/dias-uteis.js'
import {
  criarLogCapturado, DADOS_TITULAR, DOMINIO_UM, semearComTarefas, tarefasDe, TRUNCAR
} from './dominio-fixtures.js'
import { criarBancoWebhook, semearBruto } from './webhook-fixtures.js'

let banco
let log

before(async () => {
  banco = await criarBancoWebhook()
})

after(async () => {
  await banco.fechar()
})

beforeEach(async () => {
  await banco.admin.query(TRUNCAR)
  log = criarLogCapturado()
})

/** Filas falsas de alertas com dedupe por `jobId`, como o BullMQ; `falhar` faz o `addBulk` rejeitar. */
function criarFilas() {
  const estado = { alertas: [], falhar: false, tentativas: 0 }
  const vistos = new Set()
  return {
    estado,
    alertas: {
      async addBulk(lista) {
        estado.tentativas += 1
        if (estado.falhar) throw new Error('redis fora')
        for (const item of lista) {
          if (vistos.has(item.opts.jobId)) continue
          vistos.add(item.opts.jobId)
          estado.alertas.push(item)
        }
      }
    }
  }
}

const ciclo = (filas, iso, pool = banco.app) =>
  executarCicloDominio({ pool, filas, log, agora: () => new Date(iso) })

const codigos = (filas) => filas.estado.alertas.map((alerta) => alerta.data.codigo)
const lembretes = (filas) => codigos(filas).filter((codigo) => codigo === 'lembrete_registro')

// Tarefas de registro já avisadas na abertura: o foco é o lembrete.
async function semearAvisada(abertaEm, opcoes = {}) {
  const semente = await semearComTarefas(banco.admin, { abertaEm, ...opcoes })
  await banco.admin.query('UPDATE tarefa_dominio SET alertada_em = $1', [abertaEm])
  return semente
}

// ---- CA2: aviso de abertura ------------------------------------------------------------

test('CA2: um ciclo enfileira 1 alerta por pedido e marca alertada_em nas 2 tarefas', async () => {
  const { pedidoId } = await semearComTarefas(banco.admin)
  const filas = criarFilas()
  await ciclo(filas, '2026-12-01T13:00:00Z')
  assert.equal(filas.estado.alertas.length, 1)
  assert.deepEqual(filas.estado.alertas[0].data, { tipo: 'dominio', codigo: 'tarefa_registro', tarefaId: null, pedidoId })
  assert.equal(filas.estado.alertas[0].opts.jobId, `alerta-tarefa_registro-${pedidoId}`)
  const tarefas = await tarefasDe(banco.admin)
  assert.equal(tarefas.length, 2)
  assert.ok(tarefas.every((tarefa) => tarefa.alertada_em !== null))
})

test('CA2: o segundo ciclo não enfileira job novo', async () => {
  await semearComTarefas(banco.admin)
  const filas = criarFilas()
  await ciclo(filas, '2026-12-01T13:00:00Z')
  const segundo = await ciclo(filas, '2026-12-01T13:05:00Z')
  assert.equal(segundo.avisos, 0)
  assert.equal(filas.estado.alertas.length, 1)
})

test('CA2: pedido ainda em aguardando_pagamento usa o código tarefa_registro_contas_pendentes', async () => {
  const { pedidoId } = await semearComTarefas(banco.admin, { estado: 'aguardando_pagamento' })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-01T13:00:00Z')
  assert.deepEqual(filas.estado.alertas[0].data, {
    tipo: 'dominio', codigo: 'tarefa_registro_contas_pendentes', tarefaId: null, pedidoId
  })
})

test('CA2: pedido cancelado é marcado como alertado sem enfileirar alerta', async () => {
  await semearComTarefas(banco.admin, { estado: 'cancelado' })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-01T13:00:00Z')
  assert.equal(filas.estado.alertas.length, 0)
  assert.ok((await tarefasDe(banco.admin)).every((tarefa) => tarefa.alertada_em !== null))
})

test('CA2: fila falha no 1º ciclo e nada é marcado', async () => {
  await semearComTarefas(banco.admin)
  const filas = criarFilas()
  filas.estado.falhar = true
  const primeiro = await ciclo(filas, '2026-12-01T13:00:00Z')
  assert.equal(primeiro.avisos, 0)
  assert.ok((await tarefasDe(banco.admin)).every((tarefa) => tarefa.alertada_em === null))
})

test('CA2: fila falha registra warn só com nome e código, sem dado pessoal', async () => {
  await semearComTarefas(banco.admin)
  const filas = criarFilas()
  filas.estado.falhar = true
  await ciclo(filas, '2026-12-01T13:00:00Z')
  const avisos = log.chamadas.filter(([nivel]) => nivel === 'warn')
  assert.equal(avisos.length, 1)
  assert.deepEqual(Object.keys(avisos[0][1]).sort(), ['codigo', 'erro'])
  for (const dado of DADOS_TITULAR) assert.ok(!log.texto().includes(dado), dado)
})

test('CA2: com a fila normal no 2º ciclo sai 1 job', async () => {
  await semearComTarefas(banco.admin)
  const filas = criarFilas()
  filas.estado.falhar = true
  await ciclo(filas, '2026-12-01T13:00:00Z')
  filas.estado.falhar = false
  await ciclo(filas, '2026-12-01T13:05:00Z')
  assert.equal(filas.estado.alertas.length, 1)
})

test('CA2: addBulk ok e marcação falha repete o mesmo jobId e sobra 1 job só', async () => {
  const { pedidoId } = await semearComTarefas(banco.admin)
  const filas = criarFilas()
  let falharMarca = true
  const pool = {
    query(sql, ...resto) {
      if (falharMarca && /UPDATE tarefa_dominio SET alertada_em/.test(sql)) {
        return Promise.reject(Object.assign(new Error('banco fora'), { code: '57P01' }))
      }
      return banco.app.query(sql, ...resto)
    }
  }
  await ciclo(filas, '2026-12-01T13:00:00Z', pool)
  assert.ok((await tarefasDe(banco.admin)).every((tarefa) => tarefa.alertada_em === null))
  falharMarca = false
  await ciclo(filas, '2026-12-01T13:05:00Z', pool)
  assert.equal(filas.estado.tentativas, 2)
  assert.equal(filas.estado.alertas.length, 1)
  assert.equal(filas.estado.alertas[0].opts.jobId, `alerta-tarefa_registro-${pedidoId}`)
  assert.ok((await tarefasDe(banco.admin)).every((tarefa) => tarefa.alertada_em !== null))
})

test('CA2: o texto do alerta, os dados do job e o log não têm domínio nem dado do titular', async () => {
  await semearComTarefas(banco.admin)
  const filas = criarFilas()
  await ciclo(filas, '2026-12-01T13:00:00Z')
  const tudo = JSON.stringify(filas.estado.alertas) + montarTextoAlerta(filas.estado.alertas[0].data) + log.texto()
  for (const dado of DADOS_TITULAR) assert.ok(!tudo.includes(dado), dado)
})

test('CA2: a falha de uma etapa não impede as outras', async () => {
  await semearComTarefas(banco.admin)
  const filas = criarFilas()
  const pool = {
    query(sql, ...resto) {
      if (/INSERT INTO tarefa_dominio/.test(sql)) return Promise.reject(Object.assign(new Error('x'), { code: '40001' }))
      return banco.app.query(sql, ...resto)
    }
  }
  const resultado = await ciclo(filas, '2026-12-01T13:00:00Z', pool)
  assert.equal(resultado.avisos, 1)
  assert.equal(resultado.renovacoes, 0)
})

test('CA2: iniciarTarefasDominio roda um ciclo ao iniciar e close() espera o ciclo em curso', async () => {
  await semearComTarefas(banco.admin)
  const filas = criarFilas()
  let aoCiclo
  const primeiro = new Promise((resolver) => { aoCiclo = resolver })
  const laco = iniciarTarefasDominio({
    pool: banco.app, filas, log, intervaloMs: 3600000, agora: () => new Date('2026-12-01T13:00:00Z'), aoCiclo
  })
  const resultado = await primeiro
  await laco.close()
  assert.equal(resultado.avisos, 1)
  assert.equal(filas.estado.alertas.length, 1)
})

// ---- CA6: lembrete por dias úteis ---------------------------------------------------------

const SEGUNDA = '2026-11-30T13:00:00Z'
const SEXTA = '2026-12-04T13:00:00Z'
const SABADO = '2026-12-05T13:00:00Z'

// [abertura, instante do ciclo, lembretes esperados]
const CASOS_LEMBRETE = [
  ['segunda → terça (1 dia útil)', SEGUNDA, '2026-12-01T13:00:00Z', 0],
  ['segunda → quarta (2 dias úteis)', SEGUNDA, '2026-12-02T13:00:00Z', 0],
  ['segunda → quinta (3 dias úteis)', SEGUNDA, '2026-12-03T13:00:00Z', 1],
  ['segunda → sexta (4 dias úteis)', SEGUNDA, '2026-12-04T13:00:00Z', 1],
  ['segunda → sábado (fim de semana)', SEGUNDA, '2026-12-05T13:00:00Z', 0],
  ['segunda → domingo (fim de semana)', SEGUNDA, '2026-12-06T13:00:00Z', 0],
  ['segunda → segunda seguinte', SEGUNDA, '2026-12-07T13:00:00Z', 1],
  ['sexta → segunda (1 dia útil)', SEXTA, '2026-12-07T13:00:00Z', 0],
  ['sexta → terça (2 dias úteis)', SEXTA, '2026-12-08T13:00:00Z', 0],
  ['sexta → quarta (3 dias úteis)', SEXTA, '2026-12-09T13:00:00Z', 1],
  ['sábado → terça (2 dias úteis)', SABADO, '2026-12-08T13:00:00Z', 0],
  ['sábado → quarta (3 dias úteis)', SABADO, '2026-12-09T13:00:00Z', 1]
]

for (const [nome, abertura, instante, esperados] of CASOS_LEMBRETE) {
  test(`CA6: ${nome} gera ${esperados} lembrete(s)`, async () => {
    await semearAvisada(abertura, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
    const filas = criarFilas()
    await ciclo(filas, instante)
    assert.equal(lembretes(filas).length, esperados)
  })
}

const UM_DOMINIO = [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }]
const QUINTA = '2026-12-03T13:00:00Z'

test('CA6: tarefas recentes em número maior que o lote não impedem o lembrete da antiga', async () => {
  const { tarefaIds: [antiga] } = await semearAvisada(SEGUNDA, { dominios: UM_DOMINIO })
  for (let i = 0; i < 5; i++) await semearAvisada('2026-12-03T12:00:00Z', { dominios: UM_DOMINIO })
  const filas = criarFilas()
  const resultado = await executarCicloDominio({ pool: banco.app, filas, log, agora: () => new Date(QUINTA), lote: 2 })
  assert.equal(resultado.lembretes, 1)
  assert.equal(filas.estado.alertas[0].data.tarefaId, antiga)
})

test('CA6: buscarCandidatosLembrete corta no SQL as tarefas abertas há menos de 46 horas', async () => {
  const { tarefaIds: [antiga] } = await semearAvisada('2026-12-01T13:00:00Z', { dominios: UM_DOMINIO })
  await semearAvisada('2026-12-02T13:00:00Z', { dominios: UM_DOMINIO })
  const candidatos = await buscarCandidatosLembrete(banco.app, '2026-12-03', new Date(QUINTA), 10)
  assert.deepEqual(candidatos.map((c) => c.id), [antiga])
})

test('CA6: buscarCandidatosLembrete ordena pela abertura antes do último lembrete', async () => {
  const { tarefaIds: [maisAntiga] } = await semearAvisada('2026-11-26T13:00:00Z', { dominios: UM_DOMINIO })
  const { tarefaIds: [maisNova] } = await semearAvisada('2026-11-30T13:00:00Z', { dominios: UM_DOMINIO })
  await banco.admin.query("UPDATE tarefa_dominio SET ultimo_lembrete_em = '2026-12-02T13:00:00Z' WHERE id = $1", [maisAntiga])
  const candidatos = await buscarCandidatosLembrete(banco.app, '2026-12-03', new Date(QUINTA), 1)
  assert.deepEqual(candidatos.map((c) => c.id), [maisAntiga])
  assert.notEqual(maisAntiga, maisNova)
})

test('CA6: o lembrete leva o código, a tarefa e o pedido, com jobId do dia', async () => {
  const { pedidoId, tarefaIds } = await semearAvisada(SEGUNDA, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-03T13:00:00Z')
  assert.deepEqual(filas.estado.alertas[0].data, { tipo: 'dominio', codigo: 'lembrete_registro', tarefaId: tarefaIds[0], pedidoId })
  assert.equal(filas.estado.alertas[0].opts.jobId, `alerta-lembrete_registro-${tarefaIds[0]}-20261203`)
})

test('CA6: um segundo ciclo no mesmo dia (quinta) não repete o lembrete', async () => {
  await semearAvisada(SEGUNDA, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-03T13:00:00Z')
  const segundo = await ciclo(filas, '2026-12-03T18:00:00Z')
  assert.equal(segundo.lembretes, 0)
  assert.equal(lembretes(filas).length, 1)
})

test('CA6: o lembrete volta no dia útil seguinte (quinta e sexta somam 2)', async () => {
  await semearAvisada(SEGUNDA, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-03T13:00:00Z')
  await ciclo(filas, '2026-12-04T13:00:00Z')
  assert.equal(lembretes(filas).length, 2)
})

test('CA6: de madrugada local (UTC já no dia seguinte) o dia útil é o local', async () => {
  // segunda 01h local = 04h Z; domingo 29/11 23h local = segunda 02h Z (não é dia útil local)
  await semearAvisada(SEGUNDA, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-06T02:00:00Z')
  assert.equal(lembretes(filas).length, 0)
})

test('CA6: tarefa concluída não gera lembrete', async () => {
  await semearAvisada(SEGUNDA, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  await banco.admin.query('UPDATE tarefa_dominio SET concluida_em = now()')
  const filas = criarFilas()
  await ciclo(filas, '2026-12-03T13:00:00Z')
  assert.equal(lembretes(filas).length, 0)
})

test('CA6: pedido cancelado não gera lembrete', async () => {
  await semearAvisada(SEGUNDA, { estado: 'cancelado', dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-03T13:00:00Z')
  assert.equal(lembretes(filas).length, 0)
})

test('CA6: pedido em aguardando_pagamento não gera lembrete', async () => {
  await semearAvisada(SEGUNDA, { estado: 'aguardando_pagamento', dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-03T13:00:00Z')
  assert.equal(lembretes(filas).length, 0)
})

test('CA6: fila falha no ciclo da quinta deixa ultimo_lembrete_em nulo e o ciclo seguinte envia 1', async () => {
  await semearAvisada(SEGUNDA, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  filas.estado.falhar = true
  await ciclo(filas, '2026-12-03T13:00:00Z')
  assert.equal((await tarefasDe(banco.admin))[0].ultimo_lembrete_em, null)
  filas.estado.falhar = false
  await ciclo(filas, '2026-12-03T18:00:00Z')
  assert.equal(lembretes(filas).length, 1)
})

test('CA6: o lembrete não leva nome do domínio nem dado do titular', async () => {
  await semearAvisada(SEGUNDA, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const filas = criarFilas()
  await ciclo(filas, '2026-12-03T13:00:00Z')
  const tudo = JSON.stringify(filas.estado.alertas) + log.texto()
  for (const dado of DADOS_TITULAR) assert.ok(!tudo.includes(dado), dado)
})

// ---- CA7: renovação em D-30 ------------------------------------------------------------

const AGORA_RENOVACAO = '2026-12-01T13:00:00Z'
const HOJE_RENOVACAO = '2026-12-01'

/** Pedido pago com domínio registrado, vencendo em `hoje + dias`. */
async function semearRegistrado({ dias = 30, estado = 'pago' } = {}) {
  const semente = await semearComTarefas(banco.admin, {
    estado, tarefas: false, dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }]
  })
  const expira = somarDias(HOJE_RENOVACAO, dias)
  await banco.admin.query('UPDATE pedido_dominio SET registrado_em = now(), registro_expira_em = $2 WHERE id = $1', [semente.dominioIds[0], expira])
  return { ...semente, expira }
}

async function semearPagamentoAnual(assinaturaId, { status = 'RECEIVED', vencimento }) {
  await semearBruto(banco.admin, { assinaturaId, status, vencimento, pagamentoId: `pay_${status}_${vencimento.replaceAll("-", "")}` })
}

const renovacoes = async () => (await tarefasDe(banco.admin)).filter((tarefa) => tarefa.tipo === 'renovacao')

async function assinaturaDominios(pedidoId) {
  return (await banco.admin.query("SELECT asaas_assinatura_id AS id FROM assinatura WHERE pedido_id = $1 AND tipo = 'dominios'", [pedidoId])).rows[0].id
}

test('CA7: vencimento em hoje + 30 abre 1 tarefa de renovação com a referência', async () => {
  const { expira } = await semearRegistrado()
  const filas = criarFilas()
  const resultado = await ciclo(filas, AGORA_RENOVACAO)
  const tarefas = await renovacoes()
  assert.equal(resultado.renovacoes, 1)
  assert.equal(tarefas.length, 1)
  assert.equal(tarefas[0].referencia_expira_em.toISOString().slice(0, 10), expira)
})

test('CA7: o aviso da renovação sai uma vez e grava alertada_em', async () => {
  const { pedidoId } = await semearRegistrado()
  const filas = criarFilas()
  await ciclo(filas, AGORA_RENOVACAO)
  const [tarefa] = await renovacoes()
  assert.equal(filas.estado.alertas.length, 1)
  assert.deepEqual(filas.estado.alertas[0].data, { tipo: 'dominio', codigo: 'renovacao_pendente', tarefaId: tarefa.id, pedidoId })
  assert.equal(filas.estado.alertas[0].opts.jobId, `alerta-renovacao-${tarefa.id}`)
  assert.notEqual(tarefa.alertada_em, null)
})

test('CA7: evento RECEIVED da assinatura de domínios na janela dá situação paga e código renovacao_paga', async () => {
  const { pedidoId, expira } = await semearRegistrado()
  await semearPagamentoAnual(await assinaturaDominios(pedidoId), { vencimento: somarDias(expira, -10) })
  const filas = criarFilas()
  await ciclo(filas, AGORA_RENOVACAO)
  assert.equal((await renovacoes())[0].situacao_fatura, 'paga')
  assert.deepEqual(codigos(filas), ['renovacao_paga'])
})

test('CA7: só evento OVERDUE dá situação pendente e código renovacao_pendente', async () => {
  const { pedidoId, expira } = await semearRegistrado()
  await semearPagamentoAnual(await assinaturaDominios(pedidoId), { status: 'OVERDUE', vencimento: somarDias(expira, -10) })
  const filas = criarFilas()
  await ciclo(filas, AGORA_RENOVACAO)
  assert.equal((await renovacoes())[0].situacao_fatura, 'pendente')
  assert.deepEqual(codigos(filas), ['renovacao_pendente'])
})

test('CA7: evento RECEIVED fora da janela de vencimento não conta como paga', async () => {
  const { pedidoId, expira } = await semearRegistrado()
  await semearPagamentoAnual(await assinaturaDominios(pedidoId), { vencimento: somarDias(expira, -61) })
  await ciclo(criarFilas(), AGORA_RENOVACAO)
  assert.equal((await renovacoes())[0].situacao_fatura, 'pendente')
})

test('CA7: evento RECEIVED de outra assinatura não conta como paga', async () => {
  const { expira } = await semearRegistrado()
  await semearPagamentoAnual('sub_de_outro_pedido', { vencimento: somarDias(expira, -10) })
  await ciclo(criarFilas(), AGORA_RENOVACAO)
  assert.equal((await renovacoes())[0].situacao_fatura, 'pendente')
})

test('CA7: pagamento recebido da assinatura de contas do mesmo pedido não conta como fatura anual paga', async () => {
  const { pedidoId, expira } = await semearRegistrado()
  const { rows } = await banco.admin.query("SELECT asaas_assinatura_id AS id FROM assinatura WHERE pedido_id = $1 AND tipo = 'contas'", [pedidoId])
  await semearPagamentoAnual(rows[0].id, { vencimento: somarDias(expira, -10) })
  await ciclo(criarFilas(), AGORA_RENOVACAO)
  assert.equal((await renovacoes())[0].situacao_fatura, 'pendente')
})

test('CA7: um novo ciclo não cria tarefa nem alerta novo', async () => {
  await semearRegistrado()
  const filas = criarFilas()
  await ciclo(filas, AGORA_RENOVACAO)
  const segundo = await ciclo(filas, '2026-12-01T18:00:00Z')
  assert.equal(segundo.renovacoes, 0)
  assert.equal((await renovacoes()).length, 1)
  assert.equal(filas.estado.alertas.length, 1)
})

test('CA7: vencimento em hoje + 31 não abre tarefa', async () => {
  await semearRegistrado({ dias: 31 })
  await ciclo(criarFilas(), AGORA_RENOVACAO)
  assert.equal((await renovacoes()).length, 0)
})

test('CA7: pedido cancelado não abre tarefa de renovação', async () => {
  await semearRegistrado({ estado: 'cancelado' })
  await ciclo(criarFilas(), AGORA_RENOVACAO)
  assert.equal((await renovacoes()).length, 0)
})

test('CA7: fila falha cria a tarefa, deixa alertada_em nulo, e o ciclo seguinte envia 1 alerta', async () => {
  await semearRegistrado()
  const filas = criarFilas()
  filas.estado.falhar = true
  await ciclo(filas, AGORA_RENOVACAO)
  assert.equal((await renovacoes()).length, 1)
  assert.equal((await renovacoes())[0].alertada_em, null)
  filas.estado.falhar = false
  await ciclo(filas, '2026-12-01T18:00:00Z')
  assert.equal(filas.estado.alertas.length, 1)
})

test('CA7: renovação aberta de pedido que depois foi cancelado é marcada como alertada sem enfileirar alerta', async () => {
  const { pedidoId } = await semearRegistrado()
  const filas = criarFilas()
  filas.estado.falhar = true
  await ciclo(filas, AGORA_RENOVACAO)
  await banco.admin.query("UPDATE pedido SET estado = 'cancelado' WHERE id = $1", [pedidoId])
  filas.estado.falhar = false
  await ciclo(filas, '2026-12-01T18:00:00Z')
  assert.equal(filas.estado.alertas.length, 0)
  assert.notEqual((await renovacoes())[0].alertada_em, null)
})

test('CA7: o aviso de renovação não leva nome do domínio nem dado do titular', async () => {
  await semearRegistrado()
  const filas = criarFilas()
  await ciclo(filas, AGORA_RENOVACAO)
  const tudo = JSON.stringify(filas.estado.alertas) + log.texto()
  for (const dado of DADOS_TITULAR) assert.ok(!tudo.includes(dado), dado)
})

test('CA7: com a renovação concluída e o novo vencimento a 365 dias o ciclo seguinte não reabre', async () => {
  const { dominioIds } = await semearRegistrado()
  const filas = criarFilas()
  await ciclo(filas, AGORA_RENOVACAO)
  await banco.admin.query('UPDATE tarefa_dominio SET concluida_em = now() WHERE tipo = $1', ['renovacao'])
  await banco.admin.query('UPDATE pedido_dominio SET registro_expira_em = $2 WHERE id = $1', [dominioIds[0], somarDias(HOJE_RENOVACAO, 395)])
  const seguinte = await ciclo(filas, '2026-12-02T13:00:00Z')
  assert.equal(seguinte.renovacoes, 0)
  assert.equal((await renovacoes()).length, 1)
})
