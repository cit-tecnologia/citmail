import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Pool } from 'pg';
import {
  criarBancoTemporario,
  removerBancoTemporario,
  aplicarMigracoes,
  urlAdminTeste,
} from './auxiliares.js';
import { registrarAuditoria } from '../src/auditoria/servico.js';

async function criarBancoMigrado() {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url);
  } catch (erro) {
    await removerBancoTemporario(nomeBanco);
    throw erro;
  }
  const pool = new Pool({ connectionString: url, max: 2 });
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
  return {
    autor: { tipo: 'cliente', id: '42' },
    acao: 'senha_trocada',
    alvo: { tipo: 'conta', id: '42' },
    resultado: 'sucesso',
    ip: '203.0.113.5',
    requestId: 'req-teste-1',
    detalhes: { canal: 'painel' },
    ...sobrescritas,
  };
}

// Premissa do ambiente de teste e da CI: o usuário é superusuário (`postgres`),
// o que permite `SET ROLE` para os papéis de teste.
async function exigirSuperusuario(pool) {
  const { rows } = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  assert.equal(rows[0]?.rolsuper, true, 'premissa do teste: o usuário do banco de teste precisa ser superusuário');
}

async function consultar(url, sql, parametros = []) {
  const cliente = new Client({ connectionString: url });
  await cliente.connect();
  try {
    return await cliente.query(sql, parametros);
  } finally {
    await cliente.end();
  }
}

async function papelExiste(nome) {
  const { rowCount } = await consultar(urlAdminTeste(), 'SELECT 1 FROM pg_roles WHERE rolname = $1', [nome]);
  return rowCount === 1;
}

async function lerTudo(pool) {
  const { rows } = await pool.query('SELECT * FROM auditoria ORDER BY id');
  return rows;
}

async function contar(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM auditoria');
  return rows[0].total;
}

// Executa `fn(client)` numa transação com `SET LOCAL ROLE <papel>`. Termina em
// COMMIT quando `confirmar`, senão em ROLLBACK; o client volta limpo ao pool.
async function comPapel(pool, papel, fn, { confirmar = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE "${papel}"`);
    const resultado = await fn(client);
    if (confirmar) await client.query('COMMIT');
    return resultado;
  } finally {
    if (!confirmar) await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const INSERT_BASE = `INSERT INTO auditoria (autor_tipo, autor_id, acao, alvo_tipo, alvo_id, resultado, ip)
  VALUES ('cliente','1','senha_trocada','conta','1','sucesso', $1)`;

// CA2 (SQL) -----------------------------------------------------------------

test('CA2: INSERT por SQL com ação fora do vocabulário viola o CHECK (23514)', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);

  await assert.rejects(
    pool.query(
      `INSERT INTO auditoria (autor_tipo, autor_id, acao, alvo_tipo, alvo_id, resultado, ip)
       VALUES ('cliente','1','apagou_tudo','conta','1','sucesso','203.0.113.5')`,
    ),
    { code: '23514' },
  );
  assert.equal(await contar(pool), 0);
});

// CA3 -----------------------------------------------------------------------

test('CA3: trigger bloqueia UPDATE, DELETE e TRUNCATE até para o dono e a linha segue igual', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);
  await registrarAuditoria(pool, dadosValidos());
  const [original] = await lerTudo(pool);

  const bloqueios = [
    "UPDATE auditoria SET resultado = 'falha'",
    "UPDATE auditoria SET ip = '203.0.113.9'",
    'DELETE FROM auditoria',
    'TRUNCATE auditoria',
  ];
  for (const sql of bloqueios) {
    await assert.rejects(pool.query(sql), { code: 'P0001', message: /auditoria só de inclusão/ }, sql);
  }

  assert.deepStrictEqual(await lerTudo(pool), [original]);
  assert.equal(await contar(pool), 1);
});

test('CA3b: papel de retenção altera só o ip; outra coluna e DELETE seguem bloqueados', async (t) => {
  const { pool, banco, fechar } = await criarBancoMigrado();
  t.after(fechar);
  await registrarAuditoria(pool, dadosValidos());
  const [original] = await lerTudo(pool);

  const retencao = `${banco}_retencao`;
  await pool.query(`CREATE ROLE "${retencao}" NOLOGIN`);
  await pool.query(`GRANT SELECT, UPDATE, DELETE ON auditoria TO "${retencao}"`);

  await comPapel(
    pool,
    retencao,
    (client) => client.query("UPDATE auditoria SET ip = '203.0.113.0'"),
    { confirmar: true },
  );
  const { rows } = await pool.query(
    `SELECT ip::text AS ip_texto, id, ocorrido_em, autor_tipo, autor_id, acao, alvo_tipo, alvo_id,
            resultado, request_id, detalhes
       FROM auditoria`,
  );
  const originalSemIp = { ...original };
  delete originalSemIp.ip;
  const { ip_texto: ipTexto, ...novoSemIp } = rows[0];
  assert.equal(ipTexto, '203.0.113.0/32');
  assert.deepStrictEqual(novoSemIp, originalSemIp);

  await assert.rejects(
    comPapel(pool, retencao, (client) =>
      client.query("UPDATE auditoria SET ip = '203.0.113.1', resultado = 'falha'")),
    { code: 'P0001' },
  );
  await assert.rejects(
    comPapel(pool, retencao, (client) => client.query('DELETE FROM auditoria')),
    { code: 'P0001' },
  );
  assert.equal(await contar(pool), 1);
  assert.equal((await lerTudo(pool))[0].resultado, original.resultado);
});

// CA4 -----------------------------------------------------------------------

test('CA4: papel da aplicação consegue INSERT e SELECT', async (t) => {
  const { pool, banco, fechar } = await criarBancoMigrado();
  t.after(fechar);
  await exigirSuperusuario(pool);
  const papel = `${banco}_aplicacao`;

  await comPapel(pool, papel, async (client) => {
    assert.equal((await client.query('SELECT current_user AS usuario')).rows[0].usuario, papel);
    const id = await registrarAuditoria(client, dadosValidos());
    assert.match(id, /^\d+$/);
    const { rows } = await client.query('SELECT count(*)::int AS total FROM auditoria');
    assert.equal(rows[0].total, 1);
  });
});

test('CA4: papel da aplicação recebe 42501 em UPDATE, DELETE e TRUNCATE e a linha segue igual', async (t) => {
  const { pool, banco, fechar } = await criarBancoMigrado();
  t.after(fechar);
  await exigirSuperusuario(pool);
  const papel = `${banco}_aplicacao`;
  await registrarAuditoria(pool, dadosValidos());
  const [original] = await lerTudo(pool);

  for (const sql of ["UPDATE auditoria SET resultado = 'falha'", 'DELETE FROM auditoria', 'TRUNCATE auditoria']) {
    await assert.rejects(comPapel(pool, papel, (client) => client.query(sql)), { code: '42501' }, sql);
  }

  assert.deepStrictEqual(await lerTudo(pool), [original]);
});

test('CA4: has_table_privilege do papel da aplicação é true só para SELECT (INSERT é por coluna)', async (t) => {
  const { pool, banco, fechar } = await criarBancoMigrado();
  t.after(fechar);
  const papel = `${banco}_aplicacao`;

  const esperado = { INSERT: false, SELECT: true, UPDATE: false, DELETE: false, TRUNCATE: false };
  for (const [privilegio, valor] of Object.entries(esperado)) {
    const { rows } = await pool.query('SELECT has_table_privilege($1, $2, $3) AS tem', [
      papel,
      'auditoria',
      privilegio,
    ]);
    assert.equal(rows[0].tem, valor, privilegio);
  }
});

// CA5 (colunas) -------------------------------------------------------------

test('CA5: a tabela tem exatamente as 11 colunas previstas, sem coluna de senha nem token', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);

  const { rows } = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'auditoria' ORDER BY column_name",
  );

  assert.deepEqual(
    rows.map((linha) => linha.column_name),
    ['acao', 'alvo_id', 'alvo_tipo', 'autor_id', 'autor_tipo', 'detalhes', 'id', 'ip', 'ocorrido_em', 'request_id', 'resultado'],
  );
});

// CA7 (SQL) -----------------------------------------------------------------

test('CA7: INSERT por SQL com ip nulo e autor cliente viola o CHECK (23514)', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);

  await assert.rejects(pool.query(INSERT_BASE, [null]), { code: '23514' });
  assert.equal(await contar(pool), 0);
});

// CA9 -----------------------------------------------------------------------

test('CA9: migração cria um papel por banco, tem down com guarda e é reaplicável', async (t) => {
  const a = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(a.nomeBanco));
  const b = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(b.nomeBanco));
  const papelA = `${a.nomeBanco}_aplicacao`;
  const papelB = `${b.nomeBanco}_aplicacao`;

  await assert.doesNotReject(aplicarMigracoes(a.url));
  await assert.doesNotReject(aplicarMigracoes(b.url));
  assert.equal(await papelExiste(papelA), true, 'papel de A');
  assert.equal(await papelExiste(papelB), true, 'papel de B');

  const privilegioCruzado = await consultar(
    b.url,
    "SELECT has_column_privilege($1, 'auditoria', 'acao', 'INSERT') AS tem",
    [papelA],
  );
  assert.equal(privilegioCruzado.rows[0].tem, false, 'papel de A não deveria inserir no banco B');

  // down com registros é recusado e nada se perde.
  const poolA = new Pool({ connectionString: a.url, max: 1 });
  try {
    await registrarAuditoria(poolA, dadosValidos());
  } finally {
    await poolA.end();
  }
  // As migrações mais recentes (eventos, CIT-166, pedidos, CIT-61, aceite, CIT-62, e webhook, CIT-64) vêm depois da auditoria: saem primeiro.
  await aplicarMigracoes(a.url, 'down', 4);
  await assert.rejects(aplicarMigracoes(a.url, 'down', 1), /auditoria com registros/);
  const aposRecusa = await consultar(
    a.url,
    "SELECT to_regclass('public.auditoria') IS NOT NULL AS existe, (SELECT count(*)::int FROM auditoria) AS total",
  );
  assert.equal(aposRecusa.rows[0].existe, true);
  assert.equal(aposRecusa.rows[0].total, 1);

  // down com a tabela vazia apaga tabela e função, mas não o papel.
  await aplicarMigracoes(b.url, 'down', 4);
  await assert.doesNotReject(aplicarMigracoes(b.url, 'down', 1));
  const aposDown = await consultar(
    b.url,
    `SELECT to_regclass('public.auditoria') IS NULL AS sem_tabela,
            (SELECT count(*)::int FROM pg_proc WHERE proname IN ('auditoria_bloquear_alteracao', 'auditoria_definir_ocorrido_em')) AS funcoes,
            (SELECT count(*)::int FROM pg_proc WHERE proname = 'definir_atualizado_em') AS base,
            (SELECT count(*)::int FROM pgmigrations) AS migracoes`,
  );
  assert.deepEqual(aposDown.rows[0], { sem_tabela: true, funcoes: 0, base: 1, migracoes: 1 });
  assert.equal(await papelExiste(papelB), true, 'papel de B sobrevive ao down');

  // novo up recria tudo, com os mesmos privilégios.
  await assert.doesNotReject(aplicarMigracoes(b.url));
  const aposUp = await consultar(
    b.url,
    `SELECT has_column_privilege($1, 'auditoria', 'acao', 'INSERT') AS inserir,
            has_table_privilege($1, 'auditoria', 'UPDATE') AS atualizar`,
    [papelB],
  );
  assert.deepEqual(aposUp.rows[0], { inserir: true, atualizar: false });

  await removerBancoTemporario(a.nomeBanco);
  await removerBancoTemporario(b.nomeBanco);
  assert.equal(await papelExiste(papelA), false, 'papel de A deveria sumir com o banco');
  assert.equal(await papelExiste(papelB), false, 'papel de B deveria sumir com o banco');
});

// B1: horário e id fora do alcance da aplicação ----------------------------------------------

const COLUNAS_DA_APLICACAO = [
  'autor_tipo', 'autor_id', 'acao', 'alvo_tipo', 'alvo_id', 'resultado', 'ip', 'request_id', 'detalhes',
];

test('CA4: papel da aplicação recebe 42501 ao informar ocorrido_em ou id (inclusive OVERRIDING SYSTEM VALUE)', async (t) => {
  const { pool, banco, fechar } = await criarBancoMigrado();
  t.after(fechar);
  await exigirSuperusuario(pool);
  const papel = `${banco}_aplicacao`;

  const tentativas = [
    `INSERT INTO auditoria (ocorrido_em, autor_tipo, autor_id, acao, alvo_tipo, alvo_id, resultado, ip)
     VALUES ('2000-01-01', 'cliente','1','senha_trocada','conta','1','sucesso','203.0.113.5')`,
    `INSERT INTO auditoria (id, autor_tipo, autor_id, acao, alvo_tipo, alvo_id, resultado, ip)
     OVERRIDING SYSTEM VALUE VALUES (999, 'cliente','1','senha_trocada','conta','1','sucesso','203.0.113.5')`,
  ];
  for (const sql of tentativas) {
    await assert.rejects(comPapel(pool, papel, (client) => client.query(sql)), { code: '42501' }, sql);
  }

  assert.equal(await contar(pool), 0);
});

test('CA4: has_column_privilege de INSERT é true nas 9 colunas do serviço e false em id e ocorrido_em', async (t) => {
  const { pool, banco, fechar } = await criarBancoMigrado();
  t.after(fechar);
  const papel = `${banco}_aplicacao`;

  const esperado = { ...Object.fromEntries(COLUNAS_DA_APLICACAO.map((c) => [c, true])), id: false, ocorrido_em: false };
  for (const [coluna, valor] of Object.entries(esperado)) {
    const { rows } = await pool.query("SELECT has_column_privilege($1, 'auditoria', $2, 'INSERT') AS tem", [papel, coluna]);
    assert.equal(rows[0].tem, valor, coluna);
  }
});

test('CA1: dono que informa ocorrido_em grava o horário do banco, não o informado', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);

  const antes = new Date();
  const { rows } = await pool.query(
    `INSERT INTO auditoria (ocorrido_em, autor_tipo, autor_id, acao, alvo_tipo, alvo_id, resultado, ip)
     VALUES ('2000-01-01', 'cliente','1','senha_trocada','conta','1','sucesso','203.0.113.5')
     RETURNING ocorrido_em`,
  );
  const depois = new Date();

  assert.ok(rows[0].ocorrido_em >= antes && rows[0].ocorrido_em <= depois, 'ocorrido_em deveria ser o instante do banco');
});

// B2: search_path fixo ------------------------------------------------------------------------

test('CA3: as funções da migração fixam search_path em pg_catalog, pg_temp', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);

  const { rows } = await pool.query(
    `SELECT proname, proconfig FROM pg_proc
      WHERE proname IN ('auditoria_bloquear_alteracao', 'auditoria_definir_ocorrido_em') ORDER BY proname`,
  );

  assert.equal(rows.length, 2);
  for (const linha of rows) {
    assert.deepEqual(linha.proconfig, ['search_path=pg_catalog, pg_temp'], linha.proname);
  }
});

// L1: triggers valem com session_replication_role = replica ---------------------------------------

test('CA3: com session_replication_role = replica, UPDATE e DELETE do dono seguem bloqueados', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);
  await exigirSuperusuario(pool);
  await registrarAuditoria(pool, dadosValidos());

  const { rows } = await pool.query(
    "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'auditoria'::regclass AND NOT tgisinternal ORDER BY tgname",
  );
  assert.equal(rows.length, 3);
  for (const linha of rows) assert.equal(linha.tgenabled, 'A', linha.tgname);

  const client = await pool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await assert.rejects(client.query("UPDATE auditoria SET resultado = 'falha'"), { code: 'P0001' });
    await assert.rejects(client.query('DELETE FROM auditoria'), { code: 'P0001' });
  } finally {
    await client.query('RESET session_replication_role');
    client.release();
  }
  assert.equal(await contar(pool), 1);
});

// L2: papel pré-existente com poder demais -----------------------------------------------------------

test('CA9: up falha se o papel da aplicação já existe com LOGIN', async (t) => {
  const { nomeBanco, url } = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(nomeBanco));
  await consultar(urlAdminTeste(), `CREATE ROLE "${nomeBanco}_aplicacao" LOGIN`);

  await assert.rejects(aplicarMigracoes(url), /já existe com atributos ou herança não permitidos/);

  const { rows } = await consultar(url, "SELECT to_regclass('public.auditoria') IS NULL AS sem_tabela");
  assert.equal(rows[0].sem_tabela, true);
});

// L3 (SQL): id vazio ----------------------------------------------------------------------------------

test('CA2: INSERT por SQL com autor_id ou alvo_id vazio viola o CHECK (23514)', async (t) => {
  const { pool, fechar } = await criarBancoMigrado();
  t.after(fechar);

  const base = (autor, alvo) => pool.query(
    `INSERT INTO auditoria (autor_tipo, autor_id, acao, alvo_tipo, alvo_id, resultado, ip)
     VALUES ('cliente', $1, 'senha_trocada', 'conta', $2, 'sucesso', '203.0.113.5')`,
    [autor, alvo],
  );
  await assert.rejects(base('', '1'), { code: '23514' });
  await assert.rejects(base('1', ''), { code: '23514' });
  assert.equal(await contar(pool), 0);
});

// B3: o down espera INSERT em andamento e depois recusa ----------------------------------------------

test('CA9: down que concorre com um INSERT ainda não confirmado espera e recusa, sem perder o registro', async (t) => {
  const { pool, url, fechar } = await criarBancoMigrado();
  t.after(fechar);
  // As migrações mais recentes (eventos, CIT-166, pedidos, CIT-61, aceite, CIT-62, e webhook, CIT-64) vêm depois da auditoria: saem primeiro.
  await aplicarMigracoes(url, 'down', 4);

  const client = await pool.connect();
  let down;
  try {
    await client.query('BEGIN');
    await registrarAuditoria(client, dadosValidos());

    down = aplicarMigracoes(url, 'down', 1).then(() => null, (erro) => erro);
    const observador = new Client({ connectionString: url });
    await observador.connect();
    try {
      let esperando = false;
      for (let i = 0; i < 400 && !esperando; i++) {
        const { rowCount } = await observador.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%LOCK TABLE auditoria%'",
        );
        esperando = rowCount > 0;
        if (!esperando) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(esperando, 'o down deveria esperar o lock da tabela enquanto o INSERT não é confirmado');
    } finally {
      await observador.end();
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const erro = await down;
  assert.match(String(erro?.message), /auditoria com registros/);
  assert.equal(await contar(pool), 1);
});

// L2: papel pré-existente com atributos ou herança além do permitido ----------------------------------

const PAPEIS_AMPLOS = {
  'NOLOGIN com CREATEDB': (papel) => `CREATE ROLE "${papel}" NOLOGIN CREATEDB`,
  'NOLOGIN com BYPASSRLS': (papel) => `CREATE ROLE "${papel}" NOLOGIN BYPASSRLS`,
};

for (const [caso, criar] of Object.entries(PAPEIS_AMPLOS)) {
  test(`CA9: up falha se o papel da aplicação já existe ${caso}`, async (t) => {
    const { nomeBanco, url } = await criarBancoTemporario();
    t.after(() => removerBancoTemporario(nomeBanco));
    await consultar(urlAdminTeste(), criar(`${nomeBanco}_aplicacao`));

    await assert.rejects(aplicarMigracoes(url), /já existe com atributos ou herança não permitidos/);
  });
}

test('CA9: up falha se o papel da aplicação já existe como membro de outro papel', async (t) => {
  const { nomeBanco, url } = await criarBancoTemporario();
  t.after(() => removerBancoTemporario(nomeBanco));
  const papel = `${nomeBanco}_aplicacao`;
  await consultar(urlAdminTeste(), `CREATE ROLE "${papel}" NOLOGIN`);
  await consultar(urlAdminTeste(), `GRANT pg_read_all_data TO "${papel}"`);

  await assert.rejects(aplicarMigracoes(url), /já existe com atributos ou herança não permitidos/);
});
