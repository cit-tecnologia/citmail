// CIT-69: token de acompanhamento e POST /api/pedidos/status (ADR 0016). Contra um banco
// temporário migrado e o stub HTTP local do Asaas (`stub-asaas.js`); nenhuma rede externa.
// Um app e um banco por arquivo; cada cenário cria o próprio pedido (CPF e chave únicos).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { construirApp } from '../src/app.js';
import { criarClienteAsaas } from '../src/asaas/cliente.js';
import { calcularOrcamento } from '../src/precos/servico.js';
import { VERSAO } from '../src/precos/tabela.js';
import { tipoPessoa } from '../src/pedidos/documento.js';
import { VERSAO_PRIVACIDADE, VERSAO_TERMOS } from '../src/pedidos/aceite.js';
import { construirAppTeste, criarCapturaDeLog, criarConfigTeste } from './auxiliares.js';
import { criarStubAsaas } from './stub-asaas.js';

const CHAVE_API = 'CHAVE-FICTICIA-ASAAS';
const PADRAO_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FATURA_CONTAS = 'https://sandbox.asaas.com/i/abc';
const FATURA_DOMINIO = 'https://www.asaas.com/i/def';
const CHAVES_DA_LISTA_BRANCA = ['etapa', 'dominioNovo', 'faturaContasUrl', 'faturaDominioUrl'];

let stub;
let ambiente;
const appsExtras = [];
const tokensVistos = new Set();

before(async () => {
  stub = await criarStubAsaas();
  ambiente = await construirAppTeste({
    asaas: criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: CHAVE_API, timeoutMs: 1000 }),
    sobrescritasConfig: { asaasTimeoutMs: 1000 },
  });
});

after(async () => {
  for (const app of appsExtras) await app.close();
  await ambiente.fechar();
  await stub.fechar();
});

beforeEach(() => stub.limpar());

// O token em claro (e o hash) nunca vai ao log, em nenhum cenário (CA3).
afterEach(() => {
  const texto = ambiente.captura.texto();
  for (const token of tokensVistos) {
    assert.ok(!texto.includes(token), 'o log não pode conter o token');
    assert.ok(!texto.includes(hashDe(token)), 'o log não pode conter o hash do token');
  }
});

const hashDe = (token) => createHash('sha256').update(token).digest('hex');

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

let sequenciaCpf = 0;

function cpfUnico() {
  sequenciaCpf += 1;
  const digitos = [...String(223456000 + sequenciaCpf * 17)].map(Number);
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += digitos[i] * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    digitos.push(resto === 10 ? 0 : resto);
  }
  const cpf = digitos.join('');
  assert.equal(tipoPessoa(cpf), 'fisica', 'o gerador de CPF do teste precisa produzir CPF válido');
  return cpf;
}

function montarCorpo(sobre = {}) {
  const corpo = {
    chave_idempotencia: randomUUID(),
    versao_tabela: VERSAO,
    ciclo: 'mensal',
    contas: { '5gb': 5, '50gb': 1 },
    addons: {},
    dominio: { tipo: 'existente', nome: 'exemplo-ficticio.com' },
    cliente: { nome: 'Fulana de Teste', email: 'fulana@exemplo.test', telefone: '11999990000', documento: cpfUnico() },
    aceite: { termos: true, versao_termos: VERSAO_TERMOS, versao_privacidade: VERSAO_PRIVACIDADE },
    ...sobre,
  };
  if (corpo.total_exibido_centavos === undefined) {
    const { ciclo, contas, addons, dominio } = corpo;
    const { totais } = calcularOrcamento({ ciclo, contas, addons, dominio });
    corpo.total_exibido_centavos = totais.recorrente_ciclo_centavos + totais.avulso_centavos;
  }
  return corpo;
}

// Domínio novo com 1 extra: duas assinaturas (contas e domínios).
const corpoComDominios = () => montarCorpo({
  addons: { talk: 2, extraDom: 1 },
  dominio: { tipo: 'novo', nome: 'exemplo-ficticio' },
  dominios_extras: ['outro-ficticio.com.br'],
});

async function enviar(corpo, app = ambiente.app) {
  const resposta = await app.inject({ method: 'POST', url: '/api/pedidos', payload: corpo });
  const json = resposta.json();
  if (typeof json?.token === 'string') tokensVistos.add(json.token);
  return { status: resposta.statusCode, corpo: json };
}

// Cria um pedido de verdade (201) e devolve o corpo, o token e o id.
async function criarPedido(corpo = montarCorpo()) {
  stub.definir('GET /subscriptions/{id}/payments', { corpo: { data: [{ invoiceUrl: 'https://stub.test/f/1' }] } });
  const resposta = await enviar(corpo);
  assert.equal(resposta.status, 201);
  return { corpo, token: resposta.corpo.token, pedidoId: resposta.corpo.pedidoId, resposta };
}

function consultar(token, app = ambiente.app) {
  return app.inject({ method: 'POST', url: '/api/pedidos/status', payload: { token } });
}

const definirEstado = (pedidoId, estado) => ambiente.pool.query(
  `UPDATE pedido SET estado = $2,
          criando_desde = CASE WHEN $2 = 'criando' THEN now() END,
          falha_motivo = CASE WHEN $2 = 'falhou_na_criacao' THEN 'asaas_timeout' END
    WHERE id = $1`,
  [pedidoId, estado],
);

const definirUrl = (pedidoId, tipo, url) => ambiente.pool.query(
  'UPDATE assinatura SET url_primeira_fatura = $3 WHERE pedido_id = $1 AND tipo = $2',
  [pedidoId, tipo, url],
);

function appExtra(configExtra = {}, opcoes = {}) {
  const captura = criarCapturaDeLog();
  const app = construirApp(criarConfigTeste(configExtra), { pool: ambiente.pool, logStream: captura.stream, ...opcoes });
  appsExtras.push(app);
  return { app, captura };
}

// ---------------------------------------------------------------------------
// CA1: token gerado e só o hash no banco
// ---------------------------------------------------------------------------

test('CA1: o 201 de POST /api/pedidos traz token de 43 caracteres base64url', async () => {
  const { token } = await criarPedido();

  assert.match(token, PADRAO_TOKEN);
});

test('CA1: pedido.token_hash guarda o SHA-256 em hex do token', async () => {
  const { token, pedidoId } = await criarPedido();

  const { rows } = await ambiente.pool.query('SELECT token_hash FROM pedido WHERE id = $1', [pedidoId]);

  assert.equal(rows[0].token_hash, hashDe(token));
});

test('CA1: nenhuma coluna do pedido contém o token em claro', async () => {
  const { token, pedidoId } = await criarPedido();

  const { rows } = await ambiente.pool.query('SELECT row_to_json(p)::text AS linha FROM pedido p WHERE id = $1', [pedidoId]);

  assert.ok(!rows[0].linha.includes(token));
});

test('CA1: dois pedidos recebem tokens diferentes', async () => {
  const primeiro = await criarPedido();
  const segundo = await criarPedido();

  assert.notEqual(primeiro.token, segundo.token);
});

test('CA1: 400 de corpo inválido não traz token', async () => {
  const resposta = await enviar({ ...montarCorpo(), campo_extra: 'x' });

  assert.equal(resposta.status, 400);
  assert.ok(!('token' in resposta.corpo));
});

test('CA1: 409 de total divergente não traz token', async () => {
  const resposta = await enviar(montarCorpo({ total_exibido_centavos: 1 }));

  assert.equal(resposta.status, 409);
  assert.ok(!('token' in resposta.corpo));
});

test('CA1: 422 de chave reutilizada com outro corpo não traz token', async () => {
  const { corpo } = await criarPedido();

  const outro = montarCorpo({ chave_idempotencia: corpo.chave_idempotencia, contas: { '5gb': 6, '50gb': 1 } });

  const resposta = await enviar(outro);

  assert.equal(resposta.status, 422);
  assert.ok(!('token' in resposta.corpo));
});

test('CA1: 502 e 504 do Asaas não trazem token e não gravam hash', async () => {
  for (const [comportamento, esperado] of [[{ status: 500 }, 502], [{ semResposta: true }, 504]]) {
    stub.definir('POST /customers', comportamento);
    const corpo = montarCorpo();

    const resposta = await enviar(corpo);

    assert.equal(resposta.status, esperado);
    assert.ok(!('token' in resposta.corpo));
    const { rows } = await ambiente.pool.query('SELECT token_hash FROM pedido WHERE chave_idempotencia = $1', [corpo.chave_idempotencia]);
    assert.equal(rows[0].token_hash, null);
    stub.limpar();
  }
});

test('CA1: 503 sem adaptador do Asaas não traz token', async () => {
  const { app } = appExtra();

  const resposta = await enviar(montarCorpo(), app);

  assert.equal(resposta.status, 503);
  assert.ok(!('token' in resposta.corpo));
});

// ---------------------------------------------------------------------------
// CA2: rotação na repetição
// ---------------------------------------------------------------------------

test('CA2: repetir a mesma chave e o mesmo corpo devolve 201 com token diferente', async () => {
  const { corpo, token } = await criarPedido();

  const repeticao = await enviar(corpo);

  assert.equal(repeticao.status, 201);
  assert.match(repeticao.corpo.token, PADRAO_TOKEN);
  assert.notEqual(repeticao.corpo.token, token);
});

test('CA2: depois da repetição o 1º token responde 404', async () => {
  const { corpo, token } = await criarPedido();
  await enviar(corpo);

  const resposta = await consultar(token);

  assert.equal(resposta.statusCode, 404);
});

test('CA2: depois da repetição o 2º token responde 200', async () => {
  const { corpo } = await criarPedido();
  const repeticao = await enviar(corpo);

  const resposta = await consultar(repeticao.corpo.token);

  assert.equal(resposta.statusCode, 200);
});

test('CA2: o hash gravado depois da repetição é o do 2º token', async () => {
  const { corpo, pedidoId } = await criarPedido();
  const repeticao = await enviar(corpo);

  const { rows } = await ambiente.pool.query('SELECT token_hash FROM pedido WHERE id = $1', [pedidoId]);

  assert.equal(rows[0].token_hash, hashDe(repeticao.corpo.token));
});

test('CA2: pedido antigo com token_hash nulo não responde a nenhum token', async () => {
  const { token, pedidoId } = await criarPedido();
  await ambiente.pool.query('UPDATE pedido SET token_hash = NULL WHERE id = $1', [pedidoId]);

  const resposta = await consultar(token);

  assert.equal(resposta.statusCode, 404);
});

// ---------------------------------------------------------------------------
// CA3: consulta e lista branca
// ---------------------------------------------------------------------------

test('CA3: token válido responde 200 com chaves só da lista branca', async () => {
  const { token } = await criarPedido();

  const resposta = await consultar(token);

  assert.equal(resposta.statusCode, 200);
  for (const chave of Object.keys(resposta.json())) {
    assert.ok(CHAVES_DA_LISTA_BRANCA.includes(chave), `chave fora da lista branca: ${chave}`);
  }
});

test('CA3: a resposta 200 não expõe dados do pedido nem do comprador', async () => {
  const { token, pedidoId, corpo } = await criarPedido();

  const texto = (await consultar(token)).body;

  for (const proibido of [pedidoId, corpo.cliente.nome, corpo.cliente.email, corpo.cliente.documento, corpo.cliente.telefone, 'exemplo-ficticio']) {
    assert.ok(!texto.includes(proibido), `a resposta não pode conter ${proibido}`);
  }
});

test('CA3: 200 e 404 levam Cache-Control no-store e Referrer-Policy no-referrer', async () => {
  const { token } = await criarPedido();

  for (const resposta of [await consultar(token), await consultar('A'.repeat(43))]) {
    assert.equal(resposta.headers['cache-control'], 'no-store');
    assert.equal(resposta.headers['referrer-policy'], 'no-referrer');
  }
});

const ETAPAS_POR_ESTADO = [
  ['criando', 'aguardando_confirmacao'],
  ['aguardando_pagamento', 'aguardando_confirmacao'],
  ['aguardando_pagamento_do_dominio', 'dominio_pendente'],
  ['aguardando_registro_de_dominio', 'registro_dominio'],
  ['pago', 'ativando'],
  ['falha_no_provisionamento', 'ativando'],
  ['ativo', 'ativo'],
  ['falhou_na_criacao', 'erro_criacao'],
  ['cancelado', 'cancelado'],
];

for (const [estado, etapa] of ETAPAS_POR_ESTADO) {
  test(`CA3: o estado ${estado} aparece como a etapa ${etapa}, nunca com o estado cru`, async () => {
    const { token, pedidoId } = await criarPedido();
    await definirEstado(pedidoId, estado);

    const resposta = await consultar(token);

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().etapa, etapa);
    assert.ok(!('estado' in resposta.json()));
  });
}

test('CA3: dominioNovo é true com domínio novo e false com domínio existente', async () => {
  const existente = await criarPedido();
  const novo = await criarPedido(corpoComDominios());

  assert.equal((await consultar(existente.token)).json().dominioNovo, false);
  assert.equal((await consultar(novo.token)).json().dominioNovo, true);
});

test('CA3: o token não aparece no log da requisição de consulta', async () => {
  const { token } = await criarPedido();
  const { app, captura } = appExtra();

  await consultar(token, app);
  await consultar('B'.repeat(43), app);

  const texto = captura.texto();
  assert.ok(texto.length > 0, 'a requisição precisa ter sido logada');
  assert.ok(!texto.includes(token));
  assert.ok(!texto.includes('B'.repeat(43)));
});

// ---------------------------------------------------------------------------
// CA4: identificador de outra pessoa
// ---------------------------------------------------------------------------

function impressao(resposta) {
  const { statusCode, body, headers } = resposta;
  return {
    statusCode,
    body,
    contentType: headers['content-type'],
    cacheControl: headers['cache-control'],
    referrerPolicy: headers['referrer-policy'],
    contentLength: headers['content-length'],
  };
}

test('CA4: token inexistente, mal formado ou de outro tamanho responde o mesmo 404', async () => {
  const { token } = await criarPedido();
  const casos = [
    'A'.repeat(43),
    'x',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(42)}+`,
    `${'A'.repeat(42)}/`,
    'A'.repeat(100),
    'A'.repeat(128),
    hashDe(token),
    '',
  ];

  const respostas = [];
  for (const caso of casos) respostas.push([caso, impressao(await consultar(caso))]);

  assert.equal(respostas[0][1].statusCode, 404);
  assert.equal(respostas[0][1].body, JSON.stringify({ erro: 'nao_encontrado' }));
  for (const [caso, resposta] of respostas) {
    assert.deepEqual(resposta, respostas[0][1], `o 404 de ${JSON.stringify(caso.slice(0, 20))} difere do padrão`);
  }
});

test('CA4: o 404 de token válido de outro pedido não difere do 404 de token inexistente', async () => {
  const { token } = await criarPedido();
  await criarPedido();
  const alterado = `${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`;

  assert.deepEqual(impressao(await consultar(alterado)), impressao(await consultar('A'.repeat(43))));
});

for (const [rotulo, payload] of [
  ['sem token', {}],
  ['token nulo', { token: null }],
  ['token numérico', { token: 123 }],
  ['token em lista', { token: ['A'.repeat(43)] }],
  ['token com 129 caracteres', { token: 'A'.repeat(129) }],
  ['campo extra', { token: 'A'.repeat(43), extra: 1 }],
]) {
  test(`CA4: corpo ${rotulo} responde 400`, async () => {
    const resposta = await ambiente.app.inject({ method: 'POST', url: '/api/pedidos/status', payload });

    assert.equal(resposta.statusCode, 400);
  });
}

test('CA4: GET /api/pedidos/status?token=... responde 404 de rota, mesmo com token válido', async () => {
  const { token } = await criarPedido();

  const resposta = await ambiente.app.inject({ method: 'GET', url: `/api/pedidos/status?token=${token}` });

  assert.equal(resposta.statusCode, 404);
  assert.notEqual(resposta.headers['referrer-policy'], 'no-referrer', 'o 404 de rota não passa pelo handler da consulta');
});

test('CA4: com a flag de pedidos desligada a rota de status responde 404 de rota', async () => {
  const { app } = appExtra({ pedidosHabilitado: false });

  const resposta = await consultar('A'.repeat(43), app);

  assert.equal(resposta.statusCode, 404);
  assert.notEqual(resposta.headers['referrer-policy'], 'no-referrer', 'a rota nem é registrada');
});

test('CA4: sem adaptador do Asaas a consulta responde 200 ou 404, nunca 503', async () => {
  const { token } = await criarPedido();
  const { app } = appExtra();

  assert.equal((await consultar(token, app)).statusCode, 200);
  assert.equal((await consultar('A'.repeat(43), app)).statusCode, 404);
});

// ---------------------------------------------------------------------------
// CA5: URLs da fatura
// ---------------------------------------------------------------------------

test('CA5: aguardando_pagamento com URL do Asaas expõe faturaContasUrl igual', async () => {
  const { token, pedidoId } = await criarPedido();
  await definirUrl(pedidoId, 'contas', FATURA_CONTAS);

  const corpo = (await consultar(token)).json();

  assert.equal(corpo.faturaContasUrl, FATURA_CONTAS);
  assert.ok(!('faturaDominioUrl' in corpo));
});

test('CA5: aguardando_pagamento_do_dominio expõe só faturaDominioUrl', async () => {
  const { token, pedidoId } = await criarPedido(corpoComDominios());
  await definirUrl(pedidoId, 'contas', FATURA_CONTAS);
  await definirUrl(pedidoId, 'dominios', FATURA_DOMINIO);
  await definirEstado(pedidoId, 'aguardando_pagamento_do_dominio');

  const corpo = (await consultar(token)).json();

  assert.equal(corpo.faturaDominioUrl, FATURA_DOMINIO);
  assert.ok(!('faturaContasUrl' in corpo));
});

test('CA5: aguardando_pagamento com domínio novo em aberto expõe as duas URLs', async () => {
  const { token, pedidoId } = await criarPedido(corpoComDominios());
  await definirUrl(pedidoId, 'contas', FATURA_CONTAS);
  await definirUrl(pedidoId, 'dominios', FATURA_DOMINIO);

  const corpo = (await consultar(token)).json();

  assert.equal(corpo.faturaContasUrl, FATURA_CONTAS);
  assert.equal(corpo.faturaDominioUrl, FATURA_DOMINIO);
});

test('CA5: com dominio_pago_em preenchido só faturaContasUrl sai', async () => {
  const { token, pedidoId } = await criarPedido(corpoComDominios());
  await definirUrl(pedidoId, 'contas', FATURA_CONTAS);
  await definirUrl(pedidoId, 'dominios', FATURA_DOMINIO);
  await ambiente.pool.query('UPDATE pedido SET dominio_pago_em = now() WHERE id = $1', [pedidoId]);

  const corpo = (await consultar(token)).json();

  assert.equal(corpo.faturaContasUrl, FATURA_CONTAS);
  assert.ok(!('faturaDominioUrl' in corpo));
});

test('CA5: fatura_retida omite as duas URLs', async () => {
  const { token, pedidoId } = await criarPedido(corpoComDominios());
  await definirUrl(pedidoId, 'contas', FATURA_CONTAS);
  await definirUrl(pedidoId, 'dominios', FATURA_DOMINIO);
  await ambiente.pool.query('UPDATE pedido SET fatura_retida = true WHERE id = $1', [pedidoId]);

  const corpo = (await consultar(token)).json();

  assert.ok(!('faturaContasUrl' in corpo));
  assert.ok(!('faturaDominioUrl' in corpo));
});

test('CA5: URL nula omite faturaContasUrl', async () => {
  const { token, pedidoId } = await criarPedido();
  await definirUrl(pedidoId, 'contas', null);

  const corpo = (await consultar(token)).json();

  assert.ok(!('faturaContasUrl' in corpo));
});

// A coluna só aceita `https://` (CHECK do banco): `http://` não chega a ser gravada.
for (const [rotulo, url] of [
  ['host fora da allowlist', 'https://evil.example/i/x'],
  ['subdomínio parecido', 'https://www.asaas.com.evil.example/i/x'],
  ['porta explícita', 'https://www.asaas.com:444/x'],
  ['credenciais na URL', 'https://u:p@www.asaas.com/i/x'],
]) {
  test(`CA5: URL com ${rotulo} omite faturaContasUrl`, async () => {
    const { token, pedidoId } = await criarPedido();
    await definirUrl(pedidoId, 'contas', url);

    const corpo = (await consultar(token)).json();

    assert.ok(!('faturaContasUrl' in corpo));
    assert.ok(!(await consultar(token)).body.includes('evil'));
  });
}

test('CA5: URL de fatura com host fora da allowlist em domínios omite faturaDominioUrl', async () => {
  const { token, pedidoId } = await criarPedido(corpoComDominios());
  await definirUrl(pedidoId, 'dominios', 'https://evil.example/i/x');
  await definirEstado(pedidoId, 'aguardando_pagamento_do_dominio');

  const corpo = (await consultar(token)).json();

  assert.ok(!('faturaDominioUrl' in corpo));
});
