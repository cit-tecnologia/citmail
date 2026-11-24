# 0016. Status do pedido por token

Status: proposto
Data: 2026-11-24

## Contexto

A E3-H5 (CIT-69) mostra ao comprador o status do pedido depois do pagamento, sem conta nem login (a área logada é da #43). O comprador precisa de um identificador que só ele tenha: o `pedidoId` sai no 201 e não é segredo. O [ADR 0014](0014-criacao-do-pedido-no-asaas.md) deixou para esta história a fatura com `url: null`, os dois links de fatura e o comprador com fatura retida.

- O 201 de `POST /api/pedidos` pode se perder (caso ambíguo do ADR 0014): o checkout repete com a mesma chave e o mesmo corpo e recebe a resposta gravada.
- O log de acesso grava a URL ([ADR 0013](0013-seguranca-transversal-e-observabilidade.md)); o corpo não é logado.
- A API não tem limite de taxa (E6-H4) e ainda não está publicada para o front (#57): o `criarAssinatura` não envia `callback`, então a volta da fatura não traz o comprador de volta.

## Opções consideradas

### Opção 1: Token aleatório com hash no banco e rotação no reenvio

Token novo a cada 201; o banco guarda só o SHA-256. O reenvio pela mesma chave gera outro token e invalida o anterior.

### Opção 2: Token por HMAC do `pedidoId`

Derivado com um segredo do servidor, sem coluna; o reenvio devolveria o mesmo token sem guardá-lo. Descartada: exige segredo novo no environment, a rotação do segredo invalida todos os links de uma vez e não há como revogar um link isolado.

### Opção 3: Token guardado em claro para reenvio

Vetada: um vazamento do banco daria acesso a todos os pedidos.

### Opção 4: 201 do reenvio sem token

Deixaria sem link justamente o comprador do caso ambíguo (o 1º 201 se perdeu).

## Decisão

Proposto (CIT-69), na posição conservadora; validar a posteriori com o responsável. Opção 1.

1. **Token:** 32 bytes de `crypto.randomBytes` em base64url sem `=` (43 caracteres, `^[A-Za-z0-9_-]{43}$`; `src/pedidos/token.js`). O banco guarda só `pedido.token_hash` = SHA-256 em hex (`char(64) UNIQUE`, nulável, `CHECK ~ '^[0-9a-f]{64}$'`; migração `pedido-token`, com `GRANT UPDATE (token_hash)` ao papel da aplicação). Pedidos anteriores ficam sem token (sem backfill); sem expiração no MVP.
2. **Entrega e rotação:** todo 201 de `POST /api/pedidos` traz `token` (obrigatório no schema do 201); nenhuma resposta de erro o traz.
   - 1º 201 (criação ou retomada): o hash é gravado dentro do `emTransacao` de `concluirPedido`, no mesmo `UPDATE` guardado pela posse; posse perdida → nenhum hash gravado (a retomada grava o seu).
   - Reenvio pela mesma chave e mesmo corpo: um único `UPDATE pedido SET token_hash = $2 WHERE id = $1 AND estado NOT IN ('criando', 'falhou_na_criacao') RETURNING estado, fatura_retida` (`rotacionarToken`), e o 201 é montado desse retorno: estado e token coerentes, sem `SELECT` separado. O token anterior deixa de valer. Duas repetições concorrentes: vale a última.
   - Só quem tem a chave de idempotência (vive na memória da aba) e o mesmo corpo obtém o 201 e, com ele, um token.
3. **Consulta `POST /api/pedidos/status`** com `{ "token": "<43>" }` no corpo: o token nunca vai em path, query ou cabeçalho (log de acesso). Corpo fechado, `token` string de até 128 caracteres (sem `token` ou de outro tipo → 400). Token fora do padrão, inexistente ou de pedido sem token → 404 `{ "erro": "nao_encontrado" }` idêntico (token fora do padrão nem chega ao banco). 200 e 404 com `Cache-Control: no-store` e `Referrer-Policy: no-referrer`. Atrás da mesma flag `PEDIDOS_HABILITADO`. A rota só usa o pool: registrada no plugin de pedidos, mas fora de `criarServicoPedidos` e antes do 503 `asaas_nao_configurado`, ela responde também sem adaptador do Asaas. CORS com `maxAge: 600` (o POST com JSON faz preflight a cada consulta do polling).
4. **Resposta 200 em lista branca** (schema fechado): `etapa`, `dominioNovo` (há `pedido_dominio.tipo = 'novo'`), `faturaContasUrl` (só em `aguardando_confirmacao`) e `faturaDominioUrl` (em `dominio_pendente`, e em `aguardando_confirmacao` com domínio novo e `dominio_pago_em` nulo: as duas faturas em aberto). Cada URL só sai com `fatura_retida = false`, `url_primeira_fatura` não nula e `https:` com host exatamente `www.asaas.com` ou `sandbox.asaas.com`, sem porta nem credenciais (mesma regra de `urlFaturaSegura` do checkout, agora também no servidor, só nesta rota); senão a chave é omitida. Nunca `pedidoId`, nome, e-mail, domínio, valores ou datas.
5. **Estado → etapa** (o estado cru nunca sai): `criando` e `aguardando_pagamento` → `aguardando_confirmacao`; `aguardando_pagamento_do_dominio` → `dominio_pendente`; `aguardando_registro_de_dominio` → `registro_dominio`; `pago` e `falha_no_provisionamento` → `ativando`; `ativo` → `ativo`; `falhou_na_criacao` → `erro_criacao`; `cancelado` → `cancelado`; outro → `em_analise`.
6. **Fatura `url: null` ou retida:** a página nunca dispara nova busca no Asaas; mostra que a fatura chega por e-mail e o contato comercial. `fatura_retida` nunca expõe URL (decisão 10 do ADR 0014).
7. **Página `pedido.html`:** lê o token de `location.hash` (`#t=<token>`; o fragmento não vai ao servidor nem ao `Referer`), CSP própria com `connect-src 'self'`, `<meta name="referrer" content="no-referrer">` e `noindex`; o checkout mostra o link "Acompanhar pedido" em vez de redirecionar para a fatura quando o 201 traz `token`.

## Consequências

- O comprador acompanha o pedido sem conta, com 256 bits de entropia por link; um vazamento do banco não revela tokens.
- Link copiado antes de uma repetição pela mesma chave deixa de valer (raro: só no estado ambíguo).
- O checkout deixa de redirecionar direto para a fatura: um clique a mais para pagar (validar com o PO; reavaliar com o `callback` da #57).

## Riscos abertos

- **Token sem expiração:** fica no histórico do navegador, na barra de endereço e com quem receber o link copiado. Expiração e revogação viram história.
- **Sem limite de taxa:** a adivinhação é inviável, mas a rota pode ser usada para carga; mitigado pela flag desligada em produção até a E6-H4.
- **2º 500 seguido (herdado do ADR 0014):** o checkout gera chave nova; se o 1º pedido foi concluído, o token dele se perde e a saída é o contato comercial.
- **`connect-src 'self'` de `pedido.html`:** quebra quando a API for publicada em outra origem (#57); a CSP e o `ORIGENS_API` da página mudam juntos.
- **Allowlist de host só nesta rota:** `src/asaas/cliente.js` ainda só exige `https:` na `invoiceUrl` (issue prevista no ADR 0014).

## Revisões

- 2026-11-24: criação (CIT-69).
