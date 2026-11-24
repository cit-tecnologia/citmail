// Auxiliares dos testes das tarefas de domínio (CIT-77): pedido com domínios e tarefas
// semeados pelo dono do banco, evento `dominio_pago` e saída de texto capturada. Só dados
// fictícios (`exemplo.test`).
import { randomUUID } from 'node:crypto'
import { semearPedido } from './webhook-fixtures.js'

export const DOMINIO_UM = 'ficticio-um.exemplo.test'
export const DOMINIO_DOIS = 'ficticio-dois.exemplo.test'
export const DADOS_TITULAR = ['Fulano Ficticio', 'fulano@exemplo.test', '11999990000', DOMINIO_UM, DOMINIO_DOIS, 'ficticio-um', 'ficticio-dois']

export const DOIS_NOVOS = [
  { nome: DOMINIO_UM, tipo: 'novo', papel: 'principal' },
  { nome: DOMINIO_DOIS, tipo: 'novo', papel: 'extra' }
]

/** Saída capturada (`write`) com o texto acumulado em `texto()`. */
export function criarSaida() {
  const pedacos = []
  return { write(texto) { pedacos.push(texto) }, texto: () => pedacos.join('') }
}

/** Log que acumula as chamadas, para conferir que nenhum dado pessoal vazou. */
export function criarLogCapturado() {
  const chamadas = []
  const registrar = (nivel) => (...args) => { chamadas.push([nivel, ...args]) }
  return { chamadas, info: registrar('info'), warn: registrar('warn'), error: registrar('error'), texto: () => JSON.stringify(chamadas) }
}

/**
 * Pedido com os domínios e, se `tarefas` (padrão true), uma tarefa `registro` por domínio novo,
 * inseridas pelo dono. `abertaEm` fixa `aberta_em`. Devolve ids de pedido, cliente, domínios e tarefas.
 */
export async function semearComTarefas(admin, {
  estado = 'aguardando_registro_de_dominio', dominios = DOIS_NOVOS, abertaEm = '2026-12-01T12:00:00Z', tarefas = true,
  assinaturas = { contas: `sub_contas_${randomUUID().slice(0, 8)}`, dominios: `sub_dom_${randomUUID().slice(0, 8)}` }, ...resto
} = {}) {
  const pedido = await semearPedido(admin, { estado, dominios, assinaturas, dominioPagoEm: new Date(), ...resto })
  const dominioIds = (await admin.query('SELECT id FROM pedido_dominio WHERE pedido_id = $1 ORDER BY nome', [pedido.pedidoId]))
    .rows.map((linha) => linha.id)
  const tarefaIds = []
  if (tarefas) {
    for (const id of dominioIds) {
      const novo = (await admin.query('SELECT tipo FROM pedido_dominio WHERE id = $1', [id])).rows[0].tipo === 'novo'
      if (!novo) continue
      tarefaIds.push((await admin.query(
        "INSERT INTO tarefa_dominio (pedido_dominio_id, tipo, aberta_em) VALUES ($1, 'registro', $2) RETURNING id",
        [id, abertaEm]
      )).rows[0].id)
    }
  }
  return { ...pedido, dominioIds, tarefaIds }
}

/** Evento `dominio_pago` como o webhook o grava. Devolve o id. */
export async function gravarDominioPago(admin, pedidoId, { agregadoTipo = 'pedido', agregadoId = pedidoId, payload = { pedidoId } } = {}) {
  const id = randomUUID()
  await admin.query(
    `INSERT INTO evento (id, nome, versao, agregado_tipo, agregado_id, chave_idempotencia, payload)
     VALUES ($1, 'dominio_pago', 1, $2, $3, $4, $5::jsonb)`,
    [id, agregadoTipo, agregadoId, `dominio_pago-${pedidoId}-${id}`, JSON.stringify(payload)]
  )
  return id
}

export const tarefasDe = async (admin) => (await admin.query('SELECT * FROM tarefa_dominio ORDER BY id')).rows

export const TRUNCAR = `TRUNCATE tarefa_dominio, asaas_webhook_evento, conta_titular, evento_processado, evento,
                                 assinatura, pedido_dominio, pedido, cliente CASCADE` // auditoria é só de inclusão: testes filtram por alvo
