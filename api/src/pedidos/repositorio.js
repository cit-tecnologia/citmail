// Acesso às tabelas `cliente`, `pedido`, `pedido_dominio` e `assinatura` (CIT-61).
// `executor` é um Pool ou o Client de uma transação. A posse do fluxo é o valor de
// `criando_desde` em texto (`::text`): o Date do `pg` perde os microssegundos e a
// comparação `criando_desde = $posse` nunca bateria.

// Pedido da chave, com o documento do cliente (comparação do corpo repetido) e se o
// `criando` passou do prazo de retomada.
export async function buscarPedidoPorChave(executor, chave, prazoCriandoMs) {
  const resultado = await executor.query(
    `SELECT p.id, p.estado, p.corpo_hash, p.contato_nome, p.contato_email, p.contato_telefone,
            p.falha_motivo, c.documento,
            (p.criando_desde < now() - $2 * interval '1 millisecond') AS expirado
       FROM pedido p JOIN cliente c ON c.id = p.cliente_id
      WHERE p.chave_idempotencia = $1`,
    [chave, prazoCriandoMs]
  )
  return resultado.rows[0] ?? null
}

// O cliente existente não muda (ADR 0014, decisão 4). INSERT e SELECT em comandos separados.
export async function inserirOuBuscarCliente(executor, cliente) {
  await executor.query(
    `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (documento) DO NOTHING`,
    [cliente.tipoPessoa, cliente.documento, cliente.nome, cliente.email, cliente.telefone]
  )
  const resultado = await executor.query('SELECT id FROM cliente WHERE documento = $1', [cliente.documento])
  return resultado.rows[0].id
}

// null se a chave já foi usada; senão `{ id, posse }`.
export async function inserirPedido(executor, pedido) {
  const resultado = await executor.query(
    `INSERT INTO pedido (cliente_id, chave_idempotencia, corpo_hash, estado, criando_desde, ciclo, itens,
                         total_centavos, versao_tabela_precos, contato_nome, contato_email, contato_telefone, request_id)
     VALUES ($1, $2, $3, 'criando', now(), $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (chave_idempotencia) DO NOTHING
     RETURNING id, criando_desde::text AS posse`,
    [
      pedido.clienteId, pedido.chave, pedido.corpoHash, pedido.ciclo, pedido.itens, pedido.totalCentavos,
      pedido.versaoTabela, pedido.contatoNome, pedido.contatoEmail, pedido.contatoTelefone, pedido.requestId
    ]
  )
  return resultado.rows[0] ?? null
}

export async function inserirDominios(executor, pedidoId, dominios) {
  for (const dominio of dominios) {
    await executor.query(
      'INSERT INTO pedido_dominio (pedido_id, nome, tipo, papel) VALUES ($1, $2, $3, $4)',
      [pedidoId, dominio.nome, dominio.tipo, dominio.papel]
    )
  }
}

// Dados para os passos 3 e 4 (criação e retomada): o cliente e o snapshot do pedido.
export async function buscarDadosDoFluxo(executor, pedidoId) {
  const resultado = await executor.query(
    `SELECT p.ciclo, p.itens, p.total_centavos, c.id AS cliente_id, c.documento, c.nome, c.email,
            c.telefone, c.asaas_cliente_id
       FROM pedido p JOIN cliente c ON c.id = p.cliente_id
      WHERE p.id = $1`,
    [pedidoId]
  )
  return resultado.rows[0]
}

// Grava o id do Asaas só se ainda não houver um; senão devolve o gravado por outro pedido.
export async function gravarAsaasClienteId(executor, clienteId, asaasClienteId) {
  const resultado = await executor.query(
    `UPDATE cliente SET asaas_cliente_id = $1
      WHERE id = $2 AND asaas_cliente_id IS NULL
      RETURNING asaas_cliente_id`,
    [asaasClienteId, clienteId]
  )
  if (resultado.rows.length > 0) return resultado.rows[0].asaas_cliente_id
  const gravado = await executor.query('SELECT asaas_cliente_id FROM cliente WHERE id = $1', [clienteId])
  return gravado.rows[0].asaas_cliente_id
}

export async function temPosse(executor, pedidoId, posse) {
  const resultado = await executor.query(
    `SELECT 1 FROM pedido WHERE id = $1 AND estado = 'criando' AND criando_desde = $2::timestamptz`,
    [pedidoId, posse]
  )
  return resultado.rows.length > 0
}

// false = posse perdida para uma retomada.
export async function concluirPedido(executor, pedidoId, posse) {
  const resultado = await executor.query(
    `UPDATE pedido SET estado = 'aguardando_pagamento', criando_desde = NULL
      WHERE id = $1 AND estado = 'criando' AND criando_desde = $2::timestamptz`,
    [pedidoId, posse]
  )
  return resultado.rowCount > 0
}

export async function marcarFalha(executor, pedidoId, posse, motivo) {
  const resultado = await executor.query(
    `UPDATE pedido SET estado = 'falhou_na_criacao', falha_motivo = $3, criando_desde = NULL
      WHERE id = $1 AND estado = 'criando' AND criando_desde = $2::timestamptz`,
    [pedidoId, posse, motivo]
  )
  return resultado.rowCount > 0
}

// Posse atômica da retomada: só um UPDATE pega a linha; null se outro já pegou.
export async function retomarPedido(executor, pedidoId, prazoCriandoMs) {
  const resultado = await executor.query(
    `UPDATE pedido SET criando_desde = clock_timestamp()
      WHERE id = $1 AND estado = 'criando' AND criando_desde < now() - $2 * interval '1 millisecond'
      RETURNING criando_desde::text AS posse`,
    [pedidoId, prazoCriandoMs]
  )
  return resultado.rows[0]?.posse ?? null
}

export async function inserirAssinatura(executor, assinatura) {
  await executor.query(
    `INSERT INTO assinatura (pedido_id, cliente_id, tipo, ciclo, valor_centavos, asaas_assinatura_id, url_primeira_fatura)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      assinatura.pedidoId, assinatura.clienteId, assinatura.tipo, assinatura.ciclo, assinatura.valorCentavos,
      assinatura.asaasAssinaturaId, assinatura.url
    ]
  )
}

export async function buscarFaturas(executor, pedidoId) {
  const resultado = await executor.query(
    'SELECT tipo, url_primeira_fatura AS url FROM assinatura WHERE pedido_id = $1 ORDER BY tipo',
    [pedidoId]
  )
  return resultado.rows
}
