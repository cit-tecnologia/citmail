// CIT-64, recepção do webhook do Asaas (CA1, CA2, CA3, CA6a, CA12a/b/c, CA13a/d): rota
// `POST /api/asaas/webhook` contra um banco temporário migrado, com o papel da aplicação.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { construirApp } from '../src/app.js';
import { criarClienteAsaas } from '../src/asaas/cliente.js';
import { extrairCamposBrutos } from '../src/asaas/webhook-rotas.js';
import { construirAppTeste, criarCapturaDeLog, criarConfigTeste } from './auxiliares.js';
import { criarStubAsaas } from './stub-asaas.js';
import { criarBancoWebhook, corpoDoEvento, semearPedido, TOKEN_WEBHOOK } from './webhook-fixtures.js';

const URL_WEBHOOK = '/api/asaas/webhook';
const CABECALHO = { 'asaas-access-token': TOKEN_WEBHOOK };
let banco;
let stub;
let captura;
let app;

before(async () => {
  banco = await criarBancoWebhook();
  stub = await criarStubAsaas();
  captura = criarCapturaDeLog();
  const asaas = criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: 'CHAVE-FICTICIA', timeoutMs: 1000 });
  app = construirApp(
    criarConfigTeste({ databaseUrl: banco.url, asaasWebhookToken: TOKEN_WEBHOOK }),
    { pool: banco.app, logStream: captura.stream, asaas }
  );
});

after(async () => {
  await app.close();
  await stub.fechar();
  await banco.fechar();
});

beforeEach(async () => {
  stub.limpar();
  await banco.limpar();
});

async function contarBrutos() {
  return (await banco.admin.query('SELECT count(*)::int AS n FROM asaas_webhook_evento')).rows[0].n;
}

function enviar(payload, headers = CABECALHO) {
  return app.inject({ method: 'POST', url: URL_WEBHOOK, payload, headers });
}

const CABECALHOS_RECUSADOS = [
  ['sem o cabeçalho', {}],
  ['cabeçalho vazio', { 'asaas-access-token': '' }],
  ['token errado de mesmo tamanho', { 'asaas-access-token': 'x'.repeat(TOKEN_WEBHOOK.length) }],
  ['token errado curto', { 'asaas-access-token': 'curto' }],
  ['token errado de 200 caracteres', { 'asaas-access-token': 'y'.repeat(200) }]
];

for (const [rotulo, cabecalhos] of CABECALHOS_RECUSADOS) {
  test(`CA1: ${rotulo} responde 401 nao_autorizado e não grava nada`, async () => {
    const resposta = await enviar(corpoDoEvento(), cabecalhos);
    assert.equal(resposta.statusCode, 401);
    assert.deepEqual(resposta.json(), { erro: 'nao_autorizado' });
    assert.equal(await contarBrutos(), 0);
  });
}

test('CA1: as recusas têm corpo e cabeçalhos iguais, sem revelar o tamanho do token', async () => {
  const respostas = [];
  for (const [, cabecalhos] of CABECALHOS_RECUSADOS) respostas.push(await enviar(corpoDoEvento(), cabecalhos));
  const normalizada = (r) => {
    const { 'x-request-id': _id, date: _data, ...resto } = r.headers;
    return { corpo: r.body, cabecalhos: resto };
  };
  for (const resposta of respostas.slice(1)) assert.deepEqual(normalizada(resposta), normalizada(respostas[0]));
});

test('CA1: a autenticação vem antes da validação do corpo: token errado com corpo inválido responde 401, não 400', async () => {
  const resposta = await enviar({ semId: true }, { 'asaas-access-token': 'errado' });
  assert.equal(resposta.statusCode, 401);
  assert.deepEqual(resposta.json(), { erro: 'nao_autorizado' });
});

test('CA1: a autenticação vem antes do limite do corpo: token errado com 16385 bytes responde 401, não 413', async () => {
  const resposta = await enviar(corpoComBytes(16385), { 'asaas-access-token': 'errado', 'content-type': 'application/json' });
  assert.equal(resposta.statusCode, 401);
  assert.equal(await contarBrutos(), 0);
});

test('CA1: sem o cabeçalho o banco não é tocado (pool espião sem query nem connect)', async (t) => {
  let acessos = 0;
  const espiao = {
    async query() { acessos += 1; return { rows: [] }; },
    async connect() { acessos += 1; throw new Error('connect não esperado'); },
    on() {},
    async end() {}
  };
  const ambiente = await construirAppTeste({
    comBanco: false, pool: espiao, sobrescritasConfig: { asaasWebhookToken: TOKEN_WEBHOOK }
  });
  t.after(() => ambiente.fechar());
  const resposta = await ambiente.app.inject({ method: 'POST', url: URL_WEBHOOK, payload: corpoDoEvento() });
  assert.equal(resposta.statusCode, 401);
  assert.equal(acessos, 0);
});

test('CA2: PAYMENT_RECEIVED com token válido grava o bruto pendente e responde 200 em menos de 1 s, sem chamar o Asaas', async () => {
  const { pedidoId } = await semearPedido(banco.admin);
  stub.definir('GET /payments/{id}', { atrasoMs: 5000 });
  const inicio = performance.now();
  const resposta = await enviar(corpoDoEvento());
  const duracao = performance.now() - inicio;

  assert.equal(resposta.statusCode, 200);
  assert.deepEqual(resposta.json(), { recebido: true });
  assert.ok(duracao < 1000, `respondeu em ${duracao} ms`);
  assert.equal(stub.chamadas.length, 0);
  const { rows } = await banco.admin.query('SELECT * FROM asaas_webhook_evento');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].situacao, 'pendente');
  assert.equal(rows[0].enfileirado_em, null);
  assert.equal(rows[0].processado_em, null);
  assert.equal(rows[0].valor_centavos, 4990);
  assert.equal(rows[0].pagamento_id, 'pay_1');
  assert.equal(rows[0].assinatura_id, 'sub_contas_1');
  const pedido = await banco.admin.query('SELECT estado FROM pedido WHERE id = $1', [pedidoId]);
  assert.equal(pedido.rows[0].estado, 'aguardando_pagamento');
});

test('CA3: dados pessoais e campos fora da lista branca não chegam à linha nem ao log, e o log leva o paymentId', async () => {
  const pagamento = {
    customer: { name: 'Fulano Ficticio', email: 'fulano@exemplo.test', cpfCnpj: '00000000191' },
    description: 'descricao-ficticia-xyz',
    observations: 'observacao-ficticia-xyz',
    invoiceUrl: 'https://fatura.test/x',
    bankSlipUrl: 'https://boleto.test/y',
    creditCard: { creditCardNumber: '1234' },
    campoDesconhecido: 'desconhecido-ficticio-xyz'
  };
  const resposta = await enviar(corpoDoEvento({ campoRaiz: 'raiz-ficticia-xyz' }, pagamento));
  assert.equal(resposta.statusCode, 200);

  const { rows } = await banco.admin.query('SELECT row_to_json(a)::text AS texto FROM asaas_webhook_evento a');
  assert.equal(rows.length, 1);
  const log = captura.texto();
  for (const proibido of ['Fulano', 'fulano@', '00000000191', 'fatura.test', 'boleto.test', '1234',
    'descricao-ficticia-xyz', 'observacao-ficticia-xyz', 'desconhecido-ficticio-xyz', 'raiz-ficticia-xyz']) {
    assert.ok(!rows[0].texto.includes(proibido), `linha com ${proibido}`);
    assert.ok(!log.includes(proibido), `log com ${proibido}`);
  }
  assert.ok(!log.includes(TOKEN_WEBHOOK), 'log com o token');
  assert.ok(log.includes('"paymentId":"pay_1"'));
});

test('CA6(a): o mesmo corpo duas vezes responde 200 nas duas e grava um bruto só', async () => {
  const corpo = corpoDoEvento();
  const primeira = await enviar(corpo);
  const segunda = await enviar(corpo);
  assert.equal(primeira.statusCode, 200);
  assert.equal(segunda.statusCode, 200);
  assert.deepEqual(segunda.json(), { recebido: true });
  assert.equal(await contarBrutos(), 1);
});

function corpoComBytes(bytes) {
  const base = JSON.stringify({ id: 'evt_limite_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' }, enchimento: '' });
  return JSON.stringify({
    id: 'evt_limite_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' },
    enchimento: 'x'.repeat(bytes - Buffer.byteLength(base))
  });
}

test('CA12(a): corpo de 16385 bytes responde 413 e não grava bruto', async () => {
  const corpo = corpoComBytes(16385);
  assert.equal(Buffer.byteLength(corpo), 16385);
  const resposta = await enviar(corpo, { ...CABECALHO, 'content-type': 'application/json' });
  assert.equal(resposta.statusCode, 413);
  assert.equal(await contarBrutos(), 0);
});

test('CA12(a): corpo de exatamente 16384 bytes ainda é aceito', async () => {
  const corpo = corpoComBytes(16384);
  assert.equal(Buffer.byteLength(corpo), 16384);
  const resposta = await enviar(corpo, { ...CABECALHO, 'content-type': 'application/json' });
  assert.equal(resposta.statusCode, 200);
  assert.equal(await contarBrutos(), 1);
});

for (const evento of ['SUBSCRIPTION_CREATED', 'PAYMENT_REFUNDED']) {
  test(`CA12(b): ${evento} responde 200 e guarda o bruto`, async () => {
    const corpo = evento === 'SUBSCRIPTION_CREATED'
      ? { id: 'evt_sub_1', event: evento }
      : corpoDoEvento({ event: evento });
    const resposta = await enviar(corpo);
    assert.equal(resposta.statusCode, 200);
    const { rows } = await banco.admin.query('SELECT evento, situacao FROM asaas_webhook_evento');
    assert.deepEqual(rows, [{ evento, situacao: 'pendente' }]);
  });
}

const CORPOS_INVALIDOS = [
  ['sem id', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }],
  ['id sem o prefixo evt_', { id: 'abc_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }],
  ['id com caractere fora do padrão', { id: 'evt_a b', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }],
  ['id de número', { id: 12, event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }],
  ['sem event', { id: 'evt_1', payment: { id: 'pay_1' } }],
  ['payment sem id', { id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { value: 1 } }],
  ['payment.id fora do padrão', { id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay 1' } }]
];

for (const [rotulo, corpo] of CORPOS_INVALIDOS) {
  test(`CA12(c): corpo ${rotulo} responde 400 validacao e não grava bruto`, async () => {
    const resposta = await enviar(corpo);
    assert.equal(resposta.statusCode, 400);
    assert.equal(resposta.json().erro, 'validacao');
    assert.equal(await contarBrutos(), 0);
  });
}

test('CA3: valor, data e referência fora do formato viram null e o evento ainda é aceito', async () => {
  const resposta = await enviar(corpoDoEvento({}, {
    value: 'abc', dueDate: '2026-02-30', paymentDate: 'ontem', status: 'minusculo', externalReference: 'r'.repeat(101)
  }));
  assert.equal(resposta.statusCode, 200);
  const { rows } = await banco.admin.query(
    'SELECT valor_centavos, vencimento, pago_em, status, referencia_externa FROM asaas_webhook_evento'
  );
  assert.deepEqual(rows, [{ valor_centavos: null, vencimento: null, pago_em: null, status: null, referencia_externa: null }]);
});

test('CA2: o valor em reais vira centavos inteiros sem erro de ponto flutuante', () => {
  assert.equal(extrairCamposBrutos(corpoDoEvento({}, { value: 19.99 })).valorCentavos, 1999);
  assert.equal(extrairCamposBrutos(corpoDoEvento({}, { value: 49.9 })).valorCentavos, 4990);
});

test('CA2: pago_em usa confirmedDate quando não há paymentDate', () => {
  const campos = extrairCamposBrutos(corpoDoEvento({}, { paymentDate: undefined, confirmedDate: '2026-12-03' }));
  assert.equal(campos.pagoEm, '2026-12-03');
});

test('CA13(a): com a flag desligada a rota não existe (404) e nada é gravado', async (t) => {
  const ambiente = await construirAppTeste({
    comBanco: false,
    pool: { async query() { return { rows: [] }; }, on() {}, async end() {} },
    sobrescritasConfig: { webhookAsaasHabilitado: false, asaasWebhookToken: TOKEN_WEBHOOK }
  });
  t.after(() => ambiente.fechar());
  const resposta = await ambiente.app.inject({ method: 'POST', url: URL_WEBHOOK, payload: corpoDoEvento(), headers: CABECALHO });
  assert.equal(resposta.statusCode, 404);
});

test('CA13(a): em produção, sem a flag definida, a rota não existe (404)', async (t) => {
  const ambiente = await construirAppTeste({
    comBanco: false,
    pool: { async query() { return { rows: [] }; }, on() {}, async end() {} },
    sobrescritasConfig: { nodeEnv: 'production', asaasWebhookToken: TOKEN_WEBHOOK }
  });
  t.after(() => ambiente.fechar());
  const resposta = await ambiente.app.inject({ method: 'POST', url: URL_WEBHOOK, payload: corpoDoEvento(), headers: CABECALHO });
  assert.equal(resposta.statusCode, 404);
});

test('CA13(d): fora de produção, sem token configurado, responde 503 webhook_indisponivel e não grava', async (t) => {
  const semToken = construirApp(
    criarConfigTeste({ databaseUrl: banco.url }),
    { pool: banco.app, logStream: criarCapturaDeLog().stream }
  );
  t.after(() => semToken.close());
  for (const headers of [CABECALHO, {}]) {
    const resposta = await semToken.inject({ method: 'POST', url: URL_WEBHOOK, payload: corpoDoEvento(), headers });
    assert.equal(resposta.statusCode, 503);
    assert.deepEqual(resposta.json(), { erro: 'webhook_indisponivel' });
  }
  assert.equal(await contarBrutos(), 0);
});
