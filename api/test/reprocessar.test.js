// CA3 — reprocessamento. Contrato real:
// - `../src/cli/reprocessar.js`: `reprocessar({ filas, jobId, saida =
//   process.stdout }) → Promise<number>` (0 reenfileirado; 1 não encontrado;
//   2 fora de `failed`); nunca escreve `job.data` em `saida`.
// - `./auxiliares.js`: `criarFilasTeste(opcoesFila)` (síncrono).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as esperar } from 'node:timers/promises';
import { urlRedisTeste, criarFilasTeste } from './auxiliares.js';
import { reprocessar } from '../src/cli/reprocessar.js';

const CAMINHO_API = fileURLToPath(new URL('..', import.meta.url));

async function aguardarCondicao(condicao, { timeoutMs = 6000, intervaloMs = 20 } = {}) {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const valor = await condicao();
    if (valor) return valor;
    if (Date.now() >= prazo) throw new Error('aguardarCondicao: tempo esgotado');
    await esperar(intervaloMs);
  }
}

function saidaDeTeste() {
  const linhas = [];
  return { linhas, write(texto) { linhas.push(texto); } };
}

async function esgotarJob(aux, dados = {}) {
  const workers = aux.criarWorkers({ handlers: { sempreFalha: async () => { throw new Error('falha proposital'); } } });
  const job = await aux.filas.jobs.add('sempreFalha', dados);
  await aguardarCondicao(async () => {
    const atual = await aux.filas.jobs.getJob(job.id);
    return atual ? (await atual.getState()) === 'failed' : false;
  });
  // Fecha o worker antes de devolver: senão ele continua ativo e, ao
  // `reprocessar()` mover o job de volta para "waiting", pega o job de novo
  // (e volta a falhar) antes do teste conseguir observar o estado esperado.
  await workers.close();
  return job;
}

test('CA3: reprocessar() devolve um job esgotado para waiting com o mesmo id e attemptsMade zerado', async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);

  const job = await esgotarJob(aux);
  const saida = saidaDeTeste();
  const codigo = await reprocessar({ filas: aux.filas, jobId: job.id, saida });

  assert.equal(codigo, 0);
  const atualizado = await aux.filas.jobs.getJob(job.id);
  assert.equal(atualizado.id, job.id);
  assert.equal(await atualizado.getState(), 'waiting');
  assert.equal(atualizado.attemptsMade, 0);
  assert.ok(saida.linhas.join('').includes(job.id));
});

test('CA3: reprocessar() com jobId inexistente devolve código 1 e não cria chave nova', async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);

  await Promise.all([aux.filas.jobs.waitUntilReady(), aux.filas.alertas.waitUntilReady()]);
  const chavesAntes = new Set(await aux.conexao.keys(`${aux.prefixo}:*`));

  const codigo = await reprocessar({ filas: aux.filas, jobId: 'job-inexistente-ficticio', saida: saidaDeTeste() });
  assert.equal(codigo, 1);

  const chavesDepois = new Set(await aux.conexao.keys(`${aux.prefixo}:*`));
  assert.deepEqual(chavesDepois, chavesAntes);
});

test('CA3: reprocessar() com job em waiting devolve código 2 e não altera o job', async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);

  const job = await aux.filas.jobs.add('exemplo', {});

  const codigo = await reprocessar({ filas: aux.filas, jobId: job.id, saida: saidaDeTeste() });
  assert.equal(codigo, 2);

  const atualizado = await aux.filas.jobs.getJob(job.id);
  assert.equal(await atualizado.getState(), 'waiting');
  assert.equal(atualizado.attemptsMade, 0);
});

test('CA3: processo da CLI sem DATABASE_URL/CORS_ORIGENS sai 0 e não imprime dados do job', { timeout: 15000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);
  const job = await esgotarJob(aux, { requestId: 'req-ficticio-ca3-cli', pedidoId: '00000000-0000-4000-8000-000000000001' });

  const env = { PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste(), FILA_PREFIXO: aux.prefixo };
  const filho = spawn(process.execPath, ['src/cli/reprocessar.js', job.id], { cwd: CAMINHO_API, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  filho.stdout.on('data', (p) => { saida += p.toString('utf8'); });
  filho.stderr.on('data', (p) => { saida += p.toString('utf8'); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  const codigo = await new Promise((resolve) => filho.on('exit', resolve));

  assert.equal(codigo, 0);
  assert.ok(saida.includes(job.id));
  assert.ok(!saida.includes('req-ficticio-ca3-cli'), 'não deveria imprimir job.data (requestId)');
  assert.ok(!saida.includes('00000000-0000-4000-8000-000000000001'), 'não deveria imprimir job.data (pedidoId)');
});
