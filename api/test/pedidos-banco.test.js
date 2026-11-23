// CIT-61, CA7 (banco): tabelas `cliente`, `pedido`, `pedido_dominio` e `assinatura`
// (migração `1795458432080_pedidos.sql`), contra um banco temporário migrado.
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
                         total_centavos, versao_tabela_precos, contato_nome, contato_email, contato_telefone, falha_motivo)
     VALUES ($1, $2, repeat('a', 64), $3, $4, 'mensal', '{}'::jsonb, 7250, '2026-11-07.1',
             'Fulana de Teste', 'fulana@exemplo.test', '11999990000', $5) RETURNING id`,
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
                         versao_tabela_precos, contato_nome, contato_email, contato_telefone)
     VALUES ($1, $2, repeat('b', 64), 'aguardando_pagamento', 'mensal', '{}'::jsonb, 100, 'v',
             'Fulana de Teste', 'fulana@exemplo.test', '11999990000')
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
  cliente: ['id', 'tipo_pessoa', 'documento', 'nome', 'email', 'telefone', 'asaas_cliente_id', 'anonimizado_em', 'criado_em', 'atualizado_em'],
  pedido: [
    'id', 'cliente_id', 'chave_idempotencia', 'corpo_hash', 'estado', 'criando_desde', 'ciclo', 'itens', 'total_centavos',
    'versao_tabela_precos', 'contato_nome', 'contato_email', 'contato_telefone', 'falha_motivo', 'request_id', 'criado_em', 'atualizado_em'
  ],
  pedido_dominio: ['id', 'pedido_id', 'nome', 'tipo', 'papel', 'criado_em', 'atualizado_em'],
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
    'versao_tabela_precos', 'contato_nome', 'contato_email', 'contato_telefone', 'request_id'
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

const ATUALIZAVEIS = ['cliente.asaas_cliente_id', 'pedido.estado', 'pedido.falha_motivo', 'pedido.criando_desde'];

test('CA7: o papel <banco>_aplicacao atualiza só as 4 colunas do fluxo de criação', async () => {
  for (const [tabela, colunas] of Object.entries(COLUNAS)) {
    for (const coluna of colunas) {
      const esperado = ATUALIZAVEIS.includes(`${tabela}.${coluna}`);
      assert.equal(await privilegioDeColuna(tabela, coluna, 'UPDATE'), esperado, `UPDATE ${tabela}.${coluna}`);
    }
  }
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
      // `1795458432080_pedidos` é a última migração: o down de 1 passo a desfaz.
      await assert.rejects(aplicarMigracoes(url, 'down', 1), /pedidos com registros: down recusado/);
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
    await aplicarMigracoes(url, 'down', 1);
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
