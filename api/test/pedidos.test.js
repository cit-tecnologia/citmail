// CIT-61: POST /api/pedidos cria cliente e assinaturas no Asaas (ADR 0014). Contra um banco
// temporário migrado e o stub HTTP local do Asaas (`stub-asaas.js`); nenhuma rede externa.
// Um app e um banco por arquivo; cada cenário usa CPF e chave próprios. Apps extras (mesmo
// banco e mesmo stub) cobrem as opções `prazoCriandoMs`, `prazoPedidoMs` e `versaoTabela`.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { construirApp } from '../src/app.js';
import { criarClienteAsaas } from '../src/asaas/cliente.js';
import { calcularOrcamento } from '../src/precos/servico.js';
import { VERSAO } from '../src/precos/tabela.js';
import { tipoPessoa } from '../src/pedidos/documento.js';
import { construirAppTeste, criarCapturaDeLog, criarConfigTeste } from './auxiliares.js';
import { criarStubAsaas, MARCADOR_CORPO } from './stub-asaas.js';

const CHAVE_API = 'CHAVE-FICTICIA-ASAAS';
const TEXTO_INDISPONIVEL = 'Não foi possível gerar a cobrança agora. Tente de novo em alguns minutos.';
const AGORA = new Date('2026-11-30T23:30:00-03:00');
const ROTA_PAGAMENTOS = 'GET /subscriptions/{id}/payments';
const ROTA_REMOCAO = 'DELETE /subscriptions/{id}';

let stub;
let ambiente;
const appsExtras = [];
const sensiveis = new Set([CHAVE_API, MARCADOR_CORPO]);

before(async () => {
  stub = await criarStubAsaas();
  ambiente = await construirAppTeste({
    asaas: adaptador(1000),
    sobrescritasConfig: { asaasTimeoutMs: 1000 },
    pedidos: { agora: () => AGORA },
  });
});

after(async () => {
  for (const app of appsExtras) await app.close();
  await ambiente.fechar();
  await stub.fechar();
});

beforeEach(() => stub.limpar());

// CA15: ao fim de cada cenário o log acumulado não carrega dado pessoal, a chave do Asaas
// nem texto de erro do stub.
afterEach(() => semSensiveis(ambiente.captura));

function semSensiveis(captura) {
  const texto = captura.texto();
  for (const valor of sensiveis) {
    assert.ok(!texto.includes(valor), `o log não pode conter ${JSON.stringify(valor)}`);
  }
}

function adaptador(timeoutMs) {
  return criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: CHAVE_API, timeoutMs });
}

// App extra sobre o mesmo banco e o mesmo stub, com outras opções do serviço.
function appExtra({ pedidos, timeoutMs = 1000 }) {
  const captura = criarCapturaDeLog();
  const app = construirApp(criarConfigTeste({ asaasTimeoutMs: timeoutMs }), {
    pool: ambiente.pool,
    logStream: captura.stream,
    asaas: adaptador(timeoutMs),
    pedidos: { agora: () => AGORA, ...pedidos },
  });
  appsExtras.push(app);
  return { app, captura };
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

let sequenciaCpf = 0;

// CPF válido e único por chamada (dígitos verificadores calculados aqui; os vetores fixos
// do CPF ficam em `documento.test.js`).
function cpfUnico() {
  sequenciaCpf += 1;
  const digitos = [...String(123456000 + sequenciaCpf * 13)].map(Number);
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += digitos[i] * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    digitos.push(resto === 10 ? 0 : resto);
  }
  const cpf = digitos.join('');
  assert.equal(tipoPessoa(cpf), 'fisica', 'o gerador de CPF do teste precisa produzir CPF válido');
  return cpf;
}

const mascarar = (cpf) => `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;

function orcamentoDe(corpo) {
  const { ciclo, contas, addons, dominio } = corpo;
  return calcularOrcamento({ ciclo, contas, addons, dominio });
}

function totalDe(corpo) {
  const { totais } = orcamentoDe(corpo);
  return totais.recorrente_ciclo_centavos + totais.avulso_centavos;
}

function marcarSensiveis(corpo) {
  const { cliente } = corpo;
  for (const valor of [cliente?.documento, cliente?.nome, cliente?.email, cliente?.telefone, corpo.chave_idempotencia]) {
    if (typeof valor === 'string' && valor.length > 0) sensiveis.add(valor);
  }
  for (const nome of [corpo.dominio?.nome, ...(corpo.dominios_extras ?? [])]) {
    const radical = typeof nome === 'string' ? nome.toLowerCase().replace(/^www\./, '').split('.')[0] : '';
    if (radical.length >= 8) sensiveis.add(radical);
  }
}

// Pedido válido por padrão: mensal, 5×5 GB + 1×50 GB, domínio existente, sem extra (72,50).
function montarCorpo(sobre = {}) {
  const { cliente, ...resto } = sobre;
  const corpo = {
    chave_idempotencia: randomUUID(),
    versao_tabela: VERSAO,
    ciclo: 'mensal',
    contas: { '5gb': 5, '50gb': 1 },
    addons: {},
    dominio: { tipo: 'existente', nome: 'exemplo-ficticio.com' },
    cliente: { nome: 'Fulana de Teste', email: 'fulana@exemplo.test', telefone: '11999990000', documento: cpfUnico(), ...cliente },
    ...resto,
  };
  if (corpo.total_exibido_centavos === undefined) corpo.total_exibido_centavos = totalDe(corpo);
  marcarSensiveis(corpo);
  return corpo;
}

// Domínio novo mais 1 extra e 2 Talk: o exemplo do plano (23.990 = 8.190 recorrente + 15.800 avulso).
function corpoComDominios(sobre = {}) {
  return montarCorpo({
    addons: { talk: 2, extraDom: 1 },
    dominio: { tipo: 'novo', nome: 'exemplo-ficticio' },
    dominios_extras: ['outro-ficticio.com.br'],
    ...sobre,
  });
}

async function enviar(corpo, app = ambiente.app) {
  const resposta = await app.inject({ method: 'POST', url: '/api/pedidos', payload: corpo });
  return { status: resposta.statusCode, corpo: resposta.json() };
}

async function linhas(sql, parametros = []) {
  const { rows } = await ambiente.pool.query(sql, parametros);
  return rows;
}

async function contar(sql, parametros = []) {
  return (await linhas(sql, parametros))[0].n;
}

async function pedidoPorChave(chave) {
  return (await linhas('SELECT * FROM pedido WHERE chave_idempotencia = $1', [chave]))[0];
}

const contarPedidos = (chave) => contar('SELECT count(*)::int AS n FROM pedido WHERE chave_idempotencia = $1', [chave]);
const contarAssinaturas = (pedidoId) => contar('SELECT count(*)::int AS n FROM assinatura WHERE pedido_id = $1', [pedidoId]);
const assinaturasDe = (pedidoId) => linhas('SELECT * FROM assinatura WHERE pedido_id = $1 ORDER BY tipo', [pedidoId]);

function idDaAssinatura(chamadaDePagamentos) {
  return chamadaDePagamentos.caminho.split('/')[2];
}

const ROTULOS_CONTAS = [
  'GET /customers', 'POST /customers', 'GET /subscriptions', 'POST /subscriptions', ROTA_PAGAMENTOS,
];

function esperadoDaFalha(status) {
  return { status, corpo: { erro: 'asaas_indisponivel', mensagem: TEXTO_INDISPONIVEL } };
}

// ---------------------------------------------------------------------------
// CA1: pedido válido
// ---------------------------------------------------------------------------

test('CA1: pedido mensal válido responde 201 com a fatura de contas e chama o Asaas na ordem do plano', async () => {
  stub.definir(ROTA_PAGAMENTOS, { corpo: { data: [{ invoiceUrl: 'https://stub.test/f/1' }] } });
  const corpo = montarCorpo();
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.match(resposta.corpo.pedidoId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(resposta.corpo, {
    pedidoId: resposta.corpo.pedidoId,
    estado: 'aguardando_pagamento',
    faturas: [{ tipo: 'contas', url: 'https://stub.test/f/1' }],
  });
  assert.deepEqual(stub.rotulos(), ROTULOS_CONTAS);
});

test('CA1: o GET /customers consulta pelo documento e o POST /customers leva externalReference e notificationDisabled', async () => {
  const corpo = montarCorpo();
  await enviar(corpo);

  assert.deepEqual(stub.chamadasDe('GET /customers')[0].query, { cpfCnpj: corpo.cliente.documento });
  const cliente = (await linhas('SELECT id, asaas_cliente_id FROM cliente WHERE documento = $1', [corpo.cliente.documento]))[0];
  assert.deepEqual(stub.chamadasDe('POST /customers')[0].corpo, {
    name: 'Fulana de Teste',
    cpfCnpj: corpo.cliente.documento,
    email: 'fulana@exemplo.test',
    mobilePhone: '11999990000',
    externalReference: `cliente:${cliente.id}`,
    notificationDisabled: true,
  });
});

test('CA1: o POST /subscriptions das contas leva o corpo do plano, com vencimento em Sao_Paulo + 3 dias (2026-12-03)', async () => {
  const corpo = montarCorpo();
  const { corpo: criado } = await enviar(corpo);

  const referencia = `pedido:${criado.pedidoId}:contas`;
  assert.deepEqual(stub.chamadasDe('GET /subscriptions')[0].query, { externalReference: referencia });
  const cliente = (await linhas('SELECT asaas_cliente_id FROM cliente WHERE documento = $1', [corpo.cliente.documento]))[0];
  assert.deepEqual(stub.chamadasDe('POST /subscriptions')[0].corpo, {
    customer: cliente.asaas_cliente_id,
    billingType: 'UNDEFINED',
    cycle: 'MONTHLY',
    value: 72.5,
    nextDueDate: '2026-12-03',
    description: referencia,
    externalReference: referencia,
  });
});

test('CA1: telefone de 10 dígitos vai em phone no POST /customers', async () => {
  await enviar(montarCorpo({ cliente: { telefone: '1133330000' } }));
  const enviado = stub.chamadasDe('POST /customers')[0].corpo;
  assert.equal(enviado.phone, '1133330000');
  assert.equal('mobilePhone' in enviado, false);
});

test('CA1: toda chamada ao Asaas leva access_token e User-Agent', async () => {
  await enviar(montarCorpo());
  assert.equal(stub.chamadas.length, 5);
  for (const chamada of stub.chamadas) {
    assert.equal(chamada.cabecalhos.access_token, CHAVE_API, chamada.rotulo);
    assert.equal(chamada.cabecalhos['user-agent'], 'citmail-api', chamada.rotulo);
  }
});

test('CA1: no ciclo anual a assinatura de contas é YEARLY e vale a mensalidade × 12 em reais', async () => {
  const corpo = montarCorpo({ ciclo: 'anual' });
  const { totais } = orcamentoDe(corpo);
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  const enviado = stub.chamadasDe('POST /subscriptions')[0].corpo;
  assert.equal(enviado.cycle, 'YEARLY');
  assert.equal(enviado.value, (totais.recorrente_mensal_centavos * 12) / 100);
  assert.equal(totais.recorrente_ciclo_centavos, totais.recorrente_mensal_centavos * 12);
});

// ---------------------------------------------------------------------------
// CA2: assinatura de domínios
// ---------------------------------------------------------------------------

test('CA2: domínio novo mais 1 extra cria a assinatura de domínios anual de 158,00 e devolve 2 faturas', async () => {
  const corpo = corpoComDominios();
  assert.equal(corpo.total_exibido_centavos, 23990);
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.deepEqual(resposta.corpo.faturas.map((f) => f.tipo), ['contas', 'dominios']);
  assert.ok(resposta.corpo.faturas.every((f) => /^https:\/\/stub\.test\/f\/\d+$/.test(f.url)));
  assert.deepEqual(stub.rotulos(), [
    'GET /customers', 'POST /customers',
    'GET /subscriptions', 'POST /subscriptions', ROTA_PAGAMENTOS,
    'GET /subscriptions', 'POST /subscriptions', ROTA_PAGAMENTOS,
  ]);
  const [contas, dominios] = stub.chamadasDe('POST /subscriptions').map((c) => c.corpo);
  assert.equal(contas.cycle, 'MONTHLY');
  assert.equal(contas.value, 81.9);
  assert.equal(contas.externalReference, `pedido:${resposta.corpo.pedidoId}:contas`);
  assert.equal(dominios.cycle, 'YEARLY');
  assert.equal(dominios.value, 158);
  assert.equal(dominios.externalReference, `pedido:${resposta.corpo.pedidoId}:dominios`);
  assert.equal(dominios.description, dominios.externalReference);
  assert.equal(dominios.nextDueDate, '2026-12-03');
});

test('CA2: só o domínio novo (sem extra) cria a assinatura de domínios anual de 79,00', async () => {
  const resposta = await enviar(montarCorpo({ dominio: { tipo: 'novo', nome: 'exemplo-ficticio' } }));

  assert.equal(resposta.status, 201);
  assert.equal(resposta.corpo.faturas.length, 2);
  const dominios = stub.chamadasDe('POST /subscriptions')[1].corpo;
  assert.equal(dominios.value, 79);
  assert.equal(dominios.cycle, 'YEARLY');
});

test('CA2: domínio existente com 1 extra cria a assinatura de domínios de 79,00 (só o extra)', async () => {
  const corpo = montarCorpo({
    addons: { extraDom: 1 },
    dominios_extras: ['outro-ficticio.com.br'],
  });
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.deepEqual(resposta.corpo.faturas.map((f) => f.tipo), ['contas', 'dominios']);
  assert.equal(stub.chamadasDe('POST /subscriptions')[1].corpo.value, 79);
});

test('CA2: domínio existente sem extra cria só 1 assinatura e devolve 1 fatura', async () => {
  const resposta = await enviar(montarCorpo());

  assert.equal(resposta.status, 201);
  assert.deepEqual(resposta.corpo.faturas.map((f) => f.tipo), ['contas']);
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 1);
});

test('CA2: no ciclo anual as duas assinaturas são YEARLY', async () => {
  await enviar(corpoComDominios({ ciclo: 'anual' }));
  const ciclos = stub.chamadasDe('POST /subscriptions').map((c) => c.corpo.cycle);
  assert.deepEqual(ciclos, ['YEARLY', 'YEARLY']);
});

// ---------------------------------------------------------------------------
// CA3: cliente reaproveitado e contato no pedido
// ---------------------------------------------------------------------------

test('CA3: 2º pedido do mesmo documento não consulta nem cria cliente no Asaas e guarda o contato de cada pedido', async () => {
  const documento = cpfUnico();
  const primeiro = montarCorpo({ cliente: { documento } });
  const segundo = montarCorpo({
    cliente: { documento, nome: 'Beltrana de Teste', email: 'beltrana@exemplo.test', telefone: '11988887777' },
  });

  assert.equal((await enviar(primeiro)).status, 201);
  assert.equal((await enviar(segundo)).status, 201);

  assert.equal(stub.chamadasDe('GET /customers').length, 1);
  assert.equal(stub.chamadasDe('POST /customers').length, 1);
  assert.equal(await contar('SELECT count(*)::int AS n FROM cliente WHERE documento = $1', [documento]), 1);

  const cliente = (await linhas('SELECT * FROM cliente WHERE documento = $1', [documento]))[0];
  assert.equal(cliente.nome, 'Fulana de Teste');
  assert.equal(cliente.email, 'fulana@exemplo.test');
  const pedido1 = await pedidoPorChave(primeiro.chave_idempotencia);
  const pedido2 = await pedidoPorChave(segundo.chave_idempotencia);
  assert.equal(pedido1.cliente_id, cliente.id);
  assert.equal(pedido2.cliente_id, cliente.id);
  assert.equal(pedido2.contato_nome, 'Beltrana de Teste');
  assert.equal(pedido2.contato_email, 'beltrana@exemplo.test');
  assert.equal(pedido2.contato_telefone, '11988887777');
  assert.equal(pedido1.contato_nome, 'Fulana de Teste');
  const customers = stub.chamadasDe('POST /subscriptions').map((c) => c.corpo.customer);
  assert.deepEqual(customers, [cliente.asaas_cliente_id, cliente.asaas_cliente_id]);
});

test('CA3: cliente que só existe no Asaas (GET /customers) é reaproveitado sem POST /customers', async () => {
  const corpo = montarCorpo();
  stub.semearCliente({ id: 'cus_existente', documento: corpo.cliente.documento, nome: 'Fulana de Teste', email: 'fulana@exemplo.test' });
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadasDe('POST /customers').length, 0);
  const cliente = (await linhas('SELECT asaas_cliente_id FROM cliente WHERE documento = $1', [corpo.cliente.documento]))[0];
  assert.equal(cliente.asaas_cliente_id, 'cus_existente');
  assert.equal(stub.chamadasDe('POST /subscriptions')[0].corpo.customer, 'cus_existente');
});

// ---------------------------------------------------------------------------
// CA4 e CA14: erro do Asaas e repetição
// ---------------------------------------------------------------------------

// A compensação consulta `pedido:<id>:contas` pelo externalReference (1 GET /subscriptions a mais).
const ROTAS_DE_CRIACAO = [
  ['GET /customers', ['GET /customers', 'GET /subscriptions']],
  ['POST /customers', ['GET /customers', 'POST /customers', 'GET /customers', 'GET /subscriptions']],
  ['GET /subscriptions', ['GET /customers', 'POST /customers', 'GET /subscriptions', 'GET /subscriptions']],
  ['POST /subscriptions', ['GET /customers', 'POST /customers', 'GET /subscriptions', 'POST /subscriptions', 'GET /subscriptions', 'GET /subscriptions']],
];
const FALHAS_DO_ASAAS = [
  ['400', { status: 400 }, 502, 'asaas_http_4xx'],
  ['500', { status: 500 }, 502, 'asaas_http_5xx'],
  ['sem resposta', { semResposta: true }, 504, 'asaas_timeout'],
];

for (const [rota, rotulosEsperados] of ROTAS_DE_CRIACAO) {
  for (const [nomeFalha, comportamento, statusEsperado, motivo] of FALHAS_DO_ASAAS) {
    test(`CA4 e CA14: ${rota} com ${nomeFalha} responde ${statusEsperado}, grava ${motivo}, não deixa assinatura e a repetição devolve o mesmo`, async () => {
      stub.definir(rota, comportamento);
      const corpo = montarCorpo();
      const resposta = await enviar(corpo);

      assert.deepEqual(resposta, esperadoDaFalha(statusEsperado));
      assert.ok(!JSON.stringify(resposta).includes(MARCADOR_CORPO));
      assert.deepEqual(stub.rotulos(), rotulosEsperados);
      const pedido = await pedidoPorChave(corpo.chave_idempotencia);
      assert.equal(pedido.estado, 'falhou_na_criacao');
      assert.equal(pedido.falha_motivo, motivo);
      assert.equal(pedido.criando_desde, null);
      assert.equal(await contarAssinaturas(pedido.id), 0);
      assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 0);

      const chamadasAntes = stub.chamadas.length;
      const repeticao = await enviar(corpo);
      assert.deepEqual(repeticao, resposta);
      assert.equal(stub.chamadas.length, chamadasAntes);
      assert.equal(await contarPedidos(corpo.chave_idempotencia), 1);
    });
  }
}

test('CA4: a falha é logada com pedidoId e falhaMotivo, sem o corpo do stub', async () => {
  stub.definir('POST /subscriptions', { status: 500 });
  const corpo = montarCorpo();
  await enviar(corpo);

  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  const linha = ambiente.captura.linhas().find((l) => l.pedidoId === pedido.id && l.falhaMotivo === 'asaas_http_5xx');
  assert.ok(linha, 'log de falha com pedidoId e falhaMotivo');
  assert.equal(linha.operacao, 'criar_assinatura');
  assert.equal(linha.statusAsaas, 500);
});

// ---------------------------------------------------------------------------
// CA5: timeout com recurso criado
// ---------------------------------------------------------------------------

test('CA5: POST /subscriptions aceito mas respondido tarde é achado pelo GET por externalReference (201, 1 POST, 1 linha)', async () => {
  stub.definir('POST /subscriptions', { respostaTardiaMs: 1600 });
  const corpo = montarCorpo();
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 1);
  assert.equal(stub.chamadasDe('GET /subscriptions').length, 2);
  assert.equal(await contarAssinaturas(resposta.corpo.pedidoId), 1);
  assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 0);
});

test('CA5: POST /customers aceito mas respondido tarde é achado pelo GET por documento (201, 1 POST de cliente)', async () => {
  stub.definir('POST /customers', { respostaTardiaMs: 1600 });
  const corpo = montarCorpo();
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadasDe('POST /customers').length, 1);
  assert.equal(stub.chamadasDe('GET /customers').length, 2);
  const cliente = (await linhas('SELECT asaas_cliente_id FROM cliente WHERE documento = $1', [corpo.cliente.documento]))[0];
  assert.match(cliente.asaas_cliente_id, /^cus_stub_/);
  assert.equal(stub.chamadasDe('POST /subscriptions')[0].corpo.customer, cliente.asaas_cliente_id);
});

// ---------------------------------------------------------------------------
// CA6: sem cartão
// ---------------------------------------------------------------------------

const VARIACOES_DE_CARTAO = [
  ['cliente.creditCard', (c) => ({ ...c, cliente: { ...c.cliente, creditCard: { number: '4111' } } })],
  ['creditCard', (c) => ({ ...c, creditCard: { number: '4111' } })],
  ['creditCardToken', (c) => ({ ...c, creditCardToken: 'tok_ficticio' })],
  ['cartao', (c) => ({ ...c, cartao: '4111' })],
  ['contas.cartao', (c) => ({ ...c, contas: { ...c.contas, cartao: 1 } })],
  ['dominio.cartao', (c) => ({ ...c, dominio: { ...c.dominio, cartao: 'x' } })],
];

for (const [nome, variar] of VARIACOES_DE_CARTAO) {
  test(`CA6: campo ${nome} no corpo responde 400 campo não permitido, sem chamar o Asaas nem gravar`, async () => {
    const corpo = variar(montarCorpo());
    const pedidosAntes = await contar('SELECT count(*)::int AS n FROM pedido');
    const clientesAntes = await contar('SELECT count(*)::int AS n FROM cliente');
    const resposta = await enviar(corpo);

    assert.equal(resposta.status, 400);
    assert.ok(
      resposta.corpo.campos.some((c) => c.mensagem === 'campo não permitido'),
      JSON.stringify(resposta.corpo),
    );
    assert.equal(stub.chamadas.length, 0);
    assert.equal(await contar('SELECT count(*)::int AS n FROM pedido'), pedidosAntes);
    assert.equal(await contar('SELECT count(*)::int AS n FROM cliente'), clientesAntes);
  });
}

// ---------------------------------------------------------------------------
// CA7: gravação
// ---------------------------------------------------------------------------

test('CA7: o pedido de domínios e contas grava pedido, domínios, assinaturas e cliente com os valores do plano', async () => {
  const corpo = corpoComDominios();
  const orcamento = orcamentoDe(corpo);
  const resposta = await enviar(corpo);
  assert.equal(resposta.status, 201);

  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.id, resposta.corpo.pedidoId);
  assert.equal(pedido.estado, 'aguardando_pagamento');
  assert.equal(pedido.criando_desde, null);
  assert.equal(pedido.ciclo, 'mensal');
  assert.equal(pedido.total_centavos, 23990);
  assert.equal(pedido.versao_tabela_precos, VERSAO);
  assert.deepEqual(pedido.itens, { itens: orcamento.itens, avulsos: orcamento.avulsos });
  assert.equal(pedido.contato_nome, 'Fulana de Teste');
  assert.equal(pedido.contato_email, 'fulana@exemplo.test');
  assert.equal(pedido.contato_telefone, '11999990000');
  assert.equal(pedido.falha_motivo, null);
  assert.match(pedido.corpo_hash, /^[0-9a-f]{64}$/);
  assert.ok(pedido.request_id);

  const dominios = await linhas('SELECT id, nome, tipo, papel FROM pedido_dominio WHERE pedido_id = $1 ORDER BY papel', [pedido.id]);
  assert.deepEqual(dominios.map(({ nome, tipo, papel }) => ({ nome, tipo, papel })), [
    { nome: 'outro-ficticio.com.br', tipo: 'novo', papel: 'extra' },
    { nome: 'exemplo-ficticio.com.br', tipo: 'novo', papel: 'principal' },
  ]);
  assert.ok(dominios.every((d) => /^[0-9a-f-]{36}$/.test(d.id)));

  const assinaturas = await assinaturasDe(pedido.id);
  assert.deepEqual(assinaturas.map((a) => [a.tipo, a.ciclo, a.valor_centavos, a.estado]), [
    ['contas', 'mensal', 8190, 'ativa'],
    ['dominios', 'anual', 15800, 'ativa'],
  ]);
  assert.ok(assinaturas.every((a) => /^sub_stub_\d+$/.test(a.asaas_assinatura_id)));
  assert.deepEqual(assinaturas.map((a) => a.url_primeira_fatura), resposta.corpo.faturas.map((f) => f.url));
  assert.ok(assinaturas.every((a) => a.cliente_id === pedido.cliente_id));

  const cliente = (await linhas('SELECT * FROM cliente WHERE id = $1', [pedido.cliente_id]))[0];
  assert.match(cliente.asaas_cliente_id, /^cus_stub_/);
  assert.equal(cliente.tipo_pessoa, 'fisica');
  assert.equal(cliente.documento, corpo.cliente.documento);
});

test('CA7: nenhuma tabela de conta do titular é criada por esta história (fica para a #64)', async () => {
  const tabelas = (await linhas("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((t) => t.table_name);
  assert.deepEqual(tabelas.filter((t) => /conta|titular|usuario|mailbox/.test(t)), []);
});

// ---------------------------------------------------------------------------
// CA8: idempotência
// ---------------------------------------------------------------------------

test('CA8: mesma chave e mesmo corpo em sequência devolve o mesmo 201, sem novo pedido nem nova chamada', async () => {
  const corpo = corpoComDominios();
  const primeira = await enviar(corpo);
  const chamadasAntes = stub.chamadas.length;
  const segunda = await enviar(corpo);

  assert.equal(primeira.status, 201);
  assert.deepEqual(segunda, primeira);
  assert.equal(await contarPedidos(corpo.chave_idempotencia), 1);
  assert.equal(await contarAssinaturas(primeira.corpo.pedidoId), 2);
  assert.equal(stub.chamadas.length, chamadasAntes);
});

test('CA8: duas requisições simultâneas com a mesma chave dão um 201 e um 409 pedido_em_criacao, com uma só criação', async () => {
  stub.definir('POST /subscriptions', { atrasoMs: 500 });
  const corpo = montarCorpo();
  const [a, b] = await Promise.all([enviar(corpo), enviar(corpo)]);

  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const conflito = a.status === 409 ? a : b;
  assert.deepEqual(conflito.corpo, { erro: 'pedido_em_criacao' });
  assert.equal(await contarPedidos(corpo.chave_idempotencia), 1);
  assert.deepEqual(stub.rotulos(), ROTULOS_CONTAS);
});

const VARIACOES_DE_CORPO = [
  ['ciclo (com o total recalculado)', (c) => ({ ...c, ciclo: 'anual', total_exibido_centavos: totalDe({ ...c, ciclo: 'anual' }) })],
  ['quantidade de contas (com o total recalculado)', (c) => {
    const contas = { '5gb': 4, '50gb': 1 };
    return { ...c, contas, total_exibido_centavos: totalDe({ ...c, contas }) };
  }],
  ['nome do domínio principal', (c) => ({ ...c, dominio: { ...c.dominio, nome: 'outro-ficticio.com' } })],
  ['documento', (c) => ({ ...c, cliente: { ...c.cliente, documento: cpfUnico() } })],
  ['e-mail', (c) => ({ ...c, cliente: { ...c.cliente, email: 'outra@exemplo.test' } })],
  ['nome do cliente', (c) => ({ ...c, cliente: { ...c.cliente, nome: 'Outra Pessoa de Teste' } })],
  ['telefone', (c) => ({ ...c, cliente: { ...c.cliente, telefone: '11977776666' } })],
];

for (const [nome, variar] of VARIACOES_DE_CORPO) {
  test(`CA8: mesma chave com outro ${nome} responde 422 chave_reutilizada sem chamar o Asaas`, async () => {
    const corpo = montarCorpo();
    const primeira = await enviar(corpo);
    assert.equal(primeira.status, 201);
    const chamadasAntes = stub.chamadas.length;

    const variado = variar(corpo);
    marcarSensiveis(variado);
    const resposta = await enviar(variado);

    assert.deepEqual(resposta, { status: 422, corpo: { erro: 'chave_reutilizada' } });
    assert.equal(stub.chamadas.length, chamadasAntes);
    assert.equal(await contarPedidos(corpo.chave_idempotencia), 1);
  });
}

test('CA8: documento com máscara, e-mail em maiúsculas, nome com espaços extras e telefone formatado valem como o mesmo corpo (201)', async () => {
  const corpo = montarCorpo();
  const primeira = await enviar(corpo);
  const chamadasAntes = stub.chamadas.length;

  const mascarado = {
    ...corpo,
    cliente: {
      nome: '  Fulana   de  Teste ',
      email: 'FULANA@exemplo.test',
      telefone: '(11) 99999-0000',
      documento: mascarar(corpo.cliente.documento),
    },
  };
  const segunda = await enviar(mascarado);

  assert.deepEqual(segunda, primeira);
  assert.equal(stub.chamadas.length, chamadasAntes);
});

test('CA8: o domínio principal com www, maiúsculas e ponto final vale como o mesmo corpo (201)', async () => {
  const corpo = montarCorpo({ dominio: { tipo: 'novo', nome: 'exemplo-ficticio' } });
  const primeira = await enviar(corpo);
  const segunda = await enviar({ ...corpo, dominio: { tipo: 'novo', nome: 'WWW.Exemplo-Ficticio.com.br.' } });

  assert.deepEqual(segunda, primeira);
});

test('CA8: reenvio depois que a tabela de preços mudou devolve o pedido gravado, não o 409', async () => {
  const corpo = montarCorpo();
  const primeira = await enviar(corpo);
  const { app: appNova } = appExtra({ pedidos: { versaoTabela: '2099-01-01.1' } });

  const reenvio = await enviar(corpo, appNova);
  const novoPedido = await enviar(montarCorpo(), appNova);

  assert.equal(primeira.status, 201);
  assert.deepEqual(reenvio, primeira);
  assert.deepEqual(novoPedido.corpo, {
    erro: 'total_divergente',
    total_centavos: 7250,
    versao_tabela: '2099-01-01.1',
  });
  assert.equal(novoPedido.status, 409);
});

// ---------------------------------------------------------------------------
// CA9: retomada de `criando`
// ---------------------------------------------------------------------------

// Cria o pedido por inteiro e o devolve ao estado `criando`, sem as linhas de assinatura e
// com `criando_desde` no passado (a assinatura segue no stub, achável pelo externalReference).
async function pedidoEmCriando(corpo, idade) {
  const criado = await enviar(corpo);
  assert.equal(criado.status, 201);
  await ambiente.pool.query('DELETE FROM assinatura WHERE pedido_id = $1', [criado.corpo.pedidoId]);
  await ambiente.pool.query(
    "UPDATE pedido SET estado = 'criando', criando_desde = now() - $2::interval WHERE id = $1",
    [criado.corpo.pedidoId, idade],
  );
  return criado;
}

test('CA9: pedido em criando dentro do prazo responde 409 pedido_em_criacao sem chamar o Asaas', async () => {
  const corpo = montarCorpo();
  await pedidoEmCriando(corpo, '1 second');
  const chamadasAntes = stub.chamadas.length;

  const resposta = await enviar(corpo);

  assert.deepEqual(resposta, { status: 409, corpo: { erro: 'pedido_em_criacao' } });
  assert.equal(stub.chamadas.length, chamadasAntes);
});

test('CA9: pedido em criando além do prazo é retomado pela mesma chave, sem novo POST das contas (201)', async () => {
  const corpo = montarCorpo();
  const criado = await pedidoEmCriando(corpo, '1 hour');
  const chamadasAntes = stub.chamadas.length;

  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal(resposta.corpo.pedidoId, criado.corpo.pedidoId);
  assert.deepEqual(stub.chamadas.slice(chamadasAntes).map((c) => c.rotulo), ['GET /subscriptions', ROTA_PAGAMENTOS]);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'aguardando_pagamento');
  assert.equal(pedido.criando_desde, null);
  assert.equal(await contarAssinaturas(pedido.id), 1);
  assert.ok(ambiente.captura.linhas().some((l) => l.msg === 'pedido retomado' && l.pedidoId === pedido.id));
});

test('CA9: a retomada com corpo diferente responde 422, sem tomar a posse', async () => {
  const corpo = montarCorpo();
  await pedidoEmCriando(corpo, '1 hour');

  const resposta = await enviar({ ...corpo, cliente: { ...corpo.cliente, email: 'outra@exemplo.test' } });

  assert.deepEqual(resposta, { status: 422, corpo: { erro: 'chave_reutilizada' } });
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'criando');
});

test('CA9: duas retomadas simultâneas dão um 201 e um 409, com uma só linha de assinatura e nenhum POST', async () => {
  const corpo = montarCorpo();
  const criado = await pedidoEmCriando(corpo, '1 hour');
  stub.definir('GET /subscriptions', { atrasoMs: 300 });
  const chamadasAntes = stub.chamadas.length;

  const [a, b] = await Promise.all([enviar(corpo), enviar(corpo)]);

  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.deepEqual((a.status === 409 ? a : b).corpo, { erro: 'pedido_em_criacao' });
  assert.equal(await contarAssinaturas(criado.corpo.pedidoId), 1);
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 1);
  // Só quem ganhou a posse chama o Asaas: a perdedora não faz nenhuma chamada.
  assert.deepEqual(stub.chamadas.slice(chamadasAntes).map((c) => c.rotulo), ['GET /subscriptions', ROTA_PAGAMENTOS]);
});

test('CA9: original parado no POST e retomada que toma a posse: a retomada completa (201) e o original responde 409 sem gravar nem remover', async () => {
  const corpo = montarCorpo();
  stub.definir('POST /subscriptions', ({ n }) => (n === 1 ? { atrasoMs: 600 } : undefined));
  stub.definir('GET /subscriptions', ({ n }) => (n === 2 ? { atrasoMs: 1500 } : undefined));
  const { app: appRetomada } = appExtra({ pedidos: { prazoCriandoMs: 100 }, timeoutMs: 5000 });

  const original = enviar(corpo);
  await stub.esperarChamada('POST /subscriptions', 1);
  await esperar(250);
  const retomada = await enviar(corpo, appRetomada);
  const respostaOriginal = await original;

  assert.equal(retomada.status, 201);
  assert.deepEqual(respostaOriginal, { status: 409, corpo: { erro: 'pedido_em_criacao' } });
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'aguardando_pagamento');
  const assinaturas = await assinaturasDe(pedido.id);
  assert.deepEqual(assinaturas.map((a) => a.tipo), ['contas']);
  assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 0);
  assert.ok(ambiente.captura.linhas().some((l) => l.msg === 'posse perdida' && l.pedidoId === pedido.id));
});

test('CA9: original que falha depois de perder a posse responde 409, sem compensar a assinatura que a retomada reaproveita', async () => {
  const corpo = corpoComDominios();
  stub.definir('POST /subscriptions', ({ n }) => (n === 2 ? { atrasoMs: 600, status: 500 } : undefined));
  stub.definir(ROTA_PAGAMENTOS, ({ n }) => (n === 2 ? { atrasoMs: 1500 } : undefined));
  const { app: appRetomada } = appExtra({ pedidos: { prazoCriandoMs: 100 }, timeoutMs: 5000 });

  const original = enviar(corpo);
  await stub.esperarChamada('POST /subscriptions', 2);
  await esperar(250);
  const retomada = await enviar(corpo, appRetomada);
  const respostaOriginal = await original;

  assert.equal(retomada.status, 201);
  assert.deepEqual(respostaOriginal, { status: 409, corpo: { erro: 'pedido_em_criacao' } });
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'aguardando_pagamento');
  assert.equal(pedido.falha_motivo, null);
  assert.deepEqual((await assinaturasDe(pedido.id)).map((a) => a.tipo), ['contas', 'dominios']);
  assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 0);
  assert.equal(stub.assinaturasVivas().length, 2);
});

// ---------------------------------------------------------------------------
// CA10: total divergente
// ---------------------------------------------------------------------------

async function semEfeitos(documento) {
  assert.equal(stub.chamadas.length, 0);
  assert.equal(await contar('SELECT count(*)::int AS n FROM cliente WHERE documento = $1', [documento]), 0);
}

for (const [rotulo, ajuste] of [['1 centavo a mais', 1], ['1 centavo a menos', -1]]) {
  test(`CA10: total_exibido_centavos com ${rotulo} responde 409 total_divergente, sem linhas nem chamadas`, async () => {
    const corpo = montarCorpo();
    const resposta = await enviar({ ...corpo, total_exibido_centavos: corpo.total_exibido_centavos + ajuste });

    assert.deepEqual(resposta, {
      status: 409,
      corpo: { erro: 'total_divergente', total_centavos: 7250, versao_tabela: VERSAO },
    });
    await semEfeitos(corpo.cliente.documento);
    assert.equal(await contarPedidos(corpo.chave_idempotencia), 0);
  });
}

test('CA10: versao_tabela antiga responde 409 total_divergente com o total e a versão atuais', async () => {
  const corpo = montarCorpo();
  const resposta = await enviar({ ...corpo, versao_tabela: '2026-01-01.1' });

  assert.deepEqual(resposta, {
    status: 409,
    corpo: { erro: 'total_divergente', total_centavos: 7250, versao_tabela: VERSAO },
  });
  await semEfeitos(corpo.cliente.documento);
});

test('CA10: a versão da tabela de preços em vigor é a do plano (2026-11-07.1)', () => {
  assert.equal(VERSAO, '2026-11-07.1');
});

test('CA10: o total do pedido inclui o avulso de domínios (23.990 no exemplo do plano)', async () => {
  const corpo = corpoComDominios();
  const resposta = await enviar({ ...corpo, total_exibido_centavos: 8190 });

  assert.deepEqual(resposta.corpo, { erro: 'total_divergente', total_centavos: 23990, versao_tabela: VERSAO });
});

// ---------------------------------------------------------------------------
// CA11: documento e domínios
// ---------------------------------------------------------------------------

const DOCUMENTOS_RECUSADOS = [
  ['CPF com dígito verificador errado', '52998224724'],
  ['CPF com dígitos repetidos', '11111111111'],
  ['CNPJ numérico com dígito verificador errado', '11222333000182'],
  ['CPF com sequência inválida', '12345678912'],
];

for (const [rotulo, documento] of DOCUMENTOS_RECUSADOS) {
  test(`CA11: ${rotulo} responde 400 cliente.documento valor inválido, sem chamadas nem linhas`, async () => {
    const resposta = await enviar(montarCorpo({ cliente: { documento } }));

    assert.equal(resposta.status, 400);
    assert.deepEqual(resposta.corpo.campos, [{ campo: 'cliente.documento', mensagem: 'valor inválido' }]);
    assert.equal(stub.chamadas.length, 0);
    assert.equal(await contar('SELECT count(*)::int AS n FROM cliente WHERE documento = $1', [documento]), 0);
  });
}

const DOCUMENTOS_ACEITOS = [
  ['CPF com máscara', () => mascarar(cpfUnico()), 'fisica', (d) => d.replace(/\D/g, '')],
  ['CNPJ numérico', () => '11222333000181', 'juridica', (d) => d],
  ['CNPJ alfanumérico (exemplo da Receita)', () => '12ABC34501DE35', 'juridica', (d) => d],
  ['CNPJ alfanumérico com máscara e minúsculas', () => '12.abc.345/01de-35', 'juridica', () => '12ABC34501DE35'],
];

for (const [rotulo, gerar, tipo, normalizar] of DOCUMENTOS_ACEITOS) {
  test(`CA11: ${rotulo} é aceito e gravado normalizado como ${tipo}`, async () => {
    const documento = gerar();
    const esperado = normalizar(documento);
    // Os CNPJ são fixos: o cliente pode já existir de outro cenário (então não há GET /customers).
    const corpo = montarCorpo({ cliente: { documento } });
    sensiveis.add(esperado);
    const resposta = await enviar(corpo);

    assert.equal(resposta.status, 201, JSON.stringify(resposta.corpo));
    const cliente = (await linhas('SELECT tipo_pessoa, documento FROM cliente WHERE documento = $1', [esperado]))[0];
    assert.deepEqual(cliente, { tipo_pessoa: tipo, documento: esperado });
  });
}

test('CA11: domínio novo com www, maiúsculas, .com.br e ponto final é gravado como exemplo-ficticio.com.br', async () => {
  const corpo = montarCorpo({ dominio: { tipo: 'novo', nome: 'www.Exemplo-Ficticio.com.br.' } });
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  const dominios = await linhas('SELECT nome, tipo, papel FROM pedido_dominio WHERE pedido_id = $1', [pedido.id]);
  assert.deepEqual(dominios, [{ nome: 'exemplo-ficticio.com.br', tipo: 'novo', papel: 'principal' }]);
});

for (const nome of ['123', 'a', 'ab--cd', '-ab']) {
  test(`CA11: domínio novo ${JSON.stringify(nome)} responde 400 dominio.nome`, async () => {
    const resposta = await enviar(montarCorpo({ dominio: { tipo: 'novo', nome } }));

    assert.equal(resposta.status, 400);
    assert.deepEqual(resposta.corpo.campos, [{ campo: 'dominio.nome', mensagem: 'valor inválido' }]);
    assert.equal(stub.chamadas.length, 0);
  });
}

test('CA11: domínio extra x.com responde 400 dominios_extras.0', async () => {
  const resposta = await enviar(montarCorpo({ addons: { extraDom: 1 }, dominios_extras: ['x.com'] }));

  assert.equal(resposta.status, 400);
  assert.deepEqual(resposta.corpo.campos, [{ campo: 'dominios_extras.0', mensagem: 'valor inválido' }]);
});

test('CA11: domínio extra repetido ou igual ao principal responde 400 dominios_extras.<i>', async () => {
  const repetido = await enviar(montarCorpo({
    addons: { extraDom: 2 },
    dominios_extras: ['outro-ficticio.com.br', 'OUTRO-ficticio'],
  }));
  assert.deepEqual(repetido.corpo.campos, [{ campo: 'dominios_extras.1', mensagem: 'valor inválido' }]);

  const igualAoPrincipal = await enviar(montarCorpo({
    addons: { extraDom: 1 },
    dominio: { tipo: 'novo', nome: 'exemplo-ficticio' },
    dominios_extras: ['exemplo-ficticio.com.br'],
  }));
  assert.deepEqual(igualAoPrincipal.corpo.campos, [{ campo: 'dominios_extras.0', mensagem: 'valor inválido' }]);
  assert.equal(stub.chamadas.length, 0);
});

test('CA11: domínio existente exemplo-ficticio.com é aceito e gravado como existente', async () => {
  const corpo = montarCorpo({ dominio: { tipo: 'existente', nome: 'Exemplo-Ficticio.com' } });
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  const dominios = await linhas('SELECT nome, tipo, papel FROM pedido_dominio WHERE pedido_id = $1', [pedido.id]);
  assert.deepEqual(dominios, [{ nome: 'exemplo-ficticio.com', tipo: 'existente', papel: 'principal' }]);
});

test('CA11: domínio existente sem_ponto responde 400 dominio.nome', async () => {
  const resposta = await enviar(montarCorpo({ dominio: { tipo: 'existente', nome: 'sem_ponto' } }));

  assert.equal(resposta.status, 400);
  assert.deepEqual(resposta.corpo.campos, [{ campo: 'dominio.nome', mensagem: 'valor inválido' }]);
});

test('CA11: dominios_extras com tamanho diferente de extraDom responde 400 dominios_extras', async () => {
  const faltando = await enviar(montarCorpo({ addons: { extraDom: 1 } }));
  const sobrando = await enviar(montarCorpo({ dominios_extras: ['outro-ficticio.com.br'] }));

  for (const resposta of [faltando, sobrando]) {
    assert.equal(resposta.status, 400);
    assert.deepEqual(resposta.corpo.campos, [{ campo: 'dominios_extras', mensagem: 'valor inválido' }]);
  }
  assert.equal(stub.chamadas.length, 0);
});

test('CA11: chave_idempotencia que não é UUID responde 400', async () => {
  const resposta = await enviar({ ...montarCorpo(), chave_idempotencia: 'nao-e-uuid' });

  assert.equal(resposta.status, 400);
  assert.equal(stub.chamadas.length, 0);
});

test('CA11: pedido sem o bloco cliente responde 400', async () => {
  const { cliente: _descartado, ...semCliente } = montarCorpo();
  const resposta = await enviar(semCliente);

  assert.equal(resposta.status, 400);
});

test('CA11: pedido sem nenhuma conta responde 400 sem chamar o Asaas', async () => {
  const resposta = await enviar(montarCorpo({ contas: {}, total_exibido_centavos: 0 }));

  assert.equal(resposta.status, 400);
  assert.equal(stub.chamadas.length, 0);
});

// ---------------------------------------------------------------------------
// CA12: falha parcial e erros de banco
// ---------------------------------------------------------------------------

const FUNCAO_QUE_FALHA = `
  CREATE OR REPLACE FUNCTION falha_de_teste() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'MENSAGEM-DO-DRIVER' USING ERRCODE = 'XX001';
  END
  $$`;

async function comGatilho({ tabela, evento }, executar) {
  await ambiente.pool.query(FUNCAO_QUE_FALHA);
  await ambiente.pool.query(
    `CREATE TRIGGER gatilho_de_teste BEFORE ${evento} ON ${tabela} FOR EACH ROW EXECUTE FUNCTION falha_de_teste()`,
  );
  try {
    await executar();
  } finally {
    await ambiente.pool.query(`DROP TRIGGER IF EXISTS gatilho_de_teste ON ${tabela}`);
  }
}

test('CA12: 2º POST /subscriptions com 500 remove a assinatura de contas, grava a falha e não deixa linha de assinatura', async () => {
  stub.definir('POST /subscriptions', ({ n }) => (n === 2 ? { status: 500 } : undefined));
  const corpo = corpoComDominios();
  const resposta = await enviar(corpo);

  assert.deepEqual(resposta, esperadoDaFalha(502));
  const contasId = idDaAssinatura(stub.chamadasDe(ROTA_PAGAMENTOS)[0]);
  const remocoes = stub.chamadasDe(ROTA_REMOCAO);
  assert.deepEqual(remocoes.map((r) => r.caminho), [`/subscriptions/${contasId}`]);
  assert.deepEqual(stub.assinaturasVivas(), []);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'falhou_na_criacao');
  assert.equal(pedido.falha_motivo, 'asaas_http_5xx');
  assert.equal(await contarAssinaturas(pedido.id), 0);
});

test('CA12: com o DELETE também falhando, a resposta é a mesma e o log assinatura órfã leva só pedidoId e asaasAssinaturaId', async () => {
  stub.definir('POST /subscriptions', ({ n }) => (n === 2 ? { status: 500 } : undefined));
  stub.definir(ROTA_REMOCAO, { status: 500 });
  const corpo = corpoComDominios();
  const resposta = await enviar(corpo);

  assert.deepEqual(resposta, esperadoDaFalha(502));
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  const contasId = idDaAssinatura(stub.chamadasDe(ROTA_PAGAMENTOS)[0]);
  const orfas = ambiente.captura.linhas().filter((l) => l.msg === 'assinatura órfã' && l.pedidoId === pedido.id);
  assert.equal(orfas.length, 1);
  assert.equal(orfas[0].level, 50);
  assert.equal(orfas[0].asaasAssinaturaId, contasId);
  const permitidas = new Set(['level', 'time', 'pid', 'hostname', 'reqId', 'msg', 'pedidoId', 'asaasAssinaturaId']);
  assert.deepEqual(Object.keys(orfas[0]).filter((chave) => !permitidas.has(chave)), []);
});

test('CA12: erro de banco na transação final remove as 2 assinaturas, grava falha_motivo banco e responde 500 interno só com o code no log', async () => {
  const corpo = corpoComDominios();
  await comGatilho({ tabela: 'assinatura', evento: 'INSERT' }, async () => {
    const resposta = await enviar(corpo);

    assert.equal(resposta.status, 500);
    assert.equal(resposta.corpo.erro, 'interno');
    assert.equal(typeof resposta.corpo.requestId, 'string');
    assert.deepEqual(Object.keys(resposta.corpo).sort(), ['erro', 'requestId']);
  });

  const ids = stub.chamadasDe(ROTA_PAGAMENTOS).map(idDaAssinatura);
  assert.equal(ids.length, 2);
  assert.deepEqual(stub.chamadasDe(ROTA_REMOCAO).map((r) => r.caminho).sort(), ids.map((id) => `/subscriptions/${id}`).sort());
  assert.deepEqual(stub.assinaturasVivas(), []);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'falhou_na_criacao');
  assert.equal(pedido.falha_motivo, 'banco');
  assert.equal(await contarAssinaturas(pedido.id), 0);
  const erroDeBanco = ambiente.captura.linhas().find((l) => l.msg === 'erro de banco no pedido' && l.pedidoId === pedido.id);
  assert.ok(erroDeBanco, 'log erro de banco no pedido');
  assert.equal(erroDeBanco.code, 'XX001');
  assert.ok(!ambiente.captura.texto().includes('MENSAGEM-DO-DRIVER'));
});

test('CA14: o reenvio de um pedido que falhou por banco devolve 500 interno com o requestId da nova requisição, sem nova criação', async () => {
  const corpo = montarCorpo();
  await comGatilho({ tabela: 'assinatura', evento: 'INSERT' }, async () => {
    assert.equal((await enviar(corpo)).status, 500);
  });
  const chamadasAntes = stub.chamadas.length;
  const reenvio = await ambiente.app.inject({ method: 'POST', url: '/api/pedidos', payload: corpo });

  assert.equal(reenvio.statusCode, 500);
  assert.equal(reenvio.json().erro, 'interno');
  assert.equal(reenvio.json().requestId, reenvio.headers['x-request-id']);
  assert.equal(stub.chamadas.length, chamadasAntes);
  assert.equal(await contarPedidos(corpo.chave_idempotencia), 1);
});

test('CA12: erro de banco ao gravar asaas_cliente_id responde 500, grava falha_motivo banco e não cria assinatura', async () => {
  const corpo = montarCorpo();
  await comGatilho({ tabela: 'cliente', evento: 'UPDATE OF asaas_cliente_id' }, async () => {
    const resposta = await enviar(corpo);

    assert.equal(resposta.status, 500);
    assert.equal(resposta.corpo.erro, 'interno');
  });

  assert.equal(stub.chamadasDe('POST /subscriptions').length, 0);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'falhou_na_criacao');
  assert.equal(pedido.falha_motivo, 'banco');
  assert.ok(!ambiente.captura.texto().includes('MENSAGEM-DO-DRIVER'));
});

// ---------------------------------------------------------------------------
// CA13: fatura sem URL
// ---------------------------------------------------------------------------

const FATURA_SEM_URL = [
  ['lista vazia', { corpo: { data: [] } }],
  ['erro 500', { status: 500 }],
  ['sem resposta', { semResposta: true }],
  ['invoiceUrl http://', { corpo: { data: [{ invoiceUrl: 'http://stub.test/f/1' }] } }],
];

for (const [nome, comportamento] of FATURA_SEM_URL) {
  test(`CA13: GET payments com ${nome} responde 201 com url null, pedido aguardando_pagamento e nenhum DELETE`, async () => {
    stub.definir(ROTA_PAGAMENTOS, comportamento);
    const corpo = montarCorpo();
    const resposta = await enviar(corpo);

    assert.equal(resposta.status, 201);
    assert.deepEqual(resposta.corpo.faturas, [{ tipo: 'contas', url: null }]);
    const pedido = await pedidoPorChave(corpo.chave_idempotencia);
    assert.equal(pedido.estado, 'aguardando_pagamento');
    const [assinatura] = await assinaturasDe(pedido.id);
    assert.equal(assinatura.url_primeira_fatura, null);
    assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 0);
  });
}

// ---------------------------------------------------------------------------
// CA15: logs
// ---------------------------------------------------------------------------

test('CA15: o sucesso loga pedido criado só com ids, e o conjunto do log não tem dado pessoal (conferido em cada cenário)', async () => {
  const corpo = corpoComDominios();
  const resposta = await enviar(corpo);

  const linha = ambiente.captura.linhas().find((l) => l.msg === 'pedido criado' && l.pedidoId === resposta.corpo.pedidoId);
  assert.ok(linha);
  assert.equal(linha.estado, 'aguardando_pagamento');
  assert.match(linha.asaasClienteId, /^cus_stub_/);
  semSensiveis(ambiente.captura);
});

// ---------------------------------------------------------------------------
// CA16: configuração da rota, itens removidos e prazo global
// ---------------------------------------------------------------------------

function poolQueNaoPodeSerUsado() {
  const falha = () => {
    throw new Error('o banco não pode ser tocado');
  };
  return { query: falha, connect: falha, on() {}, async end() {} };
}

test('CA16: com a rota desligada em produção (sem PEDIDOS_HABILITADO) o POST /api/pedidos responde 404 sem tocar no banco', async (t) => {
  const { app } = await construirAppTeste({
    comBanco: false,
    pool: poolQueNaoPodeSerUsado(),
    asaas: adaptador(1000),
    sobrescritasConfig: { nodeEnv: 'production' },
  });
  t.after(() => app.close());

  const resposta = await enviar(montarCorpo(), app);

  assert.equal(resposta.status, 404);
  assert.equal(stub.chamadas.length, 0);
});

test('CA16: PEDIDOS_HABILITADO=false desliga a rota também fora de produção (404)', async (t) => {
  const { app } = await construirAppTeste({
    comBanco: false,
    pool: poolQueNaoPodeSerUsado(),
    asaas: adaptador(1000),
    sobrescritasConfig: { pedidosHabilitado: false },
  });
  t.after(() => app.close());

  assert.equal((await enviar(montarCorpo(), app)).status, 404);
});

test('CA16: sem chave nem adaptador injetado, fora de produção, o POST responde 503 asaas_nao_configurado sem tocar no banco', async (t) => {
  const { app } = await construirAppTeste({ comBanco: false, pool: poolQueNaoPodeSerUsado() });
  t.after(() => app.close());

  const resposta = await enviar(montarCorpo(), app);

  assert.deepEqual(resposta, { status: 503, corpo: { erro: 'asaas_nao_configurado' } });
});

test('CA16: com ASAAS_API_KEY e ASAAS_BASE_URL na config, o app cria o adaptador e fala com o stub', async (t) => {
  const { app, pool, fechar } = await construirAppTeste({
    sobrescritasConfig: { asaasApiKey: CHAVE_API, asaasBaseUrl: stub.baseUrl, asaasTimeoutMs: 1000 },
  });
  t.after(fechar);

  const corpo = montarCorpo();
  const resposta = await enviar(corpo, app);

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadas[0].cabecalhos.access_token, CHAVE_API);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedido')).rows[0].n, 1);
});

test('CA16: cliente removido (deleted: true) no GET /customers não é reaproveitado: o fluxo cria um novo', async () => {
  const corpo = montarCorpo();
  stub.semearCliente({ id: `cus_removido_${randomUUID().replaceAll('-', '')}`, documento: corpo.cliente.documento, deleted: true });
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadasDe('POST /customers').length, 1);
  const cliente = (await linhas('SELECT asaas_cliente_id FROM cliente WHERE documento = $1', [corpo.cliente.documento]))[0];
  assert.notEqual(cliente.asaas_cliente_id, 'cus_removido');
  assert.equal(stub.chamadasDe('POST /subscriptions')[0].corpo.customer, cliente.asaas_cliente_id);
});

test('CA16: assinatura removida (deleted: true) no GET /subscriptions não é reaproveitada: o fluxo cria uma nova', async () => {
  stub.definir('GET /subscriptions', { corpo: { data: [{ id: 'sub_removida', deleted: true }] } });
  const corpo = montarCorpo();
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 1);
  const [assinatura] = await assinaturasDe(resposta.corpo.pedidoId);
  assert.notEqual(assinatura.asaas_assinatura_id, 'sub_removida');
});

test('CA16: prazo global: chamadas lentas (cada uma abaixo do timeout) estouram o prazo do pedido e dão 504 asaas_timeout dentro do prazo + confirmação + compensação', async () => {
  const prazoPedidoMs = 1500;
  for (const rotulo of [...ROTULOS_CONTAS, ROTA_REMOCAO]) stub.definir(rotulo, { atrasoMs: 900 });
  const { app } = appExtra({ pedidos: { prazoPedidoMs } });
  const corpo = montarCorpo();

  const inicio = Date.now();
  const resposta = await enviar(corpo, app);
  const duracao = Date.now() - inicio;

  assert.deepEqual(resposta, esperadoDaFalha(504));
  // A confirmação (1 × timeout) e a compensação (até 2 × timeout) ficam fora do prazo global.
  const limite = prazoPedidoMs + 3 * 1000 + 1000;
  assert.ok(duracao <= limite, `duração ${duracao} ms acima de ${limite} ms`);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'falhou_na_criacao');
  assert.equal(pedido.falha_motivo, 'asaas_timeout');
});

// ---------------------------------------------------------------------------
// Revisão: confirmação e compensação fora do prazo global, "cria e não responde"
// ---------------------------------------------------------------------------

// GET /subscriptions: normal, exceto a n-ésima chamada, que devolve 500.
const falhaNaChamada = (alvo) => ({ n }) => (n === alvo ? { status: 500 } : undefined);

test('CA16: POST /subscriptions que cria e não responde, com a confirmação falhando, tem a assinatura criada removida pela compensação (504)', async () => {
  stub.definir('POST /subscriptions', { criaESemResposta: true });
  stub.definir('GET /subscriptions', falhaNaChamada(2));
  const corpo = montarCorpo();
  const resposta = await enviar(corpo);

  assert.deepEqual(resposta, esperadoDaFalha(504));
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 1);
  assert.equal(stub.chamadasDe('GET /subscriptions').length, 3);
  const remocoes = stub.chamadasDe(ROTA_REMOCAO);
  assert.equal(remocoes.length, 1, 'a assinatura criada pelo POST sem resposta precisa ser removida');
  assert.match(remocoes[0].caminho, /^\/subscriptions\/sub_stub_\d+$/);
  assert.deepEqual(stub.assinaturasVivas(), []);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'falhou_na_criacao');
  assert.equal(pedido.falha_motivo, 'asaas_timeout');
  assert.equal(await contarAssinaturas(pedido.id), 0);
  const aviso = ambiente.captura.linhas().find((l) => l.msg === 'confirmação falhou' && l.pedidoId === pedido.id);
  assert.ok(aviso, 'log confirmação falhou');
  assert.equal(aviso.operacao, 'criar_assinatura');
});

test('CA16: POST /subscriptions que cria e não responde, com a confirmação achando a assinatura, a reaproveita (201, 1 POST, 0 DELETE)', async () => {
  stub.definir('POST /subscriptions', { criaESemResposta: true });
  const resposta = await enviar(montarCorpo());

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 1);
  assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 0);
  assert.equal(await contarAssinaturas(resposta.corpo.pedidoId), 1);
});

test('CA16: compensação consulta pedido:<id>:<tipo> de cada tipo, sem assinatura obtida, e remove o que achar', async () => {
  // O 1º POST (contas) cria e não responde; a confirmação falha; a compensação acha as contas.
  stub.definir('POST /subscriptions', { criaESemResposta: true });
  stub.definir('GET /subscriptions', falhaNaChamada(2));
  const corpo = corpoComDominios();
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 504);
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  const consultas = stub.chamadasDe('GET /subscriptions').map((c) => c.query.externalReference);
  assert.deepEqual(consultas, [`pedido:${pedido.id}:contas`, `pedido:${pedido.id}:contas`, `pedido:${pedido.id}:contas`, `pedido:${pedido.id}:dominios`]);
  assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 1);
  assert.deepEqual(stub.assinaturasVivas(), []);
});

test('CA16: falha na consulta da compensação é logada como compensação sem consulta e o pedido falha mesmo assim', async () => {
  stub.definir('POST /subscriptions', { status: 500 });
  stub.definir('GET /subscriptions', ({ n }) => (n >= 2 ? { status: 500 } : undefined));
  const corpo = montarCorpo();
  const resposta = await enviar(corpo);

  assert.deepEqual(resposta, esperadoDaFalha(502));
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.estado, 'falhou_na_criacao');
  assert.ok(ambiente.captura.linhas().some((l) => l.msg === 'compensação sem consulta' && l.pedidoId === pedido.id));
});

test('CA16: com o prazo global esgotado, a confirmação usa sinal próprio e reaproveita a assinatura criada (201)', async () => {
  stub.definir('POST /subscriptions', { criaESemResposta: true });
  const { app } = appExtra({ pedidos: { prazoPedidoMs: 800 }, timeoutMs: 3000 });
  const resposta = await enviar(montarCorpo(), app);

  assert.equal(resposta.status, 201, JSON.stringify(resposta.corpo));
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 1);
  assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 0);
});

test('CA16: com o prazo global esgotado, a compensação usa sinal próprio e remove a assinatura criada', async () => {
  stub.definir('POST /subscriptions', { criaESemResposta: true });
  stub.definir('GET /subscriptions', falhaNaChamada(2));
  const { app } = appExtra({ pedidos: { prazoPedidoMs: 800 }, timeoutMs: 3000 });
  const corpo = montarCorpo();
  const resposta = await enviar(corpo, app);

  assert.equal(resposta.status, 504);
  assert.equal(stub.chamadasDe(ROTA_REMOCAO).length, 1);
  assert.deepEqual(stub.assinaturasVivas(), []);
});

test('CA9: o prazo de retomada padrão é 105 s (45 s + 3 × timeout de 10 s + 30 s)', async () => {
  const { app } = appExtra({ pedidos: {}, timeoutMs: 10000 });
  const corpo = montarCorpo();
  const criado = await pedidoEmCriando(corpo, '100 seconds');
  assert.deepEqual(await enviar(corpo, app), { status: 409, corpo: { erro: 'pedido_em_criacao' } });

  await ambiente.pool.query("UPDATE pedido SET criando_desde = now() - interval '110 seconds' WHERE id = $1", [criado.corpo.pedidoId]);
  assert.equal((await enviar(corpo, app)).status, 201);
});

// ---------------------------------------------------------------------------
// Revisão: assinatura duplicada para o mesmo externalReference
// ---------------------------------------------------------------------------

test('CA16: duas assinaturas ativas no mesmo externalReference: fica a mais antiga e a outra recebe DELETE', async () => {
  const corpo = montarCorpo();
  const sufixo = randomUUID().replaceAll('-', '');
  const [nova, antiga] = [`sub_nova${sufixo}`, `sub_antiga${sufixo}`];
  // A mais nova vem primeiro na lista: a ordem da resposta não decide.
  stub.definir('GET /subscriptions', {
    corpo: {
      data: [
        { id: nova, dateCreated: '2026-02-01T00:00:00Z' },
        { id: antiga, dateCreated: '2026-01-01T00:00:00Z' }
      ]
    }
  });
  stub.definir(ROTA_PAGAMENTOS, { corpo: { data: [{ invoiceUrl: 'https://stub.test/f/antiga' }] } });
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 0);
  assert.deepEqual(stub.chamadasDe(ROTA_REMOCAO).map((c) => c.caminho), [`/subscriptions/${nova}`]);
  assert.equal(stub.chamadasDe(ROTA_PAGAMENTOS)[0].caminho, `/subscriptions/${antiga}/payments`);
  const [assinatura] = await assinaturasDe(resposta.corpo.pedidoId);
  assert.equal(assinatura.asaas_assinatura_id, antiga);
  assert.equal(assinatura.url_primeira_fatura, 'https://stub.test/f/antiga');
  const duplicada = ambiente.captura.linhas().find((l) => l.msg === 'assinatura duplicada');
  assert.equal(duplicada.pedidoId, resposta.corpo.pedidoId);
  assert.equal(duplicada.asaasAssinaturaId, nova);
});

test('CA16: se o DELETE da duplicada falhar, o pedido segue (201) e o log assinatura órfã leva o id', async () => {
  const sufixo = randomUUID().replaceAll('-', '');
  stub.definir('GET /subscriptions', {
    corpo: { data: [{ id: `sub_a${sufixo}`, dateCreated: '2026-01-01' }, { id: `sub_n${sufixo}`, dateCreated: '2026-02-01' }] }
  });
  stub.definir(ROTA_REMOCAO, { status: 500 });
  const resposta = await enviar(montarCorpo());

  assert.equal(resposta.status, 201, JSON.stringify(resposta.corpo));
  const orfa = ambiente.captura.linhas().find((l) => l.msg === 'assinatura órfã' && l.pedidoId === resposta.corpo.pedidoId);
  assert.equal(orfa.asaasAssinaturaId, `sub_n${sufixo}`);
});

// ---------------------------------------------------------------------------
// Revisão: A1, contato divergente do cadastro do documento retém a URL da fatura
// ---------------------------------------------------------------------------

async function assertFaturaRetida(corpo, resposta) {
  assert.equal(resposta.status, 201);
  assert.equal(resposta.corpo.aviso, 'fatura_pendente');
  assert.equal(resposta.corpo.estado, 'aguardando_pagamento');
  assert.ok(resposta.corpo.faturas.length >= 1);
  assert.ok(resposta.corpo.faturas.every((f) => f.url === null), 'todas as faturas com url null');
  const pedido = await pedidoPorChave(corpo.chave_idempotencia);
  assert.equal(pedido.fatura_retida, true);
  assert.equal(pedido.estado, 'aguardando_pagamento');
  const assinaturas = await assinaturasDe(pedido.id);
  assert.equal(assinaturas.length, resposta.corpo.faturas.length);
  assert.ok(assinaturas.every((a) => a.url_primeira_fatura === null), 'banco sem URL');
  return pedido;
}

test('A1: cliente do Asaas com outro nome responde 201 com aviso fatura_pendente, url null, banco sem URL e fatura_retida true', async () => {
  const corpo = corpoComDominios();
  stub.semearCliente({ id: `cus_outro_nome_${randomUUID().replaceAll('-', '')}`, documento: corpo.cliente.documento, nome: 'Outra Pessoa Cadastrada', email: 'fulana@exemplo.test' });
  const resposta = await enviar(corpo);

  const pedido = await assertFaturaRetida(corpo, resposta);
  assert.equal(resposta.corpo.faturas.length, 2);
  assert.equal(stub.chamadasDe(ROTA_PAGAMENTOS).length, 0, 'a URL nem é buscada');
  assert.equal(stub.chamadasDe('POST /subscriptions').length, 2, 'as assinaturas são criadas normalmente');
  const retida = ambiente.captura.linhas().find((l) => l.msg === 'fatura retida' && l.pedidoId === pedido.id);
  assert.ok(retida, 'log fatura retida');
  assert.equal(retida.codigo, 'contato_divergente');
});

test('A1: cliente do Asaas com outro e-mail também retém a fatura', async () => {
  const corpo = montarCorpo();
  stub.semearCliente({ id: `cus_outro_email_${randomUUID().replaceAll('-', '')}`, documento: corpo.cliente.documento, nome: 'Fulana de Teste', email: 'outra@exemplo.test' });

  await assertFaturaRetida(corpo, await enviar(corpo));
});

test('A1: cliente do Asaas sem nome e e-mail conta como divergente', async () => {
  const corpo = montarCorpo();
  stub.semearCliente({ id: `cus_sem_dados_${randomUUID().replaceAll('-', '')}`, documento: corpo.cliente.documento });

  await assertFaturaRetida(corpo, await enviar(corpo));
});

test('A1: repetição pela mesma chave devolve o mesmo aviso e as mesmas faturas, sem nova chamada', async () => {
  const corpo = montarCorpo();
  stub.semearCliente({ id: `cus_${randomUUID().replaceAll('-', '')}`, documento: corpo.cliente.documento, nome: 'Outra Pessoa Cadastrada', email: 'fulana@exemplo.test' });
  const primeira = await enviar(corpo);
  await assertFaturaRetida(corpo, primeira);
  const chamadasAntes = stub.chamadas.length;

  const segunda = await enviar(corpo);

  assert.deepEqual(segunda, primeira);
  assert.equal(stub.chamadas.length, chamadasAntes);
});

test('A1: 2º pedido do mesmo documento com contato diferente do cadastrado da tabela cliente retém a fatura', async () => {
  const documento = cpfUnico();
  const primeiro = montarCorpo({ cliente: { documento } });
  const segundo = montarCorpo({ cliente: { documento, nome: 'Beltrana de Teste', email: 'beltrana@exemplo.test' } });

  const a = await enviar(primeiro);
  assert.equal(a.status, 201);
  assert.equal(a.corpo.aviso, undefined);
  await assertFaturaRetida(segundo, await enviar(segundo));
});

test('A1: contato igual ao cadastrado devolve a URL normal, sem aviso e com fatura_retida false', async () => {
  const documento = cpfUnico();
  const primeiro = montarCorpo({ cliente: { documento } });
  const segundo = montarCorpo({ cliente: { documento } });

  const a = await enviar(primeiro);
  const b = await enviar(segundo);

  for (const [corpo, resposta] of [[primeiro, a], [segundo, b]]) {
    assert.equal(resposta.status, 201);
    assert.equal('aviso' in resposta.corpo, false);
    assert.match(resposta.corpo.faturas[0].url, /^https:\/\/stub\.test\/f\/\d+$/);
    assert.equal((await pedidoPorChave(corpo.chave_idempotencia)).fatura_retida, false);
  }
});

test('A1: nome com caixa, espaços e acentuação em outra forma Unicode, e e-mail em maiúsculas, valem como iguais (URL normal)', async () => {
  const corpo = montarCorpo({ cliente: { nome: 'José Ficticio', email: 'jose@exemplo.test' } });
  stub.semearCliente({ id: `cus_jose_${randomUUID().replaceAll('-', '')}`, documento: corpo.cliente.documento, nome: '  JOSÉ   ficticio ', email: 'JOSE@EXEMPLO.TEST' });
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal('aviso' in resposta.corpo, false);
  assert.match(resposta.corpo.faturas[0].url, /^https:\/\/stub\.test\/f\//);
  assert.equal((await pedidoPorChave(corpo.chave_idempotencia)).fatura_retida, false);
});

test('A1: o log fatura retida não leva nome nem e-mail do cadastro (conferido pelo afterEach com o marcador de dados do stub)', async () => {
  const corpo = montarCorpo();
  sensiveis.add('Cadastrada Ficticia Do Stub');
  stub.semearCliente({ id: `cus_x_${randomUUID().replaceAll('-', '')}`, documento: corpo.cliente.documento, nome: 'Cadastrada Ficticia Do Stub', email: 'cadastrada@exemplo.test' });
  sensiveis.add('cadastrada@exemplo.test');

  await assertFaturaRetida(corpo, await enviar(corpo));
});

test('A1: aviso fatura_pendente fica fora do 201 quando o pedido é retomado e o contato confere', async () => {
  const corpo = montarCorpo();
  await pedidoEmCriando(corpo, '1 hour');
  const resposta = await enviar(corpo);

  assert.equal(resposta.status, 201);
  assert.equal('aviso' in resposta.corpo, false);
});

// ---------------------------------------------------------------------------
// Revisão: caracteres de controle e invisíveis no contato
// ---------------------------------------------------------------------------

const CONTATOS_COM_CONTROLE = [
  ['nome com espaço de largura zero', { nome: 'Fulana​Teste' }],
  ['nome com quebra de linha', { nome: 'Fulana\nTeste' }],
  ['nome com inversão de direção (U+202E)', { nome: 'Fulana‮Teste' }],
  ['nome com caractere nulo', { nome: 'Fulana\u0000Teste' }],
  ['telefone com caractere de controle', { telefone: '11999\u0007990000' }],
  ['documento com caractere de controle', { documento: '529.982.247-25​' }],
];

for (const [rotulo, cliente] of CONTATOS_COM_CONTROLE) {
  test(`A1: ${rotulo} responde 400 sem chamar o Asaas nem gravar`, async () => {
    const corpo = montarCorpo();
    const enviado = { ...corpo, cliente: { ...corpo.cliente, ...cliente } };
    const resposta = await enviar(enviado);

    assert.equal(resposta.status, 400);
    assert.equal(stub.chamadas.length, 0);
    assert.equal(await contarPedidos(corpo.chave_idempotencia), 0);
  });
}

test('A1: e-mail com caractere de controle responde 400 sem chamar o Asaas', async () => {
  const corpo = montarCorpo();
  const resposta = await enviar({ ...corpo, cliente: { ...corpo.cliente, email: 'fulana​@exemplo.test' } });

  assert.equal(resposta.status, 400);
  assert.equal(stub.chamadas.length, 0);
});

test('A1: nome com acento e cedilha (categoria L, não C) segue aceito', async () => {
  const resposta = await enviar(montarCorpo({ cliente: { nome: 'Conceição Ávila de Teste' } }));

  assert.equal(resposta.status, 201);
});

// ---------------------------------------------------------------------------
// Revisão: asaas_contato_confere vale também para os pedidos seguintes do documento
// ---------------------------------------------------------------------------

async function clienteDe(documento) {
  return (await linhas('SELECT * FROM cliente WHERE documento = $1', [documento]))[0];
}

test('A1: CPF com cadastro de outro nome no Asaas e sem linha local: o 2º pedido do atacante, com outra chave e o mesmo contato, também sai retido', async () => {
  const documento = cpfUnico();
  stub.semearCliente({
    id: `cus_${randomUUID().replaceAll('-', '')}`, documento, nome: 'Titular Verdadeiro Y', email: 'titular@exemplo.test'
  });
  const contato = { documento, nome: 'Atacante de Teste X', email: 'atacante@exemplo.test' };
  const primeiro = montarCorpo({ cliente: contato });
  const segundo = montarCorpo({ cliente: contato });

  await assertFaturaRetida(primeiro, await enviar(primeiro));
  assert.equal((await clienteDe(documento)).asaas_contato_confere, false);
  const chamadasAntes = stub.chamadas.length;
  const resposta = await enviar(segundo);

  await assertFaturaRetida(segundo, resposta);
  assert.equal(stub.chamadas.slice(chamadasAntes).some((c) => c.rotulo === ROTA_PAGAMENTOS), false, 'a URL não é buscada');
});

test('A1: retomada de pedido de cliente com a flag falsa continua retida', async () => {
  const documento = cpfUnico();
  stub.semearCliente({
    id: `cus_${randomUUID().replaceAll('-', '')}`, documento, nome: 'Titular Verdadeiro Y', email: 'titular@exemplo.test'
  });
  const corpo = montarCorpo({ cliente: { documento, nome: 'Atacante de Teste X', email: 'atacante@exemplo.test' } });
  const criado = await pedidoEmCriando(corpo, '1 hour');
  assert.equal((await clienteDe(documento)).asaas_contato_confere, false);

  const retomada = await enviar(corpo);

  assert.equal(retomada.corpo.pedidoId, criado.corpo.pedidoId);
  await assertFaturaRetida(corpo, retomada);
});

test('A1: cliente criado agora no Asaas grava asaas_contato_confere true e o 2º pedido com o mesmo contato traz a URL', async () => {
  const documento = cpfUnico();
  const primeiro = montarCorpo({ cliente: { documento } });
  const segundo = montarCorpo({ cliente: { documento } });

  const a = await enviar(primeiro);
  assert.equal((await clienteDe(documento)).asaas_contato_confere, true);
  const b = await enviar(segundo);

  for (const resposta of [a, b]) {
    assert.equal(resposta.status, 201);
    assert.equal('aviso' in resposta.corpo, false);
    assert.match(resposta.corpo.faturas[0].url, /^https:\/\/stub\.test\/f\//);
  }
  assert.equal((await pedidoPorChave(segundo.chave_idempotencia)).fatura_retida, false);
});

test('A1: cadastro do Asaas que confere com a linha grava a flag true', async () => {
  const documento = cpfUnico();
  stub.semearCliente({
    id: `cus_${randomUUID().replaceAll('-', '')}`, documento, nome: 'Fulana de Teste', email: 'fulana@exemplo.test'
  });
  const resposta = await enviar(montarCorpo({ cliente: { documento } }));

  assert.equal(resposta.status, 201);
  assert.equal('aviso' in resposta.corpo, false);
  assert.equal((await clienteDe(documento)).asaas_contato_confere, true);
});
