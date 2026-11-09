import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirAppTeste } from './auxiliares.js';
import { ErroDeDominio } from '../src/erros.js';

function ordenarPorCampo(campos) {
  return [...campos].sort((a, b) => a.campo.localeCompare(b.campo));
}

test('CA4: corpo válido responde 200 com o mesmo corpo', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    payload: { titulo: 'Teste', quantidade: 2 },
  });

  assert.equal(resposta.statusCode, 200);
  assert.deepEqual(resposta.json(), { titulo: 'Teste', quantidade: 2 });
});

test('CA4: campo obrigatório ausente, fora do limite e não permitido geram 400 ordenado por campo', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    payload: { quantidade: 0, extra: true },
  });

  assert.equal(resposta.statusCode, 400);
  const corpo = resposta.json();
  assert.equal(corpo.erro, 'validacao');
  assert.deepEqual(ordenarPorCampo(corpo.campos), [
    { campo: 'extra', mensagem: 'campo não permitido' },
    { campo: 'quantidade', mensagem: 'fora do limite' },
    { campo: 'titulo', mensagem: 'obrigatório' },
  ]);
});

test('CA4: título maior que 80 caracteres e quantidade com tipo errado geram 400', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    payload: { titulo: 'a'.repeat(81), quantidade: 'abc' },
  });

  assert.equal(resposta.statusCode, 400);
  const porCampo = Object.fromEntries(resposta.json().campos.map((c) => [c.campo, c.mensagem]));
  assert.equal(porCampo.titulo, 'fora do limite');
  assert.equal(porCampo.quantidade, 'tipo inválido');
});

test('CA4: JSON malformado responde 400 com erro json_invalido', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    headers: { 'content-type': 'application/json' },
    payload: '{"titulo":',
  });

  assert.equal(resposta.statusCode, 400);
  assert.deepEqual(resposta.json(), { erro: 'json_invalido' });
});

test('CA4: nenhuma resposta 400 vaza stack, node_modules, " at " ou FST_', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  const respostas = await Promise.all([
    app.inject({ method: 'POST', url: '/api/exemplos', payload: { quantidade: 0, extra: true } }),
    app.inject({
      method: 'POST',
      url: '/api/exemplos',
      payload: { titulo: 'a'.repeat(81), quantidade: 'abc' },
    }),
    app.inject({
      method: 'POST',
      url: '/api/exemplos',
      headers: { 'content-type': 'application/json' },
      payload: '{"titulo":',
    }),
  ]);

  for (const resposta of respostas) {
    assert.equal(resposta.statusCode, 400);
    for (const trecho of ['stack', 'node_modules', ' at ', 'FST_']) {
      assert.ok(!resposta.body.includes(trecho), `corpo não deveria conter "${trecho}": ${resposta.body}`);
    }
  }
});

test('CA4 (proposto): erro não tratado numa rota responde 500 sem stack, com requestId', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  // Rota exclusiva do teste para forçar um erro não tratado (500).
  app.get('/api/rota-com-erro-para-teste', async () => {
    throw new Error('segredo-interno');
  });
  await app.ready();

  const resposta = await app.inject({ method: 'GET', url: '/api/rota-com-erro-para-teste' });

  assert.equal(resposta.statusCode, 500);
  const corpo = resposta.json();
  assert.equal(corpo.erro, 'interno');
  assert.equal(corpo.requestId, resposta.headers['x-request-id']);
  assert.ok(!resposta.body.includes('segredo-interno'));
  assert.ok(!resposta.body.includes('stack'));
});

test('CA4 (proposto): rota inexistente responde 404 com erro nao_encontrado', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({ method: 'GET', url: '/api/inexistente' });

  assert.equal(resposta.statusCode, 404);
  assert.deepEqual(resposta.json(), { erro: 'nao_encontrado' });
});

test('CA4: POST /api/exemplos não existe fora de desenvolvimento (NODE_ENV=production)', async (t) => {
  const { app, fechar } = await construirAppTeste({ sobrescritasConfig: { nodeEnv: 'production' } });
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    payload: { titulo: 'Teste', quantidade: 2 },
  });

  assert.equal(resposta.statusCode, 404);
});

test('Revisão: corpo sem coerção — número como string e vice-versa geram tipo inválido nos dois campos', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    payload: { titulo: 123, quantidade: '2' },
  });

  assert.equal(resposta.statusCode, 400);
  const porCampo = Object.fromEntries(resposta.json().campos.map((c) => [c.campo, c.mensagem]));
  assert.equal(porCampo.titulo, 'tipo inválido');
  assert.equal(porCampo.quantidade, 'tipo inválido');
});

test('Revisão: querystring continua com coerção de tipo (ao contrário do corpo)', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  // Rota exclusiva do teste (GET: a guarda onRoute só exige schema.body em
  // POST/PUT/PATCH) para provar que só o corpo perdeu a coerção.
  app.get('/api/rota-com-querystring-para-teste', {
    schema: {
      querystring: {
        type: 'object',
        required: ['numero'],
        properties: { numero: { type: 'integer' } },
      },
    },
  }, async (request) => ({ numero: request.query.numero, tipo: typeof request.query.numero }));
  await app.ready();

  const resposta = await app.inject({ method: 'GET', url: '/api/rota-com-querystring-para-teste?numero=5' });

  assert.equal(resposta.statusCode, 200);
  assert.deepEqual(resposta.json(), { numero: 5, tipo: 'number' });
});

test('Revisão: guarda onRoute barra POST/PUT/PATCH sem schema.body (ADR 0003)', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  let erroCapturado;
  try {
    app.post('/api/rota-sem-schema-para-teste', async () => ({ ok: true }));
    await app.ready();
  } catch (erro) {
    erroCapturado = erro;
  }

  assert.ok(erroCapturado, 'era esperado um erro ao registrar/subir uma rota POST sem schema.body');
  assert.equal(erroCapturado.message, 'Rota POST /api/rota-sem-schema-para-teste sem schema.body (ADR 0003)');
});

test('Revisão: ErroDeDominio lançado numa rota vira o status e o corpo configurados', async (t) => {
  const { app, fechar } = await construirAppTeste();
  t.after(fechar);

  app.get('/api/rota-com-erro-de-dominio-para-teste', async () => {
    throw new ErroDeDominio({ status: 409, erro: 'x' });
  });
  await app.ready();

  const resposta = await app.inject({ method: 'GET', url: '/api/rota-com-erro-de-dominio-para-teste' });

  assert.equal(resposta.statusCode, 409);
  assert.deepEqual(resposta.json(), { erro: 'x' });
});

test('CIT-59 (D7): 400 de validação devolve no máximo 20 itens em campos', async (t) => {
  const { app, fechar } = await construirAppTeste({ comBanco: false });
  t.after(fechar);

  const payload = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`desconhecido${i}`, true]));
  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos', payload });

  assert.equal(resposta.statusCode, 400);
  const corpo = resposta.json();
  assert.equal(corpo.erro, 'validacao');
  assert.equal(corpo.campos.length, 20);
});
