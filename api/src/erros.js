// Respostas de erro padronizadas: nunca expõem stack, mensagem interna nem códigos FST_.

// Erro de regra de negócio (409, 422, 429...): o serviço lança e o handler
// responde com o status e `{ erro }`, sem expor mensagem interna.
export class ErroDeDominio extends Error {
  constructor({ status, erro }) {
    // Status inválido quebraria o handler e cairia no 500 genérico, fora do contrato `{ erro }`.
    if (!Number.isInteger(status) || status < 400 || status > 499) {
      throw new TypeError('ErroDeDominio: status deve ser inteiro entre 400 e 499')
    }
    super(erro)
    this.name = 'ErroDeDominio'
    this.status = status
    this.erro = erro
  }
}

// Máximo de itens em `campos` no 400 de validação, para todas as rotas.
const LIMITE_CAMPOS = 20

const mensagensPorRegra = {
  required: 'obrigatório',
  type: 'tipo inválido',
  minLength: 'fora do limite',
  maxLength: 'fora do limite',
  minimum: 'fora do limite',
  maximum: 'fora do limite',
  exclusiveMinimum: 'fora do limite',
  exclusiveMaximum: 'fora do limite',
  minItems: 'fora do limite',
  maxItems: 'fora do limite',
  additionalProperties: 'campo não permitido'
}

function nomeDoCampo(item) {
  const base = (item.instancePath ?? '').replace(/^\//, '').replaceAll('/', '.')
  const propriedade = item.params?.missingProperty ?? item.params?.additionalProperty
  if (propriedade === undefined) return base
  return base ? `${base}.${propriedade}` : propriedade
}

export function registrarErros(app) {
  app.setErrorHandler((erro, request, reply) => {
    if (erro instanceof ErroDeDominio) {
      return reply.code(erro.status).send({ erro: erro.erro })
    }
    if (erro.validation) {
      // Só os primeiros: com `allErrors`, um corpo com milhares de chaves geraria milhares de itens.
      const campos = erro.validation.slice(0, LIMITE_CAMPOS).map((item) => ({
        campo: nomeDoCampo(item).slice(0, 100),
        mensagem: mensagensPorRegra[item.keyword] ?? 'valor inválido'
      }))
      return reply.code(400).send({ erro: 'validacao', campos })
    }
    if (erro.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || erro.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(400).send({ erro: 'json_invalido' })
    }
    const status = erro.statusCode
    if (status === 413) {
      return reply.code(413).send({ erro: 'corpo_muito_grande' })
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ erro: 'requisicao_invalida' })
    }
    request.log.error({ err: erro }, 'erro não tratado')
    return reply.code(500).send({ erro: 'interno', requestId: request.id })
  })

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ erro: 'nao_encontrado' })
  })
}
