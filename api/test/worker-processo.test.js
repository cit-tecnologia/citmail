// CA6 — encerramento do processo do worker (`../src/worker.js`, `npm run
// worker`). Contrato real: loga "worker iniciado" ao subir; no SIGTERM/SIGINT
// loga "encerrando", espera `workers.close()` (job ativo termina) e sai 0 (1
// se o fechamento falhar); configuração inválida (sem REDIS_URL) imprime
// "Configuração inválida: REDIS_URL não definida" e sai 1, sem tocar
// DATABASE_URL/CORS_ORIGENS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as esperar } from 'node:timers/promises';
import { urlRedisTeste, criarFilasTeste } from './auxiliares.js';

const CAMINHO_API = fileURLToPath(new URL('..', import.meta.url));

async function aguardarCondicao(condicao, { timeoutMs = 15000, intervaloMs = 20 } = {}) {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const valor = await condicao();
    if (valor) return valor;
    if (Date.now() >= prazo) throw new Error('aguardarCondicao: tempo esgotado');
    await esperar(intervaloMs);
  }
}

function spawnWorker(env) {
  const filho = spawn(process.execPath, ['--import', './test/sem-rede.js', 'src/worker.js'], {
    cwd: CAMINHO_API,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saida = '';
  filho.stdout.on('data', (p) => { saida += p.toString('utf8'); });
  filho.stderr.on('data', (p) => { saida += p.toString('utf8'); });
  return { filho, obterSaida: () => saida };
}

test('CA6: SIGTERM no worker com job em andamento conclui o job antes de sair com código 0', { timeout: 25000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);

  const job = await aux.filas.jobs.add('exemplo', { requestId: 'req-ficticio-ca6', esperarMs: 1500 });

  const env = { PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste(), FILA_PREFIXO: aux.prefixo };
  const { filho, obterSaida } = spawnWorker(env);
  let codigoDeSaida;
  const encerrado = new Promise((resolve) => { filho.on('exit', (codigo) => { codigoDeSaida = codigo; resolve(); }); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await aguardarCondicao(() => obterSaida().includes('"job iniciado"'), { timeoutMs: 15000 });
  filho.kill('SIGTERM');
  await encerrado;

  assert.equal(codigoDeSaida, 0);
  const saida = obterSaida();
  const indiceEncerrando = saida.indexOf('"encerrando"');
  const indiceConcluido = saida.indexOf('"job concluído"');
  assert.ok(indiceEncerrando !== -1, 'esperava a linha "encerrando"');
  assert.ok(indiceConcluido !== -1, 'esperava a linha "job concluído"');
  assert.ok(indiceEncerrando < indiceConcluido, '"encerrando" deveria vir antes de "job concluído" (o fechamento espera o job ativo)');

  const atualizado = await aux.filas.jobs.getJob(job.id);
  assert.equal(await atualizado.getState(), 'completed');
});

test('Revisão: um segundo sinal durante o encerramento é ignorado (só uma linha "encerrando")', { timeout: 25000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(aux.fechar);

  await aux.filas.jobs.add('exemplo', { requestId: 'req-ficticio-ca6-dupla', esperarMs: 1500 });

  const env = { PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste(), FILA_PREFIXO: aux.prefixo };
  const { filho, obterSaida } = spawnWorker(env);
  let codigoDeSaida;
  const encerrado = new Promise((resolve) => { filho.on('exit', (codigo) => { codigoDeSaida = codigo; resolve(); }); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await aguardarCondicao(() => obterSaida().includes('"job iniciado"'), { timeoutMs: 15000 });
  filho.kill('SIGTERM');
  filho.kill('SIGINT'); // segundo sinal (diferente), quase junto: deveria ser ignorado.
  await encerrado;

  assert.equal(codigoDeSaida, 0);
  const ocorrencias = (obterSaida().match(/"encerrando"/g) ?? []).length;
  assert.equal(ocorrencias, 1, 'o segundo sinal não deveria gerar uma 2ª linha "encerrando"');
});

test('Revisão: em produção, o worker não registra o handler "exemplo" (job vai a "job desconhecido")', { timeout: 20000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const job = await aux.filas.jobs.add('exemplo', {});

  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    REDIS_URL: urlRedisTeste(),
    FILA_PREFIXO: aux.prefixo,
    TELEGRAM_BOT_TOKEN: 'TOKEN-FICTICIO',
    TELEGRAM_CHAT_ID: 'CHAT-FICTICIO',
  };
  const { filho } = spawnWorker(env);
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await aguardarCondicao(async () => {
    const atual = await aux.filas.jobs.getJob(job.id);
    return atual ? (await atual.getState()) === 'failed' : false;
  }, { timeoutMs: 15000 });

  const atualizado = await aux.filas.jobs.getJob(job.id);
  assert.equal(atualizado.failedReason, 'job desconhecido');
  filho.kill('SIGTERM');
});

test('CA6: worker sem REDIS_URL (e sem DATABASE_URL) sai com código 1 citando REDIS_URL', { timeout: 10000 }, async (t) => {
  const env = { PATH: process.env.PATH, NODE_ENV: 'test' };
  const { filho, obterSaida } = spawnWorker(env);
  let codigoDeSaida;
  const encerrado = new Promise((resolve) => { filho.on('exit', (codigo) => { codigoDeSaida = codigo; resolve(); }); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await encerrado;

  assert.equal(codigoDeSaida, 1);
  const saida = obterSaida();
  assert.match(saida, /REDIS_URL/);
  assert.ok(!saida.includes('DATABASE_URL'));
});
