// CIT-166, CA1 e CA2: tabelas `evento` e `evento_processado` (migração
// `1795431594142_eventos.sql`) e `registrarEvento` (`src/eventos/servico.js`),
// contra um banco temporário migrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { criarBancoTemporario, removerBancoTemporario, aplicarMigracoes } from './auxiliares.js';
import { registrarEvento } from '../src/eventos/servico.js';

const REQUEST_ID = 'req-ficticio-166';

async function criarBancoMigrado() {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url);
  } catch (erro) {
    await removerBancoTemporario(nomeBanco);
    throw erro;
  }
  const pool = new Pool({ connectionString: url, max: 3 });
  return {
    pool,
    url,
    banco: nomeBanco,
    async fechar() {
      await pool.end();
      await removerBancoTemporario(nomeBanco);
    },
  };
}

function dadosValidos(sobrescritas = {}) {
  const pedidoId = randomUUID();
  return {
    nome: 'pedido_pago',
    agregado: { tipo: 'pedido', id: pedidoId },
    chaveIdempotencia: `pedido_pago-${pedidoId}`,
    payload: { pedidoId, ciclo: 'mensal' },
    requestId: REQUEST_ID,
    ...sobrescritas,
  };
}

// Roda `fn(cliente)` numa transação; COMMIT quando `confirmar`, senão ROLLBACK.
async function emTransacao(pool, fn, { confirmar = true } = {}) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query(confirmar ? 'COMMIT' : 'ROLLBACK');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
}

async function contarEventos(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM evento');
  return rows[0].total;
}

async function inserirEventoCru(pool, chave = `chave-${randomUUID()}`) {
  const { rows } = await pool.query(
    `INSERT INTO evento (nome, agregado_tipo, agregado_id, chave_idempotencia)
     VALUES ('pedido_pago', 'pedido', 'p1', $1) RETURNING id`,
    [chave],
  );
  return rows[0].id;
}

async function codigoDeErro(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro.code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CA1: migração
// ---------------------------------------------------------------------------

test('CA1a: a tabela evento tem as 11 colunas com os tipos e a nulidade do plano', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const { rows } = await banco.pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'evento' ORDER BY column_name`,
  );
  const obtido = Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}/${r.is_nullable}`]));
  assert.deepEqual(obtido, {
    agregado_id: 'text/NO',
    agregado_tipo: 'text/NO',
    chave_idempotencia: 'text/NO',
    id: 'uuid/NO',
    nome: 'text/NO',
    ocorrido_em: 'timestamp with time zone/NO',
    payload: 'jsonb/NO',
    publicado_em: 'timestamp with time zone/YES',
    request_id: 'text/YES',
    tentativas_publicacao: 'integer/NO',
    versao: 'integer/NO',
  });
});

test('CA1b: a tabela evento_processado tem as 3 colunas com os tipos do plano', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const { rows } = await banco.pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'evento_processado' ORDER BY column_name`,
  );
  const obtido = Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}/${r.is_nullable}`]));
  assert.deepEqual(obtido, {
    consumidor: 'text/NO',
    evento_id: 'uuid/NO',
    processado_em: 'timestamp with time zone/NO',
  });
});

test('CA1c: o índice parcial evento_pendente_idx cobre só eventos não publicados', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const { rows } = await banco.pool.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'evento_pendente_idx'",
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].indexdef, /\(ocorrido_em, id\)/);
  assert.match(rows[0].indexdef, /WHERE \(publicado_em IS NULL\)/);
});

test('CA1d: duas linhas com a mesma chave_idempotencia falham com 23505', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  await inserirEventoCru(banco.pool, 'pedido_pago-repetida');
  assert.equal(await codigoDeErro(inserirEventoCru(banco.pool, 'pedido_pago-repetida')), '23505');
});

test('CA1e: o par (consumidor, evento_id) duplicado em evento_processado falha com 23505', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const eventoId = await inserirEventoCru(banco.pool);
  const sql = "INSERT INTO evento_processado (consumidor, evento_id) VALUES ('teste_a', $1)";
  await banco.pool.query(sql, [eventoId]);
  assert.equal(await codigoDeErro(banco.pool.query(sql, [eventoId])), '23505');
});

test('CA1f: evento_processado com evento_id inexistente falha com 23503', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const codigo = await codigoDeErro(
    banco.pool.query("INSERT INTO evento_processado (consumidor, evento_id) VALUES ('teste_a', $1)", [randomUUID()]),
  );
  assert.equal(codigo, '23503');
});

test('CA1g: consumidor com hífen é recusado pelo CHECK (23514), pois o hífen separa o jobId', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const eventoId = await inserirEventoCru(banco.pool);
  const codigo = await codigoDeErro(
    banco.pool.query("INSERT INTO evento_processado (consumidor, evento_id) VALUES ('teste-a', $1)", [eventoId]),
  );
  assert.equal(codigo, '23514');
});

test('CA1h: apagar o evento apaga as marcas dele em evento_processado (ON DELETE CASCADE)', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const eventoId = await inserirEventoCru(banco.pool);
  await banco.pool.query("INSERT INTO evento_processado (consumidor, evento_id) VALUES ('teste_a', $1)", [eventoId]);
  await banco.pool.query('DELETE FROM evento WHERE id = $1', [eventoId]);

  const { rows } = await banco.pool.query('SELECT count(*)::int AS total FROM evento_processado');
  assert.equal(rows[0].total, 0);
});

test('CA1i: o papel <banco>_aplicacao não insere id nem ocorrido_em, mas atualiza publicado_em', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const papel = `${banco.banco}_aplicacao`;
  const privilegio = async (tabela, coluna, tipo) => {
    const { rows } = await banco.pool.query('SELECT has_column_privilege($1, $2, $3, $4) AS ok', [papel, tabela, coluna, tipo]);
    return rows[0].ok;
  };
  assert.equal(await privilegio('evento', 'id', 'INSERT'), false);
  assert.equal(await privilegio('evento', 'ocorrido_em', 'INSERT'), false);
  assert.equal(await privilegio('evento', 'publicado_em', 'INSERT'), false);
  assert.equal(await privilegio('evento', 'payload', 'INSERT'), true);
  assert.equal(await privilegio('evento', 'publicado_em', 'UPDATE'), true);
  assert.equal(await privilegio('evento', 'tentativas_publicacao', 'UPDATE'), true);
  assert.equal(await privilegio('evento', 'payload', 'UPDATE'), false);
  assert.equal(await privilegio('evento_processado', 'processado_em', 'INSERT'), false);
});

test('CA1j: o papel <banco>_aplicacao não tem DELETE em evento nem em evento_processado', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const papel = `${banco.banco}_aplicacao`;
  for (const tabela of ['evento', 'evento_processado']) {
    const { rows } = await banco.pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [papel, tabela, 'DELETE']);
    assert.equal(rows[0].ok, false, `${tabela} não deveria aceitar DELETE`);
  }
});

test('CA1k: o down com um evento gravado é recusado com P0001 e as tabelas continuam', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  await inserirEventoCru(banco.pool);
  await assert.rejects(aplicarMigracoes(banco.url, 'down', 7), /evento com registros: down recusado/);

  const { rows } = await banco.pool.query("SELECT to_regclass('evento') AS tabela");
  assert.notEqual(rows[0].tabela, null);
});

test('CA1l: o down com as tabelas vazias remove evento e evento_processado, e o up seguinte funciona', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  await aplicarMigracoes(banco.url, 'down', 7);
  const { rows } = await banco.pool.query(
    "SELECT to_regclass('evento') AS evento, to_regclass('evento_processado') AS processado",
  );
  assert.equal(rows[0].evento, null);
  assert.equal(rows[0].processado, null);

  await assert.doesNotReject(aplicarMigracoes(banco.url, 'up'));
  const depois = await banco.pool.query("SELECT to_regclass('evento') AS evento");
  assert.notEqual(depois.rows[0].evento, null);
});

// ---------------------------------------------------------------------------
// CA2: registrarEvento
// ---------------------------------------------------------------------------

test('CA2a: registrarEvento grava a linha com os campos recebidos e devolve { id, criado: true }', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const dados = dadosValidos();
  const resultado = await emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dados));

  assert.equal(resultado.criado, true);
  const { rows } = await banco.pool.query('SELECT * FROM evento WHERE id = $1', [resultado.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nome, 'pedido_pago');
  assert.equal(rows[0].versao, 1);
  assert.equal(rows[0].agregado_tipo, 'pedido');
  assert.equal(rows[0].agregado_id, dados.agregado.id);
  assert.equal(rows[0].chave_idempotencia, dados.chaveIdempotencia);
  assert.deepEqual(rows[0].payload, dados.payload);
  assert.equal(rows[0].request_id, REQUEST_ID);
  assert.equal(rows[0].publicado_em, null);
  assert.equal(rows[0].tentativas_publicacao, 0);
});

test('CA2b: o ROLLBACK do chamador não deixa linha de evento', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  await emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dadosValidos()), { confirmar: false });

  assert.equal(await contarEventos(banco.pool), 0);
});

test('CA2c: a mesma chaveIdempotencia em outra transação devolve o mesmo id com criado false e 1 linha', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const dados = dadosValidos();
  const primeiro = await emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dados));
  const segundo = await emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dados));

  assert.equal(segundo.id, primeiro.id);
  assert.equal(segundo.criado, false);
  assert.equal(await contarEventos(banco.pool), 1);
});

test('CA2d: a mesma chaveIdempotencia repetida na mesma transação devolve o mesmo id com criado false', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const dados = dadosValidos();
  const [primeiro, segundo] = await emTransacao(banco.pool, async (cliente) => [
    await registrarEvento(cliente, dados),
    await registrarEvento(cliente, dados),
  ]);

  assert.equal(primeiro.criado, true);
  assert.equal(segundo.criado, false);
  assert.equal(segundo.id, primeiro.id);
  assert.equal(await contarEventos(banco.pool), 1);
});

test('CA2e: nome fora da lista lança TypeError "nome fora da lista" e não grava', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const dados = dadosValidos({ nome: 'evento_inexistente', chaveIdempotencia: 'evento_inexistente-1' });
  await assert.rejects(
    emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dados)),
    (erro) => erro instanceof TypeError && /nome fora da lista/.test(erro.message),
  );
  assert.equal(await contarEventos(banco.pool), 0);
});

const PAYLOADS_SENSIVEIS = {
  'chave no nível raiz': { email: 'fulano@exemplo.test' },
  'chave em objeto aninhado': { cliente: { cpf: '00000000000' } },
  'chave dentro de array, com maiúscula': { itens: [{ Nome: 'x' }] },
};

for (const [descricao, payload] of Object.entries(PAYLOADS_SENSIVEIS)) {
  test(`CA2f: payload com campo sensível (${descricao}) lança TypeError sem o valor na mensagem e não grava`, async (t) => {
    const banco = await criarBancoMigrado();
    t.after(banco.fechar);

    await assert.rejects(
      emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dadosValidos({ payload }))),
      (erro) => {
        assert.ok(erro instanceof TypeError);
        assert.match(erro.message, /payload com campo sensível/);
        assert.ok(!erro.message.includes('fulano@exemplo.test'));
        assert.ok(!erro.message.includes('00000000000'));
        return true;
      },
    );
    assert.equal(await contarEventos(banco.pool), 0);
  });
}

test('CA2g: chaveIdempotencia sem o prefixo <nome>- lança TypeError e não grava', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  await assert.rejects(
    emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dadosValidos({ chaveIdempotencia: 'outro-1' }))),
    TypeError,
  );
  assert.equal(await contarEventos(banco.pool), 0);
});

test('CA2h: requestId ausente lança TypeError e não grava', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  await assert.rejects(
    emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dadosValidos({ requestId: undefined }))),
    (erro) => erro instanceof TypeError && /requestId/.test(erro.message),
  );
  assert.equal(await contarEventos(banco.pool), 0);
});

test('CA2i: payload maior que 2048 bytes lança TypeError e não grava', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const payload = { referencia: 'x'.repeat(2100) };
  await assert.rejects(
    emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dadosValidos({ payload }))),
    TypeError,
  );
  assert.equal(await contarEventos(banco.pool), 0);
});

test('CA2j: agregado.tipo fora da lista passa pelo serviço e o banco recusa com 23514, sem gravar', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const dados = dadosValidos();
  dados.agregado = { tipo: 'outro', id: dados.agregado.id };
  const codigo = await codigoDeErro(emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dados)));

  assert.equal(codigo, '23514');
  assert.equal(await contarEventos(banco.pool), 0);
});

test('CA2l: chave repetida com outro agregado é rejeitada', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  const dados = dadosValidos();
  await emTransacao(banco.pool, (cliente) => registrarEvento(cliente, dados));
  const outro = { ...dados, agregado: { tipo: 'pedido', id: randomUUID() } };

  await assert.rejects(
    emTransacao(banco.pool, (cliente) => registrarEvento(cliente, outro)),
    { name: 'TypeError', message: 'evento: chave de idempotência já usada por outro agregado' }
  );
  assert.equal(await contarEventos(banco.pool), 1);
});

test('CA2k: registrarEvento recusa um Pool no lugar do cliente da transação', async (t) => {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);

  await assert.rejects(registrarEvento(banco.pool, dadosValidos()), TypeError);
  assert.equal(await contarEventos(banco.pool), 0);
});
