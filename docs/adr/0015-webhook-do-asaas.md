# 0015. Webhook do Asaas

Status: proposto
Data: 2026-11-23

## Contexto

A E3-H4 (CIT-64) confirma o pagamento pelo webhook do Asaas e cria a conta do titular. O [ADR 0005](0005-fila-e-eventos-de-dominio.md) já decide a fila, o outbox e as regras gerais do webhook (token em tempo constante, evento bruto minimizado, conferência no Asaas antes de mudar estado). Faltava decidir a rota, a trava de produção, a tabela do bruto, a lista branca, como o bruto chega ao processamento, a matriz de status e a regra da conta do titular.

- O Asaas reenvia o mesmo evento e manda `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED`, com ids diferentes, para o mesmo pagamento.
- O webhook pode chegar com o pedido ainda em `criando`, antes de a assinatura local existir ([ADR 0014](0014-criacao-do-pedido-no-asaas.md)).
- O sandbox do Asaas ainda não está disponível (#57): o formato do `id` do evento, o `value` do 1º pagamento e os nomes dos status são premissas a confirmar.

## Opções consideradas

### Opção 1: Processar na requisição

A rota consulta o Asaas e muda o pedido antes de responder. Simples, mas a resposta depende do Asaas e do banco no mesmo instante, passa do prazo do webhook com o Asaas lento e, numa falha, depende do reenvio do Asaas.

### Opção 2: Gravar o bruto e processar por job, com retry no próprio laço

A rota só grava o bruto; um laço no worker lê e processa. O retry, o alerta de esgotado e o reprocessamento manual teriam de ser refeitos com colunas, alerta e CLI novos.

### Opção 3: Gravar o bruto e processar por job da fila `jobs`

A rota só grava o bruto; um laço no worker (mesma forma do publicador do outbox) cria um job `asaas_webhook` por bruto. Tentativas, backoff, alerta de esgotado e `npm run reprocessar` já existem e são testados (CIT-56, CIT-166).

## Decisão

Opção 3. Proposto (CIT-64), a validar no sandbox (#57):

1. **Rota `POST /api/asaas/webhook`**, registrada só com `WEBHOOK_ASAAS_HABILITADO` (padrão: desligada em produção, ligada fora dela). `bodyLimit` de 16 KiB. Schema mínimo, aberto a campos novos: `id` em `^evt_[A-Za-z0-9_&.-]{1,120}$` (premissa), `event` de 1 a 64 caracteres, `payment.id` em `^[A-Za-z0-9_]{1,64}$` quando há `payment`. Sem filtro de IP na aplicação (o Caddy pode restringir, #57).
2. **Token.** Hook `onRequest`, antes do parse do corpo e de qualquer acesso ao banco: cabeçalho `asaas-access-token` ausente, vazio ou com SHA-256 diferente do configurado (`crypto.timingSafeEqual` sobre os digests) responde 401 `{ erro: 'nao_autorizado' }`, sempre igual. `ASAAS_WEBHOOK_TOKEN` só no environment da API; com a rota ligada em produção, obrigatório e com ao menos 32 caracteres, senão a API não sobe. Fora de produção, sem token, 503 `webhook_indisponivel`.
3. **Recepção.** Só `INSERT ... ON CONFLICT (asaas_evento_id) DO NOTHING` em `asaas_webhook_evento` e 200 `{ recebido: true }`, também para o evento repetido. Nenhuma chamada ao Asaas na requisição. Log só com `resumoEventoAsaas` e o id do bruto.
4. **Lista branca do bruto:** `asaas_evento_id`, `evento`, `request_id`, `pagamento_id`, `assinatura_id`, `referencia_externa` (até 100 caracteres), `status`, `billing_type`, `valor_centavos`, `vencimento` e `pago_em`. Valor fora do formato vira nulo. Nunca o corpo inteiro, `customer`, `description`, `observations`, URLs de fatura nem `creditCard*`.
5. **Enfileirador** (`iniciarEnfileiradorWebhook`, no worker): a cada ciclo, lê até 50 brutos com `enfileirado_em` nulo, cria um job `asaas_webhook` (`jobId = asaas_webhook-<brutoId>`) num `addBulk` com prazo de 2 s e marca `enfileirado_em`. Usa as filas do publicador (conexão de produtor). Bruto com erro fica `pendente`, guardado para reenvio.
6. **Alerta `webhook_parado`:** bruto `pendente` enfileirado há mais de 1 hora, ou recebido há mais de 1 hora e nunca enfileirado, gera um alerta (`alerta-whp-<brutoId>`) uma vez só (`alertado_pendente_em`). Cobre o job que saiu do Redis (retenção de 30 dias do `failed`).
7. **Handler** (`criarHandlerWebhook`): acha o pedido pela assinatura local ou, sem ela, pelo `externalReference` `pedido:<id>:<tipo>` (pedido em `criando` lança e a fila tenta de novo); confere o pagamento no Asaas (`buscarPagamento`) fora da transação; decide pelo **status atual** no Asaas, não pelo do bruto:

   | Evento | Status atual | Resultado |
   |---|---|---|
   | `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | `CONFIRMED`, `RECEIVED`, `RECEIVED_IN_CASH` | efeito de pago |
   | `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | `PENDING`, `AWAITING_RISK_ANALYSIS` | `ignorado` `pagamento_nao_confirmado` + alerta |
   | qualquer um dos três | estorno ou chargeback | `ignorado` `estornado` + alerta |
   | `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | `OVERDUE` | `ignorado` `status_divergente` + alerta |
   | `PAYMENT_OVERDUE` | `OVERDUE` | `cobranca_vencida` |
   | `PAYMENT_OVERDUE` | pago | `ignorado` `ja_pago` |
   | `PAYMENT_OVERDUE` | `PENDING`, `AWAITING_RISK_ANALYSIS` | `ignorado` `status_divergente` |
   | qualquer um dos três | outro | `ignorado` `status_desconhecido` + alerta |

   Divergência na conferência (`pagamento_inexistente`, `assinatura_divergente`, `referencia_divergente`, `valor_divergente`): bruto `divergente`, alerta e nenhum efeito. O efeito vai numa transação com `FOR UPDATE` do bruto (relendo a `situacao`) e do pedido; os alertas são enfileirados depois do `COMMIT`.
8. **Idempotência por fato:** o 2º evento do mesmo pagamento encontra o pedido fora de `aguardando_pagamento` (ou `dominio_pago_em` preenchido) e vira `ignorado` `pagamento_repetido`; um pagamento seguinte ao 1º, `pagamento_seguinte`. Pedido relido como `cancelado` ou `falhou_na_criacao` depois da trava não recebe efeito (`pedido_<estado>`, com alerta); a chave do evento de domínio é a do fato (anexo de eventos).
9. **Conta do titular** criada com `pedido_pago`, na mesma transação: e-mail do pedido em minúsculas, `sem_senha`. Com `fatura_retida`, não é criada (alerta `contato_divergente`). E-mail já em conta de outro cliente: alerta `conta_email_em_uso`, sem retry.
10. **Alertas** na fila `alertas`, com o payload `{ tipo: 'webhook', codigo, brutoId, pedidoId }` (só ids e código, `jobId` `alerta-wh-<brutoId>`).

## Justificativa

- A resposta ao Asaas sai em milissegundos e não depende do Asaas nem do Redis: o bruto já está no banco antes de qualquer processamento.
- O processamento reaproveita inteiro o que a fila já garante (tentativas, backoff, alerta de esgotado, reprocessamento), sem código novo de retry.
- A conferência no Asaas antes de qualquer efeito torna inútil um token vazado: o forjador só consegue gravar brutos (16 KiB por corpo, id único).
- A matriz conservadora nunca provisiona sem pagamento confirmado no Asaas e não entra em retry infinito.

## Consequências

- **A ordem entre `pedido_pago` e `conta_titular_criada` não é garantida** para os consumidores: nascem na mesma transação, mas cada consumidor recebe o seu job. Consumidor que precisar da conta lê do banco.
- Os brutos `ignorado` `pagamento_seguinte` (pagamentos seguintes ao 1º) ficam reprocessáveis quando `cobranca_paga` existir (E4-H5).
- Um bruto parado há mais de 1 hora gera o alerta `webhook_parado`; o reenvio manual é zerar `enfileirado_em` do bruto (api/README.md).
- **Pendência: limpeza do bruto após 90 dias.** O índice por `recebido_em` está pronto; a limpeza é história própria, com papel próprio (o papel da aplicação não tem `DELETE`).
- Uma chamada ao Asaas por webhook (limite de requisições do Asaas, ADR 0005).
- **Risco aceito:** o alerta do resultado é enfileirado depois do `COMMIT` e se perde se o Redis falhar nesse instante; o bruto fica com situação e código consultáveis (mesmo risco aceito no ADR 0005).
- **A conta `sem_senha` não é prova de posse** do e-mail nem do documento: a E5 deve exigir verificação (link de primeiro acesso ao e-mail) antes de dar acesso aos dados do `cliente_id`. E-mail já ocupado por conta de terceiro precisa de liberação pela equipe (alerta `conta_email_em_uso`).
- O papel `<banco>_aplicacao` é compartilhado entre a API e o worker: a API tem, por exemplo, `INSERT` em `conta_titular`, que só o worker usa. Separar os papéis por processo fica para uma história de infraestrutura.
- O schema da rota exige `id` com prefixo `evt_` e `payment.id` quando há `payment`: premissas até a confirmação no sandbox (#57); fora delas, 400 e o Asaas acumula falhas.
- E-mail como login único: o mesmo e-mail em dois documentos bloqueia a 2ª conta, com alerta e resolução manual.

## Riscos abertos

- Premissas sem sandbox (#57): formato do `id` do evento (fora do padrão, a rota responde 400 e o Asaas acumula falhas), `value` do 1º pagamento (juros, multa ou desconto viram `valor_divergente`, falha segura) e nomes dos status da matriz.

## Revisões

- 2026-11-23: criação (CIT-64).
