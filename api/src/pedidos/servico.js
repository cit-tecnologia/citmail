// Criação do pedido no Asaas (ADR 0014; CIT-61). Fluxo D1 do plano:
//  1. consulta pela chave (reenvio devolve o gravado) → limites → documento e domínios → total (409);
//  2. transação curta: cliente, pedido em `criando` (posse = `criando_desde`) e domínios;
//  3. cliente no Asaas (consulta antes de criar e antes de declarar falha);
//  4. assinaturas (contas; domínios se houver avulso), idem, e a URL da 1ª fatura;
//  5. transação final guardada pela posse.
// Nenhuma transação fica aberta durante chamada ao Asaas. Falha nos passos 3 e 4 remove
// as assinaturas do pedido achadas pelo `externalReference` (compensação) e grava
// `falhou_na_criacao`. Logs só com ids e códigos (D7); erro de banco só com `code` e `routine`.
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
const TIPOS_ASSINATURA = ['contas', 'dominios']
// Contato do pedido diverge do cadastro do documento: a resposta não traz a URL da
// fatura (ADR 0014, oráculo de nome por CPF).
export const AVISO_FATURA_PENDENTE = 'fatura_pendente'
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

function nomeComparavel(nome) {
  return typeof nome === 'string' ? nome.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR') : null
}

function emailComparavel(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null
}

// Sem nome ou e-mail para comparar, conta como divergente.
function contatoConfere(contato, cadastro) {
  const nome = nomeComparavel(cadastro?.nome)
  const email = emailComparavel(cadastro?.email)
  return nome !== null && email !== null &&
    nome === nomeComparavel(contato.nome) && email === emailComparavel(contato.email)
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

// Timeout ou erro no POST: consulta de novo antes de declarar falha (decisão 5), com
// sinal próprio (`confirmar` não usa o prazo global, que pode já ter vencido). Se a
// consulta também falhar, vale o erro do POST.
async function criarComConfirmacao(operacao, criar, confirmar, { pedidoId, log }) {
  try {
    return await chamar(operacao, criar)
  } catch (erro) {
    if (!(erro instanceof ErroAsaas)) throw erro
    let achado = null
    try {
      achado = await confirmar()
    } catch (erroConfirmacao) {
      log.warn(
        { pedidoId, operacao, tipo: erroConfirmacao?.tipo, erro: erroConfirmacao?.name },
        'confirmação falhou'
      )
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
  // Maior que o prazo global mais a confirmação (1 × timeout) e a compensação (até 2 ×
  // timeout), ambas fora dele: o fluxo original sempre termina ou desiste antes de uma
  // retomada começar (105 s com o padrão).
  const prazoRetomadaMs = prazoCriandoMs ?? prazoPedidoMs + 3 * asaasTimeoutMs + 30000

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

  function corpoCriado(pedidoId, estado, faturas, faturaRetida) {
    return faturaRetida
      ? { pedidoId, estado, faturas: faturas.map(({ tipo }) => ({ tipo, url: null })), aviso: AVISO_FATURA_PENDENTE }
      : { pedidoId, estado, faturas }
  }

  async function responderCriado(pedidoId, estado, faturaRetida) {
    const faturas = await noBanco(() => repositorio.buscarFaturas(pool, pedidoId))
    return { status: 201, corpo: corpoCriado(pedidoId, estado, faturas, faturaRetida) }
  }

  // Compensação best-effort, com sinal próprio fora do prazo global (até 2 ×
  // ASAAS_TIMEOUT_MS no total; cada chamada, até 1 ×). Busca pelo `externalReference`
  // todas as assinaturas do pedido, inclusive as de um POST que deu timeout e foi
  // efetivado, e remove as achadas e as já obtidas.
  async function compensar(pedidoId, tipos, obtidas, log) {
    const sinal = AbortSignal.timeout(2 * asaasTimeoutMs)
    const ids = new Set(obtidas.map(({ asaasAssinaturaId }) => asaasAssinaturaId))
    for (const tipo of tipos) {
      try {
        const achadas = await asaas.listarAssinaturasPorReferencia(`pedido:${pedidoId}:${tipo}`, { signal: sinal })
        for (const id of achadas) ids.add(id)
      } catch (erro) {
        log.warn({ pedidoId, operacao: 'buscar_assinatura', tipo: erro?.tipo, erro: erro?.name }, 'compensação sem consulta')
      }
    }
    for (const asaasAssinaturaId of ids) {
      try {
        await asaas.removerAssinatura(asaasAssinaturaId, { signal: sinal })
      } catch {
        log.error({ pedidoId, asaasAssinaturaId }, 'assinatura órfã')
      }
    }
  }

  async function falhar({ pedidoId, posse, motivo, tipos = TIPOS_ASSINATURA, obtidas, erro, log, requestId }) {
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
    await compensar(pedidoId, tipos, obtidas, log)
    try {
      if (!(await repositorio.marcarFalha(pool, pedidoId, posse, motivo))) return possePerdida(pedidoId, log)
    } catch (erroBanco) {
      logarErroBanco(log, pedidoId, erroBanco)
    }
    return respostaFalha(motivo, requestId)
  }

  // Devolve o id do cliente no Asaas e se o contato do pedido diverge do cadastro do
  // documento: o da tabela `cliente` e o do Asaas. Com o id já gravado, o do Asaas vale
  // pelo `asaas_contato_confere` (gravado junto com o id; cobre também a retomada).
  async function obterClienteAsaas(pedidoId, dados, sinal, log) {
    const contato = { nome: dados.contato_nome, email: dados.contato_email }
    const divergeDoBanco = !contatoConfere(contato, dados)
    if (dados.asaas_cliente_id) {
      return { asaasClienteId: dados.asaas_cliente_id, divergente: divergeDoBanco || !dados.asaas_contato_confere }
    }
    const buscar = (signal) => asaas.buscarClientePorDocumento(dados.documento, { signal })
    let cadastro = await chamar('buscar_cliente', () => buscar(sinal))
    if (!cadastro) {
      cadastro = await criarComConfirmacao('criar_cliente', async () => ({
        id: await asaas.criarCliente({
          nome: dados.nome,
          email: dados.email,
          telefone: dados.telefone,
          documento: dados.documento,
          referencia: `cliente:${dados.cliente_id}`
        }, { signal: sinal }),
        nome: dados.nome,
        email: dados.email
      }), () => buscar(AbortSignal.timeout(asaasTimeoutMs)), { pedidoId, log })
    }
    // Confere se o cadastro do Asaas (achado, ou criado agora com os dados da linha) tem o
    // contato da linha `cliente`: é o que vale para os pedidos seguintes do documento.
    const confere = contatoConfere(dados, cadastro)
    const gravado = await noBanco(() => repositorio.gravarAsaasClienteId(pool, dados.cliente_id, cadastro.id, confere))
    // Outro pedido gravou outro id antes: vale o `asaas_contato_confere` gravado com ele.
    const divergeDoAsaas = !gravado.contatoConfere ||
      (gravado.asaasClienteId === cadastro.id && !contatoConfere(contato, cadastro))
    return { asaasClienteId: gravado.asaasClienteId, divergente: divergeDoBanco || divergeDoAsaas }
  }

  // Fica a mais antiga; as demais (POST em voo efetivado depois de uma retomada) são
  // removidas, best-effort, com o mesmo sinal da consulta.
  async function manterUma(pedidoId, ids, sinal, log) {
    const [mantida = null, ...duplicadas] = ids
    for (const asaasAssinaturaId of duplicadas) {
      log.warn({ pedidoId, asaasAssinaturaId }, 'assinatura duplicada')
      try {
        await asaas.removerAssinatura(asaasAssinaturaId, { signal: sinal })
      } catch {
        log.error({ pedidoId, asaasAssinaturaId }, 'assinatura órfã')
      }
    }
    return mantida
  }

  async function obterAssinatura(pedidoId, plano, asaasClienteId, vencimento, sinal, log) {
    const referencia = `pedido:${pedidoId}:${plano.tipo}`
    const buscar = async (signal) => manterUma(
      pedidoId,
      await asaas.listarAssinaturasPorReferencia(referencia, { signal }),
      signal,
      log
    )
    const achada = await chamar('buscar_assinatura', () => buscar(sinal))
    if (achada) return achada
    return criarComConfirmacao('criar_assinatura', () => asaas.criarAssinatura({
      cliente: asaasClienteId,
      valorCentavos: plano.valorCentavos,
      vencimento,
      ciclo: plano.cycle,
      referencia
    }, { signal: sinal }), () => buscar(AbortSignal.timeout(asaasTimeoutMs)), { pedidoId, log })
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
    let faturaRetida = false
    let tipos
    try {
      const dados = await noBanco(() => repositorio.buscarDadosDoFluxo(pool, pedidoId))
      const planos = planosDeAssinatura(dados)
      tipos = planos.map(({ tipo }) => tipo)
      const cliente = await obterClienteAsaas(pedidoId, dados, sinal, log)
      asaasClienteId = cliente.asaasClienteId
      faturaRetida = cliente.divergente
      if (faturaRetida) log.info({ pedidoId, asaasClienteId, codigo: 'contato_divergente' }, 'fatura retida')
      for (const plano of planos) {
        const asaasAssinaturaId = await obterAssinatura(pedidoId, plano, asaasClienteId, vencimento, sinal, log)
        const assinatura = { ...plano, clienteId: dados.cliente_id, asaasAssinaturaId, url: null }
        obtidas.push(assinatura)
        // Fatura retida: a URL (que mostra o nome do cadastro) não é buscada nem gravada.
        if (!faturaRetida) assinatura.url = await urlDaFatura(pedidoId, asaasAssinaturaId, sinal, log)
      }
    } catch (erro) {
      if (erro instanceof ErroAsaas) {
        return falhar({ pedidoId, posse, motivo: `asaas_${erro.tipo}`, tipos, obtidas, erro, log, requestId })
      }
      if (erro instanceof ErroBanco) {
        return falhar({ pedidoId, posse, motivo: 'banco', tipos, obtidas, erro, log, requestId })
      }
      throw erro
    }

    let concluido
    try {
      concluido = await emTransacao(async (conexao) => {
        if (!(await repositorio.concluirPedido(conexao, pedidoId, posse, faturaRetida))) return false
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
      return falhar({ pedidoId, posse, motivo: 'banco', tipos, obtidas, erro: new ErroBanco(erro), log, requestId })
    }
    if (!concluido) return possePerdida(pedidoId, log)

    log.info({ pedidoId, estado: 'aguardando_pagamento', asaasClienteId }, 'pedido criado')
    return {
      status: 201,
      corpo: corpoCriado(pedidoId, 'aguardando_pagamento', obtidas.map(({ tipo, url }) => ({ tipo, url })), faturaRetida)
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
    if (existente.estado !== 'criando') return responderCriado(existente.id, existente.estado, existente.fatura_retida)
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
