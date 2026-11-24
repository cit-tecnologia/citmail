// Laço das tarefas de domínio no worker (E4-H4; CIT-77), na forma do enfileirador de
// e-mail (CIT-65): aviso de abertura das tarefas de registro, lembrete diário das paradas
// há mais de 2 dias úteis, abertura da renovação em D-30 e aviso da renovação. Cada aviso
// segue SELECT → `addBulk` com `jobId` determinístico (com prazo) → marcar: fila fora não
// marca (o próximo ciclo tenta de novo) e marcação perdida repete o `jobId` sem duplicar.
// Premissa: o `jobId` repetido só deduplica enquanto o job ainda está no Redis (concluídos
// ficam 1 dia ou até 1000 por fila); marcação perdida por mais tempo que isso gera um
// alerta repetido, aceito (é só aviso à equipe).
// Os alertas levam só códigos e ids, nunca o nome do domínio nem dado do titular.
import { LIMITE_PUBLICACAO_MS } from '../eventos/publicador.js'
import { dataLocal, diasUteisEntre, ehDiaUtil } from './dias-uteis.js'
import {
  abrirRenovacoes, buscarCandidatosLembrete, buscarRegistrosNaoAlertados, buscarRenovacoesNaoAlertadas,
  marcarAlertadas, marcarLembrete
} from './repositorio.js'

export const INTERVALO_PADRAO_MS = 300000
export const LOTE_PADRAO = 50
// Lembrete quando os dias úteis decorridos desde a abertura passam disto.
export const DIAS_UTEIS_LEMBRETE = 2

const ALERTA = 'dominio'

// Prazo do `add`/`addBulk`: com o Redis fora, o BullMQ espera a conexão indefinidamente.
async function comPrazo(promessa) {
  let timer
  try {
    return await Promise.race([
      promessa,
      new Promise((_, rejeitar) => {
        timer = setTimeout(() => {
          rejeitar(Object.assign(new Error('limite da fila'), { name: 'TimeoutError' }))
        }, LIMITE_PUBLICACAO_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function alerta(codigo, { tarefaId = null, pedidoId }, jobId) {
  return { name: ALERTA, data: { tipo: ALERTA, codigo, tarefaId, pedidoId }, opts: { jobId } }
}

async function enfileirar(filas, jobs) {
  if (jobs.length > 0) await comPrazo(filas.alertas.addBulk(jobs))
}

// Aviso de abertura: 1 alerta por pedido; pedido cancelado (ou fora dos dois estados de
// espera do registro) é marcado sem alerta.
async function avisarRegistros({ pool, filas, lote }, instante) {
  const grupos = await buscarRegistrosNaoAlertados(pool, lote)
  if (grupos.length === 0) return 0
  const jobs = []
  for (const { pedido_id: pedidoId, pedido_estado: estado } of grupos) {
    const codigo = estado === 'aguardando_registro_de_dominio'
      ? 'tarefa_registro'
      : estado === 'aguardando_pagamento' ? 'tarefa_registro_contas_pendentes' : null
    if (codigo) jobs.push(alerta(codigo, { pedidoId }, `alerta-tarefa_registro-${pedidoId}`))
  }
  await enfileirar(filas, jobs)
  await marcarAlertadas(pool, grupos.flatMap((grupo) => grupo.tarefas), instante)
  return jobs.length
}

// Lembrete: só em dia útil, 1 por tarefa por dia, com mais de 2 dias úteis desde a abertura.
async function lembrarRegistros({ pool, filas, lote }, instante, hoje) {
  if (!ehDiaUtil(hoje)) return 0
  const candidatos = (await buscarCandidatosLembrete(pool, hoje, instante, lote))
    .filter((tarefa) => diasUteisEntre(tarefa.aberta_em, instante) > DIAS_UTEIS_LEMBRETE)
  if (candidatos.length === 0) return 0
  const dia = hoje.replaceAll('-', '')
  await enfileirar(filas, candidatos.map((tarefa) => alerta('lembrete_registro',
    { tarefaId: tarefa.id, pedidoId: tarefa.pedido_id }, `alerta-lembrete_registro-${tarefa.id}-${dia}`)))
  await marcarLembrete(pool, candidatos.map((tarefa) => tarefa.id), instante)
  return candidatos.length
}

// Aviso da renovação: 1 alerta por tarefa; pedido cancelado é marcado sem alerta.
async function avisarRenovacoes({ pool, filas, lote }, instante) {
  const tarefas = await buscarRenovacoesNaoAlertadas(pool, lote)
  if (tarefas.length === 0) return 0
  const jobs = tarefas
    .filter((tarefa) => tarefa.pedido_estado !== 'cancelado')
    .map((tarefa) => alerta(tarefa.situacao_fatura === 'paga' ? 'renovacao_paga' : 'renovacao_pendente',
      { tarefaId: tarefa.id, pedidoId: tarefa.pedido_id }, `alerta-renovacao-${tarefa.id}`))
  await enfileirar(filas, jobs)
  await marcarAlertadas(pool, tarefas.map((tarefa) => tarefa.id), instante)
  return jobs.length
}

/**
 * Um ciclo do laço. As etapas são isoladas: a falha de uma (fila ou banco) só vai ao log
 * (`warn` com nome e código do erro, sem dado) e não impede as outras. `agora` é o relógio
 * (injetado nos testes). Nunca lança.
 *
 * @returns {Promise<{ avisos: number, lembretes: number, renovacoes: number, avisosRenovacao: number }>}
 */
export async function executarCicloDominio({ pool, filas, log, agora = () => new Date(), lote = LOTE_PADRAO }) {
  const instante = agora()
  const hoje = dataLocal(instante)
  const contexto = { pool, filas, lote }
  const resultado = { avisos: 0, lembretes: 0, renovacoes: 0, avisosRenovacao: 0 }
  const etapas = [
    ['avisos', () => avisarRegistros(contexto, instante), 'aviso de tarefa de registro falhou'],
    ['lembretes', () => lembrarRegistros(contexto, instante, hoje), 'lembrete de tarefa de registro falhou'],
    ['renovacoes', () => abrirRenovacoes(pool, hoje, lote), 'abertura de tarefa de renovação falhou'],
    ['avisosRenovacao', () => avisarRenovacoes(contexto, instante), 'aviso de tarefa de renovação falhou']
  ]
  for (const [campo, etapa, mensagem] of etapas) {
    try {
      resultado[campo] = await etapa()
    } catch (err) {
      // Erro do ioredis traz host e porta, e o do `pg` pode repetir valores: só nome e código.
      log.warn({ erro: err?.name, codigo: err?.code }, mensagem)
    }
  }
  return resultado
}

/**
 * Inicia o laço, na forma de `iniciarEnfileiradorEmail`: um ciclo logo ao iniciar e os
 * seguintes a cada `intervaloMs` depois do fim do anterior. `agora` e `aoCiclo` só nos
 * testes. `close()` cancela o próximo ciclo e espera o que estiver em curso.
 *
 * @returns {{ close: () => Promise<void> }}
 */
export function iniciarTarefasDominio({
  pool, filas, log, intervaloMs = INTERVALO_PADRAO_MS, agora, lote = LOTE_PADRAO, aoCiclo
}) {
  let parado = false
  let timer
  let emCurso = null

  async function rodar() {
    try {
      const resultado = await executarCicloDominio({ pool, filas, log, agora, lote })
      aoCiclo?.(resultado)
    } catch (err) {
      log.error({ erro: err?.name }, 'ciclo das tarefas de domínio falhou')
    }
  }

  function agendar(atrasoMs) {
    timer = setTimeout(() => {
      emCurso = rodar().finally(() => {
        emCurso = null
        if (!parado) agendar(intervaloMs)
      })
    }, atrasoMs)
  }

  agendar(0)
  log.info({ intervaloMs }, 'tarefas de domínio iniciadas')

  return {
    async close() {
      parado = true
      clearTimeout(timer)
      if (emCurso) await emCurso
    }
  }
}
