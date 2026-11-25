# 0010. Canal do e-mail transacional

Status: aceito
Data: 2026-09-25

## Contexto

Decidido pelo responsável em 2026-09-25: o e-mail transacional (confirmação de compra, credenciais iniciais, avisos de vencimento e cancelamento) sai por SMTP da Skymail, com remetente de um domínio da CITMail. A história E7-H1 pede um serviço único de envio, com modelos (HTML e texto), reenvio em falha e registro sem dado sensível.

## Opções consideradas

### Opção 1: SMTP da Skymail com `nodemailer`, via job da fila
Envio só por job da fila (E7-H1), usando `nodemailer` configurado para o SMTP da Skymail, com modelos de e-mail versionados no repositório da API e reenvio pelo mecanismo de retentativa do BullMQ (ADR 0005).

### Opção 2: Provedor transacional dedicado (descartada)
Um provedor especializado em e-mail transacional (ex.: SES, SendGrid, Postmark), com API própria de envio e métricas de entrega.

### Opção 3: SMTP próprio (descartada)
Servidor SMTP próprio rodando na VPS da CIT, sem depender de terceiro.

## Decisão

**Decidido pelo responsável em 2026-09-25:** SMTP da Skymail, remetente de um domínio da CITMail.

**Proposto:**

- Envio só por job da fila com `nodemailer`, modelos versionados e reenvio (ADR 0005).
- Modelos HTML com escape automático de todo dado interpolado (nome, endereço de caixa, domínio); nenhum dado entra como HTML cru. Versão em texto sem HTML.
- DMARC do domínio remetente em `p=none` com relatórios no início; depois de um período sem falhas de SPF e DKIM (proposta: 30 dias), passar a `p=quarantine`.

## Justificativa

- **Um só provedor de e-mail:** a Skymail já é o provedor de caixas de e-mail e domínio (E4); usar o mesmo SMTP para transacional evita contratar e manter um segundo fornecedor (provedor dedicado, Opção 2) só para esse fim, e evita o esforço de rodar e reputar um SMTP próprio (Opção 3), que teria entrega pior sem histórico de reputação.
- **Job da fila, não envio síncrono:** enviar dentro do job que processa o evento (ex.: `pedido_pago` → e-mail de confirmação) reaproveita o reprocessamento com backoff e o alerta de falha esgotada já decididos no ADR 0005, sem duplicar essa lógica no envio de e-mail.
- **Escape nos modelos:** nome e domínio vêm do cliente; sem escape, um valor com HTML mudaria o conteúdo do e-mail (injeção de HTML, link falso).
- **DMARC em etapas:** `p=none` mostra nos relatórios se algum envio legítimo falha antes de punir; `p=quarantine` depois reduz a falsificação do remetente.
- **Modelos versionados:** manter os modelos HTML/texto no repositório da API (e não numa interface externa) os coloca sob revisão de PR, como qualquer outro código.

Exemplo ilustrativo:

```js
const transportador = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
})
await transportador.sendMail({
  from: 'CITMail <naoresponda@citmail.com.br>',
  to: destinatario,
  subject: assuntoDoModelo,
  html: renderizarModelo('confirmacao-compra', dados)
})
```

## Consequências

- O domínio remetente precisa de registros SPF, DKIM e DMARC válidos (E7-H1), como consequência direta de enviar pelo SMTP da Skymail com remetente próprio.
- A credencial SMTP fica em arquivo `chmod 600` no servidor ou em environment do GitHub, nunca no repositório (regra da CIT-46); a chave da Skymail em si permanece no gerenciador de senhas até haver consumidor (CIT-46/E2-H8).
- O registro de cada envio guarda destinatário mascarado, modelo, estado e data — nunca o conteúdo do e-mail (E7-H1).
- Trocar de provedor de e-mail no futuro exige rever este ADR e o registro DNS de SPF/DKIM/DMARC, não só a configuração do `nodemailer`.

## Adendo (CIT-65): implementação do envio por fila

Registrado na implementação da E7-H1 (história #65), sem mudar a decisão acima.

- **Duas etapas.** O consumidor de um evento (#66, #102, #72) chama `solicitarEmail(cliente, { eventoId, chaveIdempotencia, modelo, refs })` (`api/src/email/servico.js`) dentro do `tratar`, na transação que grava a marca do outbox (ADR 0005): grava uma linha `pendente` em `email_envio` com `ON CONFLICT (chave_idempotencia) DO NOTHING` e a `versao_modelo` do modelo registrado (modelo fora do registro lança `TypeError` e a transação do consumidor falha). Um enfileirador em laço no worker (`api/src/email/enfileirador.js`, mesma forma do enfileirador do webhook do Asaas, ADR 0015) cria um job `email_enviar` por linha `pendente` não enfileirada (`data = { envioId, geracao }`, só ids) e grava `enfileirado_em`. O job nunca nasce antes do `COMMIT` nem fica órfão por `ROLLBACK`.
- **Job `email_enviar`.** Lê a linha (sem transação longa); job de outra geração ou linha fora de `pendente` conclui sem enviar. O modelo (`api/src/email/modelos/`) lê do banco, no momento do envio, destinatário e variáveis a partir de `refs`; sem destinatário, a linha vai a `nao_enviado` com `erro_codigo = 'SEM_DESTINATARIO'`, sem retry nem alerta (outros códigos de sem envio na revisão de 2026-11-25); o mesmo vale para destinatário que não seja um único endereço (o envelope SMTP leva só ele). O HTML que não vem do tagged template `html` faz o job falhar (`modelo sem escape`). Depois do aceite do SMTP, `UPDATE ... WHERE estado = 'pendente' AND geracao = $2` grava `enviado`, `enviado_em`, `message_id` e a tentativa.
- **Entrega "ao menos uma vez".** Um crash do worker entre o aceite do SMTP e o `UPDATE` reenvia na retentativa (e-mail duplicado). Aceito; o `message_id` ajuda a conferir.
- **Geração e reenvio.** `jobId = email_enviar-<envioId>-<geracao>`. Reenviar uma linha `falhou` ou `nao_enviado` é um `UPDATE` documentado no `api/README.md` que volta a `pendente` e soma 1 à `geracao`; o enfileirador cria o job da geração nova. `npm run reprocessar -- <jobId>` só para job em `failed` cuja linha ainda esteja `pendente`.
- **E-mail parado.** A cada ciclo, linha `pendente` enfileirada há mais de `EMAIL_PARADO_HORAS` (padrão 6, acima das ~2 h do backoff completo), ou criada há mais que isso e nunca enfileirada, gera um alerta `email_parado` só com o id (uma vez por geração, `alertado_parado_em`).
- **Configuração do worker.** `EMAIL_TRANSPORTE=desligado|smtp`, padrão `desligado` em todos os ambientes até haver credencial (#57): o job grava `nao_enviado`, sem alerta, e em produção a partida loga `warn` (`e-mail desligado em produção`). `smtp` exige `SMTP_HOST`, `SMTP_USUARIO` e `SMTP_SENHA`; `SMTP_PORTA` (padrão 587; 465 usa TLS direto) e `SMTP_TIMEOUT_MS` (padrão 10000, de 1000 a 60000). `requireTLS` em todo host fora do loopback; em produção, host de loopback é recusado. `EMAIL_REMETENTE` (padrão `CITMail <naoresponda@citmail.com.br>`) e `EMAIL_RESPONDER_PARA` (vazio: sem Reply-To) recusam caractere de controle. Mensagens de erro citam o nome da variável, nunca o valor. O `nodemailer` roda sem `logger` nem `debug`, e sem acesso a arquivo ou URL.
- **Classificação e saneamento do erro.** O erro do `nodemailer` repete o endereço em `message`, `response` e `rejected`; o handler o troca por `ErroEmail` só com `code` e `responseCode`, sem `cause` nem a mensagem original, antes de chegar ao log e à fila. 5xx em `RCPT`/`DATA` (`EENVELOPE` ou `EMESSAGE`) grava `falhou` e é definitivo (`UnrecoverableError`, alerta de esgotado). O resto (4xx, rede, timeout, `EAUTH`) soma a tentativa, grava o código (SMTP, do `nodemailer` ou `ERRO_DESCONHECIDO` quando não há código), mantém `pendente` e relança; na última tentativa grava `falhou` antes de relançar. A tabela fica numa constante só (`CODIGOS_DEFINITIVOS_5XX`), a revisar no smoke da #57 (não se sabe ainda como a Skymail responde a limite de taxa ou bloqueio).
- **Registro.** `email_envio` guarda destinatário mascarado (1ª letra da parte local, `***`, `@` e o domínio: `a***@exemplo.com.br`), modelo, versão, `refs` (só ids), estado, tentativas, código do erro e datas; nunca endereço em claro, assunto ou corpo. O papel da aplicação não apaga nem altera `modelo` ou `refs`.
- **Escape.** HTML pelo tagged template `html` (`api/src/email/html.js`), que escapa `& < > " '` em todo valor interpolado; só entra cru o que vem de outro `html`. Assunto e valores do texto passam por `limparLinha`, que remove CR, LF e caracteres de controle (sem injeção de cabeçalho).
- **Log.** `to`, `from`, `replyTo`, `destinatario`, `variaveis`, `html`, `text`, `subject`, `assunto`, `pass` e `smtpSenha` entram em `camposSensiveis` (`api/src/log.js`). Custo: o `redact` em 4 níveis soma 44 caminhos. Campos homônimos de outro contexto (ex.: `from`/`to` de um intervalo de datas) também saem mascarados; aceito. O log do job leva só `envioId`, `modelo`, `estado` e `erro_codigo`.
- **Pendências.** SPF, DKIM e DMARC do domínio remetente (infraestrutura, #57) e limpeza de `email_envio` após 90 dias (índice por `criado_em` pronto; história própria), em "Decisões em aberto" do README.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-11-24: adendo da implementação do envio por fila (CIT-65).
- 2026-11-25: e-mails do link de senha (CIT-72), sem mudar a decisão acima:
  - Protocolo do `carregar`: além de `{ destinatario, variaveis }` e `null` (`SEM_DESTINATARIO`), o modelo pode devolver `{ semEnvio: '<CODIGO>' }`. Código no formato de `erro_codigo` (`^[A-Z0-9_]{1,32}$`) → `nao_enviado` com ele, log `info` com `envioId`, `modelo` e `erro_codigo`, sem retry nem alerta. Código fora do formato é erro do modelo: `UnrecoverableError('semEnvio inválido')`, a linha fica `pendente` e o `email_parado` alerta (não grava `falhou`: o código não cabe no CHECK).
  - Contexto do `carregar`: `{ log, painelUrlBase }`. `painelUrlBase` vem de `criarHandlerEmail` (worker, `PAINEL_URL_BASE`, só com `PAINEL_HABILITADO`; ADR 0008).
  - Hook opcional `aposEnviar(pool, refs, { tokenHash, log })`, chamado só quando o `UPDATE` de `enviado` grava a linha, com o `tokenHash` que o `carregar` devolveu em campo próprio (fora de `variaveis`). Falha do hook vai ao log (`warn`, só ids e código) e não relança: relançar reenviaria o e-mail. `validarModelos` aceita `aposEnviar` ausente ou função.
  - `destinatarioValido` (`api/src/email/html.js`) é a regra única de endereço, usada pelo handler e pelos modelos que conferem o endereço antes de um efeito (o de senha, antes de gastar o token).
  - Modelos `senha_primeiro_acesso` ("Defina sua senha do CITMail") e `senha_redefinicao` ("Redefinição de senha do CITMail"), `refs = { solicitacaoId }`, pedidos pelo consumidor `email_definicao_senha` e pela reemissão do "esqueci"; códigos de sem envio `LINK_FECHADO`, `TIPO_DIVERGENTE` e `SEM_URL_PAINEL`. Contrato do token no ADR 0008.
  - Dívida registrada: o anti-spam da reemissão (ADR 0008) filtra `email_envio` por `refs->>'solicitacaoId'` sem índice (varredura dos envios de senha). Volume baixo no mvp; o índice de expressão entra numa migração própria quando o volume pedir, com o ajuste das contagens do teste de down.
