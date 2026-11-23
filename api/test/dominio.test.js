// CIT-61, CA11: regras de domínio do pedido (as mesmas de assets/checkout.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nomeDominioExistente, nomeDominioNovo } from '../src/pedidos/dominio.js';

const NOVOS = [
  ['exemplo-ficticio', 'exemplo-ficticio.com.br'],
  ['www.Exemplo-Ficticio.com.br.', 'exemplo-ficticio.com.br'],
  ['  EXEMPLO.com.br ', 'exemplo.com.br'],
  ['ab', 'ab.com.br'],
  ['a1', 'a1.com.br'],
  ['abc-def', 'abc-def.com.br'],
  ['a'.repeat(26), `${'a'.repeat(26)}.com.br`]
];
for (const [entrada, esperado] of NOVOS) {
  test(`CA11: domínio novo ${JSON.stringify(entrada)} é aceito como ${esperado}`, () => {
    assert.equal(nomeDominioNovo(entrada), esperado);
  });
}

const NOVOS_INVALIDOS = [
  ['só números', '123'],
  ['1 caractere', 'a'],
  ['hífen duplo nas posições 3-4', 'ab--cd'],
  ['hífen no início', '-ab'],
  ['hífen no fim', 'ab-'],
  ['27 caracteres', 'a'.repeat(27)],
  ['com ponto no meio', 'x.com'],
  ['com espaço', 'ab cd'],
  ['com sublinhado', 'ab_cd'],
  ['com acento', 'ação'],
  ['vazio', '']
];
for (const [rotulo, entrada] of NOVOS_INVALIDOS) {
  test(`CA11: domínio novo ${rotulo} (${JSON.stringify(entrada)}) é recusado`, () => {
    assert.equal(nomeDominioNovo(entrada), null);
  });
}

const EXISTENTES = [
  ['exemplo-ficticio.com', 'exemplo-ficticio.com'],
  ['www.Exemplo.com.br.', 'exemplo.com.br'],
  ['sub.exemplo.org', 'sub.exemplo.org']
];
for (const [entrada, esperado] of EXISTENTES) {
  test(`CA11: domínio existente ${JSON.stringify(entrada)} é aceito como ${esperado}`, () => {
    assert.equal(nomeDominioExistente(entrada), esperado);
  });
}

const EXISTENTES_INVALIDOS = [
  ['sem ponto', 'sem_ponto'],
  ['sem ponto e sem sublinhado', 'semponto'],
  ['TLD de 1 letra', 'exemplo.c'],
  ['com sublinhado', 'ex_emplo.com'],
  ['hífen no início do rótulo', '-exemplo.com'],
  ['rótulo de 64 caracteres', `${'a'.repeat(64)}.com`],
  ['vazio', '']
];
for (const [rotulo, entrada] of EXISTENTES_INVALIDOS) {
  test(`CA11: domínio existente ${rotulo} (${JSON.stringify(entrada)}) é recusado`, () => {
    assert.equal(nomeDominioExistente(entrada), null);
  });
}
