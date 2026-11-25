// Login do painel (ADR 0008; CIT-70): POST /api/painel/login, POST /api/painel/logout e
// GET /api/painel/sessao. Registradas só com `PAINEL_HABILITADO` (app.js). Sem sessões
// (fora de produção sem `REDIS_URL`) ou com o Redis fora, 503 antes do banco e do hash.
// Toda resposta leva `Cache-Control: no-store`.
import { registrarAuditoria } from '../auditoria/servico.js'
import { buscarContaParaLogin, buscarContaPorId } from '../contas/repositorio.js'
import { HASH_FALSO, hashPadrao } from './senha.js'

export const COOKIE_SESSAO = '__Host-citmail_sessao'
// `__Host-`: `Secure`, `Path=/` e sem `Domain`. Sem `Max-Age`/`Expires`: cookie de sessão do navegador.
const OPCOES_COOKIE = { path: '/', httpOnly: true, secure: true, sameSite: 'lax' }

const respostaErro = {
  type: 'object',
  additionalProperties: false,
  required: ['erro'],
  properties: { erro: { type: 'string' } }
}

const corpoLogin = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'senha'],
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 254 },
    senha: { type: 'string', minLength: 1, maxLength: 1024 }
  }
}

// Sessão amarrada à senha (CIT-71): epoch ms de `senha_definida_em`, ou null.
function epochDaSenha(conta) {
  return conta.senha_definida_em ? conta.senha_definida_em.getTime() : null
}

// ADR 0003: o logout declara corpo, vazio e fechado.
const corpoVazio = { type: 'object', additionalProperties: false, properties: {} }

/**
 * Fábrica do preHandler das rotas autenticadas do painel (CIT-71): lê a sessão do cookie,
 * confere a conta e renova. Recusa com 401 (apagando a sessão) quando a conta não está
 * `ativa`, quando a sessão não tem `senhaEm` (anterior à CIT-71) ou quando `senhaEm`
 * diverge do valor atual da conta (senha trocada: segunda defesa, além de `encerrarTodas`).
 * Redis ou banco fora: 503. Válida: `request.sessaoPainel = { sessao, conta }` (a rota
 * decora o request com `sessaoPainel`).
 */
export function criarExigirSessao({ sessoes, banco }) {
  return async function exigirSessao(request, reply) {
    const indisponivel = () => reply.code(503).send({ erro: 'sessao_indisponivel' })
    if (!sessoes?.pronto()) return indisponivel()
    const semSessao = () => reply.code(401).send({ erro: 'sem_sessao' })

    let sessao
    try {
      sessao = await sessoes.ler(request.cookies[COOKIE_SESSAO])
    } catch (erro) {
      request.log.error({ codigo: erro.code ?? erro.name }, 'falha ao ler a sessão do painel')
      return indisponivel()
    }
    if (!sessao) return semSessao()

    let conta
    try {
      conta = await buscarContaPorId(banco, sessao.dados.contaId)
      const senhaConfere = conta !== null && Object.hasOwn(sessao.dados, 'senhaEm') &&
        sessao.dados.senhaEm === epochDaSenha(conta)
      if (conta?.estado !== 'ativa' || !senhaConfere) {
        await sessoes.apagar(sessao.idHash, sessao.dados.contaId)
        return semSessao()
      }
      if (!(await sessoes.renovar(sessao))) return semSessao()
    } catch (erro) {
      request.log.error({ codigo: erro.code ?? erro.name }, 'falha ao conferir a sessão do painel')
      return indisponivel()
    }
    request.sessaoPainel = { sessao, conta }
  }
}

export default async function rotasPainel(app, { origens, sessoes, hash = hashPadrao, auditoria }) {
  const registrar = auditoria ?? ((dados) => registrarAuditoria(app.banco, dados))

  app.addHook('onSend', async (request, reply) => {
    reply.header('cache-control', 'no-store')
  })

  // CSRF (ADR 0008): `Origin` presente e exato, antes do corpo, do Redis e do banco.
  async function exigirOrigem(request, reply) {
    if (!origens.includes(request.headers.origin)) {
      return reply.code(403).send({ erro: 'origem_recusada' })
    }
  }

  function indisponivel(reply) {
    return reply.code(503).send({ erro: 'sessao_indisponivel' })
  }

  // Falha da trilha é logada e não muda a resposta. Sem e-mail em `detalhes`.
  async function auditar(request, dados) {
    try {
      await registrar({ ...dados, ip: request.ip, requestId: request.id })
    } catch (erro) {
      request.log.error({ err: erro }, 'falha ao gravar a auditoria do login')
    }
  }

  function falhaDeLogin(request, reply, detalhes) {
    return auditar(request, {
      autor: { tipo: 'cliente', id: null },
      acao: 'login_falhou',
      alvo: { tipo: 'conta', id: null },
      resultado: 'falha',
      ...(detalhes ? { detalhes } : {})
    }).then(() => reply.code(401).send({ erro: 'credenciais_invalidas' }))
  }

  app.post('/painel/login', {
    onRequest: exigirOrigem,
    schema: { body: corpoLogin, response: { 401: respostaErro, 403: respostaErro, 503: respostaErro } }
  }, async (request, reply) => {
    if (!sessoes?.pronto()) return indisponivel(reply)
    const { email, senha } = request.body
    const conta = await buscarContaParaLogin(app.banco, email)
    const podeEntrar = conta?.estado === 'ativa' && typeof conta.senha_hash === 'string'
    // Sempre uma verificação: e-mail inexistente e conta sem login usam o hash falso, e o
    // resultado dessa verificação é ignorado de propósito (só iguala o tempo de resposta).
    const confere = await hash.verificar(podeEntrar ? conta.senha_hash : HASH_FALSO, senha)
    if (!podeEntrar || !confere) return falhaDeLogin(request, reply, { motivo: 'credenciais' })

    let id
    try {
      // Fixação: a sessão do cookie anterior sai antes de a nova ser gravada.
      await sessoes.encerrar(request.cookies[COOKIE_SESSAO])
      id = await sessoes.criar({
        contaId: conta.id,
        clienteId: conta.cliente_id,
        senhaEm: epochDaSenha(conta),
        ip: request.ip,
        agenteUsuario: request.headers['user-agent']
      })
    } catch (erro) {
      // O mesmo 401 da senha errada: o status não revela que a senha conferiu. Só o código
      // do erro: o comando do Redis traz IP e agente de usuário.
      request.log.error({ codigo: erro.code ?? erro.name }, 'falha ao gravar a sessão do painel')
      return falhaDeLogin(request, reply)
    }
    // Limpeza do conjunto é manutenção: a falha vai ao log e não derruba o login.
    try {
      await sessoes.limparConjunto(conta.id)
    } catch (erro) {
      request.log.warn({ codigo: erro.code ?? erro.name }, 'falha ao limpar as sessões vencidas da conta')
    }

    await auditar(request, {
      autor: { tipo: 'cliente', id: conta.cliente_id },
      acao: 'login',
      alvo: { tipo: 'conta', id: conta.id },
      resultado: 'sucesso'
    })
    reply.setCookie(COOKIE_SESSAO, id, OPCOES_COOKIE)
    return reply.code(204).send()
  })

  // Sempre 204 com o cookie expirado, com ou sem sessão, com o Redis fora ou sem ele
  // (sem `REDIS_URL`): a falha da remoção vai só para o log.
  app.post('/painel/logout', {
    onRequest: exigirOrigem,
    schema: { body: corpoVazio, response: { 403: respostaErro } }
  }, async (request, reply) => {
    try {
      if (sessoes) await sessoes.encerrar(request.cookies[COOKIE_SESSAO])
    } catch (erro) {
      request.log.error({ codigo: erro.code ?? erro.name }, 'falha ao apagar a sessão do painel')
    }
    reply.clearCookie(COOKIE_SESSAO, OPCOES_COOKIE)
    return reply.code(204).send()
  })

  const exigirSessao = criarExigirSessao({ sessoes, banco: app.banco })

  app.decorateRequest('sessaoPainel', null)

  app.get('/painel/sessao', {
    preHandler: exigirSessao,
    schema: {
      response: {
        200: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string' } } },
        401: respostaErro,
        503: respostaErro
      }
    }
  }, async (request) => {
    return { email: request.sessaoPainel.conta.email }
  })
}
