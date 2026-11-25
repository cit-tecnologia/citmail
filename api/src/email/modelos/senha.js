import { emitirToken, hashDoToken, PRAZO_HORAS, UUID } from '../../senhas/servico.js'
import { buscarParaEnvio, marcarEnviada } from '../../senhas/repositorio.js'
import { destinatarioValido, html, texto } from '../html.js'

// E-mails do link de senha do painel (E7-H3; CIT-72; ADR 0008): `senha_primeiro_acesso`
// e `senha_redefinicao`, pedidos pelo consumidor `email_definicao_senha` e pela reemissão
// do "esqueci" com `refs = { solicitacaoId }`. O token nasce no `carregar`, por último
// (depois de conferir solicitação, tipo, destinatário e URL do painel), e fica só em
// memória: no link das `variaveis`; ao handler volta só o SHA-256 (`tokenHash`), para o
// `aposEnviar` gravar `enviada_em`. Cada `carregar` troca o hash: vale o último link emitido.
// Corpo sem senha, sem `senha_hash` e sem dado além do link e do prazo.

export const ASSUNTO_PRIMEIRO_ACESSO = 'Defina sua senha do CITMail'
export const ASSUNTO_REDEFINICAO = 'Redefinição de senha do CITMail'
export const MODELO_POR_TIPO = Object.freeze({
  primeiro_acesso: 'senha_primeiro_acesso',
  redefinicao: 'senha_redefinicao'
})

const PAGINA = 'definir-senha.html'
// Prazo cheio quando faltam até 5 min para ele (envio logo após o pedido).
const FOLGA_PRAZO_S = 5 * 60
const DATA = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' })
const HORA = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: 'America/Sao_Paulo' })

const plural = (n, singular, varios) => `${n} ${n === 1 ? singular : varios}`

/**
 * Prazo restante em texto, arredondado para baixo: o prazo cheio ("72 horas", "1 hora") se
 * faltam pelo menos `prazo − 5 min`; senão "N horas" com 120 min ou mais; senão "N minutos"
 * (mínimo 1).
 */
export function formatarPrazo(segundosRestantes, prazoHoras) {
  if (segundosRestantes >= prazoHoras * 3600 - FOLGA_PRAZO_S) return plural(prazoHoras, 'hora', 'horas')
  const minutos = Math.floor(segundosRestantes / 60)
  if (minutos >= 120) return plural(Math.floor(minutos / 60), 'hora', 'horas')
  return plural(Math.max(1, minutos), 'minuto', 'minutos')
}

/** Data e hora de `expiraEm` em pt-BR, no horário de Brasília: `{ data, hora }`. */
export function formatarExpiracao(expiraEm) {
  return { data: DATA.format(expiraEm), hora: HORA.format(expiraEm) }
}

const fraseDoPrazo = (v) => `Este link vale por ${v.prazo}, até ${v.data} às ${v.hora} (horário de Brasília), e só pode ser usado uma vez.`

function criarModelo(tipo, { assunto, finalidade, aviso }) {
  return {
    versao: 1,
    async carregar(pool, refs, contexto = {}) {
      const solicitacaoId = refs?.solicitacaoId
      if (typeof solicitacaoId !== 'string' || !UUID.test(solicitacaoId)) return { semEnvio: 'LINK_FECHADO' }
      const solicitacao = await buscarParaEnvio(pool, solicitacaoId)
      if (!solicitacao) return { semEnvio: 'LINK_FECHADO' }
      if (solicitacao.tipo !== tipo) {
        contexto.log?.warn({ solicitacaoId }, 'tipo da solicitação diverge do modelo')
        return { semEnvio: 'TIPO_DIVERGENTE' }
      }
      // Antes de gastar o token: o handler recusaria o endereço do mesmo jeito.
      if (!destinatarioValido(solicitacao.email)) return null
      if (!contexto.painelUrlBase) return { semEnvio: 'SEM_URL_PAINEL' }
      const token = await emitirToken(pool, solicitacaoId)
      if (!token) return { semEnvio: 'LINK_FECHADO' }
      if (solicitacao.tinha_token) contexto.log?.info({ solicitacaoId }, 'link substituído')
      return {
        destinatario: solicitacao.email,
        variaveis: {
          link: `${new URL(PAGINA, contexto.painelUrlBase).href}#t=${token}`,
          prazo: formatarPrazo(solicitacao.segundos_restantes, PRAZO_HORAS[tipo]),
          ...formatarExpiracao(solicitacao.expira_em)
        },
        tokenHash: hashDoToken(token)
      }
    },
    // `enviada_em` só com o hash deste envio (contrato (d) do ADR 0008).
    async aposEnviar(pool, refs, { tokenHash, log } = {}) {
      if (typeof tokenHash !== 'string') return
      if (!(await marcarEnviada(pool, refs.solicitacaoId, tokenHash))) {
        log?.info({ solicitacaoId: refs.solicitacaoId }, 'link substituído')
      }
    },
    assunto: () => assunto,
    html: (v) => html`<!doctype html>
<html lang="pt-BR">
<body>
<p>Olá.</p>
<p>${finalidade}</p>
<p><a href="${v.link}">${v.link}</a></p>
<p>${fraseDoPrazo(v)}</p>
${aviso ? html`<p>${aviso}</p>
` : ''}<p>Equipe CITMail</p>
</body>
</html>`,
    texto: (v) => {
      const linhas = ['Olá.', '', finalidade, '', texto`${v.link}`, '', texto`${fraseDoPrazo(v)}`, '']
      if (aviso) linhas.push(aviso, '')
      linhas.push('Equipe CITMail', '')
      return linhas.join('\n')
    }
  }
}

export const senhaPrimeiroAcesso = criarModelo('primeiro_acesso', {
  assunto: ASSUNTO_PRIMEIRO_ACESSO,
  finalidade: 'Seu acesso ao painel do CITMail está pronto. Para entrar pela primeira vez, defina sua senha pelo link abaixo:'
})

export const senhaRedefinicao = criarModelo('redefinicao', {
  assunto: ASSUNTO_REDEFINICAO,
  finalidade: 'Recebemos um pedido para redefinir a senha do painel do CITMail. Para criar uma nova senha, use o link abaixo:',
  aviso: 'Se você não pediu, ignore este e-mail; sua senha atual continua valendo.'
})
