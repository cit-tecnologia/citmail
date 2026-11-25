// CIT-77, CA9: `tarefa_dominio`, as datas de registro e a ação nova da auditoria no banco:
// constraints, unicidade, grants por coluna do papel `<banco>_aplicacao` e o down com guarda,
// contra bancos temporários. Só dados fictícios.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { registrarAuditoria } from '../src/auditoria/servico.js'
import { aplicarMigracoes, criarBancoTemporario, removerBancoTemporario } from './auxiliares.js'
import { DOMINIO_UM, semearComTarefas, TRUNCAR } from './dominio-fixtures.js'
import { criarBancoWebhook } from './webhook-fixtures.js'

let banco
let pedidoDominioId

before(async () => {
  banco = await criarBancoWebhook()
})

after(async () => {
  await banco.fechar()
})

beforeEach(async () => {
  await banco.admin.query(TRUNCAR)
  const semente = await semearComTarefas(banco.admin, { tarefas: false, dominios: [{ nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' }] })
  pedidoDominioId = semente.dominioIds[0]
})

async function codigoDeErro(promessa) {
  try {
    await promessa
  } catch (erro) {
    return erro.code
  }
  return undefined
}

const inserir = (tipo, referencia, situacao, executor = banco.admin) => executor.query(
  'INSERT INTO tarefa_dominio (pedido_dominio_id, tipo, referencia_expira_em, situacao_fatura) VALUES ($1, $2, $3, $4)',
  [pedidoDominioId, tipo, referencia, situacao]
)

// ---- unicidade ----------------------------------------------------------------------------

test('CA9: segunda tarefa de registro do mesmo domínio (referência nula) é recusada com 23505', async () => {
  await inserir('registro', null, null)
  assert.equal(await codigoDeErro(inserir('registro', null, null)), '23505')
})

test('CA9: segunda renovação do mesmo domínio e da mesma referência é recusada com 23505', async () => {
  await inserir('renovacao', '2027-01-01', 'pendente')
  assert.equal(await codigoDeErro(inserir('renovacao', '2027-01-01', 'paga')), '23505')
})

test('CA9: renovação com outra referência do mesmo domínio é aceita', async () => {
  await inserir('renovacao', '2027-01-01', 'pendente')
  assert.equal(await codigoDeErro(inserir('renovacao', '2028-01-01', 'pendente')), undefined)
})

// ---- CHECKs -------------------------------------------------------------------------------

const CHECKS = [
  ['tipo fora do domínio', 'outro', null, null],
  ['renovacao sem referência', 'renovacao', null, 'pendente'],
  ['renovacao sem situacao_fatura', 'renovacao', '2027-01-01', null],
  ['registro com referência', 'registro', '2027-01-01', null],
  ['registro com situacao_fatura', 'registro', null, 'paga'],
  ['situacao_fatura fora do domínio', 'renovacao', '2027-01-01', 'talvez']
]

for (const [nome, tipo, referencia, situacao] of CHECKS) {
  test(`CA9: ${nome} é recusado com 23514`, async () => {
    assert.equal(await codigoDeErro(inserir(tipo, referencia, situacao)), '23514')
  })
}

// ---- grants do papel da aplicação --------------------------------------------------------

test('CA9: o papel da aplicação insere tarefa só com as colunas permitidas', async () => {
  assert.equal(await codigoDeErro(inserir('registro', null, null, banco.app)), undefined)
})

test('CA9: o papel da aplicação recebe 42501 ao informar aberta_em no INSERT', async () => {
  assert.equal(await codigoDeErro(banco.app.query(
    "INSERT INTO tarefa_dominio (pedido_dominio_id, tipo, aberta_em) VALUES ($1, 'registro', now())", [pedidoDominioId]
  )), '42501')
})

test('CA9: o papel da aplicação recebe 42501 em DELETE de tarefa_dominio', async () => {
  await inserir('registro', null, null)
  assert.equal(await codigoDeErro(banco.app.query('DELETE FROM tarefa_dominio')), '42501')
})

for (const coluna of ['tipo', 'referencia_expira_em', 'situacao_fatura', 'aberta_em', 'pedido_dominio_id']) {
  test(`CA9: o papel da aplicação recebe 42501 em UPDATE de tarefa_dominio.${coluna}`, async () => {
    await inserir('registro', null, null)
    assert.equal(await codigoDeErro(banco.app.query(`UPDATE tarefa_dominio SET ${coluna} = ${coluna}`)), '42501')
  })
}

for (const coluna of ['concluida_em', 'alertada_em', 'ultimo_lembrete_em']) {
  test(`CA9: o papel da aplicação atualiza tarefa_dominio.${coluna}`, async () => {
    await inserir('registro', null, null)
    assert.equal(await codigoDeErro(banco.app.query(`UPDATE tarefa_dominio SET ${coluna} = now()`)), undefined)
  })
}

test('CA9: o papel da aplicação recebe 42501 em UPDATE de pedido_dominio.nome', async () => {
  assert.equal(await codigoDeErro(banco.app.query("UPDATE pedido_dominio SET nome = 'outro.exemplo.test'")), '42501')
})

test('CA9: o papel da aplicação atualiza as datas de registro de pedido_dominio e pedido', async () => {
  assert.equal(await codigoDeErro(banco.app.query('UPDATE pedido_dominio SET registrado_em = now(), registro_expira_em = current_date')), undefined)
  assert.equal(await codigoDeErro(banco.app.query('UPDATE pedido SET dominio_registrado_em = now()')), undefined)
})

// ---- auditoria ----------------------------------------------------------------------------

const INSERT_AUDITORIA = `INSERT INTO auditoria (autor_tipo, autor_id, acao, alvo_tipo, alvo_id, ip, resultado)
                          VALUES ('equipe', 'equipe_teste', $1, 'cliente', 'alvo-ficticio', '127.0.0.1', 'sucesso')`

test('CA9: a auditoria aceita a ação dados_titular_consultados', async () => {
  assert.equal(await codigoDeErro(banco.admin.query(INSERT_AUDITORIA, ['dados_titular_consultados'])), undefined)
})

test('CA9: registrarAuditoria grava dados_titular_consultados pelo papel da aplicação', async () => {
  const id = await registrarAuditoria(banco.app, {
    autor: { tipo: 'equipe', id: 'equipe_teste' }, acao: 'dados_titular_consultados', alvo: { tipo: 'cliente', id: 'alvo-ficticio-2' },
    resultado: 'sucesso', ip: '127.0.0.1', detalhes: {}
  })
  assert.match(id, /^\d+$/)
})

test('CA9: a auditoria recusa ação inexistente com 23514', async () => {
  assert.equal(await codigoDeErro(banco.admin.query(INSERT_AUDITORIA, ['acao_inexistente'])), '23514')
})

// ---- down ---------------------------------------------------------------------------------

async function comBancoMigrado(corpo) {
  const { nomeBanco, url } = await criarBancoTemporario()
  try {
    await aplicarMigracoes(url)
    // A solicitação de senha (CIT-71) vem depois: sai antes, e a da tarefa de domínio fica por último.
    await aplicarMigracoes(url, 'down', 1)
    const pool = new Pool({ connectionString: url, max: 2 })
    try {
      await corpo(url, pool)
    } finally {
      await pool.end()
    }
  } finally {
    await removerBancoTemporario(nomeBanco)
  }
}

async function semearPedidoCru(pool) {
  const { rows: [cliente] } = await pool.query(
    `INSERT INTO cliente (tipo_pessoa, documento, nome, email, telefone)
     VALUES ('fisica', '52998224725', 'Fulana de Teste', 'fulana@exemplo.test', '11999990000') RETURNING id`
  )
  const { rows: [pedido] } = await pool.query(
    `INSERT INTO pedido (cliente_id, chave_idempotencia, corpo_hash, estado, ciclo, itens, total_centavos, versao_tabela_precos,
                         contato_nome, contato_email, contato_telefone, aceite_em, versao_termos, versao_privacidade, ip_aceite)
     VALUES ($1, gen_random_uuid(), repeat('a', 64), 'aguardando_registro_de_dominio', 'mensal', '{}'::jsonb, 4990, '2026-01-01.1',
             'Fulana', 'fulana@exemplo.test', '11999990000', now(), '0.1', 'p1', '127.0.0.1') RETURNING id`,
    [cliente.id]
  )
  const { rows: [dominio] } = await pool.query(
    "INSERT INTO pedido_dominio (pedido_id, nome, tipo, papel) VALUES ($1, $2, 'novo', 'principal') RETURNING id",
    [pedido.id, DOMINIO_UM]
  )
  return { clienteId: cliente.id, pedidoId: pedido.id, dominioId: dominio.id }
}

const ESTRUTURA = `SELECT (to_regclass('tarefa_dominio') IS NOT NULL)::int
                        + (SELECT count(*)::int FROM information_schema.columns
                            WHERE (table_name, column_name) IN
                                  (('pedido_dominio', 'registrado_em'), ('pedido_dominio', 'registro_expira_em'), ('pedido', 'dominio_registrado_em'))) AS n`

async function recusaDown(url, pool) {
  await assert.rejects(aplicarMigracoes(url, 'down', 1), (erro) => {
    assert.match(erro.message, /tarefas de domínio com registros: down recusado/)
    assert.equal(erro.code, 'P0001')
    return true
  })
  assert.equal((await pool.query(ESTRUTURA)).rows[0].n, 4)
}

test('CA9: o down com linha em tarefa_dominio é recusado (P0001) e nada é removido', async () => {
  await comBancoMigrado(async (url, pool) => {
    const { dominioId } = await semearPedidoCru(pool)
    await pool.query("INSERT INTO tarefa_dominio (pedido_dominio_id, tipo) VALUES ($1, 'registro')", [dominioId])
    await recusaDown(url, pool)
  })
})

test('CA9: o down com pedido_dominio.registrado_em gravado é recusado (P0001)', async () => {
  await comBancoMigrado(async (url, pool) => {
    const { dominioId } = await semearPedidoCru(pool)
    await pool.query('UPDATE pedido_dominio SET registrado_em = now() WHERE id = $1', [dominioId])
    await recusaDown(url, pool)
  })
})

test('CA9: o down com pedido_dominio.registro_expira_em gravado é recusado (P0001)', async () => {
  await comBancoMigrado(async (url, pool) => {
    const { dominioId } = await semearPedidoCru(pool)
    await pool.query('UPDATE pedido_dominio SET registro_expira_em = current_date WHERE id = $1', [dominioId])
    await recusaDown(url, pool)
  })
})

test('CA9: o down com pedido.dominio_registrado_em gravado é recusado (P0001)', async () => {
  await comBancoMigrado(async (url, pool) => {
    const { pedidoId } = await semearPedidoCru(pool)
    await pool.query('UPDATE pedido SET dominio_registrado_em = now() WHERE id = $1', [pedidoId])
    await recusaDown(url, pool)
  })
})

test('CA9: o down com auditoria dados_titular_consultados é recusado (P0001)', async () => {
  await comBancoMigrado(async (url, pool) => {
    await pool.query(INSERT_AUDITORIA, ['dados_titular_consultados'])
    await recusaDown(url, pool)
  })
})

test('CA9: o down vazio remove a tabela e as colunas e restaura o CHECK sem a ação nova', async () => {
  await comBancoMigrado(async (url, pool) => {
    await semearPedidoCru(pool)
    assert.equal((await pool.query(ESTRUTURA)).rows[0].n, 4)
    await aplicarMigracoes(url, 'down', 1)
    assert.equal((await pool.query(ESTRUTURA)).rows[0].n, 0)
    assert.equal(await codigoDeErro(pool.query(INSERT_AUDITORIA, ['dados_titular_consultados'])), '23514')
    assert.equal(await codigoDeErro(pool.query(INSERT_AUDITORIA, ['dominio_registrado_manualmente'])), undefined)
  })
})

test('CA9: o up seguinte ao down recria a tabela, as colunas e a ação', async () => {
  await comBancoMigrado(async (url, pool) => {
    await aplicarMigracoes(url, 'down', 1)
    await aplicarMigracoes(url, 'up', 1)
    assert.equal((await pool.query(ESTRUTURA)).rows[0].n, 4)
    assert.equal(await codigoDeErro(pool.query(INSERT_AUDITORIA, ['dados_titular_consultados'])), undefined)
  })
})
