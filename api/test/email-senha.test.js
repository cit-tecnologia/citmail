// CIT-72, e-mails do link de senha: `conta_titular_criada` → `senha_primeiro_acesso` →
// `definicao_senha_solicitada` → `email_definicao_senha` → enfileirador → handler
// `email_enviar` com `modelosPadrao` e SMTP real apontado ao stub; e o mesmo para o
// "esqueci" (`senha_redefinicao`). Banco temporário migrado, papel da aplicação; DATA
// decodificado (`decodificarQp`) antes das buscas. Só dados fictícios.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UnrecoverableError } from 'bullmq';
import { criarLogger } from '../src/log.js';
import { consumidoresDoAmbiente, consumidoresPadrao, processarEvento } from '../src/eventos/consumidores.js';
import { enfileirarEmails } from '../src/email/enfileirador.js';
import { ehHtmlSeguro } from '../src/email/html.js';
import { modelosPadrao } from '../src/email/modelos/index.js';
import {
  ASSUNTO_PRIMEIRO_ACESSO, ASSUNTO_REDEFINICAO, formatarExpiracao, formatarPrazo, senhaPrimeiroAcesso, senhaRedefinicao
} from '../src/email/modelos/senha.js';
import { criarHandlerEmail } from '../src/email/servico.js';
import { criarTransporte } from '../src/email/transporte.js';
import { criarHandlerEsqueci } from '../src/senhas/job-esqueci.js';
import { emitirToken, hashDoToken, validarToken } from '../src/senhas/servico.js';
import {
  criarCapturaDeLog, criarFilasTeste, decodificarQp, gravarContaTitularCriada, semearContaPainel
} from './auxiliares.js';
import { REMETENTE, SENHA_SMTP } from './email-fixtures.js';
import { criarStubSmtp } from './stub-smtp.js';
import { criarBancoWebhook } from './webhook-fixtures.js';

const EMAIL = 'titular@exemplo.com.br';
const SENHA_ANTIGA = 'Senha-antiga-de-teste';
const BASE = 'http://127.0.0.1:4200/citmail/';
const LINK = /definir-senha\.html#t=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;
const TRUNCAR = 'TRUNCATE email_envio, solicitacao_senha, conta_titular, evento_processado, evento, cliente CASCADE';
const consumidores = consumidoresDoAmbiente({ painelHabilitado: true });

let banco;
let captura;
let log;
const stubs = [];

before(async () => {
  banco = await criarBancoWebhook();
});

after(async () => {
  for (const stub of stubs) await stub.parar();
  await banco.fechar();
});

beforeEach(async () => {
  await banco.admin.query(TRUNCAR);
  captura = criarCapturaDeLog();
  log = criarLogger({ level: 'info', stream: captura.stream });
});

async function novoStub(opcoes) {
  const stub = await criarStubSmtp(opcoes);
  stubs.push(stub);
  return stub;
}

function transporteDe(stub, desligado = false) {
  return criarTransporte({
    emailTransporte: desligado ? 'desligado' : 'smtp',
    smtpHost: stub.host,
    smtpPorta: stub.porta,
    smtpUsuario: 'usuario-ficticio',
    smtpSenha: SENHA_SMTP,
    smtpTimeoutMs: 3000,
    smtpRequireTls: false
  });
}

const consumir = (nome, eventoId) => processarEvento({
  pool: banco.app, consumidor: nome, tratar: consumidores[nome].tratar, log
}, { eventoId });

const eventosDefinicao = async (contaId) => (await banco.admin.query(
  "SELECT id, payload FROM evento WHERE nome = 'definicao_senha_solicitada' AND agregado_id = $1", [contaId]
)).rows;
const envios = async () => (await banco.admin.query('SELECT * FROM email_envio ORDER BY criado_em, id')).rows;
const solicitacao = async (id) => (await banco.admin.query('SELECT * FROM solicitacao_senha WHERE id = $1', [id])).rows[0];

async function enviar(envioId, { stub, desligado = false, tentativa, painelUrlBase = BASE, pool = banco.app, transporte } = {}) {
  const t = transporte ?? transporteDe(stub, desligado);
  try {
    const handler = criarHandlerEmail({ pool, modelos: modelosPadrao, transporte: t, remetente: REMETENTE, painelUrlBase, log });
    await handler({ log, tentativa }, { envioId, geracao: 1 });
  } finally {
    t.close();
  }
}

/** Conta `sem_senha` + `conta_titular_criada` + os dois consumidores. */
async function pedirPrimeiroAcesso() {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, estado: 'sem_senha' });
  await consumir('senha_primeiro_acesso', await gravarContaTitularCriada(banco.admin, contaId));
  const [evento] = await eventosDefinicao(contaId);
  await consumir('email_definicao_senha', evento.id);
  const [linha] = await envios();
  return { contaId, eventoId: evento.id, solicitacaoId: evento.payload.solicitacaoId, linha };
}

/** Conta `ativa` com senha + job do "esqueci" + consumidor. */
async function pedirRedefinicao() {
  const { contaId, senhaHash } = await semearContaPainel(banco.admin, { email: EMAIL, senha: SENHA_ANTIGA });
  const filas = { alertas: { add: async () => {} } };
  await criarHandlerEsqueci({ pool: banco.app, filas })({ log, jobId: '1' }, { email: EMAIL, requestId: randomUUID() });
  const [evento] = await eventosDefinicao(contaId);
  await consumir('email_definicao_senha', evento.id);
  const [linha] = await envios();
  return { contaId, senhaHash, eventoId: evento.id, solicitacaoId: evento.payload.solicitacaoId, linha };
}

/** Mensagem decodificada e o token único do link (o mesmo no texto e no HTML). */
function lerMensagem(mensagem) {
  const lida = decodificarQp(mensagem.data);
  const tokensTexto = [...lida.texto.matchAll(LINK)].map((m) => m[1]);
  const tokensHtml = [...lida.html.matchAll(LINK)].map((m) => m[1]);
  assert.equal(tokensTexto.length, 1, 'um link no texto');
  assert.ok(tokensHtml.length >= 1, 'link no HTML');
  assert.ok(tokensHtml.every((t) => t === tokensTexto[0]), 'mesmo token nas duas partes');
  return { ...lida, token: tokensTexto[0] };
}

async function semVazamento({ token, tokenHash }) {
  for (const segredo of [token, tokenHash]) {
    const linhas = (await banco.admin.query('SELECT row_to_json(e)::text AS t FROM email_envio e')).rows;
    for (const { t } of linhas) assert.ok(!t.includes(segredo), 'email_envio sem token nem hash');
    const payloads = (await banco.admin.query('SELECT payload::text AS t FROM evento')).rows;
    for (const { t } of payloads) assert.ok(!t.includes(segredo), 'evento sem token nem hash');
    assert.ok(!captura.texto().includes(segredo), 'log sem token nem hash');
  }
  assert.ok(!captura.texto().includes(EMAIL), 'log sem o e-mail');
  assert.doesNotMatch(captura.texto(), /definir-senha/, 'log sem o link');
}

async function conteudoDoRedis(aux) {
  const conteudos = [];
  let cursor = '0';
  do {
    const [proximo, chaves] = await aux.conexao.scan(cursor, 'MATCH', `${aux.prefixo}:*`, 'COUNT', 1000);
    cursor = proximo;
    for (const chave of chaves) {
      const tipo = await aux.conexao.type(chave);
      if (tipo === 'hash') conteudos.push(JSON.stringify(await aux.conexao.hgetall(chave)));
      else if (tipo === 'stream') conteudos.push(JSON.stringify(await aux.conexao.xrange(chave, '-', '+')));
      else if (tipo === 'string') conteudos.push(String(await aux.conexao.get(chave)));
    }
  } while (cursor !== '0');
  return conteudos.join('\n');
}

test('CIT-72 CA1: primeiro acesso envia o link de definição de 72 h, com o token válido e enviada_em', { tag: '@CIT-72', timeout: 60000 }, async (t) => {
  const stub = await novoStub();
  const aux = criarFilasTeste();
  t.after(aux.fechar);
  const { solicitacaoId, eventoId, linha } = await pedirPrimeiroAcesso();
  assert.equal(linha.modelo, 'senha_primeiro_acesso');
  assert.equal(linha.chave_idempotencia, `definicao_senha-${solicitacaoId}`);
  assert.equal(linha.evento_id, eventoId);
  assert.deepStrictEqual(linha.refs, { solicitacaoId });

  await enfileirarEmails({ pool: banco.app, filas: aux.filas, log });
  const jobs = await aux.filas.jobs.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
  assert.equal(jobs.length, 1);
  assert.deepStrictEqual(jobs[0].data, { envioId: linha.id, geracao: 1 });
  await enviar(jobs[0].data.envioId, { stub });

  const [gravada, ...outras] = await envios();
  assert.equal(outras.length, 0);
  assert.equal(gravada.estado, 'enviado');
  assert.equal(gravada.destinatario_mascarado, 't***@exemplo.com.br');
  assert.equal(stub.mensagens.length, 1);
  assert.deepStrictEqual(stub.mensagens[0].rcptTo, [EMAIL]);
  const mensagem = lerMensagem(stub.mensagens[0]);
  assert.equal(mensagem.assunto, ASSUNTO_PRIMEIRO_ACESSO);
  // O link (~94 caracteres, `=` vira `=3D`) passa de 76 colunas: o QP o quebra com `=\r\n`.
  const bruto = stub.mensagens[0].data;
  assert.match(bruto, /^Content-Transfer-Encoding: quoted-printable$/mi);
  const linkQp = `${BASE}definir-senha.html#t=${mensagem.token}`.replace(/=/g, '=3D');
  const ocorrencias = (texto) => texto.split(linkQp).length - 1;
  const semQuebraMole = bruto.replace(/=\r\n/g, '');
  assert.ok(ocorrencias(semQuebraMole) >= 2, 'link codificado no texto e no HTML');
  assert.ok(ocorrencias(bruto) < ocorrencias(semQuebraMole), 'quebra mole dentro do link');
  for (const corpo of [mensagem.texto, mensagem.html]) {
    assert.ok(corpo.includes(`${BASE}definir-senha.html#t=${mensagem.token}`), 'link completo');
  }
  assert.match(mensagem.html, new RegExp(`<a href="${BASE.replace(/[.]/g, '\\.')}definir-senha\\.html#t=${mensagem.token}">${BASE.replace(/[.]/g, '\\.')}definir-senha\\.html#t=${mensagem.token}</a>`));

  const s = await solicitacao(solicitacaoId);
  assert.equal(hashDoToken(mensagem.token), s.token_hash);
  assert.deepStrictEqual(await validarToken(banco.app, mensagem.token), { tipo: 'primeiro_acesso' });
  assert.ok(s.enviada_em instanceof Date, 'enviada_em preenchido');

  const { data, hora } = formatarExpiracao(s.expira_em);
  assert.match(mensagem.texto, /vale por 72 horas/);
  assert.ok(mensagem.texto.includes(`até ${data} às ${hora} (horário de Brasília)`), 'data em America/Sao_Paulo');
  assert.equal(mensagem.texto.split('(horário de Brasília)').length - 1, 1);
  assert.equal(mensagem.html.split('(horário de Brasília)').length - 1, 1);
  assert.doesNotMatch(mensagem.texto + mensagem.html, /\$argon2id|senha_hash|Se você não pediu/);

  await semVazamento({ token: mensagem.token, tokenHash: s.token_hash });
  const redis = await conteudoDoRedis(aux);
  assert.ok(!redis.includes(mensagem.token) && !redis.includes(s.token_hash), 'Redis sem token nem hash');
});

test('CIT-72 CA2/CA3: redefinição pelo "esqueci" envia o link de 1 h, sem a senha nem o hash da conta', { tag: '@CIT-72' }, async () => {
  const stub = await novoStub();
  const { solicitacaoId, senhaHash, linha } = await pedirRedefinicao();
  assert.equal(linha.modelo, 'senha_redefinicao');
  assert.equal(linha.chave_idempotencia, `definicao_senha-${solicitacaoId}`);
  await enviar(linha.id, { stub });

  assert.equal(stub.mensagens.length, 1);
  assert.deepStrictEqual(stub.mensagens[0].rcptTo, [EMAIL]);
  const mensagem = lerMensagem(stub.mensagens[0]);
  assert.equal(mensagem.assunto, ASSUNTO_REDEFINICAO);
  const s = await solicitacao(solicitacaoId);
  assert.equal(hashDoToken(mensagem.token), s.token_hash);
  assert.deepStrictEqual(await validarToken(banco.app, mensagem.token), { tipo: 'redefinicao' });
  assert.ok(s.enviada_em instanceof Date);
  const { data, hora } = formatarExpiracao(s.expira_em);
  for (const corpo of [mensagem.texto, mensagem.html]) {
    assert.match(corpo, /vale por 1 hora,/);
    assert.ok(corpo.includes(`até ${data} às ${hora} (horário de Brasília)`));
    assert.match(corpo, /Se você não pediu, ignore este e-mail; sua senha atual continua valendo\./);
    assert.ok(!corpo.includes(SENHA_ANTIGA), 'sem a senha');
    assert.ok(!corpo.includes(senhaHash), 'sem o senha_hash');
    assert.doesNotMatch(corpo, /\$argon2id/);
  }
  assert.equal((await envios())[0].estado, 'enviado');
  await semVazamento({ token: mensagem.token, tokenHash: s.token_hash });
});

test('CIT-72 CA3: o html dos dois modelos é seguro e leva o link no href e no texto visível', { tag: '@CIT-72' }, () => {
  const link = `${BASE}definir-senha.html#t=${'A'.repeat(43)}`;
  for (const modelo of [senhaPrimeiroAcesso, senhaRedefinicao]) {
    const corpo = modelo.html({ link, prazo: '1 hora', data: '01/01/2027', hora: '10:00' });
    assert.ok(ehHtmlSeguro(corpo));
    assert.ok(corpo.toString().includes(`<a href="${link}">${link}</a>`));
  }
});

async function linkFechado(ajuste) {
  const stub = await novoStub();
  const { solicitacaoId, linha, contaId } = await pedirPrimeiroAcesso();
  await ajuste({ solicitacaoId, contaId, linha });
  const antes = (await solicitacao(solicitacaoId)).token_hash;
  const aux = criarFilasTeste();
  try {
    await enviar(linha.id, { stub });
    const [gravada] = await envios();
    assert.equal(gravada.estado, 'nao_enviado');
    assert.equal(gravada.tentativas, 0);
    assert.equal(stub.mensagens.length, 0);
    assert.equal((await solicitacao(solicitacaoId)).token_hash, antes);
    assert.equal((await enfileirarEmails({ pool: banco.app, filas: aux.filas, log })).enfileirados, 0, 'sem novo job');
    return gravada.erro_codigo;
  } finally {
    await aux.fechar();
  }
}

test('CIT-72 CA4: solicitação usada, vencida ou de conta cancelada → LINK_FECHADO, sem mensagem nem token', { tag: '@CIT-72', timeout: 60000 }, async () => {
  const ajustes = {
    usada: ({ solicitacaoId }) => banco.admin.query('UPDATE solicitacao_senha SET usada_em = now() WHERE id = $1', [solicitacaoId]),
    vencida: ({ solicitacaoId }) => banco.admin.query(
      "UPDATE solicitacao_senha SET criada_em = criada_em - interval '73 hours', expira_em = expira_em - interval '73 hours' WHERE id = $1",
      [solicitacaoId]
    ),
    cancelada: ({ contaId }) => banco.admin.query("UPDATE conta_titular SET estado = 'cancelada' WHERE id = $1", [contaId])
  };
  for (const [caso, ajuste] of Object.entries(ajustes)) {
    await banco.admin.query(TRUNCAR);
    assert.equal(await linkFechado(ajuste), 'LINK_FECHADO', caso);
  }
});

test('CIT-72 CA4: modelo senha_redefinicao numa solicitação primeiro_acesso → TIPO_DIVERGENTE, sem token', { tag: '@CIT-72' }, async () => {
  const codigo = await linkFechado(({ linha }) => banco.admin.query(
    "UPDATE email_envio SET modelo = 'senha_redefinicao' WHERE id = $1", [linha.id]
  ));
  assert.equal(codigo, 'TIPO_DIVERGENTE');
  assert.ok(captura.linhas().some((l) => l.msg === 'tipo da solicitação diverge do modelo' && l.level === 40));
});

test('CIT-72 CA4: e-mail da conta com vírgula → SEM_DESTINATARIO, sem gastar token', { tag: '@CIT-72' }, async () => {
  const codigo = await linkFechado(({ contaId }) => banco.admin.query(
    "UPDATE conta_titular SET email = 'a@exemplo.com.br,b@exemplo.com.br' WHERE id = $1", [contaId]
  ));
  assert.equal(codigo, 'SEM_DESTINATARIO');
});

test('CIT-72 CA4: worker sem painelUrlBase → SEM_URL_PAINEL, sem token', { tag: '@CIT-72' }, async () => {
  const stub = await novoStub();
  const { solicitacaoId, linha } = await pedirPrimeiroAcesso();
  await enviar(linha.id, { stub, painelUrlBase: null });
  const [gravada] = await envios();
  assert.equal(gravada.estado, 'nao_enviado');
  assert.equal(gravada.erro_codigo, 'SEM_URL_PAINEL');
  assert.equal((await solicitacao(solicitacaoId)).token_hash, null);
  assert.equal(stub.mensagens.length, 0);
});

test('CIT-72 CA4: transporte desligado → nao_enviado sem código e sem token', { tag: '@CIT-72' }, async () => {
  const stub = await novoStub();
  const { solicitacaoId, linha } = await pedirPrimeiroAcesso();
  await enviar(linha.id, { stub, desligado: true });
  const [gravada] = await envios();
  assert.equal(gravada.estado, 'nao_enviado');
  assert.equal(gravada.erro_codigo, null);
  assert.equal((await solicitacao(solicitacaoId)).token_hash, null);
  assert.equal(stub.mensagens.length, 0);
});

test('CIT-72 CA4: reprocessar o evento → "evento já processado", ainda 1 email_envio', { tag: '@CIT-72' }, async () => {
  const { eventoId } = await pedirPrimeiroAcesso();
  await consumir('email_definicao_senha', eventoId);
  assert.equal((await envios()).length, 1);
  assert.ok(captura.linhas().some((l) => l.msg === 'evento já processado' && l.consumidor === 'email_definicao_senha'));
});

test('CIT-72 CA4: 4xx no 1º RCPT → nova tentativa com token novo; só o token da mensagem aceita vale', { tag: '@CIT-72' }, async () => {
  const stub = await novoStub({ rcpt: ['451', '250'] });
  const { solicitacaoId, linha } = await pedirPrimeiroAcesso();
  await assert.rejects(enviar(linha.id, { stub, tentativa: { feita: 0, maxima: 3 } }), { name: 'ErroEmail' });
  const primeiroHash = (await solicitacao(solicitacaoId)).token_hash;
  assert.match(primeiroHash, /^[0-9a-f]{64}$/);
  await enviar(linha.id, { stub, tentativa: { feita: 1, maxima: 3 } });
  assert.equal(stub.mensagens.length, 1);
  const { token } = lerMensagem(stub.mensagens[0]);
  const s = await solicitacao(solicitacaoId);
  assert.notEqual(s.token_hash, primeiroHash);
  assert.equal(hashDoToken(token), s.token_hash);
  assert.deepStrictEqual(await validarToken(banco.app, token), { tipo: 'primeiro_acesso' });
  assert.equal((await envios())[0].estado, 'enviado');
});

test('CIT-72 CA4: token já emitido → "link substituído" só com ids e o anterior deixa de valer', { tag: '@CIT-72' }, async () => {
  const stub = await novoStub();
  const { solicitacaoId, linha } = await pedirPrimeiroAcesso();
  const anterior = await emitirToken(banco.app, solicitacaoId);
  await enviar(linha.id, { stub });
  const { token } = lerMensagem(stub.mensagens[0]);
  assert.notEqual(token, anterior);
  assert.equal(await validarToken(banco.app, anterior), null);
  assert.deepStrictEqual(await validarToken(banco.app, token), { tipo: 'primeiro_acesso' });
  const registro = captura.linhas().find((l) => l.msg === 'link substituído');
  assert.equal(registro.envioId, linha.id);
  assert.equal(registro.solicitacaoId, solicitacaoId);
  assert.ok(!captura.texto().includes(anterior) && !captura.texto().includes(token));
  assert.ok(!captura.texto().includes(EMAIL));
});

test('CIT-72 CA4: hash trocado entre o SMTP e o aposEnviar → enviada_em nulo e "link substituído"', { tag: '@CIT-72' }, async () => {
  const stub = await novoStub();
  const { solicitacaoId, linha } = await pedirPrimeiroAcesso();
  const transporte = transporteDe(stub);
  const enviarOriginal = transporte.enviar.bind(transporte);
  transporte.enviar = async (mensagem) => {
    const info = await enviarOriginal(mensagem);
    await emitirToken(banco.app, solicitacaoId);
    return info;
  };
  await enviar(linha.id, { transporte });
  assert.equal((await envios())[0].estado, 'enviado');
  assert.equal((await solicitacao(solicitacaoId)).enviada_em, null);
  const registro = captura.linhas().find((l) => l.msg === 'link substituído');
  assert.equal(registro.envioId, linha.id);
  assert.equal(registro.solicitacaoId, solicitacaoId);
});

test('CIT-72 CA4: falha ao gravar enviada_em → enviado, job concluído, 1 mensagem e warn', { tag: '@CIT-72' }, async () => {
  const stub = await novoStub();
  const { solicitacaoId, linha } = await pedirPrimeiroAcesso();
  const pool = {
    query: (sql, params) => (/SET enviada_em/.test(sql)
      ? Promise.reject(Object.assign(new Error('conexão perdida'), { code: '57P01' }))
      : banco.app.query(sql, params))
  };
  await enviar(linha.id, { stub, pool });
  assert.equal((await envios())[0].estado, 'enviado');
  assert.equal(stub.mensagens.length, 1);
  assert.equal((await solicitacao(solicitacaoId)).enviada_em, null);
  const aviso = captura.linhas().find((l) => l.msg === 'pós-envio do e-mail falhou');
  assert.equal(aviso.level, 40);
  assert.equal(aviso.envioId, linha.id);
});

test('CIT-72: o consumidor recusa evento fora do contrato com UnrecoverableError, sem marca nem linha', { tag: '@CIT-72' }, async () => {
  const { contaId } = await semearContaPainel(banco.admin, { email: EMAIL, estado: 'sem_senha' });
  const casos = [
    ['agregado', 'pedido', contaId, { contaId, tipo: 'primeiro_acesso', solicitacaoId: randomUUID() }],
    ['contaId divergente', 'conta_titular', contaId, { contaId: randomUUID(), tipo: 'primeiro_acesso', solicitacaoId: randomUUID() }],
    ['solicitacaoId', 'conta_titular', contaId, { contaId, tipo: 'primeiro_acesso', solicitacaoId: 'x' }],
    ['tipo', 'conta_titular', contaId, { contaId, tipo: 'outro', solicitacaoId: randomUUID() }]
  ];
  for (const [caso, agregadoTipo, agregadoId, payload] of casos) {
    const id = randomUUID();
    await banco.admin.query(
      `INSERT INTO evento (id, nome, versao, agregado_tipo, agregado_id, chave_idempotencia, payload)
       VALUES ($1, 'definicao_senha_solicitada', 1, $2, $3, $4, $5::jsonb)`,
      [id, agregadoTipo, agregadoId, `definicao_senha_solicitada-${id}`, JSON.stringify(payload)]
    );
    await assert.rejects(consumir('email_definicao_senha', id), UnrecoverableError, caso);
  }
  assert.equal((await banco.admin.query('SELECT 1 FROM evento_processado')).rowCount, 0);
  assert.equal((await envios()).length, 0);
});

test('CIT-72 CA5: consumidoresDoAmbiente só registra senha_primeiro_acesso e email_definicao_senha com a flag', { tag: '@CIT-72' }, () => {
  const desligada = consumidoresDoAmbiente({ painelHabilitado: false });
  assert.equal(desligada, consumidoresPadrao);
  assert.ok(!Object.hasOwn(desligada, 'email_definicao_senha'));
  assert.ok(!Object.hasOwn(desligada, 'senha_primeiro_acesso'));
  assert.ok(Object.hasOwn(consumidores, 'email_definicao_senha'));
  assert.ok(Object.hasOwn(consumidores, 'senha_primeiro_acesso'));
  assert.deepStrictEqual(consumidores.email_definicao_senha.eventos, ['definicao_senha_solicitada']);
});

test('CIT-72 CA6: o link aponta para definir-senha.html da raiz e o token passa no PADRAO_TOKEN da página', { tag: '@CIT-72' }, async () => {
  const raiz = fileURLToPath(new URL('../../', import.meta.url));
  assert.ok(existsSync(`${raiz}definir-senha.html`));
  const fonte = readFileSync(`${raiz}assets/definir-senha.js`, 'utf8');
  const [, padrao] = /const PADRAO_TOKEN = \/(.+)\/;/.exec(fonte);
  const stub = await novoStub();
  const { linha } = await pedirPrimeiroAcesso();
  await enviar(linha.id, { stub });
  const { texto, token } = lerMensagem(stub.mensagens[0]);
  const link = /http\S+definir-senha\.html#t=\S+/.exec(texto)[0];
  const url = new URL(link);
  assert.equal(url.pathname, '/citmail/definir-senha.html');
  assert.match(url.hash, new RegExp(padrao));
  assert.equal(new RegExp(padrao).exec(url.hash)[1], token);
});

test('CIT-72: formatarPrazo com valores fixos (floor; prazo cheio a até 5 min dele)', { tag: '@CIT-72' }, () => {
  const casos = [
    [72 * 3600, 72, '72 horas'],
    [72 * 3600 - 300, 72, '72 horas'],
    [72 * 3600 - 301, 72, '71 horas'],
    [120 * 60, 72, '2 horas'],
    [119 * 60 + 59, 72, '119 minutos'],
    [3600, 1, '1 hora'],
    [3300, 1, '1 hora'],
    [3299, 1, '54 minutos'],
    [20 * 60 + 30, 1, '20 minutos'],
    [119, 1, '1 minuto'],
    [30, 1, '1 minuto'],
    [0.5, 1, '1 minuto']
  ];
  for (const [segundos, prazo, esperado] of casos) {
    assert.equal(formatarPrazo(segundos, prazo), esperado, `${segundos}s de ${prazo} h`);
  }
});

test('CIT-72: formatarExpiracao em pt-BR no horário de Brasília', { tag: '@CIT-72' }, () => {
  assert.deepStrictEqual(formatarExpiracao(new Date('2026-11-25T18:30:00Z')), { data: '25/11/2026', hora: '15:30' });
  assert.deepStrictEqual(formatarExpiracao(new Date('2027-01-01T02:05:00Z')), { data: '31/12/2026', hora: '23:05' });
});
