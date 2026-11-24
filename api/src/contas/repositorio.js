// Acesso a `conta_titular` (CIT-64). `executor` é o Client da transação do chamador.
// O e-mail é normalizado no banco (`lower(btrim(...))`), o mesmo `lower` do CHECK.

// `ON CONFLICT DO NOTHING` sem alvo cobre os dois únicos (`cliente_id` e `email`):
// devolve o id da conta criada ou null se algum já existia.
export async function inserirContaSeNova(executor, clienteId, email) {
  const resultado = await executor.query(
    `INSERT INTO conta_titular (cliente_id, email, estado) VALUES ($1, lower(btrim($2)), 'sem_senha')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [clienteId, email]
  )
  return resultado.rows[0]?.id ?? null
}

// Separa os conflitos: conta do mesmo cliente ou e-mail em conta de outro cliente.
export async function buscarContaPorClienteOuEmail(executor, clienteId, email) {
  const resultado = await executor.query(
    'SELECT id, cliente_id FROM conta_titular WHERE cliente_id = $1 OR email = lower(btrim($2))',
    [clienteId, email]
  )
  return resultado.rows
}
