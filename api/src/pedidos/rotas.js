// POST /api/pedidos (ADR 0014; CIT-61): cria o cliente e as assinaturas no Asaas.
// Registrada só com `PEDIDOS_HABILITADO` (app.js). O corpo é o do orçamento com
// `dominio.nome`, mais `dominios_extras`, `cliente`, `chave_idempotencia`,
// `versao_tabela`, `total_exibido_centavos` e `aceite` (CIT-62); todo objeto é fechado
// (campo de cartão → 400).
// POST /api/pedidos/status (ADR 0016; CIT-69): consulta pelo token de acompanhamento, só
// com o pool; responde mesmo sem adaptador do Asaas (fora do 503).
import { criarCorpoOrcamento } from '../precos/rotas.js'
import { LIMITES } from '../precos/tabela.js'
import { buscarStatusPorToken } from './repositorio.js'
import { AVISO_FATURA_PENDENTE, criarServicoPedidos } from './servico.js'
import { hashDoToken, tokenValido } from './token.js'

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
  required: [
    ...baseOrcamento.required, 'chave_idempotencia', 'versao_tabela', 'total_exibido_centavos', 'cliente', 'aceite'
  ],
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
    }),
    // Corpo sem coerção (app.js): `"true"` não vira `true`.
    aceite: objetoFechado({
      termos: { type: 'boolean', const: true },
      versao_termos: { ...texto(1, 32), pattern: '^[0-9A-Za-z._-]+$' },
      versao_privacidade: { ...texto(1, 64), pattern: '^[0-9A-Za-z._-]+$' }
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
    },
    aviso: { type: 'string', enum: [AVISO_FATURA_PENDENTE] },
    token: tipoTexto
  }, ['pedidoId', 'estado', 'faturas', 'token']),
  409: objetoFechado({
    erro: tipoTexto,
    total_centavos: { type: 'integer' },
    versao_tabela: tipoTexto,
    versao_termos: tipoTexto,
    versao_privacidade: tipoTexto
  }, ['erro']),
  422: respostaErro,
  502: respostaAsaas,
  503: respostaErro,
  504: respostaAsaas
}

// Estado → etapa exposta (ADR 0016): o estado cru nunca sai na resposta.
const ETAPAS = {
  criando: 'aguardando_confirmacao',
  aguardando_pagamento: 'aguardando_confirmacao',
  aguardando_pagamento_do_dominio: 'dominio_pendente',
  aguardando_registro_de_dominio: 'registro_dominio',
  pago: 'ativando',
  falha_no_provisionamento: 'ativando',
  ativo: 'ativo',
  falhou_na_criacao: 'erro_criacao',
  cancelado: 'cancelado'
}
const ETAPA_DESCONHECIDA = 'em_analise'

// Corpo fechado; token fora do padrão responde o mesmo 404 do inexistente.
export const corpoStatus = objetoFechado({ token: { type: 'string', maxLength: 128 } })

const respostasStatus = {
  200: objetoFechado({
    etapa: { type: 'string', enum: [...new Set([...Object.values(ETAPAS), ETAPA_DESCONHECIDA])] },
    dominioNovo: { type: 'boolean' },
    faturaContasUrl: tipoTexto,
    faturaDominioUrl: tipoTexto
  }, ['etapa', 'dominioNovo']),
  404: respostaErro
}

// Mesma regra de `urlFaturaSegura` do checkout: `https:`, host exato do Asaas, sem porta
// nem credenciais. null se a URL não passa.
const HOSTS_FATURA = ['www.asaas.com', 'sandbox.asaas.com']
export function urlFaturaSegura(url) {
  if (typeof url !== 'string') return null
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !HOSTS_FATURA.includes(u.hostname) || u.port !== '' || u.username !== '' ||
      u.password !== '') return null
  return u.href
}

// Lista branca (ADR 0016): etapa, domínio novo e as URLs das faturas em aberto, nunca com
// fatura retida. Sem id, nome, e-mail, domínio, valores nem datas.
function corpoDoStatus(linha) {
  const etapa = ETAPAS[linha.estado] ?? ETAPA_DESCONHECIDA
  const corpo = { etapa, dominioNovo: linha.dominio_novo }
  if (linha.fatura_retida) return corpo
  const urlContas = etapa === 'aguardando_confirmacao' ? urlFaturaSegura(linha.url_contas) : null
  const dominioEmAberto = etapa === 'dominio_pendente' ||
    (etapa === 'aguardando_confirmacao' && linha.dominio_novo && linha.dominio_em_aberto)
  const urlDominio = dominioEmAberto ? urlFaturaSegura(linha.url_dominios) : null
  if (urlContas) corpo.faturaContasUrl = urlContas
  if (urlDominio) corpo.faturaDominioUrl = urlDominio
  return corpo
}

const NAO_ENCONTRADO = { erro: 'nao_encontrado' }

export default async function rotasPedidos(app, opcoes) {
  // Antes do ramo do 503: só o pool. O token vai no corpo, que não é logado (ADR 0013).
  app.post('/pedidos/status', { schema: { body: corpoStatus, response: respostasStatus } }, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    const { token } = request.body
    const linha = tokenValido(token) ? await buscarStatusPorToken(app.banco, hashDoToken(token)) : null
    if (!linha) return reply.code(404).send(NAO_ENCONTRADO)
    return reply.code(200).send(corpoDoStatus(linha))
  })

  const {
    asaas, asaasTimeoutMs, agora, versaoTabela, versaoTermos, versaoPrivacidade, prazoPedidoMs, prazoCriandoMs
  } = opcoes
  // Sem adaptador (fora de produção, sem chave): 503 sem tocar no banco.
  const servico = asaas
    ? criarServicoPedidos({
      pool: app.banco, asaas, asaasTimeoutMs, agora, versaoTabela, versaoTermos, versaoPrivacidade, prazoPedidoMs, prazoCriandoMs
    })
    : null

  app.post('/pedidos', { schema: { body: corpoPedido, response: respostas } }, async (request, reply) => {
    if (!servico) return reply.code(503).send({ erro: 'asaas_nao_configurado' })
    // IP do aceite: `request.ip` (trustProxy só no loopback), nunca um header lido à mão.
    const { status, corpo } = await servico.criarPedido(request.body, {
      log: request.log, requestId: request.id, ip: request.ip
    })
    // O 201 leva o token de acompanhamento (ADR 0016): nada de cache intermediário.
    if (status === 201) reply.header('cache-control', 'no-store')
    return reply.code(status).send(corpo)
  })
}
