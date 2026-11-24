// CIT-64, enfileirador e retry pela fila (CA8 a, b, c, e, f): Redis de teste, workers
// reais do BullMQ, stub HTTP do Asaas e banco temporário migrado. Dados fictícios.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as esperar } from 'node:timers/promises';
import { criarClienteAsaas } from '../src/asaas/cliente.js';
import { reprocessar } from '../src/cli/reprocessar.js';
import {
  criarHandlerWebhook, enfileirarPendentes, iniciarEnfileiradorWebhook, JOB_WEBHOOK
} from '../src/asaas/webhook-processamento.js';
import { criarFilasTeste } from './auxiliares.js';
import { criarStubAsaas } from './stub-asaas.js';
import {
  contasDoTitular, criarBancoWebhook, criarFilasFalsas, estadoDoPedido, eventosPublicados, leituraDoBruto,
  semearBruto, semearPagamentoNoStub, semearPedido
} from './webhook-fixtures.js';

let banco;
let stub;

before(async () => {
  banco = await criarBancoWebhook();
  stub = await criarStubAsaas();
});

after(async () => {
  await stub.fechar();
  await banco.fechar();
});

beforeEach(async () => {
  stub.limpar();
  await banco.limpar();
});

function adaptador() {
  return criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: 'CHAVE-FICTICIA', timeoutMs: 1000 });
}

function aguardar(emissor, evento) {
  return new Promise((resolver) => emissor.once(evento, resolver));
}

// Pedido de contas + bruto já enfileirado pelo enfileirador real; o worker consome.
async function prepararJob(aux, { tentativas = 2 } = {}) {
  const pedido = await semearPedido(banco.admin);
  const referencia = `pedido:${pedido.pedidoId}:contas`;
  semearPagamentoNoStub(stub, { externalReference: referencia });
  const brutoId = await semearBruto(banco.admin, { referenciaExterna: referencia });
  const handler = criarHandlerWebhook({ pool: banco.app, asaas: adaptador(), filas: aux.filas, log: aux.log });
  const alertasEnviados = [];
  let avisar;
  const alertado = new Promise((resolver) => { avisar = resolver; });
  const workers = aux.criarWorkers({
    handlers: { [JOB_WEBHOOK]: handler },
    enviarAlerta: async (dados) => { alertasEnviados.push(dados); avisar(dados); }
  });
  return { pedido, brutoId, workers, alertasEnviados, alertado, jobId: `${JOB_WEBHOOK}-${brutoId}`, tentativas };
}

test('CA8(a): Asaas com 500 na 1ª chamada e 200 na 2ª conclui o job na 2ª tentativa e aplica o efeito uma vez', async (t) => {
  const aux = criarFilasTeste({ tentativas: 2, backoffMs: 50 });
  t.after(aux.fechar);
  stub.definir('GET /payments/{id}', ({ n }) => (n === 1 ? { status: 500 } : undefined));
  const { pedido, brutoId, workers, jobId } = await prepararJob(aux);

  const concluido = aguardar(workers.jobs, 'completed');
  const ciclo = await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log: aux.log });
  assert.equal(ciclo.enfileirados, 1);
  await concluido;

  const job = await aux.filas.jobs.getJob(jobId);
  assert.equal(await job.getState(), 'completed');
  assert.equal(job.attemptsMade, 2);
  assert.equal(stub.chamadasDe('GET /payments/{id}').length, 2);
  assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
  assert.deepEqual((await eventosPublicados(banco.admin)).map((e) => e.nome), ['conta_titular_criada', 'pedido_pago']);
  assert.equal((await contasDoTitular(banco.admin)).length, 1);
  assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'processado');
});

test('CA8(b): Asaas sempre com 500 esgota o job, alerta job_esgotado com o jobId e deixa bruto pendente e pedido inalterado', async (t) => {
  const aux = criarFilasTeste({ tentativas: 2, backoffMs: 50 });
  t.after(aux.fechar);
  stub.definir('GET /payments/{id}', { status: 500 });
  const { pedido, brutoId, alertado, jobId } = await prepararJob(aux);

  await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log: aux.log });
  const alerta = await alertado;

  assert.equal(alerta.jobId, jobId);
  assert.equal(alerta.job, JOB_WEBHOOK);
  assert.equal(await (await aux.filas.jobs.getJob(jobId)).getState(), 'failed');
  assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'pendente');
  assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'aguardando_pagamento');
  assert.deepEqual(await eventosPublicados(banco.admin), []);
});

test('CA8(c): reprocessar do job esgotado, com o Asaas corrigido, devolve 0 e o job conclui com o efeito', async (t) => {
  const aux = criarFilasTeste({ tentativas: 2, backoffMs: 50 });
  t.after(aux.fechar);
  stub.definir('GET /payments/{id}', { status: 500 });
  const { pedido, brutoId, workers, alertado, jobId } = await prepararJob(aux);
  await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log: aux.log });
  await alertado;

  stub.definir('GET /payments/{id}', undefined);
  const concluido = aguardar(workers.jobs, 'completed');
  const saida = { texto: '', write(t) { this.texto += t; } };
  assert.equal(await reprocessar({ filas: aux.filas, jobId, saida }), 0);
  await concluido;

  assert.equal(await (await aux.filas.jobs.getJob(jobId)).getState(), 'completed');
  assert.equal((await estadoDoPedido(banco.admin, pedido.pedidoId)).estado, 'pago');
  assert.equal((await leituraDoBruto(banco.admin, brutoId)).situacao, 'processado');
  assert.deepEqual((await eventosPublicados(banco.admin)).map((e) => e.nome), ['conta_titular_criada', 'pedido_pago']);
});

test('CA8(e): addBulk que rejeita deixa enfileirado_em nulo e o ciclo seguinte, com a fila boa, cria o job e marca', async (t) => {
  const aux = criarFilasTeste();
  t.after(aux.fechar);
  const brutoId = await semearBruto(banco.admin);
  const log = aux.log;

  const quebrada = { jobs: { async addBulk() { throw new Error('redis fora'); } }, alertas: aux.filas.alertas };
  const falha = await enfileirarPendentes({ pool: banco.app, filas: quebrada, log });
  assert.equal(falha.enfileirados, 0);
  assert.equal((await leituraDoBruto(banco.admin, brutoId)).enfileirado_em, null);

  const ok = await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log });
  assert.equal(ok.enfileirados, 1);
  assert.notEqual((await leituraDoBruto(banco.admin, brutoId)).enfileirado_em, null);
  const job = await aux.filas.jobs.getJob(`${JOB_WEBHOOK}-${brutoId}`);
  assert.equal(job.name, JOB_WEBHOOK);
  assert.deepEqual(job.data, { brutoId, requestId: 'req-teste' });
});

test('CA8(e): o ciclo repetido não duplica o job nem reenfileira um bruto já marcado', async (t) => {
  const aux = criarFilasTeste();
  t.after(aux.fechar);
  const brutoId = await semearBruto(banco.admin);
  await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log: aux.log });
  const segundo = await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log: aux.log });
  assert.equal(segundo.enfileirados, 0);
  assert.equal(await aux.filas.jobs.getJobCountByTypes('waiting'), 1);
  assert.ok(await aux.filas.jobs.getJob(`${JOB_WEBHOOK}-${brutoId}`));
});

test('CA8(f): bruto pendente enfileirado há 2 h gera um alerta webhook_parado com jobId alerta-whp e o ciclo seguinte não repete', async (t) => {
  const aux = criarFilasTeste();
  t.after(aux.fechar);
  const brutoId = await semearBruto(banco.admin, { enfileiradoEm: new Date(Date.now() - 2 * 3600 * 1000) });

  const primeiro = await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log: aux.log });
  assert.equal(primeiro.parados, 1);
  const alerta = await aux.filas.alertas.getJob(`alerta-whp-${brutoId}`);
  assert.equal(alerta.name, 'webhook');
  assert.deepEqual(alerta.data, { tipo: 'webhook', codigo: 'webhook_parado', brutoId, pedidoId: null });
  assert.notEqual((await leituraDoBruto(banco.admin, brutoId)).alertado_pendente_em, null);

  const segundo = await enfileirarPendentes({ pool: banco.app, filas: aux.filas, log: aux.log });
  assert.equal(segundo.parados, 0);
  assert.equal(await aux.filas.alertas.getJobCountByTypes('waiting'), 1);
});

test('CA8(f): bruto enfileirado há 30 min, ou já processado há 2 h, não gera alerta de parado', async () => {
  const filas = criarFilasFalsas();
  await semearBruto(banco.admin, { enfileiradoEm: new Date(Date.now() - 30 * 60 * 1000) });
  const processado = await semearBruto(banco.admin, { enfileiradoEm: new Date(Date.now() - 2 * 3600 * 1000) });
  await banco.admin.query(
    "UPDATE asaas_webhook_evento SET situacao = 'processado', processado_em = now() WHERE id = $1", [processado]
  );
  const log = { warn() {}, error() {}, info() {} };
  const resultado = await enfileirarPendentes({ pool: banco.app, filas, log });
  assert.equal(resultado.parados, 0);
  assert.deepEqual(filas.estado.alertas, []);
});

test('CA8: o laço do enfileirador cria os jobs a cada ciclo e para no close()', async () => {
  const filas = criarFilasFalsas();
  const log = { warn() {}, error() {}, info() {} };
  const brutoId = await semearBruto(banco.admin);
  let avisar;
  const ciclo = new Promise((resolver) => { avisar = resolver; });
  const laco = iniciarEnfileiradorWebhook({
    pool: banco.app, filas, log, intervaloMs: 20, aoCiclo: (resultado) => { if (resultado.enfileirados > 0) avisar(resultado); }
  });
  const resultado = await ciclo;
  await laco.close();

  assert.equal(resultado.enfileirados, 1);
  assert.equal(filas.estado.jobs[0].opts.jobId, `${JOB_WEBHOOK}-${brutoId}`);
  const aposClose = filas.estado.jobs.length;
  await semearBruto(banco.admin);
  await esperar(150); // espera fixa: prova que nenhum ciclo novo nasce depois do close()
  assert.equal(filas.estado.jobs.length, aposClose);
});

test('CA8: o laço sem aoCiclo (como no worker) também enfileira o bruto pendente', async () => {
  const log = { warn() {}, error() {}, info() {} };
  const brutoId = await semearBruto(banco.admin);
  let avisar;
  const enfileirado = new Promise((resolver) => { avisar = resolver; });
  const filas = {
    jobs: { async addBulk(lista) { avisar(lista); } },
    alertas: { async addBulk() {} }
  };
  const laco = iniciarEnfileiradorWebhook({ pool: banco.app, filas, log, intervaloMs: 20 });
  const lista = await Promise.race([
    enfileirado,
    esperar(5000).then(() => { throw new Error('o laço não enfileirou o bruto em 5 s'); })
  ]).finally(() => laco.close());

  assert.equal(lista[0].opts.jobId, `${JOB_WEBHOOK}-${brutoId}`);
  assert.notEqual((await leituraDoBruto(banco.admin, brutoId)).enfileirado_em, null);
});

  test('CA8(f): bruto nunca enfileirado (Redis fora) e recebido há 2 h gera um alerta webhook_parado uma vez só', async () => {
    const filas = criarFilasFalsas();
    filas.estado.falharAddBulk = true;
    const log = { warn() {}, error() {}, info() {} };
    const brutoId = await semearBruto(banco.admin);
    await banco.admin.query("UPDATE asaas_webhook_evento SET recebido_em = now() - interval '2 hours' WHERE id = $1", [brutoId]);

    const primeiro = await enfileirarPendentes({ pool: banco.app, filas, log });
    assert.equal(primeiro.enfileirados, 0);
    assert.equal(primeiro.parados, 1);
    assert.deepEqual(filas.estado.alertas.map((a) => [a.data.codigo, a.data.brutoId, a.opts.jobId]),
      [['webhook_parado', brutoId, `alerta-whp-${brutoId}`]]);
    const bruto = await leituraDoBruto(banco.admin, brutoId);
    assert.equal(bruto.enfileirado_em, null);
    assert.notEqual(bruto.alertado_pendente_em, null);

    const segundo = await enfileirarPendentes({ pool: banco.app, filas, log });
    assert.equal(segundo.parados, 0);
    assert.equal(filas.estado.alertas.length, 1);
  });

  test('CA8(f): bruto nunca enfileirado mas recebido há 30 min ainda não gera alerta de parado', async () => {
    const filas = criarFilasFalsas();
    filas.estado.falharAddBulk = true;
    const log = { warn() {}, error() {}, info() {} };
    const brutoId = await semearBruto(banco.admin);
    await banco.admin.query("UPDATE asaas_webhook_evento SET recebido_em = now() - interval '30 minutes' WHERE id = $1", [brutoId]);
    assert.equal((await enfileirarPendentes({ pool: banco.app, filas, log })).parados, 0);
    assert.deepEqual(filas.estado.alertas, []);
  });
