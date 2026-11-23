// Criação do pedido no Asaas (ADR 0014; CIT-61). Fluxo D1 do plano:
//  1. consulta pela chave (reenvio devolve o gravado) → limites → documento e domínios → total (409);
//  2. transação curta: cliente, pedido em `criando` (posse = `criando_desde`) e domínios;
//  3. cliente no Asaas (consulta antes de criar e antes de declarar falha);
//  4. assinaturas (contas; domínios se houver avulso), idem, e a URL da 1ª fatura;
//  5. transação final guardada pela posse.
// Nenhuma transação fica aberta durante chamada ao Asaas. Falha nos passos 3 e 4 remove
// as assinaturas já obtidas (compensação) e grava `falhou_na_criacao`. Logs só com ids e
// códigos (D7); erro de banco só com `code` e `routine`.
import { createHash } from 'node:crypto'
import { ErroAsaas } from '../asaas/cliente.js'
import { calcularOrcamento, validarLimites } from '../precos/servico.js'
import { VERSAO } from '../precos/tabela.js'
import { normalizarDocumento, tipoPessoa } from './documento.js'
import {
  nomeDominioExistente,
  nomeDominioNovo,
  normalizarDominioExistente,
  normalizarDominioNovo
} from './dominio.js'
import * as repositorio from './repositorio.js'

// Prazo global das chamadas de criação ao Asaas numa requisição (D1, passo 0).
export const PRAZO_PEDIDO_MS = 45000
const FUSO = 'America/Sao_Paulo'
const DIAS_ATE_VENCIMENTO = 3
const INVALIDO = 'valor inválido'
export const MENSAGEM_ASAAS_INDISPONIVEL = 'Não foi possível gerar a cobrança agora. Tente de novo em alguns minutos.'

class ErroBanco extends Error {
  constructor(erro) {
    super('banco')
    this.name = 'ErroBanco'
    this.code = erro?.code
    this.routine = erro?.routine
  }
}

async function noBanco(operacao) {
  try {
    return await operacao()
  } catch (erro) {
    throw erro instanceof ErroBanco ? erro : new ErroBanco(erro)
  }
}

function respostaFalha(motivo, requestId) {
  if (motivo === 'asaas_timeout') {
    return { status: 504, corpo: { erro: 'asaas_indisponivel', mensagem: MENSAGEM_ASAAS_INDISPONIVEL } }
  }
  if (motivo?.startsWith('asaas_')) {
    return { status: 502, corpo: { erro: 'asaas_indisponivel', mensagem: MENSAGEM_ASAAS_INDISPONIVEL } }
  }
  return { status: 500, corpo: { erro: 'interno', requestId } }
}

const EM_CRIACAO = { status: 409, corpo: { erro: 'pedido_em_criacao' } }

function normalizarCliente(cliente) {
  return {
    nome: cliente.nome.trim().replace(/\s+/g, ' '),
    email: cliente.email.trim().toLowerCase(),
    telefone: cliente.telefone.replace(/\D/g, ''),
    documento: normalizarDocumento(cliente.documento)
  }
}

// JSON com chaves ordenadas em todos os níveis.
function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`
  if (valor !== null && typeof valor === 'object') {
    return `{${Object.keys(valor).sort().map((chave) => `${JSON.stringify(chave)}:${canonico(valor[chave])}`).join(',')}}`
  }
  return JSON.stringify(valor)
}

// D3: hash do corpo sem a chave e sem o bloco `cliente` (nenhum dado pessoal), com os
// domínios normalizados. O cliente é comparado às colunas, à parte.
function hashDoCorpo(corpo) {
  const { chave_idempotencia: _chave, cliente: _cliente, ...resto } = corpo
  const normalizarPrincipal = corpo.dominio.tipo === 'novo' ? normalizarDominioNovo : normalizarDominioExistente
  const semDadoPessoal = {
    ...resto,
    dominio: { ...corpo.dominio, nome: normalizarPrincipal(corpo.dominio.nome) },
    dominios_extras: (corpo.dominios_extras ?? []).map(normalizarDominioNovo)
  }
  return createHash('sha256').update(canonico(semDadoPessoal)).digest('hex')
}

// D6: documento, contato e domínios. Devolve os campos inválidos e os domínios a gravar.
function validarDados(corpo, cliente) {
  const campos = []
  const tipo = tipoPessoa(cliente.documento)
  if (!tipo) campos.push({ campo: 'cliente.documento', mensagem: INVALIDO })
  if (cliente.nome.length < 2 || cliente.nome.length > 100) campos.push({ campo: 'cliente.nome', mensagem: INVALIDO })
  if (cliente.email.length < 3 || cliente.email.length > 254) campos.push({ campo: 'cliente.email', mensagem: INVALIDO })
  if (!/^[0-9]{10,11}$/.test(cliente.telefone)) campos.push({ campo: 'cliente.telefone', mensagem: INVALIDO })

  const dominios = []
  const nomes = new Set()
  const principal = corpo.dominio.tipo === 'novo'
    ? nomeDominioNovo(corpo.dominio.nome)
    : nomeDominioExistente(corpo.dominio.nome)
  if (principal) {
    nomes.add(principal)
    dominios.push({ nome: principal, tipo: corpo.dominio.tipo, papel: 'principal' })
  } else {
    campos.push({ campo: 'dominio.nome', mensagem: INVALIDO })
  }

  const extras = corpo.dominios_extras ?? []
  if (extras.length !== (corpo.addons?.extraDom ?? 0)) campos.push({ campo: 'dominios_extras', mensagem: INVALIDO })
  extras.forEach((valor, indice) => {
    const nome = nomeDominioNovo(valor)
    if (!nome || nomes.has(nome)) {
      campos.push({ campo: `dominios_extras.${indice}`, mensagem: INVALIDO })
      return
    }
    nomes.add(nome)
    dominios.push({ nome, tipo: 'novo', papel: 'extra' })
  })
  return { campos, dominios, tipoPessoa: tipo }
}

// Data do pedido em America/Sao_Paulo + 3 dias corridos, `AAAA-MM-DD` (decisão 2).
export function calcularVencimento(data) {
  const [ano, mes, dia] = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(data).split('-').map(Number)
  return new Date(Date.UTC(ano, mes - 1, dia + DIAS_ATE_VENCIMENTO)).toISOString().slice(0, 10)
}

// Assinaturas do pedido a partir do snapshot gravado (vale também na retomada, mesmo
// que a tabela de preços tenha mudado): contas sempre; domínios com avulso > 0.
function planosDeAssinatura(dados) {
  const avulso = (dados.itens.avulsos ?? []).reduce((soma, item) => soma + item.subtotal_centavos, 0)
  const anual = dados.ciclo === 'anual'
  const planos = [{
    tipo: 'contas',
    ciclo: dados.ciclo,
    cycle: anual ? 'YEARLY' : 'MONTHLY',
    valorCentavos: dados.total_centavos - avulso
  }]
  if (avulso > 0) planos.push({ tipo: 'dominios', ciclo: 'anual', cycle: 'YEARLY', valorCentavos: avulso })
  return planos
}

// Marca a operação no erro do Asaas, para o log (D7).
async function chamar(operacao, chamada) {
  try {
    return await chamada()
  } catch (erro) {
    if (erro instanceof ErroAsaas && !erro.operacao) erro.operacao = operacao
    throw erro
  }
}

// Timeout ou erro no POST: consulta de novo antes de declarar falha (decisão 5). Se a
// consulta também falhar, vale o erro do POST.
async function criarComConfirmacao(operacao, criar, confirmar) {
  try {
    return await chamar(operacao, criar)
  } catch (erro) {
    if (!(erro instanceof ErroAsaas)) throw erro
    let achado = null
    try {
      achado = await confirmar()
    } catch {
      achado = null
    }
    if (achado) return achado
    throw erro
  }
}

export function criarServicoPedidos({
  pool,
  asaas,
  asaasTimeoutMs = 10000,
  agora = () => new Date(),
  versaoTabela = VERSAO,
  prazoPedidoMs = PRAZO_PEDIDO_MS,
  prazoCriandoMs
}) {
  // Maior que o prazo global mais a compensação: o fluxo original sempre termina ou
  // desiste antes de uma retomada começar (95 s com o padrão).
  const prazoRetomadaMs = prazoCriandoMs ?? prazoPedidoMs + 2 * asaasTimeoutMs + 30000

  async function emTransacao(operacao) {
    const conexao = await pool.connect()
    let erroAoDesfazer
    try {
      await conexao.query('BEGIN')
      const valor = await operacao(conexao)
      await conexao.query(valor ? 'COMMIT' : 'ROLLBACK')
      return valor
    } catch (erro) {
      await conexao.query('ROLLBACK').catch((erroRollback) => {
        erroAoDesfazer = erroRollback
      })
      throw erro
    } finally {
      conexao.release(erroAoDesfazer)
    }
  }

  function possePerdida(pedidoId, log) {
    log.info({ pedidoId }, 'posse perdida')
    return EM_CRIACAO
  }

  function logarErroBanco(log, pedidoId, erro) {
    log.error({ pedidoId, code: erro.code, routine: erro.routine }, 'erro de banco no pedido')
  }

  async function responderCriado(pedidoId, estado) {
    const faturas = await noBanco(() => repositorio.buscarFaturas(pool, pedidoId))
    return { status: 201, corpo: { pedidoId, estado, faturas } }
  }

  // Compensação best-effort, fora do prazo global (até 2 × ASAAS_TIMEOUT_MS no total).
  async function compensar(pedidoId, obtidas, log) {
    const sinal = AbortSignal.timeout(2 * asaasTimeoutMs)
    for (const { asaasAssinaturaId } of obtidas) {
      try {
        await asaas.removerAssinatura(asaasAssinaturaId, { signal: sinal })
      } catch {
        log.error({ pedidoId, asaasAssinaturaId }, 'assinatura órfã')
      }
    }
  }

  async function falhar({ pedidoId, posse, motivo, obtidas, erro, log, requestId }) {
    if (erro instanceof ErroBanco) logarErroBanco(log, pedidoId, erro)
    log.warn(
      { pedidoId, falhaMotivo: motivo, operacao: erro?.operacao, statusAsaas: erro?.status },
      'pedido falhou na criação'
    )
    // Sem conseguir conferir a posse, não compensa: o pedido fica em `criando` e a
    // retomada reaproveita as assinaturas pelo `externalReference`.
    let comPosse
    try {
      comPosse = await repositorio.temPosse(pool, pedidoId, posse)
    } catch (erroBanco) {
      logarErroBanco(log, pedidoId, erroBanco)
      return respostaFalha('banco', requestId)
    }
    if (!comPosse) return possePerdida(pedidoId, log)
    await compensar(pedidoId, obtidas, log)
    try {
      if (!(await repositorio.marcarFalha(pool, pedidoId, posse, motivo))) return possePerdida(pedidoId, log)
    } catch (erroBanco) {
      logarErroBanco(log, pedidoId, erroBanco)
    }
    return respostaFalha(motivo, requestId)
  }

  async function obterClienteAsaas(dados, sinal) {
    if (dados.asaas_cliente_id) return dados.asaas_cliente_id
    const buscar = () => asaas.buscarClientePorDocumento(dados.documento, { signal: sinal })
    let asaasClienteId = await chamar('buscar_cliente', buscar)
    if (!asaasClienteId) {
      asaasClienteId = await criarComConfirmacao('criar_cliente', () => asaas.criarCliente({
        nome: dados.nome,
        email: dados.email,
        telefone: dados.telefone,
        documento: dados.documento,
        referencia: `cliente:${dados.cliente_id}`
      }, { signal: sinal }), buscar)
    }
    return noBanco(() => repositorio.gravarAsaasClienteId(pool, dados.cliente_id, asaasClienteId))
  }

  async function obterAssinatura(pedidoId, plano, asaasClienteId, vencimento, sinal) {
    const referencia = `pedido:${pedidoId}:${plano.tipo}`
    const buscar = () => asaas.buscarAssinaturaPorReferencia(referencia, { signal: sinal })
    const achada = await chamar('buscar_assinatura', buscar)
    if (achada) return achada
    return criarComConfirmacao('criar_assinatura', () => asaas.criarAssinatura({
      cliente: asaasClienteId,
      valorCentavos: plano.valorCentavos,
      vencimento,
      ciclo: plano.cycle,
      referencia
    }, { signal: sinal }), buscar)
  }

  // Lista vazia, erro ou timeout: `url: null`, sem falhar o pedido (decisão 6).
  async function urlDaFatura(pedidoId, asaasAssinaturaId, sinal, log) {
    try {
      return await asaas.urlPrimeiraFatura(asaasAssinaturaId, { signal: sinal })
    } catch (erro) {
      log.warn({ pedidoId, asaasAssinaturaId, operacao: 'buscar_fatura', statusAsaas: erro?.status }, 'fatura sem url')
      return null
    }
  }

  // Passos 3 a 5, com a posse do fluxo (criação nova ou retomada).
  async function executarCriacao(pedidoId, posse, log, requestId) {
    const sinal = AbortSignal.timeout(prazoPedidoMs)
    const vencimento = calcularVencimento(agora())
    const obtidas = []
    let asaasClienteId
    try {
      const dados = await noBanco(() => repositorio.buscarDadosDoFluxo(pool, pedidoId))
      asaasClienteId = await obterClienteAsaas(dados, sinal)
      for (const plano of planosDeAssinatura(dados)) {
        const asaasAssinaturaId = await obterAssinatura(pedidoId, plano, asaasClienteId, vencimento, sinal)
        const assinatura = { ...plano, clienteId: dados.cliente_id, asaasAssinaturaId, url: null }
        obtidas.push(assinatura)
        assinatura.url = await urlDaFatura(pedidoId, asaasAssinaturaId, sinal, log)
      }
    } catch (erro) {
      if (erro instanceof ErroAsaas) {
        return falhar({ pedidoId, posse, motivo: `asaas_${erro.tipo}`, obtidas, erro, log, requestId })
      }
      if (erro instanceof ErroBanco) {
        return falhar({ pedidoId, posse, motivo: 'banco', obtidas, erro, log, requestId })
      }
      throw erro
    }

    let concluido
    try {
      concluido = await emTransacao(async (conexao) => {
        if (!(await repositorio.concluirPedido(conexao, pedidoId, posse))) return false
        for (const assinatura of obtidas) {
          await repositorio.inserirAssinatura(conexao, {
            pedidoId,
            clienteId: assinatura.clienteId,
            tipo: assinatura.tipo,
            ciclo: assinatura.ciclo,
            valorCentavos: assinatura.valorCentavos,
            asaasAssinaturaId: assinatura.asaasAssinaturaId,
            url: assinatura.url
          })
        }
        return true
      })
    } catch (erro) {
      return falhar({ pedidoId, posse, motivo: 'banco', obtidas, erro: new ErroBanco(erro), log, requestId })
    }
    if (!concluido) return possePerdida(pedidoId, log)

    log.info({ pedidoId, estado: 'aguardando_pagamento', asaasClienteId }, 'pedido criado')
    return {
      status: 201,
      corpo: {
        pedidoId,
        estado: 'aguardando_pagamento',
        faturas: obtidas.map(({ tipo, url }) => ({ tipo, url }))
      }
    }
  }

  // Passo 6: a chave já existe.
  async function responderExistente(existente, corpoHash, cliente, log, requestId) {
    if (existente.corpo_hash !== corpoHash || existente.documento !== cliente.documento ||
        existente.contato_nome !== cliente.nome || existente.contato_email !== cliente.email ||
        existente.contato_telefone !== cliente.telefone) {
      return { status: 422, corpo: { erro: 'chave_reutilizada' } }
    }
    if (existente.estado === 'falhou_na_criacao') return respostaFalha(existente.falha_motivo, requestId)
    if (existente.estado !== 'criando') return responderCriado(existente.id, existente.estado)
    if (!existente.expirado) return EM_CRIACAO
    // Passo 7: posse atômica; a retomada perdedora recebe 409.
    const posse = await noBanco(() => repositorio.retomarPedido(pool, existente.id, prazoRetomadaMs))
    if (!posse) return EM_CRIACAO
    log.info({ pedidoId: existente.id, estado: 'criando' }, 'pedido retomado')
    return executarCriacao(existente.id, posse, log, requestId)
  }

  async function fluxo(corpo, log, requestId) {
    const cliente = normalizarCliente(corpo.cliente)
    const corpoHash = hashDoCorpo(corpo)

    const existente = await noBanco(() => repositorio.buscarPedidoPorChave(pool, corpo.chave_idempotencia, prazoRetomadaMs))
    if (existente) return responderExistente(existente, corpoHash, cliente, log, requestId)

    const limites = validarLimites(corpo)
    if (limites.length > 0) return { status: 400, corpo: { erro: 'validacao', campos: limites } }
    const { campos, dominios, tipoPessoa: tipo } = validarDados(corpo, cliente)
    if (campos.length > 0) return { status: 400, corpo: { erro: 'validacao', campos } }

    const orcamento = calcularOrcamento(corpo)
    const totalCentavos = orcamento.totais.recorrente_ciclo_centavos + orcamento.totais.avulso_centavos
    if (corpo.total_exibido_centavos !== totalCentavos || corpo.versao_tabela !== versaoTabela) {
      return {
        status: 409,
        corpo: { erro: 'total_divergente', total_centavos: totalCentavos, versao_tabela: versaoTabela }
      }
    }

    const criado = await noBanco(() => emTransacao(async (conexao) => {
      const clienteId = await repositorio.inserirOuBuscarCliente(conexao, { ...cliente, tipoPessoa: tipo })
      const pedido = await repositorio.inserirPedido(conexao, {
        clienteId,
        chave: corpo.chave_idempotencia,
        corpoHash,
        ciclo: corpo.ciclo,
        itens: JSON.stringify({ itens: orcamento.itens, avulsos: orcamento.avulsos }),
        totalCentavos,
        versaoTabela,
        contatoNome: cliente.nome,
        contatoEmail: cliente.email,
        contatoTelefone: cliente.telefone,
        requestId
      })
      // Chave já usada: o ROLLBACK desfaz também o cliente recém-inserido.
      if (!pedido) return null
      await repositorio.inserirDominios(conexao, pedido.id, dominios)
      return pedido
    }))
    if (!criado) {
      const atual = await noBanco(() => repositorio.buscarPedidoPorChave(pool, corpo.chave_idempotencia, prazoRetomadaMs))
      return atual ? responderExistente(atual, corpoHash, cliente, log, requestId) : EM_CRIACAO
    }
    return executarCriacao(criado.id, criado.posse, log, requestId)
  }

  return {
    async criarPedido(corpo, { log, requestId }) {
      try {
        return await fluxo(corpo, log, requestId)
      } catch (erro) {
        if (!(erro instanceof ErroBanco)) throw erro
        logarErroBanco(log, undefined, erro)
        return respostaFalha('banco', requestId)
      }
    }
  }
}
