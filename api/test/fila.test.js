// CA1 (tentativas, backoff e retenção), CA4 (persistência e travamento) e CA7
// (conferência de `fechar()`). Contrato real (ver `.omc/plans/CIT-56.md` e o
// código já implementado):
// - `./auxiliares.js`: `criarFilasTeste(opcoesFila)` (síncrono) devolve
//   `{ prefixo, conexao, filas: { jobs, alertas, close }, captura, log,
//   criarWorkers(opcoesWorkers), acompanhar(objeto), fechar() }`.
//   `criarWorkers()` já preenche `conexao`/`filas`/`prefixo`/`log` e usa por
//   padrão um `enviarAlerta` sem Telegram (só loga "alerta sem telegram");
//   os workers criados por ele são fechados pelo `fechar()`.
// - `../src/jobs/exemplo.js`: `jobExemplo` com a opção `esperarMs` (handler
//   padrão `exemplo` dos workers, `handlersPadrao` em `src/fila/worker.js`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as esperar } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { urlRedisTeste, criarFilasTeste } from './auxiliares.js';

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

async function estadoDoJob(fila, jobId) {
  const job = await fila.getJob(jobId);
  return job ? job.getState() : undefined;
}

test('CA1(a): job que sempre falha roda exatamente FILA_TENTATIVAS vezes, com "job falhou" (nível 50) e reqId/job corretos', async (t) => {
  const { filas, captura, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(fechar);

  criarWorkers({ handlers: { sempreFalha: async () => { throw new Error('falha proposital'); } } });

  const job = await filas.jobs.add('sempreFalha', { requestId: 'req-ficticio-1' });
  await aguardarCondicao(async () => (await estadoDoJob(filas.jobs, job.id)) === 'failed');

  const atualizado = await filas.jobs.getJob(job.id);
  assert.equal(atualizado.attemptsMade, 3);

  const linhasFalhou = captura.linhas().filter((l) => l.msg === 'job falhou' && l.reqId === 'req-ficticio-1');
  assert.equal(linhasFalhou.length, 3, 'eram esperadas 3 linhas "job falhou"');
  for (const linha of linhasFalhou) {
    assert.equal(linha.job, 'sempreFalha');
    assert.equal(linha.level, 50);
  }

  const temposIniciado = captura
    .linhas()
    .filter((l) => l.msg === 'job iniciado' && l.reqId === 'req-ficticio-1')
    .map((l) => l.time)
    .sort((a, b) => a - b);
  assert.equal(temposIniciado.length, 3);
  assert.ok(temposIniciado[1] - temposIniciado[0] >= 300, 'intervalo 1→2 deveria ser >= 300ms (backoffMs · 2^0)');
  assert.ok(temposIniciado[2] - temposIniciado[1] >= 600, 'intervalo 2→3 deveria ser >= 600ms (backoffMs · 2^1)');
});

// Mutação "backoff fixed": com 1 CPU o atraso de agendamento pode cobrir a
// diferença absoluta de 300ms entre os casos fixo e exponencial; backoffMs
// maior (500ms) separa melhor as duas razões (≈1× fixo, ≈2× exponencial).
test('CA1(a) mutação: a razão entre o 2º e o 1º intervalo de "job iniciado" confirma backoff exponencial', async (t) => {
  const { filas, captura, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 500 });
  t.after(fechar);

  criarWorkers({ handlers: { sempreFalha: async () => { throw new Error('falha proposital'); } } });

  const job = await filas.jobs.add('sempreFalha', { requestId: 'req-ficticio-1b' });
  await aguardarCondicao(async () => (await estadoDoJob(filas.jobs, job.id)) === 'failed');

  const temposIniciado = captura
    .linhas()
    .filter((l) => l.msg === 'job iniciado' && l.reqId === 'req-ficticio-1b')
    .map((l) => l.time)
    .sort((a, b) => a - b);
  assert.equal(temposIniciado.length, 3);

  const intervalo1 = temposIniciado[1] - temposIniciado[0];
  const intervalo2 = temposIniciado[2] - temposIniciado[1];
  assert.ok(intervalo2 / intervalo1 >= 1.6, `razão esperada >= 1,6 (exponencial ≈ 2×), obtida ${intervalo2 / intervalo1}`);
});

test('CA1(b): filas.jobs e filas.alertas nascem com attempts, backoff exponencial e retenção (removeOnComplete/removeOnFail)', async (t) => {
  const { filas, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);

  assert.deepEqual(filas.jobs.defaultJobOptions, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 300 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 2592000, count: 10000 },
    stackTraceLimit: 0,
  });
  assert.deepEqual(filas.alertas.defaultJobOptions, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 20 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 2592000, count: 1000 },
    stackTraceLimit: 0,
  });
});

test('Revisão: filas.jobs e filas.alertas limitam o stream de eventos a 1000 entradas (streams.events.maxLen)', async (t) => {
  const { filas, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(fechar);

  assert.equal(filas.jobs.opts.streams?.events?.maxLen, 1000);
  assert.equal(filas.alertas.opts.streams?.events?.maxLen, 1000);
});

test('CA1(c): job de nome desconhecido vai a "failed" com attemptsMade 1, failedReason e log "job desconhecido"', async (t) => {
  const { filas, captura, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(fechar);

  criarWorkers({ handlers: {} });

  const job = await filas.jobs.add('inexistente', {});
  await aguardarCondicao(async () => (await estadoDoJob(filas.jobs, job.id)) === 'failed');

  const atualizado = await filas.jobs.getJob(job.id);
  assert.equal(atualizado.attemptsMade, 1);
  assert.equal(atualizado.failedReason, 'job desconhecido');

  const linhasErro = captura.linhas().filter((l) => l.msg === 'job desconhecido' && l.level === 50);
  assert.equal(linhasErro.length, 1);
  assert.equal(linhasErro[0].jobId, job.id);
});

test('CA4(a): jobs enfileirados com o worker parado são concluídos por um worker iniciado depois', async (t) => {
  const { filas, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(fechar);

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const job = await filas.jobs.add('exemplo', { requestId: `req-ficticio-ca4a-${i}` });
    ids.push(job.id);
  }

  criarWorkers();

  for (const id of ids) {
    await aguardarCondicao(async () => (await estadoDoJob(filas.jobs, id)) === 'completed');
  }
});

test('CA4(b): job ativo num processo de worker morto com SIGKILL volta como "stalled" e é concluído por outra instância', { timeout: 30000 }, async (t) => {
  const { filas, prefixo, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300 });
  t.after(fechar);

  const job = await filas.jobs.add('exemplo', { requestId: 'req-ficticio-ca4b', esperarMs: 5000 });

  const filho = spawn(process.execPath, ['--import', './test/sem-rede.js', 'test/fixtures/worker-filho.js'], {
    cwd: CAMINHO_API,
    env: { PATH: process.env.PATH, REDIS_URL: urlRedisTeste(), FILA_PREFIXO: prefixo, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saidaFilho = '';
  filho.stdout.on('data', (p) => { saidaFilho += p.toString('utf8'); });
  filho.stderr.on('data', (p) => { saidaFilho += p.toString('utf8'); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await aguardarCondicao(() => saidaFilho.includes('"job iniciado"'), { timeoutMs: 10000 });
  filho.kill('SIGKILL');

  const workers = criarWorkers({ opcoesWorker: { lockDuration: 1000, stalledInterval: 500 } });

  let viuStalled = false;
  workers.jobs.on('stalled', (jobId) => { if (jobId === job.id) viuStalled = true; });

  await aguardarCondicao(async () => (await estadoDoJob(filas.jobs, job.id)) === 'completed', { timeoutMs: 25000 });
  assert.ok(viuStalled, 'esperava o evento "stalled" para o job travado');
});

test('Revisão: erro do job é saneado antes de ir ao BullMQ — failedReason só com o nome do erro, sem stacktrace', async (t) => {
  const { filas, criarWorkers, fechar } = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(fechar);

  const emailFicticio = 'fulano@exemplo.invalid';
  criarWorkers({ handlers: { sempreFalha: async () => { throw new Error(`falha ao processar ${emailFicticio}`); } } });

  const job = await filas.jobs.add('sempreFalha', {});
  await aguardarCondicao(async () => (await estadoDoJob(filas.jobs, job.id)) === 'failed');

  const atualizado = await filas.jobs.getJob(job.id);
  assert.equal(atualizado.failedReason, 'Error');
  assert.ok(!atualizado.failedReason.includes(emailFicticio));
  assert.equal(atualizado.stacktrace?.length ?? 0, 0);
});

test('Revisão: erro saneado preserva o code válido no formato "<name> (<code>)"', async (t) => {
  const { filas, criarWorkers, fechar } = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(fechar);

  criarWorkers({
    handlers: {
      sempreFalha: async () => {
        const erro = new Error('falha ao conectar a um endereço interno sensível');
        erro.code = 'ECONNREFUSED';
        throw erro;
      },
    },
  });

  const job = await filas.jobs.add('sempreFalha', {});
  await aguardarCondicao(async () => (await estadoDoJob(filas.jobs, job.id)) === 'failed');

  const atualizado = await filas.jobs.getJob(job.id);
  assert.equal(atualizado.failedReason, 'Error (ECONNREFUSED)');
});

test('CA7: fechar() lança se sobrar, após o obliterate, uma chave do prefixo sem TTL', async () => {
  const { conexao, prefixo, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300 });

  const chavePermanente = `${prefixo}:chave-permanente-de-teste`;
  await conexao.set(chavePermanente, '1');

  // `fechar()` apaga toda chave varrida (inclusive a sem TTL) antes de
  // lançar; não sobra estado para limpar manualmente depois.
  await assert.rejects(fechar());
});
