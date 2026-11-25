// CIT-61, CA7 (banco): tabelas `cliente`, `pedido`, `pedido_dominio` e `assinatura`
// (migração `1795458432080_pedidos.sql`) e, da CIT-62, as 4 colunas do aceite dos termos
// (`1795478712105_pedido-aceite.sql`), contra um banco temporário migrado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { criarBancoTemporario, removerBancoTemporario, aplicarMigracoes } from './auxiliares.js';

let banco;
let contador = 0;

before(async () => {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url);
  } catch (erro) {
    await removerBancoTemporario(nomeBanco);
    throw erro;
  }
  banco = { nomeBanco, url, pool: new Pool({ connectionString: url, max: 3 }) };
});

after(async () => {
  await banco.pool.end();
  await removerBancoTemporario(banco.nomeBanco);
});

async function codigoDeErro(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro.code;
  }
  return undefined;
}

// Documento de 11 dígitos único por chamada (o banco só confere o formato).
function documentoUnico() {
  contador += 1;
  return String(10000000000 + contador);
}

async function inserirCliente(sobrescritas = {}) {
  const dados = {
    tipo_pessoa: 'fisica',
    documento: documentoUnico(),
    nome: 'Fulana de Teste',
    email: 'fulana@exemplo.test',
    telefone: '11999990000',
    asaas_cliente_id: null,
    ...sobrescritas
  };
  const { rows } = await banco.pool.query(
    `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone, asaas_cliente_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [dados.tipo_pessoa, dados.documento, dados.nome, dados.email, dados.telefone, dados.asaas_cliente_id]
  );
  return rows[0].id;
}

// Pedido mínimo válido; `estado` e `criando_desde` combinam por padrão ('criando' + agora).
async function inserirPedido(clienteId, sobrescritas = {}) {
  const dados = {
    chave: randomUUID(),
    estado: 'aguardando_pagamento',
    criando_desde: null,
    falha_motivo: null,
    ...sobrescritas
  };
  const { rows } = await banco.pool.query(
    `INSERT INTO pedido (cliente_id, chave_idempotencia, corpo_hash, estado, criando_desde, ciclo, itens,
                         total_centavos, versao_tabela_precos, contato_nome, contato_email, contato_telefone, falha_motivo,
                         aceite_em, versao_termos, versao_privacidade, ip_aceite)
     VALUES ($1, $2, repeat('a', 64), $3, $4, 'mensal', '{}'::jsonb, 7250, '2026-11-07.1',
             'Fulana de Teste', 'fulana@exemplo.test', '11999990000', $5,
             now(), '0.1', 'externa-2026-11-23', '203.0.113.7') RETURNING id`,
    [clienteId, dados.chave, dados.estado, dados.criando_desde, dados.falha_motivo]
  );
  return rows[0].id;
}

function inserirAssinatura(pedidoId, clienteId, sobrescritas = {}) {
  const dados = { tipo: 'contas', ciclo: 'mensal', valor: 7250, asaasId: `sub_${randomUUID().replaceAll('-', '')}`, ...sobrescritas };
  return banco.pool.query(
    `INSERT INTO assinatura (pedido_id, cliente_id, tipo, ciclo, valor_centavos, asaas_assinatura_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [pedidoId, clienteId, dados.tipo, dados.ciclo, dados.valor, dados.asaasId]
  );
}

function inserirDominio(pedidoId, nome, papel = 'principal', tipo = 'novo') {
  return banco.pool.query(
    'INSERT INTO pedido_dominio (pedido_id, nome, tipo, papel) VALUES ($1, $2, $3, $4)',
    [pedidoId, nome, tipo, papel]
  );
}

// ---------------------------------------------------------------------------
// CHECKs
// ---------------------------------------------------------------------------

test('CA7: o pedido aceita os 9 estados do modelo (criando com criando_desde, os demais sem)', async () => {
  const clienteId = await inserirCliente();
  await inserirPedido(clienteId, { estado: 'criando', criando_desde: new Date() });
  for (const estado of [
    'aguardando_pagamento', 'aguardando_pagamento_do_dominio', 'aguardando_registro_de_dominio', 'pago',
    'ativo', 'cancelado'
  ]) {
    await inserirPedido(clienteId, { estado });
  }
  await inserirPedido(clienteId, { estado: 'falhou_na_criacao', falha_motivo: 'asaas_timeout' });
  await inserirPedido(clienteId, { estado: 'falha_no_provisionamento', falha_motivo: 'dominio_recusado' });
});

test('CA7: estado fora da lista é recusado pelo CHECK (23514)', async () => {
  const clienteId = await inserirCliente();
  assert.equal(await codigoDeErro(inserirPedido(clienteId, { estado: 'inventado' })), '23514');
});

test('CA7: estado criando sem criando_desde é recusado pelo CHECK (23514)', async () => {
  const clienteId = await inserirCliente();
  assert.equal(await codigoDeErro(inserirPedido(clienteId, { estado: 'criando', criando_desde: null })), '23514');
});

test('CA7: estado diferente de criando com criando_desde é recusado pelo CHECK (23514)', async () => {
  const clienteId = await inserirCliente();
  assert.equal(
    await codigoDeErro(inserirPedido(clienteId, { estado: 'aguardando_pagamento', criando_desde: new Date() })),
    '23514'
  );
});

test('CA7: falhou_na_criacao sem falha_motivo é recusado pelo CHECK (23514)', async () => {
  const clienteId = await inserirCliente();
  assert.equal(await codigoDeErro(inserirPedido(clienteId, { estado: 'falhou_na_criacao' })), '23514');
});

test('CA7: falha_motivo num estado que não é de falha é recusado pelo CHECK (23514)', async () => {
  const clienteId = await inserirCliente();
  assert.equal(
    await codigoDeErro(inserirPedido(clienteId, { estado: 'aguardando_pagamento', falha_motivo: 'asaas_timeout' })),
    '23514'
  );
});

for (const motivo of ['Asaas-Timeout', '1abc', 'tem espaço', 'a'.repeat(49), '']) {
  test(`CA7: falha_motivo ${JSON.stringify(motivo.slice(0, 20))} fora do formato é recusado (23514)`, async () => {
    const clienteId = await inserirCliente();
    assert.equal(
      await codigoDeErro(inserirPedido(clienteId, { estado: 'falhou_na_criacao', falha_motivo: motivo })),
      '23514'
    );
  });
}

test('CA7: o cliente recusa tipo_pessoa que não bate com o tamanho do documento (23514)', async () => {
  assert.equal(await codigoDeErro(inserirCliente({ tipo_pessoa: 'juridica' })), '23514');
  assert.equal(await codigoDeErro(inserirCliente({ tipo_pessoa: 'fisica', documento: '12ABC34501DE35' })), '23514');
});

test('CA7: o cliente aceita CNPJ alfanumérico como pessoa juridica', async () => {
  await inserirCliente({ tipo_pessoa: 'juridica', documento: `${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}35` });
});

test('CA7: o cliente recusa documento com máscara ou minúsculas (23514)', async () => {
  assert.equal(await codigoDeErro(inserirCliente({ documento: '529.982.247-25' })), '23514');
  assert.equal(await codigoDeErro(inserirCliente({ tipo_pessoa: 'juridica', documento: '12abc34501de35' })), '23514');
});

test('CA7: a assinatura de domínios só aceita ciclo anual (23514)', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  assert.equal(await codigoDeErro(inserirAssinatura(pedidoId, clienteId, { tipo: 'dominios', ciclo: 'mensal' })), '23514');
  await inserirAssinatura(pedidoId, clienteId, { tipo: 'dominios', ciclo: 'anual', valor: 7900 });
});

test('CA7: a assinatura recusa valor zero, tipo desconhecido e asaas_assinatura_id fora do padrão (23514)', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  assert.equal(await codigoDeErro(inserirAssinatura(pedidoId, clienteId, { valor: 0 })), '23514');
  assert.equal(await codigoDeErro(inserirAssinatura(pedidoId, clienteId, { tipo: 'outro' })), '23514');
  assert.equal(await codigoDeErro(inserirAssinatura(pedidoId, clienteId, { asaasId: 'sub com espaço' })), '23514');
});

test('CA7: o estado da assinatura nasce ativa', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  await inserirAssinatura(pedidoId, clienteId);
  const { rows } = await banco.pool.query('SELECT estado FROM assinatura WHERE pedido_id = $1', [pedidoId]);
  assert.equal(rows[0].estado, 'ativa');
});

test('CA7: url_primeira_fatura só aceita https:// (23514)', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  await inserirAssinatura(pedidoId, clienteId);
  assert.equal(
    await codigoDeErro(banco.pool.query("UPDATE assinatura SET url_primeira_fatura = 'http://stub.test/f/1' WHERE pedido_id = $1", [pedidoId])),
    '23514'
  );
  await banco.pool.query("UPDATE assinatura SET url_primeira_fatura = 'https://stub.test/f/1' WHERE pedido_id = $1", [pedidoId]);
});

test('CA7: o domínio extra só pode ser novo (23514)', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  assert.equal(await codigoDeErro(inserirDominio(pedidoId, 'extra-existente.com', 'extra', 'existente')), '23514');
});

// ---------------------------------------------------------------------------
// Únicos (23505)
// ---------------------------------------------------------------------------

test('CA7: documento do cliente é único (23505)', async () => {
  const documento = documentoUnico();
  await inserirCliente({ documento });
  assert.equal(await codigoDeErro(inserirCliente({ documento })), '23505');
});

test('CA7: asaas_cliente_id é único (23505)', async () => {
  const asaasClienteId = `cus_${randomUUID().replaceAll('-', '')}`;
  await inserirCliente({ asaas_cliente_id: asaasClienteId });
  assert.equal(await codigoDeErro(inserirCliente({ asaas_cliente_id: asaasClienteId })), '23505');
});

test('CA7: chave_idempotencia do pedido é única (23505)', async () => {
  const clienteId = await inserirCliente();
  const chave = randomUUID();
  await inserirPedido(clienteId, { chave });
  assert.equal(await codigoDeErro(inserirPedido(clienteId, { chave })), '23505');
});

test('CA7: asaas_assinatura_id é único entre pedidos (23505)', async () => {
  const clienteId = await inserirCliente();
  const asaasId = `sub_${randomUUID().replaceAll('-', '')}`;
  await inserirAssinatura(await inserirPedido(clienteId), clienteId, { asaasId });
  assert.equal(await codigoDeErro(inserirAssinatura(await inserirPedido(clienteId), clienteId, { asaasId })), '23505');
});

test('CA7: só uma assinatura por tipo em cada pedido (23505)', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  await inserirAssinatura(pedidoId, clienteId);
  assert.equal(await codigoDeErro(inserirAssinatura(pedidoId, clienteId)), '23505');
});

test('CA7: o nome do domínio é único dentro do pedido, mas pode se repetir em outro pedido (23505)', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  await inserirDominio(pedidoId, 'exemplo-ficticio.com.br');
  assert.equal(await codigoDeErro(inserirDominio(pedidoId, 'exemplo-ficticio.com.br', 'extra')), '23505');
  await inserirDominio(await inserirPedido(clienteId), 'exemplo-ficticio.com.br');
});

test('CA7: o pedido tem no máximo um domínio principal (23505)', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  await inserirDominio(pedidoId, 'um-ficticio.com.br');
  assert.equal(await codigoDeErro(inserirDominio(pedidoId, 'dois-ficticio.com.br')), '23505');
});

test('CA7: ON CONFLICT (chave_idempotencia) DO NOTHING não devolve linha na 2ª inserção', async () => {
  const clienteId = await inserirCliente();
  const chave = randomUUID();
  await inserirPedido(clienteId, { chave });
  const { rows } = await banco.pool.query(
    `INSERT INTO pedido (cliente_id, chave_idempotencia, corpo_hash, estado, ciclo, itens, total_centavos,
                         versao_tabela_precos, contato_nome, contato_email, contato_telefone,
                         aceite_em, versao_termos, versao_privacidade, ip_aceite)
     VALUES ($1, $2, repeat('b', 64), 'aguardando_pagamento', 'mensal', '{}'::jsonb, 100, 'v',
             'Fulana de Teste', 'fulana@exemplo.test', '11999990000',
             now(), '0.1', 'externa-2026-11-23', '203.0.113.7')
     ON CONFLICT (chave_idempotencia) DO NOTHING RETURNING id`,
    [clienteId, chave]
  );
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// Sem cartão, privilégios e down
// ---------------------------------------------------------------------------

test('CA6: nenhuma coluna das tabelas novas tem card ou cart no nome', async () => {
  const { rows } = await banco.pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('cliente', 'pedido', 'pedido_dominio', 'assinatura')`
  );
  assert.ok(rows.length > 20, 'a consulta precisa enxergar as colunas das 4 tabelas');
  assert.deepEqual(rows.filter((c) => /card|cart/i.test(c.column_name)), []);
});

async function privilegioDeColuna(tabela, coluna, tipo) {
  const papel = `${banco.nomeBanco}_aplicacao`;
  const { rows } = await banco.pool.query('SELECT has_column_privilege($1, $2, $3, $4) AS ok', [papel, tabela, coluna, tipo]);
  return rows[0].ok;
}

const COLUNAS = {
  cliente: ['id', 'tipo_pessoa', 'documento', 'nome', 'email', 'telefone', 'asaas_cliente_id', 'asaas_contato_confere', 'anonimizado_em', 'criado_em', 'atualizado_em'],
  pedido: [
    'id', 'cliente_id', 'chave_idempotencia', 'corpo_hash', 'estado', 'criando_desde', 'ciclo', 'itens', 'total_centavos',
    'versao_tabela_precos', 'contato_nome', 'contato_email', 'contato_telefone', 'falha_motivo', 'request_id',
    'fatura_retida', 'aceite_em', 'versao_termos', 'versao_privacidade', 'ip_aceite', 'dominio_pago_em', 'dominio_registrado_em', 'token_hash', 'criado_em', 'atualizado_em'
  ],
  pedido_dominio: ['id', 'pedido_id', 'nome', 'tipo', 'papel', 'registrado_em', 'registro_expira_em', 'criado_em', 'atualizado_em'],
  assinatura: [
    'id', 'pedido_id', 'cliente_id', 'tipo', 'ciclo', 'valor_centavos', 'estado', 'asaas_assinatura_id',
    'url_primeira_fatura', 'criado_em', 'atualizado_em'
  ]
};

test('CA7: as 4 tabelas têm exatamente as colunas do modelo (nada de coluna a mais sem teste)', async () => {
  for (const [tabela, esperadas] of Object.entries(COLUNAS)) {
    const { rows } = await banco.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [tabela]
    );
    assert.deepEqual(rows.map((r) => r.column_name).sort(), [...esperadas].sort(), tabela);
  }
});

test('CA7: o papel <banco>_aplicacao lê todas as colunas das 4 tabelas', async () => {
  for (const [tabela, colunas] of Object.entries(COLUNAS)) {
    for (const coluna of colunas) {
      assert.equal(await privilegioDeColuna(tabela, coluna, 'SELECT'), true, `SELECT ${tabela}.${coluna}`);
    }
  }
});

const INSERIVEIS = {
  cliente: ['tipo_pessoa', 'documento', 'nome', 'email', 'telefone'],
  pedido: [
    'cliente_id', 'chave_idempotencia', 'corpo_hash', 'estado', 'criando_desde', 'ciclo', 'itens', 'total_centavos',
    'versao_tabela_precos', 'contato_nome', 'contato_email', 'contato_telefone', 'request_id',
    'aceite_em', 'versao_termos', 'versao_privacidade', 'ip_aceite'
  ],
  pedido_dominio: ['pedido_id', 'nome', 'tipo', 'papel'],
  assinatura: ['pedido_id', 'cliente_id', 'tipo', 'ciclo', 'valor_centavos', 'asaas_assinatura_id', 'url_primeira_fatura']
};

test('CA7: o papel <banco>_aplicacao insere exatamente as colunas que o serviço grava', async () => {
  for (const [tabela, colunas] of Object.entries(COLUNAS)) {
    for (const coluna of colunas) {
      const esperado = INSERIVEIS[tabela].includes(coluna);
      assert.equal(await privilegioDeColuna(tabela, coluna, 'INSERT'), esperado, `INSERT ${tabela}.${coluna}`);
    }
  }
});

const ATUALIZAVEIS = ['cliente.asaas_cliente_id', 'cliente.asaas_contato_confere', 'pedido.estado', 'pedido.falha_motivo', 'pedido.criando_desde', 'pedido.fatura_retida', 'pedido.dominio_pago_em', 'pedido.token_hash', 'pedido.dominio_registrado_em', 'pedido_dominio.registrado_em', 'pedido_dominio.registro_expira_em'];

test('CA7: o papel <banco>_aplicacao atualiza só as colunas do fluxo de criação, do pagamento (CIT-64) e do registro de domínio (CIT-77)', async () => {
  for (const [tabela, colunas] of Object.entries(COLUNAS)) {
    for (const coluna of colunas) {
      const esperado = ATUALIZAVEIS.includes(`${tabela}.${coluna}`);
      assert.equal(await privilegioDeColuna(tabela, coluna, 'UPDATE'), esperado, `UPDATE ${tabela}.${coluna}`);
    }
  }
});

test('CA7: fatura_retida nasce false, é NOT NULL e o papel <banco>_aplicacao a atualiza mas não a insere', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId);
  const { rows } = await banco.pool.query('SELECT fatura_retida FROM pedido WHERE id = $1', [pedidoId]);
  assert.equal(rows[0].fatura_retida, false);
  assert.equal(await codigoDeErro(banco.pool.query('UPDATE pedido SET fatura_retida = NULL WHERE id = $1', [pedidoId])), '23502');
  assert.equal(await privilegioDeColuna('pedido', 'fatura_retida', 'UPDATE'), true);
  assert.equal(await privilegioDeColuna('pedido', 'fatura_retida', 'INSERT'), false);
});

test('CA7: asaas_contato_confere nasce false, é NOT NULL e o papel <banco>_aplicacao a atualiza mas não a insere', async () => {
  const clienteId = await inserirCliente();
  const { rows } = await banco.pool.query('SELECT asaas_contato_confere FROM cliente WHERE id = $1', [clienteId]);
  assert.equal(rows[0].asaas_contato_confere, false);
  assert.equal(
    await codigoDeErro(banco.pool.query('UPDATE cliente SET asaas_contato_confere = NULL WHERE id = $1', [clienteId])),
    '23502'
  );
  assert.equal(await privilegioDeColuna('cliente', 'asaas_contato_confere', 'UPDATE'), true);
  assert.equal(await privilegioDeColuna('cliente', 'asaas_contato_confere', 'INSERT'), false);
});

test('CA7: o papel <banco>_aplicacao não atualiza pedido.total_centavos nem pedido.contato_email', async () => {
  assert.equal(await privilegioDeColuna('pedido', 'total_centavos', 'UPDATE'), false);
  assert.equal(await privilegioDeColuna('pedido', 'contato_email', 'UPDATE'), false);
});

test('CA7: o papel <banco>_aplicacao não tem DELETE em nenhuma das 4 tabelas', async () => {
  const papel = `${banco.nomeBanco}_aplicacao`;
  for (const tabela of Object.keys(COLUNAS)) {
    const { rows } = await banco.pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [papel, tabela, 'DELETE']);
    assert.equal(rows[0].ok, false, `${tabela} não deveria aceitar DELETE`);
  }
});

test('CA7: o papel <banco>_aplicacao não tem TRUNCATE em nenhuma das 4 tabelas', async () => {
  const papel = `${banco.nomeBanco}_aplicacao`;
  for (const tabela of Object.keys(COLUNAS)) {
    const { rows } = await banco.pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [papel, tabela, 'TRUNCATE']);
    assert.equal(rows[0].ok, false, `${tabela} não deveria aceitar TRUNCATE`);
  }
});

test('CA7: o trigger atualiza atualizado_em do pedido a cada UPDATE', async () => {
  const clienteId = await inserirCliente();
  const pedidoId = await inserirPedido(clienteId, { estado: 'criando', criando_desde: new Date() });
  await banco.pool.query(
    "UPDATE pedido SET estado = 'aguardando_pagamento', criando_desde = NULL, atualizado_em = '2000-01-01' WHERE id = $1",
    [pedidoId]
  );
  const depois = await banco.pool.query('SELECT atualizado_em FROM pedido WHERE id = $1', [pedidoId]);
  assert.ok(depois.rows[0].atualizado_em > new Date('2001-01-01'), 'o trigger sobrescreve o atualizado_em informado');
});

test('CA7: o down com registros é recusado com P0001 e as tabelas continuam', async () => {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      await pool.query(
        `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
         VALUES ('fisica', '52998224725', 'Fulana de Teste', 'fulana@exemplo.test', '11999990000')`
      );
      // `1795458432080_pedidos` é a antepenúltima migração (depois dela vêm o aceite, CIT-62, e o webhook, CIT-64, que
      // desfaz sem erro com `pedido` vazio): o down de 3 passos chega a ela.
      await assert.rejects(aplicarMigracoes(url, 'down', 7), /pedidos com registros: down recusado/);
      const { rows } = await pool.query("SELECT to_regclass('cliente') AS cliente, to_regclass('assinatura') AS assinatura");
      assert.notEqual(rows[0].cliente, null);
      assert.notEqual(rows[0].assinatura, null);
    } finally {
      await pool.end();
    }
  } finally {
    await removerBancoTemporario(nomeBanco);
  }
});

test('CA7: o down com as tabelas vazias remove as 4 tabelas e o up seguinte as recria', async () => {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url);
    await aplicarMigracoes(url, 'down', 7);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const sem = await pool.query(
        "SELECT to_regclass('cliente') AS c, to_regclass('pedido') AS p, to_regclass('pedido_dominio') AS d, to_regclass('assinatura') AS a"
      );
      assert.deepEqual(sem.rows[0], { c: null, p: null, d: null, a: null });
      await aplicarMigracoes(url);
      const com = await pool.query("SELECT to_regclass('pedido') AS p, to_regclass('assinatura') AS a");
      assert.notEqual(com.rows[0].p, null);
      assert.notEqual(com.rows[0].a, null);
    } finally {
      await pool.end();
    }
  } finally {
    await removerBancoTemporario(nomeBanco);
  }
});

// ---------------------------------------------------------------------------
// CIT-62: aceite dos termos no pedido (os nomes CA<n> seguem o plano da CIT-62)
// ---------------------------------------------------------------------------

const INSERT_PEDIDO_BASE = `
  INSERT INTO pedido (cliente_id, chave_idempotencia, corpo_hash, estado, ciclo, itens, total_centavos,
                      versao_tabela_precos, contato_nome, contato_email, contato_telefone`;

// Pedido com as colunas da migração anterior; só o `INSERT` direto, sem as do aceite.
function inserirPedidoSemAceite(executor, clienteId) {
  return executor.query(
    `${INSERT_PEDIDO_BASE})
     VALUES ($1, $2, repeat('c', 64), 'aguardando_pagamento', 'mensal', '{}'::jsonb, 100, 'v',
             'Fulana de Teste', 'fulana@exemplo.test', '11999990000') RETURNING id`,
    [clienteId, randomUUID()]
  );
}

function inserirPedidoComAceite(versaoTermos, versaoPrivacidade) {
  return async (clienteId) => banco.pool.query(
    `${INSERT_PEDIDO_BASE}, aceite_em, versao_termos, versao_privacidade, ip_aceite)
     VALUES ($1, $2, repeat('d', 64), 'aguardando_pagamento', 'mensal', '{}'::jsonb, 100, 'v',
             'Fulana de Teste', 'fulana@exemplo.test', '11999990000', now(), $3, $4, '203.0.113.7')`,
    [clienteId, randomUUID(), versaoTermos, versaoPrivacidade]
  );
}

test('CA6: INSERT direto sem as colunas do aceite é recusado pelo NOT NULL (23502)', async () => {
  const clienteId = await inserirCliente();
  assert.equal(await codigoDeErro(inserirPedidoSemAceite(banco.pool, clienteId)), '23502');
});

for (const [rotulo, termos, privacidade] of [
  ['versao_termos com espaço', '0 1', 'externa-2026-11-23'],
  ['versao_termos vazia', '', 'externa-2026-11-23'],
  ['versao_termos com 33 caracteres', 'a'.repeat(33), 'externa-2026-11-23'],
  ['versao_privacidade com barra', '0.1', 'a/b'],
  ['versao_privacidade com 65 caracteres', '0.1', 'a'.repeat(65)],
]) {
  test(`CA6: ${rotulo} é recusada pelo CHECK (23514)`, async () => {
    const clienteId = await inserirCliente();
    assert.equal(await codigoDeErro(inserirPedidoComAceite(termos, privacidade)(clienteId)), '23514');
  });
}

test('CA6: versões nos limites (32 e 64 caracteres, com . _ -) são aceitas', async () => {
  const clienteId = await inserirCliente();
  await inserirPedidoComAceite('a'.repeat(31) + '.', 'B'.repeat(61) + '._-')(clienteId);
});

test('CA6: ip_aceite é inet: texto que não é IP é recusado (22P02)', async () => {
  const clienteId = await inserirCliente();
  const erro = await codigoDeErro(banco.pool.query(
    `${INSERT_PEDIDO_BASE}, aceite_em, versao_termos, versao_privacidade, ip_aceite)
     VALUES ($1, $2, repeat('e', 64), 'aguardando_pagamento', 'mensal', '{}'::jsonb, 100, 'v',
             'Fulana de Teste', 'fulana@exemplo.test', '11999990000', now(), '0.1', 'x', 'lixo')`,
    [clienteId, randomUUID()]
  ));
  assert.equal(erro, '22P02');
});

test('CA6: o papel <banco>_aplicacao insere as 4 colunas do aceite e não atualiza nenhuma', async () => {
  for (const coluna of ['aceite_em', 'versao_termos', 'versao_privacidade', 'ip_aceite']) {
    assert.equal(await privilegioDeColuna('pedido', coluna, 'INSERT'), true, `INSERT pedido.${coluna}`);
    assert.equal(await privilegioDeColuna('pedido', coluna, 'UPDATE'), false, `UPDATE pedido.${coluna}`);
  }
});

for (const [coluna, valor] of [['ip_aceite', "'198.51.100.1'"], ['aceite_em', 'now()']]) {
  test(`CA6: UPDATE de ${coluna} como o papel <banco>_aplicacao é negado (42501)`, async () => {
    const clienteId = await inserirCliente();
    const pedidoId = await inserirPedido(clienteId);
    const conexao = await banco.pool.connect();
    try {
      await conexao.query(`SET ROLE "${banco.nomeBanco}_aplicacao"`);
      assert.equal(await codigoDeErro(conexao.query(`UPDATE pedido SET ${coluna} = ${valor} WHERE id = $1`, [pedidoId])), '42501');
    } finally {
      await conexao.query('RESET ROLE');
      conexao.release();
    }
  });
}

async function comBancoAte(migracoes, corpo) {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url, 'up', migracoes);
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

test('CA6: o up do aceite com um pedido já existente é recusado (P0001) e nada é alterado', async () => {
  // As 4 primeiras migrações (funcao, auditoria, eventos, pedidos) deixam o banco sem as colunas.
  await comBancoAte(4, async (url, pool) => {
    const { rows } = await pool.query(
      `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
       VALUES ('fisica', '52998224725', 'Fulana de Teste', 'fulana@exemplo.test', '11999990000') RETURNING id`
    );
    await inserirPedidoSemAceite(pool, rows[0].id);

    await assert.rejects(aplicarMigracoes(url, 'up', 1), (erro) => {
      assert.match(erro.message, /pedido sem aceite: limpe os pedidos de teste antes de aplicar \(CIT-62\)/);
      assert.equal(erro.code, 'P0001');
      return true;
    });
    const colunas = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pedido' AND column_name = 'ip_aceite'"
    );
    assert.equal(colunas.rows[0].n, 0);
  });
});

test('CA6: o down do aceite com um pedido é recusado (P0001) e as colunas continuam', async () => {
  await comBancoAte(Infinity, async (url, pool) => {
    const clienteId = (await pool.query(
      `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
       VALUES ('fisica', '52998224725', 'Fulana de Teste', 'fulana@exemplo.test', '11999990000') RETURNING id`
    )).rows[0].id;
    await pool.query(
      `${INSERT_PEDIDO_BASE}, aceite_em, versao_termos, versao_privacidade, ip_aceite)
       VALUES ($1, $2, repeat('f', 64), 'aguardando_pagamento', 'mensal', '{}'::jsonb, 100, 'v',
               'Fulana de Teste', 'fulana@exemplo.test', '11999990000', now(), '0.1', 'x', '203.0.113.7')`,
      [clienteId, randomUUID()]
    );

    await assert.rejects(aplicarMigracoes(url, 'down', 6), (erro) => {
      assert.match(erro.message, /pedidos com aceite: down recusado/);
      assert.equal(erro.code, 'P0001');
      return true;
    });
    const colunas = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pedido' AND column_name = 'ip_aceite'"
    );
    assert.equal(colunas.rows[0].n, 1);
  });
});

test('CA6: o aceite sobe e desce em banco vazio, e o up seguinte o recria', async () => {
  await comBancoAte(Infinity, async (url, pool) => {
    const contarColunas = async () => (await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'pedido' AND column_name IN ('aceite_em', 'versao_termos', 'versao_privacidade', 'ip_aceite')`
    )).rows[0].n;
    assert.equal(await contarColunas(), 4);
    await aplicarMigracoes(url, 'down', 6);
    assert.equal(await contarColunas(), 0);
    await aplicarMigracoes(url, 'up', 1);
    assert.equal(await contarColunas(), 4);
  });
});
