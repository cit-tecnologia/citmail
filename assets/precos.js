/* Fonte única de preços do CITMail (checkout e landing).
 * Só dados e funções puras, sem DOM. Todos os valores em centavos inteiros.
 * "atual" = preço de lista de hoje, antes do desconto anual ou por volume;
 * "tabela" = preço de tabela exibido riscado, derivado do atual (atual = tabela − 15%). */

const PRECOS = {
  // Versão da tabela, no formato AAAA-MM-DD.N (ADR 0012): muda com qualquer preço, desconto ou limite,
  // aqui e em api/src/precos/tabela.js, no mesmo PR (o teste de paridade da API compara os dois).
  versao: '2026-11-07.1',
  contas: { '5gb': 1000, '25gb': 1600, '50gb': 2500 },
  addons: {
    talk: 470,
    backup90: 600,
    backup365: 1900,
    grupoEmail: 200,
    skybox: { '50gb': 1770, '100gb': 2870, '1tb': 31900 },
  },
  dominio: 7900, // .com.br por ano (principal e extra)
  // Tetos de quantidade, iguais aos LIMITES da API (o servidor responde 400 fora deles).
  limites: {
    contasPorTipo: 500,
    minimoPorTipo: { '5gb': 2, '25gb': 1, '50gb': 1 },
    addonsPorConta: ['talk', 'backup90', 'backup365', 'grupoEmail'],
    addonsPorContaMax: 500,
    skybox: 50,
    extraDom: 20,
  },
};

// Desconto de contratação já embutido no atual de todos os itens (atual = tabela − 15%).
const DESCONTO_CONTRATACAO_PCT = 15;
// Descontos sobre o atual das contas: anual sem volume; volume só no mensal.
const DESCONTO_ANUAL_PCT = 20;
const DESCONTO_VOLUME_PCT = 5;
const VOLUME_MIN_QTD = 5;

// Tabela = atual / 0,85, arredondada ao centavo: atual × 100 / (100 − DESCONTO_CONTRATACAO_PCT).
// Com 15%, o divisor é 85 = 5 × 17: para centavos inteiros, atual × 100 / 85 = atual × 20 / 17
// nunca termina em ,5 (17 é ímpar e não divide 10), então o Math.round não empata.
function tabelaCentavos(atual) {
  return Math.round(atual * 100 / (100 - DESCONTO_CONTRATACAO_PCT));
}

// Percentual de volume da conta: 5% a partir de 5 contas do tipo, só no mensal.
function percentualVolume(qtd, anual) {
  return (!anual && qtd >= VOLUME_MIN_QTD) ? DESCONTO_VOLUME_PCT : 0;
}

// Percentual extra sobre o atual: só em conta; anual = 20% sem volume, mensal = volume.
function percentualConta(qtd, { conta = false, anual = false } = {}) {
  if (!conta) return 0;
  return anual ? DESCONTO_ANUAL_PCT : percentualVolume(qtd, anual);
}

// Unitário cobrado a partir do atual (base de unitarioCobradoCentavos e cascataCentavos).
// O Math.round protege preços futuros.
function cobradoUnitCentavos(atualUnit, qtd, opcoes) {
  return Math.round(atualUnit * (100 - percentualConta(qtd, opcoes)) / 100);
}

// Unitário cobrado da conta (regra do checkout): anual = atual × 0,80, sem volume;
// mensal = atual × 0,95 a partir de 5 contas.
function unitarioCobradoCentavos(tipo, qtd, anual) {
  return cobradoUnitCentavos(PRECOS.contas[tipo], qtd, { conta: true, anual });
}

// Cascata de um item (qtd × atualUnit), do preço de tabela ao cobrado, em centavos:
//   tabela  = qtd × tabelaCentavos(atualUnit);
//   atual   = qtd × atualUnit;  segmento "−15% contratação" = tabela − atual;
//   cobrado = conta ? qtd × unitário com −20% anual ou −5% volume : atual;
//   segmento extra "−20% anual" ou "−5% volume" = atual − cobrado (só em conta, só se houver).
// Add-ons: conta = false (sem anual nem volume), só o segmento de contratação.
// segmentos: [{ rotulo, valor }] na ordem de exibição; a página só renderiza.
function cascataCentavos(atualUnit, qtd, { conta = false, anual = false } = {}) {
  const pct = percentualConta(qtd, { conta, anual });
  const tabela  = qtd * tabelaCentavos(atualUnit);
  const atual   = qtd * atualUnit;
  const cobrado = qtd * cobradoUnitCentavos(atualUnit, qtd, { conta, anual });
  const segmentos = [{ rotulo: `−${DESCONTO_CONTRATACAO_PCT}% contratação`, valor: tabela - atual }];
  if (pct > 0) segmentos.push({ rotulo: anual ? `−${pct}% anual` : `−${pct}% volume`, valor: atual - cobrado });
  return { tabela, atual, cobrado, segmentos };
}

// Teto de um add-on dado o total de contas (igual ao tetoAddon da API). Sem contas, nenhum add-on.
// Por conta (talk, backups, grupo de e-mail): até o total de contas, nunca acima de addonsPorContaMax.
function tetoAddon(chave, totalContas) {
  const lim = PRECOS.limites;
  if (totalContas === 0) return 0;
  if (lim.addonsPorConta.includes(chave)) return Math.min(totalContas, lim.addonsPorContaMax);
  if (chave === 'skybox') return lim.skybox;
  if (chave === 'extraDom') return lim.extraDom;
  return 0;
}

// "1.234,56" com aritmética inteira (sem ponto flutuante nem locale).
function fmtCentavos(c) {
  const sinal = c < 0 ? '-' : '';
  const abs = Math.abs(Math.round(c));
  const reais = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sinal}${reais},${String(abs % 100).padStart(2, '0')}`;
}

// Reais com ponto e duas casas ("76.40"), para Pix e boleto.
// Recebe centavos inteiros não negativos (valores a cobrar); não trata sinal nem fração.
function reaisTxt(c) {
  return Math.trunc(c / 100) + '.' + String(c % 100).padStart(2, '0');
}
