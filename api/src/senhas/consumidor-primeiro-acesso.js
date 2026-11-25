// Consumidor `senha_primeiro_acesso` (E5-H2; CIT-71): para cada `conta_titular_criada`,
// cria na transação do outbox a solicitação de primeiro acesso (sem token; o envio é da
// #72). Só conta `sem_senha` gera; o reprocessamento não duplica (`evento_processado`).
// Registrado só com `PAINEL_HABILITADO` (`consumidoresDoAmbiente`).
import { UnrecoverableError } from 'bullmq'
import { criarSolicitacao } from './servico.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const senhaPrimeiroAcesso = {
  eventos: ['conta_titular_criada'],
  async tratar({ cliente, evento, log }) {
    const contaId = evento.agregado_id
    if (evento.agregado_tipo !== 'conta_titular') throw new UnrecoverableError('agregado do evento não é conta_titular')
    if (typeof contaId !== 'string' || !UUID.test(contaId)) throw new UnrecoverableError('contaId inválido')
    if (evento.payload?.contaId !== contaId) throw new UnrecoverableError('contaId diverge do agregado')
    const resultado = await criarSolicitacao(cliente, contaId, {
      requestId: evento.request_id ?? evento.id, apenasSemSenha: true
    })
    if (!resultado.criada && resultado.motivo === 'inexistente') throw new UnrecoverableError('conta inexistente')
    if (resultado.criada) {
      log.info({ contaId, solicitacaoId: resultado.solicitacaoId }, 'solicitação de primeiro acesso criada')
    } else {
      log.info({ contaId, motivo: resultado.motivo }, 'solicitação de primeiro acesso não criada')
    }
  }
}
