// POST /api/pedidos (ADR 0014; CIT-61): cria o cliente e as assinaturas no Asaas.
// Registrada só com `PEDIDOS_HABILITADO` (app.js). O corpo é o do orçamento com
// `dominio.nome`, mais `dominios_extras`, `cliente`, `chave_idempotencia`,
// `versao_tabela` e `total_exibido_centavos`; todo objeto é fechado (campo de cartão → 400).
import { criarCorpoOrcamento } from '../precos/rotas.js'
import { LIMITES } from '../precos/tabela.js'
import { criarServicoPedidos } from './servico.js'

function objetoFechado(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties }
}

const texto = (minLength, maxLength) => ({ type: 'string', minLength, maxLength })
// Texto livre do contato sem caracteres de controle nem invisíveis (`\p{C}`): vai ao
// Asaas e ao banco. O Ajv compila `pattern` com a flag `u`.
const textoContato = (minLength, maxLength) => ({ ...texto(minLength, maxLength), pattern: '^\\P{C}*$' })

const baseOrcamento = criarCorpoOrcamento({ pedido: true })

export const corpoPedido = {
  ...baseOrcamento,
  required: [...baseOrcamento.required, 'chave_idempotencia', 'versao_tabela', 'total_exibido_centavos', 'cliente'],
  properties: {
    ...baseOrcamento.properties,
    chave_idempotencia: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    },
    versao_tabela: texto(1, 32),
    total_exibido_centavos: { type: 'integer', minimum: 0, maximum: 1000000000 },
    dominios_extras: { type: 'array', maxItems: LIMITES.extraDom, items: texto(1, 253) },
    cliente: objetoFechado({
      nome: textoContato(2, 100),
      email: { type: 'string', format: 'email', maxLength: 254, pattern: '^\\P{C}*$' },
      telefone: textoContato(10, 20),
      documento: textoContato(11, 20)
    })
  }
}

const tipoTexto = { type: 'string' }
const respostaAsaas = objetoFechado({ erro: tipoTexto, mensagem: tipoTexto })
const respostaErro = objetoFechado({ erro: tipoTexto })

const respostas = {
  201: objetoFechado({
    pedidoId: tipoTexto,
    estado: tipoTexto,
    faturas: {
      type: 'array',
      items: objetoFechado({
        tipo: { type: 'string', enum: ['contas', 'dominios'] },
        url: { type: ['string', 'null'] }
      })
    }
  }),
  409: objetoFechado({ erro: tipoTexto, total_centavos: { type: 'integer' }, versao_tabela: tipoTexto }, ['erro']),
  422: respostaErro,
  502: respostaAsaas,
  503: respostaErro,
  504: respostaAsaas
}

export default async function rotasPedidos(app, opcoes) {
  const { asaas, asaasTimeoutMs, agora, versaoTabela, prazoPedidoMs, prazoCriandoMs } = opcoes
  // Sem adaptador (fora de produção, sem chave): 503 sem tocar no banco.
  const servico = asaas
    ? criarServicoPedidos({ pool: app.banco, asaas, asaasTimeoutMs, agora, versaoTabela, prazoPedidoMs, prazoCriandoMs })
    : null

  app.post('/pedidos', { schema: { body: corpoPedido, response: respostas } }, async (request, reply) => {
    if (!servico) return reply.code(503).send({ erro: 'asaas_nao_configurado' })
    const { status, corpo } = await servico.criarPedido(request.body, { log: request.log, requestId: request.id })
    return reply.code(status).send(corpo)
  })
}
