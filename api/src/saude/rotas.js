import { verificarBanco } from '../banco.js'

const corpoSaude = {
  type: 'object',
  required: ['status', 'banco'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok', 'indisponivel'] },
    banco: { type: 'string', enum: ['ok', 'indisponivel'] }
  }
}

// Rota técnica: acessa o pool direto (`app.banco`), sem serviço/repositório (ADR 0002).
export default async function rotasSaude(app) {
  // `warn`: o monitoramento externo (ADR 0011) chama a cada minuto; a falha continua no log.
  app.get('/health', {
    logLevel: 'warn',
    schema: { response: { 200: corpoSaude, 503: corpoSaude } }
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    try {
      await verificarBanco(app.banco)
      return { status: 'ok', banco: 'ok' }
    } catch (erro) {
      // Só o código do erro: a mensagem do driver pode trazer host, porta ou usuário.
      request.log.warn({ codigo: erro?.code ?? 'desconhecido' }, 'banco indisponível no health')
      return reply.code(503).send({ status: 'indisponivel', banco: 'indisponivel' })
    }
  })
}
