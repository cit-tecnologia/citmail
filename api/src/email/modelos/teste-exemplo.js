import { html, texto } from '../html.js'

// Modelo de teste (só fora de produção, como `jobExemplo`): fixa o formato dos modelos
// e serve aos testes de envio. `refs = { pedidoId }`; destinatário e nome vêm do contato
// do pedido, lidos no momento do envio. Pedido inexistente ou id fora do formato → null
// (o job grava `nao_enviado` com `SEM_DESTINATARIO`).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const testeExemplo = {
  versao: 1,
  async carregar(cliente, refs) {
    const pedidoId = refs?.pedidoId
    if (typeof pedidoId !== 'string' || !UUID.test(pedidoId)) return null
    const resultado = await cliente.query('SELECT contato_email, contato_nome FROM pedido WHERE id = $1', [pedidoId])
    const pedido = resultado.rows[0]
    if (!pedido) return null
    return { destinatario: pedido.contato_email, variaveis: { nome: pedido.contato_nome } }
  },
  assunto: (v) => `Teste do CITMail para ${v.nome}`,
  html: (v) => html`<!doctype html>
<html lang="pt-BR">
<body>
<p>Olá, ${v.nome}.</p>
<p>Este é um e-mail de teste do CITMail.</p>
</body>
</html>`,
  texto: (v) => texto`Olá, ${v.nome}.

Este é um e-mail de teste do CITMail.
`
}
