import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { criarBancoTemporario, removerBancoTemporario, aplicarMigracoes } from './auxiliares.js';

async function contar(url, sql, parametros = []) {
  const cliente = new Client({ connectionString: url });
  await cliente.connect();
  try {
    const resultado = await cliente.query(sql, parametros);
    return resultado.rowCount;
  } finally {
    await cliente.end();
  }
}

function funcaoDefinirAtualizadoEmExiste(url) {
  return contar(url, 'SELECT 1 FROM pg_proc WHERE proname = $1', ['definir_atualizado_em']);
}

async function linhasEmPgmigrations(url) {
  const cliente = new Client({ connectionString: url });
  await cliente.connect();
  try {
    const resultado = await cliente.query('SELECT count(*)::int AS total FROM pgmigrations');
    return resultado.rows[0].total;
  } finally {
    await cliente.end();
  }
}

test('CA3: aplica, reverte e reaplica todas as migrações num banco vazio sem erro', async (t) => {
  const { nomeBanco, url } = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(nomeBanco));

  await assert.doesNotReject(
    aplicarMigracoes(url, 'up', Infinity),
    'aplicar (up) não deveria rejeitar',
  );
  assert.equal(await funcaoDefinirAtualizadoEmExiste(url), 1, 'função definir_atualizado_em deveria existir após up');

  await assert.doesNotReject(
    aplicarMigracoes(url, 'down', Infinity),
    'reverter (down) não deveria rejeitar',
  );
  assert.equal(await funcaoDefinirAtualizadoEmExiste(url), 0, 'função definir_atualizado_em não deveria existir após down');
  assert.equal(await linhasEmPgmigrations(url), 0, 'pgmigrations deveria ficar sem linhas após down completo');

  await assert.doesNotReject(
    aplicarMigracoes(url, 'up', Infinity),
    'reaplicar (up) não deveria rejeitar',
  );
  assert.equal(await funcaoDefinirAtualizadoEmExiste(url), 1, 'função definir_atualizado_em deveria existir após reaplicar');
});

async function consultar(url, sql, parametros = []) {
  const cliente = new Client({ connectionString: url });
  await cliente.connect();
  try {
    return (await cliente.query(sql, parametros)).rows;
  } finally {
    await cliente.end();
  }
}

const COLUNA_TOKEN = "SELECT data_type, is_nullable, character_maximum_length FROM information_schema.columns WHERE table_name = 'pedido' AND column_name = 'token_hash'";

test('CIT-69 CA2: a migração do token cria token_hash nulável, único, com CHECK, e o down a remove', async (t) => {
  const { nomeBanco, url } = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(nomeBanco));
  await aplicarMigracoes(url, 'up', Infinity);

  const [coluna] = await consultar(url, COLUNA_TOKEN);
  assert.equal(coluna.is_nullable, 'YES', 'pedidos antigos ficam sem token');
  assert.equal(coluna.character_maximum_length, 64);
  const [{ tem }] = await consultar(
    url,
    'SELECT has_column_privilege($1, $2, $3, $4) AS tem',
    [`${nomeBanco}_aplicacao`, 'pedido', 'token_hash', 'UPDATE'],
  );
  assert.equal(tem, true, 'o papel da aplicação grava o hash');

  // As 4 últimas: solicitação de senha (CIT-71), tarefa de domínio, envio de e-mail e o token.
  await aplicarMigracoes(url, 'down', 4);
  assert.equal((await consultar(url, COLUNA_TOKEN)).length, 0, 'o down remove token_hash');

  await aplicarMigracoes(url, 'up', Infinity);
  assert.equal((await consultar(url, COLUNA_TOKEN)).length, 1, 'o up reaplica token_hash');
});

test('CIT-71 CA9: down da solicitação de senha com linha → P0001; vazio, desce e sobe de novo', { tag: '@CIT-71' }, async (t) => {
  const { nomeBanco, url } = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(nomeBanco));
  await aplicarMigracoes(url, 'up', Infinity);
  const cliente = new Client({ connectionString: url });
  await cliente.connect();
  try {
    const { rows: [{ id: clienteId }] } = await cliente.query(
      `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
       VALUES ('fisica', '30000000999', 'Titular Ficticio', 'titular@exemplo.com.br', '11999990000') RETURNING id`,
    );
    const { rows: [{ id: contaId }] } = await cliente.query(
      "INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'titular@exemplo.com.br') RETURNING id",
      [clienteId],
    );
    await cliente.query(
      "INSERT INTO solicitacao_senha (conta_titular_id, tipo, expira_em) VALUES ($1, 'primeiro_acesso', now() + interval '1 hour')",
      [contaId],
    );

    await assert.rejects(aplicarMigracoes(url, 'down', 1), (erro) => erro.code === 'P0001' || /down recusado/.test(erro.message));
    assert.equal((await cliente.query("SELECT to_regclass('solicitacao_senha') AS t")).rows[0].t, 'solicitacao_senha');

    await cliente.query('DELETE FROM solicitacao_senha');
  } finally {
    await cliente.end();
  }
  await aplicarMigracoes(url, 'down', 1);
  assert.equal((await consultar(url, "SELECT to_regclass('solicitacao_senha') AS t"))[0].t, null);
  const [{ tem }] = await consultar(
    url,
    'SELECT has_column_privilege($1, $2, $3, $4) AS tem',
    [`${nomeBanco}_aplicacao`, 'conta_titular', 'senha_hash', 'UPDATE'],
  );
  assert.equal(tem, false, 'o down revoga o UPDATE da senha');
  await aplicarMigracoes(url, 'up', Infinity);
  assert.equal((await consultar(url, "SELECT to_regclass('solicitacao_senha') AS t"))[0].t, 'solicitacao_senha');
});
