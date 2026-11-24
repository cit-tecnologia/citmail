# 0014. Criação do pedido no Asaas

Status: proposto
Data: 2026-11-23

## Contexto

A E3-H2 (CIT-61) cria o `POST /api/pedidos`: o checkout confirma a compra e a API cria, no Asaas, o cliente e as assinaturas (contas, mensal ou anual; domínios, anual, se houver domínio novo ou extra). É o fluxo mais sensível do produto: envolve cobrança, dado pessoal (CPF/CNPJ, nome, e-mail, telefone) e um terceiro.

- O Asaas não tem idempotência nativa na criação de cliente nem de assinatura. Um `POST` que dá timeout pode ter sido aceito.
- A requisição do checkout pode ser repetida (rede, clique duplo) ou chegar duas vezes ao mesmo tempo.
- A API não tem limite de taxa (o [ADR 0013](0013-seguranca-transversal-e-observabilidade.md) só o prevê para o login, E6-H4) e o aceite dos termos é da #62.
- O [ADR 0012](0012-fonte-unica-de-precos.md), item 2, pede 409 `total_divergente` quando o total exibido difere do recalculado.
- O sandbox do Asaas ainda não está disponível para a API (#57): a integração é testada só contra um stub HTTP local.

Premissas da API v3 do Asaas, adotadas e **a confirmar no sandbox (#57)**:

- P1. Autenticação pelo cabeçalho `access_token`; `User-Agent` obrigatório (`citmail-api`); valores em reais decimais.
- P2. `GET /customers?cpfCnpj=<doc>` devolve `{ data: [{ id }] }`; `POST /customers` aceita `{ name, cpfCnpj, email, mobilePhone, externalReference, notificationDisabled }` e devolve `{ id }`.
- P3. `GET /subscriptions?externalReference=<ref>` filtra pelo `externalReference` e traz `dateCreated` em cada item.
- P4. `POST /subscriptions` `{ customer, billingType, value, nextDueDate, cycle, description, externalReference }` devolve `{ id }`, sem `invoiceUrl`; a 1ª cobrança é gerada na criação e vem de `GET /subscriptions/{id}/payments` (`{ data: [{ invoiceUrl }] }`).
- P5. `DELETE /subscriptions/{id}` remove a assinatura e as cobranças pendentes.
- P6. Sem idempotência nativa; CNPJ alfanumérico aceito a partir de 07/2026.
- P7. As listas podem trazer itens removidos com `deleted: true`.
- P8. `customers` aceita `phone` (fixo) e `mobilePhone` (celular).

## Opções consideradas

### Opção 1: Criação síncrona com estado `criando` e consulta por `externalReference`
O pedido é gravado em `criando` antes de qualquer chamada; a API consulta o Asaas pelo documento (cliente) ou pelo `externalReference` (assinatura) antes de criar e antes de declarar falha. A resposta sai na mesma requisição, com a URL da fatura.

### Opção 2: Chave de idempotência no Asaas
Mandar uma chave de idempotência em cada `POST`. Descartada: o Asaas não oferece (P6).

### Opção 3: Job no worker
A rota grava o pedido e enfileira a criação; o checkout consulta o estado depois. Resolve a retomada automática, mas exige a página de status (#69) antes da hora e um consumidor novo. Fica como evolução.

## Decisão

Proposto (CIT-61), na posição conservadora; validar a posteriori com o responsável. Opção 1.

1. **Total divergente:** `total_exibido_centavos` ≠ `recorrente_ciclo_centavos + avulso_centavos`, ou `versao_tabela` ≠ `VERSAO`, responde 409 `{ "erro": "total_divergente", "total_centavos", "versao_tabela" }` antes de qualquer gravação ou chamada.
2. **Pagamento:** `billingType: 'UNDEFINED'` (o comprador escolhe Pix, boleto ou cartão na fatura do Asaas; a API nunca recebe cartão). `nextDueDate` = data do pedido em `America/Sao_Paulo` + 3 dias corridos.
3. **Corpo:** o do orçamento, com `dominio.nome` e `dominios_extras`, mais `cliente { nome, email, telefone, documento }`, `chave_idempotencia` (UUID, no corpo: o CORS só libera `Content-Type`, [ADR 0007](0007-dominios-cors-e-cookies-por-ambiente.md)), `versao_tabela` e `total_exibido_centavos`. Todo objeto é fechado: campo de cartão responde 400. Nome, e-mail, telefone e documento recusam caractere de controle ou invisível (`\p{C}`) com 400 `requisicao_invalida`.
4. **Cliente reaproveitado não muda:** achado pelo banco ou pelo `GET /customers`, o cliente não é atualizado no Asaas nem na tabela `cliente`. O contato de cada compra fica no pedido (`contato_nome`, `contato_email`, `contato_telefone`), e é dele que a #64 tira o e-mail da conta do titular.
10. **Fatura retida com contato divergente (oráculo de nome por CPF):** o nome normalizado (NFC, espaços colapsados, minúsculas) ou o e-mail (minúsculo) do pedido diferente do cadastro do documento — o da tabela `cliente` e, quando o cliente é achado ou criado nesta requisição, o devolvido pelo `GET /customers` — ou cadastro sem nome ou e-mail para comparar: o pedido segue normal (`aguardando_pagamento`, assinaturas criadas), mas a URL da fatura não é buscada nem gravada (`url_primeira_fatura` nula) e `pedido.fatura_retida = true`. O 201 (e a repetição pela mesma chave) traz `faturas` com `url: null` e `"aviso": "fatura_pendente"`, sem nenhum dado do cadastro. Log `info` `fatura retida` só com `pedidoId`, `asaasClienteId` e `codigo: 'contato_divergente'`. Junto com `asaas_cliente_id`, a linha `cliente` grava `asaas_contato_confere` (verdadeiro só se o cadastro do Asaas, achado ou criado agora com os dados da linha, tem o nome e o e-mail dela); com o id já gravado, o pedido é retido se o contato diverge da linha ou se `asaas_contato_confere` é falso (vale também na retomada).
5. **Estado `criando`** gravado e confirmado antes de qualquer HTTP, com `criando_desde`. Nenhuma transação fica aberta durante chamada ao Asaas e não há nova tentativa automática.
6. **URL da fatura:** um `GET /subscriptions/{id}/payments` por assinatura. Lista vazia, erro ou timeout → `url: null`, e o pedido segue `aguardando_pagamento` (a página de status, #69, cobre depois).
7. **Rota desligada em produção:** `PEDIDOS_HABILITADO` tem padrão `false` em produção e `true` fora dela. Desligada, a rota não é registrada (404). **Só pode ser ligada em produção depois da #62 (aceite, decisões 11 e 12) e do limite de taxa da rota (E6-H4).**
8. **Notificações do Asaas desligadas:** cliente criado com `notificationDisabled: true` até a E7 (e-mails próprios). Cliente reaproveitado com notificação ligada não é alterado (pendência).
9. **Sem outbox nem job:** criação síncrona, sem evento `pedido_criado` (fora do anexo de eventos, sem consumidor).
11. **Aceite dos termos (CIT-62):** o corpo traz `aceite { termos: true, versao_termos, versao_privacidade }`, obrigatório e fechado (sem coerção: `"true"` → 400). As versões vigentes ficam no servidor (`src/pedidos/aceite.js`: `VERSAO_TERMOS = '0.1'`, `VERSAO_PRIVACIDADE = 'externa-2026-11-23'`, provisória, porque a Política é externa e sem versão); versão diferente da vigente → 409 `{ "erro": "versao_termos_divergente", "versao_termos", "versao_privacidade" }`, conferida **antes** do total (um 409 por vez), sem gravar nada nem chamar o Asaas. O aceite é gravado no mesmo `INSERT` do pedido em `criando`: `aceite_em = now()` (o instante de `criado_em`), as duas versões e `ip_aceite` (`inet`), tirado de `request.ip` (trustProxy só no loopback, [ADR 0013](0013-seguranca-transversal-e-observabilidade.md) item 3), sem zona e com `::ffff:a.b.c.d` como IPv4. IP inválido (só com proxy mal configurado) → 500 `interno`, sem gravar e sem chamar o Asaas, log `warn` `ip inválido` sem o valor. O bloco `aceite` entra no `corpo_hash` (mesma chave com outra versão → 422); o IP não entra: o reenvio de outro IP devolve a resposta gravada sem mudar `ip_aceite`. A retomada e a conclusão não tocam no aceite, e o papel da aplicação não tem `UPDATE` nessas colunas. Versões e IP não vão para o log.
12. **Trava do aceite provisório em produção (CIT-62):** com `NODE_ENV=production` e `PEDIDOS_HABILITADO=true`, a API não sobe se `TERMOS_MINUTA = true` (termos em minuta) ou `PRIVACIDADE_PROVISORIA = true` (rótulo da Política ainda provisório), ambos em `src/pedidos/aceite.js`. A única exceção é `TERMOS_MINUTA_ACEITA=true`, liberação explícita para a homologação se ela rodar como produção (#57); em uso, a partida loga `warn` `aceite liberado com termos em minuta ou política provisória`. `TERMOS_MINUTA_ACEITA` é validada sempre: valor diferente de `true`, `false` ou vazio impede a partida. **A produção real nunca usa `TERMOS_MINUTA_ACEITA`.** Um teste de paridade confere `VERSAO_TERMOS` e `TERMOS_MINUTA` com `termos.html`.
    - **Checklist da 1.0 dos termos:** no mesmo PR, trocar `TERMOS_MINUTA` (para `false`) e `VERSAO_TERMOS`, `PRIVACIDADE_PROVISORIA` (para `false`) e `VERSAO_PRIVACIDADE` (rótulo definitivo do responsável/DPO) e a página `termos.html` (sem "(minuta)", sem `noindex` nem aviso de versão preliminar), junto com o envio das versões pelo checkout (#63).
    - **Retenção:** além de `ip_aceite`, o IP do aceite também fica no log de acesso (`request completed` grava `req.remoteAddress`, [ADR 0013](0013-seguranca-transversal-e-observabilidade.md) item 3), com a retenção de 30 dias dos logs técnicos.
    - **Pendência:** a prova do aceite guarda as versões, não um hash do texto aceito; se o texto de uma versão mudar sem trocar o rótulo, o pedido não identifica o texto. Gravar o hash (ou versionar o texto) fica para depois da 1.0.
13. **Cliente da rota: o checkout (CIT-63).** `assets/checkout.js` envia o pedido só no modo API (origem em `ORIGENS_API`); nas demais origens mostra "Contratação online em breve" e não envia nada.
    - **Chave em três classes** (a mais conservadora contra pedido duplicado): a `chave_idempotencia` (`crypto.randomUUID()`) nasce no 1º envio e fica só em memória, com o corpo enviado.
      - *Definitiva com falha gravada → chave nova no próximo envio* (o corpo pode ser editado): 502/504 JSON `asaas_indisponivel`, 422 `chave_reutilizada` fora do estado ambíguo, 409 `total_divergente` (o checkout refaz o orçamento na hora e exige novo clique), 409 `versao_termos_divergente` (desmarca o aceite e pede recarga da página), 400 `validacao` (marca os campos acusados), 404 (rota desligada; sem nova tentativa pela página) e o 2º 500 JSON `interno` seguido na mesma chave.
      - *500 JSON `interno` nem sempre é retomável:* o pedido pode ter ficado em `criando` (a mesma chave o retoma, passo 7) ou ter gravado `falhou_na_criacao` com motivo `banco`, e aí a mesma chave repete o 500. Por isso o 1º 500 `interno` é tratado como ambíguo (mesma chave e mesmo corpo, edição travada) e o 2º seguido na mesma chave, como definitivo (chave nova, edição destravada e a mensagem genérica de erro), para não prender o comprador.
      - *Ambígua → mesma chave e mesmo corpo*: 5xx sem JSON (ex.: 504 HTML do proxy), JSON fora do contrato, prazo de 90 s do cliente (acima dos ~75 s do pior caso da rota), abort, erro de rede, 201 malformado, 409 `pedido_em_criacao`, 429 e 503. No estado ambíguo a revisão avisa que o pedido pode já ter sido criado, trava a volta aos passos 1-4 e a nova tentativa reenvia o corpo guardado byte a byte. Um 422 `chave_reutilizada` nesse estado encerra os envios pela página e manda falar com o comercial (sem chave nova silenciosa). Um 404 nesse estado mantém a chave e o aviso, sem nova tentativa pela página. Um 201 válido, ou uma resposta definitiva, encerra o estado ambíguo.
    - **Risco residual do 2º 500:** se o 1º pedido ficou em `criando` (com assinaturas já criadas) e o banco falhar de novo na mesma chave, o 2º 500 gera chave nova e pode criar um 2º pedido; exige duas falhas de banco seguidas e é aceito (a reconciliação por job, opção 3, fecha o caso).
    - **Alertas acessíveis:** `#pedidoErro` é a única região `role="alert"` do pedido e fica sempre no DOM; o texto (e o aviso de pedido ambíguo, dentro dela) é esvaziado a cada envio e reescrito com a resposta, para ser anunciado de novo mesmo quando repetido.
    - **Allowlist do host da fatura no front:** o checkout só navega para a `url` da fatura com `https:`, host exatamente `www.asaas.com` ou `sandbox.asaas.com`, sem porta e sem usuário/senha (`urlFaturaSegura`, navegação para `new URL(url).href`). Fora disso, ou com `aviso: "fatura_pendente"`, mostra "Pedido recebido" com o número do pedido e o contato comercial. Com fatura de domínios, não redireciona: mostra os dois links (nova aba, `rel="noopener noreferrer"`) até a página de status (#69).
    - **Pendência:** a mesma allowlist no servidor, conferindo o host de `invoiceUrl` em `src/asaas/cliente.js` (hoje só exige `https:`), fica para issue própria. Recarregar a página no meio do envio perde a chave (vive só em memória) e pode gerar 2º pedido; aceito até a #69.

Fluxo (`src/pedidos/servico.js`):

1. Schema (400) e consulta só de leitura pela `chave_idempotencia`: pedido existente vai ao passo 6, para o reenvio devolver a resposta gravada mesmo com a tabela de preços mudada. Senão: limites (400), documento e domínios (400), versões do aceite (409 `versao_termos_divergente`), total e versão da tabela (409 `total_divergente`) e IP do aceite (500 se inválido).
2. Transação curta: `INSERT cliente ... ON CONFLICT (documento) DO NOTHING` e `SELECT`; `INSERT pedido` em `criando`, com o aceite, e com `ON CONFLICT (chave_idempotencia) DO NOTHING RETURNING` (o `criando_desde` devolvido é a posse); `INSERT pedido_dominio`. Chave já usada: `ROLLBACK` e passo 6.
3. Cliente: sem `asaas_cliente_id`, `GET /customers` pelo documento; não achou, `POST /customers` (`externalReference: cliente:<id>`). Erro ou timeout no `POST`: novo `GET` (confirmação, com timeout próprio) antes de declarar falha. `UPDATE ... WHERE asaas_cliente_id IS NULL`; sem linha, relê o gravado.
4. Assinaturas: para cada tipo, `GET /subscriptions?externalReference=pedido:<id>:<tipo>`; não achou, `POST` (contas: `MONTHLY` ou `YEARLY`, `value` = `recorrente_ciclo_centavos / 100`; domínios: `YEARLY`, `value` = `avulso_centavos / 100`; `description` = `externalReference`). Erro ou timeout no `POST`: novo `GET` (confirmação, com timeout próprio) antes de declarar falha. Mais de uma assinatura ativa com a mesma referência: fica a mais antiga (`dateCreated`, depois id) e as demais são removidas (log `warn` `assinatura duplicada`, só ids). Depois, a URL da fatura (decisão 6).
5. Transação final: `UPDATE pedido SET estado = 'aguardando_pagamento'` guardado pela posse, `INSERT assinatura`, 201.
6. Chave existente: corpo diferente → 422 `chave_reutilizada`; `aguardando_pagamento` (ou adiante) → 201 montado do banco; `falhou_na_criacao` → a mesma falha; `criando` no prazo → 409 `pedido_em_criacao`; fora do prazo → passo 7.
7. Retomada: `UPDATE pedido SET criando_desde = clock_timestamp() WHERE ... criando_desde < now() - <prazo> RETURNING` (posse atômica; a perdedora recebe 409) e os passos 3 a 5, reaproveitando o que já existe pelas consultas por documento e `externalReference`. Não fecha de todo a duplicata: um `POST` do fluxo anterior ainda em voo pode ser efetivado depois da consulta da retomada (ver Riscos abertos).

Regras do fluxo:

- **Prazos:** prazo global de 45 s (`PRAZO_PEDIDO_MS`) nas chamadas de criação; cada chamada usa o menor entre `ASAAS_TIMEOUT_MS` e o que resta. Ficam fora dele, com sinal próprio: a consulta de confirmação depois de erro no `POST` (até 1 × `ASAAS_TIMEOUT_MS`; com o prazo global vencido, a chamada seguinte falha na hora) e a compensação (consultas e `DELETE`, até 2 × `ASAAS_TIMEOUT_MS` no total). Prazo de retomada = 45 s + 3 × `ASAAS_TIMEOUT_MS` + 30 s (105 s com o padrão): o fluxo original sempre termina ou desiste antes de uma retomada começar.
- **Posse:** toda escrita no pedido durante o fluxo leva `estado = 'criando' AND criando_desde = <posse>`. Sem linha afetada, a posse foi perdida para uma retomada: o fluxo não compensa, não grava nada, loga `posse perdida` e responde 409 `pedido_em_criacao`.
- **Falha** nos passos 3 e 4: confere a posse, busca pelo `externalReference` todas as referências `pedido:<id>:<tipo>` dos planos do pedido (as duas, se os dados do pedido não foram lidos) e remove no Asaas as assinaturas ativas achadas e as já obtidas (best-effort; consulta que falha → log `warn` `compensação sem consulta`; falha do `DELETE` → log `error` `assinatura órfã` com só `pedidoId` e `asaasAssinaturaId`) e grava `falhou_na_criacao` com `falha_motivo`. Erro de banco no passo 3 ou 5: a mesma compensação, `falha_motivo 'banco'` e 500 `{ erro: 'interno', requestId }`.
- **Banco fora** sem conseguir gravar a falha: o pedido fica em `criando` e é retomado pelo prazo; assinatura já criada é reaproveitada pelo `externalReference`.
- **Códigos de falha** (`falha_motivo`) e respostas: `asaas_timeout` → 504; `asaas_rede`, `asaas_http_4xx`, `asaas_http_5xx`, `asaas_resposta_invalida` → 502, ambos com `{ "erro": "asaas_indisponivel", "mensagem": "Não foi possível gerar a cobrança agora. Tente de novo em alguns minutos." }`, sem nada do Asaas; `banco` → 500.
- **Repetição do corpo:** `corpo_hash` = SHA-256 do JSON canônico (chaves ordenadas, domínios normalizados) sem a chave e sem o bloco `cliente`, sem dado pessoal. O bloco `cliente` é comparado às colunas: documento normalizado contra `cliente.documento`; nome, e-mail e telefone normalizados contra `pedido.contato_*`. Dispensa um HMAC com segredo novo.
- **Adaptador** (`src/asaas/cliente.js`, injetável em `construirApp(config, { asaas })`): `AbortSignal.timeout` por chamada combinado ao prazo global, `redirect: 'error'` (302 vira `rede`), erros como `ErroAsaas` com `tipo` e `status`, sem corpo nem mensagem do Asaas; ids `^[A-Za-z0-9_]{1,64}$`; `invoiceUrl` só `https://`; itens com `deleted: true` descartados; telefone com 10 dígitos em `phone`, com 11 em `mobilePhone`.
- **Validação:** documento normalizado (sem `.`, `-`, `/`, maiúsculas) e validado (CPF com dígitos verificadores, sem todos iguais; CNPJ numérico ou alfanumérico por módulo 11 sobre `ASCII − 48`); domínios com as mesmas regras de `assets/checkout.js` (`src/pedidos/dominio.js`); `dominios_extras` com tamanho igual a `addons.extraDom` e nomes distintos.
- **Configuração:** `PEDIDOS_HABILITADO` (`true`/`false`), `ASAAS_BASE_URL` (obrigatória com a chave; em produção, só `https://` com o host `api.asaas.com` ou `api-sandbox.asaas.com`, sem porta nem credencial; o erro de partida cita a variável, nunca o valor), `ASAAS_API_KEY` (obrigatória com a rota ligada em produção) e `ASAAS_TIMEOUT_MS` (1000–30000, padrão 10000). Fora de produção, sem chave nem adaptador injetado, a rota responde 503 `asaas_nao_configurado` sem tocar no banco.
- **Logs:** só `pedidoId`, `estado`, `falhaMotivo`, `asaasClienteId`, `asaasAssinaturaId`, `operacao`, `statusAsaas`, `codigo` (`contato_divergente`), `tipo` (do `ErroAsaas`) e `erro` (nome do erro) na confirmação e na consulta da compensação e, no erro de banco, `code` e `routine`. Nunca corpo, documento, nome, e-mail, telefone, domínio, `access_token` nem resposta do Asaas.

## Justificativa

- Gravar `criando` antes de chamar o Asaas e consultar antes de criar torna o fluxo repetível sem idempotência nativa: o reenvio e a retomada acham o que já existe em vez de criar de novo. A duplicata residual (POST em voo) é removida na próxima consulta pela mesma referência.
- A posse por `criando_desde` impede que o fluxo original e uma retomada escrevam ao mesmo tempo, e que o original compense assinaturas que passaram a ser da retomada.
- A compensação de todas as assinaturas deixa o pedido falho sem cobrança; com `notificationDisabled`, o resíduo (assinatura órfã) não chega ao comprador.
- O contato no pedido fecha o risco de um terceiro cadastrar antes o CPF da vítima com o próprio e-mail: a conta do titular nasce com o e-mail de quem pagou.
- A rota desligada em produção evita expor uma rota que cria cobranças sem limite de taxa nem aceite dos termos.

## Consequências

- Pedido em `criando` (queda do processo ou do banco no meio) só é retomado por novo envio com a mesma chave depois do prazo; se o comprador desistir, as assinaturas desse pedido ficam órfãs no Asaas, sem notificação. Retomada automática e reconciliação por job no worker ficam como evolução (README dos ADRs, "Decisões em aberto").
- Assinatura órfã quando o `DELETE` falha ou quando o `POST` deu timeout e a consulta de confirmação também falhou: fica só o log `error` com ids, sem alerta automático.
- Nova tentativa depois de `falhou_na_criacao` usa chave nova e cria outro pedido; o pedido falho não deixa assinatura (compensação).
- Dois pedidos simultâneos de um documento novo podem criar dois clientes no Asaas; o banco fica com um `asaas_cliente_id`. Aceito.
- Associação por CPF: a tabela `cliente` (e o cliente no Asaas) pode ficar com o contato de quem cadastrou primeiro; a conta do titular (#64) usa o e-mail do pedido pago.
- A requisição pode chegar a ~75 s no pior caso (45 s de prazo global, mais a confirmação fora dele e a compensação, até 3 × `ASAAS_TIMEOUT_MS`): o Caddy (#57) e o checkout (#63) precisam tolerar até 80 s.
- CPF "sequestrado": se a linha `cliente` nasce com o contato de um terceiro e o cadastro do Asaas é do titular (achado pelo `GET`), `asaas_contato_confere` fica falso e o titular legítimo tem a fatura retida em todo pedido até correção manual (acerto da linha `cliente` e do `asaas_contato_confere`).
- Cliente removido no Asaas depois de gravado em `cliente.asaas_cliente_id`: os pedidos daquele documento falham com `asaas_http_4xx` (o id gravado não é revalidado) até correção manual.
- Rota desligada em produção até a #62 e o limite de taxa (E6-H4); ligá-la antes viola este ADR.
- Se P3 falhar no sandbox, a consulta antes de criar passa a listar as assinaturas do cliente e filtrar localmente.
- Evolução: o job de retomada e reconciliação (Opção 3) vai precisar de `executarCriacao` exposta com resultado de domínio (hoje ela devolve a resposta HTTP).

## Riscos abertos

- **Oráculo de nome por CPF — mitigado (decisão 10), rota ainda desligada em produção até o limite de taxa (E6-H4) e a #62:** um anônimo que envia o CPF de um terceiro com outro nome ou e-mail não recebe a `invoiceUrl` (que mostraria o nome do titular). Limites da mitigação:
  - o `aviso: "fatura_pendente"` revela um bit: que o documento já tem cadastro com outro contato (só um documento novo sempre confere). Não revela nome, e-mail nem dado do Asaas; o limite de taxa (E6-H4) é que barra a enumeração em massa;
  - quem já sabe o nome e o e-mail exatos do titular recebe a URL (a fatura não mostra mais do que ele já sabe);
  - cliente com `asaas_cliente_id` já gravado é conferido contra a tabela `cliente` e o `asaas_contato_confere`, sem reler o Asaas: alteração do cadastro feita direto no Asaas depois da gravação não é vista;
  - o comprador legítimo que muda de e-mail ou grafia do nome também fica sem URL na resposta; a fatura chega pela página de status (#69) ou pelos e-mails (E7), que precisam aplicar a mesma regra.
- **Duplicata residual:** um `POST /subscriptions` em voo do fluxo anterior pode ser efetivado depois da consulta da retomada, gerando duas assinaturas com a mesma referência. Mitigado pela remoção de duplicatas na próxima consulta (fica a mais antiga); o fechamento definitivo é a reconciliação por job (Opção 3).
- **TOCTOU entre a conferência de posse e a compensação:** a posse é conferida antes dos `DELETE`; se uma retomada tomar a posse nesse intervalo (só depois do prazo de retomada, que cobre a compensação), a compensação pode remover assinaturas que a retomada acabou de achar. Risco residual aceito; a retomada seguinte recria pelo `externalReference`.

## Revisões

- 2026-11-23: criação (CIT-61).
- 2026-11-23: revisão do CIT-61: confirmação e compensação com sinal próprio, compensação pelo `externalReference`, remoção de duplicatas, hosts do Asaas em produção, texto do contato sem `\p{C}` e riscos abertos.
- 2026-11-23: aceite dos termos no pedido e trava da minuta em produção (CIT-62, decisões 11 e 12).
- 2026-11-24: cliente da rota no checkout: regra da chave em três classes, estado ambíguo e allowlist do host da fatura no front (CIT-63, decisão 13).
- 2026-11-24: revisão do CIT-63: o 1º 500 `interno` passa a ambíguo e o 2º seguido na mesma chave, a definitivo; 404 no estado ambíguo mantém o aviso; região viva única para os alertas do pedido.
