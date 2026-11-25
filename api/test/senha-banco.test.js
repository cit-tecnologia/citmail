// CIT-71: consumidor `senha_primeiro_acesso` e `emitirToken` (CA1) e grants da migração
// `solicitacao_senha` (CA9), com o papel da aplicação. Só dados fictícios.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { criarLogger } from '../src/log.js'
import { consumidoresDoAmbiente, criarHandlersDeConsumidores, processarEvento } from '../src/eventos/consumidores.js'
import { criarHandlersSenha } from '../src/senhas/job-esqueci.js'
import { emitirToken } from '../src/senhas/servico.js'
import { criarCapturaDeLog, gravarContaTitularCriada, semearContaPainel, semearSolicitacao } from './auxiliares.js'
import { criarBancoWebhook } from './webhook-fixtures.js'

const EMAIL = 'titular@exemplo.com.br'
const TRUNCAR = 'TRUNCATE solicitacao_senha, conta_titular, evento_processado, evento, cliente CASCADE'
const sha256 = (texto) => createHash('sha256').update(texto, 'utf8').digest('hex')

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
  pool: banco.app,
  consumidor: 'senha_primeiro_acesso',
  tratar: consumidoresDoAmbiente({ painelHabilitado: true }).senha_primeiro_acesso.tratar,
  log
}, { eventoId })

const solicitacoes = async () => (await banco.admin.query(
  `SELECT *, extract(epoch FROM expira_em - criada_em) AS prazo_s FROM solicitacao_senha ORDER BY criada_em`
)).rows
const eventosSenha = async () => (await banco.admin.query(
  "SELECT * FROM evento WHERE nome = 'definicao_senha_solicitada'"
)).rows

async function esperarCodigo(promessa, codigo) {
  await assert.rejects(promessa, (erro) => erro.code === codigo)
}

test('CA1: conta_titular_criada de conta sem_senha → 1 solicitação primeiro_acesso de 72 h e 1 evento sem token; reprocessar não duplica', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, estado: 'sem_senha' })
  const eventoId = await gravarContaTitularCriada(banco.admin, contaId)

  await consumir(eventoId)

  const [solicitacao, ...resto] = await solicitacoes()
  assert.equal(resto.length, 0)
  assert.equal(solicitacao.tipo, 'primeiro_acesso')
  assert.equal(solicitacao.token_hash, null)
  assert.ok(Math.abs(Number(solicitacao.prazo_s) - 72 * 3600) <= 1, `prazo ${solicitacao.prazo_s}`)
  const eventos = await eventosSenha()
  assert.equal(eventos.length, 1)
  assert.deepStrictEqual(eventos[0].payload, {
    contaId, tipo: 'primeiro_acesso', solicitacaoId: solicitacao.id, expiraEm: solicitacao.expira_em.toISOString()
  })
  assert.equal(eventos[0].chave_idempotencia, `definicao_senha_solicitada-${solicitacao.id}`)
  assert.equal(eventos[0].agregado_tipo, 'conta_titular')
  assert.equal(eventos[0].agregado_id, contaId)
  assert.doesNotMatch(JSON.stringify(eventos[0].payload), /[A-Za-z0-9_-]{43}/)

  await consumir(eventoId)
  assert.ok(captura.linhas().some((l) => l.msg === 'evento já processado'))
  assert.equal((await solicitacoes()).length, 1)
  assert.equal((await eventosSenha()).length, 1)
})

test('CA1: conta fora de sem_senha → nenhuma solicitação nem evento', { tag: '@CIT-71' }, async () => {
  for (const [i, estado] of ['ativa', 'suspensa', 'cancelada'].entries()) {
    const { contaId } = await semearContaPainel(banco.admin, { email: `outra${i}@exemplo.com.br`, senha: 'Senha-de-teste-123', estado })
    await consumir(await gravarContaTitularCriada(banco.admin, contaId))
  }
  assert.equal((await solicitacoes()).length, 0)
  assert.equal((await eventosSenha()).length, 0)
})

test('CA1: agregado divergente ou conta inexistente → UnrecoverableError', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, estado: 'sem_senha' })
  const divergente = await gravarContaTitularCriada(banco.admin, contaId, { payload: { contaId: '00000000-0000-4000-8000-000000000000' } })
  await assert.rejects(consumir(divergente), { name: 'UnrecoverableError' })
  const inexistente = '11111111-1111-4111-8111-111111111111'
  await assert.rejects(consumir(await gravarContaTitularCriada(banco.admin, inexistente)), { name: 'UnrecoverableError' })
  assert.equal((await solicitacoes()).length, 0)
})

test('CA1: flag ligada registra o consumidor e o job; desligada, nenhum dos dois', { tag: '@CIT-71' }, () => {
  const filas = { alertas: { add: async () => {} } }
  const ligada = criarHandlersDeConsumidores({ pool: banco.app, consumidores: consumidoresDoAmbiente({ painelHabilitado: true }) })
  assert.equal(typeof ligada.senha_primeiro_acesso, 'function')
  assert.equal(typeof criarHandlersSenha({ pool: banco.app, filas, painelHabilitado: true }).senha_esqueci, 'function')

  const desligada = criarHandlersDeConsumidores({ pool: banco.app, consumidores: consumidoresDoAmbiente({ painelHabilitado: false }) })
  assert.ok(!Object.hasOwn(desligada, 'senha_primeiro_acesso'))
  assert.ok(Object.hasOwn(desligada, 'email_compra_confirmada'))
  assert.deepStrictEqual(criarHandlersSenha({ pool: banco.app, filas, painelHabilitado: false }), {})
})

test('CA1: emitirToken (Pool) devolve 43 base64url e grava o sha256; a 2ª troca o hash; usada, vencida ou id inválido → null', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, estado: 'sem_senha' })
  const id = await semearSolicitacao(banco.admin, { contaId, tipo: 'primeiro_acesso' })
  const hashDe = async (sid) => (await banco.admin.query('SELECT token_hash FROM solicitacao_senha WHERE id = $1', [sid])).rows[0].token_hash

  const primeiro = await emitirToken(banco.app, id)
  assert.match(primeiro, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(await hashDe(id), sha256(primeiro))

  const segundo = await emitirToken(banco.app, id)
  assert.match(segundo, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(segundo, primeiro)
  assert.equal(await hashDe(id), sha256(segundo))

  const usada = await semearSolicitacao(banco.admin, { contaId, usada: true })
  const vencida = await semearSolicitacao(banco.admin, { contaId, recuoMs: 2 * 3600000 })
  assert.equal(await emitirToken(banco.app, usada), null)
  assert.equal(await emitirToken(banco.app, vencida), null)
  assert.equal(await hashDe(usada), null)
  assert.equal(await hashDe(vencida), null)
  assert.equal(await emitirToken(banco.app, 'nao-e-uuid'), null)
  assert.equal(await emitirToken(banco.app, '22222222-2222-4222-8222-222222222222'), null)
})

test('CA9: grants do papel da aplicação em conta_titular e solicitacao_senha; únicos e CHECK', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, estado: 'sem_senha' })
  const app = banco.app

  await esperarCodigo(app.query("UPDATE conta_titular SET email = 'outro@exemplo.com.br' WHERE id = $1", [contaId]), '42501')
  await app.query("UPDATE conta_titular SET senha_hash = 'x', senha_definida_em = now(), estado = 'ativa' WHERE id = $1", [contaId])
  const cliente = await app.connect()
  try {
    await cliente.query('BEGIN')
    assert.equal((await cliente.query('SELECT id FROM conta_titular WHERE id = $1 FOR UPDATE', [contaId])).rowCount, 1)
    await cliente.query('ROLLBACK')
  } finally {
    cliente.release()
  }

  await esperarCodigo(app.query(
    "INSERT INTO solicitacao_senha (id, conta_titular_id, tipo, expira_em) VALUES (gen_random_uuid(), $1, 'redefinicao', now() + interval '1 hour')",
    [contaId]
  ), '42501')
  await esperarCodigo(app.query(
    "INSERT INTO solicitacao_senha (conta_titular_id, tipo, criada_em, expira_em) VALUES ($1, 'redefinicao', now(), now() + interval '1 hour')",
    [contaId]
  ), '42501')
  const { rows: [{ id }] } = await app.query(
    "INSERT INTO solicitacao_senha (conta_titular_id, tipo, expira_em) VALUES ($1, 'redefinicao', now() + interval '1 hour') RETURNING id",
    [contaId]
  )
  await app.query('UPDATE solicitacao_senha SET token_hash = $2, enviada_em = now(), usada_em = now() WHERE id = $1', [id, sha256('a')])
  await esperarCodigo(app.query('UPDATE solicitacao_senha SET tipo = $2 WHERE id = $1', [id, 'primeiro_acesso']), '42501')
  await esperarCodigo(app.query('DELETE FROM solicitacao_senha WHERE id = $1', [id]), '42501')

  const outra = await semearSolicitacao(banco.admin, { contaId })
  await esperarCodigo(app.query('UPDATE solicitacao_senha SET token_hash = $2 WHERE id = $1', [outra, sha256('a')]), '23505')
  await esperarCodigo(app.query(
    "INSERT INTO solicitacao_senha (conta_titular_id, tipo, expira_em) VALUES ($1, 'redefinicao', now())",
    [contaId]
  ), '23514')
  await esperarCodigo(app.query('UPDATE solicitacao_senha SET token_hash = $2 WHERE id = $1', [outra, 'nao-hex']), '23514')
})
