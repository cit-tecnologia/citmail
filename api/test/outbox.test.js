// CIT-166, CA3 a CA5: publicador do outbox (`src/eventos/publicador.js`), consumidores
// idempotentes (`src/eventos/consumidores.js`) e correlação do `requestId`, contra
// Postgres e Redis de teste. Os consumidores são de teste (o registro padrão é vazio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  criarBancoTemporario,
  removerBancoTemporario,
  aplicarMigracoes,
  criarFilasTeste,
  criarCapturaDeLog,
} from './auxiliares.js';
import { criarLogger } from '../src/log.js';
import { criarConexaoProdutor } from '../src/fila/conexao.js';
import { criarFilas } from '../src/fila/filas.js';
import { registrarEvento } from '../src/eventos/servico.js';
import { iniciarPublicador, publicarPendentes } from '../src/eventos/publicador.js';
import { criarHandlersDeConsumidores, processarEvento } from '../src/eventos/consumidores.js';

const REQUEST_ID = 'req-ficticio-166';

// Consumidor que só grava o efeito (1 linha em `efeito_teste` por evento).
async function gravarEfeito({ cliente, evento }) {
  await cliente.query('INSERT INTO efeito_teste (evento_id) VALUES ($1)', [evento.id]);
}

function criarConsumidores(tratar = gravarEfeito) {
  return {
    teste_a: { eventos: ['pedido_pago'], tratar },
    teste_b: { eventos: ['pedido_pago'], tratar },
    teste_c: { eventos: ['conta_ativada'], tratar },
  };
}

// Banco migrado com a tabela de efeito + filas de teste (Redis). `fechar` é um só
// para a ordem do teardown ser certa: filas e workers antes do pool.
async function montar(t, opcoesFilas = {}) {
  const { nomeBanco, url } = await criarBancoTemporario();
  let pool;
  let aux;
  try {
    await aplicarMigracoes(url);
    pool = new Pool({ connectionString: url, max: 5 });
    await pool.query('CREATE TABLE efeito_teste (evento_id uuid NOT NULL)');
    aux = criarFilasTeste(opcoesFilas);
  } catch (erro) {
    await pool?.end();
    await removerBancoTemporario(nomeBanco);
    throw erro;
  }
  t.after(async () => {
    try {
      await aux.fechar();
    } finally {
      await pool.end();
      await removerBancoTemporario(nomeBanco);
    }
  });
  return { pool, aux };
}

async function registrar(pool, { nome = 'pedido_pago', requestId = REQUEST_ID } = {}) {
  const agregadoId = randomUUID();
  const cliente = await pool.connect();
  try {
    const { id } = await registrarEvento(cliente, {
      nome,
      agregado: { tipo: 'pedido', id: agregadoId },
      chaveIdempotencia: `${nome}-${agregadoId}`,
      payload: { pedidoId: agregadoId },
      requestId,
    });
    return id;
  } finally {
    cliente.release();
  }
}

async function lerEvento(pool, id) {
  const { rows } = await pool.query('SELECT publicado_em, tentativas_publicacao FROM evento WHERE id = $1', [id]);
  return rows[0];
}

async function contar(pool, tabela) {
  const { rows } = await pool.query(`SELECT count(*)::int AS total FROM ${tabela}`);
  return rows[0].total;
}

// Resolve quando `quantidade` jobs terminarem (evento `completed` ou `failed`, sem
// contar as falhas que a fila vai repetir se `soTerminais`); registrar ANTES do add.
function aguardarJobs(workers, quantidade, eventos = ['completed', 'failed']) {
  return new Promise((resolve) => {
    let restantes = quantidade;
    const aoTerminar = () => {
      restantes -= 1;
      if (restantes === 0) resolve();
    };
    for (const evento of eventos) workers.jobs.on(evento, aoTerminar);
  });
}

// ---------------------------------------------------------------------------
// CA3: publicador
// ---------------------------------------------------------------------------

test('CA3a: evento pendente vira 1 job por consumidor inscrito, com jobId e data só de ids, e fica publicado', async (t) => {
  const { pool, aux } = await montar(t);
  const consumidores = criarConsumidores();
  const eventoId = await registrar(pool);

  await publicarPendentes({ pool, filas: aux.filas, consumidores, log: aux.log });

  for (const consumidor of ['teste_a', 'teste_b']) {
    const job = await aux.filas.jobs.getJob(`${consumidor}-${eventoId}`);
    assert.ok(job, `esperava o job ${consumidor}-${eventoId}`);
    assert.equal(job.name, consumidor);
    assert.deepEqual(job.data, { eventoId, requestId: REQUEST_ID });
  }
  assert.equal(await aux.filas.jobs.getJob(`teste_c-${eventoId}`), undefined);
  assert.notEqual((await lerEvento(pool, eventoId)).publicado_em, null);
  assert.equal((await aux.filas.jobs.getJobCounts()).waiting, 2);
});

test('CA3b: com o Redis inacessível o ciclo termina em até 3 s sem lançar e deixa os eventos pendentes', async (t) => {
  const { pool } = await montar(t);
  const consumidores = criarConsumidores();
  const ids = [await registrar(pool), await registrar(pool)];

  const conexaoSemRedis = criarConexaoProdutor('redis://127.0.0.1:1');
  const captura = criarCapturaDeLog();
  const log = criarLogger({ level: 'info', stream: captura.stream });
  const filasSemRedis = criarFilas({
    conexao: conexaoSemRedis, prefixo: `teste-sem-redis-${process.pid}`, tentativas: 3, backoffMs: 300, log,
  });
  t.after(async () => {
    await filasSemRedis.close().catch(() => {});
    conexaoSemRedis.disconnect();
  });

  const inicio = Date.now();
  await publicarPendentes({ pool, filas: filasSemRedis, consumidores, log });
  const duracao = Date.now() - inicio;

  assert.ok(duracao <= 3000, `esperava terminar em até 3000ms, levou ${duracao}ms`);
  for (const id of ids) {
    const evento = await lerEvento(pool, id);
    assert.equal(evento.publicado_em, null);
    assert.equal(evento.tentativas_publicacao, 1);
  }
  const falha = captura.linhas().find((linha) => linha.msg === 'publicação falhou');
  assert.ok(falha, 'esperava o log "publicação falhou"');
  assert.equal(falha.level, 40);
  assert.ok(!captura.texto().includes('127.0.0.1:1'), 'o log não deveria conter a URL/porta do Redis');
});

test('CA3b3: com o addBulk pendurado (Redis que nunca responde) o ciclo estoura o prazo de 2 s e conta a falha', async (t) => {
  const { pool } = await montar(t);
  const consumidores = criarConsumidores();
  const eventoId = await registrar(pool);
  const filasPendentes = { jobs: { addBulk: () => new Promise(() => {}) } };
  const captura = criarCapturaDeLog();
  const log = criarLogger({ level: 'info', stream: captura.stream });

  const inicio = Date.now();
  await publicarPendentes({ pool, filas: filasPendentes, consumidores, log });
  const duracao = Date.now() - inicio;

  assert.ok(duracao >= 1900 && duracao <= 3000, `esperava o prazo de ~2000ms, levou ${duracao}ms`);
  const evento = await lerEvento(pool, eventoId);
  assert.equal(evento.publicado_em, null);
  assert.equal(evento.tentativas_publicacao, 1);
  assert.ok(captura.linhas().some((linha) => linha.msg === 'publicação falhou' && linha.erro === 'TimeoutError'));
});

test('CA3b2: depois que o Redis volta, o ciclo seguinte publica os eventos que ficaram pendentes', async (t) => {
  const { pool, aux } = await montar(t);
  const consumidores = criarConsumidores();
  const eventoId = await registrar(pool);
  // Simula o ciclo que falhou antes.
  await pool.query('UPDATE evento SET tentativas_publicacao = 1 WHERE id = $1', [eventoId]);

  await publicarPendentes({ pool, filas: aux.filas, consumidores, log: aux.log });

  assert.ok(await aux.filas.jobs.getJob(`teste_a-${eventoId}`));
  const evento = await lerEvento(pool, eventoId);
  assert.notEqual(evento.publicado_em, null);
  assert.equal(evento.tentativas_publicacao, 1);
});

test('CA3c: republicar o mesmo evento não cria segundo job', async (t) => {
  const { pool, aux } = await montar(t);
  const consumidores = criarConsumidores();
  const eventoId = await registrar(pool);

  await publicarPendentes({ pool, filas: aux.filas, consumidores, log: aux.log });
  const primeiro = await aux.filas.jobs.getJob(`teste_a-${eventoId}`);
  const contagemAntes = await aux.filas.jobs.getJobCounts();

  await pool.query('UPDATE evento SET publicado_em = NULL WHERE id = $1', [eventoId]);
  await publicarPendentes({ pool, filas: aux.filas, consumidores, log: aux.log });

  const segundo = await aux.filas.jobs.getJob(`teste_a-${eventoId}`);
  assert.equal(segundo.timestamp, primeiro.timestamp);
  assert.deepEqual(await aux.filas.jobs.getJobCounts(), contagemAntes);
  assert.notEqual((await lerEvento(pool, eventoId)).publicado_em, null);
});

test('CA3d: evento sem consumidor inscrito é marcado publicado, sem job, com o log "evento sem consumidor"', async (t) => {
  const { pool, aux } = await montar(t);
  const consumidores = criarConsumidores();
  const eventoId = await registrar(pool, { nome: 'dominio_pago' });

  await publicarPendentes({ pool, filas: aux.filas, consumidores, log: aux.log });

  assert.notEqual((await lerEvento(pool, eventoId)).publicado_em, null);
  const contagem = await aux.filas.jobs.getJobCounts();
  assert.equal(contagem.waiting + contagem.delayed + contagem.active + contagem.completed, 0);
  const linhas = aux.captura.linhas().filter((linha) => linha.msg === 'evento sem consumidor');
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].eventoId, eventoId);
  assert.equal(linhas[0].evento, 'dominio_pago');
});

test('CA3e: iniciarPublicador publica evento inserido depois de iniciado e, após close(), não roda mais ciclos', async (t) => {
  const { pool, aux } = await montar(t);
  const consumidores = criarConsumidores();
  let ciclos = 0;
  let aoPublicar;
  const publicou = new Promise((resolve) => { aoPublicar = resolve; });

  const publicador = iniciarPublicador({
    pool,
    filas: aux.filas,
    consumidores,
    log: aux.log,
    intervaloMs: 100,
    aoCiclo: (resultado) => {
      ciclos += 1;
      if (resultado.publicados > 0) aoPublicar();
    },
  });
  t.after(() => publicador.close());

  const eventoId = await registrar(pool);
  await publicou;
  assert.ok(await aux.filas.jobs.getJob(`teste_a-${eventoId}`));
  assert.notEqual((await lerEvento(pool, eventoId)).publicado_em, null);

  await publicador.close();
  const ciclosAoFechar = ciclos;
  await esperar(300);
  assert.equal(ciclos, ciclosAoFechar, 'nenhum ciclo deveria rodar depois do close()');
});

// ---------------------------------------------------------------------------
// CA4: consumidor idempotente
// ---------------------------------------------------------------------------

test('CA4a: o mesmo eventoId entregue em dois jobs produz 1 efeito, 1 marca e 1 log "evento já processado"', async (t) => {
  const { pool, aux } = await montar(t);
  const consumidores = criarConsumidores();
  const eventoId = await registrar(pool);
  const workers = aux.criarWorkers({ handlers: criarHandlersDeConsumidores({ pool, consumidores }) });

  const terminou = aguardarJobs(workers, 2, ['completed']);
  await aux.filas.jobs.add('teste_a', { eventoId, requestId: REQUEST_ID }, { jobId: 'teste_a-entrega-1' });
  await aux.filas.jobs.add('teste_a', { eventoId, requestId: REQUEST_ID }, { jobId: 'teste_a-entrega-2' });
  await terminou;

  assert.equal(await contar(pool, 'efeito_teste'), 1);
  assert.equal(await contar(pool, 'evento_processado'), 1);
  const jaProcessado = aux.captura.linhas().filter((linha) => linha.msg === 'evento já processado');
  assert.equal(jaProcessado.length, 1);
});

test('CA4b: tratar que lança na 1ª tentativa e passa na 2ª deixa 1 efeito e 1 marca', async (t) => {
  const { pool, aux } = await montar(t);
  let chamadas = 0;
  const consumidores = criarConsumidores(async (contexto) => {
    chamadas += 1;
    // Grava o efeito antes de falhar: o ROLLBACK precisa desfazer efeito e marca.
    await gravarEfeito(contexto);
    if (chamadas === 1) throw new Error('falha simulada do consumidor');
  });
  const eventoId = await registrar(pool);
  const workers = aux.criarWorkers({ handlers: criarHandlersDeConsumidores({ pool, consumidores }) });

  const terminou = aguardarJobs(workers, 1, ['completed']);
  await aux.filas.jobs.add('teste_a', { eventoId, requestId: REQUEST_ID }, { jobId: `teste_a-${eventoId}` });
  await terminou;

  assert.equal(chamadas, 2);
  assert.equal(await contar(pool, 'efeito_teste'), 1);
  assert.equal(await contar(pool, 'evento_processado'), 1);
  const job = await aux.filas.jobs.getJob(`teste_a-${eventoId}`);
  assert.equal(job.attemptsMade, 2);
});

const EVENTOS_ID_INVALIDOS = {
  'eventoId que não é UUID': 'nao-uuid',
  'UUID inexistente': randomUUID(),
};

for (const [descricao, eventoIdInvalido] of Object.entries(EVENTOS_ID_INVALIDOS)) {
  test(`CA4c: ${descricao} vai a failed na 1ª tentativa, sem novas tentativas e sem gravar nada`, async (t) => {
    const { pool, aux } = await montar(t);
    const consumidores = criarConsumidores();
    const workers = aux.criarWorkers({ handlers: criarHandlersDeConsumidores({ pool, consumidores }) });

    const terminou = aguardarJobs(workers, 1, ['failed']);
    await aux.filas.jobs.add('teste_a', { eventoId: eventoIdInvalido, requestId: REQUEST_ID }, { jobId: 'teste_a-invalido' });
    await terminou;

    const job = await aux.filas.jobs.getJob('teste_a-invalido');
    assert.equal(await job.getState(), 'failed');
    assert.equal(job.attemptsMade, 1);
    assert.equal(await contar(pool, 'efeito_teste'), 0);
    assert.equal(await contar(pool, 'evento_processado'), 0);
  });
}

test('CA4e: tratar que engole erro SQL não marca o evento como processado', async (t) => {
  const { pool, aux } = await montar(t);
  const eventoId = await registrar(pool);
  const tratar = async ({ cliente }) => {
    try {
      await cliente.query('SELECT * FROM tabela_inexistente_166');
    } catch {
      // erro engolido de propósito: a transação fica abortada
    }
  };

  await assert.rejects(
    processarEvento({ pool, consumidor: 'teste_a', tratar, log: aux.log }, { eventoId }),
    /transação do consumidor abortada/
  );
  assert.equal(await contar(pool, 'evento_processado'), 0);
  assert.equal(await contar(pool, 'efeito_teste'), 0);
});

test('CA4d: duas entregas concorrentes do mesmo eventoId resolvem sem erro e deixam 1 efeito e 1 marca', async (t) => {
  const { pool, aux } = await montar(t);
  const eventoId = await registrar(pool);
  // Segura a 1ª transação aberta para a 2ª esbarrar na marca ainda não confirmada.
  const tratar = async (contexto) => {
    await esperar(150);
    await gravarEfeito(contexto);
  };
  const base = { pool, consumidor: 'teste_a', tratar, log: aux.log };

  const resultados = await Promise.allSettled([
    processarEvento(base, { eventoId }),
    processarEvento(base, { eventoId }),
  ]);

  assert.deepEqual(resultados.map((r) => r.status), ['fulfilled', 'fulfilled']);
  assert.equal(await contar(pool, 'efeito_teste'), 1);
  assert.equal(await contar(pool, 'evento_processado'), 1);
});

// ---------------------------------------------------------------------------
// CA5: correlação
// ---------------------------------------------------------------------------

test('CA5: o job publicado leva o request_id do evento e o consumidor loga com esse reqId', async (t) => {
  const { pool, aux } = await montar(t);
  const consumidores = criarConsumidores();
  const eventoId = await registrar(pool, { requestId: REQUEST_ID });
  const workers = aux.criarWorkers({ handlers: criarHandlersDeConsumidores({ pool, consumidores }) });

  const terminou = aguardarJobs(workers, 1, ['completed']);
  await publicarPendentes({ pool, filas: aux.filas, consumidores: { teste_a: consumidores.teste_a }, log: aux.log });
  await terminou;

  const job = await aux.filas.jobs.getJob(`teste_a-${eventoId}`);
  assert.equal(job.data.requestId, REQUEST_ID);
  const linhas = aux.captura.linhas().filter((linha) => linha.job === 'teste_a');
  for (const mensagem of ['job iniciado', 'job concluído']) {
    const linha = linhas.find((l) => l.msg === mensagem);
    assert.ok(linha, `esperava a linha "${mensagem}"`);
    assert.equal(linha.reqId, REQUEST_ID);
  }
});
