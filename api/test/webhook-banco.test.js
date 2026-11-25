// CIT-64, CA14 (banco): tabelas `asaas_webhook_evento` e `conta_titular` e a coluna
// `pedido.dominio_pago_em` (migração `1795483886040_webhook-asaas.sql`): integridade,
// grants do papel da aplicação e guarda do down, contra bancos temporários.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { aplicarMigracoes, criarBancoTemporario, removerBancoTemporario } from './auxiliares.js';
import { criarBancoWebhook, semearBruto, semearCliente, semearPedido } from './webhook-fixtures.js';

let banco;

before(async () => {
  banco = await criarBancoWebhook();
});

after(() => banco.fechar());

beforeEach(() => banco.limpar());

async function codigoDeErro(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro.code;
  }
  return undefined;
}

const INSERT_BRUTO = "INSERT INTO asaas_webhook_evento (asaas_evento_id, evento) VALUES ($1, 'PAYMENT_RECEIVED')";

test('CA14: asaas_evento_id duplicado é recusado com 23505', async () => {
  await banco.admin.query(INSERT_BRUTO, ['evt_dup']);
  assert.equal(await codigoDeErro(banco.admin.query(INSERT_BRUTO, ['evt_dup'])), '23505');
});

test('CA14: situação pendente com processado_em preenchido, ou terminal sem ele, é recusada com 23514', async () => {
  assert.equal(await codigoDeErro(banco.admin.query(
    "INSERT INTO asaas_webhook_evento (asaas_evento_id, evento, processado_em) VALUES ('evt_a', 'X', now())"
  )), '23514');
  assert.equal(await codigoDeErro(banco.admin.query(
    "INSERT INTO asaas_webhook_evento (asaas_evento_id, evento, situacao) VALUES ('evt_b', 'X', 'processado')"
  )), '23514');
});

test('CA14: codigo fora do padrão de código é recusado com 23514', async () => {
  const id = await semearBruto(banco.admin);
  assert.equal(await codigoDeErro(banco.admin.query(
    "UPDATE asaas_webhook_evento SET situacao = 'ignorado', processado_em = now(), codigo = 'Com Espaco' WHERE id = $1", [id]
  )), '23514');
});

test('CA14: conta_titular com e-mail em maiúscula é recusada com 23514', async () => {
  const cliente = await semearCliente(banco.admin);
  assert.equal(await codigoDeErro(banco.admin.query(
    "INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'Titular@Exemplo.test')", [cliente]
  )), '23514');
});

test('CA14: 2ª conta do mesmo cliente é recusada com 23505', async () => {
  const cliente = await semearCliente(banco.admin);
  await banco.admin.query("INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'a@exemplo.test')", [cliente]);
  assert.equal(await codigoDeErro(banco.admin.query(
    "INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'b@exemplo.test')", [cliente]
  )), '23505');
});

test('CA14: o mesmo e-mail em dois clientes é recusado com 23505', async () => {
  const [a, b] = [await semearCliente(banco.admin), await semearCliente(banco.admin)];
  await banco.admin.query("INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'a@exemplo.test')", [a]);
  assert.equal(await codigoDeErro(banco.admin.query(
    "INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'a@exemplo.test')", [b]
  )), '23505');
});

test('CA14: conta nasce sem_senha e o estado fora da lista é recusado com 23514', async () => {
  const cliente = await semearCliente(banco.admin);
  const { rows } = await banco.admin.query(
    "INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'a@exemplo.test') RETURNING estado, senha_hash", [cliente]
  );
  assert.deepEqual(rows[0], { estado: 'sem_senha', senha_hash: null });
  const outro = await semearCliente(banco.admin);
  assert.equal(await codigoDeErro(banco.admin.query(
    "INSERT INTO conta_titular (cliente_id, email, estado) VALUES ($1, 'b@exemplo.test', 'inventado')", [outro]
  )), '23514');
});

test('CA14: o papel da aplicação lê as duas tabelas', async () => {
  await assert.doesNotReject(banco.app.query('SELECT count(*) FROM asaas_webhook_evento'));
  await assert.doesNotReject(banco.app.query('SELECT count(*) FROM conta_titular'));
});

test('CA14: o papel da aplicação não altera o evento do bruto nem apaga linha (42501)', async () => {
  const id = await semearBruto(banco.admin);
  assert.equal(await codigoDeErro(banco.app.query("UPDATE asaas_webhook_evento SET evento = 'OUTRO' WHERE id = $1", [id])), '42501');
  assert.equal(await codigoDeErro(banco.app.query('DELETE FROM asaas_webhook_evento WHERE id = $1', [id])), '42501');
  assert.equal(await codigoDeErro(banco.app.query('TRUNCATE asaas_webhook_evento')), '42501');
});

test('CA14: o papel da aplicação só insere o bruto nas colunas da lista branca (42501 em situacao e recebido_em)', async () => {
  assert.equal(await codigoDeErro(banco.app.query(
    "INSERT INTO asaas_webhook_evento (asaas_evento_id, evento, situacao) VALUES ('evt_s', 'X', 'pendente')"
  )), '42501');
  assert.equal(await codigoDeErro(banco.app.query(
    "INSERT INTO asaas_webhook_evento (asaas_evento_id, evento, recebido_em) VALUES ('evt_r', 'X', now())"
  )), '42501');
  await assert.doesNotReject(banco.app.query(
    `INSERT INTO asaas_webhook_evento (asaas_evento_id, evento, request_id, pagamento_id, assinatura_id,
       referencia_externa, status, billing_type, valor_centavos, vencimento, pago_em)
     VALUES ('evt_ok', 'X', 'r', 'pay_1', 'sub_1', 'ref', 'RECEIVED', 'PIX', 100, '2026-12-10', '2026-12-01')`
  ));
});

test('CA14: o papel da aplicação atualiza só as colunas do processamento do bruto', async () => {
  const id = await semearBruto(banco.admin);
  await assert.doesNotReject(banco.app.query(
    "UPDATE asaas_webhook_evento SET situacao = 'processado', processado_em = now(), codigo = 'ok' WHERE id = $1", [id]
  ));
  await assert.doesNotReject(banco.app.query('UPDATE asaas_webhook_evento SET enfileirado_em = now(), alertado_pendente_em = now() WHERE id = $1', [id]));
  assert.equal(await codigoDeErro(banco.app.query("UPDATE asaas_webhook_evento SET pagamento_id = 'pay_x' WHERE id = $1", [id])), '42501');
});

test('CA14: o papel da aplicação insere a conta (cliente, e-mail, estado), mas não altera nem apaga nem grava a senha (42501)', async () => {
  const cliente = await semearCliente(banco.admin);
  await assert.doesNotReject(banco.app.query(
    "INSERT INTO conta_titular (cliente_id, email, estado) VALUES ($1, 'a@exemplo.test', 'sem_senha')", [cliente]
  ));
  assert.equal(await codigoDeErro(banco.app.query("UPDATE conta_titular SET email = 'z@exemplo.test'")), '42501');
  assert.equal(await codigoDeErro(banco.app.query('DELETE FROM conta_titular')), '42501');
  const outro = await semearCliente(banco.admin);
  assert.equal(await codigoDeErro(banco.app.query(
    "INSERT INTO conta_titular (cliente_id, email, senha_hash) VALUES ($1, 'b@exemplo.test', 'hash')", [outro]
  )), '42501');
});

test('CA14: o papel da aplicação atualiza pedido.dominio_pago_em, e a coluna nasce nula', async () => {
  const { pedidoId } = await semearPedido(banco.admin);
  assert.equal((await banco.admin.query('SELECT dominio_pago_em FROM pedido WHERE id = $1', [pedidoId])).rows[0].dominio_pago_em, null);
  await assert.doesNotReject(banco.app.query('UPDATE pedido SET dominio_pago_em = now() WHERE id = $1', [pedidoId]));
  assert.equal(await codigoDeErro(banco.app.query("UPDATE pedido SET contato_email = 'x@exemplo.test' WHERE id = $1", [pedidoId])), '42501');
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

test('CA14: o down com linha em asaas_webhook_evento é recusado (P0001) e nada é removido', async () => {
  await comBancoMigrado(async (url, pool) => {
    await pool.query(INSERT_BRUTO, [`evt_${randomUUID()}`]);
    await assert.rejects(aplicarMigracoes(url, 'down', 5), (erro) => {
      assert.match(erro.message, /webhook do asaas com registros: down recusado/);
      assert.equal(erro.code, 'P0001');
      return true;
    });
    const { rows } = await pool.query(
      "SELECT to_regclass('asaas_webhook_evento') AS bruto, to_regclass('conta_titular') AS conta"
    );
    assert.notEqual(rows[0].bruto, null);
    assert.notEqual(rows[0].conta, null);
  });
});

test('CA14: o down com linha em conta_titular é recusado (P0001) e a coluna dominio_pago_em segue no pedido', async () => {
  await comBancoMigrado(async (url, pool) => {
    const { rows: [cliente] } = await pool.query(
      `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
       VALUES ('fisica', '52998224725', 'Fulana de Teste', 'fulana@exemplo.test', '11999990000') RETURNING id`
    );
    await pool.query("INSERT INTO conta_titular (cliente_id, email) VALUES ($1, 'a@exemplo.test')", [cliente.id]);
    await assert.rejects(aplicarMigracoes(url, 'down', 5), (erro) => {
      assert.equal(erro.code, 'P0001');
      return true;
    });
    const colunas = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pedido' AND column_name = 'dominio_pago_em'"
    );
    assert.equal(colunas.rows[0].n, 1);
  });
});

test('CA14: o down com as tabelas vazias remove as duas tabelas e a coluna, e o up seguinte as recria', async () => {
  await comBancoMigrado(async (url, pool) => {
    const contar = async () => (await pool.query(
      `SELECT (to_regclass('asaas_webhook_evento') IS NOT NULL)::int
            + (to_regclass('conta_titular') IS NOT NULL)::int
            + (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name = 'pedido' AND column_name = 'dominio_pago_em') AS n`
    )).rows[0].n;
    assert.equal(await contar(), 3);
    await aplicarMigracoes(url, 'down', 5);
    assert.equal(await contar(), 0);
    await aplicarMigracoes(url, 'up', 1);
    assert.equal(await contar(), 3);
  });
});
