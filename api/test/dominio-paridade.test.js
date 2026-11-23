// CIT-61, CA11: paridade das regras de domínio entre `assets/checkout.js` (front) e
// `src/pedidos/dominio.js` (API). O front é um script clássico sem `export`: o teste
// extrai as 4 funções pelo texto (de `function <nome>(` até a `}` na coluna 0) e as roda
// em `node:vm`, como em `precos-paridade.test.js`. Função não encontrada → falha clara.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as api from '../src/pedidos/dominio.js';

const CODIGO = readFileSync(new URL('../../assets/checkout.js', import.meta.url), 'utf8');
const FUNCOES = ['normalizarDominioNovo', 'normalizarDominioExistente', 'dominioNovoValido', 'dominioExistenteValido'];

function extrair(codigo, nome) {
  const inicio = codigo.indexOf(`function ${nome}(`);
  assert.notEqual(inicio, -1, `função ${nome} não encontrada em assets/checkout.js: a extração por texto quebrou`);
  const fim = codigo.indexOf('\n}', inicio);
  assert.notEqual(fim, -1, `fim da função ${nome} (} na coluna 0) não encontrado em assets/checkout.js`);
  return codigo.slice(inicio, fim + 2);
}

function carregar(codigo) {
  const fonte = FUNCOES.map((nome) => extrair(codigo, nome)).join('\n');
  return vm.runInNewContext(`${fonte}\n;({ ${FUNCOES.join(', ')} })`, {});
}

const NOMES = [
  'exemplo-ficticio', 'www.Exemplo-Ficticio.com.br.', 'EXEMPLO.COM.BR', '  exemplo  ', 'exemplo.', 'www.exemplo',
  'ab', 'a', '', '123', '12a', 'a12', 'ab--cd', 'a--b', 'abc--d', '-ab', 'ab-', 'a-b', 'abc-def',
  'a'.repeat(26), 'a'.repeat(27), 'x.com', 'x.com.br', 'exemplo.com', 'exemplo-ficticio.com', 'sem_ponto',
  'semponto', 'sub.exemplo.org', 'ex_emplo.com', `${'a'.repeat(63)}.com`, `${'a'.repeat(64)}.com`, 'exemplo.c',
  `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`,
  `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`,
  'exemplo.comunicacao', 'a.b', 'ação.com.br', 'EXEMPLO.Com.Br.', 'www.www.exemplo.com', 'exemplo..com', '.com'
];

// Lança na primeira divergência entre o front carregado e a API.
function comparar(front) {
  for (const nome of NOMES) {
    assert.equal(front.normalizarDominioNovo(nome), api.normalizarDominioNovo(nome), `normalizarDominioNovo(${JSON.stringify(nome)})`);
    assert.equal(front.normalizarDominioExistente(nome), api.normalizarDominioExistente(nome), `normalizarDominioExistente(${JSON.stringify(nome)})`);
    for (const candidato of [nome, api.normalizarDominioNovo(nome), api.normalizarDominioExistente(nome)]) {
      assert.equal(front.dominioNovoValido(candidato), api.dominioNovoValido(candidato), `dominioNovoValido(${JSON.stringify(candidato)})`);
      assert.equal(front.dominioExistenteValido(candidato), api.dominioExistenteValido(candidato), `dominioExistenteValido(${JSON.stringify(candidato)})`);
    }
  }
}

test('CA11: as 4 funções de domínio do checkout e da API decidem igual para ~40 nomes', () => {
  comparar(carregar(CODIGO));
});

test('CA11: a extração acha as 4 funções no checkout', () => {
  const front = carregar(CODIGO);
  for (const nome of FUNCOES) assert.equal(typeof front[nome], 'function', nome);
});

test('CA11: a extração falha com mensagem clara se uma função some do checkout', () => {
  const semFuncao = CODIGO.replace('function dominioNovoValido(', 'function outraCoisa(');
  assert.throws(() => carregar(semFuncao), /dominioNovoValido não encontrada/);
});

const MUTACOES = [
  ['rótulo novo (limite 26 → 27)', '{0,24}[a-z0-9]$', '{0,25}[a-z0-9]$'],
  ['só números aceito', ' && !/^[0-9]+$/.test(n)', ''],
  ['hífen nas posições 3-4 aceito', " && n.slice(2, 4) !== '--'", ''],
  ['tamanho máximo do existente', '(?=.{4,253}$)', '(?=.{4,254}$)'],
  ['TLD do existente', '[a-z]{2,63}$', '[a-z]{1,63}$'],
  ['www. no normalizador do existente', "replace(/^www\\./, '').replace(/\\.$/, '');\n}\n// .com.br", "replace(/\\.$/, '');\n}\n// .com.br"],
  ['.com.br no normalizador do novo', ".replace(/\\.com\\.br$/, '')", '']
];
for (const [nome, de, para] of MUTACOES) {
  test(`CA11: mutação do texto-fonte do checkout (${nome}) quebra a paridade`, () => {
    const mutado = CODIGO.replace(de, para);
    assert.notEqual(mutado, CODIGO, 'a substituição precisa casar com o texto de checkout.js');
    assert.throws(() => comparar(carregar(mutado)), assert.AssertionError);
  });
}
