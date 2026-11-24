// Processo do worker da fila (ADR 0006; CIT-56): `npm run worker`. Roda os jobs, os
// consumidores de eventos e o publicador do outbox (CIT-166), que lê o banco, e, com
// `WEBHOOK_ASAAS_HABILITADO`, o enfileirador e o handler do webhook do Asaas (CIT-64), e
// o enfileirador e o handler do e-mail transacional (CIT-65) e o laço das tarefas de
// domínio (CIT-77), em todos os ambientes.
// Sem CORS; o token do Telegram só existe aqui (menor privilégio).
import { carregarConfigWorker } from './config.js'
import { criarLogger } from './log.js'
import { criarPool } from './banco.js'
import { criarConexaoProdutor, criarConexaoWorker } from './fila/conexao.js'
import { criarFilas } from './fila/filas.js'
import { criarWorkers, handlersPadrao } from './fila/worker.js'
import { criarEnvioTelegram } from './alertas/telegram.js'
import { consumidoresPadrao, criarHandlersDeConsumidores } from './eventos/consumidores.js'
import { iniciarPublicador } from './eventos/publicador.js'
import { criarClienteAsaas } from './asaas/cliente.js'
import { criarHandlerWebhook, iniciarEnfileiradorWebhook, JOB_WEBHOOK } from './asaas/webhook-processamento.js'
import { criarHandlerEmail, JOB_EMAIL } from './email/servico.js'
import { iniciarEnfileiradorEmail } from './email/enfileirador.js'
import { modelosDoAmbiente } from './email/modelos/index.js'
import { criarTransporte } from './email/transporte.js'
import { iniciarTarefasDominio } from './dominios/laco.js'

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
// Webhook do Asaas (ADR 0015): registrado também em produção; os alertas do handler vão
// pelas filas do publicador (falha rápida, prazo de 2 s). Sem chave (só fora de produção),
// o handler lança e o bruto fica para reenvio.
const handlersWebhook = {}
if (config.webhookAsaasHabilitado) {
  const asaas = config.asaasApiKey
    ? criarClienteAsaas({ baseUrl: config.asaasBaseUrl, apiKey: config.asaasApiKey, timeoutMs: config.asaasTimeoutMs })
    : undefined
  if (!asaas) log.warn('webhook do asaas sem ASAAS_API_KEY: os jobs vão falhar até a configuração')
  handlersWebhook[JOB_WEBHOOK] = criarHandlerWebhook({ pool, asaas, filas: filasPublicador, log })
}
// E-mail transacional (ADR 0010): `teste_exemplo` só fora de produção. Desligado (padrão
// até haver credencial, #57), o job grava `nao_enviado`; em produção, a partida avisa.
const transporteEmail = criarTransporte(config)
if (config.nodeEnv === 'production' && !transporteEmail.ligado) log.warn('e-mail desligado em produção')
const handlersEmail = {
  [JOB_EMAIL]: criarHandlerEmail({
    pool,
    modelos: modelosDoAmbiente(config.nodeEnv),
    transporte: transporteEmail,
    remetente: config.emailRemetente,
    responderPara: config.emailResponderPara,
    log
  })
}
const workers = criarWorkers({
  conexao,
  filas,
  prefixo: config.filaPrefixo,
  log,
  nodeEnv: config.nodeEnv,
  handlers: config.nodeEnv === 'production'
    ? { ...handlersConsumidores, ...handlersWebhook, ...handlersEmail }
    : { ...handlersPadrao, ...handlersConsumidores, ...handlersWebhook, ...handlersEmail },
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
const enfileiradorWebhook = config.webhookAsaasHabilitado
  ? iniciarEnfileiradorWebhook({ pool, filas: filasPublicador, log, intervaloMs: config.outboxIntervaloMs })
  : null
const enfileiradorEmail = iniciarEnfileiradorEmail({
  pool,
  filas: filasPublicador,
  log,
  intervaloMs: config.outboxIntervaloMs,
  paradoHoras: config.emailParadoHoras
})
const tarefasDominio = iniciarTarefasDominio({
  pool,
  filas: filasPublicador,
  log,
  intervaloMs: config.dominioTarefasIntervaloMs
})

// Ordem: o publicador, os enfileiradores (webhook e e-mail) e o laço das tarefas de domínio param de criar jobs; `workers.close()` espera o job ativo terminar
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
      await enfileiradorWebhook?.close()
      await enfileiradorEmail.close()
      await tarefasDominio.close()
      await workers.close()
      await filas.close()
      // Com o Redis fora, o `close()` das filas do produtor pode falhar: a conexão
      // é derrubada de qualquer jeito.
      await filasPublicador.close().catch((erro) => log.warn({ erro: erro?.name }, 'falha ao fechar filas do publicador'))
      transporteEmail.close()
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
