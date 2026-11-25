// Definição e redefinição da senha do titular por link (E5-H2; CIT-71; ADR 0008).
// A solicitação nasce sem token (`criarSolicitacao`); o token só existe no envio
// (`emitirToken`, chamado pela #72) e o banco guarda só o SHA-256 dele.
import { createHash, randomBytes } from 'node:crypto'
import { registrarAuditoria } from '../auditoria/servico.js'
import { registrarEvento } from '../eventos/servico.js'
import { gerarHashSenha } from '../painel/senha.js'
import {
  buscarSolicitacaoAberta, consumirSolicitacao, contarSolicitacoes, gravarSenha, gravarTokenHash, inserirSolicitacao,
  invalidarAbertas, travarConta, travarContaNaoCancelada
} from './repositorio.js'

// Prazos pelo relógio do banco (`expira_em = now() + prazo`).
export const PRAZO_HORAS = Object.freeze({ primeiro_acesso: 72, redefinicao: 1 })
// Limites por conta: um pedido a cada 5 min (no SQL) e no máximo 5 abertas.
export const MAXIMO_ABERTAS = 5
// Política (ADR 0008): de 12 a 128 code points, sem normalização nem regra de composição.
export const SENHA_MINIMO = 12
export const SENHA_MAXIMO = 128

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function hashDoToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function senhaNoTamanho(senha) {
  const tamanho = [...senha].length
  return tamanho >= SENHA_MINIMO && tamanho <= SENHA_MAXIMO
}

export function senhaIgualAoEmail(senha, email) {
  return senha.trim().toLowerCase() === email
}

/**
 * Cria a solicitação de senha da conta, sempre dentro da transação do chamador
 * (`executor` é o Client com `BEGIN` aberto): trava a conta (`FOR UPDATE`, antes de
 * qualquer linha de `solicitacao_senha`), aplica os limites e, se couber, insere a
 * solicitação (sem token) e registra `definicao_senha_solicitada`.
 * Tipo pela conta: sem `senha_hash` → `primeiro_acesso` (72 h); com → `redefinicao` (1 h).
 * `apenasSemSenha` (consumidor do primeiro acesso): conta fora de `sem_senha` não gera.
 *
 * @returns {Promise<{ criada: true, solicitacaoId: string, tipo: string } |
 *   { criada: false, motivo: 'inexistente' | 'cancelada' | 'estado' | 'limite' }>}
 */
export async function criarSolicitacao(executor, contaId, { requestId, apenasSemSenha = false }) {
  const conta = await travarConta(executor, contaId)
  if (!conta) return { criada: false, motivo: 'inexistente' }
  if (conta.estado === 'cancelada') return { criada: false, motivo: 'cancelada' }
  if (apenasSemSenha && conta.estado !== 'sem_senha') return { criada: false, motivo: 'estado' }
  const { recentes, abertas } = await contarSolicitacoes(executor, contaId)
  if (recentes > 0 || abertas >= MAXIMO_ABERTAS) return { criada: false, motivo: 'limite' }

  const tipo = conta.senha_hash === null ? 'primeiro_acesso' : 'redefinicao'
  const { id: solicitacaoId, expira_em: expiraEm } = await inserirSolicitacao(executor, {
    contaId, tipo, prazoHoras: PRAZO_HORAS[tipo]
  })
  await registrarEvento(executor, {
    nome: 'definicao_senha_solicitada',
    agregado: { tipo: 'conta_titular', id: contaId },
    chaveIdempotencia: `definicao_senha_solicitada-${solicitacaoId}`,
    payload: { contaId, tipo, solicitacaoId, expiraEm: expiraEm.toISOString() },
    requestId
  })
  return { criada: true, solicitacaoId, tipo }
}

/**
 * Gera o token do link (32 bytes, base64url, 43 caracteres), grava o SHA-256 hex dele em
 * `token_hash` e devolve o token cru; `null` se a solicitação não estiver aberta (usada,
 * vencida, inexistente, de conta `cancelada` ou id fora do formato). Cada chamada troca o hash: o link anterior
 * deixa de valer. Contrato com o envio (#72; ADR 0008):
 * - `executor` em autocommit (Pool, ou Client fora de transação): o hash fica confirmado
 *   antes do SMTP;
 * - `null` (inclusive conta `cancelada`) → envio `nao_enviado`, sem nova tentativa;
 * - o token fica só em memória até montar o link: nunca em `refs`, log, `job.data`,
 *   evento ou auditoria;
 * - quem envia grava `enviada_em` (o papel da aplicação já tem o UPDATE).
 *
 * @param {import('pg').Pool | import('pg').Client} executor
 * @param {string} solicitacaoId
 * @returns {Promise<string | null>}
 */
export async function emitirToken(executor, solicitacaoId) {
  if (typeof solicitacaoId !== 'string' || !UUID.test(solicitacaoId)) return null
  const token = randomBytes(32).toString('base64url')
  return (await gravarTokenHash(executor, solicitacaoId, hashDoToken(token))) ? token : null
}

/** Solicitação aberta do token, de conta não cancelada: `{ tipo }` ou null. Sem efeito colateral. */
export async function validarToken(executor, token) {
  const solicitacao = await buscarSolicitacaoAberta(executor, hashDoToken(token))
  return solicitacao ? { tipo: solicitacao.tipo } : null
}

/** Falha da auditoria dentro da transação: a rota responde 503 e o token continua aberto. */
export class ErroAuditoriaSenha extends Error {
  constructor(causa) {
    super('auditoria da senha falhou')
    this.name = 'ErroAuditoriaSenha'
    this.code = causa?.code
  }
}

/**
 * Consome o token e grava a senha (ADR 0008). A política é conferida antes de consumir:
 * tamanho → solicitação aberta (senão `link_invalido`) → diferente do e-mail → Argon2id →
 * transação com a conta travada primeiro (mesma ordem do pedido de link): consome o
 * token, grava a senha, invalida as outras abertas da conta e audita `senha_trocada`.
 * `antesDeConsumir` (só testes) roda depois da trava da conta.
 *
 * @returns {Promise<{ definida: true, contaId: string } |
 *   { erro: 'senha_fora_da_politica' | 'link_invalido' }>}
 */
export async function definirSenha({
  pool, token, senha, ip, requestId, gerarHash = gerarHashSenha, registrar = registrarAuditoria, antesDeConsumir
}) {
  if (!senhaNoTamanho(senha)) return { erro: 'senha_fora_da_politica' }
  const tokenHash = hashDoToken(token)
  const solicitacao = await buscarSolicitacaoAberta(pool, tokenHash)
  if (!solicitacao) return { erro: 'link_invalido' }
  if (senhaIgualAoEmail(senha, solicitacao.email)) return { erro: 'senha_fora_da_politica' }
  const senhaHash = await gerarHash(senha)
  const contaId = solicitacao.conta_titular_id

  const cliente = await pool.connect()
  let erroDoCliente
  try {
    await cliente.query('BEGIN')
    const invalido = async () => {
      await cliente.query('ROLLBACK')
      return { erro: 'link_invalido' }
    }
    if (!(await travarContaNaoCancelada(cliente, contaId))) return await invalido()
    if (antesDeConsumir) await antesDeConsumir()
    if (!(await consumirSolicitacao(cliente, tokenHash, contaId))) return await invalido()
    if (!(await gravarSenha(cliente, contaId, senhaHash))) return await invalido()
    await invalidarAbertas(cliente, contaId)
    try {
      await registrar(cliente, {
        autor: { tipo: 'cliente', id: solicitacao.cliente_id },
        acao: 'senha_trocada',
        alvo: { tipo: 'conta', id: contaId },
        resultado: 'sucesso',
        ip,
        requestId,
        detalhes: { tipo: solicitacao.tipo }
      })
    } catch (erro) {
      throw new ErroAuditoriaSenha(erro)
    }
    await cliente.query('COMMIT')
    return { definida: true, contaId }
  } catch (erro) {
    try {
      await cliente.query('ROLLBACK')
    } catch (erroRollback) {
      // Cliente em estado incerto: descartado do pool no release.
      erroDoCliente = erroRollback
    }
    throw erro
  } finally {
    cliente.release(erroDoCliente)
  }
}
