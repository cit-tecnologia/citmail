import { html, texto } from '../html.js'

// E-mail de compra confirmada (E7-H2; CIT-66), consumidor `email_compra_confirmada` do
// evento `pedido_pago`. `refs = { pedidoId }`; destinatário (contato do pedido), itens,
// ciclo e valores são lidos no momento do envio. Sem link nem nome de domínio no corpo.
// Prazo de ativação: mesmo texto da landing (`index.html`, "Ativação Automática" e FAQ);
// mudou lá, muda aqui e sobe a `versao`.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ASSUNTO_COMPRA_CONFIRMADA = 'Compra confirmada no CITMail'

// Rótulos por chave do snapshot do pedido (chaves de `api/src/precos/tabela.js`; nomes de
// exibição de `assets/checkout.js`). Chave sem rótulo: item omitido, nunca a chave crua.
export const ROTULOS_CONTAS = Object.freeze({ '5gb': 'Conta 5 GB', '25gb': 'Conta 25 GB', '50gb': 'Conta 50 GB' })
export const ROTULOS_ADDONS = Object.freeze({
  talk: 'Talk',
  backup90: 'Backup 90 dias',
  backup365: 'Backup 365 dias',
  grupoEmail: 'Grupo de E-mail'
})
export const ROTULOS_SKYBOX = Object.freeze({ '50gb': 'Skybox 50 GB', '100gb': 'Skybox 100 GB', '1tb': 'Skybox 1 TB' })

// Depois do pagamento das contas. `falha_no_provisionamento` também: o pagamento foi feito.
const ESTADOS_PAGOS = new Set([
  'aguardando_pagamento_do_dominio', 'aguardando_registro_de_dominio', 'pago', 'ativo', 'falha_no_provisionamento'
])

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

// Espaço comum no lugar do não separável do `Intl` ("R$ 1.234,56").
function formatarCentavos(centavos) {
  return BRL.format(centavos / 100).replace(/\u00a0/g, ' ')
}

function quantidadeValida(item) {
  return Number.isSafeInteger(item?.quantidade) && item.quantidade > 0
}

function rotuloDoAddon(item) {
  if (item.chave === 'skybox') return Object.hasOwn(ROTULOS_SKYBOX, item.plano) ? ROTULOS_SKYBOX[item.plano] : null
  return Object.hasOwn(ROTULOS_ADDONS, item.chave) ? ROTULOS_ADDONS[item.chave] : null
}

function listarItens(itens) {
  const contas = []
  const addons = []
  for (const item of Array.isArray(itens?.itens) ? itens.itens : []) {
    if (!quantidadeValida(item)) continue
    if (item.tipo === 'conta' && Object.hasOwn(ROTULOS_CONTAS, item.chave)) {
      contas.push({ rotulo: ROTULOS_CONTAS[item.chave], quantidade: item.quantidade })
    } else if (item.tipo === 'addon') {
      const rotulo = rotuloDoAddon(item)
      if (rotulo) addons.push({ rotulo, quantidade: item.quantidade })
    }
  }
  return { contas, addons }
}

function motivoSemEnvio(pedido) {
  if (!pedido) return 'inexistente'
  // ADR 0014: com o contato divergente, o endereço pode ser de terceiro (oráculo de nome por CPF).
  if (pedido.fatura_retida) return 'fatura_retida'
  if (pedido.estado === 'cancelado') return 'cancelado'
  if (!ESTADOS_PAGOS.has(pedido.estado)) return 'nao_pago'
  return null
}

const periodo = (ciclo) => (ciclo === 'anual' ? 'por ano' : 'por mês')
const itensDe = (v) => [...v.contas, ...v.addons]
const rotuloDominios = (v) => (v.dominioAguardandoPagamento ? 'Domínios (a pagar)' : 'Domínios')

export const compraConfirmada = {
  versao: 1,
  // `contexto.log` (opcional) recebe o motivo, em código, de não enviar; sem dado do pedido.
  async carregar(cliente, refs, contexto = {}) {
    const pedidoId = refs?.pedidoId
    if (typeof pedidoId !== 'string' || !UUID.test(pedidoId)) {
      contexto.log?.info({ motivo: 'inexistente' }, 'compra confirmada sem envio')
      return null
    }
    // `tem_dominio_novo`: mesma expressão de `travarPedido` (webhook, CIT-64).
    const resultado = await cliente.query(
      `SELECT estado, fatura_retida, ciclo, itens, contato_nome, contato_email,
              EXISTS (SELECT 1 FROM pedido_dominio WHERE pedido_id = pedido.id AND tipo = 'novo') AS tem_dominio_novo,
              (SELECT valor_centavos FROM assinatura WHERE pedido_id = pedido.id AND tipo = 'contas') AS valor_contas,
              (SELECT valor_centavos FROM assinatura WHERE pedido_id = pedido.id AND tipo = 'dominios') AS valor_dominios
         FROM pedido WHERE id = $1`,
      [pedidoId]
    )
    const pedido = resultado.rows[0]
    const motivo = motivoSemEnvio(pedido)
    if (motivo) {
      contexto.log?.info({ pedidoId, motivo }, 'compra confirmada sem envio')
      return null
    }
    const { contas, addons } = listarItens(pedido.itens)
    if (contas.length + addons.length === 0) {
      contexto.log?.info({ pedidoId, aviso: 'itens_sem_rotulo' }, 'compra confirmada sem itens listados')
    }
    return {
      destinatario: pedido.contato_email,
      variaveis: {
        nome: pedido.contato_nome,
        ciclo: pedido.ciclo,
        contas,
        addons,
        valorContas: pedido.valor_contas === null ? null : formatarCentavos(pedido.valor_contas),
        valorDominios: pedido.valor_dominios === null ? null : formatarCentavos(pedido.valor_dominios),
        dominioNovo: pedido.tem_dominio_novo === true,
        dominioAguardandoPagamento: pedido.estado === 'aguardando_pagamento_do_dominio'
      }
    }
  },
  assunto: () => ASSUNTO_COMPRA_CONFIRMADA,
  html: (v) => html`<!doctype html>
<html lang="pt-BR">
<body>
<p>Olá, ${v.nome}.</p>
<p>Confirmamos o pagamento da sua compra no CITMail.</p>
${itensDe(v).length > 0 ? html`<p>Itens contratados (ciclo ${v.ciclo}):</p>
<ul>
${itensDe(v).map((item) => html`<li>${item.quantidade} × ${item.rotulo}</li>
`)}</ul>
` : ''}${v.valorContas ? html`<p>Contas e add-ons: ${v.valorContas} ${periodo(v.ciclo)}.</p>
` : ''}${v.valorDominios ? html`<p>${rotuloDominios(v)}: ${v.valorDominios} por ano.</p>
` : ''}${v.dominioNovo
    ? html`<p>O registro do domínio novo é feito manualmente pela nossa equipe, por isso a ativação não fica pronta em 5 minutos. Avisaremos por um novo e-mail quando terminar.</p>
${v.dominioAguardandoPagamento ? html`<p>O registro começa após a confirmação do pagamento do domínio.</p>
` : ''}`
    : html`<p>Com o seu domínio, as caixas ficam prontas em até 5 minutos após a confirmação do pagamento. Para enviar e receber mensagens, os registros de DNS precisam estar apontados; a propagação leva até 48 horas.</p>
`}<p>Equipe CITMail</p>
</body>
</html>`,
  // Cada linha com valor é um `texto` próprio (`texto` remove quebras dos valores); as
  // linhas são unidas com `\n` só aqui.
  texto: (v) => {
    const linhas = [
      texto`Olá, ${v.nome}.`,
      '',
      'Confirmamos o pagamento da sua compra no CITMail.',
      ''
    ]
    if (itensDe(v).length > 0) {
      linhas.push(
        texto`Itens contratados (ciclo ${v.ciclo}):`,
        ...itensDe(v).map((item) => texto`- ${item.quantidade} × ${item.rotulo}`),
        ''
      )
    }
    if (v.valorContas) linhas.push(texto`Contas e add-ons: ${v.valorContas} ${periodo(v.ciclo)}.`)
    if (v.valorDominios) linhas.push(texto`${rotuloDominios(v)}: ${v.valorDominios} por ano.`)
    linhas.push('')
    if (v.dominioNovo) {
      linhas.push('O registro do domínio novo é feito manualmente pela nossa equipe, por isso a ativação não fica pronta em 5 minutos. Avisaremos por um novo e-mail quando terminar.')
      if (v.dominioAguardandoPagamento) linhas.push('O registro começa após a confirmação do pagamento do domínio.')
    } else {
      linhas.push('Com o seu domínio, as caixas ficam prontas em até 5 minutos após a confirmação do pagamento. Para enviar e receber mensagens, os registros de DNS precisam estar apontados; a propagação leva até 48 horas.')
    }
    linhas.push('', 'Equipe CITMail', '')
    return linhas.join('\n')
  }
}
