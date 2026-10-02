import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import AjvCompiler from '@fastify/ajv-compiler'
import { criarPool } from './banco.js'
import { registrarErros } from './erros.js'
import rotasSaude from './saude/rotas.js'
import rotasExemplo from './exemplo/rotas.js'
import { caminhosMascarados, LogCitmail, serializadores } from './log.js'
import { criarConexaoProdutor } from './fila/conexao.js'
import { criarFilas } from './fila/filas.js'

// ADR 0003: toda rota que recebe corpo declara `schema.body`. Exceções, se
// houver, entram aqui como 'MÉTODO /caminho' com o motivo ao lado.
const metodosComCorpo = ['POST', 'PUT', 'PATCH']
const rotasSemSchemaDeCorpo = new Set([])

// Corpo JSON sem coerção de tipo ("2" não vira 2); querystring e params mantêm
// a coerção padrão do Fastify, porque chegam sempre como texto.
const fabricaAjv = AjvCompiler()
function construirValidador(externos, opcoesAjv) {
  const comCoercao = fabricaAjv(externos, opcoesAjv)
  const semCoercao = fabricaAjv(externos, {
    ...opcoesAjv,
    customOptions: { ...opcoesAjv.customOptions, coerceTypes: false }
  })
  return (rota) => (rota.httpPart === 'body' ? semCoercao : comCoercao)(rota)
}

export function construirApp(config, { pool, logStream, filas } = {}) {
  const origens = config?.corsOrigens
  if (!Array.isArray(origens) || origens.length === 0 || origens.some((o) => !o || o.includes('*'))) {
    throw new Error('CORS_ORIGENS inválida: informe a lista exata de origens permitidas')
  }

  const app = Fastify({
    logger: {
      level: config.logLevel ?? 'info',
      redact: { paths: caminhosMascarados, censor: '[mascarado]' },
      serializers: serializadores,
      ...(logStream ? { stream: logStream } : {})
    },
    logController: new LogCitmail(),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 65536,
    ajv: { customOptions: { allErrors: true, removeAdditional: false } },
    schemaController: { compilersFactory: { buildValidator: construirValidador } }
  })

  app.addHook('onRoute', (rota) => {
    for (const metodo of [rota.method].flat()) {
      if (metodosComCorpo.includes(metodo) && !rota.schema?.body && !rotasSemSchemaDeCorpo.has(`${metodo} ${rota.url}`)) {
        throw new Error(`Rota ${metodo} ${rota.url} sem schema.body (ADR 0003)`)
      }
    }
  })

  // O app só fecha o pool que ele mesmo criou; pool injetado é de quem o criou.
  const poolProprio = !pool
  const poolBanco = pool ?? criarPool(config.databaseUrl, app.log)
  app.decorate('banco', poolBanco)
  if (poolProprio) {
    app.addHook('onClose', async () => {
      await poolBanco.end()
    })
  }

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  // Cliente que desiste antes da resposta não passa por `request completed`.
  app.addHook('onRequestAbort', async (request) => {
    request.log.info({ req: request }, 'request aborted')
  })

  app.register(cors, {
    origin: origens,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: false
  })

  registrarErros(app)
  app.register(rotasSaude, { prefix: '/api' })
  // A guarda de produção vem antes de qualquer fila: lá a rota de exemplo não existe,
  // nem com `filas` injetado. Fora de produção, `filas` injetado é de quem o criou
  // (o app não fecha); sem ele e com `REDIS_URL`, o app cria e fecha as suas.
  if (config.nodeEnv !== 'production') {
    let filasExemplo = filas
    if (!filasExemplo && config.redisUrl) {
      const conexao = criarConexaoProdutor(config.redisUrl)
      filasExemplo = criarFilas({
        conexao,
        prefixo: config.filaPrefixo,
        tentativas: config.filaTentativas,
        backoffMs: config.filaBackoffMs,
        log: app.log
      })
      app.addHook('onClose', async () => {
        try {
          await filasExemplo.close()
        } finally {
          conexao.disconnect()
        }
      })
    }
    app.register(rotasExemplo, { prefix: '/api', filas: filasExemplo })
  }

  return app
}
