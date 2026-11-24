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
import { Pool } from 'pg';
import { urlRedisTeste, criarFilasTeste, criarBancoTemporario, removerBancoTemporario, aplicarMigracoes } from './auxiliares.js';
import { criarStubAsaas } from './stub-asaas.js';
import { criarStubSmtp } from './stub-smtp.js';
import { estadoDoPedido, semearBruto, semearPagamentoNoStub, semearPedido } from './webhook-fixtures.js';

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

// CIT-166: o worker lê o banco (outbox); cada teste recebe um banco temporário migrado.
async function criarBancoParaWorker(t) {
  const { nomeBanco, url } = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(nomeBanco));
  await aplicarMigracoes(url);
  return url;
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
  const databaseUrl = await criarBancoParaWorker(t);

  const job = await aux.filas.jobs.add('exemplo', { requestId: 'req-ficticio-ca6', esperarMs: 1500 });

  const env = { PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste(), DATABASE_URL: databaseUrl, FILA_PREFIXO: aux.prefixo };
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
  const databaseUrl = await criarBancoParaWorker(t);

  await aux.filas.jobs.add('exemplo', { requestId: 'req-ficticio-ca6-dupla', esperarMs: 1500 });

  const env = { PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste(), DATABASE_URL: databaseUrl, FILA_PREFIXO: aux.prefixo };
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
  const databaseUrl = await criarBancoParaWorker(t);
  const job = await aux.filas.jobs.add('exemplo', {});

  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    REDIS_URL: urlRedisTeste(),
    DATABASE_URL: databaseUrl,
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

test('CA6: worker com REDIS_URL e sem DATABASE_URL sai com código 1 citando DATABASE_URL', { timeout: 10000 }, async (t) => {
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste() };
  const { filho, obterSaida } = spawnWorker(env);
  let codigoDeSaida;
  const encerrado = new Promise((resolve) => { filho.on('exit', (codigo) => { codigoDeSaida = codigo; resolve(); }); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await encerrado;

  assert.equal(codigoDeSaida, 1);
  assert.match(obterSaida(), /DATABASE_URL/);
});

test('CA6: o worker sobe o publicador ("publicador iniciado") e sai com código 0 no SIGTERM', { timeout: 20000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const databaseUrl = await criarBancoParaWorker(t);

  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    REDIS_URL: urlRedisTeste(),
    DATABASE_URL: databaseUrl,
    FILA_PREFIXO: aux.prefixo,
    OUTBOX_INTERVALO_MS: '100',
  };
  const { filho, obterSaida } = spawnWorker(env);
  let codigoDeSaida;
  const encerrado = new Promise((resolve) => { filho.on('exit', (codigo) => { codigoDeSaida = codigo; resolve(); }); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await aguardarCondicao(() => obterSaida().includes('"publicador iniciado"'), { timeoutMs: 15000 });
  filho.kill('SIGTERM');
  await encerrado;

  assert.equal(codigoDeSaida, 0);
  const saida = obterSaida();
  assert.ok(saida.includes('"worker iniciado"'));
  assert.ok(saida.includes('"encerrando"'));
});

// CIT-64: webhook do Asaas no processo do worker.
function aguardarSaida(obterSaida, filho, trecho) {
  return new Promise((resolve) => {
    const verificar = () => { if (obterSaida().includes(trecho)) resolve(); };
    filho.stdout.on('data', verificar);
    filho.stderr.on('data', verificar);
    verificar();
  });
}

test('CA13(a): com a flag ligada, o worker enfileira e processa um bruto pendente de ponta a ponta', { timeout: 30000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const databaseUrl = await criarBancoParaWorker(t);
  const stub = await criarStubAsaas();
  t.after(() => stub.fechar());
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const pedido = await semearPedido(admin);
  const referencia = `pedido:${pedido.pedidoId}:contas`;
  semearPagamentoNoStub(stub, { externalReference: referencia });
  await semearBruto(admin, { referenciaExterna: referencia });

  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    REDIS_URL: urlRedisTeste(),
    DATABASE_URL: databaseUrl,
    FILA_PREFIXO: aux.prefixo,
    OUTBOX_INTERVALO_MS: '100',
    ASAAS_API_KEY: 'CHAVE-FICTICIA',
    ASAAS_BASE_URL: stub.baseUrl,
  };
  const { filho, obterSaida } = spawnWorker(env);
  const encerrado = new Promise((resolve) => { filho.on('exit', resolve); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await Promise.race([
    aguardarSaida(obterSaida, filho, '"webhook processado"'),
    esperar(12000).then(() => { throw new Error(`worker sem processar o webhook; saída: ${obterSaida()}`); }),
  ]);
  filho.kill('SIGTERM');
  assert.equal(await encerrado, 0);

  assert.ok(obterSaida().includes('"enfileirador do webhook iniciado"'));
  const estado = (await estadoDoPedido(admin, pedido.pedidoId)).estado;
  await admin.end();
  assert.equal(estado, 'pago');
  assert.equal(stub.chamadasDe('GET /payments/{id}').length, 1);
});

test('CA13(a): em produção sem a flag, o worker não sobe o enfileirador nem registra o handler asaas_webhook', { timeout: 20000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const databaseUrl = await criarBancoParaWorker(t);
  const job = await aux.filas.jobs.add('asaas_webhook', { brutoId: '00000000-0000-4000-8000-000000000001' });

  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    REDIS_URL: urlRedisTeste(),
    DATABASE_URL: databaseUrl,
    FILA_PREFIXO: aux.prefixo,
    TELEGRAM_BOT_TOKEN: 'TOKEN-FICTICIO',
    TELEGRAM_CHAT_ID: 'CHAT-FICTICIO',
  };
  const { filho, obterSaida } = spawnWorker(env);
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await aguardarCondicao(async () => {
    const atual = await aux.filas.jobs.getJob(job.id);
    return atual ? (await atual.getState()) === 'failed' : false;
  }, { timeoutMs: 15000 });

  assert.equal((await aux.filas.jobs.getJob(job.id)).failedReason, 'job desconhecido');
  assert.ok(!obterSaida().includes('enfileirador do webhook iniciado'));
  filho.kill('SIGTERM');
});

test('CA13(c): em produção com a flag ligada e sem ASAAS_API_KEY, o worker sai com código 1 citando a variável', { timeout: 10000 }, async (t) => {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    REDIS_URL: urlRedisTeste(),
    DATABASE_URL: 'postgres://postgres@127.0.0.1:55433/postgres',
    TELEGRAM_BOT_TOKEN: 'TOKEN-FICTICIO',
    TELEGRAM_CHAT_ID: 'CHAT-FICTICIO',
    WEBHOOK_ASAAS_HABILITADO: 'true',
  };
  const { filho, obterSaida } = spawnWorker(env);
  const encerrado = new Promise((resolve) => { filho.on('exit', resolve); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  assert.equal(await encerrado, 1);
  assert.match(obterSaida(), /ASAAS_API_KEY/);
});

// CIT-65: e-mail transacional no processo do worker.
function envProducaoSemEmail(aux, databaseUrl, extra = {}) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    REDIS_URL: urlRedisTeste(),
    DATABASE_URL: databaseUrl,
    FILA_PREFIXO: aux.prefixo,
    TELEGRAM_BOT_TOKEN: 'TOKEN-FICTICIO',
    TELEGRAM_CHAT_ID: 'CHAT-FICTICIO',
    ...extra,
  };
}

test('CA8(g): em produção com o e-mail desligado, o worker loga um warn "e-mail desligado em produção"', { timeout: 20000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const databaseUrl = await criarBancoParaWorker(t);
  const { filho, obterSaida } = spawnWorker(envProducaoSemEmail(aux, databaseUrl));
  const encerrado = new Promise((resolve) => { filho.on('exit', resolve); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await Promise.race([
    aguardarSaida(obterSaida, filho, '"enfileirador de e-mail iniciado"'),
    encerrado.then(() => { throw new Error(`worker saiu antes de iniciar; saída: ${obterSaida()}`); }),
  ]);
  filho.kill('SIGTERM');
  await encerrado;

  const avisos = obterSaida().split('\n').filter((linha) => linha.includes('e-mail desligado em produção'));
  assert.equal(avisos.length, 1);
  assert.equal(JSON.parse(avisos[0]).level, 40);
});

test('CA8(g): em produção com smtp (host externo), o worker não loga o aviso de e-mail desligado', { timeout: 20000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const databaseUrl = await criarBancoParaWorker(t);
  const env = envProducaoSemEmail(aux, databaseUrl, {
    EMAIL_TRANSPORTE: 'smtp', SMTP_HOST: 'smtp.exemplo.test', SMTP_USUARIO: 'usuario-ficticio', SMTP_SENHA: 'SenhaSmtpFicticia-123',
  });
  const { filho, obterSaida } = spawnWorker(env);
  const encerrado = new Promise((resolve) => { filho.on('exit', resolve); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await Promise.race([
    aguardarSaida(obterSaida, filho, '"enfileirador de e-mail iniciado"'),
    encerrado.then(() => { throw new Error(`worker saiu antes de iniciar; saída: ${obterSaida()}`); }),
  ]);
  filho.kill('SIGTERM');
  await encerrado;
  assert.ok(!obterSaida().includes('e-mail desligado em produção'));
  assert.ok(!obterSaida().includes('SenhaSmtpFicticia-123'));
});

test('CA8: o worker com SMTP_SENHA ausente e transporte smtp sai com código 1 citando a variável, sem os outros valores', { timeout: 10000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const databaseUrl = await criarBancoParaWorker(t);
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste(), DATABASE_URL: databaseUrl, FILA_PREFIXO: aux.prefixo,
    EMAIL_TRANSPORTE: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_USUARIO: 'usuario-ficticio',
  };
  const { filho, obterSaida } = spawnWorker(env);
  const codigo = await new Promise((resolve) => { filho.on('exit', resolve); });
  assert.equal(codigo, 1);
  assert.ok(obterSaida().includes('SMTP_SENHA não definida'));
  assert.ok(!obterSaida().includes('usuario-ficticio'));
});

test('CA1: o worker enfileira e envia pelo SMTP de teste uma linha pendente do teste_exemplo, de ponta a ponta', { timeout: 30000 }, async (t) => {
  const aux = criarFilasTeste({ tentativas: 1, backoffMs: 300 });
  t.after(aux.fechar);
  const databaseUrl = await criarBancoParaWorker(t);
  const stub = await criarStubSmtp();
  t.after(() => stub.fechar());
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const pedido = await semearPedido(admin, { email: 'fulano@exemplo.test' });
  const { rows } = await admin.query(
    "INSERT INTO email_envio (chave_idempotencia, modelo, versao_modelo, refs) VALUES ('worker-ponta-a-ponta', 'teste_exemplo', 1, $1) RETURNING id",
    [{ pedidoId: pedido.pedidoId }],
  );

  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', REDIS_URL: urlRedisTeste(), DATABASE_URL: databaseUrl, FILA_PREFIXO: aux.prefixo,
    OUTBOX_INTERVALO_MS: '100', EMAIL_TRANSPORTE: 'smtp', SMTP_HOST: stub.host, SMTP_PORTA: String(stub.porta),
    SMTP_USUARIO: 'usuario-ficticio', SMTP_SENHA: 'SenhaSmtpFicticia-123', EMAIL_REMETENTE: 'CITMail <naoresponda@exemplo.test>',
  };
  const { filho, obterSaida } = spawnWorker(env);
  const encerrado = new Promise((resolve) => { filho.on('exit', resolve); });
  t.after(() => { if (filho.exitCode === null) filho.kill('SIGKILL'); });

  await Promise.race([
    stub.aguardarMensagens(1),
    encerrado.then(() => { throw new Error(`worker saiu antes de enviar; saída: ${obterSaida()}`); }),
  ]);
  await aguardarSaida(obterSaida, filho, '"e-mail enviado"');
  filho.kill('SIGTERM');
  assert.equal(await encerrado, 0);

  assert.deepEqual(stub.mensagens[0].rcptTo, ['fulano@exemplo.test']);
  assert.equal(stub.mensagens[0].mailFrom, 'naoresponda@exemplo.test');
  const gravada = (await admin.query('SELECT estado, destinatario_mascarado FROM email_envio WHERE id = $1', [rows[0].id])).rows[0];
  await admin.end();
  assert.deepEqual(gravada, { estado: 'enviado', destinatario_mascarado: 'f***@exemplo.test' });
  for (const proibido of ['fulano@exemplo.test', 'Fulano Ficticio', 'SenhaSmtpFicticia-123']) {
    assert.ok(!obterSaida().includes(proibido), `saída do worker com ${proibido}`);
  }
});
