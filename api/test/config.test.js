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

// CIT-166 (CA6): o worker passa a ler o banco (outbox); DATABASE_URL é conferida
// depois de REDIS_URL e OUTBOX_INTERVALO_MS tem faixa 100-60000.
const AMBIENTE_WORKER = {
  REDIS_URL: 'redis://127.0.0.1:56379',
  DATABASE_URL: 'postgres://postgres:SENHA-FICTICIA@127.0.0.1:55433/postgres',
};

test('CA6: carregarConfigWorker sem DATABASE_URL lança erro citando o nome, sem o valor do segredo', () => {
  const { DATABASE_URL: _descartado, ...semBanco } = AMBIENTE_WORKER;
  assert.throws(
    () => carregarConfigWorker({ ...semBanco, NODE_ENV: 'development' }),
    (erro) => {
      assert.match(erro.message, /DATABASE_URL não definida/);
      assert.ok(!erro.message.includes('SENHA-FICTICIA'));
      return true;
    },
  );
});

test('CA6: carregarConfigWorker confere REDIS_URL antes de DATABASE_URL', () => {
  assert.throws(
    () => carregarConfigWorker({ NODE_ENV: 'development' }),
    (erro) => { assert.match(erro.message, /REDIS_URL/); return true; },
  );
});

test('CA6: carregarConfigWorker lê DATABASE_URL e usa 2000 em OUTBOX_INTERVALO_MS ausente ou vazia', () => {
  const ausente = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development' });
  assert.equal(ausente.databaseUrl, AMBIENTE_WORKER.DATABASE_URL);
  assert.equal(ausente.outboxIntervaloMs, 2000);
  const vazia = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', OUTBOX_INTERVALO_MS: '' });
  assert.equal(vazia.outboxIntervaloMs, 2000);
});

test('CA6: carregarConfigWorker aceita OUTBOX_INTERVALO_MS nos limites 100 e 60000', () => {
  for (const valor of ['100', '60000']) {
    const config = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', OUTBOX_INTERVALO_MS: valor });
    assert.equal(config.outboxIntervaloMs, Number(valor));
  }
});

for (const valor of ['99', '60001', '1e3', 'abc']) {
  test(`CA6: carregarConfigWorker lança erro citando OUTBOX_INTERVALO_MS com ${JSON.stringify(valor)}`, () => {
    assert.throws(
      () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', OUTBOX_INTERVALO_MS: valor }),
      (erro) => { assert.match(erro.message, /OUTBOX_INTERVALO_MS/); return true; },
    );
  });
}

test('CA5(c): carregarConfigWorker em produção exige TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID', () => {
  assert.throws(
    () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'production', TELEGRAM_CHAT_ID: 'CHAT-FICTICIO' }),
    (erro) => { assert.match(erro.message, /TELEGRAM_BOT_TOKEN/); return true; },
  );
  assert.throws(
    () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'production', TELEGRAM_BOT_TOKEN: 'TOKEN-FICTICIO' }),
    (erro) => { assert.match(erro.message, /TELEGRAM_CHAT_ID/); return true; },
  );
});

test('CA5(c): carregarConfigWorker fora de produção é válida sem Telegram', () => {
  const config = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development' });
  assert.equal(config.telegramBotToken, undefined);
  assert.equal(config.telegramChatId, undefined);
});

// CIT-61 (CA16): pedido no Asaas. `PEDIDOS_HABILITADO` nasce desligada em produção;
// ligada, exige chave e URL https; `ASAAS_TIMEOUT_MS` tem faixa 1000-30000.
const AMBIENTE_PRODUCAO = { ...AMBIENTE_BASE, NODE_ENV: 'production' };
const AMBIENTE_ASAAS = {
  PEDIDOS_HABILITADO: 'true',
  ASAAS_API_KEY: 'CHAVE-FICTICIA-ASAAS',
  ASAAS_BASE_URL: 'https://asaas.exemplo.test/v3',
};

test('CA16: PEDIDOS_HABILITADO ausente é false em produção e true fora dela', () => {
  assert.equal(carregarConfig(AMBIENTE_PRODUCAO).pedidosHabilitado, false);
  assert.equal(carregarConfig({ ...AMBIENTE_BASE, NODE_ENV: 'development' }).pedidosHabilitado, true);
  assert.equal(carregarConfig(AMBIENTE_BASE).pedidosHabilitado, true);
});

test('CA16: PEDIDOS_HABILITADO vazia usa o padrão do ambiente', () => {
  assert.equal(carregarConfig({ ...AMBIENTE_PRODUCAO, PEDIDOS_HABILITADO: '' }).pedidosHabilitado, false);
});

test('CA16: PEDIDOS_HABILITADO=sim lança erro citando a variável', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_BASE, PEDIDOS_HABILITADO: 'sim' }),
    (erro) => { assert.match(erro.message, /PEDIDOS_HABILITADO/); return true; },
  );
});

test('CA16: PEDIDOS_HABILITADO=false desliga a rota também fora de produção', () => {
  assert.equal(carregarConfig({ ...AMBIENTE_BASE, PEDIDOS_HABILITADO: 'false' }).pedidosHabilitado, false);
});

test('CA16: produção sem PEDIDOS_HABILITADO carrega sem chave nem URL do Asaas', () => {
  const config = carregarConfig(AMBIENTE_PRODUCAO);
  assert.equal(config.asaasApiKey, undefined);
  assert.equal(config.asaasBaseUrl, undefined);
});

test('CA16: produção com PEDIDOS_HABILITADO=true, chave e URL https carrega e expõe a configuração', () => {
  const config = carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS });
  assert.equal(config.pedidosHabilitado, true);
  assert.equal(config.asaasApiKey, 'CHAVE-FICTICIA-ASAAS');
  assert.equal(config.asaasBaseUrl, 'https://asaas.exemplo.test/v3');
  assert.equal(config.asaasTimeoutMs, 10000);
});

test('CA16: produção com PEDIDOS_HABILITADO=true sem ASAAS_API_KEY lança erro citando o nome', () => {
  const { ASAAS_API_KEY: _descartada, ...semChave } = AMBIENTE_ASAAS;
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...semChave }),
    (erro) => { assert.match(erro.message, /ASAAS_API_KEY/); return true; },
  );
});

test('CA16: produção com PEDIDOS_HABILITADO=true sem ASAAS_BASE_URL lança erro citando o nome', () => {
  const { ASAAS_BASE_URL: _descartada, ...semUrl } = AMBIENTE_ASAAS;
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...semUrl }),
    (erro) => { assert.match(erro.message, /ASAAS_BASE_URL/); return true; },
  );
});

test('CA16: produção com ASAAS_BASE_URL http:// lança erro citando o nome, sem o valor', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS, ASAAS_BASE_URL: 'http://asaas-ficticio.exemplo.test/v3' }),
    (erro) => {
      assert.match(erro.message, /ASAAS_BASE_URL/);
      assert.ok(!erro.message.includes('asaas-ficticio'));
      return true;
    },
  );
});

test('CA16: produção com a rota desligada também recusa ASAAS_BASE_URL http:// (valor nunca usado fora do https)', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_PRODUCAO, PEDIDOS_HABILITADO: 'false', ASAAS_API_KEY: 'CHAVE-FICTICIA-ASAAS', ASAAS_BASE_URL: 'http://asaas.exemplo.test' }),
    (erro) => { assert.match(erro.message, /ASAAS_BASE_URL/); return true; },
  );
});

test('CA16: ASAAS_BASE_URL que não é URL lança erro citando o nome', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_BASE, ASAAS_BASE_URL: 'isto não é url' }),
    (erro) => { assert.match(erro.message, /ASAAS_BASE_URL/); return true; },
  );
});

test('CA16: fora de produção, ASAAS_API_KEY sem ASAAS_BASE_URL lança erro na partida sem o valor da chave', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_BASE, ASAAS_API_KEY: 'CHAVE-FICTICIA-ASAAS' }),
    (erro) => {
      assert.match(erro.message, /ASAAS_BASE_URL/);
      assert.ok(!erro.message.includes('CHAVE-FICTICIA-ASAAS'));
      return true;
    },
  );
});

test('CA16: fora de produção, chave com URL http:// local é aceita', () => {
  const config = carregarConfig({ ...AMBIENTE_BASE, ASAAS_API_KEY: 'CHAVE-FICTICIA-ASAAS', ASAAS_BASE_URL: 'http://127.0.0.1:4010' });
  assert.equal(config.asaasBaseUrl, 'http://127.0.0.1:4010');
});

test('CA16: fora de produção, sem chave nem URL, a configuração carrega (a rota responde 503)', () => {
  const config = carregarConfig(AMBIENTE_BASE);
  assert.equal(config.asaasApiKey, undefined);
  assert.equal(config.asaasBaseUrl, undefined);
});

for (const valor of ['999', '30001', '1e4', 'abc', '-1', '0x10', ' 5000']) {
  test(`CA16: carregarConfig lança erro citando ASAAS_TIMEOUT_MS com ${JSON.stringify(valor)}`, () => {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_BASE, ASAAS_TIMEOUT_MS: valor }),
      (erro) => { assert.match(erro.message, /ASAAS_TIMEOUT_MS/); return true; },
    );
  });
}

test('CA16: ASAAS_TIMEOUT_MS ausente ou vazia usa 10000 e aceita os limites 1000 e 30000', () => {
  assert.equal(carregarConfig(AMBIENTE_BASE).asaasTimeoutMs, 10000);
  assert.equal(carregarConfig({ ...AMBIENTE_BASE, ASAAS_TIMEOUT_MS: '' }).asaasTimeoutMs, 10000);
  assert.equal(carregarConfig({ ...AMBIENTE_BASE, ASAAS_TIMEOUT_MS: '1000' }).asaasTimeoutMs, 1000);
  assert.equal(carregarConfig({ ...AMBIENTE_BASE, ASAAS_TIMEOUT_MS: '30000' }).asaasTimeoutMs, 30000);
});
