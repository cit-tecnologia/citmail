// Consumidor `email_definicao_senha` (E7-H3; CIT-72): para cada `definicao_senha_solicitada`,
// pede na transação do outbox o e-mail do link pelo tipo da solicitação
// (`senha_primeiro_acesso` ou `senha_redefinicao`), com `refs = { solicitacaoId }` e chave
// por solicitação. O token não nasce aqui: só no envio (`carregar` do modelo). Registrado
// só com `PAINEL_HABILITADO` (`consumidoresDoAmbiente`).
import { UnrecoverableError } from 'bullmq'
import { UUID } from '../senhas/servico.js'
import { MODELO_POR_TIPO } from './modelos/senha.js'
import { solicitarEmail } from './servico.js'

export const emailDefinicaoSenha = {
  eventos: ['definicao_senha_solicitada'],
  async tratar({ cliente, evento, log }) {
    const contaId = evento.agregado_id
    const { solicitacaoId, tipo } = evento.payload ?? {}
    if (evento.agregado_tipo !== 'conta_titular') throw new UnrecoverableError('agregado do evento não é conta_titular')
    if (typeof contaId !== 'string' || !UUID.test(contaId)) throw new UnrecoverableError('contaId inválido')
    if (evento.payload?.contaId !== contaId) throw new UnrecoverableError('contaId diverge do agregado')
    if (typeof solicitacaoId !== 'string' || !UUID.test(solicitacaoId)) throw new UnrecoverableError('solicitacaoId inválido')
    if (!Object.hasOwn(MODELO_POR_TIPO, tipo)) throw new UnrecoverableError('tipo inválido')
    const { id: envioId, criado } = await solicitarEmail(cliente, {
      eventoId: evento.id,
      chaveIdempotencia: `definicao_senha-${solicitacaoId}`,
      modelo: MODELO_POR_TIPO[tipo],
      refs: { solicitacaoId }
    })
    log.info({ contaId, solicitacaoId, envioId, criado }, 'e-mail de definição de senha solicitado')
  }
}
