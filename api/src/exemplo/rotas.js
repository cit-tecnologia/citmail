// Endpoint de exemplo (só fora de produção, sem efeito colateral): fixa o padrão
// de schema por rota e de erro 400 por campo, e o de log correlacionado de job.
import { executarJob } from '../jobs/executar.js'
import { jobExemplo } from '../jobs/exemplo.js'

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

export default async function rotasExemplo(app) {
  app.post('/exemplos', {
    schema: { body: corpoExemplo, response: { 200: corpoExemplo } }
  }, async (request) => {
    return { titulo: request.body.titulo, quantidade: request.body.quantidade }
  })

  // A rota aguarda o job só no exemplo; na fila real (#56) ela apenas enfileira.
  // Logger raiz (`app.log`), não `request.log`: o `reqId` vem de `correlacaoId`.
  app.post('/exemplos/job', {
    schema: { body: corpoJobExemplo }
  }, async (request) => {
    await executarJob({ nome: 'exemplo', correlacaoId: request.id, log: app.log }, (contexto) =>
      jobExemplo(contexto, { falhar: request.body.falhar }))
    return { job: 'exemplo', status: 'concluido' }
  })
}
