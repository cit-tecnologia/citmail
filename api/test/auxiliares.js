// Auxiliares da suíte da API: banco de teste temporário (criado e removido
// por teste), migrações programáticas e fábrica do app de teste via
// `construirApp(config, { pool, logStream })`.
//
// Contrato conferido em `api/src/config.js` e `api/src/app.js` (código já
// escrito pelo executor em paralelo a este arquivo): `carregarConfig(env =
// process.env)` devolve `{ databaseUrl, host, port, corsOrigens (array),
// logLevel, nodeEnv }`; `construirApp(config, { pool, logStream })` cria seu
// próprio `pg.Pool` a partir de `config.databaseUrl` (via `criarPool` de
// `banco.js`) quando `pool` não é passado, e só fecha (`onClose`) o pool que
// ele mesmo criou — por isso `fechar()` abaixo só chama `pool.end()` quando
// foi este arquivo que criou o pool (`comBanco: true` sem override).

import { Client, Pool } from 'pg';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { construirApp } from '../src/app.js';
import { criarLogger } from '../src/log.js';
import { criarConexaoWorker } from '../src/fila/conexao.js';
import { criarFilas } from '../src/fila/filas.js';
import { criarWorkers } from '../src/fila/worker.js';
import { criarEnvioTelegram } from '../src/alertas/telegram.js';

export const URL_ADMIN_TESTE_PADRAO = 'postgres://postgres@127.0.0.1:55433/postgres';

let contadorBancos = 0;

export function urlAdminTeste() {
  return process.env.DATABASE_URL_TESTE ?? URL_ADMIN_TESTE_PADRAO;
}

function urlComBanco(urlBase, nomeBanco) {
  const url = new URL(urlBase);
  url.pathname = `/${nomeBanco}`;
  return url.toString();
}

/**
 * Cria um banco de dados novo e vazio no Postgres de teste, com nome único
 * por processo e por chamada (`citmail_teste_<pid>_<n>`).
 */
export async function criarBancoTemporario() {
  const urlBase = urlAdminTeste();
  const nomeBanco = `citmail_teste_${process.pid}_${contadorBancos++}`;

  const cliente = new Client({ connectionString: urlBase });
  await cliente.connect();
  try {
    await cliente.query(`CREATE DATABASE "${nomeBanco}"`);
  } finally {
    await cliente.end();
  }

  return { nomeBanco, url: urlComBanco(urlBase, nomeBanco) };
}

/**
 * Encerra conexões pendentes e apaga o banco temporário. Idempotente.
 */
export async function removerBancoTemporario(nomeBanco) {
  if (!nomeBanco) return;

  const cliente = new Client({ connectionString: urlAdminTeste() });
  await cliente.connect();
  try {
    await cliente.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [nomeBanco],
    );
    await cliente.query(`DROP DATABASE IF EXISTS "${nomeBanco}"`);
  } finally {
    await cliente.end();
  }
}

/**
 * Roda as migrações do `node-pg-migrate` programaticamente contra `url`.
 * Assinatura conferida em `node_modules/node-pg-migrate/dist/bundle/index.js`
 * (v9.0.0, `export { ..., runner }`, named export): `databaseUrl`, `dir`,
 * `direction`, `count`, `migrationsTable`, `checkOrder`, `log` (função) são
 * opções válidas.
 */
export async function aplicarMigracoes(url, direcao = 'up', quantidade = Infinity) {
  // `fileURLToPath` (não `new URL(...).pathname`) para funcionar também no
  // Windows, onde `pathname` de uma `file:` URL traz uma barra inicial
  // espúria antes da letra da unidade (ex.: "/C:/...").
  const diretorioMigracoes = fileURLToPath(new URL('../migrations', import.meta.url));

  return runner({
    databaseUrl: url,
    dir: diretorioMigracoes,
    direction: direcao,
    count: quantidade,
    migrationsTable: 'pgmigrations',
    checkOrder: false,
    log: () => {},
  });
}

/**
 * Stream de destino para o logger `pino` do app de teste. Acumula as linhas
 * (NDJSON) e expõe `linhas()` já convertidas em objetos, para asserções sobre
 * `reqId`, nível e máscara de campos sensíveis (CA8), e `texto()` com o
 * NDJSON bruto, para asserções de ausência de valores sensíveis e para
 * conferir duplicidade de chave numa linha específica (CIT-55, CA1/CA2/CA3).
 */
export function criarCapturaDeLog() {
  const pedacosBrutos = [];

  const stream = new Writable({
    write(pedaco, _codificacao, callback) {
      pedacosBrutos.push(pedaco.toString('utf8'));
      callback();
    },
  });

  return {
    stream,
    linhas() {
      return pedacosBrutos
        .join('')
        .split('\n')
        .map((linha) => linha.trim())
        .filter(Boolean)
        .map((linha) => JSON.parse(linha));
    },
    texto() {
      return pedacosBrutos.join('');
    },
  };
}

export function criarConfigTeste(sobrescritas = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: urlAdminTeste(),
    corsOrigens: ['http://127.0.0.1:4200'],
    logLevel: 'info',
    nodeEnv: 'test',
    ...sobrescritas,
  };
}

/**
 * Monta um app de teste completo.
 *
 * Opções:
 * - `comBanco` (padrão `true`): cria um banco temporário, aplica as
 *   migrações e cria um `pg.Pool` real apontando para ele.
 * - `pool`: substitui o pool acima (ou o que `construirApp` criaria a partir
 *   de `config.databaseUrl`) por um objeto fornecido pelo teste (mock).
 * - `sobrescritasConfig`: mescladas por cima da config padrão de teste
 *   (ex.: `databaseUrl` apontando para uma porta inacessível, no CA2).
 *
 * Devolve `{ app, pool, captura, fechar }`; `fechar()` encerra o app, o pool
 * (quando criado aqui) e remove o banco temporário (quando criado aqui).
 */
export async function construirAppTeste(opcoes = {}) {
  const { comBanco = true, sobrescritasConfig = {}, pool: poolFornecido } = opcoes;

  let nomeBanco;
  let url;
  let pool = poolFornecido;

  if (comBanco) {
    ({ nomeBanco, url } = await criarBancoTemporario());
    await aplicarMigracoes(url);
    pool = poolFornecido ?? new Pool({ connectionString: url, max: 5 });
  }

  const captura = criarCapturaDeLog();
  const config = criarConfigTeste({
    ...(url ? { databaseUrl: url } : {}),
    ...sobrescritasConfig,
  });

  const app = construirApp(config, { pool, logStream: captura.stream });

  return {
    app,
    pool,
    captura,
    async fechar() {
      await app.close();
      if (pool && !poolFornecido && typeof pool.end === 'function') {
        await pool.end();
      }
      if (nomeBanco) {
        await removerBancoTemporario(nomeBanco);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fila (CIT-56): Redis de teste no loopback, prefixo único por chamada.
// ---------------------------------------------------------------------------

export const URL_REDIS_TESTE_PADRAO = 'redis://127.0.0.1:56379';

let contadorFilas = 0;

export function urlRedisTeste() {
  return process.env.REDIS_URL_TESTE ?? URL_REDIS_TESTE_PADRAO;
}

/**
 * Cria as filas `jobs` e `alertas` com prefixo único (`teste-<pid>-<n>`) sobre
 * uma conexão de worker com o Redis de teste, e um logger `pino` (mesma máscara
 * do app, `criarLogger`) que escreve numa `criarCapturaDeLog()`.
 *
 * Opções (padrões de teste do plano): `tentativas` 3, `backoffMs` 300,
 * `alertaTentativas` 3, `alertaBackoffMs` 20, `logLevel` 'info'.
 *
 * Devolve `{ prefixo, conexao, filas, captura, log, criarWorkers, acompanhar, fechar }`:
 * - `criarWorkers(opcoes)`: chama `criarWorkers` de `src/fila/worker.js` com
 *   `conexao`, `filas`, `prefixo` e `log` já preenchidos (sobrescrevíveis);
 *   `enviarAlerta` padrão = Telegram sem token (só loga `alerta sem telegram`).
 *   Os workers criados são fechados pelo `fechar()`.
 * - `acompanhar(objeto)`: registra outro objeto com `close()` (ex.: `Worker`
 *   criado à mão) para ser fechado antes do `obliterate`.
 * - `fechar()`: fecha workers → `obliterate({ force: true })` das filas → fecha
 *   as filas → confere por `SCAN` as chaves `<prefixo>:*` que sobraram → fecha a
 *   conexão. Chaves com `PTTL > 0` (expiram sozinhas) são aceitas e apagadas;
 *   chave sem TTL (`PTTL -1`) é apagada e faz o `fechar()` lançar (CA7).
 *   Conferido no BullMQ 6.3.11: após o `obliterate` não sobra chave no prefixo.
 *
 * Filas sobre conexão inacessível (CA8, porta 1) não usam este auxiliar.
 */
export function criarFilasTeste(opcoes = {}) {
  const {
    tentativas = 3,
    backoffMs = 300,
    alertaTentativas = 3,
    alertaBackoffMs = 20,
    logLevel = 'info',
  } = opcoes;

  const prefixo = `teste-${process.pid}-${contadorFilas++}`;
  const conexao = criarConexaoWorker(urlRedisTeste());
  const captura = criarCapturaDeLog();
  const log = criarLogger({ level: logLevel, stream: captura.stream });
  const filas = criarFilas({ conexao, prefixo, tentativas, backoffMs, alertaTentativas, alertaBackoffMs, log });
  const acompanhados = [];

  return {
    prefixo,
    conexao,
    filas,
    captura,
    log,
    criarWorkers(opcoesWorkers = {}) {
      const workers = criarWorkers({
        conexao,
        filas,
        prefixo,
        log,
        enviarAlerta: criarEnvioTelegram({ log }),
        ...opcoesWorkers,
      });
      acompanhados.push(workers);
      return workers;
    },
    acompanhar(objeto) {
      acompanhados.push(objeto);
      return objeto;
    },
    async fechar() {
      try {
        for (const objeto of acompanhados.reverse()) {
          await objeto.close();
        }
        await filas.jobs.obliterate({ force: true });
        await filas.alertas.obliterate({ force: true });
        await filas.close();

        const permanentes = [];
        let cursor = '0';
        do {
          const [proximo, chaves] = await conexao.scan(cursor, 'MATCH', `${prefixo}:*`, 'COUNT', 1000);
          cursor = proximo;
          for (const chave of chaves) {
            if ((await conexao.pttl(chave)) === -1) permanentes.push(chave);
            await conexao.del(chave);
          }
        } while (cursor !== '0');

        if (permanentes.length > 0) {
          throw new Error(`chaves sem TTL no prefixo ${prefixo}: ${permanentes.join(', ')}`);
        }
      } finally {
        await conexao.quit().catch(() => conexao.disconnect());
      }
    },
  };
}
