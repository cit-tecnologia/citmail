// CIT-65, CA3 (máscara): `mascararEmail` guarda só a 1ª letra e o domínio do destinatário.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mascararEmail } from '../src/email/mascara.js';

const CASOS = [
  ['ana@exemplo.com.br', 'a***@exemplo.com.br'],
  ['x@y.z', 'x***@y.z'],
  ['fulano@exemplo.test', 'f***@exemplo.test'],
  ['a@b@exemplo.test', 'a***@exemplo.test'],
  ['', '***'],
  [null, '***'],
  [undefined, '***'],
  [42, '***'],
  ['semarroba', '***'],
  ['@exemplo.test', '***'],
  ['ana@', '***']
];

for (const [entrada, esperado] of CASOS) {
  test(`CA3: mascararEmail(${JSON.stringify(entrada)}) devolve ${JSON.stringify(esperado)}`, () => {
    assert.equal(mascararEmail(entrada), esperado);
  });
}

test('CA3: a máscara não contém o restante da parte local', () => {
  assert.ok(!mascararEmail('fulano@exemplo.test').includes('ulano'));
});
