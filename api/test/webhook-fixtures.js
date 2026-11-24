// Auxiliares dos testes do webhook do Asaas (CIT-64): banco migrado com dois pools (dono,
// para semear e conferir; papel `<banco>_aplicacao`, para o código sob teste exercitar os
// grants), semente de cliente, pedido, assinaturas e bruto, e filas falsas que capturam
// jobs e alertas. Só dados fictícios.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { criarBancoTemporario, removerBancoTemporario, aplicarMigracoes } from './auxiliares.js';

export const TOKEN_WEBHOOK = 'tok-'.repeat(10) // fictício, 40 caracteres;
export const EMAIL_PEDIDO = 'Titular@Exemplo.TEST';

let contador = 0;
function proximo() {
  contador += 1;
  return contador;
}

/** Banco temporário migrado: `admin` (dono) e `app` (papel da aplicação). */
export async function criarBancoWebhook() {
  const { nomeBanco, url } = await criarBancoTemporario();
  try {
    await aplicarMigracoes(url);
  } catch (erro) {
    await removerBancoTemporario(nomeBanco);
    throw erro;
  }
  const admin = new Pool({ connectionString: url, max: 3 });
  const app = new Pool({ connectionString: url, max: 4, options: `-c role=${nomeBanco}_aplicacao` });
  return {
    nomeBanco,
    url,
    admin,
    app,
    async limpar() {
      await admin.query(
        `TRUNCATE asaas_webhook_evento, conta_titular, evento_processado, evento, assinatura,
                  pedido_dominio, pedido, cliente CASCADE`
      );
    },
    async fechar() {
      await app.end();
      await admin.end();
      await removerBancoTemporario(nomeBanco);
    }
  };
}

export async function semearCliente(admin) {
  const n = proximo();
  const { rows } = await admin.query(
    `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
     VALUES ('fisica', $1, 'Fulano Ficticio', 'fulano@exemplo.test', '11999990000') RETURNING id`,
    [String(20000000000 + n)]
  );
  return rows[0].id;
}

/**
 * Pedido com as assinaturas pedidas. `assinaturas`: `{ contas: 'sub_contas_1', dominios: 'sub_dom_1' }`
 * (a chave ausente não cria a assinatura). `dominios`: `[{ nome, tipo, papel }]`.
 * Valores: contas 4990 (mensal), domínios 4000 (anual).
 */
export async function semearPedido(admin, opcoes = {}) {
  const {
    estado = 'aguardando_pagamento',
    ciclo = 'mensal',
    email = EMAIL_PEDIDO,
    faturaRetida = false,
    clienteId: clienteExistente,
    dominios = [],
    assinaturas = { contas: 'sub_contas_1' },
    dominioPagoEm = null
  } = opcoes;
  const clienteId = clienteExistente ?? await semearCliente(admin);
  const { rows } = await admin.query(
    `INSERT INTO pedido (cliente_id, chave_idempotencia, corpo_hash, estado, criando_desde, falha_motivo, ciclo, itens,
                         total_centavos, versao_tabela_precos, contato_nome, contato_email, contato_telefone,
                         fatura_retida, dominio_pago_em, aceite_em, versao_termos, versao_privacidade, ip_aceite)
     VALUES ($1, $2, repeat('a', 64), $3, CASE WHEN $3 = 'criando' THEN now() END,
             CASE WHEN $3 = 'falhou_na_criacao' THEN 'motivo_ficticio' END, $4, '{}'::jsonb, 4990, '2026-01-01.1',
             'Fulano Ficticio', $5, '11999990000', $6, $7, now(), '0.1', 'p1', '127.0.0.1')
     RETURNING id`,
    [clienteId, randomUUID(), estado, ciclo, email, faturaRetida, dominioPagoEm]
  );
  const pedidoId = rows[0].id;
  for (const dominio of dominios) {
    await admin.query(
      'INSERT INTO pedido_dominio (pedido_id, nome, tipo, papel) VALUES ($1, $2, $3, $4)',
      [pedidoId, dominio.nome, dominio.tipo, dominio.papel]
    );
  }
  const resultado = { pedidoId, clienteId, assinaturaContasId: null, assinaturaDominiosId: null };
  if (assinaturas.contas) {
    resultado.assinaturaContasId = (await admin.query(
      `INSERT INTO assinatura (pedido_id, cliente_id, tipo, ciclo, valor_centavos, asaas_assinatura_id)
       VALUES ($1, $2, 'contas', $3, 4990, $4) RETURNING id`,
      [pedidoId, clienteId, ciclo, assinaturas.contas]
    )).rows[0].id;
  }
  if (assinaturas.dominios) {
    resultado.assinaturaDominiosId = (await admin.query(
      `INSERT INTO assinatura (pedido_id, cliente_id, tipo, ciclo, valor_centavos, asaas_assinatura_id)
       VALUES ($1, $2, 'dominios', 'anual', 4000, $3) RETURNING id`,
      [pedidoId, clienteId, assinaturas.dominios]
    )).rows[0].id;
  }
  return resultado;
}

/** Bruto `pendente` inserido pelo dono, como a rota o grava. Devolve o id. */
export async function semearBruto(admin, opcoes = {}) {
  const {
    eventoId = `evt_teste_${proximo()}_${randomUUID().slice(0, 8)}`,
    evento = 'PAYMENT_RECEIVED',
    pagamentoId = 'pay_1',
    assinaturaId = 'sub_contas_1',
    referenciaExterna = null,
    status = 'RECEIVED',
    valorCentavos = 4990,
    vencimento = '2026-12-10',
    enfileiradoEm = null
  } = opcoes;
  const { rows } = await admin.query(
    `INSERT INTO asaas_webhook_evento (asaas_evento_id, evento, request_id, pagamento_id, assinatura_id,
                                       referencia_externa, status, valor_centavos, vencimento, enfileirado_em)
     VALUES ($1, $2, 'req-teste', $3, $4, $5, $6, $7, $8::date, $9) RETURNING id`,
    [eventoId, evento, pagamentoId, assinaturaId, referenciaExterna, status, valorCentavos, vencimento, enfileiradoEm]
  );
  return rows[0].id;
}

/** Pagamento no stub do Asaas (valor em reais), com os padrões do pedido de contas. */
export function semearPagamentoNoStub(stub, opcoes = {}) {
  const {
    id = 'pay_1', subscription = 'sub_contas_1', status = 'RECEIVED', value = 49.9,
    dueDate = '2026-12-10', externalReference
  } = opcoes;
  stub.semearPagamento({
    id, subscription, status, value, dueDate,
    ...(externalReference === undefined ? {} : { externalReference })
  });
}

/** Filas falsas: capturam os jobs do enfileirador e os alertas; `falhar` faz o `addBulk` rejeitar. */
export function criarFilasFalsas() {
  const estado = { jobs: [], alertas: [], falharAddBulk: false };
  return {
    estado,
    jobs: {
      async addBulk(lista) {
        if (estado.falharAddBulk) throw new Error('redis fora');
        estado.jobs.push(...lista);
      }
    },
    alertas: {
      async add(name, data, opts) {
        estado.alertas.push({ name, data, opts });
      },
      async addBulk(lista) {
        for (const item of lista) estado.alertas.push({ name: item.name, data: item.data, opts: item.opts });
      }
    }
  };
}

export async function estadoDoPedido(admin, pedidoId) {
  return (await admin.query('SELECT estado, dominio_pago_em FROM pedido WHERE id = $1', [pedidoId])).rows[0];
}

export async function eventosPublicados(admin) {
  return (await admin.query(
    `SELECT nome, chave_idempotencia, agregado_tipo, agregado_id, payload
       FROM evento ORDER BY nome, chave_idempotencia`
  )).rows;
}

export async function contasDoTitular(admin) {
  return (await admin.query('SELECT * FROM conta_titular ORDER BY criado_em')).rows;
}

export async function leituraDoBruto(admin, brutoId) {
  return (await admin.query(
    'SELECT situacao, codigo, processado_em, enfileirado_em, alertado_pendente_em FROM asaas_webhook_evento WHERE id = $1',
    [brutoId]
  )).rows[0];
}

export function corpoDoEvento(sobrescritas = {}, pagamento = {}) {
  return {
    id: `evt_http_${proximo()}_${randomUUID().slice(0, 8)}`,
    event: 'PAYMENT_RECEIVED',
    payment: {
      id: 'pay_1', subscription: 'sub_contas_1', status: 'RECEIVED', billingType: 'PIX', value: 49.9,
      dueDate: '2026-12-10', paymentDate: '2026-12-01', ...pagamento
    },
    ...sobrescritas
  };
}
