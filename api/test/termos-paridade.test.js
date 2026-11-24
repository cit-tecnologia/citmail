// CIT-62 (CA8 do plano): `VERSAO_TERMOS` e `TERMOS_MINUTA` (api/src/pedidos/aceite.js) em
// paridade com `termos.html`. Padrão de `precos-paridade.test.js`: lê o arquivo do front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TERMOS_MINUTA, VERSAO_TERMOS } from '../src/pedidos/aceite.js';

const html = readFileSync(new URL('../../termos.html', import.meta.url), 'utf8');

function textoDoParagrafo(id) {
  const encontrado = new RegExp(`<p[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</p>`).exec(html);
  assert.ok(encontrado, `termos.html precisa ter o parágrafo #${id}`);
  return encontrado[1].replace(/<[^>]+>/g, '').trim();
}

for (const id of ['termosVersao', 'termosVersaoFim']) {
  test(`CA8: #${id} de termos.html exibe a versão vigente do servidor`, () => {
    const escapada = VERSAO_TERMOS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(textoDoParagrafo(id), new RegExp(`^Versão ${escapada}(\\s|$)`));
  });
}

test('CA8: TERMOS_MINUTA é verdadeira exatamente quando termos.html traz "(minuta)"', () => {
  assert.equal(TERMOS_MINUTA, /\(minuta\)/.test(html));
});
