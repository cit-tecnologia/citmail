// Endpoint de exemplo (só fora de produção, sem efeito colateral): fixa o padrão
// de schema por rota e de erro 400 por campo, e o de rota que só enfileira o job.

// Limite do `add`: com o Redis fora, o BullMQ espera a conexão indefinidamente.
// O comando pode valer depois do 503 (job fantasma, risco aceito no ADR 0005).
const LIMITE_FILA_MS = 2000

const corpoExemplo = {
  type: 'object',
  required: ['titulo', 'quantidade'],
  additionalProperties: false,
  properties: {
    titulo: { type: 'string', minLength: 1, maxLength: 80 },
    quantidade: { type: 'integer', minimum: 1, maximum: 10 }
  }
}

const corpoJobExemplo = {
  type: 'object',
  additionalProperties: false,
  properties: { falhar: { type: 'boolean' } }
}

function limiteDaFila(timer) {
  return new Promise((_, rejeitar) => {
    timer.id = setTimeout(() => {
      const erro = new Error('limite da fila')
      erro.name = 'TimeoutError'
      rejeitar(erro)
    }, LIMITE_FILA_MS)
  })
}

export default async function rotasExemplo(app, { filas } = {}) {
  app.post('/exemplos', {
    schema: { body: corpoExemplo, response: { 200: corpoExemplo } }
  }, async (request) => {
    return { titulo: request.body.titulo, quantidade: request.body.quantidade }
  })

  // Sem fila (sem `REDIS_URL`), a rota de job não existe.
  if (!filas) return

  // Só enfileira (ADR 0013, item 8): o worker roda o job com `reqId = requestId`.
  app.post('/exemplos/job', {
    schema: { body: corpoJobExemplo }
  }, async (request, reply) => {
    const timer = {}
    try {
      const job = await Promise.race([
        filas.jobs.add('exemplo', { requestId: request.id, falhar: request.body.falhar }),
        limiteDaFila(timer)
      ])
      return reply.code(202).send({ jobId: job.id })
    } catch (err) {
      // Erro do ioredis traz host e porta: só o nome.
      request.log.warn({ erro: err?.name }, 'fila indisponível')
      return reply.code(503).send({ erro: 'fila indisponível' })
    } finally {
      clearTimeout(timer.id)
    }
  })
}
