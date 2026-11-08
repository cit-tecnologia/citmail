# 0012. Fonte única de preços com o servidor como autoridade

Status: aceito
Data: 2026-09-25

## Contexto

Hoje o preço é calculado só no navegador. `assets/precos.js` é a fonte única do site: valores em centavos inteiros, desconto de contratação de 15% embutido no preço atual, 20% no anual (sem volume) e 5% de volume a partir de 5 contas do mesmo tipo, só no mensal. A função `cascataCentavos` monta a cascata de tabela até cobrado. O arquivo é um script clássico, sem `export`.

Um total vindo do navegador pode ser manipulado (issue #33). A E3-H1 leva o cálculo ao servidor (`POST /api/orcamento`), com teste de paridade contra `precos.js`, e fecha #31 e #33.

## Opções consideradas

### Opção 1: Servidor como autoridade, `precos.js` manual com teste de paridade no CI
A tabela do servidor manda. `precos.js` continua escrito à mão para a landing e o checkout exibirem preços sem chamar a API. Um teste no CI falha se os dois divergirem.

### Opção 2: `precos.js` gerado a partir da tabela do servidor
Um passo no deploy gera o arquivo. Elimina a divergência, mas cria um passo de build num site publicado sem build e amarra o deploy do site ao da API.

### Opção 3: Landing lê os preços da API em tempo real
Sem cópia no front. Em troca, landing e checkout dependem da API no ar para mostrar qualquer preço.

## Decisão

Proposto: Opção 1.

1. **Autoridade:** a tabela de preços do servidor (módulo de preços da API, ADR 0002) é a única que vale para cobrança. A API recalcula todo total a partir dos itens (tipo e quantidade de contas, ciclo, add-ons, domínio). Nenhum valor monetário enviado pelo cliente é usado no cálculo.
2. **Total divergente:** o `POST /api/pedidos` recebe o total que o cliente exibiu (`total_exibido_centavos`) e a versão da tabela que ele usou. Se o total recalculado for diferente, a API rejeita o pedido com **HTTP 409** e o código `total_divergente`, devolvendo o total correto e a versão atual. O checkout mostra o novo total e pede nova confirmação. Quantidade fora dos limites continua 400 (E3-H1).
3. **Paridade no CI:** um teste carrega `assets/precos.js` (com `node:vm`, por ser script sem `export`) e a tabela do servidor, e compara a versão da tabela, os preços unitários, os percentuais e o resultado de `cascataCentavos` numa tabela de casos: cada tipo de conta com 4 e 5 contas, mensal e anual; cada add-on; domínio principal e extra.
4. **`precos.js` manual no mvp:** mudar preço exige mudar os dois arquivos no mesmo PR, e o teste de paridade garante isso. Gerar o arquivo (Opção 2) fica como opção futura.
5. **Versão da tabela:** fica em `PRECOS.versao` em `assets/precos.js` (campo novo, criado na E3-H1) e no campo equivalente da tabela do servidor (módulo `precos`), no formato `AAAA-MM-DD.N`. Muda a cada alteração de preço ou desconto, nos dois arquivos no mesmo PR; o teste de paridade falha se diferirem. O checkout envia `PRECOS.versao` no pedido.
6. **Registro no pedido:** o pedido guarda o total calculado, os itens com preço unitário e a versão da tabela usada.

```json
{ "erro": "total_divergente", "total_centavos": 7640, "versao_tabela": "2026-09-25.1" }
```

## Justificativa

- Fecha a manipulação de valor no navegador (#33) sem tirar do site a exibição instantânea de preços.
- 409 indica conflito entre o que o cliente viu e o estado atual do servidor (tabela mudou entre a exibição e o envio). 400 fica para entrada inválida.
- O teste de paridade custa pouco e pega a divergência antes do merge.
- A Opção 2 adiciona build ao site; a Opção 3 torna a landing dependente da API.

## Consequências

- Toda mudança de preço toca dois arquivos, a versão nos dois e o teste de paridade.
- O CI (#54) ganha um passo de teste da API além do `npm test`.
- Guardar a versão da tabela permite explicar um pedido antigo depois de um reajuste. A assinatura no Asaas segue o valor do pedido.
- Cupom (E1-H3) e pro-rata (E3-H6) entram no cálculo do servidor, não em `precos.js`.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-11-07: versão da tabela, limites e `tetoAddon` criados (CIT-59). `PRECOS.versao` e `VERSAO` de `api/src/precos/tabela.js` começam em `2026-11-07.1`. `PRECOS.limites` e `LIMITES` têm a mesma forma: até 500 contas por tipo, mínimo por tipo com quantidade > 0 (5 GB = 2, 25 GB = 1, 50 GB = 1), add-ons por conta (talk, backup90, backup365, grupoEmail) até o total de contas e nunca acima de 500, Skybox até 50 e domínio extra até 20. `tetoAddon(chave, totalContas)` existe igual nos dois lados: sem contas, devolve 0 para qualquer add-on (add-on exige ao menos uma conta); chave desconhecida, 0. A paridade fica em `api/test/precos-paridade.test.js` e compara versão, preços, percentuais, limites, `tetoAddon` e `cascataCentavos`, com mutação do texto-fonte de `precos.js` provando que cada comparação falha. Preço, desconto ou limite muda nos dois arquivos e na versão, no mesmo PR.
