// CIT-70: POST /api/painel/login (CA1, CA2, CA3, CA6, CA8 e CA9 de rota). Postgres e Redis
// de teste; conta e senha fictícias semeadas direto no banco.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { construirAppTeste, criarSessoesTeste, semearContaPainel } from './auxiliares.js';
import { HASH_FALSO, verificarSenha } from '../src/painel/senha.js';
import { registrarAuditoria } from '../src/auditoria/servico.js';
import { hashDoId } from '../src/painel/sessoes.js';

const ORIGEM_PAINEL = 'http://localhost:4200';
const ORIGEM_SO_CORS = 'http://127.0.0.1:4200';
const EMAIL = 'titular@exemplo.com.br';
const SENHA = 'Senha-de-teste-123';
const HASH_ARGON2ID = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/;
const COOKIE = /^__Host-citmail_sessao=([A-Za-z0-9_-]{43}); /;

const configPainel = {
  corsOrigens: [ORIGEM_SO_CORS, ORIGEM_PAINEL],
  painelOrigens: [ORIGEM_PAINEL],
};

// Espiões e falhas injetadas, ligados por teste.
const estado = { verificacoes: 0, falharGravacao: false, falharAuditoria: false };
let ctx;
let teste;

before(async () => {
  ctx = criarSessoesTeste();
  await ctx.pronta();
  const sessoes = {
    ...ctx.sessoes,
    async criar(dados) {
      if (estado.falharGravacao) throw Object.assign(new Error('falha injetada'), { code: 'FALHA_INJETADA' });
      return ctx.sessoes.criar(dados);
    },
  };
  teste = await construirAppTeste({
    sobrescritasConfig: configPainel,
    painel: {
      sessoes,
      hash: {
        verificar(hash, senha) {
          estado.verificacoes++;
          return verificarSenha(hash, senha);
        },
      },
      auditoria(dados) {
        if (estado.falharAuditoria) throw new Error('auditoria fora');
        return registrarAuditoria(teste.pool, dados);
      },
    },
  });
  await semearContaPainel(teste.pool, { email: EMAIL, senha: SENHA });
  await semearContaPainel(teste.pool, { email: 'semsenha@exemplo.com.br' , estado: 'sem_senha' });
  await semearContaPainel(teste.pool, { email: 'suspensa@exemplo.com.br', senha: SENHA, estado: 'suspensa' });
  await semearContaPainel(teste.pool, { email: 'cancelada@exemplo.com.br', senha: SENHA, estado: 'cancelada' });
});

after(async () => {
  await teste?.fechar();
  await ctx?.fechar();
});

function login(corpo, headers = { origin: ORIGEM_PAINEL }) {
  return teste.app.inject({ method: 'POST', url: '/api/painel/login', headers, payload: corpo });
}

function cabecalhosDo401(resposta) {
  return {
    status: resposta.statusCode,
    corpo: resposta.body,
    'content-type': resposta.headers['content-type'],
    'cache-control': resposta.headers['cache-control'],
    'content-length': resposta.headers['content-length'],
    'set-cookie': resposta.headers['set-cookie'],
  };
}

const ESPERADO_401 = {
  status: 401,
  corpo: '{"erro":"credenciais_invalidas"}',
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'content-length': '32',
  'set-cookie': undefined,
};

test('CA1: login válido → 204 com cookie __Host- de sessão e CORS com credenciais; GET /sessao → 200 com o e-mail', { tag: '@CIT-70' }, async () => {
  const resposta = await login({ email: EMAIL, senha: SENHA });

  assert.equal(resposta.statusCode, 204);
  assert.equal(resposta.headers['cache-control'], 'no-store');
  assert.equal(resposta.headers['access-control-allow-credentials'], 'true');
  assert.equal(resposta.headers['access-control-allow-origin'], ORIGEM_PAINEL);
  const setCookie = resposta.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string', 'um único Set-Cookie');
  assert.match(setCookie, COOKIE);
  const atributos = setCookie.split('; ').slice(1).sort();
  assert.deepEqual(atributos, ['HttpOnly', 'Path=/', 'SameSite=Lax', 'Secure']);
  assert.doesNotMatch(setCookie, /Domain|Max-Age|Expires/i);

  const id = COOKIE.exec(setCookie)[1];
  const sessao = await teste.app.inject({ method: 'GET', url: '/api/painel/sessao', cookies: { '__Host-citmail_sessao': id } });
  assert.equal(sessao.statusCode, 200);
  assert.deepEqual(sessao.json(), { email: EMAIL });
  assert.equal(sessao.headers['cache-control'], 'no-store');
});

test('CA2/CA3: inexistente, senha errada, sem_senha, suspensa e cancelada → o mesmo 401, sem cookie, 1 verificação Argon2 cada', { tag: '@CIT-70' }, async (t) => {
  const casos = [
    ['e-mail inexistente', { email: 'ninguem@exemplo.com.br', senha: SENHA }],
    ['senha errada', { email: EMAIL, senha: 'senha-errada' }],
    ['conta sem_senha', { email: 'semsenha@exemplo.com.br', senha: SENHA }],
    ['conta suspensa', { email: 'suspensa@exemplo.com.br', senha: SENHA }],
    ['conta cancelada', { email: 'cancelada@exemplo.com.br', senha: SENHA }],
  ];
  for (const [nome, corpo] of casos) {
    estado.verificacoes = 0;
    const inicio = process.hrtime.bigint();
    const resposta = await login(corpo);
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    t.diagnostic(`${nome}: ${ms.toFixed(1)} ms`);
    assert.deepEqual(cabecalhosDo401(resposta), ESPERADO_401, nome);
    assert.equal(estado.verificacoes, 1, `${nome}: uma verificação`);
  }
});

test('CA2: e-mail com espaços e maiúsculas e a senha certa entra', { tag: '@CIT-70' }, async () => {
  const resposta = await login({ email: '  Titular@Exemplo.com.br ', senha: SENHA });
  assert.equal(resposta.statusCode, 204);
  assert.match(resposta.headers['set-cookie'], COOKIE);
});

test('CA2: falha na gravação da sessão depois do Argon2 → o mesmo 401 e log de erro com o requestId', { tag: '@CIT-70' }, async (t) => {
  estado.falharGravacao = true;
  t.after(() => { estado.falharGravacao = false; });

  const resposta = await login({ email: EMAIL, senha: SENHA });

  assert.deepEqual(cabecalhosDo401(resposta), ESPERADO_401);
  const requestId = resposta.headers['x-request-id'];
  const linha = teste.captura.linhas().find((l) => l.msg === 'falha ao gravar a sessão do painel' && l.reqId === requestId);
  assert.ok(linha, 'log de erro da gravação com o requestId');
  assert.equal(linha.level, 50);
  assert.equal(linha.codigo, 'FALHA_INJETADA');
});

test('CA3: hash semeado e hash falso são Argon2id m=19456,t=2,p=1; o banco não guarda a senha', { tag: '@CIT-70' }, async () => {
  assert.match(HASH_FALSO, HASH_ARGON2ID);
  const { rows } = await teste.pool.query(
    'SELECT senha_hash, row_to_json(conta_titular)::text AS linha FROM conta_titular WHERE email = $1',
    [EMAIL],
  );
  assert.match(rows[0].senha_hash, HASH_ARGON2ID);
  assert.ok(!rows[0].linha.includes(SENHA));
});

test('CA3: o log do login (sucesso e falha) não tem senha, e-mail, valor do cookie nem set-cookie', { tag: '@CIT-70' }, async () => {
  const sucesso = await login({ email: EMAIL, senha: SENHA });
  await login({ email: EMAIL, senha: 'senha-errada' });
  const id = COOKIE.exec(sucesso.headers['set-cookie'])[1];

  const texto = teste.captura.texto();
  for (const proibido of [SENHA, 'senha-errada', EMAIL, id, hashDoId(id)]) {
    assert.ok(!texto.includes(proibido), `log sem ${proibido.slice(0, 6)}...`);
  }
  assert.doesNotMatch(texto, /set-cookie/i);
});

test('CA6: login e logout sem Origin, com origem estranha ou só de CORS_ORIGENS → 403 sem tocar o banco nem o Redis', { tag: '@CIT-70' }, async (t) => {
  const consultas = t.mock.method(teste.pool, 'query');
  const prontos = t.mock.method(ctx.redis, 'sendCommand');
  const origens = [{}, { origin: 'https://estranha.example' }, { origin: ORIGEM_SO_CORS }];
  for (const url of ['/api/painel/login', '/api/painel/logout']) {
    for (const headers of origens) {
      const payload = url.endsWith('login') ? { email: EMAIL, senha: SENHA } : {};
      const resposta = await teste.app.inject({ method: 'POST', url, headers, payload });
      assert.equal(resposta.statusCode, 403, `${url} ${JSON.stringify(headers)}`);
      assert.equal(resposta.body, '{"erro":"origem_recusada"}');
      assert.equal(resposta.headers['cache-control'], 'no-store');
      assert.equal(resposta.headers['set-cookie'], undefined);
    }
  }
  assert.equal(consultas.mock.callCount(), 0, 'sem consulta ao banco');
  assert.equal(prontos.mock.callCount(), 0, 'sem comando ao Redis');
});

test('CA6: GET /api/painel/login → 404; 400 do schema com no-store', { tag: '@CIT-70' }, async () => {
  const get = await teste.app.inject({ method: 'GET', url: '/api/painel/login' });
  assert.equal(get.statusCode, 404);

  for (const payload of [{ email: EMAIL }, { email: EMAIL, senha: '' }, { email: EMAIL, senha: SENHA, extra: 1 }, { email: 'a', senha: SENHA }]) {
    const resposta = await login(payload);
    assert.equal(resposta.statusCode, 400, JSON.stringify(Object.keys(payload)));
    assert.equal(resposta.headers['cache-control'], 'no-store');
  }
  const logout = await teste.app.inject({
    method: 'POST', url: '/api/painel/logout', headers: { origin: ORIGEM_PAINEL }, payload: { x: 1 },
  });
  assert.equal(logout.statusCode, 400);
  assert.equal(logout.headers['cache-control'], 'no-store');
});

test('CA6: CORS com credenciais só no painel e só para PAINEL_ORIGENS; rotas públicas sem allow-credentials', { tag: '@CIT-70' }, async () => {
  const preflight = (url, origin) => teste.app.inject({
    method: 'OPTIONS',
    url,
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });

  const painel = await preflight('/api/painel/login', ORIGEM_PAINEL);
  assert.equal(painel.headers['access-control-allow-origin'], ORIGEM_PAINEL);
  assert.equal(painel.headers['access-control-allow-credentials'], 'true');

  const soCors = await preflight('/api/painel/login', ORIGEM_SO_CORS);
  assert.equal(soCors.headers['access-control-allow-origin'], undefined);
  assert.equal(soCors.headers['access-control-allow-credentials'], undefined);

  for (const url of ['/api/orcamento', '/api/pedidos']) {
    for (const origin of [ORIGEM_PAINEL, ORIGEM_SO_CORS]) {
      const publica = await preflight(url, origin);
      assert.equal(publica.headers['access-control-allow-origin'], origin, url);
      assert.equal(publica.headers['access-control-allow-credentials'], undefined, url);
    }
  }
});

test('CA8: auditoria do sucesso e das falhas (ids nulos, ip e request_id, sem e-mail); falha da auditoria não muda o status', { tag: '@CIT-70' }, async (t) => {
  const { rows: [{ ultimo }] } = await teste.pool.query('SELECT coalesce(max(id), 0) AS ultimo FROM auditoria');
  const sucesso = await login({ email: EMAIL, senha: SENHA });
  const inexistente = await login({ email: 'ninguem@exemplo.com.br', senha: SENHA });
  const errada = await login({ email: EMAIL, senha: 'senha-errada' });

  const { rows: contas } = await teste.pool.query('SELECT id, cliente_id FROM conta_titular WHERE email = $1', [EMAIL]);
  const { rows } = await teste.pool.query(
    'SELECT acao, resultado, autor_tipo, autor_id, alvo_tipo, alvo_id, host(ip) AS ip, request_id, detalhes::text AS detalhes FROM auditoria WHERE id > $1 ORDER BY id',
    [ultimo],
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    acao: 'login', resultado: 'sucesso', autor_tipo: 'cliente', autor_id: contas[0].cliente_id,
    alvo_tipo: 'conta', alvo_id: contas[0].id, ip: '127.0.0.1', request_id: sucesso.headers['x-request-id'], detalhes: '{}',
  });
  for (const [linha, resposta] of [[rows[1], inexistente], [rows[2], errada]]) {
    assert.deepEqual(linha, {
      acao: 'login_falhou', resultado: 'falha', autor_tipo: 'cliente', autor_id: null,
      alvo_tipo: 'conta', alvo_id: null, ip: '127.0.0.1', request_id: resposta.headers['x-request-id'],
      detalhes: '{"motivo": "credenciais"}',
    });
    assert.ok(!linha.detalhes.includes('@'));
  }

  estado.falharAuditoria = true;
  t.after(() => { estado.falharAuditoria = false; });
  assert.equal((await login({ email: EMAIL, senha: SENHA })).statusCode, 204);
  assert.deepEqual(cabecalhosDo401(await login({ email: EMAIL, senha: 'senha-errada' })), ESPERADO_401);
  assert.ok(teste.captura.linhas().some((l) => l.msg === 'falha ao gravar a auditoria do login'));
});

test('CA9: PAINEL_HABILITADO=false → as três rotas 404', { tag: '@CIT-70' }, async (t) => {
  const desligado = await construirAppTeste({ comBanco: false, sobrescritasConfig: { ...configPainel, painelHabilitado: false } });
  t.after(desligado.fechar);
  for (const [method, url] of [['POST', '/api/painel/login'], ['POST', '/api/painel/logout'], ['GET', '/api/painel/sessao']]) {
    const resposta = await desligado.app.inject({ method, url, headers: { origin: ORIGEM_PAINEL }, payload: method === 'POST' ? {} : undefined });
    assert.equal(resposta.statusCode, 404, url);
  }
});

// Logout fica fora: responde 204 sempre (abaixo).
const ROTAS = [
  ['POST', '/api/painel/login', { email: EMAIL, senha: SENHA }],
  ['GET', '/api/painel/sessao', undefined],
];

async function conferirLogout204(app) {
  const resposta = await app.inject({ method: 'POST', url: '/api/painel/logout', headers: { origin: ORIGEM_PAINEL }, payload: {} });
  assert.equal(resposta.statusCode, 204);
  assert.match(resposta.headers['set-cookie'], /^__Host-citmail_sessao=; .*Max-Age=0/);
  assert.equal(resposta.headers['cache-control'], 'no-store');
}

test('CA9: ligada sem REDIS_URL fora de produção → login e sessão 503 sessao_indisponivel com no-store; logout 204', { tag: '@CIT-70' }, async (t) => {
  const semRedis = await construirAppTeste({ comBanco: false, sobrescritasConfig: configPainel });
  t.after(semRedis.fechar);
  for (const [method, url, payload] of ROTAS) {
    const resposta = await semRedis.app.inject({ method, url, headers: { origin: ORIGEM_PAINEL }, payload });
    assert.equal(resposta.statusCode, 503, url);
    assert.equal(resposta.body, '{"erro":"sessao_indisponivel"}');
    assert.equal(resposta.headers['cache-control'], 'no-store');
  }
  await conferirLogout204(semRedis.app);
});

test('CA9: Redis fora do ar → 503 em até 3 s no login e na sessão (logout 204), sem banco nem Argon2', { tag: '@CIT-70' }, async (t) => {
  const fora = criarSessoesTeste({ url: 'redis://127.0.0.1:1' });
  let consultas = 0;
  let verificacoes = 0;
  const app = await construirAppTeste({
    comBanco: false,
    pool: { query: async () => { consultas++; throw new Error('sem banco'); } },
    sobrescritasConfig: configPainel,
    painel: { sessoes: fora.sessoes, hash: { verificar: async () => { verificacoes++; return false; } } },
  });
  t.after(async () => {
    await app.fechar();
    await fora.fechar();
  });
  for (const [method, url, payload] of ROTAS) {
    const inicio = Date.now();
    const resposta = await app.app.inject({ method, url, headers: { origin: ORIGEM_PAINEL }, payload });
    assert.equal(resposta.statusCode, 503, url);
    assert.equal(resposta.body, '{"erro":"sessao_indisponivel"}');
    assert.ok(Date.now() - inicio < 3000, `${url} em até 3 s`);
  }
  const inicio = Date.now();
  await conferirLogout204(app.app);
  assert.ok(Date.now() - inicio < 3000, 'logout em até 3 s');
  assert.equal(consultas, 0);
  assert.equal(verificacoes, 0);
});

test('CA2: hash malformado no banco → o mesmo 401, sem 500', { tag: '@CIT-70' }, async (t) => {
  await teste.pool.query("UPDATE conta_titular SET senha_hash = 'nao-e-um-hash' WHERE email = $1", ['suspensa@exemplo.com.br']);
  await teste.pool.query("UPDATE conta_titular SET estado = 'ativa' WHERE email = $1", ['suspensa@exemplo.com.br']);
  t.after(() => teste.pool.query("UPDATE conta_titular SET estado = 'suspensa' WHERE email = $1", ['suspensa@exemplo.com.br']));
  assert.deepEqual(cabecalhosDo401(await login({ email: 'suspensa@exemplo.com.br', senha: SENHA })), ESPERADO_401);
});
