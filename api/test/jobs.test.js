import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as esperar } from 'node:timers/promises';
import { construirAppTeste, criarFilasTeste, urlRedisTeste } from './auxiliares.js';
import { executarJob } from '../src/jobs/executar.js';
import { criarConexaoProdutor, criarConexaoWorker } from '../src/fila/conexao.js';
import { criarFilas } from '../src/fila/filas.js';
import { criarLogger } from '../src/log.js';

// CIT-56 (CA8): a rota `POST /api/exemplos/job` passou a só enfileirar (202
// com `jobId`; 503 com a fila fora). `construirAppTeste` repassa `filas`
// injetada a `construirApp(config, { ..., filas })` (decisão 9 do plano).

async function aguardarCondicao(condicao, { timeoutMs = 6000, intervaloMs = 20 } = {}) {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const valor = await condicao();
    if (valor) return valor;
    if (Date.now() >= prazo) throw new Error('aguardarCondicao: tempo esgotado');
    await esperar(intervaloMs);
  }
}

test('CA8: POST /api/exemplos/job responde 202 com jobId e o worker processa com o mesmo reqId da resposta', async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);
  aux.criarWorkers();

  const { app, fechar } = await construirAppTeste({ filas: aux.filas });
  t.after(fechar);

  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos/job', payload: {} });
  assert.equal(resposta.statusCode, 202);
  const { jobId } = resposta.json();
  assert.equal(typeof jobId, 'string');
  const requestId = resposta.headers['x-request-id'];

  await aguardarCondicao(async () => {
    const job = await aux.filas.jobs.getJob(jobId);
    return job ? (await job.getState()) === 'completed' : false;
  });

  const linhasDoJob = aux.captura.linhas().filter((l) => l.reqId === requestId && l.job === 'exemplo');
  const mensagens = linhasDoJob.map((l) => l.msg);
  assert.ok(mensagens.includes('job iniciado'));
  assert.ok(mensagens.includes('processando exemplo'));

  const linhaFim = linhasDoJob.find((l) => l.msg === 'job concluído');
  assert.ok(linhaFim, 'era esperado o log "job concluído"');
  assert.ok(Number.isInteger(linhaFim.duracaoMs) && linhaFim.duracaoMs >= 0);

  // "reqId" único na linha bruta (CIT-55).
  const linhasBrutas = aux.captura.texto().split('\n').map((l) => l.trim()).filter(Boolean);
  for (const linhaBruta of linhasBrutas) {
    const objeto = JSON.parse(linhaBruta);
    if (objeto.reqId === requestId && objeto.job === 'exemplo') {
      const ocorrencias = (linhaBruta.match(/"reqId"/g) ?? []).length;
      assert.equal(ocorrencias, 1, `"reqId" duplicado na linha: ${linhaBruta}`);
    }
  }
});

test('CA8: POST /api/exemplos/job com falhar:true gera 3 linhas "job falhou" (nível 50) e nenhuma "erro não tratado"', async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);
  aux.criarWorkers();

  const { app, fechar } = await construirAppTeste({ filas: aux.filas });
  t.after(fechar);

  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos/job', payload: { falhar: true } });
  assert.equal(resposta.statusCode, 202);
  const { jobId } = resposta.json();
  const requestId = resposta.headers['x-request-id'];

  await aguardarCondicao(async () => {
    const job = await aux.filas.jobs.getJob(jobId);
    return job ? (await job.getState()) === 'failed' : false;
  });

  const linhasFalhou = aux.captura.linhas().filter((l) => l.reqId === requestId && l.job === 'exemplo' && l.msg === 'job falhou');
  assert.equal(linhasFalhou.length, 3);
  for (const linha of linhasFalhou) {
    assert.equal(linha.level, 50);
    assert.equal(linha.err?.message, 'falha simulada do job de exemplo');
  }
  assert.ok(!aux.captura.linhas().some((l) => l.msg === 'erro não tratado'));
});

test('CA8: com o Redis inacessível, a rota responde 503 em até 3 segundos, sem a URL no log', async (t) => {
  const prefixo = `teste-ca8-sem-redis-${process.pid}`;
  const conexao = criarConexaoProdutor('redis://127.0.0.1:1');
  const log = criarLogger({ level: 'info' });
  const filas = criarFilas({ conexao, prefixo, tentativas: 3, backoffMs: 300, log });
  t.after(async () => {
    await filas.close().catch(() => {});
    conexao.disconnect();
  });

  const { app, captura, fechar } = await construirAppTeste({ filas });
  t.after(fechar);

  const inicio = Date.now();
  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos/job', payload: {} });
  const duracao = Date.now() - inicio;

  assert.equal(resposta.statusCode, 503);
  assert.deepEqual(resposta.json(), { erro: 'fila indisponível' });
  assert.ok(duracao < 3000, `esperava responder em menos de 3000ms, levou ${duracao}ms`);
  assert.ok(!captura.texto().includes('127.0.0.1:1'), 'o log não deveria conter a URL/porta do Redis');
});

// CA8 "job fantasma" (Redis volta depois do 503 via proxy TCP local): tirado
// da suíte por instabilidade — a 1ª execução travou (handles do BullMQ sobre
// o proxy nunca soltam o event loop, "Promise resolution is still pending"
// mesmo fechando `filas`/conexão no `t.after`), exatamente o caso que o plano
// (.omc/plans/CIT-56.md, linha do CA8 "Job fantasma") previu e autorizou
// deixar só registrado no ADR 0005 quando o proxy se mostrar instável.

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

test('Revisão: sem filas injetada, com config.redisUrl o app cria a própria fila (202) e a fecha no app.close()', { timeout: 15000 }, async () => {
  const prefixo = `teste-app-fila-propria-${process.pid}`;
  const { app, fechar } = await construirAppTeste({
    sobrescritasConfig: { redisUrl: urlRedisTeste(), filaPrefixo: prefixo, filaTentativas: 3, filaBackoffMs: 300 },
  });

  const resposta = await app.inject({ method: 'POST', url: '/api/exemplos/job', payload: {} });
  assert.equal(resposta.statusCode, 202);
  assert.equal(typeof resposta.json().jobId, 'string');

  await fechar(); // não deveria travar: onClose fecha a fila/conexão própria do app.

  // Limpeza: essa fila não passou por `criarFilasTeste()`/`fechar()`; apaga
  // as chaves do prefixo numa conexão nova, só para não vazar estado.
  const conexao = criarConexaoWorker(urlRedisTeste());
  const chaves = await conexao.keys(`${prefixo}:*`);
  if (chaves.length > 0) await conexao.del(...chaves);
  await conexao.quit();
});

test('CA8: POST /api/exemplos/job continua 404 em produção, mesmo com filas injetadas', async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);

  const { app, fechar } = await construirAppTeste({ filas: aux.filas, sobrescritasConfig: { nodeEnv: 'production' } });
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
