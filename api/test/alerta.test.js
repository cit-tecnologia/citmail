// CA2 — alerta de esgotado pelo Telegram. Contrato real (ver
// `.omc/plans/CIT-56.md` e o código já implementado):
// - `./auxiliares.js`: `criarCapturaDeLog()`, `criarFilasTeste(opcoesFila)`
//   (síncrono) → `{ prefixo, conexao, filas, captura, log, criarWorkers,
//   acompanhar, fechar }`; `criarWorkers(opcoesWorkers)` já preenche
//   `conexao`/`filas`/`prefixo`/`log` e usa por padrão um `enviarAlerta` sem
//   Telegram (só loga "alerta sem telegram").
// - `../src/log.js`: `criarLogger({ level, stream })`.
// - `../src/alertas/telegram.js`: `criarEnvioTelegram({ token, chatId, fetch,
//   log })` → `async ({ jobId, job, pedidoId }) => void`; sem token/chatId,
//   só loga `{ jobId, job, pedido }` em "alerta sem telegram" (nunca chama
//   `fetch`). Texto: `Job falhou: job=<jobId> tipo=<job> pedido=<id|->`.
//   Erro de rede: `warn({ erro: err.name }, 'envio ao telegram falhou')`.
//   Status != 2xx: `warn({ status }, 'envio ao telegram falhou')`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as esperar } from 'node:timers/promises';
import { criarCapturaDeLog, criarFilasTeste } from './auxiliares.js';
import { criarLogger } from '../src/log.js';
import { criarEnvioTelegram } from '../src/alertas/telegram.js';

const UUID_FICTICIO = '00000000-0000-4000-8000-000000000001';
const TOKEN_FICTICIO = 'TOKEN-FICTICIO';
const CHAT_FICTICIO = 'CHAT-FICTICIO';

async function aguardarCondicao(condicao, { timeoutMs = 6000, intervaloMs = 20 } = {}) {
  const prazo = Date.now() + timeoutMs;
  for (;;) {
    const valor = await condicao();
    if (valor) return valor;
    if (Date.now() >= prazo) throw new Error('aguardarCondicao: tempo esgotado');
    await esperar(intervaloMs);
  }
}

function criarFetchFalso(implementacao) {
  const chamadas = [];
  const fetchFalso = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return implementacao(url, opcoes, chamadas.length);
  };
  fetchFalso.chamadas = chamadas;
  return fetchFalso;
}

test('CA2(a)+(h): job esgotado gera 1 alerta em "alertas" com data {jobId, job, pedidoId} (campo "job", não mascarado) e 1 POST ao Telegram só com ids', async (t) => {
  const { filas, captura, log, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);

  const fetchFalso = criarFetchFalso(async () => ({ ok: true, status: 200 }));
  const enviarAlerta = criarEnvioTelegram({ token: TOKEN_FICTICIO, chatId: CHAT_FICTICIO, fetch: fetchFalso, log });

  criarWorkers({
    handlers: { sempreFalha: async () => { throw new Error('falha proposital'); } },
    enviarAlerta,
  });

  const job = await filas.jobs.add('sempreFalha', {
    requestId: 'req-ficticio-ca2a',
    pedidoId: UUID_FICTICIO,
    email: 'fulano@exemplo.invalid',
  });

  await aguardarCondicao(() => fetchFalso.chamadas.length === 1);

  const alertasConcluidos = await filas.alertas.getJobs(['completed']);
  assert.equal(alertasConcluidos.length, 1);
  assert.deepEqual(alertasConcluidos[0].data, { jobId: job.id, job: 'sempreFalha', pedidoId: UUID_FICTICIO });

  const { url, opcoes } = fetchFalso.chamadas[0];
  assert.equal(url, `https://api.telegram.org/bot${TOKEN_FICTICIO}/sendMessage`);
  assert.equal(opcoes.method, 'POST');
  const corpo = JSON.parse(opcoes.body);
  assert.equal(corpo.chat_id, CHAT_FICTICIO);
  assert.match(corpo.text, new RegExp(`job=${job.id}\\b`));
  assert.match(corpo.text, new RegExp(`pedido=${UUID_FICTICIO}\\b`));
  assert.ok(!corpo.text.includes('fulano'), 'o texto não deveria conter o email do payload');
  assert.ok(!JSON.stringify(corpo).includes('fulano'));

  // (h): o campo `job` (não `nome`) chega são ao log, sem passar pela
  // máscara de `camposSensiveis` (que mascararia um campo chamado `nome`).
  const linhaComJob = captura.linhas().find((l) => l.jobId === job.id || l.job === 'sempreFalha');
  assert.ok(linhaComJob, 'esperava alguma linha de log referenciando o job esgotado');
});

for (const pedidoId of ['abc', undefined, '-'.repeat(36)]) {
  test(`CA2(b): pedidoId inválido (${JSON.stringify(pedidoId)}) aparece como "pedido=-" no texto`, async () => {
    const captura = criarCapturaDeLog();
    const log = criarLogger({ level: 'info', stream: captura.stream });
    const fetchFalso = criarFetchFalso(async () => ({ ok: true, status: 200 }));
    const enviarAlerta = criarEnvioTelegram({ token: TOKEN_FICTICIO, chatId: CHAT_FICTICIO, fetch: fetchFalso, log });

    await enviarAlerta({ jobId: 'job-ficticio-ca2b', job: 'sempreFalha', pedidoId });

    assert.equal(fetchFalso.chamadas.length, 1);
    const corpo = JSON.parse(fetchFalso.chamadas[0].opcoes.body);
    assert.match(corpo.text, /pedido=-$/);
  });
}

test('CA2(c): falha de rede ou status != 2xx não vaza o token no log e lança ErroTelegram', async () => {
  const captura = criarCapturaDeLog();
  const log = criarLogger({ level: 'info', stream: captura.stream });

  const fetchQueRejeita = async () => {
    throw new TypeError('fetch failed', { cause: new Error(`https://api.telegram.org/bot${TOKEN_FICTICIO}/x`) });
  };
  const enviarAlertaRede = criarEnvioTelegram({ token: TOKEN_FICTICIO, chatId: CHAT_FICTICIO, fetch: fetchQueRejeita, log });
  await assert.rejects(enviarAlertaRede({ jobId: 'job-ficticio-ca2c-1', job: 'x', pedidoId: undefined }));

  const fetchQue401 = async () => ({ ok: false, status: 401 });
  const enviarAlerta401 = criarEnvioTelegram({ token: TOKEN_FICTICIO, chatId: CHAT_FICTICIO, fetch: fetchQue401, log });
  await assert.rejects(enviarAlerta401({ jobId: 'job-ficticio-ca2c-2', job: 'x', pedidoId: undefined }));

  assert.ok(!captura.texto().includes(TOKEN_FICTICIO), 'o token não deveria aparecer em nenhuma linha de log');

  const linhas = captura.linhas().filter((l) => l.msg === 'envio ao telegram falhou');
  assert.equal(linhas.length, 2);
  assert.equal(linhas[0].erro, 'TypeError');
  assert.equal(linhas[1].status, 401);
});

test('CA2(d): alerta que esgota não gera outro alerta e loga "alerta falhou"', async (t) => {
  const { filas, captura, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);

  criarWorkers({ enviarAlerta: async () => { throw new Error('telegram fora do ar'); } });

  await filas.alertas.add('job_esgotado', { jobId: 'job-ficticio-ca2d', job: 'sempreFalha', pedidoId: undefined });

  await aguardarCondicao(async () => (await filas.alertas.getJobCounts('failed')).failed === 1);

  const contagens = await filas.alertas.getJobCounts();
  const total = Object.values(contagens).reduce((soma, n) => soma + n, 0);
  assert.equal(total, 1, 'o alerta esgotado não deveria gerar outro job em "alertas"');
  assert.ok(captura.linhas().some((l) => l.msg === 'alerta falhou'));
});

test('CA2(e): limitador do worker de alertas espera em vez de descartar o excedente', async (t) => {
  const { filas, log, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);

  const fetchFalso = criarFetchFalso(async () => ({ ok: true, status: 200 }));
  const enviarAlerta = criarEnvioTelegram({ token: TOKEN_FICTICIO, chatId: CHAT_FICTICIO, fetch: fetchFalso, log });
  criarWorkers({ enviarAlerta, opcoesWorker: { limiter: { max: 2, duration: 1000 } } });

  const inicio = Date.now();
  for (let i = 0; i < 3; i++) {
    await filas.alertas.add('job_esgotado', { jobId: `job-ficticio-ca2e-${i}`, job: 'sempreFalha', pedidoId: undefined });
  }

  await aguardarCondicao(() => fetchFalso.chamadas.length === 3, { timeoutMs: 5000 });
  assert.ok(Date.now() - inicio >= 1000, 'o 3º envio deveria sair pelo menos 1000ms depois do 1º');
});

test('CA2(f): worker de alertas usa por padrão o limitador de 20 por minuto', async (t) => {
  const { criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);

  const workers = criarWorkers();
  assert.deepEqual(workers.alertas.opts.limiter, { max: 20, duration: 60000 });
});

test('CA2(g): job de nome desconhecido (irrecuperável) também gera um alerta', async (t) => {
  const { filas, log, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);

  const fetchFalso = criarFetchFalso(async () => ({ ok: true, status: 200 }));
  const enviarAlerta = criarEnvioTelegram({ token: TOKEN_FICTICIO, chatId: CHAT_FICTICIO, fetch: fetchFalso, log });
  criarWorkers({ enviarAlerta });

  await filas.jobs.add('inexistente', {});

  await aguardarCondicao(() => fetchFalso.chamadas.length === 1);
  assert.equal(fetchFalso.chamadas.length, 1);
});

test('CA2(i): erro no worker ou na fila nunca loga a mensagem original (host/porta/segredo), só err.name', async (t) => {
  const { filas, captura, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);
  const workers = criarWorkers();

  const chamadasConsoleError = [];
  const consoleErrorOriginal = console.error;
  console.error = (...args) => { chamadasConsoleError.push(args); };
  t.after(() => { console.error = consoleErrorOriginal; });

  workers.jobs.emit('error', new Error('redis://u:SENHA-FICTICIA@127.0.0.1'));
  filas.jobs.emit('error', new Error('redis://u:SENHA-FICTICIA@127.0.0.1'));
  await esperar(50);

  assert.ok(!captura.texto().includes('SENHA-FICTICIA'));
  assert.ok(captura.linhas().some((l) => l.msg === 'erro no worker'));
  assert.ok(captura.linhas().some((l) => l.msg === 'erro na fila'));
  assert.ok(
    !chamadasConsoleError.some((args) => args.some((a) => String(a).includes('SENHA-FICTICIA'))),
    'console.error não deveria ter recebido a mensagem com o segredo',
  );
});

test('CA2(j): o listener de esgotado não deixa rejeição sem tratamento (job sem getState, ou getState que rejeita)', async (t) => {
  const { captura, criarWorkers, fechar } = criarFilasTeste({ tentativas: 3, backoffMs: 300, alertaTentativas: 3, alertaBackoffMs: 20 });
  t.after(fechar);
  const workers = criarWorkers();

  let rejeicaoNaoTratada;
  const aoRejeitar = (erro) => { rejeicaoNaoTratada = erro; };
  process.on('unhandledRejection', aoRejeitar);
  t.after(() => process.off('unhandledRejection', aoRejeitar));

  workers.jobs.emit('failed', 'id-de-job-sem-getstate', new Error('x'), 'active');
  await esperar(50);
  assert.equal(rejeicaoNaoTratada, undefined, 'job sem getState não deveria gerar rejeição sem tratamento');

  workers.jobs.emit(
    'failed',
    { id: 'job-ficticio-ca2j', getState: async () => { throw new Error('redis indisponível'); } },
    new Error('x'),
    'active',
  );
  await aguardarCondicao(() => captura.linhas().some((l) => l.msg === 'alerta não enfileirado'));
  assert.equal(rejeicaoNaoTratada, undefined, 'getState que rejeita não deveria gerar rejeição sem tratamento');
});

test('CA5/CA2: sem token/chatId, criarEnvioTelegram só loga "alerta sem telegram" e nunca chama fetch', async () => {
  const captura = criarCapturaDeLog();
  const log = criarLogger({ level: 'info', stream: captura.stream });
  const fetchFalso = criarFetchFalso(async () => ({ ok: true, status: 200 }));
  const enviarAlerta = criarEnvioTelegram({ token: undefined, chatId: undefined, fetch: fetchFalso, log });

  await enviarAlerta({ jobId: 'job-ficticio-ca5', job: 'sempreFalha', pedidoId: UUID_FICTICIO });

  assert.equal(fetchFalso.chamadas.length, 0, 'não deveria chamar fetch sem token/chatId');
  const linha = captura.linhas().find((l) => l.msg === 'alerta sem telegram');
  assert.ok(linha, 'esperava a linha "alerta sem telegram"');
  assert.equal(linha.jobId, 'job-ficticio-ca5');
  assert.equal(linha.job, 'sempreFalha');
  assert.equal(linha.pedido, UUID_FICTICIO);
});
