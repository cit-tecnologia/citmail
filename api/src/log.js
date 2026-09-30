import { LogController } from 'fastify'

// Log técnico da API (ADR 0013, item 8; CIT-55): uma linha por requisição,
// sem URL concreta, headers nem corpo, e máscara por nome de campo.

// Campos mascarados pelo nome exato (o `redact` diferencia maiúsculas), na raiz
// e em até 3 níveis de aninhamento. Campo novo com dado pessoal entra aqui.
export const camposSensiveis = [
  // Pedido (campos do checkout), em português.
  'senha', 'token', 'email', 'telefone', 'nome', 'cpf', 'cnpj', 'cpfCnpj', 'documento', 'razaoSocial',
  'nascimento', 'dataNascimento', 'cep', 'endereco', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade',
  // ViaCEP.
  'localidade',
  // Credenciais em inglês.
  'password', 'authorization', 'accessToken', 'access_token', 'refreshToken', 'apiKey',
  // Cliente e pagamento do Asaas (`creditCard` traz o `creditCardToken`, que permite cobrar de novo).
  'name', 'phone', 'mobilePhone', 'company', 'postalCode', 'address', 'addressNumber', 'complement', 'province',
  'cityName', 'additionalEmails', 'municipalInscription', 'stateInscription', 'creditCard', 'creditCardToken'
]

export const caminhosMascarados = [
  ...camposSensiveis,
  ...camposSensiveis.map((campo) => `*.${campo}`),
  ...camposSensiveis.map((campo) => `*.*.${campo}`),
  ...camposSensiveis.map((campo) => `*.*.*.${campo}`),
  // O serializer `req` não loga headers; estes caminhos são defesa caso alguém volte a serializá-los.
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["asaas-access-token"]',
  'res.headers["set-cookie"]',
  // Campos de erro do `pg` que repetem valores da linha (ex.: violação de unicidade),
  // no erro e na `cause`. O serializer `err` do pino copia a `cause` atribuída que não
  // é Error (ex.: `erro.cause = { ...erroPg }`); de uma `cause` Error só junta message e stack.
  ...['detail', 'where', 'parameters', 'hint', 'internalQuery', 'query'].flatMap((campo) => [
    `err.${campo}`,
    `err.cause.${campo}`
  ])
]

const LIMITE_CAMINHO = 200

// Rota pelo template (`/api/exemplos/:id`), nunca a URL concreta: sem query nem
// valores de parâmetro. Só no 404 (sem rota) sai o `caminho`, sem query e truncado.
export const serializadores = {
  req(request) {
    const rota = request.routeOptions?.url ?? null
    const saida = { method: request.method, rota, remoteAddress: request.ip }
    if (rota === null) {
      saida.caminho = String(request.url ?? '').split('?')[0].slice(0, LIMITE_CAMINHO)
    }
    return saida
  },
  res(reply) {
    return { statusCode: reply.statusCode }
  }
}

// Uma linha só por requisição (`request completed`), com rota, status, duração e IP.
// Não usa `disableRequestLogging` (deprecado, FSTDEP023, e cala também erros de stream).
export class LogCitmail extends LogController {
  incomingRequest() {}

  requestCompleted(err, request, reply) {
    if (this.isLogDisabled(request)) return
    const responseTime = reply.elapsedTime
    if (err) {
      reply.log.error({ req: request, res: reply, err, responseTime }, 'request errored')
    } else {
      reply.log.info({ req: request, res: reply, responseTime }, 'request completed')
    }
  }

  // Defesa: hoje não roda, porque `registrarErros` (src/erros.js) registra o
  // `setNotFoundHandler`. Se esse handler sair, o `basic404` do Fastify chama este
  // método, e a linha padrão (`Route GET:/x?... not found`) levaria a query crua.
  // O 404 já sai em `request completed`.
  routeNotFound() {}
}
