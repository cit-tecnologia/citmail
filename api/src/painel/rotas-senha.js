// Senha do titular por link (E5-H2; CIT-71; ADR 0008): POST /api/painel/senha/esqueci,
// /validar e /definir. Registradas junto do painel (`PAINEL_HABILITADO`). Ordem: `Origin`
// exato de `PAINEL_ORIGENS` (403, antes do corpo) → schema (400) → Redis pronto (503
// `sessao_indisponivel`, antes do banco e do hash) → regra da rota. Toda resposta leva
// `Cache-Control: no-store`. O token chega só no corpo e nunca vai a log.
import { comPrazo } from '../email/enfileirador.js'
import { JOB_SENHA_ESQUECI, OPCOES_JOB_ESQUECI } from '../senhas/job-esqueci.js'
import { definirSenha, ErroAuditoriaSenha, validarToken } from '../senhas/servico.js'
import { gerarHashSenha } from './senha.js'

const respostaErro = {
  type: 'object',
  additionalProperties: false,
  required: ['erro'],
  properties: { erro: { type: 'string' } }
}

const TOKEN = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }

const corpoEsqueci = {
  type: 'object',
  additionalProperties: false,
  required: ['email'],
  properties: { email: { type: 'string', minLength: 3, maxLength: 254 } }
}

const corpoValidar = {
  type: 'object',
  additionalProperties: false,
  required: ['token'],
  properties: { token: TOKEN }
}

// A política (12 a 128 code points, diferente do e-mail) é conferida no código.
const corpoDefinir = {
  type: 'object',
  additionalProperties: false,
  required: ['token', 'senha'],
  properties: { token: TOKEN, senha: { type: 'string', minLength: 1, maxLength: 1024 } }
}

// `filas`: as do painel (mesma conexão de produtor das sessões). `antesDeConsumir` e
// `auditoria` (`(cliente, dados)`, no lugar de `registrarAuditoria`) só nos testes.
export default async function rotasSenha(app, { origens, sessoes, filas, hash, antesDeConsumir, auditoria }) {
  const gerarHash = hash?.gerar ?? gerarHashSenha

  app.addHook('onSend', async (request, reply) => {
    reply.header('cache-control', 'no-store')
  })

  async function exigirOrigem(request, reply) {
    if (!origens.includes(request.headers.origin)) {
      return reply.code(403).send({ erro: 'origem_recusada' })
    }
  }

  // Antes do banco e do hash, sem depender do e-mail nem do token.
  async function exigirRedis(request, reply) {
    if (!sessoes?.pronto()) return reply.code(503).send({ erro: 'sessao_indisponivel' })
  }

  const linkInvalido = (reply) => reply.code(410).send({ erro: 'link_invalido' })

  // 202 sem corpo para qualquer e-mail: a busca da conta é do job. Só a falha ao enfileirar
  // (prazo de 2 s) muda a resposta, e independe do e-mail.
  app.post('/painel/senha/esqueci', {
    onRequest: exigirOrigem,
    preHandler: exigirRedis,
    schema: { body: corpoEsqueci, response: { 403: respostaErro, 503: respostaErro } }
  }, async (request, reply) => {
    try {
      if (!filas) throw new Error('sem filas')
      await comPrazo(filas.jobs.add(JOB_SENHA_ESQUECI, { email: request.body.email, requestId: request.id },
        OPCOES_JOB_ESQUECI))
    } catch (erro) {
      request.log.error({ codigo: erro.code ?? erro.name }, 'falha ao enfileirar o esqueci a senha')
      return reply.code(503).send({ erro: 'sessao_indisponivel' })
    }
    return reply.code(202).send()
  })

  app.post('/painel/senha/validar', {
    onRequest: exigirOrigem,
    preHandler: exigirRedis,
    schema: {
      body: corpoValidar,
      response: {
        200: { type: 'object', additionalProperties: false, required: ['tipo'], properties: { tipo: { type: 'string' } } },
        403: respostaErro,
        410: respostaErro,
        503: respostaErro
      }
    }
  }, async (request, reply) => {
    const solicitacao = await validarToken(app.banco, request.body.token)
    if (!solicitacao) return linkInvalido(reply)
    return { tipo: solicitacao.tipo }
  })

  app.post('/painel/senha/definir', {
    onRequest: exigirOrigem,
    preHandler: exigirRedis,
    schema: {
      body: corpoDefinir,
      response: { 400: respostaErro, 403: respostaErro, 410: respostaErro, 503: respostaErro }
    }
  }, async (request, reply) => {
    let resultado
    try {
      resultado = await definirSenha({
        pool: app.banco,
        token: request.body.token,
        senha: request.body.senha,
        ip: request.ip,
        requestId: request.id,
        gerarHash,
        antesDeConsumir,
        ...(auditoria ? { registrar: auditoria } : {})
      })
    } catch (erro) {
      if (!(erro instanceof ErroAuditoriaSenha)) throw erro
      request.log.error({ codigo: erro.code ?? erro.name }, 'falha ao auditar a troca de senha')
      return reply.code(503).send({ erro: 'sessao_indisponivel' })
    }
    if (resultado.erro === 'senha_fora_da_politica') return reply.code(400).send({ erro: resultado.erro })
    if (resultado.erro) return linkInvalido(reply)

    // Depois do COMMIT: a falha vai ao log; `senhaEm` em `exigirSessao` recusa as sessões antigas.
    try {
      await sessoes.encerrarTodas(resultado.contaId)
    } catch (erro) {
      request.log.error({ codigo: erro.code ?? erro.name }, 'falha ao encerrar as sessões da conta')
    }
    return reply.code(204).send()
  })
}
