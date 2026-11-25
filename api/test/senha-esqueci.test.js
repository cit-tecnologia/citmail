// CIT-71, CA2 (job): handler `senha_esqueci` com o papel da aplicação (tipos por estado,
// normalização do e-mail, limites de 5 min e de 5 abertas) e, na fila real, remoção do job
// ao terminar e ao falhar e alerta da última tentativa sem o e-mail. Só dados fictícios.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { criarLogger } from '../src/log.js'
import { criarHandlerEsqueci, JOB_SENHA_ESQUECI, OPCOES_JOB_ESQUECI } from '../src/senhas/job-esqueci.js'
import { criarCapturaDeLog, criarFilasTeste, semearContaPainel, semearSolicitacao } from './auxiliares.js'
import { criarBancoWebhook } from './webhook-fixtures.js'

const EMAIL = 'titular@exemplo.com.br'
const SENHA = 'Senha-de-teste-123'
const TRUNCAR = 'TRUNCATE solicitacao_senha, conta_titular, evento_processado, evento, cliente CASCADE'
const CINCO_MIN_MS = 5 * 60 * 1000

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

const filasFalsas = () => {
  const alertas = []
  return { alertas, filas: { alertas: { add: async (...args) => { alertas.push(args) } } } }
}

function pedir(email, { filas = filasFalsas().filas, tentativa = { feita: 0, maxima: 3 }, pool = banco.app } = {}) {
  return criarHandlerEsqueci({ pool, filas })({ log, tentativa, jobId: '7' }, { email, requestId: 'req-ficticio-cit71' })
}

const solicitacoesDe = async (contaId) => (await banco.admin.query(
  `SELECT *, extract(epoch FROM expira_em - criada_em) AS prazo_s FROM solicitacao_senha
    WHERE conta_titular_id = $1 ORDER BY criada_em`,
  [contaId]
)).rows
const eventosDe = async (contaId) => (await banco.admin.query(
  "SELECT * FROM evento WHERE nome = 'definicao_senha_solicitada' AND agregado_id = $1",
  [contaId]
)).rows
const todas = async () => (await banco.admin.query('SELECT count(*)::int AS n FROM solicitacao_senha')).rows[0].n

test('CA2: ativa e suspensa com senha → redefinicao de 1 h; sem_senha → primeiro_acesso de 72 h; com evento', { tag: '@CIT-71' }, async () => {
  const casos = [
    ['ativa@exemplo.com.br', 'ativa', SENHA, 'redefinicao', 3600],
    ['suspensa@exemplo.com.br', 'suspensa', SENHA, 'redefinicao', 3600],
    ['semsenha@exemplo.com.br', 'sem_senha', undefined, 'primeiro_acesso', 72 * 3600]
  ]
  for (const [email, estado, senha, tipo, prazo] of casos) {
    const { contaId } = await semearContaPainel(banco.admin, { email, senha, estado })
    await pedir(email)
    const [solicitacao, ...resto] = await solicitacoesDe(contaId)
    assert.equal(resto.length, 0, estado)
    assert.equal(solicitacao.tipo, tipo, estado)
    assert.equal(solicitacao.token_hash, null)
    assert.ok(Math.abs(Number(solicitacao.prazo_s) - prazo) <= 1, `${estado}: prazo ${solicitacao.prazo_s}`)
    const eventos = await eventosDe(contaId)
    assert.equal(eventos.length, 1, estado)
    assert.deepStrictEqual(eventos[0].payload, {
      contaId, tipo, solicitacaoId: solicitacao.id, expiraEm: solicitacao.expira_em.toISOString()
    })
  }
  assert.doesNotMatch(captura.texto(), /exemplo\.com\.br/i, 'sem e-mail no log')
})

test('CA2: cancelada e inexistente → 0 linha e 0 evento; e-mail com espaços e maiúsculas acha a conta', { tag: '@CIT-71' }, async () => {
  await semearContaPainel(banco.admin, { email: 'cancelada@exemplo.com.br', senha: SENHA, estado: 'cancelada' })
  await pedir('cancelada@exemplo.com.br')
  await pedir('ninguem@exemplo.com.br')
  assert.equal(await todas(), 0)
  assert.equal((await banco.admin.query("SELECT count(*)::int AS n FROM evento WHERE nome = 'definicao_senha_solicitada'")).rows[0].n, 0)

  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA })
  await pedir(' Titular@Exemplo.com.br ')
  assert.equal((await solicitacoesDe(contaId)).length, 1)
  assert.doesNotMatch(captura.texto(), /exemplo\.com\.br|ninguem|cancelada@/i, 'sem e-mail no log')
})

test('CA2: 2º pedido em menos de 5 min não gera; com a anterior a 5 min + 1 s, gera', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA })
  await pedir(EMAIL)
  await pedir(EMAIL)
  assert.equal((await solicitacoesDe(contaId)).length, 1)

  await banco.admin.query('TRUNCATE solicitacao_senha')
  await semearSolicitacao(banco.admin, { contaId, recuoMs: CINCO_MIN_MS + 1000 })
  await pedir(EMAIL)
  assert.equal((await solicitacoesDe(contaId)).length, 2)
})

test('CA2: com 5 abertas (todas de mais de 5 min) não gera; com uma vencida ou usada, gera', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA })
  const abertas = (n) => Promise.all(Array.from({ length: n }, () => semearSolicitacao(banco.admin, {
    contaId, recuoMs: CINCO_MIN_MS + 60000, prazoMs: 3600000
  })))

  await abertas(5)
  await pedir(EMAIL)
  assert.equal((await solicitacoesDe(contaId)).length, 5)

  for (const extra of [{ prazoMs: 60000 }, { usada: true }]) {
    await banco.admin.query('TRUNCATE solicitacao_senha')
    await abertas(4)
    await semearSolicitacao(banco.admin, { contaId, recuoMs: CINCO_MIN_MS + 60000, prazoMs: 3600000, ...extra })
    await pedir(EMAIL)
    assert.equal((await solicitacoesDe(contaId)).length, 6, JSON.stringify(extra))
  }
})

test('CA2: falha antes da última tentativa relança sem alerta; na última, 1 alerta só com jobId e nome', { tag: '@CIT-71' }, async () => {
  const poolFora = { query: async () => { throw Object.assign(new Error('banco fora'), { code: 'ECONNREFUSED' }) } }
  const { alertas, filas } = filasFalsas()
  await assert.rejects(pedir(EMAIL, { pool: poolFora, filas, tentativa: { feita: 0, maxima: 3 } }), { code: 'ECONNREFUSED' })
  assert.equal(alertas.length, 0)
  await assert.rejects(pedir(EMAIL, { pool: poolFora, filas, tentativa: { feita: 2, maxima: 3 } }), { code: 'ECONNREFUSED' })
  assert.equal(alertas.length, 1)
  assert.deepStrictEqual(alertas[0][1], { jobId: '7', job: JOB_SENHA_ESQUECI })
  assert.doesNotMatch(JSON.stringify(alertas), /exemplo\.com\.br/i)
})

test('CA2: na fila real o job some do Redis ao terminar e ao falhar; a falha final gera 1 alerta sem o e-mail', { tag: '@CIT-71', timeout: 30000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 2, backoffMs: 20 })
  t.after(aux.fechar)
  await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA })
  let falhar = false
  const poolAlternavel = {
    query: (...args) => (falhar ? Promise.reject(new Error('banco fora')) : banco.app.query(...args)),
    connect: () => banco.app.connect()
  }
  const enviados = []
  aux.criarWorkers({
    handlers: { [JOB_SENHA_ESQUECI]: criarHandlerEsqueci({ pool: poolAlternavel, filas: aux.filas }) },
    enviarAlerta: async (dados) => { enviados.push(dados) }
  })
  const ok = await aux.filas.jobs.add(JOB_SENHA_ESQUECI, { email: EMAIL, requestId: 'req-ficticio-cit71' }, OPCOES_JOB_ESQUECI)
  await aguardar(async () => (await aux.filas.jobs.getJob(ok.id)) === undefined)
  assert.equal((await banco.admin.query('SELECT count(*)::int AS n FROM solicitacao_senha')).rows[0].n, 1)

  falhar = true
  const falho = await aux.filas.jobs.add(JOB_SENHA_ESQUECI, { email: EMAIL, requestId: 'req-ficticio-cit71' }, OPCOES_JOB_ESQUECI)
  await aguardar(async () => enviados.length === 1)
  await aguardar(async () => (await aux.filas.jobs.getJob(falho.id)) === undefined)
  assert.deepStrictEqual(enviados[0], { jobId: falho.id, job: JOB_SENHA_ESQUECI })

  // Nada do e-mail no Redis do prefixo (jobs, alertas e streams).
  let cursor = '0'
  do {
    const [proximo, chaves] = await aux.conexao.scan(cursor, 'MATCH', `${aux.prefixo}:*`, 'COUNT', 1000)
    cursor = proximo
    for (const chave of chaves) {
      const tipo = await aux.conexao.type(chave)
      const conteudo = tipo === 'hash'
        ? JSON.stringify(await aux.conexao.hgetall(chave))
        : tipo === 'stream'
          ? JSON.stringify(await aux.conexao.xrange(chave, '-', '+'))
          : tipo === 'string' ? String(await aux.conexao.get(chave)) : ''
      assert.doesNotMatch(conteudo, /exemplo\.com\.br/i, chave)
    }
  } while (cursor !== '0')
  assert.doesNotMatch(aux.captura.texto(), /exemplo\.com\.br/i)
})

async function aguardar(condicao, prazoMs = 20000) {
  const limite = Date.now() + prazoMs
  while (!(await condicao())) {
    if (Date.now() > limite) throw new Error('aguardar: tempo esgotado')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
