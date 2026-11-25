import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carregarConfig, carregarConfigBanco, carregarConfigFila, carregarConfigWorker, lerPainelUrlBase } from '../src/config.js';
import { construirApp } from '../src/app.js';
import { PRIVACIDADE_PROVISORIA, TERMOS_MINUTA } from '../src/pedidos/aceite.js';
import { criarCapturaDeLog, criarConfigTeste } from './auxiliares.js';

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
  ASAAS_BASE_URL: 'https://api.asaas.com/v3',
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
  const config = carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS }, { termosMinuta: false, privacidadeProvisoria: false });
  assert.equal(config.pedidosHabilitado, true);
  assert.equal(config.asaasApiKey, 'CHAVE-FICTICIA-ASAAS');
  assert.equal(config.asaasBaseUrl, 'https://api.asaas.com/v3');
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

test('CA16: produção aceita os hosts api.asaas.com e api-sandbox.asaas.com', () => {
  for (const url of ['https://api.asaas.com', 'https://api.asaas.com/v3', 'https://api-sandbox.asaas.com/v3']) {
    const config = carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS, ASAAS_BASE_URL: url }, { termosMinuta: false, privacidadeProvisoria: false });
    assert.equal(config.asaasBaseUrl, url);
  }
});

const URLS_DE_PRODUCAO_RECUSADAS = [
  ['outro host https', 'https://asaas.exemplo.test/v3'],
  ['host parecido (sufixo)', 'https://api.asaas.com.exemplo.test/v3'],
  ['host parecido (prefixo)', 'https://exemplo-api.asaas.com/v3'],
  ['subdomínio do host', 'https://x.api.asaas.com/v3'],
  ['porta explícita', 'https://api.asaas.com:8443/v3'],
  ['credencial na URL', 'https://usuario:senha@api.asaas.com/v3'],
  ['host no lugar da credencial', 'https://api.asaas.com@exemplo.test/v3'],
];
for (const [rotulo, url] of URLS_DE_PRODUCAO_RECUSADAS) {
  test(`CA16: produção recusa ASAAS_BASE_URL com ${rotulo}, citando o nome e sem o valor`, () => {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS, ASAAS_BASE_URL: url }),
      (erro) => {
        assert.match(erro.message, /ASAAS_BASE_URL/);
        assert.ok(!erro.message.includes('exemplo.test'));
        assert.ok(!erro.message.includes('senha'));
        return true;
      },
    );
  });
}

test('CA16: fora de produção ASAAS_BASE_URL aceita qualquer host https', () => {
  const config = carregarConfig({ ...AMBIENTE_BASE, ASAAS_API_KEY: 'CHAVE-FICTICIA-ASAAS', ASAAS_BASE_URL: 'https://asaas.exemplo.test/v3' });
  assert.equal(config.asaasBaseUrl, 'https://asaas.exemplo.test/v3');
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

// CIT-62 (CA7 do plano): com os termos em minuta, a produção não sobe com pedidos ligados,
// salvo a liberação explícita `TERMOS_MINUTA_ACEITA=true` (só homologação).
test('CA7: produção com pedidos ligados e termos em minuta lança erro citando PEDIDOS_HABILITADO, minuta e TERMOS_MINUTA_ACEITA', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS }, { termosMinuta: true, privacidadeProvisoria: false }),
    (erro) => {
      assert.match(erro.message, /PEDIDOS_HABILITADO/);
      assert.match(erro.message, /minuta/);
      assert.match(erro.message, /TERMOS_MINUTA_ACEITA/);
      return true;
    },
  );
});

test('CA7: TERMOS_MINUTA_ACEITA=true libera a partida em produção com os termos em minuta', () => {
  const config = carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS, TERMOS_MINUTA_ACEITA: 'true' }, { termosMinuta: true, privacidadeProvisoria: false });
  assert.equal(config.pedidosHabilitado, true);
});

test('CA7: TERMOS_MINUTA_ACEITA=sim lança erro citando a variável', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS, TERMOS_MINUTA_ACEITA: 'sim' }, { termosMinuta: true, privacidadeProvisoria: false }),
    (erro) => { assert.match(erro.message, /TERMOS_MINUTA_ACEITA/); return true; },
  );
});

test('CA7: produção com pedidos ligados e termos finais (sem minuta) sobe sem liberação', () => {
  assert.equal(carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS }, { termosMinuta: false, privacidadeProvisoria: false }).pedidosHabilitado, true);
});

test('CA7: produção com a rota desligada sobe com os termos em minuta', () => {
  assert.equal(carregarConfig(AMBIENTE_PRODUCAO, { termosMinuta: true, privacidadeProvisoria: false }).pedidosHabilitado, false);
});

test('CA7: fora de produção, pedidos ligados sobem com os termos em minuta', () => {
  const config = carregarConfig({ ...AMBIENTE_BASE, NODE_ENV: 'development', ...AMBIENTE_ASAAS }, { termosMinuta: true, privacidadeProvisoria: false });
  assert.equal(config.pedidosHabilitado, true);
});

test('CA7: produção com pedidos ligados, termos finais e Política provisória lança erro citando política e TERMOS_MINUTA_ACEITA', () => {
  assert.throws(
    () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS }, { termosMinuta: false, privacidadeProvisoria: true }),
    (erro) => {
      assert.match(erro.message, /política/);
      assert.match(erro.message, /TERMOS_MINUTA_ACEITA/);
      return true;
    },
  );
});

test('CA7: TERMOS_MINUTA_ACEITA=true libera a Política provisória e devolve aceiteLiberado', () => {
  const config = carregarConfig(
    { ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS, TERMOS_MINUTA_ACEITA: 'true' },
    { termosMinuta: false, privacidadeProvisoria: true },
  );
  assert.equal(config.aceiteLiberado, true);
});

test('CA7: aceiteLiberado é false sem a trava em uso (termos e Política finais, ou liberação sem necessidade)', () => {
  const final = { termosMinuta: false, privacidadeProvisoria: false };
  assert.equal(carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS }, final).aceiteLiberado, false);
  assert.equal(carregarConfig({ ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS, TERMOS_MINUTA_ACEITA: 'true' }, final).aceiteLiberado, false);
});

test('CA7: TERMOS_MINUTA_ACEITA=sim impede a partida mesmo fora da trava (desenvolvimento, rota desligada, termos finais)', () => {
  const final = { termosMinuta: false, privacidadeProvisoria: false };
  for (const ambiente of [
    { ...AMBIENTE_BASE, NODE_ENV: 'development' },
    AMBIENTE_PRODUCAO,
    { ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS },
  ]) {
    assert.throws(
      () => carregarConfig({ ...ambiente, TERMOS_MINUTA_ACEITA: 'sim' }, final),
      (erro) => { assert.match(erro.message, /TERMOS_MINUTA_ACEITA/); return true; },
    );
  }
});

test('CA7: o padrão de termosMinuta e privacidadeProvisoria são as constantes de pedidos/aceite.js', () => {
  const ambiente = { ...AMBIENTE_PRODUCAO, ...AMBIENTE_ASAAS };
  if (TERMOS_MINUTA || PRIVACIDADE_PROVISORIA) assert.throws(() => carregarConfig(ambiente), /TERMOS_MINUTA_ACEITA/);
  else assert.equal(carregarConfig(ambiente).pedidosHabilitado, true);
});

test('CA7: com aceiteLiberado o app loga warn na partida, e sem ele não loga', async (t) => {
  const poolFalso = () => ({ async query() { return { rows: [] }; }, on() {}, async end() {} });
  const comAviso = criarCapturaDeLog();
  const appCom = construirApp({ ...criarConfigTeste(), aceiteLiberado: true }, { pool: poolFalso(), logStream: comAviso.stream });
  t.after(() => appCom.close());
  const avisos = comAviso.linhas().filter((l) => l.msg === 'aceite liberado com termos em minuta ou política provisória');
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].level, 40);

  const semAviso = criarCapturaDeLog();
  const appSem = construirApp({ ...criarConfigTeste(), aceiteLiberado: false }, { pool: poolFalso(), logStream: semAviso.stream });
  t.after(() => appSem.close());
  assert.equal(semAviso.linhas().some((l) => /aceite liberado/.test(l.msg ?? '')), false);
});

// CIT-64 (CA13): webhook do Asaas. A rota nasce desligada em produção e ligada fora dela;
// ligada em produção, `ASAAS_WEBHOOK_TOKEN` é obrigatório e tem ao menos 32 caracteres. O
// worker lê chave e URL do Asaas (obrigatórias em produção) e nunca o token do webhook.
const TOKEN_WEBHOOK_FICTICIO = 'cfg-'.repeat(10) // fictício, 40 caracteres;
const AMBIENTE_WEBHOOK = { ...AMBIENTE_PRODUCAO, WEBHOOK_ASAAS_HABILITADO: 'true', ASAAS_WEBHOOK_TOKEN: TOKEN_WEBHOOK_FICTICIO };
const AMBIENTE_WORKER_PRODUCAO = {
  ...AMBIENTE_WORKER,
  NODE_ENV: 'production',
  TELEGRAM_BOT_TOKEN: 'TOKEN-FICTICIO',
  TELEGRAM_CHAT_ID: 'CHAT-FICTICIO',
};

test('CA13(a): WEBHOOK_ASAAS_HABILITADO ausente ou vazia é false em produção e true fora dela', () => {
  assert.equal(carregarConfig(AMBIENTE_PRODUCAO).webhookAsaasHabilitado, false);
  assert.equal(carregarConfig({ ...AMBIENTE_PRODUCAO, WEBHOOK_ASAAS_HABILITADO: '' }).webhookAsaasHabilitado, false);
  assert.equal(carregarConfig(AMBIENTE_BASE).webhookAsaasHabilitado, true);
});

test('CA13(a): com a flag desligada em produção a API não exige o token do webhook', () => {
  assert.doesNotThrow(() => carregarConfig(AMBIENTE_PRODUCAO));
});

test('CA13(a): carregarConfigWorker em produção sem a flag não liga o webhook nem exige a chave do Asaas', () => {
  const config = carregarConfigWorker(AMBIENTE_WORKER_PRODUCAO);
  assert.equal(config.webhookAsaasHabilitado, false);
  assert.equal(config.asaasApiKey, undefined);
});

test('CA13(b): em produção, flag ligada e token válido de 32 ou mais caracteres é aceito', () => {
  const config = carregarConfig(AMBIENTE_WEBHOOK);
  assert.equal(config.webhookAsaasHabilitado, true);
  assert.equal(config.asaasWebhookToken, TOKEN_WEBHOOK_FICTICIO);
  assert.doesNotThrow(() => carregarConfig({ ...AMBIENTE_WEBHOOK, ASAAS_WEBHOOK_TOKEN: 'a'.repeat(32) }));
});

for (const [rotulo, token] of [['ausente', undefined], ['vazio', ''], ['só espaços', '   '], ['com 31 caracteres', 'a'.repeat(31)]]) {
  test(`CA13(b): em produção, flag ligada e ASAAS_WEBHOOK_TOKEN ${rotulo} lança citando a variável, sem o valor`, () => {
    const ambiente = { ...AMBIENTE_WEBHOOK, ASAAS_WEBHOOK_TOKEN: token };
    assert.throws(
      () => carregarConfig(ambiente),
      (erro) => {
        assert.match(erro.message, /ASAAS_WEBHOOK_TOKEN/);
        if (token?.trim()) assert.ok(!erro.message.includes(token));
        return true;
      },
    );
  });
}

test('CA13(b): o mínimo de 32 caracteres vale só em produção; fora dela um token curto é aceito', () => {
  const config = carregarConfig({ ...AMBIENTE_BASE, ASAAS_WEBHOOK_TOKEN: 'curto' });
  assert.equal(config.asaasWebhookToken, 'curto');
});

test('CA13(b): fora de produção, sem token, a config carrega e o token fica indefinido (a rota responde 503)', () => {
  assert.equal(carregarConfig(AMBIENTE_BASE).asaasWebhookToken, undefined);
});

test('CA13(c): carregarConfigWorker em produção com a flag ligada e sem ASAAS_API_KEY lança citando a variável', () => {
  assert.throws(
    () => carregarConfigWorker({
      ...AMBIENTE_WORKER_PRODUCAO, WEBHOOK_ASAAS_HABILITADO: 'true', ASAAS_BASE_URL: 'https://api.asaas.com/v3'
    }),
    (erro) => { assert.match(erro.message, /ASAAS_API_KEY/); return true; },
  );
});

test('CA13(c): carregarConfigWorker em produção com a flag ligada e sem ASAAS_BASE_URL lança citando a variável', () => {
  assert.throws(
    () => carregarConfigWorker({ ...AMBIENTE_WORKER_PRODUCAO, WEBHOOK_ASAAS_HABILITADO: 'true', ASAAS_API_KEY: 'CHAVE-FICTICIA' }),
    (erro) => { assert.match(erro.message, /ASAAS_BASE_URL/); return true; },
  );
});

test('CA13(c): carregarConfigWorker com a flag e as credenciais lê chave, URL e timeout e nunca o token do webhook', () => {
  const config = carregarConfigWorker({
    ...AMBIENTE_WORKER_PRODUCAO,
    WEBHOOK_ASAAS_HABILITADO: 'true',
    ASAAS_API_KEY: 'CHAVE-FICTICIA',
    ASAAS_BASE_URL: 'https://api.asaas.com/v3',
    ASAAS_TIMEOUT_MS: '5000',
    ASAAS_WEBHOOK_TOKEN: TOKEN_WEBHOOK_FICTICIO,
  });
  assert.equal(config.webhookAsaasHabilitado, true);
  assert.equal(config.asaasApiKey, 'CHAVE-FICTICIA');
  assert.equal(config.asaasBaseUrl, 'https://api.asaas.com/v3');
  assert.equal(config.asaasTimeoutMs, 5000);
  assert.ok(!JSON.stringify(config).includes(TOKEN_WEBHOOK_FICTICIO));
});

test('CA13(c): carregarConfigWorker em produção valida o host do Asaas como a API (host fora da lista lança)', () => {
  assert.throws(
    () => carregarConfigWorker({
      ...AMBIENTE_WORKER_PRODUCAO, WEBHOOK_ASAAS_HABILITADO: 'true', ASAAS_API_KEY: 'CHAVE-FICTICIA', ASAAS_BASE_URL: 'https://outro.exemplo.test/v3'
    }),
    (erro) => { assert.match(erro.message, /ASAAS_BASE_URL/); return true; },
  );
});

test('CA13(c): fora de produção, a flag ligada no worker não exige a chave (o handler lança até configurar)', () => {
  const config = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development' });
  assert.equal(config.webhookAsaasHabilitado, true);
  assert.equal(config.asaasApiKey, undefined);
  assert.equal(config.asaasTimeoutMs, 10000);
});

test('CA13(e): WEBHOOK_ASAAS_HABILITADO=talvez lança citando a variável, na API e no worker', () => {
  for (const carregar of [
    () => carregarConfig({ ...AMBIENTE_BASE, WEBHOOK_ASAAS_HABILITADO: 'talvez' }),
    () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', WEBHOOK_ASAAS_HABILITADO: 'talvez' }),
  ]) {
    assert.throws(carregar, (erro) => { assert.match(erro.message, /WEBHOOK_ASAAS_HABILITADO/); return true; });
  }
});

// CIT-65, CA8: e-mail transacional no worker (`EMAIL_*`, `SMTP_*`).
const AMBIENTE_EMAIL_SMTP = {
  ...AMBIENTE_WORKER,
  NODE_ENV: 'development',
  EMAIL_TRANSPORTE: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_USUARIO: 'usuario-ficticio',
  SMTP_SENHA: 'SENHA-SMTP-FICTICIA',
};

for (const variavel of ['SMTP_HOST', 'SMTP_USUARIO', 'SMTP_SENHA']) {
  test(`CA8(a): EMAIL_TRANSPORTE=smtp sem ${variavel} lança citando a variável e sem o valor das outras`, () => {
    const ambiente = { ...AMBIENTE_EMAIL_SMTP, [variavel]: '' };
    assert.throws(
      () => carregarConfigWorker(ambiente),
      (erro) => {
        assert.equal(erro.message, `${variavel} não definida`);
        for (const outra of ['usuario-ficticio', 'SENHA-SMTP-FICTICIA']) assert.ok(!erro.message.includes(outra));
        return true;
      },
    );
  });
}

test('CA8(b): EMAIL_TRANSPORTE fora de desligado|smtp lança citando a variável', () => {
  for (const valor of ['sendmail', 'SMTP', 'ligado']) {
    assert.throws(
      () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', EMAIL_TRANSPORTE: valor }),
      (erro) => {
        assert.equal(erro.message, 'EMAIL_TRANSPORTE inválida: use desligado ou smtp');
        assert.ok(!erro.message.includes('sendmail'));
        return true;
      },
    );
  }
});

test('CA8(c): em produção, smtp com SMTP_HOST de loopback lança citando a variável', () => {
  for (const host of ['127.0.0.1', 'localhost', '127.1.2.3', '127.1', '0', '0.0.0.0', '::', '[::]', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', 'smtp.localhost', 'a.b.localhost', 'LOCALHOST']) {
    assert.throws(
      () => carregarConfigWorker({ ...AMBIENTE_WORKER_PRODUCAO, ...AMBIENTE_EMAIL_SMTP, NODE_ENV: 'production', SMTP_HOST: host }),
      (erro) => {
        assert.match(erro.message, /SMTP_HOST inválida: em produção, use um host fora do loopback/);
        assert.ok(!erro.message.includes('SENHA-SMTP-FICTICIA'));
        return true;
      },
      host,
    );
  }
});

test('CA8(c): em produção, smtp com host externo exige TLS (smtpRequireTls) e usa as portas e o timeout padrão', () => {
  const config = carregarConfigWorker({
    ...AMBIENTE_WORKER_PRODUCAO, ...AMBIENTE_EMAIL_SMTP, NODE_ENV: 'production', SMTP_HOST: 'smtp.exemplo.test',
  });
  assert.equal(config.emailTransporte, 'smtp');
  assert.equal(config.smtpHost, 'smtp.exemplo.test');
  assert.equal(config.smtpPorta, 587);
  assert.equal(config.smtpTimeoutMs, 10000);
  assert.equal(config.smtpRequireTls, true);
});

test('CA8: fora de produção, smtp aceita o loopback e não exige TLS', () => {
  const config = carregarConfigWorker({ ...AMBIENTE_EMAIL_SMTP, SMTP_PORTA: '2525' });
  assert.equal(config.smtpHost, '127.0.0.1');
  assert.equal(config.smtpPorta, 2525);
  assert.equal(config.smtpRequireTls, false);
});

for (const [variavel, valor] of [['SMTP_PORTA', '0'], ['SMTP_PORTA', '65536'], ['SMTP_TIMEOUT_MS', '999'], ['EMAIL_PARADO_HORAS', '0'], ['EMAIL_PARADO_HORAS', '73'], ['EMAIL_PARADO_HORAS', '1e1']]) {
  test(`CA8: ${variavel}=${valor} lança citando a variável`, () => {
    assert.throws(
      () => carregarConfigWorker({ ...AMBIENTE_EMAIL_SMTP, [variavel]: valor }),
      (erro) => { assert.match(erro.message, new RegExp(`^${variavel} inválida`)); return true; },
    );
  });
}

test('CA8(d): EMAIL_REMETENTE e EMAIL_RESPONDER_PARA com CR/LF ou caractere de controle lançam, sem o valor', () => {
  for (const variavel of ['EMAIL_REMETENTE', 'EMAIL_RESPONDER_PARA']) {
    for (const valor of ['a@exemplo.test\r\nBcc: x@exemplo.test', 'a@exemplo.test\nBcc: x', 'a@exemplo.test\u0000']) {
      assert.throws(
        () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', [variavel]: valor }),
        (erro) => {
          assert.match(erro.message, new RegExp(`^${variavel} inválida`));
          assert.ok(!erro.message.includes('Bcc'));
          return true;
        },
      );
    }
  }
});

test('CA8(d): remetente sem @ lança citando a variável', () => {
  assert.throws(
    () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', EMAIL_REMETENTE: 'CITMail' }),
    (erro) => { assert.match(erro.message, /^EMAIL_REMETENTE inválida/); return true; },
  );
});

test('CA8(e): sem EMAIL_TRANSPORTE o transporte é desligado, com remetente padrão e alerta de parado em 6 horas', () => {
  const config = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development' });
  assert.equal(config.emailTransporte, 'desligado');
  assert.equal(config.emailRemetente, 'CITMail <naoresponda@citmail.com.br>');
  assert.equal(config.emailResponderPara, undefined);
  assert.equal(config.emailParadoHoras, 6);
  assert.equal(config.smtpHost, undefined);
});

test('CA8(e): EMAIL_TRANSPORTE vazio em produção também é desligado', () => {
  const config = carregarConfigWorker({ ...AMBIENTE_WORKER_PRODUCAO, EMAIL_TRANSPORTE: '' });
  assert.equal(config.emailTransporte, 'desligado');
});

test('CA8: com o transporte desligado, SMTP_* incompleto não lança e a configuração não carrega a senha', () => {
  const config = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', SMTP_SENHA: 'SENHA-SMTP-FICTICIA' });
  assert.ok(!JSON.stringify(config).includes('SENHA-SMTP-FICTICIA'));
});

test('CA8: remetente e responder-para válidos são lidos sem as pontas em branco', () => {
  const config = carregarConfigWorker({
    ...AMBIENTE_WORKER, NODE_ENV: 'development', EMAIL_REMETENTE: '  Equipe <equipe@exemplo.test> ', EMAIL_RESPONDER_PARA: 'suporte@exemplo.test',
  });
  assert.equal(config.emailRemetente, 'Equipe <equipe@exemplo.test>');
  assert.equal(config.emailResponderPara, 'suporte@exemplo.test');
});

test('CA8: a configuração da API (carregarConfig) não lê o e-mail', () => {
  const config = carregarConfig({ ...AMBIENTE_BASE, EMAIL_TRANSPORTE: 'smtp' });
  assert.equal(config.emailTransporte, undefined);
});

test('CA8: smtpRequireTls é true em qualquer host fora do loopback, em produção ou não, e false no loopback', () => {
  const externo = carregarConfigWorker({ ...AMBIENTE_EMAIL_SMTP, SMTP_HOST: 'smtp.exemplo.test' });
  assert.equal(externo.smtpRequireTls, true);
  const loopback = carregarConfigWorker({ ...AMBIENTE_EMAIL_SMTP, SMTP_HOST: '127.0.0.1' });
  assert.equal(loopback.smtpRequireTls, false);
});

test('CA8: EMAIL_TRANSPORTE com espaços nas pontas é aceito e só com espaços vale desligado', () => {
  assert.equal(carregarConfigWorker({ ...AMBIENTE_EMAIL_SMTP, EMAIL_TRANSPORTE: ' smtp ' }).emailTransporte, 'smtp');
  assert.equal(carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', EMAIL_TRANSPORTE: '   ' }).emailTransporte, 'desligado');
});

// CIT-77: intervalo do laço das tarefas de domínio (60000 a 3600000, padrão 300000) e a
// configuração da CLI `npm run dominio` (só o banco).
test('CIT-77 CA2: carregarConfigWorker usa 300000 em DOMINIO_TAREFAS_INTERVALO_MS ausente', () => {
  const config = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development' });
  assert.equal(config.dominioTarefasIntervaloMs, 300000);
});

test('CIT-77 CA2: carregarConfigWorker aceita DOMINIO_TAREFAS_INTERVALO_MS nos limites 60000 e 3600000', () => {
  for (const valor of ['60000', '3600000']) {
    const config = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', DOMINIO_TAREFAS_INTERVALO_MS: valor });
    assert.equal(config.dominioTarefasIntervaloMs, Number(valor));
  }
});

for (const valor of ['59999', '3600001', '1e5', 'abc']) {
  test(`CIT-77 CA2: carregarConfigWorker lança erro citando DOMINIO_TAREFAS_INTERVALO_MS com ${JSON.stringify(valor)}`, () => {
    assert.throws(
      () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', DOMINIO_TAREFAS_INTERVALO_MS: valor }),
      (erro) => { assert.match(erro.message, /DOMINIO_TAREFAS_INTERVALO_MS/); return true; },
    );
  });
}

test('CIT-77 CA4: carregarConfigBanco é válida só com DATABASE_URL, sem CORS, Redis nem Telegram', () => {
  const config = carregarConfigBanco({ DATABASE_URL: AMBIENTE_WORKER.DATABASE_URL, NODE_ENV: 'development' });
  assert.equal(config.databaseUrl, AMBIENTE_WORKER.DATABASE_URL);
  assert.equal(config.logLevel, 'info');
});

test('CIT-77 CA4: carregarConfigBanco sem DATABASE_URL lança erro citando o nome', () => {
  assert.throws(() => carregarConfigBanco({ NODE_ENV: 'development' }), /DATABASE_URL não definida/);
});

test('CIT-77 CA4: carregarConfigBanco com DATABASE_URL só de espaços lança erro', () => {
  assert.throws(() => carregarConfigBanco({ DATABASE_URL: '   ', NODE_ENV: 'development' }), /DATABASE_URL não definida/);
});

// CIT-70 (CA9): login do painel. Desligado em produção por padrão; ligado lá, exige
// REDIS_URL e PAINEL_ORIGENS; PAINEL_ORIGENS é subconjunto exato de CORS_ORIGENS.
const AMBIENTE_PAINEL = {
  CORS_ORIGENS: 'http://127.0.0.1:4200,https://painel.exemplo.test',
  PAINEL_ORIGENS: 'https://painel.exemplo.test',
  REDIS_URL: 'redis://127.0.0.1:56379',
};

test('CA9 (CIT-70): PAINEL_HABILITADO desligada por padrão em produção e ligada fora dela', { tag: '@CIT-70' }, () => {
  assert.equal(carregarConfig(AMBIENTE_PRODUCAO).painelHabilitado, false);
  assert.equal(carregarConfig(AMBIENTE_BASE).painelHabilitado, true);
  assert.equal(carregarConfig({ ...AMBIENTE_BASE, PAINEL_HABILITADO: 'false' }).painelHabilitado, false);
  assert.deepEqual(carregarConfig(AMBIENTE_BASE).painelOrigens, []);
  assert.throws(() => carregarConfig({ ...AMBIENTE_BASE, PAINEL_HABILITADO: 'sim' }), /PAINEL_HABILITADO inválida/);
});

test('CA9 (CIT-70): produção com o painel ligado é recusada (sem limitador de tentativas, CIT-78), mesmo com tudo definido', { tag: '@CIT-70' }, () => {
  const { REDIS_URL: _r, PAINEL_ORIGENS: _p, ...semRedisNemOrigens } = AMBIENTE_PAINEL;
  for (const ambiente of [AMBIENTE_PAINEL, semRedisNemOrigens]) {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_PRODUCAO, ...ambiente, PAINEL_HABILITADO: 'true' }),
      (erro) => {
        assert.equal(
          erro.message,
          'PAINEL_HABILITADO recusada em produção: sem limitador de tentativas no login (CIT-78, ADR 0013)',
        );
        return true;
      },
    );
  }
  // Desligado em produção, sobe sem REDIS_URL nem PAINEL_ORIGENS.
  assert.equal(carregarConfig({ ...AMBIENTE_PRODUCAO, ...semRedisNemOrigens }).painelHabilitado, false);
  // Fora de produção, ligado e com tudo definido, sobe.
  assert.deepEqual(carregarConfig({ ...AMBIENTE_BASE, ...AMBIENTE_PAINEL }).painelOrigens, ['https://painel.exemplo.test']);
});

test('CA9 (CIT-70): PAINEL_ORIGENS fora de CORS_ORIGENS, com curinga ou não exata lança', { tag: '@CIT-70' }, () => {
  for (const PAINEL_ORIGENS of ['https://outra.exemplo.test', '*', 'https://painel.exemplo.test/']) {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_BASE, ...AMBIENTE_PAINEL, PAINEL_ORIGENS }),
      /PAINEL_ORIGENS/,
      PAINEL_ORIGENS,
    );
  }
});

test('CIT-71: carregarConfigWorker lê PAINEL_HABILITADO com a trava da API: ligada fora de produção, recusada em produção', { tag: '@CIT-71' }, () => {
  assert.equal(carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development' }).painelHabilitado, true);
  assert.equal(carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', PAINEL_HABILITADO: 'false' }).painelHabilitado, false);
  assert.equal(carregarConfigWorker(AMBIENTE_WORKER_PRODUCAO).painelHabilitado, false);
  assert.equal(carregarConfigWorker({ ...AMBIENTE_WORKER_PRODUCAO, PAINEL_HABILITADO: 'false' }).painelHabilitado, false);
  assert.throws(
    () => carregarConfigWorker({ ...AMBIENTE_WORKER_PRODUCAO, PAINEL_HABILITADO: 'true' }),
    (erro) => {
      assert.equal(
        erro.message,
        'PAINEL_HABILITADO recusada em produção: sem limitador de tentativas no login (CIT-78, ADR 0013)',
      );
      return true;
    },
  );
  assert.throws(() => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', PAINEL_HABILITADO: 'sim' }), /PAINEL_HABILITADO inválida/);
});

test('CIT-72 CA5: lerPainelUrlBase usa o padrão do Vite em development e test e exige a variável fora deles', { tag: '@CIT-72' }, () => {
  for (const nodeEnv of ['development', 'test']) {
    assert.equal(lerPainelUrlBase({}, nodeEnv), 'http://127.0.0.1:4200/citmail/');
    assert.equal(lerPainelUrlBase({ PAINEL_URL_BASE: '  ' }, nodeEnv), 'http://127.0.0.1:4200/citmail/');
    assert.equal(lerPainelUrlBase({ PAINEL_URL_BASE: 'http://localhost:4200/citmail/' }, nodeEnv), 'http://localhost:4200/citmail/');
  }
  assert.throws(() => lerPainelUrlBase({}, 'production'), { message: 'PAINEL_URL_BASE não definida' });
  assert.equal(lerPainelUrlBase({ PAINEL_URL_BASE: 'https://novo.citmail.com.br/' }, 'production'), 'https://novo.citmail.com.br/');
});

test('CIT-72 CA5: lerPainelUrlBase recusa http fora de dev/test, caminho sem / final, query, fragmento e credenciais', { tag: '@CIT-72' }, () => {
  const invalidas = [
    ['production', 'http://novo.citmail.com.br/'],
    ['production', 'https://novo.citmail.com.br/citmail'],
    ['production', 'https://novo.citmail.com.br/?a=1'],
    ['production', 'https://novo.citmail.com.br/?'],
    ['production', 'https://novo.citmail.com.br/#x'],
    ['production', 'https://user:pw@novo.citmail.com.br/'],
    ['production', 'novo.citmail.com.br/'],
    ['production', 'ftp://novo.citmail.com.br/'],
    ['test', 'http://127.0.0.1:4200/citmail'],
    ['test', 'javascript:alert(1)/'],
  ];
  for (const [nodeEnv, PAINEL_URL_BASE] of invalidas) {
    assert.throws(() => lerPainelUrlBase({ PAINEL_URL_BASE }, nodeEnv), /^Error: PAINEL_URL_BASE inválida/, PAINEL_URL_BASE);
  }
});

test('CIT-72 CA5: carregarConfigWorker lê PAINEL_URL_BASE só com a flag; produção com a flag continua recusada', { tag: '@CIT-72' }, () => {
  const ligada = carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development' });
  assert.equal(ligada.painelUrlBase, 'http://127.0.0.1:4200/citmail/');
  const desligada = carregarConfigWorker({
    ...AMBIENTE_WORKER, NODE_ENV: 'development', PAINEL_HABILITADO: 'false', PAINEL_URL_BASE: 'invalida',
  });
  assert.ok(!Object.hasOwn(desligada, 'painelUrlBase'));
  assert.ok(!Object.hasOwn(carregarConfigWorker(AMBIENTE_WORKER_PRODUCAO), 'painelUrlBase'));
  assert.throws(
    () => carregarConfigWorker({ ...AMBIENTE_WORKER, NODE_ENV: 'development', PAINEL_URL_BASE: 'http://x/sem-barra' }),
    /PAINEL_URL_BASE inválida/,
  );
  assert.throws(
    () => carregarConfigWorker({ ...AMBIENTE_WORKER_PRODUCAO, PAINEL_HABILITADO: 'true', PAINEL_URL_BASE: 'https://novo.citmail.com.br/' }),
    { message: 'PAINEL_HABILITADO recusada em produção: sem limitador de tentativas no login (CIT-78, ADR 0013)' },
  );
});
