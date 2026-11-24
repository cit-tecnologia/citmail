import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { criarBancoTemporario, removerBancoTemporario, aplicarMigracoes } from './auxiliares.js';
import { registrarAuditoria } from '../src/auditoria/servico.js';
import { ACOES, ALVOS, AUTORES, RESULTADOS } from '../src/auditoria/vocabulario.js';
import { camposSensiveis } from '../src/log.js';

const VALOR_SECRETO = 'valor-secreto-de-teste';

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

async function bancoDoTeste(t) {
  const banco = await criarBancoMigrado();
  t.after(banco.fechar);
  return banco.pool;
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

async function contar(pool) {
  const resultado = await pool.query('SELECT count(*)::int AS total FROM auditoria');
  return resultado.rows[0].total;
}

async function lerLinha(pool, id) {
  const resultado = await pool.query('SELECT *, ip::text AS ip_texto FROM auditoria WHERE id = $1', [id]);
  return resultado.rows[0];
}

// CA1 -----------------------------------------------------------------------

function dadosDaAcao(acao) {
  if (acao === 'login_falhou') {
    return dadosValidos({
      acao,
      autor: { tipo: 'cliente', id: null },
      alvo: { tipo: 'conta', id: null },
      resultado: 'falha',
    });
  }
  if (acao === 'dominio_registrado_manualmente') {
    return dadosValidos({
      acao,
      autor: { tipo: 'equipe', id: '7' },
      alvo: { tipo: 'dominio', id: '15' },
    });
  }
  return dadosValidos({ acao });
}

test('CA1: grava as 13 ações com cada coluna igual ao enviado e ids crescentes', async (t) => {
  const pool = await bancoDoTeste(t);
  assert.equal(ACOES.length, 13);

  let idAnterior = 0n;
  for (const acao of ACOES) {
    await t.test(`CA1 ${acao}`, async () => {
      const dados = dadosDaAcao(acao);
      const antes = new Date();
      const id = await registrarAuditoria(pool, dados);
      const depois = new Date();

      assert.equal(typeof id, 'string');
      assert.match(id, /^\d+$/);
      assert.ok(BigInt(id) > idAnterior, 'id deveria crescer na ordem das chamadas');
      idAnterior = BigInt(id);

      const linha = await lerLinha(pool, id);
      assert.equal(linha.autor_tipo, dados.autor.tipo);
      assert.equal(linha.autor_id, dados.autor.id);
      assert.equal(linha.acao, acao);
      assert.equal(linha.alvo_tipo, dados.alvo.tipo);
      assert.equal(linha.alvo_id, dados.alvo.id);
      assert.equal(linha.resultado, dados.resultado);
      assert.equal(linha.ip_texto, '203.0.113.5/32');
      assert.equal(linha.request_id, 'req-teste-1');
      assert.deepEqual(linha.detalhes, { canal: 'painel' });
      assert.ok(linha.ocorrido_em >= antes && linha.ocorrido_em <= depois, 'ocorrido_em fora do intervalo medido');
    });
  }

  assert.equal(await contar(pool), 13);
});

// CA2 -----------------------------------------------------------------------

test('CA2: vocabulário fechado recusa ação, autor, resultado e alvo desconhecidos sem gravar', async (t) => {
  const pool = await bancoDoTeste(t);

  const invalidos = [
    dadosValidos({ acao: 'apagou_tudo' }),
    dadosValidos({ autor: { tipo: 'robo', id: '1' } }),
    dadosValidos({ resultado: 'talvez' }),
    dadosValidos({ alvo: { tipo: 'fatura', id: '1' } }),
  ];
  for (const dados of invalidos) {
    await assert.rejects(registrarAuditoria(pool, dados), TypeError);
  }

  assert.equal(await contar(pool), 0);
});

// CA5 -----------------------------------------------------------------------

test('CA5: detalhes com chave proibida lança TypeError sem gravar e sem vazar o valor', async (t) => {
  const pool = await bancoDoTeste(t);

  const proibidos = {
    'senha na raiz': { senha: VALOR_SECRETO },
    'Token em maiúscula': { Token: VALOR_SECRETO },
    'accessToken aninhado': { conta: { accessToken: VALOR_SECRETO } },
    'Authorization dentro de array': { lista: [{ Authorization: VALOR_SECRETO }] },
    novaSenha: { novaSenha: VALOR_SECRETO },
    refresh_token: { refresh_token: VALOR_SECRETO },
    'toJSON que devolve senha': {
      info: {
        toJSON() {
          return { senha: VALOR_SECRETO };
        },
      },
    },
  };

  for (const [caso, detalhes] of Object.entries(proibidos)) {
    await assert.rejects(
      registrarAuditoria(pool, dadosValidos({ detalhes })),
      (erro) => {
        assert.ok(erro instanceof TypeError, `${caso}: deveria ser TypeError`);
        assert.ok(!erro.message.includes(VALOR_SECRETO), `${caso}: mensagem vazou o valor`);
        return true;
      },
    );
  }

  assert.equal(await contar(pool), 0);
});

test('CA5: mensagem do erro cita a chave proibida', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(
    registrarAuditoria(pool, dadosValidos({ detalhes: { senha: VALOR_SECRETO } })),
    { name: 'TypeError', message: 'auditoria: chave proibida em detalhes: senha' },
  );
});

test('CA5: toda chave de camposSensiveis do log é recusada pela auditoria', async (t) => {
  const pool = await bancoDoTeste(t);

  for (const chave of camposSensiveis) {
    await assert.rejects(
      registrarAuditoria(pool, dadosValidos({ detalhes: { [chave]: 'x' } })),
      TypeError,
      `a chave "${chave}" deveria ser recusada`,
    );
  }

  assert.equal(await contar(pool), 0);
});

// CA6 -----------------------------------------------------------------------

test('CA6: ROLLBACK do chamador apaga o registro de auditoria', async (t) => {
  const pool = await bancoDoTeste(t);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await registrarAuditoria(client, dadosValidos());
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  assert.equal(await contar(pool), 0);
});

test('CA6: COMMIT do chamador mantém o registro de auditoria', async (t) => {
  const pool = await bancoDoTeste(t);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await registrarAuditoria(client, dadosValidos());
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  assert.equal(await contar(pool), 1);
});

// CA7 -----------------------------------------------------------------------

test('CA7: ip nulo com autor cliente ou equipe lança TypeError sem gravar', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ ip: null })), TypeError);
  await assert.rejects(
    registrarAuditoria(pool, dadosValidos({ ip: null, autor: { tipo: 'equipe', id: '7' } })),
    TypeError,
  );

  assert.equal(await contar(pool), 0);
});

test('CA7: ip nulo com autor sistema grava NULL', async (t) => {
  const pool = await bancoDoTeste(t);

  const id = await registrarAuditoria(
    pool,
    dadosValidos({ autor: { tipo: 'sistema', id: null }, ip: null }),
  );

  const linha = await lerLinha(pool, id);
  assert.equal(linha.ip, null);
  assert.equal(linha.autor_tipo, 'sistema');
  assert.equal(linha.autor_id, null);
});

test('CA7: grava IPv4, IPv6 e IPv4 mapeado como inet', async (t) => {
  const pool = await bancoDoTeste(t);

  const esperados = {
    '::1': '::1/128',
    '203.0.113.5': '203.0.113.5/32',
    '::ffff:203.0.113.5': '::ffff:203.0.113.5/128',
  };
  for (const [ip, texto] of Object.entries(esperados)) {
    const id = await registrarAuditoria(pool, dadosValidos({ ip }));
    assert.equal((await lerLinha(pool, id)).ip_texto, texto, `ip ${ip}`);
  }
});

test('CA7: ip inválido ou IPv6 com zona lança TypeError sem gravar', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ ip: '999.1.1.1' })), TypeError);
  await assert.rejects(registrarAuditoria(pool, dadosValidos({ ip: 'fe80::1%eth0' })), TypeError);

  assert.equal(await contar(pool), 0);
});

// CA8 -----------------------------------------------------------------------

function detalhesComBytes(bytes) {
  const detalhes = { texto: 'a'.repeat(bytes - Buffer.byteLength(JSON.stringify({ texto: '' }))) };
  assert.equal(Buffer.byteLength(JSON.stringify(detalhes)), bytes);
  return detalhes;
}

test('CA8: detalhes com 2048 bytes serializados grava', async (t) => {
  const pool = await bancoDoTeste(t);
  const detalhes = detalhesComBytes(2048);

  const id = await registrarAuditoria(pool, dadosValidos({ detalhes }));

  assert.deepEqual((await lerLinha(pool, id)).detalhes, detalhes);
});

test('CA8: detalhes com 2049 bytes serializados lança TypeError sem gravar', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ detalhes: detalhesComBytes(2049) })), TypeError);

  assert.equal(await contar(pool), 0);
});

test('CA8: profundidade 4 grava, inclusive com array no caminho', async (t) => {
  const pool = await bancoDoTeste(t);

  for (const detalhes of [{ a: { b: { c: { d: 1 } } } }, { a: [{ b: 1 }] }]) {
    const id = await registrarAuditoria(pool, dadosValidos({ detalhes }));
    assert.deepEqual((await lerLinha(pool, id)).detalhes, detalhes);
  }
});

test('CA8: profundidade acima de 4 lança TypeError, contando arrays', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ detalhes: { a: { b: { c: { d: { e: 1 } } } } } })), TypeError);
  await assert.rejects(registrarAuditoria(pool, dadosValidos({ detalhes: { a: [[[[{}]]]] } })), TypeError);

  assert.equal(await contar(pool), 0);
});

test('CA8: detalhes que não é objeto lança TypeError', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ detalhes: [] })), TypeError);
  await assert.rejects(registrarAuditoria(pool, dadosValidos({ detalhes: 'texto' })), TypeError);

  assert.equal(await contar(pool), 0);
});

test('CA8: detalhes com caractere nulo lança TypeError antes de chegar ao banco', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ detalhes: { texto: 'a\u0000b' } })), TypeError);

  assert.equal(await contar(pool), 0);
});

test('CA8: sem detalhes grava objeto vazio', async (t) => {
  const pool = await bancoDoTeste(t);
  const dados = dadosValidos();
  delete dados.detalhes;

  const id = await registrarAuditoria(pool, dados);

  assert.deepEqual((await lerLinha(pool, id)).detalhes, {});
});

// L3: ids vazios ----------------------------------------------------------------

test('CA1: autor.id ou alvo.id vazio lança TypeError sem gravar', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ autor: { tipo: 'cliente', id: '' } })), /inválido/);
  await assert.rejects(registrarAuditoria(pool, dadosValidos({ alvo: { tipo: 'conta', id: '' } })), /inválido/);

  assert.equal(await contar(pool), 0);
});

// L9: vocabulário JS e CHECK do banco ---------------------------------------------

test('CA2: grava no banco cada valor de ALVOS, AUTORES e RESULTADOS (vocabulário JS igual ao CHECK)', async (t) => {
  const pool = await bancoDoTeste(t);

  for (const tipo of ALVOS) {
    await registrarAuditoria(pool, dadosValidos({ alvo: { tipo, id: '1' } }));
  }
  for (const tipo of AUTORES) {
    await registrarAuditoria(pool, dadosValidos({ autor: { tipo, id: '1' } }));
  }
  for (const resultado of RESULTADOS) {
    await registrarAuditoria(pool, dadosValidos({ resultado }));
  }

  assert.equal(await contar(pool), ALVOS.length + AUTORES.length + RESULTADOS.length);
});

// L4/L5: caracteres que o banco recusa ----------------------------------------------

test('CA8: caractere nulo em autor.id, alvo.id ou requestId lança TypeError sem gravar', async (t) => {
  const pool = await bancoDoTeste(t);

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ autor: { tipo: 'cliente', id: 'a\0b' } })), TypeError);
  await assert.rejects(registrarAuditoria(pool, dadosValidos({ alvo: { tipo: 'conta', id: 'a\0b' } })), TypeError);
  await assert.rejects(registrarAuditoria(pool, dadosValidos({ requestId: 'a\0b' })), TypeError);

  assert.equal(await contar(pool), 0);
});

test('CA8: caractere nulo e surrogate solitário em chave ou valor de detalhes lançam TypeError', async (t) => {
  const pool = await bancoDoTeste(t);

  const invalidos = [{ texto: 'a\0b' }, { 'a\0b': 1 }, { texto: '\ud800' }, { '\ud800': 1 }, { lista: ['x\0'] }];
  for (const detalhes of invalidos) {
    await assert.rejects(
      registrarAuditoria(pool, dadosValidos({ detalhes })),
      { name: 'TypeError', message: 'auditoria: detalhes com caractere inválido' },
    );
  }

  assert.equal(await contar(pool), 0);
});

test('CA8: o texto literal contrabarra-u0000 em detalhes é gravado', async (t) => {
  const pool = await bancoDoTeste(t);
  const detalhes = { texto: '\\u0000' };

  const id = await registrarAuditoria(pool, dadosValidos({ detalhes }));

  assert.deepEqual((await lerLinha(pool, id)).detalhes, detalhes);
});

test('CA5: chave proibida longa sai truncada a 64 caracteres na mensagem', async (t) => {
  const pool = await bancoDoTeste(t);
  const chave = `senha${'x'.repeat(100)}`;

  await assert.rejects(registrarAuditoria(pool, dadosValidos({ detalhes: { [chave]: 1 } })), {
    message: `auditoria: chave proibida em detalhes: ${chave.slice(0, 64)}`,
  });
});

// L6: chaves novas ----------------------------------------------------------------------

test('CA5: chaves de e-mail, documento, telefone e IP (ip_origem, remoteAddress, X-Forwarded-For) são recusadas em detalhes', async (t) => {
  const pool = await bancoDoTeste(t);

  for (const chave of ['emailNovo', 'cpf_cnpj', 'telefoneAnterior', 'ip', 'ip_origem', 'ipOrigem', 'remoteAddress', 'X-Forwarded-For']) {
    await assert.rejects(
      registrarAuditoria(pool, dadosValidos({ detalhes: { [chave]: 'x' } })),
      /chave proibida em detalhes/,
      chave,
    );
  }

  assert.equal(await contar(pool), 0);
});

// L7: faixa numérica -------------------------------------------------------------------

test('CA8: número fora da faixa em detalhes lança TypeError', async (t) => {
  const pool = await bancoDoTeste(t);

  for (const numero of [1e15, 1e300, 1e-7, -1e15]) {
    await assert.rejects(
      registrarAuditoria(pool, dadosValidos({ detalhes: { valor: numero } })),
      { name: 'TypeError', message: 'auditoria: detalhes com número fora da faixa' },
      String(numero),
    );
  }

  assert.equal(await contar(pool), 0);
});

test('CA8: números dentro da faixa em detalhes são gravados', async (t) => {
  const pool = await bancoDoTeste(t);
  const detalhes = { inteiro: 999999999999999, fracao: 0.5, zero: 0 };

  const id = await registrarAuditoria(pool, dadosValidos({ detalhes }));

  assert.deepEqual((await lerLinha(pool, id)).detalhes, detalhes);
});
