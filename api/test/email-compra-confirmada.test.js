// CIT-66, e-mail de compra confirmada: evento `pedido_pago` -> consumidor
// `email_compra_confirmada` (`processarEvento`) -> handler `email_enviar` com `modelosPadrao`
// e transporte SMTP real apontado ao stub. Banco temporário migrado, papel da aplicação.
// Só dados fictícios; o corpo da mensagem chega em quoted-printable e é decodificado antes
// de comparar.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { criarLogger } from '../src/log.js';
import { processarEvento, consumidoresPadrao, criarHandlersDeConsumidores, validarConsumidores } from '../src/eventos/consumidores.js';
import { criarHandlerEmail, solicitarEmail } from '../src/email/servico.js';
import { criarTransporte } from '../src/email/transporte.js';
import {
  ASSUNTO_COMPRA_CONFIRMADA, ROTULOS_ADDONS, ROTULOS_CONTAS, ROTULOS_SKYBOX
} from '../src/email/modelos/compra-confirmada.js';
import { modelosForaDeProducao, modelosPadrao, validarModelos } from '../src/email/modelos/index.js';
import { ADDONS, CONTAS } from '../src/precos/tabela.js';
import { criarCapturaDeLog } from './auxiliares.js';
import { ENDERECO, linhaDe, REMETENTE, SENHA_SMTP } from './email-fixtures.js';
import { criarStubSmtp } from './stub-smtp.js';
import { criarBancoWebhook, semearPedido } from './webhook-fixtures.js';

const NOME_HOSTIL = '<script>x</script> & "a"\nX';
const ITENS_CA1 = {
  itens: [
    { tipo: 'conta', chave: '5gb', quantidade: 2 },
    { tipo: 'conta', chave: '25gb', quantidade: 1 },
    { tipo: 'addon', chave: 'talk', quantidade: 3 },
    { tipo: 'addon', chave: 'skybox', plano: '50gb', quantidade: 1 }
  ],
  avulsos: []
};

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
  await banco.admin.query('TRUNCATE email_envio, evento_processado, evento, assinatura, pedido_dominio, pedido, cliente CASCADE');
  captura = criarCapturaDeLog();
  log = criarLogger({ level: 'info', stream: captura.stream });
});

async function novoStub() {
  const stub = await criarStubSmtp();
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

/** Pedido semeado; `itens`, `nome` e `email` ajustados pelo dono. */
async function semear({ itens = ITENS_CA1, nome = 'Fulano Ficticio', ...opcoes } = {}) {
  const pedido = await semearPedido(banco.admin, { estado: 'pago', email: ENDERECO, ...opcoes });
  await banco.admin.query('UPDATE pedido SET itens = $2::jsonb, contato_nome = $3 WHERE id = $1', [
    pedido.pedidoId, JSON.stringify(itens), nome
  ]);
  return pedido.pedidoId;
}

/** Linha `pedido_pago` em `evento`, como o webhook a grava. */
async function gravarEvento(pedidoId, { agregadoTipo = 'pedido', agregadoId = pedidoId, payload = { pedidoId }, chave } = {}) {
  const id = randomUUID();
  await banco.admin.query(
    `INSERT INTO evento (id, nome, versao, agregado_tipo, agregado_id, chave_idempotencia, payload)
     VALUES ($1, 'pedido_pago', 1, $2, $3, $4, $5::jsonb)`,
    [id, agregadoTipo, agregadoId, chave ?? `pedido_pago-${pedidoId}-${id}`, JSON.stringify(payload)]
  );
  return id;
}

const consumir = (eventoId) => processarEvento({
  pool: banco.app, consumidor: 'email_compra_confirmada', tratar: consumidoresPadrao.email_compra_confirmada.tratar, log
}, { eventoId });

const envios = async () => (await banco.admin.query('SELECT * FROM email_envio ORDER BY enfileirado_em')).rows;

async function enviar(linha, stub, { desligado = false } = {}) {
  const transporte = transporteDe(stub, desligado);
  try {
    const handler = criarHandlerEmail({
      pool: banco.app, modelos: modelosPadrao, transporte, remetente: REMETENTE, log
    });
    await handler({ log }, { envioId: linha.id, geracao: linha.geracao });
  } finally {
    transporte.close();
  }
}

/** Pedido + evento + consumidor + envio. Devolve a linha de `email_envio` já enviada e o stub. */
async function fluxo(opcoes = {}, { aposSemear, desligado } = {}) {
  const stub = await novoStub();
  const pedidoId = await semear(opcoes);
  const eventoId = await gravarEvento(pedidoId);
  await consumir(eventoId);
  if (aposSemear) await aposSemear(pedidoId);
  const [linha] = await envios();
  await enviar(linha, stub, { desligado });
  return { pedidoId, eventoId, stub, linha };
}

/** Decodifica quoted-printable (UTF-8) e separa assunto, texto e HTML da primeira mensagem. */
function lerMensagem(mensagem) {
  const semQuebraMole = mensagem.data.replace(/=\r?\n/g, '');
  const decodificado = Buffer.from(
    semQuebraMole.replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1'
  ).toString('utf8');
  const partes = decodificado.split(/\r?\n--/);
  const corpoDe = (tipo) => {
    const parte = partes.find((p) => p.includes(`Content-Type: ${tipo}`));
    return parte.split(/\r?\n\r?\n/).slice(1).join('\n\n');
  };
  return { assunto: /^Subject: (.*)$/m.exec(decodificado)[1], texto: corpoDe('text/plain'), html: corpoDe('text/html') };
}

test('CA1: envia só ao contato do pedido, com assunto fixo, itens, ciclo, valor e prazo de 5 minutos', async () => {
  const { stub, linha, eventoId, pedidoId } = await fluxo({ ciclo: 'anual' });
  assert.equal(stub.mensagens.length, 1);
  assert.deepEqual(stub.mensagens[0].rcptTo, [ENDERECO]);
  const gravada = await linhaDe(banco, linha.id);
  assert.equal(gravada.modelo, 'compra_confirmada');
  assert.equal(gravada.evento_id, eventoId);
  assert.deepEqual(gravada.refs, { pedidoId });
  assert.equal(gravada.estado, 'enviado');
  const { assunto, texto, html } = lerMensagem(stub.mensagens[0]);
  assert.equal(assunto, ASSUNTO_COMPRA_CONFIRMADA);
  for (const corpo of [texto, html]) {
    assert.match(corpo, /2 × Conta 5 GB/);
    assert.match(corpo, /1 × Conta 25 GB/);
    assert.match(corpo, /3 × Talk/);
    assert.match(corpo, /1 × Skybox 50 GB/);
    assert.match(corpo, /anual/);
    assert.match(corpo, /R\$ 49,90 por ano/);
    assert.match(corpo, /em até 5 minutos após a confirmação do pagamento/);
  }
  assert.doesNotMatch(assunto, /Conta|Talk|49,90/);
});

test('CA1: no texto, cada item ocupa uma linha própria', async () => {
  const { stub } = await fluxo();
  const { texto } = lerMensagem(stub.mensagens[0]);
  assert.equal((texto.match(/^- \d+ × .+$/gm) ?? []).length, 4);
});

test('CA1: o valor das contas e o dos domínios aparecem em BRL, este por ano', async () => {
  const { stub } = await fluxo({
    ciclo: 'mensal',
    assinaturas: { contas: 'sub_contas_1', dominios: 'sub_dom_1' },
    dominios: [{ nome: 'existente.exemplo.test', tipo: 'existente', papel: 'principal' }]
  });
  const { texto, html } = lerMensagem(stub.mensagens[0]);
  for (const corpo of [texto, html]) {
    assert.match(corpo, /mensal/);
    assert.match(corpo, /R\$ 49,90 por mês/);
    assert.match(corpo, /Domínios: R\$ 40,00 por ano/);
  }
});

test('CA2: domínio novo avisa registro manual, sem prometer 5 minutos', async () => {
  const { stub } = await fluxo({
    dominios: [{ nome: 'novo.exemplo.test', tipo: 'novo', papel: 'principal' }]
  });
  const { texto, html } = lerMensagem(stub.mensagens[0]);
  for (const corpo of [texto, html]) {
    assert.match(corpo, /registro do domínio novo é feito manualmente pela nossa equipe/);
    assert.match(corpo, /não fica pronta em 5 minutos/);
    assert.match(corpo, /novo e-mail quando terminar/);
    assert.doesNotMatch(corpo, /em até 5 minutos/);
  }
});

test('CA2: domínio novo ainda sem pagamento do domínio avisa que o registro começa após o pagamento', async () => {
  const { stub } = await fluxo({
    estado: 'aguardando_pagamento_do_dominio',
    dominios: [{ nome: 'novo.exemplo.test', tipo: 'novo', papel: 'principal' }]
  });
  const { texto, html } = lerMensagem(stub.mensagens[0]);
  for (const corpo of [texto, html]) {
    assert.match(corpo, /O registro começa após a confirmação do pagamento do domínio/);
    assert.doesNotMatch(corpo, /em até 5 minutos/);
  }
});

test('CA3: o mesmo evento processado duas vezes grava uma só linha e envia uma só mensagem', async () => {
  const stub = await novoStub();
  const pedidoId = await semear();
  const eventoId = await gravarEvento(pedidoId);
  await consumir(eventoId);
  await consumir(eventoId);
  const linhas = await envios();
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].chave_idempotencia, `compra_confirmada-${pedidoId}`);
  await enviar(linhas[0], stub);
  assert.equal(stub.mensagens.length, 1);
});

test('CA3: um segundo pedido_pago do mesmo pedido, com outro evento, não cria nova linha', async () => {
  const pedidoId = await semear();
  await consumir(await gravarEvento(pedidoId));
  await consumir(await gravarEvento(pedidoId));
  const linhas = await envios();
  assert.equal(linhas.length, 1);
  const cliente = await banco.app.connect();
  try {
    const repetido = await solicitarEmail(cliente, {
      eventoId: randomUUID(), chaveIdempotencia: `compra_confirmada-${pedidoId}`, modelo: 'compra_confirmada', refs: { pedidoId }
    }, modelosPadrao);
    assert.equal(repetido.criado, false);
  } finally {
    cliente.release();
  }
});

async function semEnvio({ ajuste, motivo }) {
  const { stub, linha } = await fluxo({}, { aposSemear: ajuste });
  const gravada = await linhaDe(banco, linha.id);
  assert.equal(stub.mensagens.length, 0);
  assert.equal(gravada.estado, 'nao_enviado');
  assert.equal(gravada.erro_codigo, 'SEM_DESTINATARIO');
  const registro = captura.linhas().find((l) => l.msg === 'compra confirmada sem envio');
  assert.equal(registro.motivo, motivo);
  assert.deepEqual(Object.keys(registro).filter((k) => ['pedidoId', 'motivo', 'envioId'].includes(k)).sort(), ['envioId', 'motivo', 'pedidoId']);
  assert.equal(registro.envioId, gravada.id);
}

test('CA4: fatura retida não envia e registra o motivo fatura_retida', () => semEnvio({
  motivo: 'fatura_retida',
  ajuste: (id) => banco.admin.query('UPDATE pedido SET fatura_retida = true WHERE id = $1', [id])
}));

test('CA4: pedido cancelado não envia e registra o motivo cancelado', () => semEnvio({
  motivo: 'cancelado',
  ajuste: (id) => banco.admin.query(`UPDATE pedido SET estado = 'cancelado' WHERE id = $1`, [id])
}));

test('CA4: pedido ainda aguardando pagamento não envia e registra o motivo nao_pago', () => semEnvio({
  motivo: 'nao_pago',
  ajuste: (id) => banco.admin.query(`UPDATE pedido SET estado = 'aguardando_pagamento' WHERE id = $1`, [id])
}));

test('CA4: pedido inexistente não envia e registra o motivo inexistente', () => semEnvio({
  motivo: 'inexistente',
  ajuste: () => banco.admin.query('UPDATE email_envio SET refs = $1::jsonb', [JSON.stringify({ pedidoId: randomUUID() })])
}));

test('CA4: pedido em falha_no_provisionamento (já pago) recebe o e-mail', async () => {
  const { stub } = await fluxo({}, {
    aposSemear: (id) => banco.admin.query(
      `UPDATE pedido SET estado = 'falha_no_provisionamento', falha_motivo = 'motivo_ficticio' WHERE id = $1`, [id]
    )
  });
  assert.equal(stub.mensagens.length, 1);
});

test('CA5: nome hostil sai escapado no HTML e sem a quebra de linha injetada no texto', async () => {
  const { stub } = await fluxo({ nome: NOME_HOSTIL });
  const { texto, html } = lerMensagem(stub.mensagens[0]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; &quot;a&quot;/);
  assert.match(texto, /^Olá, .*X\.$/m);
  assert.doesNotMatch(texto, /^X\.?$/m);
});

test('CA5: o HTML não tem href nem src', async () => {
  const { stub } = await fluxo({ nome: NOME_HOSTIL });
  assert.doesNotMatch(lerMensagem(stub.mensagens[0]).html, /\b(href|src)\s*=/i);
});

test('CA5: nenhum log do consumidor ou do envio traz endereço, nome, itens ou valor', async () => {
  await fluxo({ nome: 'Beltrano Sigiloso' });
  const logs = captura.texto();
  assert.ok(logs.length > 0);
  assert.doesNotMatch(logs, /fulano@|Beltrano|Sigiloso|Conta|Talk|Skybox|49,90|4990/);
});

test('CA5: contato_email com dois endereços fica nao_enviado com SEM_DESTINATARIO', async () => {
  const { stub, linha } = await fluxo({ email: 'a@exemplo.test,b@exemplo.test' });
  const gravada = await linhaDe(banco, linha.id);
  assert.equal(stub.mensagens.length, 0);
  assert.equal(gravada.estado, 'nao_enviado');
  assert.equal(gravada.erro_codigo, 'SEM_DESTINATARIO');
});

test('CA6: agregado que não é pedido lança UnrecoverableError, sem marca nem linha', async () => {
  const pedidoId = await semear();
  const eventoId = await gravarEvento(pedidoId, { agregadoTipo: 'assinatura' });
  await assert.rejects(consumir(eventoId), UnrecoverableError);
  await semMarcaNemLinha();
});

test('CA6: agregado_id fora do formato UUID lança UnrecoverableError, sem marca nem linha', async () => {
  const pedidoId = await semear();
  const eventoId = await gravarEvento(pedidoId, { agregadoId: 'nao-e-uuid', payload: { pedidoId: 'nao-e-uuid' } });
  await assert.rejects(consumir(eventoId), UnrecoverableError);
  await semMarcaNemLinha();
});

test('CA6: payload.pedidoId diferente do agregado lança UnrecoverableError, sem marca nem linha', async () => {
  const pedidoId = await semear();
  const eventoId = await gravarEvento(pedidoId, { payload: { pedidoId: randomUUID() } });
  await assert.rejects(consumir(eventoId), UnrecoverableError);
  await semMarcaNemLinha();
});

async function semMarcaNemLinha() {
  assert.equal((await banco.admin.query('SELECT 1 FROM evento_processado')).rowCount, 0);
  assert.equal((await envios()).length, 0);
}

test('CA6: com o transporte desligado a linha fica nao_enviado e nada chega ao stub', async () => {
  const { stub, linha } = await fluxo({}, { desligado: true });
  assert.equal((await linhaDe(banco, linha.id)).estado, 'nao_enviado');
  assert.equal(stub.mensagens.length, 0);
});

test('CA6: o modelo e o consumidor estão nos registros de produção e passam na validação', () => {
  assert.ok(Object.hasOwn(modelosPadrao, 'compra_confirmada'));
  assert.ok(Object.hasOwn(modelosForaDeProducao, 'compra_confirmada'));
  assert.ok(Object.hasOwn(consumidoresPadrao, 'email_compra_confirmada'));
  validarModelos(modelosPadrao);
  validarConsumidores(consumidoresPadrao);
  assert.deepEqual(Object.keys(criarHandlersDeConsumidores({ pool: banco.app })), ['email_compra_confirmada', 'tarefa_registro_dominio']);
});

test('CA6: toda chave de conta, add-on e plano de Skybox da tabela de preços tem rótulo', () => {
  assert.deepEqual(Object.keys(ROTULOS_CONTAS).sort(), Object.keys(CONTAS).sort());
  assert.deepEqual(Object.keys(ROTULOS_SKYBOX).sort(), Object.keys(ADDONS.skybox).sort());
  const addonsSemSkybox = Object.keys(ADDONS).filter((chave) => chave !== 'skybox');
  assert.deepEqual(Object.keys(ROTULOS_ADDONS).sort(), addonsSemSkybox.sort());
});

test('CA6: item com chave desconhecida é omitido, sem a chave crua no e-mail', async () => {
  const { stub } = await fluxo({
    itens: { itens: [{ tipo: 'conta', chave: '5gb', quantidade: 1 }, { tipo: 'addon', chave: 'chave_nova', quantidade: 9 }], avulsos: [] }
  });
  const { texto, html } = lerMensagem(stub.mensagens[0]);
  assert.equal((texto.match(/^- \d+ × .+$/gm) ?? []).length, 1);
  assert.doesNotMatch(texto + html, /chave_nova/);
});
