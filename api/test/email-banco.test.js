// CIT-65, CA10 (banco): tabela `email_envio` (migração `1795518247853_email-envio.sql`):
// integridade, grants do papel da aplicação, `ON DELETE SET NULL` do evento e guarda do
// down, contra bancos temporários. Dados fictícios.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { aplicarMigracoes, criarBancoTemporario, removerBancoTemporario } from './auxiliares.js';
import { criarBancoWebhook } from './webhook-fixtures.js';

let banco;
let contador = 0;

before(async () => {
  banco = await criarBancoWebhook();
});

after(() => banco.fechar());

beforeEach(() => banco.admin.query('TRUNCATE email_envio, evento_processado, evento CASCADE'));

async function codigoDeErro(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro.code;
  }
  return undefined;
}

function chave() {
  contador += 1;
  return `teste_exemplo-${contador}`;
}

// Linha mínima; `extra` acrescenta ou troca colunas.
function inserir(executor, extra = {}) {
  const colunas = { chave_idempotencia: chave(), modelo: 'teste_exemplo', versao_modelo: 1, ...extra };
  const nomes = Object.keys(colunas);
  return executor.query(
    `INSERT INTO email_envio (${nomes.join(', ')}) VALUES (${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(colunas)
  );
}

test('CA10: chave_idempotencia repetida é recusada com 23505', async () => {
  await inserir(banco.admin, { chave_idempotencia: 'k-repetida' });
  assert.equal(await codigoDeErro(inserir(banco.admin, { chave_idempotencia: 'k-repetida' })), '23505');
});

test('CA10: a linha nasce pendente, geração 1, sem tentativas e sem datas de envio', async () => {
  const { rows } = await banco.admin.query(
    `INSERT INTO email_envio (chave_idempotencia, modelo, versao_modelo) VALUES ('k-padrao', 'teste_exemplo', 1)
     RETURNING estado, geracao, tentativas, refs, enfileirado_em, enviado_em, alertado_parado_em, criado_em`
  );
  assert.equal(rows[0].estado, 'pendente');
  assert.equal(rows[0].geracao, 1);
  assert.equal(rows[0].tentativas, 0);
  assert.deepEqual(rows[0].refs, {});
  assert.equal(rows[0].enfileirado_em, null);
  assert.equal(rows[0].enviado_em, null);
  assert.equal(rows[0].alertado_parado_em, null);
  assert.ok(rows[0].criado_em instanceof Date);
});

for (const [descricao, extra] of [
  ['modelo com hífen', { modelo: 'teste-exemplo' }],
  ['modelo com maiúscula', { modelo: 'Teste' }],
  ['modelo vazio', { modelo: '' }],
  ['estado fora da lista', { estado: 'inventado' }],
  ['erro_codigo com mensagem do servidor', { erro_codigo: 'fulano@exemplo.test rejeitado' }],
  ['erro_codigo em minúsculas', { erro_codigo: 'erro' }],
  ['refs que não é objeto', { refs: '[1]' }],
  ['refs com mais de 1024 bytes', { refs: JSON.stringify({ a: 'x'.repeat(1100) }) }],
  ['versao_modelo zero', { versao_modelo: 0 }],
  ['chave_idempotencia vazia', { chave_idempotencia: '' }]
]) {
  test(`CA10: ${descricao} é recusado com 23514`, async () => {
    assert.equal(await codigoDeErro(inserir(banco.admin, extra)), '23514');
  });
}

test('CA10: erro_codigo SEM_DESTINATARIO, 451 e ECONNECTION são aceitos', async () => {
  for (const erro_codigo of ['SEM_DESTINATARIO', '451', 'ECONNECTION']) {
    await assert.doesNotReject(inserir(banco.admin, { erro_codigo }));
  }
});

test('CA10: o papel da aplicação lê a tabela e insere nas colunas da lista', async () => {
  await assert.doesNotReject(banco.app.query('SELECT count(*) FROM email_envio'));
  await assert.doesNotReject(inserir(banco.app));
});

test('CA10: o papel da aplicação insere só evento_id, chave_idempotencia, modelo, versao_modelo e refs', async () => {
  const papel = `${banco.nomeBanco}_aplicacao`;
  const consulta = (coluna) => banco.admin.query(
    'SELECT has_column_privilege($1, $2, $3, $4) AS tem', [papel, 'email_envio', coluna, 'INSERT']
  );
  for (const coluna of ['evento_id', 'chave_idempotencia', 'modelo', 'versao_modelo', 'refs']) {
    assert.equal((await consulta(coluna)).rows[0].tem, true, coluna);
  }
  for (const coluna of ['id', 'estado', 'geracao', 'tentativas', 'erro_codigo', 'message_id', 'destinatario_mascarado',
    'criado_em', 'enfileirado_em', 'enviado_em', 'alertado_parado_em']) {
    assert.equal((await consulta(coluna)).rows[0].tem, false, coluna);
  }
});

test('CA10: o papel da aplicação não insere a linha já em estado enviado (42501)', async () => {
  assert.equal(await codigoDeErro(inserir(banco.app, { estado: 'enviado' })), '42501');
  assert.equal(await codigoDeErro(inserir(banco.app, { tentativas: 3 })), '42501');
});

test('CA10: o papel da aplicação não apaga linha (42501)', async () => {
  const { rows } = await inserir(banco.admin);
  assert.equal(await codigoDeErro(banco.app.query('DELETE FROM email_envio WHERE id = $1', [rows[0].id])), '42501');
  assert.equal(await codigoDeErro(banco.app.query('TRUNCATE email_envio')), '42501');
});

test('CA10: o papel da aplicação não altera modelo nem refs (42501)', async () => {
  const { rows } = await inserir(banco.admin);
  assert.equal(await codigoDeErro(banco.app.query("UPDATE email_envio SET modelo = 'outro' WHERE id = $1", [rows[0].id])), '42501');
  assert.equal(await codigoDeErro(banco.app.query("UPDATE email_envio SET refs = '{}'::jsonb WHERE id = $1", [rows[0].id])), '42501');
});

test('CA10: o papel da aplicação não escolhe o id no INSERT (42501)', async () => {
  assert.equal(await codigoDeErro(inserir(banco.app, { id: randomUUID() })), '42501');
});

test('CA10: o papel da aplicação não altera chave_idempotencia nem evento_id (42501)', async () => {
  const { rows } = await inserir(banco.admin);
  assert.equal(await codigoDeErro(banco.app.query("UPDATE email_envio SET chave_idempotencia = 'x' WHERE id = $1", [rows[0].id])), '42501');
  assert.equal(await codigoDeErro(banco.app.query('UPDATE email_envio SET evento_id = NULL WHERE id = $1', [rows[0].id])), '42501');
});

test('CA10: o papel da aplicação atualiza as colunas do processamento (estado, geração, tentativas, datas)', async () => {
  const { rows } = await inserir(banco.admin);
  await assert.doesNotReject(banco.app.query(
    `UPDATE email_envio SET estado = 'enviado', geracao = geracao + 1, tentativas = 1, erro_codigo = '451', message_id = 'm',
            enfileirado_em = now(), enviado_em = now(), destinatario_mascarado = 'f***@exemplo.test', alertado_parado_em = now()
      WHERE id = $1`,
    [rows[0].id]
  ));
});

test('CA10: apagar o evento (como dono) deixa evento_id nulo e preserva a linha do e-mail', async () => {
  const evento = await banco.admin.query(
    `INSERT INTO evento (nome, agregado_tipo, agregado_id, chave_idempotencia)
     VALUES ('pedido_pago', 'pedido', 'p1', 'evt-email-1') RETURNING id`
  );
  const { rows } = await inserir(banco.admin, { evento_id: evento.rows[0].id });
  await banco.admin.query('DELETE FROM evento WHERE id = $1', [evento.rows[0].id]);
  const depois = await banco.admin.query('SELECT evento_id FROM email_envio WHERE id = $1', [rows[0].id]);
  assert.equal(depois.rows.length, 1);
  assert.equal(depois.rows[0].evento_id, null);
});

test('CA10: evento_id inexistente é recusado com 23503', async () => {
  assert.equal(await codigoDeErro(inserir(banco.admin, { evento_id: randomUUID() })), '23503');
});

async function comBancoMigrado(corpo) {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      await corpo(url, pool);
    } finally {
      await pool.end();
    }
  } finally {
    await removerBancoTemporario(nomeBanco);
  }
}

test('CA10: o down com linha em email_envio é recusado (P0001) e a tabela continua', async () => {
  await comBancoMigrado(async (url, pool) => {
    await inserir(pool);
    await assert.rejects(aplicarMigracoes(url, 'down', 1), (erro) => {
      assert.match(erro.message, /email_envio com registros: down recusado/);
      assert.equal(erro.code, 'P0001');
      return true;
    });
    const { rows } = await pool.query("SELECT to_regclass('email_envio') AS tabela, (SELECT count(*)::int FROM email_envio) AS n");
    assert.notEqual(rows[0].tabela, null);
    assert.equal(rows[0].n, 1);
  });
});

test('CA10: o down com a tabela vazia a remove e o up seguinte a recria', async () => {
  await comBancoMigrado(async (url, pool) => {
    await aplicarMigracoes(url, 'down', 1);
    assert.equal((await pool.query("SELECT to_regclass('email_envio') AS tabela")).rows[0].tabela, null);
    await aplicarMigracoes(url, 'up', 1);
    assert.notEqual((await pool.query("SELECT to_regclass('email_envio') AS tabela")).rows[0].tabela, null);
  });
});
