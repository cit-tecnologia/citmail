// Processo do worker da fila (ADR 0006; CIT-56): `npm run worker`. Não usa banco nem
// CORS; o token do Telegram só existe aqui (menor privilégio).
import { carregarConfigWorker } from './config.js'
import { criarLogger } from './log.js'
import { criarConexaoWorker } from './fila/conexao.js'
import { criarFilas } from './fila/filas.js'
import { criarWorkers } from './fila/worker.js'
import { criarEnvioTelegram } from './alertas/telegram.js'

let config
try {
  config = carregarConfigWorker()
} catch (erro) {
  console.error(`Configuração inválida: ${erro.message}`)
  process.exit(1)
}

const log = criarLogger({ level: config.logLevel })
const conexao = criarConexaoWorker(config.redisUrl)
const filas = criarFilas({
  conexao,
  prefixo: config.filaPrefixo,
  tentativas: config.filaTentativas,
  backoffMs: config.filaBackoffMs,
  log
})
const workers = criarWorkers({
  conexao,
  filas,
  prefixo: config.filaPrefixo,
  log,
  nodeEnv: config.nodeEnv,
  enviarAlerta: criarEnvioTelegram({ token: config.telegramBotToken, chatId: config.telegramChatId, log })
})
log.info({ prefixo: config.filaPrefixo }, 'worker iniciado')

// `workers.close()` espera o job ativo terminar e os alertas em curso serem enfileirados
// antes de fechar as filas e a conexão. Um segundo sinal durante o encerramento é
// ignorado (a unidade systemd mata o processo após `TimeoutStopSec`).
let encerrando = false
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, async () => {
    if (encerrando) return
    encerrando = true
    log.info({ sinal }, 'encerrando')
    let codigo = 0
    try {
      await workers.close()
      await filas.close()
      await conexao.quit()
    } catch (erro) {
      codigo = 1
      log.error({ erro: erro?.name }, 'falha ao encerrar')
    } finally {
      process.exit(codigo)
    }
  })
}
