// CIT-61, CA16 e CA17: adaptador `criarClienteAsaas` contra o stub HTTP local
// (`stub-asaas.js`), sem rede externa.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { centavosParaReais, criarClienteAsaas, ErroAsaas } from '../src/asaas/cliente.js';
import { criarStubAsaas, MARCADOR_CORPO } from './stub-asaas.js';

const CHAVE = 'CHAVE-FICTICIA-ASAAS';
let stub;

before(async () => {
  stub = await criarStubAsaas();
});
after(() => stub.fechar());
beforeEach(() => stub.limpar());

function adaptador(opcoes = {}) {
  return criarClienteAsaas({ baseUrl: stub.baseUrl, apiKey: CHAVE, timeoutMs: 1000, ...opcoes });
}

async function erroDe(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  assert.fail('a chamada deveria rejeitar');
}

test('CA16: toda chamada leva access_token, User-Agent e Content-Type', async () => {
  await adaptador().buscarClientePorDocumento('52998224725');
  const [chamada] = stub.chamadas;
  assert.equal(chamada.cabecalhos.access_token, CHAVE);
  assert.equal(chamada.cabecalhos['user-agent'], 'citmail-api');
  assert.equal(chamada.cabecalhos['content-type'], 'application/json');
});

test('CA16: buscarClientePorDocumento consulta pelo cpfCnpj e devolve o id', async () => {
  stub.semearCliente({ id: 'cus_existente', documento: '52998224725' });
  assert.equal(await adaptador().buscarClientePorDocumento('52998224725'), 'cus_existente');
  assert.deepEqual(stub.chamadas[0].query, { cpfCnpj: '52998224725' });
});

test('CA16: buscarClientePorDocumento devolve null quando o Asaas não tem o cliente', async () => {
  assert.equal(await adaptador().buscarClientePorDocumento('52998224725'), null);
});

test('CA16: buscarClientePorDocumento ignora cliente removido (deleted: true) e usa o próximo', async () => {
  stub.semearCliente({ id: 'cus_removido', documento: '52998224725', deleted: true });
  assert.equal(await adaptador().buscarClientePorDocumento('52998224725'), null);
  stub.semearCliente({ id: 'cus_vivo', documento: '52998224725' });
  assert.equal(await adaptador().buscarClientePorDocumento('52998224725'), 'cus_vivo');
});

test('CA16: buscarAssinaturaPorReferencia ignora assinatura removida (deleted: true)', async () => {
  stub.semearAssinatura({ id: 'sub_removida', externalReference: 'pedido:p1:contas', deleted: true });
  assert.equal(await adaptador().buscarAssinaturaPorReferencia('pedido:p1:contas'), null);
  stub.semearAssinatura({ id: 'sub_viva', externalReference: 'pedido:p1:contas' });
  assert.equal(await adaptador().buscarAssinaturaPorReferencia('pedido:p1:contas'), 'sub_viva');
  assert.deepEqual(stub.chamadas[1].query, { externalReference: 'pedido:p1:contas' });
});

test('CA16: criarCliente com telefone de 11 dígitos envia mobilePhone e notificationDisabled', async () => {
  const id = await adaptador().criarCliente({
    nome: 'Fulana de Teste',
    email: 'fulana@exemplo.test',
    telefone: '11999990000',
    documento: '52998224725',
    referencia: 'cliente:c1'
  });
  assert.match(id, /^cus_stub_/);
  assert.deepEqual(stub.chamadas[0].corpo, {
    name: 'Fulana de Teste',
    cpfCnpj: '52998224725',
    email: 'fulana@exemplo.test',
    mobilePhone: '11999990000',
    externalReference: 'cliente:c1',
    notificationDisabled: true
  });
});

test('CA16: criarCliente com telefone de 10 dígitos envia phone, não mobilePhone', async () => {
  await adaptador().criarCliente({
    nome: 'Fulana de Teste',
    email: 'fulana@exemplo.test',
    telefone: '1133330000',
    documento: '52998224725',
    referencia: 'cliente:c1'
  });
  const { corpo } = stub.chamadas[0];
  assert.equal(corpo.phone, '1133330000');
  assert.equal('mobilePhone' in corpo, false);
});

test('CA16: criarAssinatura envia UNDEFINED, value em reais, description igual ao externalReference', async () => {
  await adaptador().criarAssinatura({
    cliente: 'cus_1',
    valorCentavos: 7250,
    vencimento: '2026-12-03',
    ciclo: 'MONTHLY',
    referencia: 'pedido:p1:contas'
  });
  assert.deepEqual(stub.chamadas[0].corpo, {
    customer: 'cus_1',
    billingType: 'UNDEFINED',
    value: 72.5,
    nextDueDate: '2026-12-03',
    cycle: 'MONTHLY',
    description: 'pedido:p1:contas',
    externalReference: 'pedido:p1:contas'
  });
});

test('CA16: urlPrimeiraFatura devolve a invoiceUrl https da 1ª cobrança', async () => {
  stub.semearAssinatura({ id: 'sub_1', externalReference: 'pedido:p1:contas' });
  const url = await adaptador().urlPrimeiraFatura('sub_1');
  assert.match(url, /^https:\/\/stub\.test\/f\/\d+$/);
});

test('CA16: urlPrimeiraFatura devolve null com lista vazia', async () => {
  stub.definir('GET /subscriptions/{id}/payments', { corpo: { data: [] } });
  assert.equal(await adaptador().urlPrimeiraFatura('sub_1'), null);
});

test('CA16: urlPrimeiraFatura devolve null quando a invoiceUrl é http://', async () => {
  stub.definir('GET /subscriptions/{id}/payments', { corpo: { data: [{ invoiceUrl: 'http://stub.test/f/1' }] } });
  assert.equal(await adaptador().urlPrimeiraFatura('sub_1'), null);
});

test('CA16: removerAssinatura chama DELETE /subscriptions/{id}', async () => {
  stub.semearAssinatura({ id: 'sub_1', externalReference: 'pedido:p1:contas' });
  await adaptador().removerAssinatura('sub_1');
  assert.deepEqual(stub.rotulos(), ['DELETE /subscriptions/{id}']);
  assert.equal(stub.chamadas[0].caminho, '/subscriptions/sub_1');
  assert.deepEqual(stub.assinaturasVivas(), []);
});

test('CA16: resposta 302 vira ErroAsaas de tipo rede (redirect: error)', async () => {
  stub.definir('GET /customers', { redirecionarPara: 'http://127.0.0.1:9/outro' });
  const erro = await erroDe(adaptador().buscarClientePorDocumento('52998224725'));
  assert.ok(erro instanceof ErroAsaas);
  assert.equal(erro.tipo, 'rede');
  assert.equal(stub.chamadas.length, 1);
});

test('CA16: servidor sem resposta vira ErroAsaas de tipo timeout no prazo da chamada', async () => {
  stub.definir('GET /customers', { semResposta: true });
  const inicio = Date.now();
  const erro = await erroDe(adaptador({ timeoutMs: 300 }).buscarClientePorDocumento('52998224725'));
  assert.equal(erro.tipo, 'timeout');
  assert.ok(Date.now() - inicio < 2000);
});

test('CA16: o signal do chamador aborta a chamada como timeout, mesmo com timeout próprio longo', async () => {
  stub.definir('GET /customers', { semResposta: true });
  const erro = await erroDe(
    adaptador({ timeoutMs: 20000 }).buscarClientePorDocumento('52998224725', { signal: AbortSignal.timeout(200) })
  );
  assert.equal(erro.tipo, 'timeout');
});

test('CA16: conexão recusada vira ErroAsaas de tipo rede', async () => {
  const erro = await erroDe(adaptador({ baseUrl: 'http://127.0.0.1:1' }).buscarClientePorDocumento('52998224725'));
  assert.equal(erro.tipo, 'rede');
});

for (const [status, tipo] of [[400, 'http_4xx'], [401, 'http_4xx'], [500, 'http_5xx'], [503, 'http_5xx']]) {
  test(`CA16: resposta ${status} vira ErroAsaas ${tipo} com o status, sem o corpo na mensagem`, async () => {
    stub.definir('POST /customers', { status });
    const erro = await erroDe(adaptador().criarCliente({
      nome: 'Fulana de Teste', email: 'fulana@exemplo.test', telefone: '11999990000', documento: '52998224725', referencia: 'cliente:c1'
    }));
    assert.equal(erro.tipo, tipo);
    assert.equal(erro.status, status);
    assert.ok(!erro.message.includes(MARCADOR_CORPO));
    assert.ok(!JSON.stringify(erro).includes(MARCADOR_CORPO));
    assert.ok(!String(erro.stack).includes(MARCADOR_CORPO));
  });
}

for (const idInvalido of ['id com espaço', 'a/b', '', 'x'.repeat(65), 42, null]) {
  test(`CA16: id ${JSON.stringify(idInvalido)} na resposta vira ErroAsaas resposta_invalida`, async () => {
    stub.definir('POST /subscriptions', { corpo: { id: idInvalido } });
    const erro = await erroDe(adaptador().criarAssinatura({
      cliente: 'cus_1', valorCentavos: 100, vencimento: '2026-12-03', ciclo: 'MONTHLY', referencia: 'pedido:p1:contas'
    }));
    assert.equal(erro.tipo, 'resposta_invalida');
  });
}

test('CA16: lista sem o campo data vira ErroAsaas resposta_invalida', async () => {
  stub.definir('GET /customers', { corpo: { semData: true } });
  const erro = await erroDe(adaptador().buscarClientePorDocumento('52998224725'));
  assert.equal(erro.tipo, 'resposta_invalida');
});

test('CA16: corpo que não é JSON vira ErroAsaas resposta_invalida', async () => {
  const servidor = await criarServidorTexto('isto não é json');
  try {
    const erro = await erroDe(adaptador({ baseUrl: servidor.baseUrl }).buscarClientePorDocumento('52998224725'));
    assert.equal(erro.tipo, 'resposta_invalida');
  } finally {
    await servidor.fechar();
  }
});

test('CA16: removerAssinatura recusa id fora do padrão sem chamar o Asaas', async () => {
  const erro = await erroDe(adaptador().removerAssinatura('../customers'));
  assert.equal(erro.tipo, 'resposta_invalida');
  assert.equal(stub.chamadas.length, 0);
});

test('CA17: Math.round(centavosParaReais(c) * 100) === c para 0 a 10000', () => {
  for (let c = 0; c <= 10000; c++) {
    assert.equal(Math.round(centavosParaReais(c) * 100), c, `c = ${c}`);
  }
});

test('CA17: centavosParaReais é exato em reais decimais numa amostra até 2.000.000', () => {
  for (let c = 0; c <= 2000000; c += 997) {
    assert.equal(Math.round(centavosParaReais(c) * 100), c, `c = ${c}`);
    assert.equal(Number(centavosParaReais(c).toFixed(2)), centavosParaReais(c), `c = ${c}`);
  }
});

test('CA17: centavosParaReais(7250) é 72.5 e (15800) é 158', () => {
  assert.equal(centavosParaReais(7250), 72.5);
  assert.equal(centavosParaReais(15800), 158);
});

// Servidor mínimo que responde 200 com um texto fixo (corpo inválido).
async function criarServidorTexto(texto) {
  const { createServer } = await import('node:http');
  const servidor = createServer((_request, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(texto);
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${servidor.address().port}`,
    async fechar() {
      servidor.closeAllConnections();
      await new Promise((resolve) => servidor.close(resolve));
    }
  };
}
