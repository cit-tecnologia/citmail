// Acesso a `solicitacao_senha` e à senha de `conta_titular` (CIT-71). `executor` é um Pool
// ou o Client da transação do chamador. Só o SHA-256 (hex) do token chega aqui.

// Trava a conta (primeiro, sempre: mesma ordem no pedido de link e na definição).
export async function travarConta(executor, contaId) {
  const resultado = await executor.query(
    'SELECT id, estado, senha_hash FROM conta_titular WHERE id = $1 FOR UPDATE',
    [contaId]
  )
  return resultado.rows[0] ?? null
}

// Pedidos da conta nos últimos 5 min e abertas (não usadas e no prazo).
export async function contarSolicitacoes(executor, contaId) {
  const resultado = await executor.query(
    `SELECT count(*) FILTER (WHERE criada_em > now() - interval '5 minutes')::int AS recentes,
            count(*) FILTER (WHERE usada_em IS NULL AND expira_em > now())::int AS abertas
       FROM solicitacao_senha WHERE conta_titular_id = $1`,
    [contaId]
  )
  return resultado.rows[0]
}

// `prazoHoras` em horas inteiras; o prazo conta do relógio do banco.
export async function inserirSolicitacao(executor, { contaId, tipo, prazoHoras }) {
  const resultado = await executor.query(
    `INSERT INTO solicitacao_senha (conta_titular_id, tipo, expira_em)
     VALUES ($1, $2, now() + make_interval(hours => $3))
     RETURNING id, expira_em`,
    [contaId, tipo, prazoHoras]
  )
  return resultado.rows[0]
}

// Troca o hash só de solicitação aberta; devolve true se gravou.
export async function gravarTokenHash(executor, solicitacaoId, tokenHash) {
  const resultado = await executor.query(
    `UPDATE solicitacao_senha SET token_hash = $2
      WHERE id = $1 AND usada_em IS NULL AND expira_em > now()
      RETURNING id`,
    [solicitacaoId, tokenHash]
  )
  return resultado.rowCount === 1
}

// Solicitação aberta pelo hash, de conta não cancelada, com o e-mail da conta (política).
export async function buscarSolicitacaoAberta(executor, tokenHash) {
  const resultado = await executor.query(
    `SELECT s.id, s.tipo, s.conta_titular_id, c.email, c.cliente_id
       FROM solicitacao_senha s
       JOIN conta_titular c ON c.id = s.conta_titular_id
      WHERE s.token_hash = $1 AND s.usada_em IS NULL AND s.expira_em > now() AND c.estado <> 'cancelada'`,
    [tokenHash]
  )
  return resultado.rows[0] ?? null
}

export async function travarContaNaoCancelada(executor, contaId) {
  const resultado = await executor.query(
    `SELECT id FROM conta_titular WHERE id = $1 AND estado <> 'cancelada' FOR UPDATE`,
    [contaId]
  )
  return resultado.rowCount === 1
}

export async function consumirSolicitacao(executor, tokenHash, contaId) {
  const resultado = await executor.query(
    `UPDATE solicitacao_senha SET usada_em = now()
      WHERE token_hash = $1 AND conta_titular_id = $2 AND usada_em IS NULL AND expira_em > now()`,
    [tokenHash, contaId]
  )
  return resultado.rowCount === 1
}

// `sem_senha` vira `ativa`; `ativa` e `suspensa` só recebem o hash e a data.
export async function gravarSenha(executor, contaId, senhaHash) {
  const resultado = await executor.query(
    `UPDATE conta_titular
        SET senha_hash = $2, senha_definida_em = now(),
            estado = CASE WHEN estado = 'sem_senha' THEN 'ativa' ELSE estado END
      WHERE id = $1 AND estado <> 'cancelada'`,
    [contaId, senhaHash]
  )
  return resultado.rowCount === 1
}

export async function invalidarAbertas(executor, contaId) {
  await executor.query(
    'UPDATE solicitacao_senha SET usada_em = now() WHERE conta_titular_id = $1 AND usada_em IS NULL',
    [contaId]
  )
}

// "Esqueci a senha": mesma normalização da gravação e do login.
export async function buscarContaIdPorEmail(executor, email) {
  const resultado = await executor.query('SELECT id FROM conta_titular WHERE email = lower(btrim($1))', [email])
  return resultado.rows[0]?.id ?? null
}
