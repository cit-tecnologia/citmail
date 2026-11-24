// CIT-65, e-mail transacional de ponta a ponta (CA1 a CA3, CA6 a CA9): enfileirador real,
// workers reais do BullMQ (Redis de teste), transporte SMTP real (`nodemailer`) contra o stub
// `node:net` em 127.0.0.1 e banco temporário migrado, no papel da aplicação. O stub ECOA o
// endereço nas respostas 4xx/5xx, como servidores reais: o log, o `failedReason` e o alerta não
// podem carregá-lo. Dados fictícios.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { enfileirarEmails, iniciarEnfileiradorEmail, jobIdEmail } from '../src/email/enfileirador.js';
import { modelosForaDeProducao } from '../src/email/modelos/index.js';
import { reiniciarEnvio } from '../src/email/repositorio.js';
import { criarHandlerEmail, JOB_EMAIL } from '../src/email/servico.js';
import { criarTransporte } from '../src/email/transporte.js';
import { criarFilasTeste } from './auxiliares.js';
import {
  ASSUNTO, ENDERECO, linhaDe, NOME, pedirEnvio, REMETENTE, SENHA_SMTP, solicitar
} from './email-fixtures.js';
import { criarStubSmtp } from './stub-smtp.js';
import { criarBancoWebhook } from './webhook-fixtures.js';

let banco;

before(async () => {
  banco = await criarBancoWebhook();
});

after(() => banco.fechar());

beforeEach(() => banco.admin.query('TRUNCATE email_envio, evento_processado, evento, assinatura, pedido_dominio, pedido, cliente CASCADE'));

function aguardar(emissor, evento) {
  return new Promise((resolver) => emissor.once(evento, resolver));
}

/**
 * Monta filas + workers + handler + stub SMTP. `usar(transporte)` troca o transporte do handler
 * (CA6 e). `alertas` junta o que o worker de alertas entregaria ao Telegram; `alertado` resolve
 * no primeiro. `semWorkers` só cria as filas (enfileirador sem consumo).
 */
async function montar(t, {
  tentativas = 3, backoffMs = 50, stub: opcoesStub = {}, modelos = modelosForaDeProducao, semWorkers = false, desligado = false
} = {}) {
  const aux = criarFilasTeste({ tentativas, backoffMs });
  const stub = await criarStubSmtp(opcoesStub);
  const config = {
    emailTransporte: desligado ? 'desligado' : 'smtp',
    smtpHost: stub.host,
    smtpPorta: stub.porta,
    smtpUsuario: 'usuario-ficticio',
    smtpSenha: SENHA_SMTP,
    smtpTimeoutMs: 3000,
    smtpRequireTls: false
  };
  const transportes = [criarTransporte(config)];
  let atual = transportes[0];
  const proxy = {
    get ligado() { return atual.ligado; },
    enviar: (mensagem) => atual.enviar(mensagem)
  };
  const alertas = [];
  let avisar;
  const alertado = new Promise((resolver) => { avisar = resolver; });
  let workers = null;
  if (!semWorkers) {
    const handler = criarHandlerEmail({ pool: banco.app, modelos, transporte: proxy, remetente: REMETENTE, log: aux.log });
    workers = aux.criarWorkers({
      handlers: { [JOB_EMAIL]: handler },
      enviarAlerta: async (dados) => { alertas.push(dados); avisar(dados); }
    });
  }
  t.after(async () => {
    await aux.fechar();
    for (const transporte of transportes) transporte.close();
    await stub.fechar();
  });
  return {
    aux,
    stub,
    workers,
    alertas,
    alertado,
    usar(config2) {
      const novo = criarTransporte(config2);
      transportes.push(novo);
      atual = novo;
    },
    configSmtp: config,
    ciclo: (extra = {}) => enfileirarEmails({ pool: banco.app, filas: aux.filas, log: aux.log, ...extra }),
    // Texto de tudo que sai pelo log, para os testes de ausência de dado pessoal.
    log: () => aux.captura.texto()
  };
}

function semDadoPessoal(texto, descricao) {
  for (const proibido of [ENDERECO, NOME, ASSUNTO, SENHA_SMTP]) {
    assert.ok(!texto.includes(proibido), `${descricao} contém ${proibido}`);
  }
}

// Remove as quebras suaves do quoted-printable e separa as partes do multipart.
function mensagemDecodificada(data) {
  return data.replace(/=\r\n/g, '');
}

function parteDe(data, tipo) {
  const decodificada = mensagemDecodificada(data);
  const inicio = decodificada.search(new RegExp(`Content-Type: ${tipo}`, 'i'));
  assert.notEqual(inicio, -1, `sem parte ${tipo}`);
  const proxima = decodificada.slice(inicio + 10).search(/Content-Type: /i);
  return proxima === -1 ? decodificada.slice(inicio) : decodificada.slice(inicio, inicio + 10 + proxima);
}

test('CA1: linha pendente é enfileirada e enviada ao stub com remetente, destinatário, assunto e nome nas duas partes', async (t) => {
  const m = await montar(t);
  const { id } = await pedirEnvio(banco);

  const concluido = aguardar(m.workers.jobs, 'completed');
  assert.deepEqual(await m.ciclo(), { enfileirados: 1, parados: 0 });
  await concluido;

  assert.equal(m.stub.mensagens.length, 1);
  const recebida = m.stub.mensagens[0];
  assert.equal(recebida.mailFrom, 'naoresponda@exemplo.test');
  assert.deepEqual(recebida.rcptTo, [ENDERECO]);
  assert.match(recebida.data, new RegExp(`^Subject: ${ASSUNTO}\\r?$`, 'm'));
  assert.ok(parteDe(recebida.data, 'text/plain').includes(NOME), 'texto sem o nome');
  assert.ok(parteDe(recebida.data, 'text/html').includes(NOME), 'HTML sem o nome');

  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'enviado');
  assert.ok(gravada.enviado_em instanceof Date);
  assert.ok(gravada.message_id);
  assert.equal(gravada.tentativas, 1);
  assert.equal(gravada.versao_modelo, 1);
  assert.ok(gravada.enfileirado_em instanceof Date);
});

test('CA3: a linha gravada e o log do envio bem-sucedido não têm endereço, nome, assunto nem senha', async (t) => {
  const m = await montar(t);
  const { id } = await pedirEnvio(banco);
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;

  const { rows } = await banco.admin.query('SELECT row_to_json(e)::text AS json FROM email_envio e WHERE id = $1', [id]);
  assert.ok(rows[0].json.includes('f***@exemplo.test'));
  assert.ok(rows[0].json.includes('teste_exemplo'));
  assert.ok(rows[0].json.includes('enviado'));
  semDadoPessoal(rows[0].json, 'linha de email_envio');
  semDadoPessoal(m.log(), 'log do envio');
  const job = await m.aux.filas.jobs.getJob(jobIdEmail(id, 1));
  semDadoPessoal(JSON.stringify(job.data), 'dados do job');
});

test('CA2(a): 451 no RCPT na 1ª tentativa e aceite na 2ª conclui o job, grava enviado com 2 tentativas e 1 DATA', async (t) => {
  const m = await montar(t, { stub: { rcpt: ['451', '250'] } });
  const { id } = await pedirEnvio(banco);
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;

  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'enviado');
  assert.equal(gravada.tentativas, 2);
  assert.equal(m.stub.mensagens.length, 1);
  assert.equal((await m.aux.filas.jobs.getJob(jobIdEmail(id, 1))).attemptsMade, 2);
  assert.deepEqual(m.alertas, []);
});

test('CA2(b): conexão recusada na 1ª tentativa e stub ativo na 2ª conclui o job com 2 tentativas', async (t) => {
  const m = await montar(t);
  await m.stub.parar();
  const { id } = await pedirEnvio(banco);
  const primeiraFalha = aguardar(m.workers.jobs, 'failed').then(() => m.stub.iniciar());
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await primeiraFalha;
  await concluido;

  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'enviado');
  assert.equal(gravada.tentativas, 2);
  assert.equal(m.stub.mensagens.length, 1);
});

test('CA2(b): a falha de conexão grava só um código (sem host nem porta) e não vira alerta', async (t) => {
  const m = await montar(t, { tentativas: 1 });
  await m.stub.parar();
  const { id } = await pedirEnvio(banco);
  const falhou = aguardar(m.workers.jobs, 'failed');
  await m.ciclo();
  await falhou;
  await m.alertado;

  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'falhou');
  assert.match(gravada.erro_codigo, /^[A-Z0-9_]{1,32}$/);
  assert.ok(!m.log().includes(`127.0.0.1:${m.stub.porta}`), 'log com host:porta');
});

test('CA2(c): 451 em todas as tentativas esgota o job, grava falhou com 451 e enfileira um só alerta job_esgotado', async (t) => {
  const m = await montar(t, { stub: { rcpt: ['451'] } });
  const { id } = await pedirEnvio(banco);
  await m.ciclo();
  const alerta = await m.alertado;

  assert.deepEqual(alerta, { jobId: `email_enviar-${id}-1`, job: 'email_enviar', pedidoId: '-' });
  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'falhou');
  assert.equal(gravada.erro_codigo, '451');
  assert.equal(gravada.tentativas, 3);
  const job = await m.aux.filas.jobs.getJob(jobIdEmail(id, 1));
  assert.equal(await job.getState(), 'failed');
  assert.equal(job.attemptsMade, 3);
  assert.equal(m.stub.mensagens.length, 0);
  assert.equal(m.stub.conexoes, 3);
  assert.equal(m.alertas.length, 1);
  const contagem = await m.aux.filas.alertas.getJobCounts();
  assert.equal(Object.values(contagem).reduce((soma, n) => soma + n, 0), 1);
});

test('CA3: com o stub ecoando o endereço no 451, o log, o failedReason e o alerta não têm endereço, nome, assunto nem senha', async (t) => {
  const m = await montar(t, { stub: { rcpt: ['451'] } });
  const { id } = await pedirEnvio(banco);
  await m.ciclo();
  const alerta = await m.alertado;

  const job = await m.aux.filas.jobs.getJob(jobIdEmail(id, 1));
  assert.equal(job.failedReason, 'ErroEmail (EENVELOPE)');
  semDadoPessoal(job.failedReason, 'failedReason');
  semDadoPessoal(JSON.stringify(job.stacktrace ?? []), 'stacktrace do job');
  semDadoPessoal(JSON.stringify(alerta), 'dados do alerta');
  semDadoPessoal(m.log(), 'log do 451');
  const falhas = m.aux.captura.linhas().filter((l) => l.msg === 'envio de e-mail falhou');
  assert.equal(falhas.length, 3);
  assert.equal(falhas[0].erro_codigo, '451');
  assert.equal(falhas[2].estado, 'falhou');
});

test('CA2(d): 550 no RCPT falha o job na 1ª tentativa, sem retry, grava falhou com 550 e enfileira o alerta', async (t) => {
  const m = await montar(t, { stub: { rcpt: ['550'] } });
  const { id } = await pedirEnvio(banco);
  await m.ciclo();
  const alerta = await m.alertado;

  assert.deepEqual(alerta, { jobId: `email_enviar-${id}-1`, job: 'email_enviar', pedidoId: '-' });
  const job = await m.aux.filas.jobs.getJob(jobIdEmail(id, 1));
  assert.equal(await job.getState(), 'failed');
  assert.equal(job.attemptsMade, 1);
  assert.equal(m.stub.conexoes, 1);
  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'falhou');
  assert.equal(gravada.erro_codigo, '550');
  semDadoPessoal(job.failedReason, 'failedReason do 550');
  semDadoPessoal(m.log(), 'log do 550');
});

test('CA2(e): pedido inexistente (sem destinatário) grava nao_enviado com SEM_DESTINATARIO, conclui o job e não alerta', async (t) => {
  const m = await montar(t);
  const { id } = await solicitar(banco, {
    chaveIdempotencia: 'sem-destinatario', modelo: 'teste_exemplo', refs: { pedidoId: '00000000-0000-4000-8000-000000000009' }
  });
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;

  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'nao_enviado');
  assert.equal(gravada.erro_codigo, 'SEM_DESTINATARIO');
  assert.equal(m.stub.conexoes, 0);
  assert.deepEqual(m.alertas, []);
  assert.equal((await m.aux.filas.alertas.getJobCounts()).waiting, 0);
});

test('CA2(f): linha com modelo fora do registro falha o job na 1ª tentativa, sem retry, e alerta', async (t) => {
  const m = await montar(t);
  const { rows } = await banco.admin.query(
    "INSERT INTO email_envio (chave_idempotencia, modelo, versao_modelo) VALUES ('modelo-removido', 'modelo_removido', 1) RETURNING id"
  );
  await m.ciclo();
  const alerta = await m.alertado;

  const job = await m.aux.filas.jobs.getJob(jobIdEmail(rows[0].id, 1));
  assert.equal(await job.getState(), 'failed');
  assert.equal(job.attemptsMade, 1);
  assert.equal(job.failedReason, 'UnrecoverableError');
  assert.equal(alerta.jobId, `email_enviar-${rows[0].id}-1`);
  assert.equal(m.stub.conexoes, 0);
});

test('CA6(b): dois ciclos do enfileirador criam um só job e o segundo não reenfileira', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const { id } = await pedirEnvio(banco);

  assert.deepEqual(await m.ciclo(), { enfileirados: 1, parados: 0 });
  assert.deepEqual(await m.ciclo(), { enfileirados: 0, parados: 0 });
  const contagem = await m.aux.filas.jobs.getJobCounts();
  assert.equal(Object.values(contagem).reduce((soma, n) => soma + n, 0), 1);
  const job = await m.aux.filas.jobs.getJob(jobIdEmail(id, 1));
  assert.equal(job.name, JOB_EMAIL);
  assert.deepEqual(job.data, { envioId: id, geracao: 1 });
});

test('CA6(b): addBulk que rejeita deixa enfileirado_em nulo, loga só o nome do erro e o ciclo seguinte enfileira', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const { id } = await pedirEnvio(banco);
  const quebrada = {
    jobs: { async addBulk() { throw Object.assign(new Error('redis em 10.0.0.9:6379 fora'), { name: 'ErroRedis', code: 'ECONNREFUSED' }); } },
    alertas: m.aux.filas.alertas
  };

  const falha = await enfileirarEmails({ pool: banco.app, filas: quebrada, log: m.aux.log });
  assert.equal(falha.enfileirados, 0);
  assert.equal((await linhaDe(banco, id)).enfileirado_em, null);
  assert.ok(!m.log().includes('10.0.0.9'));
  assert.ok(m.aux.captura.linhas().some((l) => l.msg === 'enfileiramento de e-mail falhou' && l.erro === 'ErroRedis'));

  assert.deepEqual(await m.ciclo(), { enfileirados: 1, parados: 0 });
  assert.ok((await linhaDe(banco, id)).enfileirado_em instanceof Date);
});

test('CA6(b): o laço do enfileirador cria o job no primeiro ciclo e close() espera o ciclo em curso', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const { id } = await pedirEnvio(banco);
  const ciclos = [];
  let primeiro;
  const primeiroCiclo = new Promise((resolver) => { primeiro = resolver; });
  const laco = iniciarEnfileiradorEmail({
    pool: banco.app, filas: m.aux.filas, log: m.aux.log, intervaloMs: 20,
    aoCiclo: (resultado) => { ciclos.push(resultado); primeiro(); }
  });
  await primeiroCiclo;
  await laco.close();
  assert.deepEqual(ciclos[0], { enfileirados: 1, parados: 0 });
  assert.ok(await m.aux.filas.jobs.getJob(jobIdEmail(id, 1)));
  const total = ciclos.length;
  await laco.close();
  assert.equal(ciclos.length, total);
});

test('CA6(c): job da geração 1 entregue de novo depois de enviado não gera novo DATA no stub', async (t) => {
  const m = await montar(t);
  const { id } = await pedirEnvio(banco);
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;
  assert.equal(m.stub.mensagens.length, 1);

  const repetido = aguardar(m.workers.jobs, 'completed');
  await m.aux.filas.jobs.add(JOB_EMAIL, { envioId: id, geracao: 1 }, { jobId: `${JOB_EMAIL}-${id}-1-reentrega` });
  await repetido;
  assert.equal(m.stub.mensagens.length, 1);
  assert.equal((await linhaDe(banco, id)).tentativas, 1);
});

test('CA6(d): linha falhou (550) passa pelo reset, vira geração 2, ganha o job email_enviar-<id>-2 e é enviada', async (t) => {
  const m = await montar(t, { stub: { rcpt: ['550'] } });
  const { id } = await pedirEnvio(banco);
  await m.ciclo();
  await m.alertado;
  assert.equal((await linhaDe(banco, id)).estado, 'falhou');

  m.stub.definirRcpt(['250']);
  assert.equal(await reiniciarEnvio(banco.app, id), true);
  const concluido = aguardar(m.workers.jobs, 'completed');
  assert.deepEqual(await m.ciclo(), { enfileirados: 1, parados: 0 });
  await concluido;

  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'enviado');
  assert.equal(gravada.geracao, 2);
  assert.equal(gravada.tentativas, 1);
  assert.ok(await m.aux.filas.jobs.getJob(`email_enviar-${id}-2`));
  assert.equal(m.stub.mensagens.length, 1);
});

test('CA6(e): linha nao_enviado (transporte desligado) passa pelo reset e, com smtp, é enviada', async (t) => {
  const m = await montar(t, { desligado: true });
  const { id } = await pedirEnvio(banco);
  const primeiro = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await primeiro;
  assert.equal((await linhaDe(banco, id)).estado, 'nao_enviado');
  assert.equal(m.stub.conexoes, 0);

  m.usar({ ...m.configSmtp, emailTransporte: 'smtp' });
  assert.equal(await reiniciarEnvio(banco.app, id), true);
  const segundo = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await segundo;
  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'enviado');
  assert.equal(gravada.geracao, 2);
  assert.equal(m.stub.mensagens.length, 1);
});

test('CA6(f): reiniciar linha enviada não altera nenhuma linha e não gera job novo', async (t) => {
  const m = await montar(t);
  const { id } = await pedirEnvio(banco);
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;
  assert.equal(await reiniciarEnvio(banco.app, id), false);
  assert.deepEqual(await m.ciclo(), { enfileirados: 0, parados: 0 });
  assert.equal((await linhaDe(banco, id)).geracao, 1);
});

test('CA7: nome com script e aspas sai escapado no HTML, literal no texto e sem <script>', async (t) => {
  const m = await montar(t);
  const ataque = '<script>alert(1)</script> & "x"';
  await pedirEnvio(banco, { nome: ataque });
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;

  const { data } = m.stub.mensagens[0];
  assert.ok(parteDe(data, 'text/html').includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;'));
  assert.ok(!parteDe(data, 'text/html').includes('<script'));
  assert.ok(parteDe(data, 'text/plain').includes(ataque));
});

test('CA7: nome com CR/LF e Bcc injetado gera um só RCPT, nenhum cabeçalho Bcc e assunto numa linha', async (t) => {
  const m = await montar(t);
  await pedirEnvio(banco, { nome: 'Ana\r\nBcc: outro@exemplo.test' });
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;

  const recebida = m.stub.mensagens[0];
  assert.deepEqual(recebida.rcptTo, [ENDERECO]);
  const cabecalho = recebida.data.split(/\r\n\r\n/)[0];
  assert.ok(!/^Bcc:/im.test(cabecalho), 'cabeçalho Bcc injetado');
  const assunto = cabecalho.match(/^Subject: (.*)$/m)[1];
  assert.equal(assunto, 'Teste do CITMail para AnaBcc: outro@exemplo.test');
});

test('CA8(f): transporte desligado grava nao_enviado sem tentativa, conclui o job, não conecta ao stub e não alerta', async (t) => {
  const m = await montar(t, { desligado: true });
  const { id } = await pedirEnvio(banco);
  const concluido = aguardar(m.workers.jobs, 'completed');
  await m.ciclo();
  await concluido;

  const gravada = await linhaDe(banco, id);
  assert.equal(gravada.estado, 'nao_enviado');
  assert.equal(gravada.tentativas, 0);
  assert.equal(gravada.erro_codigo, null);
  assert.equal(m.stub.conexoes, 0);
  assert.deepEqual(m.alertas, []);
  assert.equal((await m.aux.filas.alertas.getJobCounts()).waiting, 0);
});

// Linhas do CA9: sem workers, com o enfileirador de verdade; a fila `jobs` quebrada mantém as
// linhas nunca enfileiradas, como com o Redis fora por horas.
async function semearParados() {
  const antiga = await pedirEnvio(banco);
  await banco.admin.query("UPDATE email_envio SET enfileirado_em = now() - interval '2 hours' WHERE id = $1", [antiga.id]);
  const nunca = await pedirEnvio(banco);
  await banco.admin.query("UPDATE email_envio SET criado_em = now() - interval '2 hours' WHERE id = $1", [nunca.id]);
  const recente = await pedirEnvio(banco);
  const concluida = await pedirEnvio(banco);
  await banco.admin.query(
    "UPDATE email_envio SET estado = 'enviado', criado_em = now() - interval '2 hours', enfileirado_em = now() - interval '2 hours' WHERE id = $1",
    [concluida.id]
  );
  return { antiga: antiga.id, nunca: nunca.id, recente: recente.id, concluida: concluida.id };
}

function filasComJobsQuebrada(aux) {
  return { jobs: { async addBulk() { throw new Error('redis fora'); } }, alertas: aux.filas.alertas };
}

test('CA9: pendente enfileirada há 2 h e pendente nunca enfileirada há 2 h geram 2 alertas email_parado, uma vez só', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const ids = await semearParados();
  const filas = filasComJobsQuebrada(m.aux);

  const primeiro = await enfileirarEmails({ pool: banco.app, filas, log: m.aux.log, paradoHoras: 1 });
  assert.equal(primeiro.parados, 2);
  const jobs = await m.aux.filas.alertas.getJobs(['waiting']);
  assert.deepEqual(
    jobs.map((job) => job.data).sort((a, b) => a.envioId.localeCompare(b.envioId)),
    [ids.antiga, ids.nunca].sort().map((envioId) => ({ tipo: 'email_parado', envioId }))
  );
  for (const id of [ids.antiga, ids.nunca]) {
    assert.ok((await linhaDe(banco, id)).alertado_parado_em instanceof Date);
  }
  assert.equal((await linhaDe(banco, ids.recente)).alertado_parado_em, null);
  assert.equal((await linhaDe(banco, ids.concluida)).alertado_parado_em, null);

  const segundo = await enfileirarEmails({ pool: banco.app, filas, log: m.aux.log, paradoHoras: 1 });
  assert.equal(segundo.parados, 0);
  assert.equal((await m.aux.filas.alertas.getJobs(['waiting'])).length, 2);
});

test('CA9: linha recente (menos de 1 h) e linha já enviada não geram alerta', async (t) => {
  const m = await montar(t, { semWorkers: true });
  await pedirEnvio(banco);
  const { concluida } = await semearParados();
  await banco.admin.query('DELETE FROM email_envio WHERE id <> $1', [concluida]);
  await pedirEnvio(banco);
  const resultado = await enfileirarEmails({ pool: banco.app, filas: filasComJobsQuebrada(m.aux), log: m.aux.log, paradoHoras: 1 });
  assert.equal(resultado.parados, 0);
  assert.equal((await m.aux.filas.alertas.getJobCounts()).waiting, 0);
});

test('CA9: o padrão de 6 horas não alerta a linha de 2 horas', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const { antiga } = await semearParados();
  await banco.admin.query('DELETE FROM email_envio WHERE id <> $1', [antiga]);
  const resultado = await enfileirarEmails({ pool: banco.app, filas: filasComJobsQuebrada(m.aux), log: m.aux.log });
  assert.equal(resultado.parados, 0);
});

test('CA9: depois do reset da linha parada (nova geração), um novo atraso gera novo alerta', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const { id } = await pedirEnvio(banco);
  await banco.admin.query("UPDATE email_envio SET enfileirado_em = now() - interval '2 hours' WHERE id = $1", [id]);
  const filas = filasComJobsQuebrada(m.aux);
  assert.equal((await enfileirarEmails({ pool: banco.app, filas, log: m.aux.log, paradoHoras: 1 })).parados, 1);

  await banco.admin.query("UPDATE email_envio SET estado = 'falhou' WHERE id = $1", [id]);
  await reiniciarEnvio(banco.app, id);
  await banco.admin.query("UPDATE email_envio SET criado_em = now() - interval '2 hours' WHERE id = $1", [id]);
  assert.equal((await enfileirarEmails({ pool: banco.app, filas, log: m.aux.log, paradoHoras: 1 })).parados, 1);
  const jobs = await m.aux.filas.alertas.getJobs(['waiting']);
  assert.deepEqual(jobs.map((job) => job.id).sort(), [`alerta-email_parado-${id}-1`, `alerta-email_parado-${id}-2`]);
});

test('CA3: o transporte real recusa anexo por arquivo e por URL (disableFileAccess e disableUrlAccess)', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const transporte = criarTransporte(m.configSmtp);
  t.after(() => transporte.close());
  const base = { from: REMETENTE, to: ENDERECO, subject: 'x', text: 'y' };

  await assert.rejects(transporte.enviar({ ...base, attachments: [{ path: new URL(import.meta.url).pathname }] }), { message: /File access rejected/ });
  await assert.rejects(transporte.enviar({ ...base, text: { href: 'http://127.0.0.1:9/x' } }), { message: /Url access rejected/ });
  assert.equal(m.stub.mensagens.length, 0);
});

test('CA8(f): o transporte desligado não abre conexão e enviar lança', async (t) => {
  const m = await montar(t, { semWorkers: true });
  const transporte = criarTransporte({ ...m.configSmtp, emailTransporte: 'desligado' });
  assert.equal(transporte.ligado, false);
  await assert.rejects(transporte.enviar({ to: ENDERECO }), /desligado/);
  assert.equal(m.stub.conexoes, 0);
});
