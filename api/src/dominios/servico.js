// Registro e renovação manuais de domínio e leitura da tarefa pela equipe (E4-H4; CIT-77),
// usados pela CLI `npm run dominio`. Sequência de travas (decisão 4 do plano): lê a tarefa
// sem trava → trava o pedido (`travarPedido`, a mesma do webhook) → relê a tarefa com
// `FOR UPDATE` → grava → audita → conta os domínios novos ainda sem registro, tudo numa
// transação. A auditoria vai no mesmo Client: falhou, nada fica gravado.
import { randomUUID } from 'node:crypto'
import { mudarEstadoDoPedido, travarPedido } from '../asaas/webhook-repositorio.js'
import { registrarAuditoria } from '../auditoria/servico.js'
import { registrarEvento } from '../eventos/servico.js'
import {
  buscarDetalheTarefa, buscarTarefa, concluirTarefa, contarNovosNaoRegistrados, marcarDominioRegistrado,
  marcarDominioRenovado, marcarPedidoDominioRegistrado, travarTarefa
} from './repositorio.js'

// Origem CLI no servidor: a auditoria exige IP para autor `equipe` (decisão 5).
export const IP_CLI = '127.0.0.1'

const TIPO_DA_OPERACAO = { registro: 'registro', renovacao: 'renovacao' }

function autorEquipe(operador) {
  return { tipo: 'equipe', id: operador }
}

// Conclui a tarefa de `operacao` (`registro` ou `renovacao`); ver `marcarRegistrado`.
async function concluirTarefaDominio({
  pool, tarefaId, operacao, expiraEm, operador, usuarioSistema, auditoria = registrarAuditoria
}) {
  const cliente = await pool.connect()
  let erroDoCliente
  try {
    await cliente.query('BEGIN')
    const tarefa = await buscarTarefa(cliente, tarefaId)
    if (!tarefa) {
      await cliente.query('ROLLBACK')
      return { saida: 1, motivo: 'tarefa_inexistente' }
    }
    const pedido = await travarPedido(cliente, tarefa.pedido_id)
    if (pedido.estado === 'cancelado') {
      await cliente.query('ROLLBACK')
      return { saida: 2, motivo: 'pedido_cancelado' }
    }
    const travada = await travarTarefa(cliente, tarefaId)
    if (travada.concluida_em !== null) {
      await cliente.query('ROLLBACK')
      return { saida: 2, motivo: 'tarefa_concluida' }
    }
    if (travada.tipo !== TIPO_DA_OPERACAO[operacao]) {
      await cliente.query('ROLLBACK')
      return { saida: 2, motivo: 'tipo_diferente' }
    }

    if (operacao === 'registro') await marcarDominioRegistrado(cliente, travada.pedido_dominio_id, expiraEm)
    else await marcarDominioRenovado(cliente, travada.pedido_dominio_id, expiraEm)
    await concluirTarefa(cliente, tarefaId)
    await auditoria(cliente, {
      autor: autorEquipe(operador),
      acao: 'dominio_registrado_manualmente',
      alvo: { tipo: 'dominio', id: travada.pedido_dominio_id },
      resultado: 'sucesso',
      ip: IP_CLI,
      detalhes: { pedidoId: pedido.id, expiraEm, operacao, usuarioSistema }
    })

    const resultado = { saida: 0, pedidoPago: false, pendentes: 0, aguardandoContas: false }
    if (operacao === 'registro') {
      resultado.pendentes = await contarNovosNaoRegistrados(cliente, pedido.id)
      if (resultado.pendentes === 0) {
        await marcarPedidoDominioRegistrado(cliente, pedido.id)
        if (pedido.estado === 'aguardando_registro_de_dominio') {
          await mudarEstadoDoPedido(cliente, pedido.id, 'pago')
          await registrarEvento(cliente, {
            nome: 'dominio_registrado',
            agregado: { tipo: 'pedido', id: pedido.id },
            chaveIdempotencia: `dominio_registrado-${pedido.id}`,
            payload: { pedidoId: pedido.id, clienteId: pedido.cliente_id },
            requestId: `cli-dominio-${randomUUID()}`
          })
          resultado.pedidoPago = true
        } else {
          // Domínios pagos antes das contas: o `pedido_pago` do webhook leva o pedido a `pago`.
          resultado.aguardandoContas = pedido.estado === 'aguardando_pagamento'
        }
      }
    }
    const fim = await cliente.query('COMMIT')
    if (fim.command === 'ROLLBACK') throw new Error('transação da tarefa de domínio abortada')
    return resultado
  } catch (err) {
    try {
      await cliente.query('ROLLBACK')
    } catch (erroRollback) {
      // Cliente em estado incerto: descartado do pool no release.
      erroDoCliente = erroRollback
    }
    throw err
  } finally {
    cliente.release(erroDoCliente)
  }
}

/**
 * Registro (`registrado`): conclui a tarefa `registro` gravando `registrado_em` e o
 * vencimento `expiraEm` (`AAAA-MM-DD`, já validado); com o último domínio novo do pedido
 * registrado, grava `dominio_registrado_em` e, com o pedido em
 * `aguardando_registro_de_dominio`, vai a `pago` e emite `dominio_registrado`. Devolve
 * `{ saida: 0, pedidoPago, pendentes, aguardandoContas }` ou `{ saida: 1|2, motivo }`;
 * erro de banco ou de auditoria lança (depois do ROLLBACK).
 * Dados: `{ pool, tarefaId, expiraEm, operador, usuarioSistema, auditoria? }`.
 */
export function marcarRegistrado(dados) {
  return concluirTarefaDominio({ ...dados, operacao: 'registro' })
}

/** Renovação (`renovado`): conclui a tarefa `renovacao` com o novo vencimento; como `marcarRegistrado`. */
export function marcarRenovado(dados) {
  return concluirTarefaDominio({ ...dados, operacao: 'renovacao' })
}

/**
 * Detalhe da tarefa com o titular, só depois de gravada a auditoria
 * `dados_titular_consultados` (LGPD). Devolve `{ saida: 0, detalhe }` ou
 * `{ saida: 1, motivo: 'tarefa_inexistente' }`; falha da auditoria lança `ErroAuditoria` (com
 * o `code` original), e nada é devolvido; outra falha (consulta) lança o erro do `pg`.
 */
export async function mostrarTarefa({ pool, tarefaId, operador, usuarioSistema, auditoria = registrarAuditoria }) {
  const detalhe = await buscarDetalheTarefa(pool, tarefaId)
  if (!detalhe) return { saida: 1, motivo: 'tarefa_inexistente' }
  try {
    await auditoria(pool, {
    autor: autorEquipe(operador),
    acao: 'dados_titular_consultados',
    alvo: { tipo: 'cliente', id: detalhe.cliente_id },
    resultado: 'sucesso',
    ip: IP_CLI,
      detalhes: { tarefaId, usuarioSistema }
    })
  } catch (err) {
    // Erro novo, sem `cause` nem a mensagem original (pode repetir valores): só o código.
    throw Object.assign(new Error('auditoria não gravada'), { name: 'ErroAuditoria', code: err?.code ?? err?.name })
  }
  return { saida: 0, detalhe }
}
