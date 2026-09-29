import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirAppTeste } from './auxiliares.js';
import { executarJob } from '../src/jobs/executar.js';

test('CA2: job de exemplo bem-sucedido registra início, execução e fim com o mesmo reqId da requisição, sem chave duplicada', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos/job', payload: {} });
  const requestId = resposta.headers['x-request-id'];

  assert.equal(resposta.statusCode, 200);

  const linhasDoJob = captura.linhas().filter((linha) => linha.reqId === requestId && linha.job === 'exemplo');
  const mensagens = linhasDoJob.map((linha) => linha.msg);

  assert.ok(mensagens.includes('job iniciado'), 'era esperado o log "job iniciado"');
  assert.ok(mensagens.includes('processando exemplo'), 'era esperado o log "processando exemplo"');

  const linhaFim = linhasDoJob.find((linha) => linha.msg === 'job concluído');
  assert.ok(linhaFim, 'era esperado o log "job concluído"');
  assert.ok(
    Number.isInteger(linhaFim.duracaoMs) && linhaFim.duracaoMs >= 0,
    `duracaoMs deveria ser inteiro >= 0, recebeu ${linhaFim.duracaoMs}`,
  );

  // Confere na linha bruta (não no objeto já reconstruído pelo JSON.parse,
  // que perderia a duplicidade): `reqId` deve aparecer uma única vez, senão
  // o job recebeu o logger da requisição (já filho, com reqId) em vez do
  // logger raiz (`app.log`) para criar seu próprio filho.
  const linhasBrutas = captura
    .texto()
    .split('\n')
    .map((linha) => linha.trim())
    .filter(Boolean);

  for (const linhaBruta of linhasBrutas) {
    const objeto = JSON.parse(linhaBruta);
    if (objeto.reqId === requestId && objeto.job === 'exemplo') {
      const ocorrencias = (linhaBruta.match(/"reqId"/g) ?? []).length;
      assert.equal(ocorrencias, 1, `"reqId" duplicado na linha: ${linhaBruta}`);
    }
  }
});

test('CA2: job de exemplo que falha registra "job falhou" (level 50) com a mensagem do erro e sem "job concluído"', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos/job', payload: { falhar: true } });
  const requestId = resposta.headers['x-request-id'];

  assert.equal(resposta.statusCode, 500);

  const linhasDoJob = captura.linhas().filter((linha) => linha.reqId === requestId && linha.job === 'exemplo');
  const linhaFalhou = linhasDoJob.find((linha) => linha.msg === 'job falhou');

  assert.ok(linhaFalhou, 'era esperado o log "job falhou"');
  assert.equal(linhaFalhou.level, 50);
  assert.equal(linhaFalhou.err?.message, 'falha simulada do job de exemplo');
  assert.ok(!linhasDoJob.some((linha) => linha.msg === 'job concluído'), 'não deveria haver "job concluído"');
});

test('CA2: chamada direta de executarJob sem correlacaoId recebe um UUID v4 novo', async (t) => {
  const { app, captura, fechar } = await construirAppTeste();
  t.after(fechar);

  await executarJob({ nome: 'x', log: app.log }, async () => {});

  const linha = captura.linhas().find((l) => l.job === 'x' && l.msg === 'job iniciado');
  assert.ok(linha, 'era esperado o log "job iniciado" para o job x');
  assert.match(
    linha.reqId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'reqId deveria ser um UUID v4',
  );
});

test('CA2: POST /api/exemplos/job não existe fora de desenvolvimento (NODE_ENV=production)', async (t) => {
  const { app, fechar } = await construirAppTeste({ sobrescritasConfig: { nodeEnv: 'production' } });
  t.after(fechar);

  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos/job', payload: {} });

  assert.equal(resposta.statusCode, 404);
});

test('Revisão: executarJob com um logger que já tem reqId (request.log) lança TypeError', async (t) => {
  const { app, captura, fechar } = await construirAppTeste({ comBanco: false });
  t.after(fechar);

  const logDaRequisicao = app.log.child({ reqId: 'req-ficticio-001' });
  let executou = false;

  await assert.rejects(
    executarJob({ nome: 'y', log: logDaRequisicao }, async () => {
      executou = true;
    }),
    { name: 'TypeError', message: 'executarJob: use o logger raiz, não request.log' },
  );
  assert.equal(executou, false, 'o corpo do job não deveria rodar');
  assert.ok(!captura.linhas().some((linha) => linha.job === 'y'), 'não deveria haver log do job y');
});
