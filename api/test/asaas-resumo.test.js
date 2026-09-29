import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumoEventoAsaas } from '../src/asaas/resumo.js';

// Fixture no formato real do webhook do Asaas (mesma do CA3(c) no log.test.js).
const fixtureWebhook = {
  event: 'PAYMENT_CONFIRMED',
  payment: {
    id: 'pay_ficticio001',
    customer: 'cus_ficticio001',
    billingType: 'CREDIT_CARD',
    status: 'CONFIRMED',
    value: 49.9,
    description: 'MARC-DESCRICAO',
    externalReference: 'MARC-EXTREF',
    creditCard: { creditCardNumber: '0000', creditCardBrand: 'VISA', creditCardToken: 'MARC-CCTOKEN' },
  },
};

test('CA7: resumoEventoAsaas devolve exatamente event, paymentId, paymentStatus e billingType', () => {
  const resultado = resumoEventoAsaas(fixtureWebhook);

  assert.deepEqual(resultado, {
    event: 'PAYMENT_CONFIRMED',
    paymentId: 'pay_ficticio001',
    paymentStatus: 'CONFIRMED',
    billingType: 'CREDIT_CARD',
  });
  assert.deepEqual(Object.keys(resultado).sort(), ['billingType', 'event', 'paymentId', 'paymentStatus']);

  const texto = JSON.stringify(resultado);
  for (const marcador of ['MARC-DESCRICAO', 'MARC-EXTREF', 'MARC-CCTOKEN', 'cus_ficticio001', '0000']) {
    assert.ok(!texto.includes(marcador), `resumo não deveria conter "${marcador}"`);
  }
});

test('CA7: evento sem payment devolve paymentId, paymentStatus e billingType undefined, sem lançar exceção', () => {
  const resultado = resumoEventoAsaas({ event: 'PAYMENT_DELETED' });

  assert.equal(resultado.event, 'PAYMENT_DELETED');
  assert.equal(resultado.paymentId, undefined);
  assert.equal(resultado.paymentStatus, undefined);
  assert.equal(resultado.billingType, undefined);
});

test('CA7: valor não string em payment.id não é copiado (paymentId fica undefined)', () => {
  const resultado = resumoEventoAsaas({ event: 'PAYMENT_CONFIRMED', payment: { id: { x: 'MARC-OBJ' } } });

  assert.equal(resultado.paymentId, undefined);
  assert.ok(!JSON.stringify(resultado).includes('MARC-OBJ'));
});
