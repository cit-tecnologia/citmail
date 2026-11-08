// Cálculo do orçamento (ADR 0012): funções puras sobre a tabela do servidor.
// A cascata reproduz a de `assets/precos.js`; nenhum valor monetário vem do cliente.
import {
  ADDONS,
  CONTAS,
  DESCONTO_ANUAL_PCT,
  DESCONTO_CONTRATACAO_PCT,
  DESCONTO_VOLUME_PCT,
  DOMINIO,
  LIMITES,
  VERSAO,
  VOLUME_MIN_QTD,
  tetoAddon
} from './tabela.js'

const FORA_DO_LIMITE = 'fora do limite'

// Tabela = atual / 0,85, arredondada ao centavo.
function tabelaCentavos(atual) {
  return Math.round(atual * 100 / (100 - DESCONTO_CONTRATACAO_PCT))
}

// Percentual extra sobre o atual: só em conta; anual = 20% sem volume, mensal = 5% a partir de 5.
function percentualConta(qtd, { conta = false, anual = false } = {}) {
  if (!conta) return 0
  if (anual) return DESCONTO_ANUAL_PCT
  return qtd >= VOLUME_MIN_QTD ? DESCONTO_VOLUME_PCT : 0
}

function cobradoUnitCentavos(atualUnit, qtd, opcoes) {
  return Math.round(atualUnit * (100 - percentualConta(qtd, opcoes)) / 100)
}

// Item da resposta: unitários e cascata (tabela → atual → cobrado) com os descontos.
export function cascataCentavos(atualUnit, qtd, { conta = false, anual = false } = {}) {
  const pct = percentualConta(qtd, { conta, anual })
  const unitTabela = tabelaCentavos(atualUnit)
  const unitCobrado = cobradoUnitCentavos(atualUnit, qtd, { conta, anual })
  const tabela = qtd * unitTabela
  const atual = qtd * atualUnit
  const cobrado = qtd * unitCobrado
  const descontos = [{ rotulo: `−${DESCONTO_CONTRATACAO_PCT}% contratação`, valor_centavos: tabela - atual }]
  if (pct > 0) descontos.push({ rotulo: anual ? `−${pct}% anual` : `−${pct}% volume`, valor_centavos: atual - cobrado })
  return {
    unit_atual_centavos: atualUnit,
    unit_tabela_centavos: unitTabela,
    unit_cobrado_centavos: unitCobrado,
    tabela_centavos: tabela,
    atual_centavos: atual,
    subtotal_centavos: cobrado,
    descontos
  }
}

function totalContas(contas) {
  return Object.keys(CONTAS).reduce((soma, tipo) => soma + (contas[tipo] ?? 0), 0)
}

// Regras que o schema não expressa. Ordem fixa: total de contas, mínimo por tipo,
// teto dos add-ons por conta. Com total 0, só sai `contas`.
export function validarLimites({ contas, addons = {} }) {
  const total = totalContas(contas)
  if (total === 0) return [{ campo: 'contas', mensagem: FORA_DO_LIMITE }]

  const campos = []
  for (const tipo of Object.keys(CONTAS)) {
    const qtd = contas[tipo] ?? 0
    if (qtd > 0 && qtd < LIMITES.minimoPorTipo[tipo]) campos.push({ campo: `contas.${tipo}`, mensagem: FORA_DO_LIMITE })
  }
  for (const chave of LIMITES.addonsPorConta) {
    if ((addons[chave] ?? 0) > tetoAddon(chave, total)) campos.push({ campo: `addons.${chave}`, mensagem: FORA_DO_LIMITE })
  }
  return campos
}

// Orçamento de uma entrada já validada (schema e validarLimites).
export function calcularOrcamento({ ciclo, contas, addons = {} }) {
  const anual = ciclo === 'anual'
  const itens = []

  for (const [tipo, atualUnit] of Object.entries(CONTAS)) {
    const qtd = contas[tipo] ?? 0
    if (qtd > 0) itens.push({ tipo: 'conta', chave: tipo, quantidade: qtd, ...cascataCentavos(atualUnit, qtd, { conta: true, anual }) })
  }
  for (const chave of LIMITES.addonsPorConta) {
    const qtd = addons[chave] ?? 0
    if (qtd > 0) itens.push({ tipo: 'addon', chave, quantidade: qtd, ...cascataCentavos(ADDONS[chave], qtd) })
  }
  const skybox = addons.skybox
  if (skybox && skybox.quantidade > 0) {
    itens.push({
      tipo: 'addon',
      chave: 'skybox',
      plano: skybox.plano,
      quantidade: skybox.quantidade,
      ...cascataCentavos(ADDONS.skybox[skybox.plano], skybox.quantidade)
    })
  }

  const avulsos = []
  const extraDom = addons.extraDom ?? 0
  if (extraDom > 0) {
    avulsos.push({ tipo: 'dominio_extra', quantidade: extraDom, periodo: 'ano', unit_centavos: DOMINIO, subtotal_centavos: extraDom * DOMINIO })
  }

  const recorrente = itens.reduce((soma, item) => soma + item.subtotal_centavos, 0)
  const tabela = itens.reduce((soma, item) => soma + item.tabela_centavos, 0)
  return {
    versao_tabela: VERSAO,
    ciclo,
    itens,
    avulsos,
    totais: {
      recorrente_mensal_centavos: recorrente,
      recorrente_ciclo_centavos: anual ? recorrente * 12 : recorrente,
      tabela_mensal_centavos: tabela,
      economia_mensal_centavos: tabela - recorrente,
      avulso_centavos: avulsos.reduce((soma, avulso) => soma + avulso.subtotal_centavos, 0)
    }
  }
}
