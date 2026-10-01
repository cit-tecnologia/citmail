// Lê e valida a configuração de cada processo (API, worker e CLI da fila) a partir
// das variáveis de ambiente. Cada processo exige só o que usa (CIT-56).
// As mensagens de erro citam o nome da variável, nunca o valor.

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

// Configuração da API. `REDIS_URL` é opcional: sem ela não há fila nem rota de exemplo
// de job (a #64 a torna obrigatória em produção). Não lê Telegram.
export function carregarConfig(env = process.env) {
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
    ...lerFila(env)
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

// Configuração do worker: a da fila mais o Telegram (ADR 0011), obrigatório em produção.
// Só este processo recebe o token (menor privilégio).
export function carregarConfigWorker(env = process.env) {
  const config = carregarConfigFila(env)
  const telegramBotToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim() || undefined
  const telegramChatId = (env.TELEGRAM_CHAT_ID ?? '').trim() || undefined
  if (config.nodeEnv === 'production') {
    if (!telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN não definida')
    if (!telegramChatId) throw new Error('TELEGRAM_CHAT_ID não definida')
  }
  return { ...config, telegramBotToken, telegramChatId }
}
