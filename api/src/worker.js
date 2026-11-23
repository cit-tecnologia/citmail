// Processo do worker da fila (ADR 0006; CIT-56): `npm run worker`. Roda os jobs, os
// consumidores de eventos e o publicador do outbox (CIT-166), que lê o banco. Sem
// CORS; o token do Telegram só existe aqui (menor privilégio).
import { carregarConfigWorker } from './config.js'
import { criarLogger } from './log.js'
import { criarPool } from './banco.js'
import { criarConexaoProdutor, criarConexaoWorker } from './fila/conexao.js'
import { criarFilas } from './fila/filas.js'
import { criarWorkers, handlersPadrao } from './fila/worker.js'
import { criarEnvioTelegram } from './alertas/telegram.js'
import { consumidoresPadrao, criarHandlersDeConsumidores } from './eventos/consumidores.js'
import { iniciarPublicador } from './eventos/publicador.js'

let config
try {
  config = carregarConfigWorker()
} catch (erro) {
  console.error(`Configuração inválida: ${erro.message}`)
  process.exit(1)
}

const log = criarLogger({ level: config.logLevel })
const pool = criarPool(config.databaseUrl, log)
const opcoesFilas = {
  prefixo: config.filaPrefixo,
  tentativas: config.filaTentativas,
  backoffMs: config.filaBackoffMs,
  log
}
const conexao = criarConexaoWorker(config.redisUrl)
const filas = criarFilas({ conexao, ...opcoesFilas })

// O publicador usa conexão de produtor (falha rápida com o Redis fora) e filas
// próprias: o `addBulk` não fica preso esperando a reconexão dos workers.
const conexaoProdutor = criarConexaoProdutor(config.redisUrl)
const filasPublicador = criarFilas({ conexao: conexaoProdutor, ...opcoesFilas })

const handlersConsumidores = criarHandlersDeConsumidores({ pool, consumidores: consumidoresPadrao })
const workers = criarWorkers({
  conexao,
  filas,
  prefixo: config.filaPrefixo,
  log,
  nodeEnv: config.nodeEnv,
  handlers: config.nodeEnv === 'production'
    ? handlersConsumidores
    : { ...handlersPadrao, ...handlersConsumidores },
  enviarAlerta: criarEnvioTelegram({ token: config.telegramBotToken, chatId: config.telegramChatId, log })
})
log.info({ prefixo: config.filaPrefixo }, 'worker iniciado')

const publicador = iniciarPublicador({
  pool,
  filas: filasPublicador,
  consumidores: consumidoresPadrao,
  log,
  intervaloMs: config.outboxIntervaloMs
})

// Ordem: o publicador para de criar jobs; `workers.close()` espera o job ativo terminar
// e os alertas em curso serem enfileirados; depois filas, pool e conexões. Um segundo
// sinal durante o encerramento é ignorado (a unidade systemd mata o processo após
// `TimeoutStopSec`).
let encerrando = false
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, async () => {
    if (encerrando) return
    encerrando = true
    log.info({ sinal }, 'encerrando')
    let codigo = 0
    try {
      await publicador.close()
      await workers.close()
      await filas.close()
      // Com o Redis fora, o `close()` das filas do produtor pode falhar: a conexão
      // é derrubada de qualquer jeito.
      await filasPublicador.close().catch((erro) => log.warn({ erro: erro?.name }, 'falha ao fechar filas do publicador'))
      conexaoProdutor.disconnect()
      await pool.end()
      await conexao.quit()
    } catch (erro) {
      codigo = 1
      log.error({ erro: erro?.name }, 'falha ao encerrar')
    } finally {
      process.exit(codigo)
    }
  })
}
