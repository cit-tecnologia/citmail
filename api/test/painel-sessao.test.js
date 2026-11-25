// CIT-70: logout e GET /api/painel/sessao (CA4 e CA7), com a corrida logout × renovação.
// Relógio injetado nas sessões; o TTL real do Redis é lido e manipulado direto.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { construirAppTeste, criarSessoesTeste, semearContaPainel } from './auxiliares.js';
import { ABSOLUTO_MS, hashDoId, INATIVIDADE_MS } from '../src/painel/sessoes.js';

const ORIGEM_PAINEL = 'http://localhost:4200';
const EMAIL = 'titular@exemplo.com.br';
const SENHA = 'Senha-de-teste-123';
const NOME_COOKIE = '__Host-citmail_sessao';
const COOKIE = /^__Host-citmail_sessao=([A-Za-z0-9_-]{43}); /;
const MIN = 60 * 1000;

const relogio = { agora: Date.now(), gancho: null, falharEncerrar: false };
let ctx;
let teste;
let conta;

before(async () => {
  ctx = criarSessoesTeste({
    agora: () => relogio.agora,
    antesDeRenovar: async () => {
      if (relogio.gancho) await relogio.gancho();
    },
  });
  await ctx.pronta();
  const sessoes = {
    ...ctx.sessoes,
    async encerrar(id) {
      if (relogio.falharEncerrar) throw Object.assign(new Error('falha injetada'), { code: 'FALHA_INJETADA' });
      return ctx.sessoes.encerrar(id);
    },
  };
  teste = await construirAppTeste({
    sobrescritasConfig: { corsOrigens: [ORIGEM_PAINEL], painelOrigens: [ORIGEM_PAINEL] },
    painel: { sessoes },
  });
  conta = await semearContaPainel(teste.pool, { email: EMAIL, senha: SENHA });
});

after(async () => {
  await teste?.fechar();
  await ctx?.fechar();
});

const chave = (id) => `${ctx.prefixo}:sessao:${hashDoId(id)}`;
const conjunto = () => `${ctx.prefixo}:sessoes:conta:${conta.contaId}`;

async function entrar(cookieAnterior) {
  const resposta = await teste.app.inject({
    method: 'POST',
    url: '/api/painel/login',
    headers: { origin: ORIGEM_PAINEL },
    payload: { email: EMAIL, senha: SENHA },
    ...(cookieAnterior ? { cookies: { [NOME_COOKIE]: cookieAnterior } } : {}),
  });
  assert.equal(resposta.statusCode, 204);
  return COOKIE.exec(resposta.headers['set-cookie'])[1];
}

function sair(id) {
  return teste.app.inject({
    method: 'POST',
    url: '/api/painel/logout',
    headers: { origin: ORIGEM_PAINEL },
    payload: {},
    ...(id ? { cookies: { [NOME_COOKIE]: id } } : {}),
  });
}

function consultar(id) {
  return teste.app.inject({ method: 'GET', url: '/api/painel/sessao', cookies: { [NOME_COOKIE]: id } });
}

// Reescreve os prazos guardados na sessão, mantendo o TTL real.
async function reescrever(id, campos) {
  const dados = JSON.parse(await ctx.redis.get(chave(id)));
  await ctx.redis.set(chave(id), JSON.stringify({ ...dados, ...campos }), 'KEEPTTL');
}

test('CA4: sair → 204 com o cookie expirado; a sessão some do Redis e do conjunto; cookie antigo → 401', { tag: '@CIT-70' }, async () => {
  const id = await entrar();
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(id)), 1);

  const resposta = await sair(id);
  assert.equal(resposta.statusCode, 204);
  assert.equal(resposta.headers['cache-control'], 'no-store');
  const setCookie = resposta.headers['set-cookie'];
  assert.match(setCookie, /^__Host-citmail_sessao=; /);
  const atributos = setCookie.split('; ').slice(1);
  for (const atributo of ['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(atributos.includes(atributo), atributo);
  }
  assert.doesNotMatch(setCookie, /Domain/i);

  assert.equal(await ctx.redis.exists(chave(id)), 0);
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(id)), 0);
  const depois = await consultar(id);
  assert.equal(depois.statusCode, 401);
  assert.equal(depois.body, '{"erro":"sem_sessao"}');
  assert.equal(depois.headers['cache-control'], 'no-store');
});

test('CA4: logout repetido, sem sessão ou com falha no Redis → 204', { tag: '@CIT-70' }, async (t) => {
  const id = await entrar();
  assert.equal((await sair(id)).statusCode, 204);
  assert.equal((await sair(id)).statusCode, 204);
  assert.equal((await sair()).statusCode, 204);
  assert.equal((await sair('cookie-fora-do-formato')).statusCode, 204);

  const outro = await entrar();
  relogio.falharEncerrar = true;
  t.after(() => { relogio.falharEncerrar = false; });
  const resposta = await sair(outro);
  assert.equal(resposta.statusCode, 204);
  assert.match(resposta.headers['set-cookie'], /Max-Age=0/);
  assert.ok(teste.captura.linhas().some((l) => l.msg === 'falha ao apagar a sessão do painel' && l.level === 50));
});

test('CA4: logout entre a leitura e a renovação de GET /sessao → 401 e a sessão não reaparece', { tag: '@CIT-70' }, async (t) => {
  const id = await entrar();
  let executou = false;
  relogio.gancho = async () => {
    relogio.gancho = null;
    executou = true;
    assert.equal((await sair(id)).statusCode, 204);
  };
  t.after(() => { relogio.gancho = null; });

  const resposta = await consultar(id);

  assert.ok(executou, 'gancho executado');
  assert.equal(resposta.statusCode, 401);
  assert.equal(await ctx.redis.exists(chave(id)), 0);
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(id)), 0);
});

test('CA7: TTL de 30 min após o login; +10 min renova; +31 min sem uso → 401 e chave apagada', { tag: '@CIT-70' }, async (t) => {
  const inicio = Date.now();
  relogio.agora = inicio;
  t.after(() => { relogio.agora = Date.now(); });
  const id = await entrar();

  const pttl = await ctx.redis.pttl(chave(id));
  assert.ok(pttl > 1790000 && pttl <= 1800000, `PTTL ${pttl}`);

  // Simula o tempo no Redis encurtando o TTL, e avança o relógio da API.
  await ctx.redis.pexpire(chave(id), INATIVIDADE_MS - 10 * MIN);
  relogio.agora = inicio + 10 * MIN;
  assert.equal((await consultar(id)).statusCode, 200);
  const renovado = await ctx.redis.pttl(chave(id));
  assert.ok(renovado > 1790000 && renovado <= 1800000, `PTTL renovado ${renovado}`);
  assert.equal(JSON.parse(await ctx.redis.get(chave(id))).ultimoAcesso, inicio + 10 * MIN);

  relogio.agora = inicio + 10 * MIN + 31 * MIN;
  assert.equal(await ctx.redis.exists(chave(id)), 1, 'chave ainda no Redis');
  assert.equal((await consultar(id)).statusCode, 401);
  assert.equal(await ctx.redis.exists(chave(id)), 0);
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(id)), 0);
});

test('CA7: prazo absoluto de 8 h: a 7 h 50 min o TTL cai para ≤ 600 s; com 8 h → 401 e chave apagada', { tag: '@CIT-70' }, async (t) => {
  const agora = Date.now();
  relogio.agora = agora;
  t.after(() => { relogio.agora = Date.now(); });
  const id = await entrar();

  await reescrever(id, { criadoEm: agora - (7 * 60 + 50) * MIN, ultimoAcesso: agora - MIN });
  assert.equal((await consultar(id)).statusCode, 200);
  const pttl = await ctx.redis.pttl(chave(id));
  assert.ok(pttl > 0 && pttl <= 600000, `PTTL ${pttl}`);

  await reescrever(id, { criadoEm: agora - ABSOLUTO_MS, ultimoAcesso: agora });
  assert.equal((await consultar(id)).statusCode, 401);
  assert.equal(await ctx.redis.exists(chave(id)), 0);
});

test('CA7: ids novos a cada login; login com cookie anterior apaga a sessão anterior; conjunto só com hashes e PTTL ≤ 8 h', { tag: '@CIT-70' }, async () => {
  const primeiro = await entrar();
  const segundo = await entrar();
  assert.notEqual(primeiro, segundo);
  assert.equal(await ctx.redis.exists(chave(primeiro)), 1);

  const terceiro = await entrar(segundo);
  assert.equal(await ctx.redis.exists(chave(segundo)), 0, 'sessão anterior apagada');
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(segundo)), 0);
  assert.equal(await ctx.redis.exists(chave(terceiro)), 1);

  const membros = await ctx.redis.smembers(conjunto());
  assert.ok(membros.length > 0);
  for (const membro of membros) assert.match(membro, /^[0-9a-f]{64}$/);
  for (const id of [primeiro, segundo, terceiro]) assert.ok(!membros.includes(id), 'sem id cru');
  const pttl = await ctx.redis.pttl(conjunto());
  assert.ok(pttl > 0 && pttl <= ABSOLUTO_MS, `PTTL do conjunto ${pttl}`);

  // Membro cuja chave venceu sai no login seguinte.
  await ctx.redis.del(chave(primeiro));
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(primeiro)), 1);
  await entrar();
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(primeiro)), 0);
});

test('CA7: conta passada para suspensa → próximo GET /sessao 401 e sessão apagada', { tag: '@CIT-70' }, async (t) => {
  const id = await entrar();
  assert.equal((await consultar(id)).statusCode, 200);
  await teste.pool.query("UPDATE conta_titular SET estado = 'suspensa' WHERE id = $1", [conta.contaId]);
  t.after(() => teste.pool.query("UPDATE conta_titular SET estado = 'ativa' WHERE id = $1", [conta.contaId]));

  const resposta = await consultar(id);
  assert.equal(resposta.statusCode, 401);
  assert.equal(resposta.body, '{"erro":"sem_sessao"}');
  assert.equal(await ctx.redis.exists(chave(id)), 0);
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(id)), 0);
});

test('CA7: cookie fora do formato ou ausente → 401 sem tocar o Redis', { tag: '@CIT-70' }, async (t) => {
  const comandos = t.mock.method(ctx.redis, 'sendCommand');
  for (const valor of ['curto', 'x'.repeat(44), 'a'.repeat(42) + '!']) {
    assert.equal((await consultar(valor)).statusCode, 401);
  }
  const semCookie = await teste.app.inject({ method: 'GET', url: '/api/painel/sessao' });
  assert.equal(semCookie.statusCode, 401);
  assert.equal(comandos.mock.callCount(), 0);
});

test('CA2/CA7: erro de comando no MULTI do conjunto (par [erro] do exec) apaga a chave recém-gravada e o login dá 401', { tag: '@CIT-70' }, async (t) => {
  const chavesDeSessao = async () => (await ctx.redis.keys(`${ctx.prefixo}:sessao:*`)).sort();
  const antes = await chavesDeSessao();
  // O exec() do ioredis não lança erro de comando: devolve o par `[erro, resultado]`.
  const loteComErro = {
    sadd() { return this; },
    pexpire() { return this; },
    exec: async () => [[Object.assign(new Error('falha injetada'), { code: 'FALHA_INJETADA' }), null], [null, 1]],
  };
  t.mock.method(ctx.redis, 'multi', () => loteComErro, { times: 1 });

  const resposta = await teste.app.inject({
    method: 'POST',
    url: '/api/painel/login',
    headers: { origin: ORIGEM_PAINEL },
    payload: { email: EMAIL, senha: SENHA },
  });

  assert.equal(resposta.statusCode, 401);
  assert.equal(resposta.headers['set-cookie'], undefined);
  assert.deepEqual(await chavesDeSessao(), antes, 'sem sessão órfã');
  assert.ok(teste.captura.linhas().some((l) => l.msg === 'falha ao gravar a sessão do painel' && l.codigo === 'FALHA_INJETADA'));
});

test('CA7: falha na limpeza do conjunto vai ao log e não derruba o login', { tag: '@CIT-70' }, async (t) => {
  t.mock.method(ctx.redis, 'smembers', async () => {
    throw Object.assign(new Error('falha injetada'), { code: 'FALHA_INJETADA' });
  }, { times: 1 });

  const id = await entrar();

  assert.equal(await ctx.redis.exists(chave(id)), 1);
  assert.equal(await ctx.redis.sismember(conjunto(), hashDoId(id)), 1);
  const linha = teste.captura.linhas().find((l) => l.msg === 'falha ao limpar as sessões vencidas da conta');
  assert.ok(linha);
  assert.equal(linha.level, 40);
});

test('CA7: falha do banco ao conferir a conta da sessão → 503 sessao_indisponivel', { tag: '@CIT-70' }, async (t) => {
  const id = await entrar();
  const original = teste.pool.query.bind(teste.pool);
  t.mock.method(teste.pool, 'query', async (sql, ...resto) => {
    if (typeof sql === 'string' && sql.includes('FROM conta_titular WHERE id')) throw new Error('banco fora');
    return original(sql, ...resto);
  });

  const resposta = await consultar(id);

  assert.equal(resposta.statusCode, 503);
  assert.equal(resposta.body, '{"erro":"sessao_indisponivel"}');
  assert.equal(resposta.headers['cache-control'], 'no-store');
  assert.equal(await ctx.redis.exists(chave(id)), 1, 'sessão intacta');
});
