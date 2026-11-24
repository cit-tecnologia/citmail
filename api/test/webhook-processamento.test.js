// CIT-64, processamento do webhook no worker (CA4 a CA12, CA8 d): `criarHandlerWebhook`
// contra um banco temporário migrado (papel da aplicação), o stub HTTP do Asaas e filas
// falsas que capturam os alertas, sem Redis. Dados fictícios.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { criarClienteAsaas } from '../src/asaas/cliente.js';
import { criarHandlerWebhook } from '../src/asaas/webhook-processamento.js';
import { executarDominio } from '../src/cli/dominio.js';
import { consumidoresPadrao, processarEvento } from '../src/eventos/consumidores.js';
import { criarLogger } from '../src/log.js';
import { criarCapturaDeLog } from './auxiliares.js';
import { criarStubAsaas } from './stub-asaas.js';
import {
  contasDoTitular, criarBancoWebhook, criarFilasFalsas, estadoDoPedido, eventosPublicados, leituraDoBruto,
  semearBruto, semearCliente, semearPagamentoNoStub, semearPedido
} from './webhook-fixtures.js';

let banco;
let stub;
let filas;
let handler;
let log;

before(async () => {
  banco = await criarBancoWebhook();
  stub = await criarStubAsaas();
  log = criarLogger({ level: 'silent', stream: criarCapturaDeLog().stream });
});

after(async () => {
  await stub.fechar();
  await banco.fechar();
});

beforeEach(async () => {
  stub.limpar();
  await banco.limpar();
  filas = criarFilasFalsas();
  handler = criarHandlerWebhook({
    pool: banco.app,
    asaas: criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: 'CHAVE-FICTICIA', timeoutMs: 1000 }),
    filas,
    log
  });
});

function processar(brutoId) {
  return handler({ log }, { brutoId, requestId: 'req-teste' });
}

// Bruto + pagamento no stub (RECEIVED, 49,90) para o pedido de contas semeado.
async function brutoDeContas(pedido, { bruto = {}, pagamento = {} } = {}) {
  const referencia = `pedido:${pedido.pedidoId}:contas`;
  semearPagamentoNoStub(stub, { externalReference: referencia, ...pagamento });
  return semearBruto(banco.admin, { referenciaExterna: referencia, ...bruto });
}

async function brutoDeDominios(pedido, { bruto = {}, pagamento = {} } = {}) {
  const referencia = `pedido:${pedido.pedidoId}:dominios`;
  semearPagamentoNoStub(stub, {
    id: 'pay_d1', subscription: 'sub_dom_1', status: 'CONFIRMED', value: 40, externalReference: referencia, ...pagamento
  });
  return semearBruto(banco.admin, {
    evento: 'PAYMENT_CONFIRMED', pagamentoId: 'pay_d1', assinaturaId: 'sub_dom_1', status: 'CONFIRMED',
    valorCentavos: 4000, referenciaExterna: referencia, ...bruto
  });
}

const DOMINIO_NOVO = [{ nome: 'exemplo-novo.com.br', tipo: 'novo', papel: 'principal' }];
const ASSINATURAS_COM_DOMINIOS = { contas: 'sub_contas_1', dominios: 'sub_dom_1' };

function nomes(eventos) {
  return eventos.map((e) => e.nome);
}

async function verificarSemEfeito(pedido, estadoEsperado = 'aguardando_pagamento') {
  assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, estadoEsperado);
  assert.deepEqual(await eventosPublicados(banco.admin), []);
  assert.deepEqual(await contasDoTitular(banco.admin), []);
}

function alertaEsperado(codigo, brutoId, pedidoId) {
  return { name: 'webhook', data: { tipo: 'webhook', codigo, brutoId, pedidoId }, opts: { jobId: `alerta-wh-${brutoId}` } };
}

describe('CA4: pagamento das contas', () => {
  test('CA4: marca o pedido pago, cria a conta do titular sem senha e publica os dois eventos com payload exato', async () => {
    const pedido = await semearPedido(banco.admin);
    const brutoId = await brutoDeContas(pedido);
    await processar(brutoId);

    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
    const contas = await contasDoTitular(banco.admin);
    assert.equal(contas.length, 1);
    assert.equal(contas[0].cliente_id, pedido.clienteId);
    assert.equal(contas[0].email, 'titular@exemplo.test');
    assert.equal(contas[0].estado, 'sem_senha');
    assert.equal(contas[0].senha_hash, null);

    const eventos = await eventosPublicados(banco.admin);
    assert.deepEqual(eventos, [
      {
        nome: 'conta_titular_criada',
        chave_idempotencia: `conta_titular_criada-${contas[0].id}`,
        agregado_tipo: 'conta_titular',
        agregado_id: contas[0].id,
        payload: { contaId: contas[0].id, clienteId: pedido.clienteId, pedidoId: pedido.pedidoId }
      },
      {
        nome: 'pedido_pago',
        chave_idempotencia: `pedido_pago-${pedido.pedidoId}`,
        agregado_tipo: 'pedido',
        agregado_id: pedido.pedidoId,
        payload: {
          pedidoId: pedido.pedidoId, clienteId: pedido.clienteId, assinaturaId: pedido.assinaturaContasId,
          ciclo: 'mensal', temDominioNovo: false
        }
      }
    ]);
    assert.ok(!JSON.stringify(eventos).includes('exemplo.test'), 'evento com e-mail');
    assert.deepEqual(await leituraDoBruto(banco.admin, brutoId).then((b) => [b.situacao, b.codigo]), ['processado', null]);
    assert.ok((await leituraDoBruto(banco.admin, brutoId)).processado_em instanceof Date);
    assert.deepEqual(filas.estado.alertas, []);
  });

  test('CA4: o Asaas sem externalReference no pagamento não impede o efeito', async () => {
    const pedido = await semearPedido(banco.admin);
    semearPagamentoNoStub(stub);
    const brutoId = await semearBruto(banco.admin);
    await processar(brutoId);
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
  });

  test('CA4: o e-mail da conta sai em minúsculas e sem espaços das pontas', async () => {
    const pedido = await semearPedido(banco.admin, { email: '  Maiusculo@Exemplo.TEST ' });
    await processar(await brutoDeContas(pedido));
    assert.equal((await contasDoTitular(banco.admin))[0].email, 'maiusculo@exemplo.test');
  });
});

describe('CA5: pedido com domínio novo', () => {
  test('CA5(a)(b): contas pagas antes dos domínios', async () => {
    const pedido = await semearPedido(banco.admin, { dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS });
    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_pagamento_do_dominio');
    const pedidoPago = (await eventosPublicados(banco.admin)).find((e) => e.nome === 'pedido_pago');
    assert.equal(pedidoPago.payload.temDominioNovo, true);
    assert.equal((await contasDoTitular(banco.admin)).length, 1);

    await processar(await brutoDeDominios(pedido));
    const depois = await estadoDoPedido(banco.admin, pedido.pedidoId);
    assert.equal(depois.estado, 'aguardando_registro_de_dominio');
    assert.notEqual(depois.dominio_pago_em, null);
    const dominioPago = (await eventosPublicados(banco.admin)).find((e) => e.nome === 'dominio_pago');
    assert.deepEqual(dominioPago, {
      nome: 'dominio_pago',
      chave_idempotencia: `dominio_pago-${pedido.pedidoId}`,
      agregado_tipo: 'pedido',
      agregado_id: pedido.pedidoId,
      payload: { pedidoId: pedido.pedidoId, assinaturaId: pedido.assinaturaDominiosId, temDominioNovo: true }
    });
  });

  test('CA5(c): domínios pagos primeiro não mudam o estado nem criam conta; as contas depois levam a aguardando_registro_de_dominio', async () => {
    const pedido = await semearPedido(banco.admin, { dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS });
    await processar(await brutoDeDominios(pedido));
    const meio = await estadoDoPedido(banco.admin, pedido.pedidoId);
    assert.equal(meio.estado, 'aguardando_pagamento');
    assert.notEqual(meio.dominio_pago_em, null);
    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['dominio_pago']);
    assert.deepEqual(await contasDoTitular(banco.admin), []);

    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_registro_de_dominio');
    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['conta_titular_criada', 'dominio_pago', 'pedido_pago']);
    assert.equal((await contasDoTitular(banco.admin)).length, 1);
  });

  test('CA5(d): domínio principal existente com um extra (novo) dá temDominioNovo true e aguardando_pagamento_do_dominio', async () => {
    const pedido = await semearPedido(banco.admin, {
      dominios: [
        { nome: 'existente.com.br', tipo: 'existente', papel: 'principal' },
        { nome: 'extra-novo.com.br', tipo: 'novo', papel: 'extra' }
      ],
      assinaturas: ASSINATURAS_COM_DOMINIOS
    });
    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_pagamento_do_dominio');
    assert.equal((await eventosPublicados(banco.admin)).find((e) => e.nome === 'pedido_pago').payload.temDominioNovo, true);
  });

  test('CA5(d): só domínio existente não tem domínio novo: o pedido vai direto a pago', async () => {
    const pedido = await semearPedido(banco.admin, {
      dominios: [{ nome: 'existente.com.br', tipo: 'existente', papel: 'principal' }]
    });
    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
    assert.equal((await eventosPublicados(banco.admin)).find((e) => e.nome === 'pedido_pago').payload.temDominioNovo, false);
  });
});

describe('CIT-77 CA3: registro de domínio antes do pedido_pago', () => {
  // Domínios pagos, registro manual gravado pelo dono e contas ainda por pagar.
  async function pedidoComDominioRegistrado() {
    const pedido = await semearPedido(banco.admin, { dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS });
    await processar(await brutoDeDominios(pedido));
    await banco.admin.query('UPDATE pedido_dominio SET registrado_em = now(), registro_expira_em = current_date + 365 WHERE pedido_id = $1', [pedido.pedidoId]);
    await banco.admin.query('UPDATE pedido SET dominio_registrado_em = now() WHERE id = $1', [pedido.pedidoId]);
    return pedido;
  }

  test('CIT-77 CA3: as contas pagas depois do registro levam o pedido direto a pago', async () => {
    const pedido = await pedidoComDominioRegistrado();
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_pagamento');
    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
  });

  test('CIT-77 CA3: as contas pagas depois do registro publicam pedido_pago e dominio_registrado com o payload exato', async () => {
    const pedido = await pedidoComDominioRegistrado();
    await processar(await brutoDeContas(pedido));
    const eventos = await eventosPublicados(banco.admin);
    assert.deepEqual(nomes(eventos), ['conta_titular_criada', 'dominio_pago', 'dominio_registrado', 'pedido_pago']);
    assert.deepEqual(eventos.find((e) => e.nome === 'dominio_registrado'), {
      nome: 'dominio_registrado',
      chave_idempotencia: `dominio_registrado-${pedido.pedidoId}`,
      agregado_tipo: 'pedido',
      agregado_id: pedido.pedidoId,
      payload: { pedidoId: pedido.pedidoId, clienteId: pedido.clienteId }
    });
  });

  test('CIT-77 CA3: reprocessar o mesmo bruto de contas não repete o dominio_registrado', async () => {
    const pedido = await pedidoComDominioRegistrado();
    const brutoId = await brutoDeContas(pedido);
    await processar(brutoId);
    await processar(brutoId);
    assert.equal(nomes(await eventosPublicados(banco.admin)).filter((nome) => nome === 'dominio_registrado').length, 1);
  });

  test('CIT-77 CA3: com o domínio pago e ainda sem registro as contas levam a aguardando_registro_de_dominio, sem dominio_registrado', async () => {
    const pedido = await semearPedido(banco.admin, { dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS });
    await processar(await brutoDeDominios(pedido));
    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_registro_de_dominio');
    assert.ok(!nomes(await eventosPublicados(banco.admin)).includes('dominio_registrado'));
  });

  test('CIT-77 CA3: registro gravado sem o domínio pago não leva o pedido a pago', async () => {
    const pedido = await semearPedido(banco.admin, { dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS });
    await banco.admin.query('UPDATE pedido SET dominio_registrado_em = now() WHERE id = $1', [pedido.pedidoId]);
    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_pagamento_do_dominio');
    assert.ok(!nomes(await eventosPublicados(banco.admin)).includes('dominio_registrado'));
  });

  test('CIT-77 CA3: do dominio_pago à CLI e às contas, o pedido só vai a pago no pedido_pago, com 1 dominio_registrado', async () => {
    const pedido = await semearPedido(banco.admin, { dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS });
    await processar(await brutoDeDominios(pedido));
    const { rows: [evento] } = await banco.admin.query("SELECT id FROM evento WHERE nome = 'dominio_pago'");
    await processarEvento(
      { pool: banco.app, consumidor: 'tarefa_registro_dominio', tratar: consumidoresPadrao.tarefa_registro_dominio.tratar, log },
      { eventoId: evento.id }
    );
    const { rows: [tarefa] } = await banco.admin.query('SELECT id FROM tarefa_dominio');
    const saida = { write() {} };
    const codigo = await executarDominio({
      pool: banco.app, saida, erro: saida, agora: () => new Date('2026-12-01T13:00:00Z'), usuarioSistema: 'operador_teste',
      args: ['registrado', tarefa.id, '--expira-em', '2027-12-01', '--operador', 'equipe_teste']
    });
    assert.equal(codigo, 0);
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_pagamento');
    await processar(await brutoDeContas(pedido));
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
    assert.equal(nomes(await eventosPublicados(banco.admin)).filter((nome) => nome === 'dominio_registrado').length, 1);
  });
});

describe('CA6: idempotência', () => {
  test('CA6(b): PAYMENT_CONFIRMED e PAYMENT_RECEIVED do mesmo pagamento geram uma mudança, uma conta e um de cada evento', async () => {
    const pedido = await semearPedido(banco.admin);
    const primeiro = await brutoDeContas(pedido, { bruto: { eventoId: 'evt_a', evento: 'PAYMENT_CONFIRMED' } });
    const segundo = await brutoDeContas(pedido, { bruto: { eventoId: 'evt_b' } });
    await processar(primeiro);
    await processar(segundo);

    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
    assert.equal((await contasDoTitular(banco.admin)).length, 1);
    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['conta_titular_criada', 'pedido_pago']);
    const bruto2 = await leituraDoBruto(banco.admin, segundo);
    assert.deepEqual([bruto2.situacao, bruto2.codigo], ['ignorado', 'pagamento_repetido']);
  });

  test('CA6(b): outro pagamento (pay_2) depois do 1º processado fica pagamento_seguinte, não pagamento_repetido', async () => {
    const pedido = await semearPedido(banco.admin);
    await processar(await brutoDeContas(pedido));
    const brutoId = await brutoDeContas(pedido, { bruto: { pagamentoId: 'pay_2' }, pagamento: { id: 'pay_2' } });
    await processar(brutoId);
    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'pagamento_seguinte']);
  });

  test('CA6(b): CONFIRMED e RECEIVED do mesmo pagamento dos domínios: o 2º fica pagamento_repetido', async () => {
    const pedido = await semearPedido(banco.admin, { dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS });
    await processar(await brutoDeDominios(pedido, { bruto: { eventoId: 'evt_d1' } }));
    const segundo = await brutoDeDominios(pedido, { bruto: { eventoId: 'evt_d2', evento: 'PAYMENT_RECEIVED' } });
    await processar(segundo);
    const bruto = await leituraDoBruto(banco.admin, segundo);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'pagamento_repetido']);
    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['dominio_pago']);
  });

  test('CA6(b): se o 2º evento escapar da checagem de estado, a chave do fato impede o 2º pedido_pago e a 2ª conta', async () => {
    const pedido = await semearPedido(banco.admin);
    await processar(await brutoDeContas(pedido, { bruto: { eventoId: 'evt_a' } }));
    await banco.admin.query("UPDATE pedido SET estado = 'aguardando_pagamento' WHERE id = $1", [pedido.pedidoId]);
    await processar(await brutoDeContas(pedido, { bruto: { eventoId: 'evt_b' } }));

    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['conta_titular_criada', 'pedido_pago']);
    assert.equal((await contasDoTitular(banco.admin)).length, 1);
  });

  test('CA6(c): o mesmo bruto processado duas vezes não repete o efeito nem consulta o Asaas de novo', async () => {
    const pedido = await semearPedido(banco.admin);
    const brutoId = await brutoDeContas(pedido);
    await processar(brutoId);
    const eventosAntes = await eventosPublicados(banco.admin);
    await processar(brutoId);

    assert.deepEqual(await eventosPublicados(banco.admin), eventosAntes);
    assert.equal((await contasDoTitular(banco.admin)).length, 1);
    assert.equal(stub.chamadasDe('GET /payments/{id}').length, 1);
  });

  test('CA6(c): duas execuções simultâneas do mesmo bruto geram um efeito só', async () => {
    const pedido = await semearPedido(banco.admin);
    const brutoId = await brutoDeContas(pedido);
    await Promise.all([processar(brutoId), processar(brutoId)]);

    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['conta_titular_criada', 'pedido_pago']);
    assert.equal((await contasDoTitular(banco.admin)).length, 1);
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'processado');
  });

  test('CA6(d): 2º pagamento mensal (pay_2) com o pedido pago fica ignorado, sem publicar nada', async () => {
    const pedido = await semearPedido(banco.admin, { estado: 'pago' });
    const brutoId = await brutoDeContas(pedido, { bruto: { pagamentoId: 'pay_2' }, pagamento: { id: 'pay_2' } });
    await processar(brutoId);

    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'pagamento_seguinte']);
    await verificarSemEfeito(pedido, 'pago');
  });

  test('CA6(d): 2º pagamento anual dos domínios (dominio_pago_em preenchido) fica ignorado', async () => {
    const pedido = await semearPedido(banco.admin, {
      estado: 'aguardando_registro_de_dominio', dominios: DOMINIO_NOVO, assinaturas: ASSINATURAS_COM_DOMINIOS,
      dominioPagoEm: new Date('2026-12-01T00:00:00Z')
    });
    const brutoId = await brutoDeDominios(pedido);
    await processar(brutoId);

    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'pagamento_seguinte']);
    assert.deepEqual(await eventosPublicados(banco.admin), []);
  });
});

describe('CA7: cobrança vencida', () => {
  test('CA7: PAYMENT_OVERDUE com o Asaas em OVERDUE publica cobranca_vencida e não muda pedido nem conta', async () => {
    const pedido = await semearPedido(banco.admin);
    semearPagamentoNoStub(stub, { id: 'pay_3', status: 'OVERDUE', dueDate: '2026-12-10' });
    const brutoId = await semearBruto(banco.admin, {
      evento: 'PAYMENT_OVERDUE', pagamentoId: 'pay_3', status: 'OVERDUE', vencimento: '2026-12-10'
    });
    await processar(brutoId);

    assert.deepEqual(await eventosPublicados(banco.admin), [{
      nome: 'cobranca_vencida',
      chave_idempotencia: 'cobranca_vencida-pay_3',
      agregado_tipo: 'assinatura',
      agregado_id: pedido.assinaturaContasId,
      payload: {
        clienteId: pedido.clienteId, assinaturaId: pedido.assinaturaContasId, cobrancaAsaasId: 'pay_3',
        vencimento: '2026-12-10'
      }
    }]);
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_pagamento');
    assert.deepEqual(await contasDoTitular(banco.admin), []);
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'processado');
  });
});

describe('CA9: divergência na conferência', () => {
  const CASOS = [
    ['subscription diferente', 'assinatura_divergente', () => ({ subscription: 'sub_outra' })],
    ['valor diferente do da assinatura', 'valor_divergente', () => ({ value: 1 })],
    ['externalReference de outro pedido', 'referencia_divergente', () => ({ externalReference: `pedido:${randomUUID()}:contas` })],
    ['externalReference de outro tipo', 'referencia_divergente', (pedido) => ({ externalReference: `pedido:${pedido.pedidoId}:dominios` })]
  ];
  for (const [rotulo, codigo, pagamento] of CASOS) {
    test(`CA9: ${rotulo} marca o bruto divergente (${codigo}), alerta e não tem efeito`, async () => {
      const pedido = await semearPedido(banco.admin);
      const brutoId = await brutoDeContas(pedido, { pagamento: pagamento(pedido) });
      await processar(brutoId);

      const bruto = await leituraDoBruto(banco.admin, brutoId);
      assert.deepEqual([bruto.situacao, bruto.codigo], ['divergente', codigo]);
      await verificarSemEfeito(pedido);
      assert.deepEqual(filas.estado.alertas, [alertaEsperado(codigo, brutoId, pedido.pedidoId)]);
    });
  }

  test('CA9: pagamento inexistente no Asaas (404) marca divergente pagamento_inexistente e alerta', async () => {
    const pedido = await semearPedido(banco.admin);
    const brutoId = await semearBruto(banco.admin);
    await processar(brutoId);

    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['divergente', 'pagamento_inexistente']);
    await verificarSemEfeito(pedido);
    assert.deepEqual(filas.estado.alertas, [alertaEsperado('pagamento_inexistente', brutoId, pedido.pedidoId)]);
  });

  test('CA9: o alerta que falha ao enfileirar não faz o handler lançar, e o resultado fica no bruto', async () => {
    const pedido = await semearPedido(banco.admin);
    filas.alertas.add = async () => { throw new Error('redis fora'); };
    const brutoId = await brutoDeContas(pedido, { pagamento: { subscription: 'sub_outra' } });
    await assert.doesNotReject(processar(brutoId));
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).codigo, 'assinatura_divergente');
  });
});

describe('CA10: matriz evento x status atual no Asaas', () => {
  const PAGOS = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'];
  const NAO_CONFIRMADOS = ['PENDING', 'AWAITING_RISK_ANALYSIS'];
  const ESTORNOS = ['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE',
    'AWAITING_CHARGEBACK_REVERSAL'];

  async function rodar(evento, status) {
    const pedido = await semearPedido(banco.admin);
    semearPagamentoNoStub(stub, { status });
    const brutoId = await semearBruto(banco.admin, { evento });
    await processar(brutoId);
    return { pedido, brutoId, bruto: await leituraDoBruto(banco.admin, brutoId) };
  }

  for (const evento of ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']) {
    for (const status of PAGOS) {
      test(`CA10: ${evento} com ${status} aplica o efeito de pago`, async () => {
        const { pedido, bruto } = await rodar(evento, status);
        assert.deepEqual([bruto.situacao, bruto.codigo], ['processado', null]);
        assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
        assert.deepEqual(filas.estado.alertas, []);
      });
    }
    for (const status of NAO_CONFIRMADOS) {
      test(`CA10: ${evento} com ${status} fica ignorado pagamento_nao_confirmado, com alerta e sem efeito`, async () => {
        const { pedido, brutoId, bruto } = await rodar(evento, status);
        assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'pagamento_nao_confirmado']);
        await verificarSemEfeito(pedido);
        assert.deepEqual(filas.estado.alertas, [alertaEsperado('pagamento_nao_confirmado', brutoId, pedido.pedidoId)]);
      });
    }
    test(`CA10: ${evento} com OVERDUE fica ignorado status_divergente, com alerta`, async () => {
      const { pedido, brutoId, bruto } = await rodar(evento, 'OVERDUE');
      assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'status_divergente']);
      await verificarSemEfeito(pedido);
      assert.deepEqual(filas.estado.alertas, [alertaEsperado('status_divergente', brutoId, pedido.pedidoId)]);
    });
  }

  for (const evento of ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE']) {
    for (const status of ESTORNOS) {
      test(`CA10: ${evento} com ${status} fica ignorado estornado, com alerta e sem efeito`, async () => {
        const { pedido, brutoId, bruto } = await rodar(evento, status);
        assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'estornado']);
        await verificarSemEfeito(pedido);
        assert.deepEqual(filas.estado.alertas, [alertaEsperado('estornado', brutoId, pedido.pedidoId)]);
      });
    }
    test(`CA10: ${evento} com status desconhecido fica ignorado status_desconhecido, com alerta`, async () => {
      const { pedido, brutoId, bruto } = await rodar(evento, 'STATUS_NOVO');
      assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'status_desconhecido']);
      await verificarSemEfeito(pedido);
      assert.deepEqual(filas.estado.alertas, [alertaEsperado('status_desconhecido', brutoId, pedido.pedidoId)]);
    });
  }

  for (const status of PAGOS) {
    test(`CA10: PAYMENT_OVERDUE com ${status} fica ignorado ja_pago, sem alerta e sem efeito`, async () => {
      const { pedido, bruto } = await rodar('PAYMENT_OVERDUE', status);
      assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'ja_pago']);
      await verificarSemEfeito(pedido);
      assert.deepEqual(filas.estado.alertas, []);
    });
  }
  for (const status of NAO_CONFIRMADOS) {
    test(`CA10: PAYMENT_OVERDUE com ${status} fica ignorado status_divergente, sem alerta e sem efeito`, async () => {
      const { pedido, bruto } = await rodar('PAYMENT_OVERDUE', status);
      assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'status_divergente']);
      await verificarSemEfeito(pedido);
      assert.deepEqual(filas.estado.alertas, []);
    });
  }
});

describe('CA11: fatura retida e conflito de conta', () => {
  test('CA11(a): fatura retida paga o pedido e publica pedido_pago, mas não cria conta, e alerta contato_divergente', async () => {
    const pedido = await semearPedido(banco.admin, { faturaRetida: true });
    const brutoId = await brutoDeContas(pedido);
    await processar(brutoId);

    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['pedido_pago']);
    assert.deepEqual(await contasDoTitular(banco.admin), []);
    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['processado', 'conta_nao_criada_fatura_retida']);
    assert.deepEqual(filas.estado.alertas, [alertaEsperado('contato_divergente', brutoId, pedido.pedidoId)]);
  });

  test('CA11(b): 2º pedido pago do mesmo cliente não cria 2ª conta nem 2º conta_titular_criada', async () => {
    const primeiro = await semearPedido(banco.admin);
    await processar(await brutoDeContas(primeiro));
    const segundo = await semearPedido(banco.admin, { clienteId: primeiro.clienteId, assinaturas: { contas: 'sub_contas_2' } });
    const referencia = `pedido:${segundo.pedidoId}:contas`;
    semearPagamentoNoStub(stub, { id: 'pay_9', subscription: 'sub_contas_2', externalReference: referencia });
    const brutoId = await semearBruto(banco.admin, { pagamentoId: 'pay_9', assinaturaId: 'sub_contas_2', referenciaExterna: referencia });
    await processar(brutoId);

    assert.equal((await estadoDoPedido(banco.admin, segundo.pedidoId)).estado, 'pago');
    assert.equal((await contasDoTitular(banco.admin)).length, 1);
    assert.deepEqual(nomes(await eventosPublicados(banco.admin)), ['conta_titular_criada', 'pedido_pago', 'pedido_pago']);
    assert.deepEqual(filas.estado.alertas, []);
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'processado');
  });

  test('CA11(c): e-mail do pedido em conta de outro cliente não cria conta, alerta conta_email_em_uso e o handler conclui sem lançar', async () => {
    const outro = await semearCliente(banco.admin);
    await banco.admin.query("INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'titular@exemplo.test')", [outro]);
    const pedido = await semearPedido(banco.admin);
    const brutoId = await brutoDeContas(pedido);
    await assert.doesNotReject(processar(brutoId));

    const contas = await contasDoTitular(banco.admin);
    assert.equal(contas.length, 1);
    assert.equal(contas[0].cliente_id, outro);
    assert.equal(nomes(await eventosPublicados(banco.admin)).includes('conta_titular_criada'), false);
    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['processado', 'conta_email_em_uso']);
    assert.deepEqual(filas.estado.alertas, [alertaEsperado('conta_email_em_uso', brutoId, pedido.pedidoId)]);
  });
});

describe('CA12 e CA8: eventos fora da lista, assinatura desconhecida e erros recuperáveis', () => {
  for (const [rotulo, opcoes] of [
    ['SUBSCRIPTION_CREATED sem payment', { evento: 'SUBSCRIPTION_CREATED', pagamentoId: null, assinaturaId: null }],
    ['PAYMENT_REFUNDED', { evento: 'PAYMENT_REFUNDED' }]
  ]) {
    test(`CA12(b): ${rotulo} fica ignorado evento_fora_da_lista, sem publicar nem chamar o Asaas`, async () => {
      const pedido = await semearPedido(banco.admin);
      const brutoId = await semearBruto(banco.admin, opcoes);
      await processar(brutoId);

      const bruto = await leituraDoBruto(banco.admin, brutoId);
      assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'evento_fora_da_lista']);
      await verificarSemEfeito(pedido);
      assert.equal(stub.chamadas.length, 0);
    });
  }

  test('CA12(d): assinatura desconhecida e sem referência válida fica ignorada assinatura_desconhecida, com alerta', async () => {
    const brutoId = await semearBruto(banco.admin, { assinaturaId: 'sub_sem_dono', referenciaExterna: 'texto-livre' });
    await processar(brutoId);

    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', 'assinatura_desconhecida']);
    assert.deepEqual(filas.estado.alertas, [alertaEsperado('assinatura_desconhecida', brutoId, null)]);
    assert.equal(stub.chamadas.length, 0);
  });

  test('CA12(d): referência de pedido inexistente também fica ignorada assinatura_desconhecida', async () => {
    const brutoId = await semearBruto(banco.admin, {
      assinaturaId: 'sub_sem_dono', referenciaExterna: `pedido:${randomUUID()}:contas`
    });
    await processar(brutoId);
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).codigo, 'assinatura_desconhecida');
  });

  test('CA8(d): pedido em aguardando_pagamento sem assinatura local fica divergente assinatura_divergente, com alerta', async () => {
    const pedido = await semearPedido(banco.admin, { assinaturas: {} });
    const brutoId = await semearBruto(banco.admin, { referenciaExterna: `pedido:${pedido.pedidoId}:contas` });
    await processar(brutoId);

    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.deepEqual([bruto.situacao, bruto.codigo], ['divergente', 'assinatura_divergente']);
    assert.deepEqual(filas.estado.alertas, [alertaEsperado('assinatura_divergente', brutoId, pedido.pedidoId)]);
  });

  test('CA8(d): pedido em criando sem assinatura local lança Error (não Unrecoverable) e, criada a assinatura, a nova execução aplica o efeito', async () => {
    const pedido = await semearPedido(banco.admin, { estado: 'criando', assinaturas: {} });
    const referencia = `pedido:${pedido.pedidoId}:contas`;
    semearPagamentoNoStub(stub, { externalReference: referencia });
    const brutoId = await semearBruto(banco.admin, { referenciaExterna: referencia });

    const erro = await processar(brutoId).then(() => null, (e) => e);
    assert.ok(erro instanceof Error);
    assert.ok(!(erro instanceof UnrecoverableError));
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'pendente');
    assert.equal(stub.chamadas.length, 0);
    await verificarSemEfeito(pedido, 'criando');

    await banco.admin.query(
      `INSERT INTO assinatura (pedido_id, cliente_id, tipo, ciclo, valor_centavos, asaas_assinatura_id)
       VALUES ($1, $2, 'contas', 'mensal', 4990, 'sub_contas_1')`, [pedido.pedidoId, pedido.clienteId]
    );
    await banco.admin.query("UPDATE pedido SET estado = 'aguardando_pagamento', criando_desde = NULL WHERE id = $1", [pedido.pedidoId]);
    await processar(brutoId);
    assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'processado');
  });

  test('CA8(d): pedido em criando com assinatura local também lança Error e deixa o bruto pendente', async () => {
    const pedido = await semearPedido(banco.admin, { estado: 'criando' });
    const brutoId = await brutoDeContas(pedido);
    const erro = await processar(brutoId).then(() => null, (e) => e);
    assert.ok(erro instanceof Error && !(erro instanceof UnrecoverableError));
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'pendente');
  });

  for (const [descricao, estado, assinaturas, codigo, situacao] of [
    ['falhou_na_criacao sem assinatura local', 'falhou_na_criacao', {}, 'pedido_falhou_na_criacao', 'ignorado'],
    ['falhou_na_criacao com assinatura local', 'falhou_na_criacao', { contas: 'sub_contas_1' }, 'pedido_falhou_na_criacao', 'ignorado'],
    ['cancelado com assinatura local', 'cancelado', { contas: 'sub_contas_1' }, 'pedido_cancelado', 'ignorado'],
    ['cancelado sem assinatura local', 'cancelado', {}, 'assinatura_divergente', 'divergente']
  ]) {
    test(`CA8(d): pedido ${descricao} fica ${situacao} ${codigo}, com alerta, sem chamar o Asaas e sem lançar`, async () => {
      const pedido = await semearPedido(banco.admin, { estado, assinaturas });
      const brutoId = await semearBruto(banco.admin, { referenciaExterna: `pedido:${pedido.pedidoId}:contas` });
      await processar(brutoId);

      const bruto = await leituraDoBruto(banco.admin, brutoId);
      assert.deepEqual([bruto.situacao, bruto.codigo], [situacao, codigo]);
      assert.deepEqual(filas.estado.alertas, [alertaEsperado(codigo, brutoId, pedido.pedidoId)]);
      assert.equal(stub.chamadas.length, 0);
    });
  }

  test('CA8(b): Asaas com 500 faz o handler lançar, deixa o bruto pendente e o pedido inalterado', async () => {
    const pedido = await semearPedido(banco.admin);
    stub.definir('GET /payments/{id}', { status: 500 });
    const brutoId = await brutoDeContas(pedido);
    const erro = await processar(brutoId).then(() => null, (e) => e);
    assert.ok(erro instanceof Error && !(erro instanceof UnrecoverableError));
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'pendente');
    await verificarSemEfeito(pedido);
    assert.deepEqual(filas.estado.alertas, []);
  });

  test('CA8: sem adaptador do Asaas o handler lança e o bruto fica para reenvio', async () => {
    const pedido = await semearPedido(banco.admin);
    const brutoId = await brutoDeContas(pedido);
    const semAsaas = criarHandlerWebhook({ pool: banco.app, asaas: undefined, filas, log });
    await assert.rejects(semAsaas({ log }, { brutoId }), /asaas não configurado/);
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'pendente');
  });

  test('CA8: brutoId inválido ou inexistente vira UnrecoverableError (sem nova tentativa)', async () => {
    await assert.rejects(processar('nao-e-uuid'), UnrecoverableError);
    await assert.rejects(processar(randomUUID()), UnrecoverableError);
    await assert.rejects(handler({ log }, undefined), UnrecoverableError);
  });
});

describe('CA8(d): estado do pedido relido depois da trava', () => {
  // `connect` é chamado depois da leitura sem trava e da conferência no Asaas, e antes do
  // BEGIN: o pedido muda nessa janela.
  function handlerComMudancaNaJanela(pedidoId, sql) {
    const pool = {
      query: (...args) => banco.app.query(...args),
      connect: async () => {
        await banco.admin.query(sql, [pedidoId]);
        return banco.app.connect();
      }
    };
    return criarHandlerWebhook({
      pool, asaas: criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: 'CHAVE-FICTICIA', timeoutMs: 1000 }), filas, log
    });
  }

  test('CA8(d): pedido que vira criando entre a leitura e a trava faz o handler lançar Error, sem efeito e com o bruto pendente', async () => {
    const pedido = await semearPedido(banco.admin);
    const brutoId = await brutoDeContas(pedido);
    const h = handlerComMudancaNaJanela(pedido.pedidoId, "UPDATE pedido SET estado = 'criando', criando_desde = now() WHERE id = $1");
    const erro = await h({ log }, { brutoId }).then(() => null, (e) => e);
    assert.ok(erro instanceof Error && !(erro instanceof UnrecoverableError));
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'pendente');
    await verificarSemEfeito(pedido, 'criando');
  });

  for (const [estado, sql] of [
    ['cancelado', "UPDATE pedido SET estado = 'cancelado' WHERE id = $1"],
    ['falhou_na_criacao', "UPDATE pedido SET estado = 'falhou_na_criacao', falha_motivo = 'motivo_ficticio' WHERE id = $1"]
  ]) {
    test(`CA8(d): pedido que vira ${estado} entre a leitura e a trava fica ignorado pedido_${estado}, com alerta e sem efeito`, async () => {
      const pedido = await semearPedido(banco.admin);
      const brutoId = await brutoDeContas(pedido);
      await handlerComMudancaNaJanela(pedido.pedidoId, sql)({ log }, { brutoId });

      const bruto = await leituraDoBruto(banco.admin, brutoId);
      assert.deepEqual([bruto.situacao, bruto.codigo], ['ignorado', `pedido_${estado}`]);
      await verificarSemEfeito(pedido, estado);
      assert.deepEqual(filas.estado.alertas, [alertaEsperado(`pedido_${estado}`, brutoId, pedido.pedidoId)]);
    });
  }

  test('CA8(d): o vencimento também não tem efeito com o pedido cancelado entre a leitura e a trava', async () => {
    const pedido = await semearPedido(banco.admin);
    semearPagamentoNoStub(stub, { id: 'pay_3', status: 'OVERDUE' });
    const brutoId = await semearBruto(banco.admin, { evento: 'PAYMENT_OVERDUE', pagamentoId: 'pay_3', status: 'OVERDUE' });
    await handlerComMudancaNaJanela(pedido.pedidoId, "UPDATE pedido SET estado = 'cancelado' WHERE id = $1")({ log }, { brutoId });
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).codigo, 'pedido_cancelado');
    assert.deepEqual(await eventosPublicados(banco.admin), []);
  });
});

describe('CA9: resultado já gravado por outra execução', () => {
  test('CA9: se outra execução gravar o resultado antes, o handler loga "já processado por outra execução", não sobrescreve nem alerta', async () => {
    const pedido = await semearPedido(banco.admin);
    const brutoId = await brutoDeContas(pedido, { pagamento: { subscription: 'sub_outra' } });
    const captura = criarCapturaDeLog();
    const logCapturado = criarLogger({ level: 'info', stream: captura.stream });
    const pool = {
      query: async (texto, params) => {
        if (/UPDATE asaas_webhook_evento SET situacao/.test(texto)) {
          await banco.admin.query(
            "UPDATE asaas_webhook_evento SET situacao = 'processado', processado_em = now(), codigo = 'outra_execucao' WHERE id = $1",
            [brutoId]
          );
        }
        return banco.app.query(texto, params);
      },
      connect: () => banco.app.connect()
    };
    const h = criarHandlerWebhook({
      pool, asaas: criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: 'CHAVE-FICTICIA', timeoutMs: 1000 }), filas, log: logCapturado
    });
    await h({ log: logCapturado }, { brutoId });

    assert.ok(captura.linhas().some((l) => l.msg === 'webhook já processado por outra execução' && l.brutoId === brutoId));
    assert.ok(!captura.linhas().some((l) => l.msg === 'webhook sem efeito'));
    assert.equal((await leituraDoBruto(banco.admin, brutoId)).codigo, 'outra_execucao');
    assert.deepEqual(filas.estado.alertas, []);
  });
});
