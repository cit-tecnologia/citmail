# 0011. Canal de alerta da equipe

Status: aceito
Data: 2026-09-25

## Contexto

Decidido pelo responsável em 2026-09-25: os alertas da equipe (falha de job esgotado, falha de backup, queda de disponibilidade, cobrança vencida, cancelamento) saem para um grupo do Telegram, por bot. Usado por E2-H7 (falha de backup), E2-H10 (job esgotado), E2-H11 (queda de disponibilidade), E4-H2 (falha de provisionamento), E4-H4 (renovação de domínio) e E5-H10 (cancelamento solicitado).

## Opções consideradas

### Opção 1: Bot do Telegram, com dois caminhos de envio
Um bot do Telegram envia a mensagem ao grupo da equipe. Alertas de negócio (job esgotado, provisionamento, domínio, cobrança vencida, cancelamento) saem por um job dedicado, consumido pela fila (ADR 0005); alertas de infraestrutura (Redis, banco, backup, disponibilidade) saem direto do processo que detecta a falha, sem passar pela fila. Token do bot como segredo e limite de mensagens por minuto, nos dois caminhos.

### Opção 2: E-mail (descartada)
Alertas por e-mail para a equipe, pelo mesmo canal do ADR 0010.

### Opção 3: Slack ou Discord (descartada)
Um canal de mensagens de equipe em Slack ou Discord, com webhook de entrada.

## Decisão

**Decidido pelo responsável em 2026-09-25:** grupo do Telegram com bot.

**Proposto:**

- **Dois caminhos de envio:**
  - Falha de infraestrutura (Redis, banco, backup, disponibilidade; E2-H7, E2-H11): envio direto ao Telegram, fora da fila, pelo processo que detecta a falha (monitor ou script do backup). A fila depende do Redis e do banco, então não pode ser o canal que avisa da queda deles.
  - Demais alertas (job esgotado, provisionamento, domínio, cobrança vencida, cancelamento): job da fila.
- Mensagem sem dado pessoal (só ids e tipo do alerta).
- Token do bot como segredo. O token vai na URL da API do Telegram: erro do `fetch` nunca é registrado com a URL; o log leva só o tipo do erro e o status.
- Limite de mensagens por minuto: 20 (o limite do Telegram por grupo), pelo limitador da fila `alertas` (CIT-56). O excedente **espera**, nada é descartado.

## Justificativa

- **Notificação imediata no celular:** Telegram entrega notificação push instantânea sem depender de a equipe estar com a caixa de e-mail aberta, ao contrário do e-mail (Opção 2), que é assíncrono por natureza e compete com outras mensagens.
- **Sem contratação nem provisionamento adicional:** um bot do Telegram é criado em minutos e não exige assinatura paga nem workspace novo, ao contrário de Slack ou Discord (Opção 3), que exigiriam criar e manter um espaço de equipe só para isso.
- **Reaproveita a fila:** o alerta de negócio sai por job da fila, como qualquer outro evento (ADR 0005), o que dá o mesmo reprocessamento e não bloqueia a requisição original em caso de lentidão do Telegram.
- **Caminho direto para infraestrutura:** se o Redis ou o banco caem, a fila para; o alerta dessa queda precisa sair por fora dela.

Exemplo ilustrativo:

```js
// A URL leva o token do bot. Em caso de erro, registrar só err.name e o status, nunca a URL.
await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: `Job falhou: id=${job.id} pedido=${job.pedidoId}`
  })
})
```

## Consequências

- O token do bot e o id do grupo (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) ficam como segredo, nunca no repositório (regra da CIT-46).
- A mensagem de alerta nunca leva dado pessoal (nome, e-mail, CPF/CNPJ) — só ids internos e o tipo do alerta, para que o grupo do Telegram não vire um repositório de dado sensível.
- Um limite de mensagens por minuto evita que uma falha em cascata (ex.: Redis fora do ar) inunde o grupo; alertas além do limite esperam na fila (decisão do responsável na CIT-56, no lugar de agregar ou descartar). O atraso é explícito: 500 alertas levam cerca de 25 min para sair.
- Resposta 429 do Telegram é tratada como falha comum (nova tentativa com backoff da fila); usar o `parameters.retry_after` da resposta fica como melhoria, se o 429 aparecer.
- Menor privilégio: o token e o chat id só existem no ambiente do worker da fila (`TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`, obrigatórios nele em produção); a API e a CLI não os leem.
- Trocar de canal no futuro (ex.: se a equipe crescer e precisar de escalonamento por plantão) exige revisar este ADR.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-10-01: alerta de job esgotado implementado (CIT-56): limite de 20 por minuto com espera em vez de agregar ou descartar (decisão do responsável), atraso explícito, `retry_after` do 429 como melhoria, token só no worker.
