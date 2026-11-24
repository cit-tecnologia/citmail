# Registros de decisão de arquitetura (ADR)

ADR é a sigla de *architecture decision record*, registro de decisão de arquitetura: um documento curto que explica uma decisão técnica, as opções que foram avaliadas e por que a escolha final venceu. Este projeto segue o formato **MADR** (*Markdown Architectural Decision Records*), que define as seções obrigatórias usadas abaixo (ver ADR [0001](0001-registrar-decisoes-em-adr.md)).

Estes ADRs registram as decisões de arquitetura do back-end do CITMail, tomadas na história CIT-47, antes da implementação das histórias dos épicos E2 a E7 (Taiga #53 a #99, mais #90).

## Siglas e termos

| Termo | Significado |
|---|---|
| API | Interface de programação (*application programming interface*): aqui, o back-end que o site chama por HTTP. |
| CI | Integração contínua (*continuous integration*): os testes que o GitHub Actions roda em cada PR. |
| CORS | Compartilhamento de recursos entre origens (*cross-origin resource sharing*): cabeçalhos que autorizam uma página de outra origem a ler respostas da API. |
| DoR | *Definition of Ready*: critérios para uma história entrar numa sprint. |
| HTTPS | HTTP cifrado com TLS, com certificado válido. |
| MVP | Produto mínimo viável (*minimum viable product*): o escopo da primeira versão (marcado `mvp` nas histórias). |
| PoC | Prova de conceito (*proof of concept*): aqui, a #48, que testa a API da Skymail. |
| TLD | Domínio de topo (*top-level domain*): a terminação do domínio, como `.com.br`. |
| VPS | Servidor virtual privado (*virtual private server*): o servidor da CIT onde rodam API, banco e fila. |

## Modelo de cada ADR

```
# NNNN. <Título>

Status: <proposto|aceito|substituído por NNNN>
Data: 2026-09-25

## Contexto
## Opções consideradas
### Opção 1: <nome>
### Opção 2: <nome>
(### Opção 3 opcional)
## Decisão
## Justificativa
## Consequências
## Revisões
- 2026-09-25: criação (CIT-47).
```

## Status possíveis

| Status | Significado |
|---|---|
| `proposto` | A Decisão tem pelo menos uma parte proposta, ainda sujeita a confirmação ou revisão (ex.: aguardando aprovação do responsável, ou dependente da PoC #48). O texto separa "Decidido pelo responsável em <data>" de "Proposto". |
| `aceito` | Todo o conteúdo da Decisão foi decidido pelo responsável, valendo para a implementação sem rediscussão. |
| `substituído por NNNN` | Decisão revogada; o ADR indicado por `NNNN` a substitui. O ADR antigo permanece no histórico, sem ser apagado. |

## Índice de ADRs

| Nº | Arquivo | Título | Status | Data |
|---|---|---|---|---|
| 0001 | [0001-registrar-decisoes-em-adr.md](0001-registrar-decisoes-em-adr.md) | Registrar decisões de arquitetura em ADRs (MADR) em `docs/adr` | aceito | 2026-09-25 |
| 0002 | [0002-organizacao-do-codigo-da-api.md](0002-organizacao-do-codigo-da-api.md) | Organização do código da API | aceito | 2026-09-25 |
| 0003 | [0003-framework-http.md](0003-framework-http.md) | Framework HTTP | aceito | 2026-09-25 |
| 0004 | [0004-banco-e-migracoes.md](0004-banco-e-migracoes.md) | PostgreSQL, acesso ao banco e migrações | aceito | 2026-09-25 |
| 0005 | [0005-fila-e-eventos-de-dominio.md](0005-fila-e-eventos-de-dominio.md) | Fila de jobs e eventos de domínio | aceito | 2026-09-25 |
| 0006 | [0006-execucao-na-vps-proxy-e-backup.md](0006-execucao-na-vps-proxy-e-backup.md) | Execução na VPS, proxy reverso com HTTPS e backup | aceito | 2026-09-25 |
| 0007 | [0007-dominios-cors-e-cookies-por-ambiente.md](0007-dominios-cors-e-cookies-por-ambiente.md) | Domínios, CORS e cookies por ambiente | aceito | 2026-09-25 |
| 0008 | [0008-sessao-do-painel-e-senhas.md](0008-sessao-do-painel-e-senhas.md) | Sessão do painel e armazenamento de senhas | aceito | 2026-09-25 |
| 0009 | [0009-consulta-de-dominio-e-tlds.md](0009-consulta-de-dominio-e-tlds.md) | Fonte da consulta de domínio e TLDs aceitos | aceito | 2026-09-25 |
| 0010 | [0010-email-transacional.md](0010-email-transacional.md) | Canal do e-mail transacional | aceito | 2026-09-25 |
| 0011 | [0011-alertas-da-equipe.md](0011-alertas-da-equipe.md) | Canal de alerta da equipe | aceito | 2026-09-25 |
| 0012 | [0012-fonte-unica-de-precos.md](0012-fonte-unica-de-precos.md) | Fonte única de preços com o servidor como autoridade | aceito | 2026-09-25 |
| 0013 | [0013-seguranca-transversal-e-observabilidade.md](0013-seguranca-transversal-e-observabilidade.md) | Segurança transversal e observabilidade | aceito | 2026-09-25 |
| 0014 | [0014-criacao-do-pedido-no-asaas.md](0014-criacao-do-pedido-no-asaas.md) | Criação do pedido no Asaas | proposto | 2026-11-23 |
| 0015 | [0015-webhook-do-asaas.md](0015-webhook-do-asaas.md) | Webhook do Asaas | proposto | 2026-11-23 |
| 0016 | [0016-status-do-pedido-por-token.md](0016-status-do-pedido-por-token.md) | Status do pedido por token | proposto | 2026-11-24 |

Hoje nenhum ADR está `aceito`: todos têm alguma parte proposta. Passam a `aceito` quando o responsável confirmar o que falta.

**Anexos** (referência, não decisão — sem `Status` nem seções de ADR):

| Arquivo | Conteúdo | Citado por |
|---|---|---|
| [anexos/modelo-de-dados.md](anexos/modelo-de-dados.md) | As 7 entidades do domínio, com chave, atributos, relações, estados e transições. | ADR 0004 |
| [anexos/eventos-de-dominio.md](anexos/eventos-de-dominio.md) | Tabela dos eventos de domínio da fila: nome, emissor, consumidor, payload e chave de idempotência. | ADR 0005 |

## Matriz: item do critério 1 → ADR

O critério de aceite 1 da história CIT-47 (E2-H1) lista os itens que a arquitetura precisa decidir. Cada um está coberto por um ADR (ou pelo anexo de modelo de dados):

| Item do critério 1 | ADR / anexo |
|---|---|
| Organização do código da API | [0002](0002-organizacao-do-codigo-da-api.md) |
| Framework HTTP | [0003](0003-framework-http.md) |
| Migrações | [0004](0004-banco-e-migracoes.md) |
| Biblioteca de fila | [0005](0005-fila-e-eventos-de-dominio.md) |
| Execução na VPS e proxy reverso com HTTPS | [0006](0006-execucao-na-vps-proxy-e-backup.md) |
| CORS entre a landing estática e a API | [0007](0007-dominios-cors-e-cookies-por-ambiente.md) |
| Sessão do painel | [0008](0008-sessao-do-painel-e-senhas.md) |
| Fonte da consulta de domínio e TLDs aceitos | [0009](0009-consulta-de-dominio-e-tlds.md) |
| Canal do e-mail transacional | [0010](0010-email-transacional.md) |
| Canal de alerta da equipe | [0011](0011-alertas-da-equipe.md) |
| Modelo de dados inicial | [anexos/modelo-de-dados.md](anexos/modelo-de-dados.md) (citado pelo ADR 0004) |

Dois critérios adicionais da história têm ADR próprio, fora da lista acima: fonte única de preços ([0012](0012-fonte-unica-de-precos.md), CA4) e segurança transversal e observabilidade ([0013](0013-seguranca-transversal-e-observabilidade.md), CA6).

## Decisões em aberto

Pendências que não foram fechadas dentro do timebox do spike (3 dias úteis, até 2026-10-01). Ao vencer o prazo, ficam registradas aqui em vez de estender a história.

| Decisão | Dono | Prazo |
|---|---|---|
| Subdomínio da API de homologação (ex.: `api.novo.citmail.com.br` ou `api-homolog.citmail.com.br`); afeta CORS, certificado e cookie (ADR 0007). | responsável | 2026-10-01 |
| Provedor do backup fora da VPS; o ADR 0006 já decide o tipo (armazenamento de objetos, cifra assimétrica, bloqueio de objeto), falta o provedor. | responsável | na E2-H7 |
| Código da API neste repositório público em `api/` ou em repositório separado; a proposta do ADR 0002 é `api/` aqui. Confirmar, porque muda o CI (E2-H4) e o deploy (E2-H5 em diante). | responsável | 2026-10-01 |
| `assets/precos.js` gerado a partir da tabela do servidor ou continua manual com teste de paridade; a proposta do ADR 0012 é manual no MVP. Confirmar. | responsável | 2026-10-01 |
| Nome do evento de desativação da E3-H7 (proposta: `assinatura_cancelada`), se o cancelamento feito pela equipe no fim do ciclo (E5-H10) também o publica, e quem efetiva o cancelamento no mvp (anexo de eventos, divergência 1). | responsável | 2026-10-01 |
| Origem que serve o painel depois da migração da landing (`citmail.com.br/painel` estático ou `painel.citmail.com.br`); afeta o cookie `SameSite` (ADR 0007 e 0008). A proposta aceita as duas, desde que fiquem sob `citmail.com.br`. | responsável | 2026-10-01 |
| Painel de produção sem história: migrar a landing para `citmail.com.br` (criar a história; a E2-H6 a deixa fora do escopo) ou publicar o painel antes em `painel.citmail.com.br` (ADR 0007). | responsável | 2026-10-01 |
| Confirmar o evento `cobranca_paga` (pagamentos seguintes ao 1º, para a reativação da E4-H5) e o critério novo na E3-H4 (anexo de eventos). | responsável | 2026-10-01 |
| `fatura_criada` emitido pela E3-H4 para a E7-H4 (anexo de eventos, divergência 9). | responsável | quando a E7-H4 sair da pendência |
| ~~`falhou_na_criacao`: nova tentativa com a mesma chave de idempotência e tratamento de assinatura órfã no Asaas (anexo de modelo de dados).~~ Fechada pelo [ADR 0014](0014-criacao-do-pedido-no-asaas.md) (CIT-61): a mesma chave devolve a mesma falha; nova tentativa com chave nova; compensação das assinaturas e log `assinatura órfã`. | planner da E3-H2 | fechada em 2026-11-23 |
| Limite de taxa do `POST /api/pedidos`; até lá a rota fica desligada em produção (`PEDIDOS_HABILITADO`, ADR 0014). | responsável | na E6-H4 |
| Retomada automática de pedido em `criando` por job no worker, em vez de só por novo envio com a mesma chave (ADR 0014). | responsável | depois da E3-H4 |
| Reconciliação de assinatura órfã no Asaas (`DELETE` de compensação que falhou ou `POST` com timeout sem confirmação), hoje só no log `assinatura órfã` (ADR 0014). | responsável | depois da E3-H4 |
| Cliente do Asaas reaproveitado (achado pelo documento) com notificações do Asaas ligadas: a API não o altera (ADR 0014, decisão 8). | responsável | até a E7 |
| Confirmar no sandbox do Asaas as premissas P1–P8 do ADR 0014 (sobretudo o filtro por `externalReference`, itens `deleted`, `phone`/`mobilePhone` e a cobrança disponível na criação). | responsável | na #57 |
| Expiração de pedido `aguardando_pagamento` nunca pago (anexo de modelo de dados). | responsável | 2026-10-01 |
| Limpeza do evento bruto do Asaas (`asaas_webhook_evento`) após 90 dias, com papel próprio (o da aplicação não tem `DELETE`); índice por `recebido_em` já criado ([ADR 0015](0015-webhook-do-asaas.md), CIT-64). História própria, no épico #41. | responsável | história a abrir |
| Confirmar no sandbox do Asaas o formato do `id` do evento do webhook, o `value` do 1º pagamento e os status da matriz do [ADR 0015](0015-webhook-do-asaas.md) (CIT-64, CA16). | responsável | na #57 |
| Registros SPF, DKIM e DMARC do domínio remetente do e-mail transacional (DMARC em `p=none` no início, [ADR 0010](0010-email-transacional.md)); sem eles, nenhum envio real sai pelo SMTP da Skymail (CIT-65, CA5). | responsável | na #57 |
| Limpeza de `email_envio` após 90 dias, com papel próprio (o da aplicação não tem `DELETE`); índice por `criado_em` já criado ([ADR 0010](0010-email-transacional.md), CIT-65). História própria, no épico #45. | responsável | história a abrir |
| Retenções propostas: evento bruto do Asaas (90 dias, ADR 0005), auditoria (IP em claro por 6 meses, registro por 5 anos, ADR 0013) e sessão (até 8 h, ADR 0008). | responsável | 2026-10-01 |

## Ajustes de critérios em outras histórias

Ajustes que os ADRs pedem em critérios de aceite de outras histórias, para o PO aplicar no Taiga. Números de critério pela ordem em `.omc/plans/epicos-citmail.md`.

| História | Critério | Ajuste | Origem |
|---|---|---|---|
| E2-H5 | 1 | Trocar `https://novo.citmail.com.br/api/health` pela URL do subdomínio da API de homologação (a definir). | ADR 0007 |
| E2-H5 | 3 | A API não fica no host do rsync do site: o critério passa a conferir que o rsync do site e o deploy da API não se afetam. | ADR 0007 |
| E3-H2 | 1 | `POST /api/pedidos` recebe `total_exibido_centavos` e a versão da tabela; total divergente responde 409 `total_divergente` com o total correto. **Aplicado** (CIT-61). | ADR 0012 |
| E3-H2 | 4 e 6 | Rever depois da decisão sobre `falhou_na_criacao` (nova tentativa com a mesma chave, assinatura órfã). **Aplicado** (CIT-61, ADR 0014). | Anexo de modelo de dados |
| E3-H3 | novo | Com 409 `total_divergente`, o checkout mostra o novo total e pede nova confirmação. | ADR 0012 |
| E3-H4 | 1 | Token do cabeçalho `asaas-access-token` comparado em tempo constante. | ADR 0005 |
| E3-H4 | novo | Antes de mudar estado, a API consulta o pagamento no Asaas e confere pagamento, valor e pedido; divergência não muda estado e gera alerta. | ADR 0005 |
| E3-H4 | 2 | `pedido_pago` só no 1º pagamento das contas; com domínio novo não pago, o pedido fica `aguardando_pagamento_do_dominio`. | Anexo de eventos, anexo de modelo de dados |
| E3-H4 | 4 | Dois eventos diferentes do Asaas para o mesmo pagamento (`PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED`) também publicam uma vez só. | Anexo de eventos |
| E3-H4 | novo | Pagamento confirmado de cobrança seguinte ao 1º publica `cobranca_paga`. | Anexo de eventos |
| E4-H5 | 2 | A reativação é disparada por `cobranca_paga`. | Anexo de eventos |
| E4-H4 | 1 | Aceita `dominio_pago` com o pedido ainda `aguardando_pagamento`: abre a tarefa sem mudar o estado. | Anexo de modelo de dados |
| E4-H4 | 2 | Só enfileira o provisionamento com as contas pagas; antes disso, só grava o registro. | Anexo de modelo de dados |
| E5-H2 | 1 | Publica só `solicitacaoId` (tabela de solicitação de senha), sem gerar o token. | Anexo de eventos |
| E7-H3 | 1 e 2 | O job gera o token no envio e grava só o hash; o link leva o token no fragmento da URL. | Anexo de eventos, ADR 0008 |
| E6-H7 | 1 | Incluir o registro manual de domínio pela equipe (E4-H4) nas ações auditadas. | ADR 0013 |
| E2-H6 | 3 | CORS aceita duas origens em produção até a migração da landing: `https://cittecnologia.github.io` e `https://citmail.com.br`. | ADR 0007 |

## Como propor ou revisar um ADR

1. Crie um arquivo `docs/adr/NNNN-<slug>.md`, com o próximo número disponível e o modelo de seções acima.
2. Descreva pelo menos duas opções em "Opções consideradas", sem benchmark: a justificativa se apoia em critérios documentados (requisitos, histórias, restrições), não em medição de desempenho.
3. Abra um Pull Request; a revisão de consistência segue o mesmo fluxo de qualquer mudança de código (`CLAUDE.md`, fluxo de desenvolvimento de história).
4. **Revisar uma decisão já aceita:**
   - Se a mudança é pequena e não invalida a decisão (ex.: um detalhe novo, uma exceção documentada), acrescente uma entrada em "Revisões" no próprio ADR, com a data e o motivo.
   - Se a mudança substitui a decisão (ex.: troca de tecnologia ou de opção escolhida), crie um ADR novo, que referencia o antigo, e mude o `Status` do ADR antigo para `substituído por NNNN` (o número do novo).
5. A PoC da Skymail (#48) pode confirmar ou invalidar decisões deste spike. Quando isso acontecer: revisão pontual vira entrada em "Revisões" do ADR afetado; revisão que muda a decisão vira ADR novo que substitui o antigo, como em qualquer outra revisão.

## Regra de placeholders para dados da VPS

Este repositório é público. Nenhum ADR, anexo ou este índice cita host, IP, porta, usuário de deploy ou credencial reais da VPS. Use sempre placeholders: `<host-da-vps>`, `<porta-ssh>`, `<usuario-de-deploy>`, `<usuario-de-servico>`. Os únicos nomes de host permitidos em `docs/` são os públicos: `citmail.com.br` e subdomínios, `cittecnologia.github.io`, `registro.br` e `rdap.registro.br`, `github.com`, `letsencrypt.org`, `telegram.org`, e domínios de documentação de bibliotecas citadas. Valores reais (host, porta, usuário) ficam só nos secrets e variables do ambiente `homologacao`/`producao` do GitHub e em arquivo `chmod 600` no servidor, nunca neste repositório.
