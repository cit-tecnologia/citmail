import { setTimeout as esperar } from 'node:timers/promises'

// Job de exemplo (só fora de produção): fixa o padrão de log correlacionado de jobs.
// `esperarMs` simula um job demorado (testes de travamento e encerramento, CIT-56).
export async function jobExemplo({ log }, { falhar = false, esperarMs = 0 } = {}) {
  log.info('processando exemplo')
  if (esperarMs > 0) {
    await esperar(esperarMs)
  }
  if (falhar) {
    throw new Error('falha simulada do job de exemplo')
  }
}
