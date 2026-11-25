// CIT-71: POST /api/painel/senha/esqueci|validar|definir (CA2 de rota, CA3-CA8) e a sessão
// amarrada à senha (`senhaEm`, `encerrarTodas`). Papel da aplicação no banco, Redis de teste
// para sessões e fila. Só dados fictícios.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { registrarAuditoria } from '../src/auditoria/servico.js'
import { gerarHashSenha, verificarSenha } from '../src/painel/senha.js'
import { hashDoId } from '../src/painel/sessoes.js'
import { emitirToken } from '../src/senhas/servico.js'
import {
  construirAppTeste, criarFilasTeste, criarSessoesTeste, semearContaPainel, semearSolicitacao
} from './auxiliares.js'
import { criarBancoWebhook } from './webhook-fixtures.js'

const ORIGEM_PAINEL = 'http://localhost:4200'
const ORIGEM_SO_CORS = 'http://127.0.0.1:4200'
const EMAIL = 'titular@exemplo.com.br'
const SENHA_ANTIGA = 'Senha-antiga-de-teste'
const SENHA_NOVA = 'Senha-nova-de-teste'
const NOME_COOKIE = '__Host-citmail_sessao'
const COOKIE = /^__Host-citmail_sessao=([A-Za-z0-9_-]{43}); /
const HASH_ARGON2ID = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/
const TRUNCAR = 'TRUNCATE solicitacao_senha, conta_titular, evento_processado, evento, cliente CASCADE'
const configPainel = { corsOrigens: [ORIGEM_SO_CORS, ORIGEM_PAINEL], painelOrigens: [ORIGEM_PAINEL] }

// Espiões e falhas injetadas, ligados por teste.
const estado = { gancho: null, falharAuditoria: false, falharEncerrarTodas: false, hashes: 0 }
// Tudo o que não pode aparecer em log, evento, auditoria nem Redis (CA7).
const segredos = new Set([SENHA_NOVA, SENHA_ANTIGA])
let banco
let sessoesTeste
let filasTeste
let teste

before(async () => {
  banco = await criarBancoWebhook()
  sessoesTeste = criarSessoesTeste()
  await sessoesTeste.pronta()
  filasTeste = criarFilasTeste()
  const sessoes = {
    ...sessoesTeste.sessoes,
    async encerrarTodas(contaId) {
      if (estado.falharEncerrarTodas) throw Object.assign(new Error('falha injetada'), { code: 'FALHA_INJETADA' })
      return sessoesTeste.sessoes.encerrarTodas(contaId)
    }
  }
  teste = await construirAppTeste({
    comBanco: false,
    pool: banco.app,
    sobrescritasConfig: configPainel,
    painel: {
      sessoes,
      filas: filasTeste.filas,
      hash: {
        verificar: verificarSenha,
        gerar(senha) {
          estado.hashes++
          return gerarHashSenha(senha)
        }
      },
      antesDeConsumir: async () => {
        if (estado.gancho) await estado.gancho()
      },
      auditoriaSenha(cliente, dados) {
        if (estado.falharAuditoria) throw new Error('auditoria fora')
        return registrarAuditoria(cliente, dados)
      }
    }
  })
})

after(async () => {
  await teste?.fechar()
  await filasTeste?.fechar()
  await sessoesTeste?.fechar()
  await banco?.fechar()
})

beforeEach(async () => {
  await banco.admin.query(TRUNCAR)
  Object.assign(estado, { gancho: null, falharAuditoria: false, falharEncerrarTodas: false, hashes: 0 })
})

const novoToken = () => {
  const token = randomBytes(32).toString('base64url')
  segredos.add(token)
  return token
}

// Solicitação aberta com o token emitido como a #72 fará (`emitirToken` no Pool).
async function novoLink(contaId, tipo = 'redefinicao') {
  const token = await emitirToken(banco.app, await semearSolicitacao(banco.admin, { contaId, tipo }))
  segredos.add(token)
  return token
}

// `origem: undefined` explícito manda sem `Origin`.
function post(rota, payload, opcoes = {}) {
  const { app = teste.app } = opcoes
  const origem = Object.hasOwn(opcoes, 'origem') ? opcoes.origem : ORIGEM_PAINEL
  return app.inject({
    method: 'POST',
    url: `/api/painel/senha/${rota}`,
    headers: origem === undefined ? {} : { origin: origem },
    payload
  })
}
const validar = (token, opcoes) => post('validar', { token }, opcoes)
const definir = (token, senha = SENHA_NOVA, opcoes) => post('definir', { token, senha }, opcoes)

async function entrar(email, senha) {
  return teste.app.inject({
    method: 'POST', url: '/api/painel/login', headers: { origin: ORIGEM_PAINEL }, payload: { email, senha }
  })
}
async function cookieDe(email, senha) {
  const resposta = await entrar(email, senha)
  assert.equal(resposta.statusCode, 204)
  return COOKIE.exec(resposta.headers['set-cookie'])[1]
}
const consultarSessao = (id) => teste.app.inject({ method: 'GET', url: '/api/painel/sessao', cookies: { [NOME_COOKIE]: id } })
const chave = (id) => `${sessoesTeste.prefixo}:sessao:${hashDoId(id)}`
const conjunto = (contaId) => `${sessoesTeste.prefixo}:sessoes:conta:${contaId}`

const contaDe = async (contaId) => (await banco.admin.query('SELECT * FROM conta_titular WHERE id = $1', [contaId])).rows[0]
const solicitacoesDe = async (contaId) => (await banco.admin.query(
  'SELECT * FROM solicitacao_senha WHERE conta_titular_id = $1 ORDER BY criada_em, id', [contaId]
)).rows
const auditoriasDe = async (contaId) => (await banco.admin.query(
  "SELECT * FROM auditoria WHERE alvo_id = $1 AND acao = 'senha_trocada'", [contaId]
)).rows

async function aguardar(condicao, prazoMs = 20000) {
  const limite = Date.now() + prazoMs
  while (!(await condicao())) {
    if (Date.now() > limite) throw new Error('aguardar: tempo esgotado')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// --------------------------------------------------------------------------- CA2

test('CA2: esqueci com e-mail de conta ativa, sem_senha, suspensa, cancelada e inexistente → 202 idêntico e job removível', { tag: '@CIT-71' }, async () => {
  await semearContaPainel(banco.admin, { email: 'ativa@exemplo.com.br', senha: SENHA_ANTIGA })
  await semearContaPainel(banco.admin, { email: 'semsenha@exemplo.com.br', estado: 'sem_senha' })
  await semearContaPainel(banco.admin, { email: 'suspensa@exemplo.com.br', senha: SENHA_ANTIGA, estado: 'suspensa' })
  await semearContaPainel(banco.admin, { email: 'cancelada@exemplo.com.br', senha: SENHA_ANTIGA, estado: 'cancelada' })
  const emails = ['ativa', 'semsenha', 'suspensa', 'cancelada', 'ninguem'].map((nome) => `${nome}@exemplo.com.br`)

  const cabecalhos = []
  for (const email of emails) {
    const resposta = await post('esqueci', { email })
    assert.equal(resposta.statusCode, 202, email)
    assert.equal(resposta.body, '')
    cabecalhos.push({
      'content-type': resposta.headers['content-type'],
      'cache-control': resposta.headers['cache-control'],
      'content-length': resposta.headers['content-length']
    })
  }
  for (const cabecalho of cabecalhos) assert.deepStrictEqual(cabecalho, cabecalhos[0])
  assert.equal(cabecalhos[0]['cache-control'], 'no-store')

  const jobs = await filasTeste.filas.jobs.getJobs(['waiting', 'delayed', 'active'])
  const doEsqueci = jobs.filter((job) => job.name === 'senha_esqueci')
  assert.equal(doEsqueci.length, emails.length)
  for (const job of doEsqueci) {
    assert.deepStrictEqual(Object.keys(job.data).sort(), ['email', 'requestId'])
    assert.equal(job.opts.removeOnComplete, true)
    assert.equal(job.opts.removeOnFail, true)
  }
  // Rota não toca o banco: nenhuma solicitação nasce sem o job.
  assert.equal((await banco.admin.query('SELECT count(*)::int AS n FROM solicitacao_senha')).rows[0].n, 0)
  await filasTeste.filas.jobs.obliterate({ force: true })
  assert.doesNotMatch(teste.captura.texto(), /exemplo\.com\.br/i)
})

test('CA2: falha ao enfileirar → 503 sessao_indisponivel', { tag: '@CIT-71' }, async (t) => {
  t.mock.method(filasTeste.filas.jobs, 'add', async () => { throw Object.assign(new Error('fila fora'), { code: 'FALHA_INJETADA' }) })
  const resposta = await post('esqueci', { email: EMAIL })
  assert.equal(resposta.statusCode, 503)
  assert.equal(resposta.body, '{"erro":"sessao_indisponivel"}')
  assert.equal(resposta.headers['cache-control'], 'no-store')
})

// --------------------------------------------------------------------------- CA3

test('CA3: validar → 200 { tipo }; definir → 204; hash Argon2id; estados; solicitações usadas; sessões antigas fora; auditoria; login novo', { tag: '@CIT-71' }, async () => {
  const casos = [
    ['semsenha@exemplo.com.br', 'sem_senha', 'ativa', 'primeiro_acesso'],
    ['ativa@exemplo.com.br', 'ativa', 'ativa', 'redefinicao'],
    ['suspensa@exemplo.com.br', 'suspensa', 'suspensa', 'redefinicao']
  ]
  for (const [email, inicial, final, tipo] of casos) {
    const { contaId, clienteId } = await semearContaPainel(banco.admin, {
      email, estado: inicial, senha: inicial === 'sem_senha' ? undefined : SENHA_ANTIGA
    })
    const cookieAntigo = inicial === 'ativa' ? await cookieDe(email, SENHA_ANTIGA) : null
    const outra = await novoLink(contaId, tipo)
    const token = await novoLink(contaId, tipo)

    const validacao = await validar(token)
    assert.equal(validacao.statusCode, 200, email)
    assert.deepStrictEqual(validacao.json(), { tipo })
    assert.equal(validacao.headers['cache-control'], 'no-store')

    const resposta = await definir(token, 'Senha-de-12c')
    assert.equal(resposta.statusCode, 204, email)
    assert.equal(resposta.body, '')
    assert.equal(resposta.headers['cache-control'], 'no-store')

    const conta = await contaDe(contaId)
    assert.match(conta.senha_hash, HASH_ARGON2ID)
    assert.ok(await verificarSenha(conta.senha_hash, 'Senha-de-12c'))
    assert.ok(conta.senha_definida_em instanceof Date)
    assert.equal(conta.estado, final, email)
    for (const solicitacao of await solicitacoesDe(contaId)) assert.ok(solicitacao.usada_em, 'usada ou invalidada')
    assert.equal((await validar(outra)).statusCode, 410, 'a outra aberta foi invalidada')

    const [registro, ...resto] = await auditoriasDe(contaId)
    assert.equal(resto.length, 0)
    assert.equal(registro.autor_tipo, 'cliente')
    assert.equal(registro.autor_id, clienteId)
    assert.equal(registro.alvo_tipo, 'conta')
    assert.equal(registro.resultado, 'sucesso')
    assert.deepStrictEqual(registro.detalhes, { tipo })
    const texto = JSON.stringify(registro)
    assert.ok(!texto.includes(token) && !texto.includes('Senha-de-12c'))

    if (cookieAntigo) {
      assert.equal(await sessoesTeste.redis.exists(chave(cookieAntigo)), 0)
      assert.equal(await sessoesTeste.redis.exists(conjunto(contaId)), 0)
      assert.equal((await consultarSessao(cookieAntigo)).statusCode, 401)
    }
    assert.equal((await entrar(email, 'Senha-de-12c')).statusCode, final === 'ativa' ? 204 : 401, email)
  }
})

test('CA3: encerrarTodas falhando → 204 e o cookie antigo dá 401 por senhaEm, com a chave apagada', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const antigo = await cookieDe(EMAIL, SENHA_ANTIGA)
  estado.falharEncerrarTodas = true

  assert.equal((await definir(await novoLink(contaId))).statusCode, 204)
  assert.ok(teste.captura.linhas().some((l) => l.msg === 'falha ao encerrar as sessões da conta' && l.codigo === 'FALHA_INJETADA'))
  assert.equal(await sessoesTeste.redis.exists(chave(antigo)), 1, 'a sessão sobrou no Redis')

  const resposta = await consultarSessao(antigo)
  assert.equal(resposta.statusCode, 401)
  assert.equal(resposta.body, '{"erro":"sem_sessao"}')
  assert.equal(await sessoesTeste.redis.exists(chave(antigo)), 0)

  const novo = await cookieDe(EMAIL, SENHA_NOVA)
  assert.equal((await consultarSessao(novo)).statusCode, 200, 'sessão nova com senhaEm igual')
})

test('CA3: sessão sem senhaEm (anterior à CIT-71) → 401 e chave apagada', { tag: '@CIT-71' }, async () => {
  await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const id = await cookieDe(EMAIL, SENHA_ANTIGA)
  const dados = JSON.parse(await sessoesTeste.redis.get(chave(id)))
  assert.equal(typeof dados.senhaEm, 'number')
  const { senhaEm: _descartado, ...semCampo } = dados
  await sessoesTeste.redis.set(chave(id), JSON.stringify(semCampo), 'KEEPTTL')

  assert.equal((await consultarSessao(id)).statusCode, 401)
  assert.equal(await sessoesTeste.redis.exists(chave(id)), 0)
})

test('CA3: falha da auditoria → 503 sessao_indisponivel, nada gravado e o token continua valendo', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const token = await novoLink(contaId)
  const antes = await contaDe(contaId)
  estado.falharAuditoria = true

  const resposta = await definir(token)
  assert.equal(resposta.statusCode, 503)
  assert.equal(resposta.body, '{"erro":"sessao_indisponivel"}')
  assert.equal((await contaDe(contaId)).senha_hash, antes.senha_hash)
  assert.equal((await solicitacoesDe(contaId))[0].usada_em, null)

  estado.falharAuditoria = false
  assert.equal((await definir(token)).statusCode, 204)
})

// --------------------------------------------------------------------------- CA4

test('CA4: token vencido, usado, desconhecido ou de conta cancelada → 410 link_invalido em validar e definir, sem mudar o banco', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const vencido = novoToken()
  await semearSolicitacao(banco.admin, { contaId, token: vencido, recuoMs: 2 * 3600000 })
  const usado = novoToken()
  await semearSolicitacao(banco.admin, { contaId, token: usado, usada: true })
  const { contaId: canceladaId } = await semearContaPainel(banco.admin, { email: 'cancelada@exemplo.com.br', senha: SENHA_ANTIGA })
  const daCancelada = await novoLink(canceladaId)
  await banco.admin.query("UPDATE conta_titular SET estado = 'cancelada' WHERE id = $1", [canceladaId])

  const fotografia = async () => JSON.stringify([
    await contaDe(contaId), await contaDe(canceladaId), await solicitacoesDe(contaId), await solicitacoesDe(canceladaId)
  ])
  const antes = await fotografia()
  for (const token of [vencido, usado, novoToken(), daCancelada]) {
    for (const resposta of [await validar(token), await definir(token)]) {
      assert.equal(resposta.statusCode, 410)
      assert.equal(resposta.body, '{"erro":"link_invalido"}')
      assert.equal(resposta.headers['cache-control'], 'no-store')
    }
  }
  assert.equal(await fotografia(), antes)
  assert.equal((await auditoriasDe(contaId)).length, 0)
})

test('CA4: conta cancelada entre o validar e o definir → 410', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const token = await novoLink(contaId)
  assert.equal((await validar(token)).statusCode, 200)
  await banco.admin.query("UPDATE conta_titular SET estado = 'cancelada' WHERE id = $1", [contaId])
  assert.equal((await definir(token)).statusCode, 410)
})

// --------------------------------------------------------------------------- CA5

test('CA5: 11 e 129 code points e igual ao e-mail → 400 senha_fora_da_politica sem consumir; o mesmo token aceita depois', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const token = await novoLink(contaId)
  for (const senha of ['a'.repeat(10) + '😀', 'a'.repeat(128) + '😀', 'TITULAR@exemplo.com.br', ' titular@exemplo.com.br ']) {
    const resposta = await definir(token, senha)
    assert.equal(resposta.statusCode, 400, senha)
    assert.equal(resposta.body, '{"erro":"senha_fora_da_politica"}')
    assert.equal(resposta.headers['cache-control'], 'no-store')
  }
  assert.equal((await solicitacoesDe(contaId))[0].usada_em, null)
  assert.equal((await definir(token, SENHA_NOVA)).statusCode, 204)
})

test('CA5: 12 e 128 code points (com emoji) → 204', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  for (const senha of ['a'.repeat(11) + '😀', '😀'.repeat(128)]) {
    const resposta = await definir(await novoLink(contaId), senha)
    assert.equal(resposta.statusCode, 204, `${[...senha].length} code points`)
    assert.ok(await verificarSenha((await contaDe(contaId)).senha_hash, senha))
  }
})

// --------------------------------------------------------------------------- CA6

async function corrida(primeiroToken, segundoToken) {
  let liberar
  const segurar = new Promise((resolve) => { liberar = resolve })
  let chamadas = 0
  estado.gancho = async () => {
    chamadas++
    if (chamadas === 1) await segurar
  }
  const primeira = definir(primeiroToken)
  await aguardar(() => chamadas === 1)
  const segunda = definir(segundoToken)
  // A 2ª espera a trava da conta (`FOR UPDATE`) antes do gancho.
  await aguardar(async () => (await banco.admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
  )).rows[0].n >= 1)
  liberar()
  return (await Promise.all([primeira, segunda])).map((resposta) => resposta.statusCode).sort()
}

test('CA6: corrida com o mesmo token → uma 204 e outra 410; 1 auditoria; sem deadlock', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const token = await novoLink(contaId)
  assert.deepStrictEqual(await corrida(token, token), [204, 410])
  assert.equal((await auditoriasDe(contaId)).length, 1)
  assert.doesNotMatch(teste.captura.texto(), /40P01/)
})

test('CA6: corrida com dois tokens da mesma conta → uma 204 e outra 410; 1 auditoria; sem deadlock', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const primeiro = await novoLink(contaId)
  const segundo = await novoLink(contaId)
  assert.deepStrictEqual(await corrida(primeiro, segundo), [204, 410])
  assert.equal((await auditoriasDe(contaId)).length, 1)
  assert.doesNotMatch(teste.captura.texto(), /40P01/)
})

// --------------------------------------------------------------------------- CA8

test('CA8: sem Origin, origem estranha ou só de CORS_ORIGENS → 403 origem_recusada sem tocar banco nem Redis', { tag: '@CIT-71' }, async (t) => {
  const consultas = t.mock.method(banco.app, 'query')
  const conexoes = t.mock.method(banco.app, 'connect')
  const comandos = t.mock.method(sessoesTeste.redis, 'sendCommand')
  const adicoes = t.mock.method(filasTeste.filas.jobs, 'add')
  const token = novoToken()
  const pedidos = [['esqueci', { email: EMAIL }], ['validar', { token }], ['definir', { token, senha: SENHA_NOVA }]]
  for (const origem of [undefined, 'https://estranha.exemplo.test', ORIGEM_SO_CORS]) {
    for (const [rota, corpo] of pedidos) {
      const resposta = await post(rota, corpo, { origem })
      assert.equal(resposta.statusCode, 403, `${rota} ${origem}`)
      assert.equal(resposta.body, '{"erro":"origem_recusada"}')
      assert.equal(resposta.headers['cache-control'], 'no-store')
    }
  }
  assert.equal(consultas.mock.callCount(), 0)
  assert.equal(conexoes.mock.callCount(), 0)
  assert.equal(comandos.mock.callCount(), 0)
  assert.equal(adicoes.mock.callCount(), 0)
  assert.equal(estado.hashes, 0)
})

test('CA8: 400 do schema leva no-store; token fora do formato → 400', { tag: '@CIT-71' }, async () => {
  for (const [rota, corpo] of [
    ['esqueci', { email: 'x' }], ['validar', { token: 'curto' }], ['definir', { token: 'a'.repeat(43) }],
    ['definir', { token: 'a'.repeat(43), senha: 'x'.repeat(20), extra: 1 }]
  ]) {
    const resposta = await post(rota, corpo)
    assert.equal(resposta.statusCode, 400, rota)
    assert.equal(resposta.headers['cache-control'], 'no-store')
  }
})

test('CA8: Redis em porta fechada → 503 sessao_indisponivel em até 3 s, sem banco nem Argon2, mesmo corpo para qualquer e-mail', { tag: '@CIT-71' }, async (t) => {
  const fora = criarSessoesTeste({ url: 'redis://127.0.0.1:1' })
  t.after(() => fora.fechar())
  const semRedis = await construirAppTeste({
    comBanco: false,
    pool: banco.app,
    sobrescritasConfig: configPainel,
    painel: { sessoes: fora.sessoes, filas: filasTeste.filas, hash: { verificar: verificarSenha, gerar: () => { estado.hashes++ } } }
  })
  t.after(() => semRedis.fechar())
  await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const consultas = t.mock.method(banco.app, 'query')
  const conexoes = t.mock.method(banco.app, 'connect')
  const adicoes = t.mock.method(filasTeste.filas.jobs, 'add')
  const token = novoToken()

  const corpos = []
  for (const [rota, corpo] of [
    ['esqueci', { email: EMAIL }], ['esqueci', { email: 'ninguem@exemplo.com.br' }],
    ['validar', { token }], ['definir', { token, senha: SENHA_NOVA }]
  ]) {
    const inicio = Date.now()
    const resposta = await post(rota, corpo, { app: semRedis.app })
    assert.ok(Date.now() - inicio < 3000, `${rota} em ${Date.now() - inicio} ms`)
    assert.equal(resposta.statusCode, 503, rota)
    assert.equal(resposta.headers['cache-control'], 'no-store')
    corpos.push(resposta.body)
  }
  for (const corpo of corpos) assert.equal(corpo, '{"erro":"sessao_indisponivel"}')
  assert.equal(consultas.mock.callCount(), 0)
  assert.equal(conexoes.mock.callCount(), 0)
  assert.equal(adicoes.mock.callCount(), 0)
  assert.equal(estado.hashes, 0)
})

test('CA8: PAINEL_HABILITADO=false → 404 nas três rotas', { tag: '@CIT-71' }, async (t) => {
  const desligado = await construirAppTeste({
    comBanco: false, pool: banco.app, sobrescritasConfig: { ...configPainel, painelHabilitado: false }
  })
  t.after(() => desligado.fechar())
  for (const [rota, corpo] of [['esqueci', { email: EMAIL }], ['validar', { token: novoToken() }], ['definir', { token: novoToken(), senha: SENHA_NOVA }]]) {
    assert.equal((await post(rota, corpo, { app: desligado.app })).statusCode, 404, rota)
  }
})

// --------------------------------------------------------------------------- CA7

test('CA7: nenhum token, senha ou e-mail no log das rotas; nenhum token em evento, auditoria nem no Redis', { tag: '@CIT-71' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA })
  const token = await novoLink(contaId)
  assert.equal((await post('esqueci', { email: EMAIL })).statusCode, 202)
  assert.equal((await validar(token)).statusCode, 200)
  assert.equal((await definir(token, 'curta')).statusCode, 400)
  assert.equal((await definir(token)).statusCode, 204)
  assert.equal((await definir(token)).statusCode, 410)

  const log = teste.captura.texto()
  for (const segredo of segredos) assert.ok(!log.includes(segredo), 'segredo no log')
  assert.doesNotMatch(log, /exemplo\.com\.br/i)
  const tabelas = JSON.stringify([
    (await banco.admin.query('SELECT * FROM evento')).rows,
    (await banco.admin.query('SELECT * FROM auditoria')).rows
  ])
  for (const segredo of segredos) assert.ok(!tabelas.includes(segredo), 'segredo em evento ou auditoria')

  for (const prefixo of [sessoesTeste.prefixo, filasTeste.prefixo]) {
    let cursor = '0'
    do {
      const [proximo, chaves] = await sessoesTeste.redis.scan(cursor, 'MATCH', `${prefixo}:*`, 'COUNT', 1000)
      cursor = proximo
      for (const nome of chaves) {
        const tipo = await sessoesTeste.redis.type(nome)
        const conteudo = tipo === 'hash'
          ? JSON.stringify(await sessoesTeste.redis.hgetall(nome))
          : tipo === 'string' ? String(await sessoesTeste.redis.get(nome)) : ''
        for (const segredo of segredos) assert.ok(!conteudo.includes(segredo), `segredo em ${nome}`)
      }
    } while (cursor !== '0')
  }
  await filasTeste.filas.jobs.obliterate({ force: true })
})
