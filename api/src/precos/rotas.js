// POST /api/orcamento: rota pública, sem banco (ADR 0012). Schemas gerados de
// `tabela.js`, sem número de limite nem lista de chaves escritos à mão.
import { ADDONS, CONTAS, LIMITES } from './tabela.js'
import { calcularOrcamento, validarLimites } from './servico.js'

const CICLOS = ['mensal', 'anual']
const PLANOS_SKYBOX = Object.keys(ADDONS.skybox)

function inteiro(maximo) {
  return { type: 'integer', minimum: 0, maximum: maximo }
}

function objetoFechado(properties, required = []) {
  return { type: 'object', additionalProperties: false, required, properties }
}

const corpoOrcamento = objetoFechado({
  ciclo: { type: 'string', enum: CICLOS },
  contas: objetoFechado(Object.fromEntries(Object.keys(CONTAS).map((tipo) => [tipo, inteiro(LIMITES.contasPorTipo)]))),
  addons: objetoFechado({
    ...Object.fromEntries(LIMITES.addonsPorConta.map((chave) => [chave, inteiro(LIMITES.addonsPorContaMax)])),
    skybox: objetoFechado({
      plano: { type: 'string', enum: PLANOS_SKYBOX },
      quantidade: inteiro(LIMITES.skybox)
    }, ['plano', 'quantidade']),
    extraDom: inteiro(LIMITES.extraDom)
  })
}, ['ciclo', 'contas'])

const camposCentavos = [
  'unit_atual_centavos',
  'unit_tabela_centavos',
  'unit_cobrado_centavos',
  'tabela_centavos',
  'atual_centavos',
  'subtotal_centavos'
]

const itemOrcamento = objetoFechado({
  tipo: { type: 'string', enum: ['conta', 'addon'] },
  chave: { type: 'string' },
  plano: { type: 'string', enum: PLANOS_SKYBOX },
  quantidade: { type: 'integer' },
  ...Object.fromEntries(camposCentavos.map((campo) => [campo, { type: 'integer' }])),
  descontos: {
    type: 'array',
    items: objetoFechado({ rotulo: { type: 'string' }, valor_centavos: { type: 'integer' } }, ['rotulo', 'valor_centavos'])
  }
}, ['tipo', 'chave', 'quantidade', ...camposCentavos, 'descontos'])

const avulsoOrcamento = objetoFechado({
  tipo: { type: 'string', enum: ['dominio_extra'] },
  quantidade: { type: 'integer' },
  periodo: { type: 'string', enum: ['ano'] },
  unit_centavos: { type: 'integer' },
  subtotal_centavos: { type: 'integer' }
}, ['tipo', 'quantidade', 'periodo', 'unit_centavos', 'subtotal_centavos'])

const camposTotais = [
  'recorrente_mensal_centavos',
  'recorrente_ciclo_centavos',
  'tabela_mensal_centavos',
  'economia_mensal_centavos',
  'avulso_centavos'
]

const respostaOrcamento = objetoFechado({
  versao_tabela: { type: 'string' },
  ciclo: { type: 'string', enum: CICLOS },
  itens: { type: 'array', items: itemOrcamento },
  avulsos: { type: 'array', items: avulsoOrcamento },
  totais: objetoFechado(Object.fromEntries(camposTotais.map((campo) => [campo, { type: 'integer' }])), camposTotais)
}, ['versao_tabela', 'ciclo', 'itens', 'avulsos', 'totais'])

export default async function rotasPrecos(app) {
  app.post('/orcamento', {
    schema: { body: corpoOrcamento, response: { 200: respostaOrcamento } }
  }, async (request, reply) => {
    const campos = validarLimites(request.body)
    if (campos.length > 0) return reply.code(400).send({ erro: 'validacao', campos })
    return calcularOrcamento(request.body)
  })
}
