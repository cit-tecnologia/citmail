import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { construirAppTeste } from './auxiliares.js';
import { camposSensiveis } from '../src/log.js';

test('CA1: requisição bem-sucedida gera uma única linha "request completed" com reqId, método, rota, IP, status e duração, sem url', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos?token=abc123-query',
    payload: { titulo: 'x', quantidade: 1 },
  });
  const requestId = resposta.headers['x-request-id'];

  assert.equal(resposta.statusCode, 200);

  const linhasCompletas = captura
    .linhas()
    .filter((linha) => linha.reqId === requestId && linha.msg === 'request completed');
  assert.equal(linhasCompletas.length, 1, 'era esperada exatamente uma linha "request completed"');

  const [linha] = linhasCompletas;
  assert.equal(linha.req.method, 'POST');
  assert.equal(linha.req.rota, '/api/exemplos');
  assert.equal(linha.req.url, undefined);
  assert.equal(linha.req.caminho, undefined);
  assert.equal(typeof linha.req.remoteAddress, 'string');
  assert.equal(linha.res.statusCode, 200);
  assert.equal(typeof linha.responseTime, 'number');
  assert.ok(linha.responseTime >= 0);

  assert.ok(!captura.texto().includes('abc123-query'));
});

test('CA1: rota não encontrada gera req.rota null e req.caminho sem a query string', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({ method: 'GET', url: '/api/nao-existe?token=q404-query' });
  const requestId = resposta.headers['x-request-id'];

  assert.equal(resposta.statusCode, 404);

  const linha = captura.linhas().find((l) => l.reqId === requestId && l.msg === 'request completed');
  assert.ok(linha, 'era esperada uma linha "request completed" para a rota não encontrada');
  assert.equal(linha.req.rota, null);
  assert.equal(linha.req.caminho, '/api/nao-existe');
  assert.equal(linha.res.statusCode, 404);

  assert.ok(!captura.texto().includes('q404-query'));
});

test('CA1: não há mais as linhas padrão "incoming request" nem "Route ... not found"', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  await app.inject({ method: 'GET', url: '/api/health' });
  await app.inject({ method: 'GET', url: '/api/nao-existe' });

  const linhas = captura.linhas();
  assert.ok(!linhas.some((linha) => linha.msg === 'incoming request'));
  assert.ok(!linhas.some((linha) => typeof linha.msg === 'string' && linha.msg.startsWith('Route ')));
});

test('CA1: req.caminho da rota não encontrada é truncado em 200 caracteres', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  const caminhoLongo = `/${'x'.repeat(299)}`; // 300 caracteres
  const resposta = await app.inject({ method: 'GET', url: caminhoLongo });
  const requestId = resposta.headers['x-request-id'];

  assert.equal(resposta.statusCode, 404);

  const linha = captura.linhas().find((l) => l.reqId === requestId && l.msg === 'request completed');
  assert.ok(linha, 'era esperada uma linha "request completed"');
  assert.equal(linha.req.caminho.length, 200);
});

test('CA3: cabeçalho Authorization nunca aparece no log, mesmo numa resposta de erro', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  // Rota exclusiva do teste, só para forçar uma resposta 500 com o cabeçalho presente.
  app.get('/api/rota-com-erro-para-teste-ca3', async () => {
    throw new Error('erro para o teste de Authorization');
  });
  await app.ready();

  const resposta200 = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    headers: { authorization: 'Bearer SEGREDO-X-AUTH' },
    payload: { titulo: 'x', quantidade: 1 },
  });
  const resposta500 = await app.inject({
    method: 'GET',
    url: '/api/rota-com-erro-para-teste-ca3',
    headers: { authorization: 'Bearer SEGREDO-X-AUTH' },
  });

  assert.equal(resposta200.statusCode, 200);
  assert.equal(resposta500.statusCode, 500);
  assert.ok(!captura.texto().includes('SEGREDO-X-AUTH'));
});

// Os 41 nomes da decisão 5 do plano CIT-55 (pedido em português, ViaCEP,
// credenciais em inglês e cliente/pagamento do Asaas, com as inscrições
// municipal/estadual acrescentadas na revisão de 2026-09-29). Se a lista
// exportada de `api/src/log.js` encolher ou ganhar um nome sem que este
// teste mude, o `deepEqual` abaixo falha.
const NOMES_ESPERADOS_CA3 = [
  'senha', 'token', 'email', 'telefone', 'nome', 'cpf', 'cnpj', 'cpfCnpj', 'documento',
  'razaoSocial', 'nascimento', 'dataNascimento', 'cep', 'endereco', 'logradouro', 'numero',
  'complemento', 'bairro', 'cidade',
  'localidade',
  'password', 'authorization', 'accessToken', 'access_token', 'refreshToken', 'apiKey',
  'name', 'phone', 'mobilePhone', 'company', 'postalCode', 'address', 'addressNumber',
  'complement', 'province', 'cityName', 'additionalEmails', 'municipalInscription', 'stateInscription',
  'creditCard', 'creditCardToken',
];

function construirComMarcadores(nomes, profundidade) {
  const folha = {};
  for (const nome of nomes) folha[nome] = `MARC-${nome}-${profundidade}`;
  if (profundidade === 0) return folha;
  if (profundidade === 1) return { a: folha };
  if (profundidade === 2) return { a: { b: folha } };
  return { a: { b: { c: folha } } };
}

function acessarNivel(linha, profundidade) {
  if (profundidade === 0) return linha;
  if (profundidade === 1) return linha.a;
  if (profundidade === 2) return linha.a.b;
  return linha.a.b.c;
}

test('CA3: os 41 campos sensíveis da decisão 5 são mascarados na raiz e em até 3 níveis de aninhamento', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  assert.equal(NOMES_ESPERADOS_CA3.length, 41);
  assert.deepEqual([...camposSensiveis].sort(), [...NOMES_ESPERADOS_CA3].sort());

  for (let profundidade = 0; profundidade <= 3; profundidade++) {
    app.log.info(construirComMarcadores(camposSensiveis, profundidade), `ca3 nivel ${profundidade}`);
  }

  const linhas = captura.linhas().filter((l) => typeof l.msg === 'string' && l.msg.startsWith('ca3 nivel'));
  assert.equal(linhas.length, 4);

  for (const linha of linhas) {
    const profundidade = Number(linha.msg.split(' ').pop());
    const alvo = acessarNivel(linha, profundidade);
    for (const nome of camposSensiveis) {
      assert.equal(alvo[nome], '[mascarado]', `campo "${nome}" no nível ${profundidade} deveria estar mascarado`);
    }
  }

  const texto = captura.texto();
  for (const nome of camposSensiveis) {
    for (let profundidade = 0; profundidade <= 3; profundidade++) {
      assert.ok(
        !texto.includes(`MARC-${nome}-${profundidade}`),
        `marcador de "${nome}" no nível ${profundidade} vazou no log`,
      );
    }
  }
});

test('CA3: pedido no formato do checkout e resumo bruto do webhook do Asaas, logados por engano, não vazam dado pessoal nem token de cartão', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  app.log.info(
    {
      pedido: {
        nome: 'MARC-NOME',
        email: 'MARC-EMAIL',
        telefone: 'MARC-TELEFONE',
        cpfCnpj: 'MARC-CPFCNPJ',
        razaoSocial: 'MARC-RAZAOSOCIAL',
        nascimento: 'MARC-NASCIMENTO',
        cep: 'MARC-CEP',
        logradouro: 'MARC-LOGRADOURO',
        numero: 'MARC-NUMERO',
        complemento: 'MARC-COMPLEMENTO',
        bairro: 'MARC-BAIRRO',
        cidade: 'MARC-CIDADE',
        estado: 'SP',
      },
    },
    'ca3 pedido checkout',
  );

  // Fixture no formato real do webhook do Asaas (mesma do CA7), logada
  // inteira por engano: nada deveria vazar mesmo assim.
  const evento = {
    event: 'PAYMENT_CONFIRMED',
    payment: {
      id: 'pay_ficticio001',
      customer: 'cus_ficticio001',
      billingType: 'CREDIT_CARD',
      status: 'CONFIRMED',
      value: 49.9,
      description: 'MARC-DESCRICAO',
      externalReference: 'MARC-EXTREF',
      creditCard: { creditCardNumber: '0000', creditCardBrand: 'VISA', creditCardToken: 'MARC-CCTOKEN' },
    },
  };
  app.log.info({ evento }, 'ca3 webhook por engano');

  const texto = captura.texto();
  for (const marcador of [
    'MARC-NOME', 'MARC-EMAIL', 'MARC-TELEFONE', 'MARC-CPFCNPJ', 'MARC-RAZAOSOCIAL',
    'MARC-NASCIMENTO', 'MARC-CEP', 'MARC-LOGRADOURO', 'MARC-NUMERO', 'MARC-COMPLEMENTO',
    'MARC-BAIRRO', 'MARC-CIDADE', 'MARC-CCTOKEN',
  ]) {
    assert.ok(!texto.includes(marcador), `marcador "${marcador}" vazou no log`);
  }

  const linhaPedido = captura.linhas().find((l) => l.msg === 'ca3 pedido checkout');
  assert.equal(linhaPedido.pedido.estado, 'SP', 'estado não deveria ser mascarado');

  const linhaWebhook = captura.linhas().find((l) => l.msg === 'ca3 webhook por engano');
  assert.equal(linhaWebhook.evento.payment.creditCard, '[mascarado]');
});

test('CA3: o corpo da requisição nunca é logado', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    payload: { titulo: 'CORPO-MARCADOR', quantidade: 1 },
  });

  assert.ok(!captura.texto().includes('CORPO-MARCADOR'));
});

test('CA5: GET /api/health bem-sucedido não gera nenhuma linha de log com o reqId da requisição', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({ method: 'GET', url: '/api/health' });
  const requestId = resposta.headers['x-request-id'];

  assert.equal(resposta.statusCode, 200);
  assert.ok(!captura.linhas().some((linha) => linha.reqId === requestId));
});

test('CA5: GET /api/health com banco indisponível continua gerando o warn "banco indisponível no health" com o reqId da requisição', async (t) => {
  const { app, captura, fechar } = await construirAppTeste({
    comBanco: false,
    sobrescritasConfig: { databaseUrl: 'postgres://postgres@127.0.0.1:1/x' },
  });
  t.after(fechar);

  const resposta = await app.inject({ method: 'GET', url: '/api/health' });
  const requestId = resposta.headers['x-request-id'];

  assert.equal(resposta.statusCode, 503);

  const linha = captura.linhas().find((l) => l.reqId === requestId && l.msg === 'banco indisponível no health');
  assert.ok(linha, 'era esperado o log de warn com o reqId da requisição');
  assert.equal(linha.level, 40);
});

test('CA6: requisição abortada pelo cliente antes da resposta gera a linha "request aborted" com reqId e req.rota', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();

  let liberarResposta;
  const respostaLiberada = new Promise((resolve) => {
    liberarResposta = resolve;
  });
  // Só destruir o socket depois que o handler começou a rodar: se destruirmos
  // logo após o `connect` TCP, a requisição HTTP pode nem ter chegado ao
  // Fastify (nada para o `onRequestAbort` correlacionar).
  let sinalizarRotaIniciada;
  const rotaIniciada = new Promise((resolve) => {
    sinalizarRotaIniciada = resolve;
  });

  t.after(async () => {
    liberarResposta();
    await fechar();
  });

  app.get('/api/teste-lenta', async () => {
    sinalizarRotaIniciada();
    await respostaLiberada;
    return { ok: true };
  });
  await app.ready();

  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  await new Promise((resolve, reject) => {
    const tempoEsgotado = setTimeout(() => reject(new Error('rota não iniciou a tempo')), 2000);
    const requisicao = http.get(
      { host: '127.0.0.1', port, path: '/api/teste-lenta?token=abort-query' },
      () => {},
    );
    requisicao.on('error', () => {});
    rotaIniciada.then(() => {
      clearTimeout(tempoEsgotado);
      requisicao.destroy();
      resolve();
    });
  });

  const inicio = Date.now();
  let linha;
  while (Date.now() - inicio < 2000) {
    linha = captura.linhas().find((l) => l.msg === 'request aborted');
    if (linha) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(linha, 'era esperada a linha "request aborted"');
  assert.equal(linha.req.rota, '/api/teste-lenta');
  assert.equal(typeof linha.reqId, 'string');
  assert.ok(!captura.texto().includes('abort-query'));
});

test('CA8: campos sensíveis do log saem mascarados como "[mascarado]"', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  // Log sobre o logger real do app (não um objeto pino à parte), como exige
  // o plano: `app.log` é o mesmo logger configurado por `construirApp`, com
  // `redact` já aplicado.
  app.log.info({ senha: 'x', dados: { email: 'a@b.c' } }, 'log de teste com dado sensível');

  const linhaComSenha = captura.linhas().find((linha) => linha.senha !== undefined);

  assert.ok(linhaComSenha, 'era esperada uma linha de log com o campo senha');
  assert.equal(linhaComSenha.senha, '[mascarado]');
  assert.equal(linhaComSenha.dados?.email, '[mascarado]');
});

test('Revisão: erro do pg (detail/where/parameters) sai mascarado no log de erro', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  // Rota exclusiva do teste: simula um erro real do driver `pg` (ex.:
  // violação de unicidade), que traz dados da linha nesses campos.
  app.get('/api/rota-com-erro-pg-para-teste', async () => {
    const erro = new Error('duplicate key value violates unique constraint');
    erro.detail = 'Key (email)=(a@b.c) already exists.';
    erro.where = 'SQL statement "INSERT INTO clientes ..."';
    erro.parameters = ['a@b.c', '11999999999'];
    throw erro;
  });
  await app.ready();

  const resposta = await app.inject({ method: 'GET', url: '/api/rota-com-erro-pg-para-teste' });
  assert.equal(resposta.statusCode, 500);

  const linhaDeErro = captura.linhas().find((linha) => linha.level === 50 && linha.err);

  assert.ok(linhaDeErro, 'era esperado um log de erro (level 50) com o campo err');
  assert.equal(linhaDeErro.err.detail, '[mascarado]');
  assert.equal(linhaDeErro.err.where, '[mascarado]');
  assert.equal(linhaDeErro.err.parameters, '[mascarado]');
});
