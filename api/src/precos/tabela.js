// Tabela de preços do servidor (ADR 0012): a única que vale para cobrança.
// Espelha `assets/precos.js` (valores, percentuais, limites e tetoAddon); o teste
// de paridade compara os dois. Mudou preço, desconto ou limite: muda aqui, lá e a
// versão, no mesmo PR. Todos os valores em centavos inteiros.

// Formato AAAA-MM-DD.N (ADR 0012, item 5).
export const VERSAO = '2026-11-07.1'

export const CONTAS = { '5gb': 1000, '25gb': 1600, '50gb': 2500 }

export const ADDONS = {
  talk: 470,
  backup90: 600,
  backup365: 1900,
  grupoEmail: 200,
  skybox: { '50gb': 1770, '100gb': 2870, '1tb': 31900 }
}

// .com.br por ano (principal e extra).
export const DOMINIO = 7900

// Desconto de contratação já embutido no atual de todos os itens (atual = tabela − 15%).
export const DESCONTO_CONTRATACAO_PCT = 15
// Descontos sobre o atual das contas: anual sem volume; volume só no mensal.
export const DESCONTO_ANUAL_PCT = 20
export const DESCONTO_VOLUME_PCT = 5
export const VOLUME_MIN_QTD = 5

// Mesma forma de `PRECOS.limites`. O schema da rota é gerado daqui.
export const LIMITES = {
  contasPorTipo: 500,
  minimoPorTipo: { '5gb': 2, '25gb': 1, '50gb': 1 },
  addonsPorConta: ['talk', 'backup90', 'backup365', 'grupoEmail'],
  addonsPorContaMax: 500,
  skybox: 50,
  extraDom: 20
}

// Teto de um add-on dado o total de contas. Sem contas, nenhum add-on (D6).
export function tetoAddon(chave, totalContas) {
  if (totalContas === 0) return 0
  if (LIMITES.addonsPorConta.includes(chave)) return Math.min(totalContas, LIMITES.addonsPorContaMax)
  if (chave === 'skybox') return LIMITES.skybox
  if (chave === 'extraDom') return LIMITES.extraDom
  return 0
}
