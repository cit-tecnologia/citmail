// CIT-71, CA2 (job): handler `senha_esqueci` com o papel da aplicação (tipos por estado,
// normalização do e-mail, limites de 5 min e de 5 abertas) e, na fila real, remoção do job
// ao terminar e ao falhar e alerta da última tentativa sem o e-mail. Só dados fictícios.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { criarLogger } from '../src/log.js'
import { modelosPadrao } from '../src/email/modelos/index.js'
import { criarHandlerEmail } from '../src/email/servico.js'
import { criarTransporte } from '../src/email/transporte.js'
import { criarHandlerEsqueci, JOB_SENHA_ESQUECI, OPCOES_JOB_ESQUECI } from '../src/senhas/job-esqueci.js'
import { hashDoToken, validarToken } from '../src/senhas/servico.js'
import {
  criarCapturaDeLog, criarFilasTeste, decodificarQp, semearContaPainel, semearEnvio, semearSolicitacao
} from './auxiliares.js'
import { REMETENTE, SENHA_SMTP } from './email-fixtures.js'
import { criarStubSmtp } from './stub-smtp.js'
import { criarBancoWebhook } from './webhook-fixtures.js'

const EMAIL = 'titular@exemplo.com.br'
const SENHA = 'Senha-de-teste-123'
const TRUNCAR = 'TRUNCATE email_envio, solicitacao_senha, conta_titular, evento_processado, evento, cliente CASCADE'
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

function pedir(email, {
  filas = filasFalsas().filas, tentativa = { feita: 0, maxima: 3 }, pool = banco.app, requestId = 'req-ficticio-cit71', jobId = '7'
} = {}) {
  return criarHandlerEsqueci({ pool, filas })({ log, tentativa, jobId }, { email, requestId })
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
const envios = async () => (await banco.admin.query('SELECT * FROM email_envio ORDER BY criado_em, id')).rows

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
  // CIT-72, cenário (d): a recente ainda está na janela do outbox, sem reemissão.
  assert.equal((await envios()).length, 0)

  await banco.admin.query('TRUNCATE solicitacao_senha')
  await semearSolicitacao(banco.admin, { contaId, recuoMs: CINCO_MIN_MS + 1000 })
  await pedir(EMAIL)
  assert.equal((await solicitacoesDe(contaId)).length, 2)
  assert.equal((await envios()).length, 0)
})

test('CA2: com 5 abertas (todas de mais de 5 min) não gera; com uma vencida ou usada, gera', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA })
  const abertas = (n) => Promise.all(Array.from({ length: n }, () => semearSolicitacao(banco.admin, {
    contaId, recuoMs: CINCO_MIN_MS + 60000, prazoMs: 3600000
  })))

  await abertas(5)
  await pedir(EMAIL)
  assert.equal((await solicitacoesDe(contaId)).length, 5)
  // CIT-72: sem envio e todas antigas → 1 reemissão da mais recente.
  assert.equal((await envios()).length, 1)
  await banco.admin.query('TRUNCATE email_envio')

  for (const extra of [{ prazoMs: 60000 }, { usada: true }]) {
    await banco.admin.query('TRUNCATE solicitacao_senha')
    await abertas(4)
    await semearSolicitacao(banco.admin, { contaId, recuoMs: CINCO_MIN_MS + 60000, prazoMs: 3600000, ...extra })
    await pedir(EMAIL)
    assert.equal((await solicitacoesDe(contaId)).length, 6, JSON.stringify(extra))
    assert.equal((await envios()).length, 0, JSON.stringify(extra))
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

test('CA2: worker sem o handler (flags diferentes na API e no worker) → job removido e 1 alerta só com id e nome', { tag: '@CIT-71', timeout: 30000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 20 })
  t.after(aux.fechar)
  const enviados = []
  aux.criarWorkers({ handlers: {}, enviarAlerta: async (dados) => { enviados.push(dados) } })

  const job = await aux.filas.jobs.add(JOB_SENHA_ESQUECI, { email: EMAIL, requestId: 'req-ficticio-cit71' }, OPCOES_JOB_ESQUECI)
  await aguardar(async () => enviados.length === 1)
  await aguardar(async () => (await aux.filas.jobs.getJob(job.id)) === undefined)
  assert.deepStrictEqual(enviados[0], { jobId: job.id, job: JOB_SENHA_ESQUECI })
  assert.doesNotMatch(JSON.stringify(enviados), /exemplo\.com\.br/i)
  assert.ok(aux.captura.linhas().some((l) => l.msg === 'job desconhecido'))
})

// ---------------------------------------------------------------------------
// CIT-72, CA2: reemissão do link no limite, com anti-spam pelo `email_envio`.
// ---------------------------------------------------------------------------

const MIN_MS = 60 * 1000
const LINK = /definir-senha\.html#t=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/

async function enviarComStub(envioId) {
  const stub = await criarStubSmtp()
  const transporte = criarTransporte({
    emailTransporte: 'smtp', smtpHost: stub.host, smtpPorta: stub.porta, smtpUsuario: 'usuario-ficticio',
    smtpSenha: SENHA_SMTP, smtpTimeoutMs: 3000, smtpRequireTls: false
  })
  try {
    await criarHandlerEmail({
      pool: banco.app, modelos: modelosPadrao, transporte, remetente: REMETENTE, painelUrlBase: 'http://127.0.0.1:4200/citmail/', log
    })({ log }, { envioId, geracao: 1 })
    assert.equal(stub.mensagens.length, 1)
    return decodificarQp(stub.mensagens[0].data)
  } finally {
    transporte.close()
    await stub.parar()
  }
}

const descarte = (motivo) => captura.linhas().filter((l) => l.msg === 'reemissão do link descartada' && l.motivo === motivo).at(-1)

async function contaComSenha() {
  return (await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA })).contaId
}

test('CIT-72 CA2(a): envio anterior falhou há mais de 5 min e enviada_em nulo → reemite com chave por pedido; o token anterior deixa de valer', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  const anterior = 'T'.repeat(43)
  const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS, token: anterior })
  await semearEnvio(banco.admin, { solicitacaoId, estado: 'falhou', recuoMs: CINCO_MIN_MS + 1000 })
  assert.deepStrictEqual(await validarToken(banco.app, anterior), { tipo: 'redefinicao' })
  const requestId = randomUUID()
  await pedir(EMAIL, { requestId })

  assert.equal((await solicitacoesDe(contaId)).length, 1, 'sem solicitação nova')
  const novos = (await envios()).filter((e) => e.chave_idempotencia.startsWith('senha_reenvio-'))
  assert.equal(novos.length, 1)
  assert.equal(novos[0].chave_idempotencia, `senha_reenvio-${solicitacaoId}-${requestId}`)
  assert.equal(novos[0].modelo, 'senha_redefinicao')
  assert.deepStrictEqual(novos[0].refs, { solicitacaoId })
  assert.equal(novos[0].evento_id, null)

  const { texto } = await enviarComStub(novos[0].id)
  const token = LINK.exec(texto)[1]
  assert.deepStrictEqual(await validarToken(banco.app, token), { tipo: 'redefinicao' })
  assert.equal(await validarToken(banco.app, anterior), null)
  assert.equal((await banco.admin.query('SELECT token_hash FROM solicitacao_senha WHERE id = $1', [solicitacaoId])).rows[0].token_hash, hashDoToken(token))
  assert.ok(captura.linhas().some((l) => l.msg === 'link reemitido' && l.solicitacaoId === solicitacaoId))
  assert.doesNotMatch(captura.texto(), /exemplo\.com\.br/i)
  assert.ok(!captura.texto().includes(token))
})

test('CIT-72 CA2(b): 5 abertas, a mais recente enviada há 5 min + 1 s → reemite a mais recente', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  for (let i = 0; i < 4; i++) await semearSolicitacao(banco.admin, { contaId, recuoMs: 20 * MIN_MS })
  const recente = await semearSolicitacao(banco.admin, { contaId, recuoMs: 10 * MIN_MS, enviadaRecuoMs: CINCO_MIN_MS + 1000 })
  await semearEnvio(banco.admin, { solicitacaoId: recente, estado: 'enviado', recuoMs: CINCO_MIN_MS + 1000 })
  await pedir(EMAIL, { requestId: randomUUID() })
  const novos = (await envios()).filter((e) => e.chave_idempotencia.startsWith('senha_reenvio-'))
  assert.equal(novos.length, 1)
  assert.deepStrictEqual(novos[0].refs, { solicitacaoId: recente })
})

test('CIT-72 CA2(c): envio enviado há 4 min → nenhum envio novo, descarte reenvio_recente', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: 4 * MIN_MS })
  await semearEnvio(banco.admin, { solicitacaoId, estado: 'enviado', recuoMs: 4 * MIN_MS })
  await pedir(EMAIL, { requestId: randomUUID() })
  assert.equal((await envios()).length, 1)
  const registro = descarte('reenvio_recente')
  assert.equal(registro.solicitacaoId, solicitacaoId)
  assert.equal(registro.contaId, contaId)
})

test('CIT-72 CA2: envio falhou ou nao_enviado há menos de 5 min → nenhum envio novo, descarte reenvio_recente', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  for (const estado of ['falhou', 'nao_enviado']) {
    await banco.admin.query('TRUNCATE email_envio, solicitacao_senha')
    const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS })
    await semearEnvio(banco.admin, { solicitacaoId, estado, recuoMs: 4 * MIN_MS })
    await pedir(EMAIL, { requestId: randomUUID() })
    assert.equal((await envios()).length, 1, estado)
    assert.equal(descarte('reenvio_recente')?.solicitacaoId, solicitacaoId, estado)
  }
})

test('CIT-72 CA2(d): sem envio e criada há 1 min → envio_pendente; sem envio e de 5 min + 1 s (5 abertas) → reemite', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS })
  await pedir(EMAIL, { requestId: randomUUID() })
  assert.equal((await envios()).length, 0)
  assert.ok(descarte('envio_pendente'))

  await banco.admin.query('TRUNCATE solicitacao_senha')
  for (let i = 0; i < 4; i++) await semearSolicitacao(banco.admin, { contaId, recuoMs: 20 * MIN_MS })
  const recente = await semearSolicitacao(banco.admin, { contaId, recuoMs: CINCO_MIN_MS + 1000 })
  await pedir(EMAIL, { requestId: randomUUID() })
  const novos = await envios()
  assert.equal(novos.length, 1)
  assert.deepStrictEqual(novos[0].refs, { solicitacaoId: recente })
})

test('CIT-72 CA2: pendente vivo não reemite; pendente alertado ou de mais de 1 h reemite', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  const casos = [
    ['vivo', { recuoMs: 10 * MIN_MS }, 0],
    ['alertado', { recuoMs: 10 * MIN_MS, alertado: true }, 1],
    ['de mais de 1 h', { recuoMs: 61 * MIN_MS }, 1]
  ]
  for (const [caso, envio, esperados] of casos) {
    await banco.admin.query('TRUNCATE email_envio, solicitacao_senha')
    const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS })
    await semearEnvio(banco.admin, { solicitacaoId, estado: 'pendente', ...envio })
    await pedir(EMAIL, { requestId: randomUUID() })
    const novos = (await envios()).filter((e) => e.chave_idempotencia.startsWith('senha_reenvio-'))
    assert.equal(novos.length, esperados, caso)
  }
  assert.ok(descarte('envio_pendente'))
})

test('CIT-72 CA2: todas usadas ou vencidas → sem_aberta; conta cancelada → nada', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS, usada: true })
  await semearSolicitacao(banco.admin, { contaId, recuoMs: 2 * MIN_MS, prazoMs: 30000 })
  await pedir(EMAIL, { requestId: randomUUID() })
  assert.equal((await envios()).length, 0)
  assert.ok(descarte('sem_aberta'))

  await banco.admin.query('TRUNCATE solicitacao_senha')
  const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS })
  await semearEnvio(banco.admin, { solicitacaoId, estado: 'falhou', recuoMs: CINCO_MIN_MS + 1000 })
  await banco.admin.query("UPDATE conta_titular SET estado = 'cancelada' WHERE id = $1", [contaId])
  await pedir(EMAIL, { requestId: randomUUID() })
  assert.equal((await envios()).length, 1, 'só o semeado')
})

test('CIT-72 CA2: primeiro acesso no limite reemite com o modelo do tipo do banco', { tag: '@CIT-72' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, estado: 'sem_senha' })
  const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, tipo: 'primeiro_acesso', recuoMs: MIN_MS, prazoMs: 72 * 3600000 })
  await semearEnvio(banco.admin, { solicitacaoId, modelo: 'senha_primeiro_acesso', estado: 'nao_enviado', recuoMs: CINCO_MIN_MS + 1000 })
  await pedir(EMAIL, { requestId: randomUUID() })
  const novos = (await envios()).filter((e) => e.chave_idempotencia.startsWith('senha_reenvio-'))
  assert.equal(novos.length, 1)
  assert.equal(novos[0].modelo, 'senha_primeiro_acesso')
})

test('CIT-72 CA2: requestId fora do formato usa o jobId na chave', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS })
  await semearEnvio(banco.admin, { solicitacaoId, estado: 'falhou', recuoMs: CINCO_MIN_MS + 1000 })
  await pedir(EMAIL, { requestId: 'req-ficticio-cit71', jobId: '42' })
  const novos = (await envios()).filter((e) => e.chave_idempotencia.startsWith('senha_reenvio-'))
  assert.deepStrictEqual(novos.map((e) => e.chave_idempotencia), [`senha_reenvio-${solicitacaoId}-42`])
})

test('CIT-72 CA2: prazo na reemissão: solicitação de 1 h recuada 39 min 30 s → "vale por 20 minutos"', { tag: '@CIT-72' }, async () => {
  const contaId = await contaComSenha()
  for (let i = 0; i < 4; i++) await semearSolicitacao(banco.admin, { contaId, recuoMs: 50 * MIN_MS })
  const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: 39 * MIN_MS + 30000, prazoMs: 3600000 })
  await pedir(EMAIL, { requestId: randomUUID() })
  const [novo] = await envios()
  assert.deepStrictEqual(novo.refs, { solicitacaoId })
  const { texto, html } = await enviarComStub(novo.id)
  assert.match(texto, /vale por 20 minutos,/)
  assert.match(html, /vale por 20 minutos,/)
})

test('CIT-72 CA2: dois "esqueci" simultâneos na mesma conta → o 2º espera a trava da conta e há exatamente 1 envio novo', { tag: '@CIT-72', timeout: 30000 }, async () => {
  const contaId = await contaComSenha()
  const solicitacaoId = await semearSolicitacao(banco.admin, { contaId, recuoMs: MIN_MS })
  await semearEnvio(banco.admin, { solicitacaoId, estado: 'enviado', recuoMs: 10 * MIN_MS })
  // O 1º pedido para com a conta travada, antes de reemitir; o 2º só pode seguir depois do COMMIT dele.
  let liberar
  const portao = new Promise((resolve) => { liberar = resolve })
  let segurou
  const segurando = new Promise((resolve) => { segurou = resolve })
  let chamadas = 0
  const antesDeReemitir = async () => {
    chamadas += 1
    if (chamadas === 1) {
      segurou()
      await portao
    }
  }
  const pedirSegurando = (requestId, jobId) => criarHandlerEsqueci({ pool: banco.app, filas: filasFalsas().filas, antesDeReemitir })(
    { log, tentativa: { feita: 0, maxima: 3 }, jobId }, { email: EMAIL, requestId }
  )
  const primeiro = pedirSegurando(randomUUID(), '1')
  await segurando
  let segundoTerminou = false
  const segundo = pedirSegurando(randomUUID(), '2').finally(() => { segundoTerminou = true })
  try {
    // Espera o 2º bloquear no FOR UPDATE (lock não concedido) ou, sem a trava, terminar.
    await aguardar(async () => segundoTerminou ||
      (await banco.admin.query('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted')).rows[0].n > 0)
    assert.equal(segundoTerminou, false, 'o 2º pedido espera a trava da conta do 1º')
  } finally {
    liberar()
    await Promise.allSettled([primeiro, segundo])
  }
  await Promise.all([primeiro, segundo])
  const novos = (await envios()).filter((e) => e.chave_idempotencia.startsWith('senha_reenvio-'))
  assert.equal(novos.length, 1)
  assert.ok(descarte('envio_pendente'))
})
