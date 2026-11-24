// Tarefas manuais de registro e renovação de domínio novo (E4-H4; CIT-77), no servidor:
// `npm run dominio -- <subcomando>`. Sem endpoint: não há autenticação de equipe. Usa o
// mesmo `DATABASE_URL` da aplicação (papel `<banco>_aplicacao`), sem CORS, Redis nem
// Telegram. Saída 0 ok, 1 uso, entrada inválida, tarefa inexistente ou falha; 2 estado
// que não permite (tarefa já concluída, pedido cancelado, tipo de tarefa diferente).
// Dados do titular só no stdout do `mostrar`, depois da auditoria; nunca em log nem no
// stderr, que recebe só mensagens fixas e o `code` do erro (nunca `message`/`detail`).
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { carregarConfigBanco } from '../config.js'
import { criarPool } from '../banco.js'
import { criarLogger } from '../log.js'
import { registrarAuditoria } from '../auditoria/servico.js'
import { dataLocal, diasUteisEntre, somarDias } from '../dominios/dias-uteis.js'
import { listarAbertas } from '../dominios/repositorio.js'
import { marcarRegistrado, marcarRenovado, mostrarTarefa } from '../dominios/servico.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Apelido do operador: nunca e-mail (`@` recusado).
const OPERADOR = /^[a-z][a-z0-9_.-]{1,31}$/
// Conta Unix do servidor (`SUDO_USER` ou o usuário do processo); fora do formato → `-`.
const USUARIO_SISTEMA = /^[a-z_][a-z0-9_-]{0,31}$/
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/
const EXPIRA_MIN_DIAS = 300
const EXPIRA_MAX_ANOS = 10

const USO = 'uso: npm run dominio -- listar [--todas]\n' +
  '       npm run dominio -- mostrar <tarefaId> --operador <apelido>\n' +
  '       npm run dominio -- registrado <tarefaId> --expira-em AAAA-MM-DD --operador <apelido>\n' +
  '       npm run dominio -- renovado <tarefaId> --expira-em AAAA-MM-DD --operador <apelido>\n'

// Opções aceitas por subcomando (`true`: flag sem valor).
const OPCOES = {
  listar: { '--todas': true },
  mostrar: { '--operador': false },
  registrado: { '--expira-em': false, '--operador': false },
  renovado: { '--expira-em': false, '--operador': false }
}

const LOG_MUDO = { info() {} }

const MOTIVOS = {
  tarefa_inexistente: [1, 'tarefa inexistente'],
  pedido_cancelado: [2, 'pedido cancelado: nada gravado'],
  tarefa_concluida: [2, 'tarefa já concluída: nada gravado']
}

/** Conta Unix de quem roda a CLI: `SUDO_USER` ou, sem ele, o usuário do processo. */
export function usuarioDoSistema(env = process.env) {
  if (env.SUDO_USER) return env.SUDO_USER
  try {
    return os.userInfo().username
  } catch {
    return '-'
  }
}

function usuarioSeguro(usuario) {
  return typeof usuario === 'string' && USUARIO_SISTEMA.test(usuario) ? usuario : '-'
}

// `null` se os argumentos não cabem no subcomando (opção desconhecida, repetida ou sem valor).
function lerArgs(subcomando, resto) {
  const aceitas = OPCOES[subcomando]
  const posicionais = []
  const opcoes = {}
  for (let i = 0; i < resto.length; i++) {
    const arg = resto[i]
    if (!arg.startsWith('--')) {
      posicionais.push(arg)
      continue
    }
    if (!Object.hasOwn(aceitas, arg) || Object.hasOwn(opcoes, arg)) return null
    if (aceitas[arg]) {
      opcoes[arg] = true
      continue
    }
    if (i + 1 >= resto.length) return null
    opcoes[arg] = resto[++i]
  }
  return { posicionais, opcoes }
}

// Data ISO real (`2027-02-30` é recusada).
function dataValida(texto) {
  const partes = DATA.exec(texto ?? '')
  if (!partes) return false
  const [, ano, mes, dia] = partes.map(Number)
  const data = new Date(Date.UTC(ano, mes - 1, dia))
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia
}

// Hoje + 10 anos (29/02 vira 28/02).
function somarAnos(data, anos) {
  const [ano, mes, dia] = data.split('-')
  const resultado = `${Number(ano) + anos}-${mes}-${dia}`
  return dataValida(resultado) ? resultado : `${Number(ano) + anos}-${mes}-28`
}

function validarOperador(opcoes, erro) {
  const operador = opcoes['--operador']
  if (operador === undefined) {
    erro.write('--operador ausente\n')
    return null
  }
  if (!OPERADOR.test(operador)) {
    erro.write('--operador inválido: use de 2 a 32 caracteres a-z, 0-9, _, . ou -, começando por letra (nunca e-mail)\n')
    return null
  }
  return operador
}

function validarExpiraEm(opcoes, hoje, erro) {
  const expiraEm = opcoes['--expira-em']
  if (expiraEm === undefined) {
    erro.write('--expira-em ausente\n')
    return null
  }
  if (!dataValida(expiraEm) || expiraEm < somarDias(hoje, EXPIRA_MIN_DIAS) || expiraEm > somarAnos(hoje, EXPIRA_MAX_ANOS)) {
    erro.write(`--expira-em inválida: use AAAA-MM-DD entre hoje + ${EXPIRA_MIN_DIAS} dias e hoje + ${EXPIRA_MAX_ANOS} anos\n`)
    return null
  }
  return expiraEm
}

async function listar({ pool, opcoes, saida, agora }) {
  const tarefas = await listarAbertas(pool, { todas: opcoes['--todas'] === true })
  if (tarefas.length === 0) {
    saida.write('nenhuma tarefa aberta\n')
    return 0
  }
  const instante = agora()
  saida.write('tarefa\ttipo\tpedido\testado do pedido\tdomínio\taberta em\tdias úteis\n')
  for (const tarefa of tarefas) {
    // Pedido cancelado (só com --todas): marcado; `registrado`/`renovado` nela devolvem 2.
    const estado = tarefa.pedido_estado === 'cancelado' ? 'cancelado (não registrar)' : tarefa.pedido_estado
    saida.write(`${tarefa.id}\t${tarefa.tipo}\t${tarefa.pedido_id}\t${estado}\t${tarefa.dominio}\t` +
      `${dataLocal(tarefa.aberta_em)}\t${diasUteisEntre(tarefa.aberta_em, instante)}\n`)
  }
  return 0
}

function escreverDetalhe(saida, detalhe) {
  const linhas = [
    ['tarefa', detalhe.id],
    ['tipo', detalhe.tipo],
    ['pedido', `${detalhe.pedido_id} (${detalhe.pedido_estado})`],
    ['domínio', detalhe.dominio],
    ['expira em', detalhe.registro_expira_em ?? '-'],
    ['aberta em', dataLocal(detalhe.aberta_em)],
    ['concluída em', detalhe.concluida_em ? dataLocal(detalhe.concluida_em) : '-']
  ]
  if (detalhe.tipo === 'renovacao') {
    linhas.push(['referência', detalhe.referencia_expira_em], ['situação da fatura', detalhe.situacao_fatura])
  }
  linhas.push(
    ['titular', detalhe.titular_nome],
    ['tipo de pessoa', detalhe.titular_tipo_pessoa],
    ['documento', detalhe.titular_documento],
    ['e-mail', detalhe.titular_email],
    ['telefone', detalhe.titular_telefone]
  )
  saida.write(linhas.map(([rotulo, valor]) => `${rotulo}: ${valor}\n`).join(''))
}

/**
 * Núcleo da CLI, com banco, saídas, log, relógio e auditoria injetáveis (testes).
 * `args` sem o `node` e o script (`process.argv.slice(2)`).
 *
 * @returns {Promise<number>} código de saída (0, 1 ou 2)
 */
export async function executarDominio({
  pool, args = [], saida = process.stdout, erro = process.stderr, log = LOG_MUDO, agora = () => new Date(),
  auditoria = registrarAuditoria, usuarioSistema = usuarioDoSistema()
}) {
  const [subcomando, ...resto] = args
  const lidos = Object.hasOwn(OPCOES, subcomando ?? '') ? lerArgs(subcomando, resto) : null
  const esperados = subcomando === 'listar' ? 0 : 1
  if (!lidos || lidos.posicionais.length !== esperados) {
    erro.write(USO)
    return 1
  }
  const { posicionais: [tarefaId], opcoes } = lidos
  if (subcomando === 'listar') {
    try {
      return await listar({ pool, opcoes, saida, agora })
    } catch (err) {
      erro.write(`falha ao listar (${err?.code ?? err?.name})\n`)
      return 1
    }
  }

  if (!UUID.test(tarefaId)) {
    erro.write('tarefaId inválido: use o UUID da tarefa\n')
    return 1
  }
  const operador = validarOperador(opcoes, erro)
  if (!operador) return 1
  const usuario = usuarioSeguro(usuarioSistema)

  if (subcomando === 'mostrar') {
    let resultado
    try {
      resultado = await mostrarTarefa({ pool, tarefaId, operador, usuarioSistema: usuario, auditoria })
    } catch (err) {
      erro.write(`auditoria não gravada: nada exibido (${err?.code ?? err?.name})\n`)
      return 1
    }
    if (resultado.saida !== 0) {
      erro.write(`${MOTIVOS[resultado.motivo][1]}\n`)
      return resultado.saida
    }
    log.info({ tarefaId }, 'dados do titular consultados')
    escreverDetalhe(saida, resultado.detalhe)
    return 0
  }

  const expiraEm = validarExpiraEm(opcoes, dataLocal(agora()), erro)
  if (!expiraEm) return 1
  const operacao = subcomando === 'registrado' ? 'registro' : 'renovacao'
  const marcar = operacao === 'registro' ? marcarRegistrado : marcarRenovado
  let resultado
  try {
    resultado = await marcar({ pool, tarefaId, expiraEm, operador, usuarioSistema: usuario, auditoria })
  } catch (err) {
    erro.write(`falha: nada gravado (${err?.code ?? err?.name})\n`)
    return 1
  }
  if (resultado.saida !== 0) {
    const mensagem = resultado.motivo === 'tipo_diferente'
      ? `a tarefa não é de ${operacao === 'registro' ? 'registro' : 'renovação'}: nada gravado`
      : MOTIVOS[resultado.motivo][1]
    erro.write(`${mensagem}\n`)
    return resultado.saida
  }
  log.info({ tarefaId, operacao, pedidoPago: resultado.pedidoPago }, 'tarefa de domínio concluída')
  if (operacao === 'renovacao') {
    saida.write(`tarefa ${tarefaId} concluída: renovação gravada\n`)
  } else if (resultado.pedidoPago) {
    saida.write(`tarefa ${tarefaId} concluída: pedido pago e dominio_registrado emitido\n`)
  } else if (resultado.pendentes > 0) {
    saida.write(`tarefa ${tarefaId} concluída: ${resultado.pendentes} domínio(s) do pedido ainda sem registro\n`)
  } else if (resultado.aguardandoContas) {
    saida.write(`tarefa ${tarefaId} concluída: registro gravado; o pedido vai a pago com o pagamento das contas\n`)
  } else {
    saida.write(`tarefa ${tarefaId} concluída: registro gravado\n`)
  }
  return 0
}

async function main() {
  let config
  try {
    config = carregarConfigBanco()
  } catch (erro) {
    console.error(`Configuração inválida: ${erro.message}`)
    return 1
  }
  // Log no stderr: o stdout é a saída do comando.
  const log = criarLogger({ level: config.logLevel, stream: process.stderr })
  const pool = criarPool(config.databaseUrl, log)
  try {
    return await executarDominio({ pool, args: process.argv.slice(2), log })
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
