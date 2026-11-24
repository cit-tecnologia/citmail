// Lê e valida a configuração de cada processo (API, worker e CLI da fila) a partir
// das variáveis de ambiente. Cada processo exige só o que usa (CIT-56).
// As mensagens de erro citam o nome da variável, nunca o valor.

import { PRIVACIDADE_PROVISORIA, TERMOS_MINUTA } from './pedidos/aceite.js'

const AMBIENTES = ['production', 'development', 'test']

function origemExata(origem) {
  try {
    return new URL(origem).origin === origem
  } catch {
    return false
  }
}

// Ausente vira production (falha fechada): nada de rota de desenvolvimento por esquecimento.
function lerNodeEnv(env) {
  const nodeEnv = env.NODE_ENV || 'production'
  if (!AMBIENTES.includes(nodeEnv)) {
    throw new Error('NODE_ENV inválida: use production, development ou test')
  }
  return nodeEnv
}

// Inteiro positivo dentro da faixa; ausente ou vazio vira o padrão. A regex vem antes
// da conversão: `Number()` aceitaria '1e1', '0x10' e ' 5'.
function lerInteiro(env, nome, padrao, minimo, maximo) {
  const valor = env[nome]
  if (valor === undefined || valor === '') return padrao
  if (!/^\d+$/.test(valor)) {
    throw new Error(`${nome} inválida: use um inteiro entre ${minimo} e ${maximo}`)
  }
  const numero = Number(valor)
  if (numero < minimo || numero > maximo) {
    throw new Error(`${nome} inválida: use um inteiro entre ${minimo} e ${maximo}`)
  }
  return numero
}

// Parâmetros da fila (ADR 0005). O prefixo separa ambientes no mesmo Redis (ADR 0006)
// e não aceita `:`, que o BullMQ usa como separador das chaves.
function lerFila(env) {
  const filaPrefixo = env.FILA_PREFIXO || 'citmail'
  if (!/^[a-z0-9-]+$/.test(filaPrefixo)) {
    throw new Error('FILA_PREFIXO inválida: use só letras minúsculas, dígitos e hífen')
  }
  return {
    redisUrl: (env.REDIS_URL ?? '').trim() || undefined,
    filaPrefixo,
    filaTentativas: lerInteiro(env, 'FILA_TENTATIVAS', 8, 1, 20),
    filaBackoffMs: lerInteiro(env, 'FILA_BACKOFF_MS', 60000, 1, 3600000)
  }
}

function lerBooleano(env, nome, padrao) {
  const valor = env[nome]
  if (valor === undefined || valor === '') return padrao
  if (valor === 'true') return true
  if (valor === 'false') return false
  throw new Error(`${nome} inválida: use true ou false`)
}

// Pedido no Asaas (ADR 0014; CIT-61). A rota nasce desligada em produção até o aceite
// (#62) e o limite de taxa (E6-H4). Ligada em produção, chave e URL são obrigatórias, e
// a URL só pode ser `https://` num dos hosts do Asaas; fora dela, chave sem URL é erro
// (sem URL padrão que aponte para produção).
// Termos em minuta ou Política com rótulo provisório (CIT-62): ligada em produção, a API
// não sobe, salvo com a liberação explícita `TERMOS_MINUTA_ACEITA=true`, só para a
// homologação (a partida loga `warn`, app.js). A produção real nunca a usa.
// `TERMOS_MINUTA_ACEITA` é validada sempre, mesmo sem uso.
const HOSTS_ASAAS = ['api.asaas.com', 'api-sandbox.asaas.com']

// Chave, URL e timeout do Asaas, com a mesma validação na API (pedidos) e no worker
// (webhook, CIT-64). `obrigatorio`: em produção, chave e URL não podem faltar.
function lerCredenciaisAsaas(env, producao, obrigatorio) {
  const asaasApiKey = (env.ASAAS_API_KEY ?? '').trim() || undefined
  const asaasBaseUrl = (env.ASAAS_BASE_URL ?? '').trim() || undefined
  const asaasTimeoutMs = lerInteiro(env, 'ASAAS_TIMEOUT_MS', 10000, 1000, 30000)

  if (obrigatorio && producao) {
    if (!asaasApiKey) throw new Error('ASAAS_API_KEY não definida')
    if (!asaasBaseUrl) throw new Error('ASAAS_BASE_URL não definida')
  }
  if (asaasApiKey && !asaasBaseUrl) {
    throw new Error('ASAAS_BASE_URL não definida: obrigatória com ASAAS_API_KEY')
  }
  if (asaasBaseUrl) {
    let url
    try {
      url = new URL(asaasBaseUrl)
    } catch {
      throw new Error('ASAAS_BASE_URL inválida: informe uma URL')
    }
    if (producao ? url.protocol !== 'https:' : !['https:', 'http:'].includes(url.protocol)) {
      throw new Error(producao ? 'ASAAS_BASE_URL inválida: use https://' : 'ASAAS_BASE_URL inválida: use http:// ou https://')
    }
    // `url.host` inclui a porta: porta explícita ou credencial na URL também são recusadas.
    if (producao && (!HOSTS_ASAAS.includes(url.host) || url.username || url.password)) {
      throw new Error(`ASAAS_BASE_URL inválida: em produção, use o host ${HOSTS_ASAAS.join(' ou ')}`)
    }
  }
  return { asaasApiKey, asaasBaseUrl, asaasTimeoutMs }
}

function lerAsaas(env, nodeEnv, termosMinuta, privacidadeProvisoria) {
  const producao = nodeEnv === 'production'
  const pedidosHabilitado = lerBooleano(env, 'PEDIDOS_HABILITADO', !producao)
  const termosMinutaAceita = lerBooleano(env, 'TERMOS_MINUTA_ACEITA', false)
  const { asaasApiKey, asaasBaseUrl, asaasTimeoutMs } = lerCredenciaisAsaas(env, producao, pedidosHabilitado)

  const aceiteProvisorio = pedidosHabilitado && producao && (termosMinuta === true || privacidadeProvisoria === true)
  if (aceiteProvisorio && !termosMinutaAceita) {
    throw new Error(
      'PEDIDOS_HABILITADO recusada em produção: termos de uso em minuta ou política de privacidade provisória; ' +
      'TERMOS_MINUTA_ACEITA=true só em homologação (CIT-62)'
    )
  }
  // Liberação em uso: a partida loga `warn` (app.js).
  const aceiteLiberado = aceiteProvisorio && termosMinutaAceita
  return { pedidosHabilitado, asaasApiKey, asaasBaseUrl, asaasTimeoutMs, aceiteLiberado }
}

// Webhook do Asaas na API (ADR 0015; CIT-64). A rota nasce desligada em produção e
// ligada fora dela. Ligada em produção, `ASAAS_WEBHOOK_TOKEN` é obrigatório, com ao
// menos 32 caracteres; fora dela, sem token, a rota responde 503. Só a API recebe o token.
const TOKEN_WEBHOOK_MIN = 32

function lerWebhook(env, nodeEnv) {
  const producao = nodeEnv === 'production'
  const webhookAsaasHabilitado = lerBooleano(env, 'WEBHOOK_ASAAS_HABILITADO', !producao)
  const asaasWebhookToken = (env.ASAAS_WEBHOOK_TOKEN ?? '').trim() || undefined
  if (webhookAsaasHabilitado && producao) {
    if (!asaasWebhookToken) throw new Error('ASAAS_WEBHOOK_TOKEN não definida')
    if (asaasWebhookToken.length < TOKEN_WEBHOOK_MIN) {
      throw new Error(`ASAAS_WEBHOOK_TOKEN inválida: use ao menos ${TOKEN_WEBHOOK_MIN} caracteres`)
    }
  }
  return { webhookAsaasHabilitado, asaasWebhookToken }
}

// E-mail transacional no worker (ADR 0010; CIT-65). `EMAIL_TRANSPORTE` nasce `desligado`
// em todos os ambientes até haver credencial (#57): o job grava `nao_enviado` (em produção,
// a partida do worker loga `warn`). `smtp` exige host, usuário e senha; exige TLS
// (`requireTLS`) sempre que o host não for de loopback, e em produção recusa host de loopback. Remetente e Reply-To não aceitam
// caractere de controle (CR/LF quebrariam o cabeçalho).
const TRANSPORTES_EMAIL = ['desligado', 'smtp']
const REMETENTE_PADRAO = 'CITMail <naoresponda@citmail.com.br>'
// eslint-disable-next-line no-control-regex -- recusar caractere de controle é o objetivo
const CONTROLE = /[\u0000-\u001f\u007f]/

// Loopback ou endereço não especificado, nas formas que o resolvedor aceita: `localhost`
// (e `*.localhost`), IPv4 127/8 abreviado (`127.1`) ou não, `0`/`0.0.0.0`, IPv6 `::1` e
// `::` por extenso ou não e o IPv4 mapeado (`::ffff:127.0.0.1`). O `URL` normaliza as formas.
function hostLoopback(host) {
  let normalizado
  try {
    normalizado = new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (normalizado === 'localhost' || normalizado.endsWith('.localhost')) return true
  if (/^127\.\d+\.\d+\.\d+$/.test(normalizado) || normalizado === '0.0.0.0') return true
  if (normalizado === '[::1]' || normalizado === '[::]') return true
  // IPv4 mapeado em IPv6: o `URL` o escreve em hexadecimal (`[::ffff:7f00:1]`).
  const mapeado = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(normalizado)
  if (mapeado) return mapeado[1].padStart(4, '0').startsWith('7f') || /^0{1,4}$/.test(mapeado[1])
  return false
}

function lerEnderecoEmail(env, nome, padrao) {
  const valor = (env[nome] ?? '').trim()
  if (!valor) return padrao
  if (CONTROLE.test(valor)) throw new Error(`${nome} inválida: sem quebra de linha nem caractere de controle`)
  if (!valor.includes('@')) throw new Error(`${nome} inválida: informe um endereço de e-mail`)
  return valor
}

function lerEmail(env, nodeEnv) {
  const producao = nodeEnv === 'production'
  const emailTransporte = (env.EMAIL_TRANSPORTE ?? '').trim() || 'desligado'
  if (!TRANSPORTES_EMAIL.includes(emailTransporte)) {
    throw new Error(`EMAIL_TRANSPORTE inválida: use ${TRANSPORTES_EMAIL.join(' ou ')}`)
  }
  const email = {
    emailTransporte,
    emailRemetente: lerEnderecoEmail(env, 'EMAIL_REMETENTE', REMETENTE_PADRAO),
    emailResponderPara: lerEnderecoEmail(env, 'EMAIL_RESPONDER_PARA', undefined),
    emailParadoHoras: lerInteiro(env, 'EMAIL_PARADO_HORAS', 6, 1, 72)
  }
  if (emailTransporte !== 'smtp') return email

  const smtpHost = (env.SMTP_HOST ?? '').trim()
  if (!smtpHost) throw new Error('SMTP_HOST não definida')
  const smtpUsuario = (env.SMTP_USUARIO ?? '').trim()
  if (!smtpUsuario) throw new Error('SMTP_USUARIO não definida')
  const smtpSenha = env.SMTP_SENHA ?? ''
  if (!smtpSenha) throw new Error('SMTP_SENHA não definida')
  if (producao && hostLoopback(smtpHost)) {
    throw new Error('SMTP_HOST inválida: em produção, use um host fora do loopback')
  }
  return {
    ...email,
    smtpHost,
    smtpPorta: lerInteiro(env, 'SMTP_PORTA', 587, 1, 65535),
    smtpUsuario,
    smtpSenha,
    smtpTimeoutMs: lerInteiro(env, 'SMTP_TIMEOUT_MS', 10000, 1000, 60000),
    // TLS exigido em todo host fora do loopback (a senha nunca sai em claro pela rede).
    smtpRequireTls: !hostLoopback(smtpHost)
  }
}

// Configuração da API. `REDIS_URL` é opcional: sem ela não há fila nem rota de exemplo
// de job. A API não usa o Redis em produção: o webhook do Asaas (CIT-64) só grava no
// banco, e quem enfileira é o worker. Não lê Telegram. `termosMinuta` e
// `privacidadeProvisoria` são injetáveis para os testes (padrão: as constantes de
// pedidos/aceite.js).
export function carregarConfig(
  env = process.env,
  { termosMinuta = TERMOS_MINUTA, privacidadeProvisoria = PRIVACIDADE_PROVISORIA } = {}
) {
  const databaseUrl = (env.DATABASE_URL ?? '').trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não definida')
  }

  const corsOrigens = (env.CORS_ORIGENS ?? '')
    .split(',')
    .map((origem) => origem.trim())
    .filter(Boolean)
  if (corsOrigens.length === 0) {
    throw new Error('CORS_ORIGENS vazia: informe a lista exata de origens permitidas')
  }
  if (corsOrigens.some((origem) => origem.includes('*'))) {
    throw new Error('CORS_ORIGENS não aceita curinga (*): informe as origens exatas')
  }
  if (!corsOrigens.every(origemExata)) {
    throw new Error('CORS_ORIGENS inválida: cada item deve ser uma origem exata (esquema://host[:porta], sem caminho nem barra final)')
  }

  const nodeEnv = lerNodeEnv(env)

  const porta = Number(env.PORT || 3000)
  if (!Number.isInteger(porta) || porta < 0 || porta > 65535) {
    throw new Error('PORT inválida')
  }

  return {
    databaseUrl,
    host: env.HOST || '127.0.0.1',
    port: porta,
    corsOrigens,
    logLevel: env.LOG_LEVEL || 'info',
    nodeEnv,
    ...lerFila(env),
    ...lerAsaas(env, nodeEnv, termosMinuta, privacidadeProvisoria),
    ...lerWebhook(env, nodeEnv)
  }
}

// Configuração da CLI de reprocessamento: só Redis e fila (sem banco nem CORS).
export function carregarConfigFila(env = process.env) {
  const nodeEnv = lerNodeEnv(env)
  const fila = lerFila(env)
  if (!fila.redisUrl) {
    throw new Error('REDIS_URL não definida')
  }
  return { nodeEnv, logLevel: env.LOG_LEVEL || 'info', ...fila }
}

// Configuração da CLI de tarefas de domínio (CIT-77, `npm run dominio`): só o banco (sem
// CORS, Redis nem Telegram). Mesmo `DATABASE_URL` da aplicação.
export function carregarConfigBanco(env = process.env) {
  const nodeEnv = lerNodeEnv(env)
  const databaseUrl = (env.DATABASE_URL ?? '').trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não definida')
  }
  return { nodeEnv, logLevel: env.LOG_LEVEL || 'info', databaseUrl }
}

// Configuração do worker: a da fila, o banco (outbox de eventos, CIT-166) e o Telegram
// (ADR 0011), obrigatório em produção. Só este processo recebe o token (menor privilégio).
// Com `WEBHOOK_ASAAS_HABILITADO` (mesmo padrão da API), lê também chave, URL e timeout do
// Asaas (conferência do pagamento, CIT-64), obrigatórios em produção; nunca o token do webhook.
// Lê também o transporte e o remetente do e-mail transacional (CIT-65, `lerEmail`) e o
// intervalo do laço das tarefas de domínio (CIT-77, `DOMINIO_TAREFAS_INTERVALO_MS`).
export function carregarConfigWorker(env = process.env) {
  const config = carregarConfigFila(env)
  const databaseUrl = (env.DATABASE_URL ?? '').trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não definida')
  }
  const outboxIntervaloMs = lerInteiro(env, 'OUTBOX_INTERVALO_MS', 2000, 100, 60000)
  const dominioTarefasIntervaloMs = lerInteiro(env, 'DOMINIO_TAREFAS_INTERVALO_MS', 300000, 60000, 3600000)
  const telegramBotToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim() || undefined
  const telegramChatId = (env.TELEGRAM_CHAT_ID ?? '').trim() || undefined
  if (config.nodeEnv === 'production') {
    if (!telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN não definida')
    if (!telegramChatId) throw new Error('TELEGRAM_CHAT_ID não definida')
  }
  const webhookAsaasHabilitado = lerBooleano(env, 'WEBHOOK_ASAAS_HABILITADO', config.nodeEnv !== 'production')
  const asaas = webhookAsaasHabilitado ? lerCredenciaisAsaas(env, config.nodeEnv === 'production', true) : {}
  return {
    ...config, databaseUrl, outboxIntervaloMs, dominioTarefasIntervaloMs, telegramBotToken, telegramChatId,
    webhookAsaasHabilitado, ...asaas,
    ...lerEmail(env, config.nodeEnv)
  }
}
