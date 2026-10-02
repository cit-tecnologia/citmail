// Conexões com o Redis da fila (ADR 0005), separadas por papel (CIT-56).
// O BullMQ 6 não carrega o `ioredis` sozinho em ESM: a conexão é sempre criada aqui
// e passada pronta a `Queue` e `Worker`.
import { Redis } from 'ioredis'

// Worker: `maxRetriesPerRequest: null` (exigido pelo `Worker` do BullMQ); com o Redis
// fora, os comandos esperam a reconexão em vez de falhar.
export function criarConexaoWorker(redisUrl) {
  return new Redis(redisUrl, { maxRetriesPerRequest: null })
}

// Produtor (API e CLI): com o Redis fora, o comando falha em vez de ficar em memória
// esperando a reconexão. O limite de tempo da resposta fica na rota (`Promise.race`).
export function criarConexaoProdutor(redisUrl) {
  return new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000 })
}
