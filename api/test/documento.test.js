// CIT-61, CA11: CPF e CNPJ (numérico e alfanumérico) do pedido, normalização antes de validar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarDocumento, tipoPessoa } from '../src/pedidos/documento.js';

const CPFS_VALIDOS = ['52998224725', '11144477735', '12345678909', '39053344705'];
const CNPJS_VALIDOS = [
  ['numérico', '11222333000181'],
  ['numérico com zeros à esquerda', '00000000000191'],
  ['alfanumérico (exemplo da Receita)', '12ABC34501DE35']
];

for (const cpf of CPFS_VALIDOS) {
  test(`CA11: CPF ${cpf} é válido e a pessoa é fisica`, () => {
    assert.equal(tipoPessoa(cpf), 'fisica');
  });
}

for (const [rotulo, cnpj] of CNPJS_VALIDOS) {
  test(`CA11: CNPJ ${rotulo} ${cnpj} é válido e a pessoa é juridica`, () => {
    assert.equal(tipoPessoa(cnpj), 'juridica');
  });
}

const INVALIDOS = [
  ['CPF com dígito verificador errado (1º)', '52998224735'],
  ['CPF com dígito verificador errado (2º)', '52998224724'],
  ['CPF com todos os dígitos iguais', '11111111111'],
  ['CPF zerado', '00000000000'],
  ['CPF com 10 dígitos', '5299822472'],
  ['CPF com 12 dígitos', '529982247250'],
  ['CNPJ numérico com dígito verificador errado', '11222333000182'],
  ['CNPJ alfanumérico com dígito verificador errado', '12ABC34501DE36'],
  ['CNPJ com todos os caracteres iguais', '11111111111111'],
  ['CNPJ com letra nos dígitos verificadores', '12ABC34501DEAB'],
  ['CNPJ com minúsculas (sem normalizar)', '12abc34501de35'],
  ['texto', 'abcdefghijk'],
  ['vazio', '']
];

for (const [rotulo, documento] of INVALIDOS) {
  test(`CA11: ${rotulo} (${JSON.stringify(documento)}) é recusado`, () => {
    assert.equal(tipoPessoa(documento), null);
  });
}

test('CA11: normalizarDocumento tira ponto, hífen, barra e espaços', () => {
  assert.equal(normalizarDocumento('529.982.247-25'), '52998224725');
  assert.equal(normalizarDocumento(' 11.222.333/0001-81 '), '11222333000181');
});

test('CA11: normalizarDocumento põe o CNPJ alfanumérico em maiúsculas', () => {
  assert.equal(normalizarDocumento('12.abc.345/01de-35'), '12ABC34501DE35');
});

test('CA11: o documento com máscara, normalizado, tem a mesma validade do sem máscara', () => {
  assert.equal(tipoPessoa(normalizarDocumento('529.982.247-25')), 'fisica');
  assert.equal(tipoPessoa(normalizarDocumento('12.abc.345/01de-35')), 'juridica');
  assert.equal(tipoPessoa(normalizarDocumento('529.982.247-24')), null);
});
