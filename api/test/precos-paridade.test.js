// Paridade entre `assets/precos.js` (front) e o módulo `precos` da API (ADR 0012, CIT-59).
// O front é um script clássico sem `export`: roda num contexto `node:vm`, e uma expressão
// final expõe os `const` de topo (que não viram propriedade do contexto). Tudo o que vem do
// `vm` passa por JSON antes de comparar, porque os protótipos de outro realm diferem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as tabela from '../src/precos/tabela.js';
import { calcularOrcamento } from '../src/precos/servico.js';

const CODIGO = readFileSync(new URL('../../assets/precos.js', import.meta.url), 'utf8');

const EXPOR = '\n;({ PRECOS, DESCONTO_CONTRATACAO_PCT, DESCONTO_ANUAL_PCT, DESCONTO_VOLUME_PCT, VOLUME_MIN_QTD, cascataCentavos, tetoAddon, tabelaCentavos, cobradoUnitCentavos })';

const normalizar = (valor) => JSON.parse(JSON.stringify(valor));

function carregar(codigo) {
  return vm.runInNewContext(codigo + EXPOR, {});
}

const CHAVES_ADDON = [...tabela.LIMITES.addonsPorConta, 'skybox', 'extraDom', 'desconhecida'];
const TOTAIS_CONTAS = [0, 3, 500, 1500];

// Casos da cascata: o item da API para a entrada e o que o front calcula para ele.
function casosCascata() {
  const casos = [];
  for (const tipo of Object.keys(tabela.CONTAS)) {
    for (const qtd of [4, 5]) {
      for (const ciclo of ['mensal', 'anual']) {
        casos.push({
          nome: `conta ${tipo} ×${qtd} ${ciclo}`,
          entrada: { ciclo, contas: { [tipo]: qtd } },
          chave: tipo,
          atual: (f) => f.PRECOS.contas[tipo],
          qtd,
          opcoes: { conta: true, anual: ciclo === 'anual' },
          front: (f) => f.cascataCentavos(f.PRECOS.contas[tipo], qtd, { conta: true, anual: ciclo === 'anual' }),
        });
      }
    }
  }
  for (const chave of tabela.LIMITES.addonsPorConta) {
    casos.push({
      nome: `add-on ${chave} ×3`,
      entrada: { ciclo: 'mensal', contas: { '25gb': 3 }, addons: { [chave]: 3 } },
      chave,
      atual: (f) => f.PRECOS.addons[chave],
      qtd: 3,
      opcoes: {},
      front: (f) => f.cascataCentavos(f.PRECOS.addons[chave], 3),
    });
  }
  for (const plano of Object.keys(tabela.ADDONS.skybox)) {
    casos.push({
      nome: `skybox ${plano} ×2`,
      entrada: { ciclo: 'mensal', contas: { '25gb': 1 }, addons: { skybox: { plano, quantidade: 2 } } },
      chave: 'skybox',
      atual: (f) => f.PRECOS.addons.skybox[plano],
      qtd: 2,
      opcoes: {},
      front: (f) => f.cascataCentavos(f.PRECOS.addons.skybox[plano], 2),
    });
  }
  return casos;
}

// Resultado do front `{ tabela, atual, cobrado, segmentos }` no formato do item da API.
function comoItem({ tabela: t, atual, cobrado, segmentos }) {
  return {
    tabela_centavos: t,
    atual_centavos: atual,
    subtotal_centavos: cobrado,
    descontos: segmentos.map((s) => ({ rotulo: s.rotulo, valor_centavos: s.valor })),
  };
}

// Lança na primeira divergência entre o front carregado e a tabela da API.
function comparar(front, api) {
  const f = front;
  assert.equal(f.PRECOS.versao, api.VERSAO, 'versão');
  assert.deepStrictEqual(normalizar(f.PRECOS.contas), api.CONTAS, 'contas');
  assert.deepStrictEqual(normalizar(f.PRECOS.addons), api.ADDONS, 'add-ons');
  assert.equal(f.PRECOS.dominio, api.DOMINIO, 'domínio');
  assert.equal(f.DESCONTO_CONTRATACAO_PCT, api.DESCONTO_CONTRATACAO_PCT, 'desconto de contratação');
  assert.equal(f.DESCONTO_ANUAL_PCT, api.DESCONTO_ANUAL_PCT, 'desconto anual');
  assert.equal(f.DESCONTO_VOLUME_PCT, api.DESCONTO_VOLUME_PCT, 'desconto de volume');
  assert.equal(f.VOLUME_MIN_QTD, api.VOLUME_MIN_QTD, 'volume mínimo');
  assert.deepStrictEqual(normalizar(f.PRECOS.limites), api.LIMITES, 'limites');

  for (const chave of CHAVES_ADDON) {
    for (const n of TOTAIS_CONTAS) {
      assert.equal(f.tetoAddon(chave, n), api.tetoAddon(chave, n), `tetoAddon(${chave}, ${n})`);
    }
  }

  for (const caso of casosCascata()) {
    const item = calcularOrcamento(caso.entrada).itens.find((i) => i.chave === caso.chave);
    const { tabela_centavos, atual_centavos, subtotal_centavos, descontos } = item;
    assert.deepStrictEqual(
      comoItem(normalizar(caso.front(f))),
      { tabela_centavos, atual_centavos, subtotal_centavos, descontos },
      caso.nome,
    );
    // Unitários: tabela e cobrado da API contra os helpers do front; qtd × cobrado fecha o subtotal.
    const atualUnit = caso.atual(f);
    assert.equal(item.unit_atual_centavos, atualUnit, `${caso.nome}: unit_atual_centavos`);
    assert.equal(item.unit_tabela_centavos, f.tabelaCentavos(atualUnit), `${caso.nome}: unit_tabela_centavos`);
    assert.equal(item.unit_cobrado_centavos, f.cobradoUnitCentavos(atualUnit, caso.qtd, caso.opcoes), `${caso.nome}: unit_cobrado_centavos`);
    assert.equal(item.quantidade * item.unit_cobrado_centavos, item.subtotal_centavos, `${caso.nome}: quantidade × unit_cobrado`);
  }

  for (const qtd of [1, 2]) {
    const { avulsos } = calcularOrcamento({ ciclo: 'mensal', contas: { '25gb': 1 }, addons: { extraDom: qtd } });
    assert.equal(qtd * f.PRECOS.dominio, avulsos[0].subtotal_centavos, `domínio extra ×${qtd}`);
  }
}

test('CA4: assets/precos.js e o módulo precos da API têm a mesma tabela, limites e cascata', () => {
  const front = carregar(CODIGO);
  assert.match(front.PRECOS.versao, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  comparar(front, tabela);
});

test('CA4: o domínio extra custa 7900 e 15800 para 1 e 2 unidades', () => {
  for (const [qtd, esperado] of [[1, 7900], [2, 15800]]) {
    const { avulsos } = calcularOrcamento({ ciclo: 'mensal', contas: { '25gb': 1 }, addons: { extraDom: qtd } });
    assert.equal(avulsos[0].subtotal_centavos, esperado);
  }
});

const MUTACOES = [
  ['versão', /versao: '[^']+'/, "versao: '1999-01-01.1'"],
  ['preço da conta 5gb', "'5gb': 1000", "'5gb': 1001"],
  ['preço do Skybox 100gb', "'100gb': 2870", "'100gb': 2871"],
  ['preço do domínio', 'dominio: 7900', 'dominio: 7901'],
  ['desconto anual', 'DESCONTO_ANUAL_PCT = 20', 'DESCONTO_ANUAL_PCT = 21'],
  ['teto do domínio extra', 'extraDom: 20', 'extraDom: 21'],
  ['teto de contas por tipo', 'contasPorTipo: 500', 'contasPorTipo: 501'],
  ['teto de add-on por conta (min vira max)', 'Math.min(totalContas', 'Math.max(totalContas'],
  [
    'arredondamento da tabela',
    'return Math.round(atual * 100 / (100 - DESCONTO_CONTRATACAO_PCT));',
    'return Math.floor(atual * 100 / (100 - DESCONTO_CONTRATACAO_PCT));',
  ],
];

for (const [nome, de, para] of MUTACOES) {
  test(`CA4: mutação do texto-fonte (${nome}) quebra a paridade`, () => {
    const mutado = CODIGO.replace(de, para);
    assert.notEqual(mutado, CODIGO, 'a substituição precisa casar com o texto de precos.js');
    assert.throws(() => comparar(carregar(mutado), tabela), assert.AssertionError);
  });
}
