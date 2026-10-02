// Fixture de processo filho para o CA4(b) (`../fila.test.js`): um worker
// isolado, fora do processo de teste, com `lockDuration`/`stalledInterval`
// curtos para que um "stalled" apareça rápido quando o processo é morto com
// SIGKILL. Usa só o Redis e o prefixo de teste recebidos por variável de
// ambiente (a mesma fila que o teste criou via `criarFilasTeste()`); nunca os
// de produção. Sem encerramento gracioso de propósito: o teste mata este
// processo com SIGKILL, não com SIGTERM (isso é o CA6, em `worker.js`).
import pino from 'pino';
import { criarConexaoWorker } from '../../src/fila/conexao.js';
import { criarFilas } from '../../src/fila/filas.js';
import { criarWorkers } from '../../src/fila/worker.js';
import { jobExemplo } from '../../src/jobs/exemplo.js';

// Qualquer arquivo sob `test/` é descoberto pelo `node --test` (não só
// `*.test.js`), então este fixture também roda sozinho, sem as variáveis do
// `spawn` de `../fila.test.js`. Sai 0 (não é um teste; nada para afirmar) em
// vez de 1, para não aparecer como "test failed" na suíte inteira.
const redisUrl = process.env.REDIS_URL;
const prefixo = process.env.FILA_PREFIXO;

if (!redisUrl || !prefixo) {
  console.log('worker-filho: fixture do CA4(b), não roda fora do spawn de fila.test.js (faltam REDIS_URL/FILA_PREFIXO)');
  process.exit(0);
}

const log = pino({ level: 'info' });
const conexao = criarConexaoWorker(redisUrl);
const filas = criarFilas({ conexao, prefixo, tentativas: 3, backoffMs: 300, log });

criarWorkers({
  conexao,
  filas,
  prefixo,
  log,
  handlers: { exemplo: jobExemplo },
  enviarAlerta: async () => {},
  opcoesWorker: { lockDuration: 1000, stalledInterval: 500 },
});
