# 0005. Fila de jobs e eventos de domínio

Status: aceito
Data: 2026-09-25

## Contexto

Decidido pelo responsável em 2026-09-25: a fila é Redis + BullMQ, não RabbitMQ. O Redis pode também servir a sessão do painel (ADR 0008) e o limite de taxa, se justificado. A fila precisa suportar reprocessamento com backoff e alerta de falha (E2-H10), e ser a base para os eventos de domínio que os épicos E3 a E5 emitem e o E7 consome para enviar e-mail (briefing, risco "webhooks do Asaas com falha ou atraso"). A lista completa de eventos, com emissor, consumidor, payload e chave de idempotência, fica no anexo `anexos/eventos-de-dominio.md`.

A principal entrada de eventos é o webhook do Asaas (E3-H4). Ele muda estado de pedido e de conta, então precisa de autenticação e de conferência antes de agir.

## Opções consideradas

### Opção 1: Publicar direto após o commit
Ao confirmar uma mudança de estado no banco (ex.: pedido pago), a API publica o evento na fila logo em seguida, na mesma requisição ou job.

### Opção 2: Outbox simples
A gravação do evento na tabela `evento` acontece na mesma transação da mudança de estado; um processo separado lê a tabela `evento` e publica na fila do BullMQ depois.

## Decisão

**Decidido pelo responsável em 2026-09-25:** Redis + BullMQ.

**Proposto:**

1. **Outbox simples (Opção 2).** O evento é gravado na tabela `evento` na mesma transação da mudança de estado. Um publicador lê a tabela e envia à fila depois do commit.
2. **Tabela `evento`** (anexo de modelo de dados): `id` UUID (é o `eventoId`), `nome`, `versao`, `agregado_tipo` e `agregado_id`, `chave_idempotencia` com restrição única, `payload`, `request_id`, `ocorrido_em`, `publicado_em`, `tentativas_publicacao`.
3. **Chave de idempotência por fato de negócio**, não pelo id do evento externo. Ex.: `pedido_pago-<pedidoId>`, `cobranca_paga-<cobrancaAsaasId>`. O Asaas manda `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` com ids diferentes para o mesmo pagamento; a chave pelo id do evento do Asaas deixaria passar os dois. Lista completa no anexo de eventos.
4. **Um job por consumidor.** Cada consumidor recebe o evento num job próprio, com `jobId = <consumidor>-<eventoId>`. Separador hífen: o BullMQ pode rejeitar `:` em `jobId` customizado.
5. **Novas tentativas com backoff.** Tentativas esgotadas levam o job a "falhou" e geram alerta (ADR 0011).
6. **Webhook do Asaas (E3-H4):**
   - Exige o cabeçalho `asaas-access-token`. Comparação em tempo constante: calcula o digest SHA-256 do token recebido e do token configurado (ambos 32 bytes) e compara os dois digests com `crypto.timingSafeEqual`, que exige buffers do mesmo tamanho — comparar os tokens brutos falharia (exceção, não 401) para um token recebido de tamanho diferente do configurado. Ausente ou com digest diferente: 401, nada gravado, sem expor o tamanho do token esperado.
   - Grava o evento bruto (tabela própria, única pelo id do evento do Asaas) e responde 200. O processamento segue em job.
   - Antes de mudar estado, o job consulta o pagamento na API do Asaas e confere pagamento, valor e pedido (assinatura ligada ao pedido). Divergência: não muda estado, gera alerta.
   - Evento bruto com dados pessoais minimizados (LGPD): guarda só os campos usados (ids, tipo, estado, valor, datas); descarta nome, e-mail, documento e endereço do payload antes de gravar.
   - Retenção do evento bruto: proposta de 90 dias, depois apagado (a confirmar; ver "Decisões em aberto" do README).

Exemplo ilustrativo do outbox:

```sql
BEGIN;
-- caso sem domínio novo (anexo de modelo de dados); com domínio novo, o estado calculado
-- é 'pago' ou 'aguardando_pagamento_do_dominio', conforme a tabela de estados do pedido
UPDATE pedido SET estado = 'pago' WHERE id = $1 AND estado = 'aguardando_pagamento';
INSERT INTO evento (id, nome, agregado_tipo, agregado_id, chave_idempotencia, payload)
VALUES ($2, 'pedido_pago', 'pedido', $1, 'pedido_pago-' || $1, $3)
ON CONFLICT (chave_idempotencia) DO NOTHING;
COMMIT;
-- o publicador lê "evento" e cria um job por consumidor: jobId = '<consumidor>-' || evento.id
```

## Justificativa

- **Sem perda se o Redis cair:** publicar direto após o commit (Opção 1) tem uma janela em que o banco já mudou de estado, mas a fila nunca recebeu o evento, se o Redis estiver indisponível nesse instante — justamente o cenário que motiva esta decisão (risco do briefing sobre falha de webhook). O outbox evita essa janela: o evento já está persistido no banco antes de qualquer tentativa de publicação.
- **Idempotência dupla:** a restrição única em `chave_idempotencia` impede gravar o mesmo fato duas vezes, mesmo com webhook repetido ou com dois eventos do Asaas para o mesmo pagamento (E3-H4). O `jobId` determinístico evita dois jobs do mesmo consumidor para o mesmo evento.
- **Um job por consumidor:** a falha de um consumidor (ex.: e-mail) não reprocessa os outros (ex.: provisionamento).
- **Webhook autenticado e conferido:** o token barra chamadas forjadas; a consulta ao Asaas barra um evento com token vazado ou dados adulterados, antes de provisionar serviço sem pagamento.
- **Reprocessamento visível:** o BullMQ oferece backoff configurável e um painel de jobs "falhados", o que atende E2-H10 (job esgotado vai para "falhou" e gera alerta) sem construir esse controle manualmente.

## Consequências

- Um processo (ou job agendado) precisa ler a tabela `evento` e publicar na fila; se esse processo parar, os eventos ficam represados no banco, não perdidos — comportamento aceito neste ADR.
- Todo consumidor de evento precisa ser preparado para receber o mesmo evento mais de uma vez (idempotência na ponta consumidora também, não só na emissora).
- Redis com persistência AOF (`appendonly yes`) e `maxmemory-policy noeviction` (exigência do BullMQ), configurado no ADR 0006.
- Cada webhook gera uma chamada de volta à API do Asaas, sujeita ao limite de requisições dele.
- Add-ons e provisionamento: os eventos ligados a add-ons dependem de quais a API da Skymail realmente suporta.

### Implementação da fila (CIT-56)

- **Valores fixados:** 8 tentativas por job, backoff exponencial a partir de 60 s (cerca de 2 h até esgotar), configuráveis por `FILA_TENTATIVAS` e `FILA_BACKOFF_MS`; prefixo das chaves por `FILA_PREFIXO` (um por ambiente, ADR 0006). BullMQ 6, com o `ioredis` como dependência direta (o BullMQ 6 não o traz e, em ESM, recebe a conexão pronta).
- **Retenção obrigatória** (Redis em `noeviction`: cheio, recusa escrita e derruba também a sessão do ADR 0008): concluídos por até 24 h (no máximo 1000), falhados por até 30 dias (no máximo 10000 jobs e 1000 alertas).
- **Fila `alertas` separada** da fila `jobs`: o limitador do BullMQ vale por fila, e o limite de alertas por minuto (ADR 0011) não pode frear jobs de negócio. Job que chega a "falhou" (tentativas esgotadas, erro irrecuperável ou limite de travamentos) gera um alerta, decidido pelo estado do job; o `jobId` do alerta (`alerta-<jobId>-<finishedOn>`) evita alerta repetido do mesmo esgotamento. Alerta que esgota não gera outro alerta. Job de nome sem handler vai a "falhou" na hora (`UnrecoverableError`).
- **Reprocessamento por CLI** (`npm run reprocessar -- <jobId>`): devolve o job de "falhou" para a fila com o mesmo id e as tentativas zeradas. Sem painel de jobs nesta fase.
- **Processo e conexão por papel:** worker em processo próprio (`npm run worker`), com conexão que espera o Redis voltar; API e CLI com conexão de produtor, que falha em vez de guardar o comando em memória. Cada processo exige só a configuração que usa; o token do Telegram só existe no worker.
- **API sem Redis em produção até a #64:** a única rota que enfileira nesta história é a de exemplo, que não existe em produção; a #64 (primeiro produtor real) torna `REDIS_URL` obrigatória na API em produção.
- **`job.data` só com ids** (`requestId`, `pedidoId` e afins), nunca dado pessoal: os falhados ficam até 30 dias no Redis (LGPD). Pelo mesmo motivo, o Redis não guarda a mensagem nem a pilha do erro: `stackTraceLimit: 0` nas duas filas e `executarJob` relança um erro saneado, com mensagem `<name>` ou `<name> (<code>)` (o erro original vai só ao log mascarado); o `pedidoId` do alerta passa por `pedidoSeguro` (UUID estrito ou `-`); o stream de eventos fica limitado a cerca de 1000 entradas por fila.
- **Perda de alerta (risco aceito no MVP):** o alerta é enfileirado por um listener em memória no worker; se o worker cair entre marcar o job como "falhou" e enfileirar o alerta, o alerta se perde (no encerramento normal, por SIGTERM, o worker espera os alertas em curso antes de fechar). Também se perde quando o `failed` do limite de travamentos chega sem o `Job` (o BullMQ pode emitir só o id): o listener não tem como conferir o estado e não enfileira. O job continua em "falhou" e pode ser reprocessado. Se acontecer, revisar com `QueueEvents` ou varredura periódica de "falhou".
- **Job fantasma após 503 (risco aceito):** a rota que enfileira espera o Redis por até 2 s e responde 503; com o Redis fora, o BullMQ 6.3 espera a conexão indefinidamente e o comando pode ser entregue depois do 503, quando o Redis volta. O job existe mesmo com a resposta de erro. Por isso o produtor real (#64) usa `jobId` determinístico, para que o reenvio do cliente não duplique o job.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- Revisão prevista pela #48 (PoC Skymail): eventos e payloads ligados a add-ons e provisionamento.
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-10-01: implementação da fila (CIT-56): valores de tentativas, backoff e retenção, fila `alertas` separada, CLI de reprocessamento, conexões de worker e de produtor, API sem Redis em produção até a #64, `job.data` só com ids, riscos de perda de alerta e de job fantasma. Os eventos de domínio (outbox) ficam para história própria. **pg-boss descartado:** uma fila no PostgreSQL daria transação única com o dado e dispensaria o Redis, mas este ADR já estava aceito com Redis + BullMQ e o Redis também serve a sessão do ADR 0008.
