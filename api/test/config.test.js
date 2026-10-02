import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carregarConfig, carregarConfigFila, carregarConfigWorker } from '../src/config.js';
import { construirApp } from '../src/app.js';
import { criarCapturaDeLog } from './auxiliares.js';

// `carregarConfig(env = process.env)`: aceita um objeto de ambiente
// explícito (conferido em `api/src/config.js`), então os testes abaixo não
// precisam mutar `process.env` global.

const AMBIENTE_BASE = {
  DATABASE_URL: 'postgres://postgres@127.0.0.1:55433/postgres',
  CORS_ORIGENS: 'http://127.0.0.1:4200',
  NODE_ENV: 'test',
};

const VALORES_CORS_INVALIDOS = ['*', '', 'http://127.0.0.1:4200,*'];

for (const corsOrigens of VALORES_CORS_INVALIDOS) {
  test(`CA5: carregarConfig lança erro com CORS_ORIGENS = ${JSON.stringify(corsOrigens)}`, () => {
    assert.throws(() => carregarConfig({ ...AMBIENTE_BASE, CORS_ORIGENS: corsOrigens }));
  });
}

test('CA5: carregarConfig lança erro sem DATABASE_URL', () => {
  const { DATABASE_URL: _descartado, ...ambienteSemBanco } = AMBIENTE_BASE;
  assert.throws(() => carregarConfig(ambienteSemBanco));
});

test('CA5: a mensagem de erro cita o nome da variável, não o valor do segredo', () => {
  const { DATABASE_URL: _descartado, ...ambienteSemBanco } = AMBIENTE_BASE;

  assert.throws(
    () => carregarConfig(ambienteSemBanco),
    (erro) => {
      assert.match(erro.message, /DATABASE_URL/);
      return true;
    },
  );
});

// Revisão: origem precisa ser exata (esquema://host[:porta], sem caminho nem
// barra final); `origemExata` usa `new URL(origem).origin === origem`.
const VALORES_CORS_SEM_ORIGEM_EXATA = [
  'null',
  '127.0.0.1:4200',
  'http://127.0.0.1:4200/painel',
  'http://127.0.0.1:4200/',
];

for (const origemInvalida of VALORES_CORS_SEM_ORIGEM_EXATA) {
  test(`Revisão: carregarConfig lança erro com CORS_ORIGENS não exata (${JSON.stringify(origemInvalida)})`, () => {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_BASE, CORS_ORIGENS: origemInvalida }),
      (erro) => {
        assert.equal(
          erro.message,
          'CORS_ORIGENS inválida: cada item deve ser uma origem exata (esquema://host[:porta], sem caminho nem barra final)',
        );
        return true;
      },
    );
  });
}

test('Revisão: NODE_ENV inválido lança erro com a lista de valores aceitos', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_BASE, NODE_ENV: 'homologacao' }),
    (erro) => {
      assert.equal(erro.message, 'NODE_ENV inválida: use production, development ou test');
      return true;
    },
  );
});

test('Revisão: NODE_ENV ausente vira "production" (falha fechada) e desativa POST /api/exemplos', async (t) => {
  const { NODE_ENV: _descartado, ...ambienteSemNodeEnv } = AMBIENTE_BASE;

  const config = carregarConfig(ambienteSemNodeEnv);
  assert.equal(config.nodeEnv, 'production');

  // Pool falso: o teste não usa /api/health, só confirma o efeito de
  // nodeEnv sobre o registro (ou não) da rota de exemplo.
  const poolFalso = { async query() { return { rows: [] }; }, on() {}, async end() {} };
  const captura = criarCapturaDeLog();
  const app = construirApp(config, { pool: poolFalso, logStream: captura.stream });
  t.after(() => app.close());

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/exemplos',
    payload: { titulo: 'Teste', quantidade: 2 },
  });

  assert.equal(resposta.statusCode, 404);
});

// CIT-56 (CA5): configuração por processo. `carregarConfig` ganha `redisUrl`
// (opcional) e os parâmetros da fila; `carregarConfigFila` (CLI) exige
// REDIS_URL em qualquer ambiente e não exige banco/CORS; `carregarConfigWorker`
// (worker) soma o Telegram, obrigatório só em produção.

const VALORES_FILA_TENTATIVAS_INVALIDOS = ['0', '21', '2.5', 'abc', '1e1', '0x10', ' 5'];
for (const valor of VALORES_FILA_TENTATIVAS_INVALIDOS) {
  test(`CA5: carregarConfig lança erro com FILA_TENTATIVAS = ${JSON.stringify(valor)}`, () => {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_BASE, FILA_TENTATIVAS: valor }),
      (erro) => { assert.match(erro.message, /FILA_TENTATIVAS/); return true; },
    );
  });
}

const VALORES_FILA_BACKOFF_MS_INVALIDOS = ['0', '-1', 'abc', '3600001', '1e3', '0x10'];
for (const valor of VALORES_FILA_BACKOFF_MS_INVALIDOS) {
  test(`CA5: carregarConfig lança erro com FILA_BACKOFF_MS = ${JSON.stringify(valor)}`, () => {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_BASE, FILA_BACKOFF_MS: valor }),
      (erro) => { assert.match(erro.message, /FILA_BACKOFF_MS/); return true; },
    );
  });
}

test('CA5: FILA_TENTATIVAS e FILA_BACKOFF_MS ausentes ou vazias usam os padrões (8 e 60000)', () => {
  const configAusente = carregarConfig(AMBIENTE_BASE);
  assert.equal(configAusente.filaTentativas, 8);
  assert.equal(configAusente.filaBackoffMs, 60000);

  const configVazia = carregarConfig({ ...AMBIENTE_BASE, FILA_TENTATIVAS: '', FILA_BACKOFF_MS: '' });
  assert.equal(configVazia.filaTentativas, 8);
  assert.equal(configVazia.filaBackoffMs, 60000);
});

test('CA5: FILA_PREFIXO com ":" lança erro citando a variável', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_BASE, FILA_PREFIXO: 'citmail:x' }),
    (erro) => { assert.match(erro.message, /FILA_PREFIXO/); return true; },
  );
});

test('CA5(a): carregarConfig aceita ambiente de produção sem REDIS_URL e sem Telegram (API não exige fila)', () => {
  const config = carregarConfig({ ...AMBIENTE_BASE, NODE_ENV: 'production' });
  assert.equal(config.redisUrl, undefined);
});

test('CA5(b): carregarConfigFila exige REDIS_URL mesmo sem DATABASE_URL/CORS_ORIGENS', () => {
  assert.throws(
    () => carregarConfigFila({ NODE_ENV: 'development' }),
    (erro) => { assert.match(erro.message, /REDIS_URL/); return true; },
  );
});

test('CA5(b): carregarConfigFila é válida com só REDIS_URL (sem banco nem CORS)', () => {
  const config = carregarConfigFila({ REDIS_URL: 'redis://127.0.0.1:56379' });
  assert.equal(config.redisUrl, 'redis://127.0.0.1:56379');
});

test('CA5(c): carregarConfigWorker em produção exige TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID', () => {
  assert.throws(
    () => carregarConfigWorker({ NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:56379', TELEGRAM_CHAT_ID: 'CHAT-FICTICIO' }),
    (erro) => { assert.match(erro.message, /TELEGRAM_BOT_TOKEN/); return true; },
  );
  assert.throws(
    () => carregarConfigWorker({ NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:56379', TELEGRAM_BOT_TOKEN: 'TOKEN-FICTICIO' }),
    (erro) => { assert.match(erro.message, /TELEGRAM_CHAT_ID/); return true; },
  );
});

test('CA5(c): carregarConfigWorker fora de produção é válida sem Telegram', () => {
  const config = carregarConfigWorker({ NODE_ENV: 'development', REDIS_URL: 'redis://127.0.0.1:56379' });
  assert.equal(config.telegramBotToken, undefined);
  assert.equal(config.telegramChatId, undefined);
});
