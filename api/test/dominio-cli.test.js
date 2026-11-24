// CIT-77, CA3, CA4, CA5, CA7 (renovado) e CA8: CLI `npm run dominio` pelo núcleo
// `executarDominio`, com banco migrado e papel da aplicação, relógio, saídas, log e
// auditoria injetados. Só dados fictícios; a auditoria é só de inclusão, então as conferências
// filtram pelos ids semeados em cada teste.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { executarDominio, usuarioDoSistema } from '../src/cli/dominio.js'
import { executarCicloDominio } from '../src/dominios/laco.js'
import { somarDias } from '../src/dominios/dias-uteis.js'
import {
  criarLogCapturado, criarSaida, DADOS_TITULAR, DOMINIO_UM, DOMINIO_DOIS, semearComTarefas, tarefasDe, TRUNCAR
} from './dominio-fixtures.js'
import { criarBancoWebhook } from './webhook-fixtures.js'

const AGORA = '2026-12-01T13:00:00Z'
const HOJE = '2026-12-01'
const EXPIRA = somarDias(HOJE, 365)
const OPERADOR = 'equipe_teste'
const USUARIO = 'operador_teste'

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

async function rodar(args, extras = {}) {
  const saida = criarSaida()
  const erro = criarSaida()
  const codigo = await executarDominio({
    pool: banco.app, args, saida, erro, log, agora: () => new Date(AGORA), usuarioSistema: USUARIO, ...extras
  })
  return { codigo, saida: saida.texto(), erro: erro.texto() }
}

const registrar = (tarefaId, extras) =>
  rodar(['registrado', tarefaId, '--expira-em', EXPIRA, '--operador', OPERADOR], extras)

const pedidoDe = async (pedidoId) =>
  (await banco.admin.query('SELECT estado, dominio_registrado_em FROM pedido WHERE id = $1', [pedidoId])).rows[0]

const dominiosDe = async (pedidoId) =>
  (await banco.admin.query('SELECT registrado_em, registro_expira_em::text AS expira FROM pedido_dominio WHERE pedido_id = $1 ORDER BY nome', [pedidoId])).rows

const eventosRegistrado = async () =>
  (await banco.admin.query("SELECT chave_idempotencia, payload FROM evento WHERE nome = 'dominio_registrado'")).rows

const auditoriaDe = async (alvoIds, acao) =>
  (await banco.admin.query(
    `SELECT acao, autor_tipo, autor_id, alvo_tipo, alvo_id, host(ip) AS ip, resultado, detalhes, row_to_json(auditoria)::text AS texto
       FROM auditoria WHERE alvo_id = ANY($1::text[]) AND acao = $2 ORDER BY id`,
    [alvoIds, acao]
  )).rows

const concluidas = async () => (await tarefasDe(banco.admin)).filter((tarefa) => tarefa.concluida_em !== null).length

async function semearRenovacao({ estado = 'pago' } = {}) {
  const semente = await semearComTarefas(banco.admin, { estado, tarefas: false, dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const referencia = somarDias(HOJE, 20)
  await banco.admin.query('UPDATE pedido_dominio SET registrado_em = now(), registro_expira_em = $2 WHERE id = $1', [semente.dominioIds[0], referencia])
  const { rows } = await banco.admin.query(
    "INSERT INTO tarefa_dominio (pedido_dominio_id, tipo, referencia_expira_em, situacao_fatura) VALUES ($1, 'renovacao', $2, 'pendente') RETURNING id",
    [semente.dominioIds[0], referencia]
  )
  return { ...semente, renovacaoId: rows[0].id, referencia }
}

// ---- CA3: marcar registrado ---------------------------------------------------------------

test('CA3: registrado da 1ª tarefa devolve 0, grava o registro e conclui a tarefa', async () => {
  const { pedidoId, tarefaIds } = await semearComTarefas(banco.admin)
  const { codigo } = await registrar(tarefaIds[0])
  assert.equal(codigo, 0)
  const [primeiro, segundo] = await dominiosDe(pedidoId)
  assert.notEqual(primeiro.registrado_em, null)
  assert.equal(primeiro.expira, EXPIRA)
  assert.equal(segundo.registrado_em, null)
  assert.equal(await concluidas(), 1)
})

test('CA3: com 1 domínio ainda pendente o pedido segue em aguardando_registro_de_dominio, sem evento', async () => {
  const { pedidoId, tarefaIds } = await semearComTarefas(banco.admin)
  await registrar(tarefaIds[0])
  assert.deepEqual(await pedidoDe(pedidoId), { estado: 'aguardando_registro_de_dominio', dominio_registrado_em: null })
  assert.equal((await eventosRegistrado()).length, 0)
})

test('CA3: registrado da última tarefa leva o pedido a pago e grava dominio_registrado_em', async () => {
  const { pedidoId, tarefaIds } = await semearComTarefas(banco.admin)
  await registrar(tarefaIds[0])
  const { codigo } = await registrar(tarefaIds[1])
  const pedido = await pedidoDe(pedidoId)
  assert.equal(codigo, 0)
  assert.equal(pedido.estado, 'pago')
  assert.notEqual(pedido.dominio_registrado_em, null)
})

test('CA3: registrado da última tarefa emite 1 dominio_registrado com a chave e o payload esperados', async () => {
  const { pedidoId, clienteId, tarefaIds } = await semearComTarefas(banco.admin)
  await registrar(tarefaIds[0])
  await registrar(tarefaIds[1])
  const eventos = await eventosRegistrado()
  assert.equal(eventos.length, 1)
  assert.equal(eventos[0].chave_idempotencia, `dominio_registrado-${pedidoId}`)
  assert.deepEqual(eventos[0].payload, { pedidoId, clienteId })
})

test('CA3: auditoria que lança na última tarefa devolve 1 e não grava registro, tarefa, pedido nem evento', async () => {
  const { pedidoId, tarefaIds, dominioIds } = await semearComTarefas(banco.admin)
  await registrar(tarefaIds[0])
  const falha = async () => { throw new TypeError('auditoria: falha proposital') }
  const { codigo } = await registrar(tarefaIds[1], { auditoria: falha })
  assert.equal(codigo, 1)
  assert.equal((await dominiosDe(pedidoId))[1].registrado_em, null)
  assert.equal(await concluidas(), 1)
  assert.deepEqual(await pedidoDe(pedidoId), { estado: 'aguardando_registro_de_dominio', dominio_registrado_em: null })
  assert.equal((await eventosRegistrado()).length, 0)
  assert.equal((await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')).length, 1)
})

test('CA3: falha depois da auditoria (transição do pedido) desfaz também a auditoria, a tarefa e o registro', async () => {
  const { pedidoId, tarefaIds, dominioIds } = await semearComTarefas(banco.admin)
  await registrar(tarefaIds[0])
  await banco.admin.query(`
    CREATE FUNCTION falhar_pago() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha proposital' USING ERRCODE = 'XX000'; END $$;
    CREATE TRIGGER falhar_pago BEFORE UPDATE ON pedido FOR EACH ROW WHEN (NEW.estado = 'pago') EXECUTE FUNCTION falhar_pago()`)
  try {
    const { codigo } = await registrar(tarefaIds[1])
    assert.equal(codigo, 1)
  } finally {
    await banco.admin.query('DROP TRIGGER falhar_pago ON pedido; DROP FUNCTION falhar_pago()')
  }
  assert.equal((await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')).length, 1)
  assert.equal(await concluidas(), 1)
  assert.equal((await dominiosDe(pedidoId))[1].registrado_em, null)
  assert.equal((await pedidoDe(pedidoId)).estado, 'aguardando_registro_de_dominio')
})

test('CA3: repetir registrado sobre tarefa concluída devolve 2 e não grava nova auditoria', async () => {
  const { tarefaIds, dominioIds } = await semearComTarefas(banco.admin)
  await registrar(tarefaIds[0])
  const antes = (await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')).length
  const { codigo } = await registrar(tarefaIds[0])
  assert.equal(codigo, 2)
  assert.equal((await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')).length, antes)
})

test('CA3: duas execuções concorrentes sobre as 2 últimas tarefas deixam o pedido pago e 1 evento só', async () => {
  const { pedidoId, tarefaIds } = await semearComTarefas(banco.admin)
  const [a, b] = await Promise.all([registrar(tarefaIds[0]), registrar(tarefaIds[1])])
  assert.deepEqual([a.codigo, b.codigo], [0, 0])
  assert.equal((await pedidoDe(pedidoId)).estado, 'pago')
  assert.equal((await eventosRegistrado()).length, 1)
})

test('CA3: duas execuções concorrentes sobre a mesma tarefa: uma devolve 0 e a outra 2', async () => {
  const { tarefaIds } = await semearComTarefas(banco.admin)
  const resultados = await Promise.all([registrar(tarefaIds[0]), registrar(tarefaIds[0])])
  assert.deepEqual(resultados.map((r) => r.codigo).sort(), [0, 2])
})

test('CA3: com o pedido em aguardando_pagamento registrar tudo grava dominio_registrado_em, sem mudar o estado nem emitir evento', async () => {
  const { pedidoId, tarefaIds } = await semearComTarefas(banco.admin, { estado: 'aguardando_pagamento' })
  await registrar(tarefaIds[0])
  await registrar(tarefaIds[1])
  const pedido = await pedidoDe(pedidoId)
  assert.equal(pedido.estado, 'aguardando_pagamento')
  assert.notEqual(pedido.dominio_registrado_em, null)
  assert.equal((await eventosRegistrado()).length, 0)
})

test('CA3: registrado em pedido de 1 domínio novo vai direto a pago', async () => {
  const { pedidoId, tarefaIds } = await semearComTarefas(banco.admin, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  await registrar(tarefaIds[0])
  assert.equal((await pedidoDe(pedidoId)).estado, 'pago')
})

// ---- CA4: validação -----------------------------------------------------------------------

async function semearUma() {
  return semearComTarefas(banco.admin, { dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
}

const nadaGravado = async () => {
  assert.equal(await concluidas(), 0)
  assert.equal((await banco.admin.query('SELECT count(*)::int AS n FROM pedido_dominio WHERE registrado_em IS NOT NULL')).rows[0].n, 0)
}

// [nome, args depois do id, valor que não pode voltar no stderr]
const ENTRADAS_INVALIDAS = [
  ['--expira-em ausente', ['--operador', OPERADOR], null],
  ['--expira-em com data inexistente', ['--expira-em', '2027-02-30', '--operador', OPERADOR], '2027-02-30'],
  ['--expira-em em formato livre', ['--expira-em', 'amanha-hostil', '--operador', OPERADOR], 'amanha-hostil'],
  ['--expira-em antes de hoje + 300 dias', ['--expira-em', somarDias(HOJE, 299), '--operador', OPERADOR], somarDias(HOJE, 299)],
  ['--expira-em depois de hoje + 10 anos', ['--expira-em', '2036-12-02', '--operador', OPERADOR], '2036-12-02'],
  ['--operador ausente', ['--expira-em', EXPIRA], null],
  ['--operador com @', ['--expira-em', EXPIRA, '--operador', 'fulano@exemplo.test'], 'fulano@exemplo.test'],
  ['--operador fora da regex', ['--expira-em', EXPIRA, '--operador', 'Operador Hostil'], 'Operador Hostil'],
  ['opção desconhecida', ['--expira-em', EXPIRA, '--operador', OPERADOR, '--forcar', 'x'], '--forcar'],
  ['opção repetida', ['--expira-em', EXPIRA, '--expira-em', EXPIRA, '--operador', OPERADOR], null]
]

for (const [nome, args, valor] of ENTRADAS_INVALIDAS) {
  test(`CA4: ${nome} devolve 1, não grava e não repete o valor no erro`, async () => {
    const { tarefaIds } = await semearUma()
    const { codigo, erro } = await rodar(['registrado', tarefaIds[0], ...args])
    assert.equal(codigo, 1)
    await nadaGravado()
    if (valor) assert.ok(!erro.includes(valor), erro)
  })
}

test('CA4: --expira-em em hoje + 300 dias é aceito', async () => {
  const { tarefaIds } = await semearUma()
  const { codigo } = await rodar(['registrado', tarefaIds[0], '--expira-em', somarDias(HOJE, 300), '--operador', OPERADOR])
  assert.equal(codigo, 0)
})

test('CA4: --expira-em em hoje + 10 anos é aceito', async () => {
  const { tarefaIds } = await semearUma()
  const { codigo } = await rodar(['registrado', tarefaIds[0], '--expira-em', '2036-12-01', '--operador', OPERADOR])
  assert.equal(codigo, 0)
})

test('CA4: tarefaId fora do formato UUID devolve 1 sem repetir o valor', async () => {
  const { codigo, erro } = await rodar(['registrado', 'tarefa-hostil', '--expira-em', EXPIRA, '--operador', OPERADOR])
  assert.equal(codigo, 1)
  assert.ok(!erro.includes('tarefa-hostil'))
})

test('CA4: tarefaId inexistente devolve 1', async () => {
  const { codigo } = await registrar('00000000-0000-4000-8000-000000000001')
  assert.equal(codigo, 1)
})

test('CA4: subcomando desconhecido devolve 1 com o uso', async () => {
  const { codigo, erro } = await rodar(['apagar', 'x'])
  assert.equal(codigo, 1)
  assert.match(erro, /uso: npm run dominio/)
})

test('CA4: sem subcomando devolve 1 com o uso', async () => {
  const { codigo, erro } = await rodar([])
  assert.equal(codigo, 1)
  assert.match(erro, /uso: npm run dominio/)
})

test('CA4: pedido cancelado devolve 2 e não grava', async () => {
  const { tarefaIds, dominioIds } = await semearComTarefas(banco.admin, { estado: 'cancelado' })
  const { codigo } = await registrar(tarefaIds[0])
  assert.equal(codigo, 2)
  await nadaGravado()
  assert.equal((await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')).length, 0)
})

test('CA4: renovado sobre tarefa de registro devolve 2 e não grava', async () => {
  const { tarefaIds } = await semearUma()
  const { codigo } = await rodar(['renovado', tarefaIds[0], '--expira-em', EXPIRA, '--operador', OPERADOR])
  assert.equal(codigo, 2)
  await nadaGravado()
})

test('CA4: registrado sobre tarefa de renovação devolve 2 e não conclui a tarefa', async () => {
  const { renovacaoId } = await semearRenovacao()
  const { codigo } = await registrar(renovacaoId)
  assert.equal(codigo, 2)
  assert.equal(await concluidas(), 0)
})

// ---- CA5: auditoria -----------------------------------------------------------------------

test('CA5: cada registro grava 1 auditoria dominio_registrado_manualmente com autor, alvo, IP e detalhes', async () => {
  const { pedidoId, tarefaIds, dominioIds } = await semearComTarefas(banco.admin)
  await registrar(tarefaIds[0])
  await registrar(tarefaIds[1])
  const linhas = await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')
  assert.equal(linhas.length, 2)
  for (const linha of linhas) {
    assert.equal(linha.autor_tipo, 'equipe')
    assert.equal(linha.autor_id, OPERADOR)
    assert.equal(linha.alvo_tipo, 'dominio')
    assert.equal(linha.ip, '127.0.0.1')
    assert.equal(linha.resultado, 'sucesso')
    assert.deepEqual(linha.detalhes, { pedidoId, expiraEm: EXPIRA, operacao: 'registro', usuarioSistema: USUARIO })
  }
  assert.deepEqual(linhas.map((linha) => linha.alvo_id).sort(), [...dominioIds].sort())
})

test('CA5: usuarioSistema fora do formato vira "-" nos detalhes', async () => {
  const { tarefaIds, dominioIds } = await semearUma()
  await registrar(tarefaIds[0], { usuarioSistema: 'Operador Com Espaço!' })
  const [linha] = await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')
  assert.equal(linha.detalhes.usuarioSistema, '-')
})

test('CA5: mostrar grava 1 auditoria dados_titular_consultados com alvo cliente e detalhes mínimos', async () => {
  const { clienteId, tarefaIds } = await semearUma()
  const { codigo } = await rodar(['mostrar', tarefaIds[0], '--operador', OPERADOR])
  assert.equal(codigo, 0)
  const linhas = await auditoriaDe([clienteId], 'dados_titular_consultados')
  assert.equal(linhas.length, 1)
  assert.equal(linhas[0].autor_tipo, 'equipe')
  assert.equal(linhas[0].autor_id, OPERADOR)
  assert.equal(linhas[0].alvo_tipo, 'cliente')
  assert.equal(linhas[0].ip, '127.0.0.1')
  assert.deepEqual(linhas[0].detalhes, { tarefaId: tarefaIds[0], usuarioSistema: USUARIO })
})

test('CA5: nenhuma linha de auditoria contém o nome do domínio nem dado do titular', async () => {
  const { clienteId, tarefaIds, dominioIds } = await semearComTarefas(banco.admin)
  await rodar(['mostrar', tarefaIds[0], '--operador', OPERADOR])
  await registrar(tarefaIds[0])
  await registrar(tarefaIds[1])
  const linhas = [
    ...await auditoriaDe(dominioIds, 'dominio_registrado_manualmente'),
    ...await auditoriaDe([clienteId], 'dados_titular_consultados')
  ]
  assert.equal(linhas.length, 3)
  for (const linha of linhas) {
    for (const dado of DADOS_TITULAR) assert.ok(!linha.texto.includes(dado), dado)
  }
})

test('CA5: usuarioDoSistema prefere SUDO_USER e, sem ele, usa o usuário do processo', () => {
  assert.equal(usuarioDoSistema({ SUDO_USER: 'ops_teste' }), 'ops_teste')
  assert.equal(typeof usuarioDoSistema({}), 'string')
  assert.ok(usuarioDoSistema({}).length > 0)
})

// ---- CA7: renovado ------------------------------------------------------------------------

const NOVA_EXPIRA = somarDias(HOJE, 395)
const renovar = (tarefaId, extras) => rodar(['renovado', tarefaId, '--expira-em', NOVA_EXPIRA, '--operador', OPERADOR], extras)

test('CA7: renovado atualiza registro_expira_em, conclui a tarefa e preserva registrado_em', async () => {
  const { pedidoId, renovacaoId } = await semearRenovacao()
  const antes = (await dominiosDe(pedidoId))[0].registrado_em
  const { codigo } = await renovar(renovacaoId)
  const [dominio] = await dominiosDe(pedidoId)
  assert.equal(codigo, 0)
  assert.equal(dominio.expira, NOVA_EXPIRA)
  assert.deepEqual(dominio.registrado_em, antes)
  assert.equal(await concluidas(), 1)
})

test('CA7: renovado grava a auditoria com operacao renovacao', async () => {
  const { pedidoId, renovacaoId, dominioIds } = await semearRenovacao()
  await renovar(renovacaoId)
  const [linha] = await auditoriaDe(dominioIds, 'dominio_registrado_manualmente')
  assert.deepEqual(linha.detalhes, { pedidoId, expiraEm: NOVA_EXPIRA, operacao: 'renovacao', usuarioSistema: USUARIO })
})

test('CA7: renovado não muda o estado do pedido nem emite dominio_registrado', async () => {
  const { pedidoId, renovacaoId } = await semearRenovacao()
  await renovar(renovacaoId)
  assert.equal((await pedidoDe(pedidoId)).estado, 'pago')
  assert.equal((await eventosRegistrado()).length, 0)
})

test('CA7: o ciclo seguinte à renovação não reabre a tarefa (nova referência só a 30 dias dela)', async () => {
  const { renovacaoId } = await semearRenovacao()
  await renovar(renovacaoId)
  const filas = { alertas: { async addBulk() {} } }
  const resultado = await executarCicloDominio({ pool: banco.app, filas, log, agora: () => new Date(AGORA) })
  assert.equal(resultado.renovacoes, 0)
  assert.equal((await tarefasDe(banco.admin)).filter((tarefa) => tarefa.tipo === 'renovacao').length, 1)
})

test('CA7: renovado com auditoria que lança devolve 1 e não altera o vencimento', async () => {
  const { pedidoId, renovacaoId, referencia } = await semearRenovacao()
  const falha = async () => { throw new TypeError('auditoria: falha proposital') }
  const { codigo } = await renovar(renovacaoId, { auditoria: falha })
  assert.equal(codigo, 1)
  assert.equal((await dominiosDe(pedidoId))[0].expira, referencia)
  assert.equal(await concluidas(), 0)
})

// ---- CA8: detalhe só pela CLI -------------------------------------------------------------

test('CA8: mostrar escreve na saída o domínio e os dados do titular fictício', async () => {
  const { tarefaIds } = await semearUma()
  const { codigo, saida } = await rodar(['mostrar', tarefaIds[0], '--operador', OPERADOR])
  assert.equal(codigo, 0)
  for (const dado of [DOMINIO_UM, 'Fulano Ficticio', 'fulano@exemplo.test', '11999990000']) {
    assert.ok(saida.includes(dado), dado)
  }
})

test('CA8: mostrar com auditoria que lança devolve 1 e a saída não tem dado do titular', async () => {
  const { tarefaIds } = await semearUma()
  const falha = async () => { throw Object.assign(new Error('Fulano Ficticio fulano@exemplo.test'), { code: 'XX000' }) }
  const { codigo, saida, erro } = await rodar(['mostrar', tarefaIds[0], '--operador', OPERADOR], { auditoria: falha })
  assert.equal(codigo, 1)
  assert.equal(saida, '')
  assert.match(erro, /XX000/)
  for (const dado of DADOS_TITULAR) assert.ok(!erro.includes(dado), dado)
})

test('CA8: mostrar de tarefa inexistente devolve 1 sem auditoria nem saída', async () => {
  const { codigo, saida } = await rodar(['mostrar', '00000000-0000-4000-8000-000000000001', '--operador', OPERADOR])
  assert.equal(codigo, 1)
  assert.equal(saida, '')
})

test('CA8: mostrar exige --operador', async () => {
  const { tarefaIds } = await semearUma()
  const { codigo, saida } = await rodar(['mostrar', tarefaIds[0]])
  assert.equal(codigo, 1)
  assert.equal(saida, '')
})

test('CA8: o log e o erro não têm dado do titular em mostrar, registrado e renovado, nem nos caminhos de erro', async () => {
  const { tarefaIds } = await semearComTarefas(banco.admin)
  const { renovacaoId } = await semearRenovacao()
  const falha = async () => { throw new Error('Fulano Ficticio fulano@exemplo.test 11999990000') }
  const erros = []
  for (const [args, extras] of [
    [['mostrar', tarefaIds[0], '--operador', OPERADOR], {}],
    [['mostrar', tarefaIds[0], '--operador', OPERADOR], { auditoria: falha }],
    [['registrado', tarefaIds[0], '--expira-em', EXPIRA, '--operador', OPERADOR], { auditoria: falha }],
    [['registrado', tarefaIds[0], '--expira-em', EXPIRA, '--operador', OPERADOR], {}],
    [['registrado', tarefaIds[0], '--expira-em', EXPIRA, '--operador', OPERADOR], {}],
    [['renovado', renovacaoId, '--expira-em', NOVA_EXPIRA, '--operador', OPERADOR], {}],
    [['renovado', renovacaoId, '--expira-em', NOVA_EXPIRA, '--operador', OPERADOR], {}],
    [['registrado', tarefaIds[1], '--expira-em', '2027-02-30', '--operador', OPERADOR], {}]
  ]) {
    erros.push((await rodar(args, extras)).erro)
  }
  const tudo = log.texto() + erros.join('')
  for (const dado of DADOS_TITULAR) assert.ok(!tudo.includes(dado), dado)
})

test('CA8: erro do banco vai ao stderr só com o code, nunca com a message', async () => {
  const pool = { async query() { throw Object.assign(new Error('Fulano Ficticio fulano@exemplo.test'), { code: '57P01' }) } }
  for (const args of [['listar'], ['mostrar', '00000000-0000-4000-8000-000000000001', '--operador', OPERADOR]]) {
    const { codigo, erro } = await rodar(args, { pool })
    assert.equal(codigo, 1)
    assert.match(erro, /57P01/)
    assert.ok(!erro.includes('Fulano'))
  }
})

test('CA8: erro de conexão em registrado vai ao stderr só com o code', async () => {
  const pool = { async connect() { throw Object.assign(new Error('Fulano Ficticio'), { code: '08006' }) } }
  const { codigo, erro } = await registrar('00000000-0000-4000-8000-000000000001', { pool })
  assert.equal(codigo, 1)
  assert.match(erro, /08006/)
  assert.ok(!erro.includes('Fulano'))
})

test('CA8: listar mostra tarefa, tipo, pedido, estado do pedido e domínio, sem dado do titular', async () => {
  const { pedidoId, tarefaIds } = await semearComTarefas(banco.admin)
  const { codigo, saida } = await rodar(['listar'])
  assert.equal(codigo, 0)
  assert.ok(saida.includes(tarefaIds[0]))
  assert.ok(saida.includes(pedidoId))
  assert.ok(saida.includes('aguardando_registro_de_dominio'))
  assert.ok(saida.includes(DOMINIO_DOIS))
  for (const dado of ['Fulano Ficticio', 'fulano@exemplo.test', '11999990000']) assert.ok(!saida.includes(dado), dado)
})

test('CA8: listar mostra os dias úteis desde a abertura pelo relógio injetado', async () => {
  await semearComTarefas(banco.admin, { abertaEm: '2026-11-26T13:00:00Z', dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  // quinta 26/11 → terça 01/12: sex 27, seg 30, ter 01 = 3 dias úteis
  const { saida } = await rodar(['listar'])
  assert.match(saida, /2026-11-26\t3\n/)
})

test('CA8: listar oculta tarefa de pedido cancelado e --todas a mostra marcada', async () => {
  await semearComTarefas(banco.admin, { estado: 'cancelado', dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  const padrao = await rodar(['listar'])
  assert.equal(padrao.saida, 'nenhuma tarefa aberta\n')
  const todas = await rodar(['listar', '--todas'])
  assert.ok(todas.saida.includes('cancelado (não registrar)'))
})

test('CA8: listar não mostra tarefa concluída', async () => {
  const { tarefaIds } = await semearUma()
  await registrar(tarefaIds[0])
  const { saida } = await rodar(['listar'])
  assert.equal(saida, 'nenhuma tarefa aberta\n')
})

test('CA8: listar com argumento posicional devolve 1', async () => {
  const { codigo } = await rodar(['listar', 'sobra'])
  assert.equal(codigo, 1)
})
