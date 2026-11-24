# API do CITMail

API (Application Programming Interface: interface que outros programas usam para conversar com o sistema) em Node.js, com [Fastify](https://fastify.dev/) e PostgreSQL. Serve as rotas de back-end do CITMail; o site estático (`index.html`, `login.html`, `checkout.html`, `painel.html`) continua publicado à parte, sem build.

Pacote independente, sem workspace npm: `npm ci` aqui não mexe no `package.json`/`package-lock.json` da raiz, e o `npm ci`/`npm test` da raiz não instala nem roda nada desta pasta.

## Estrutura de pastas

```
api/
  compose.yaml        PostgreSQL e Redis locais (desenvolvimento e teste) por Docker Compose
  .env.example        nomes das variáveis de ambiente (sem valores secretos)
  package.json        scripts e dependências da API
  eslint.config.js    configuração do lint (ESLint, regras recomendadas)
  migrations/         migrações SQL do node-pg-migrate (uma por arquivo, com Up/Down)
  deploy/journald-namespace.conf  retenção dos logs (journald, até 30 dias; instalado na VPS pela #57/#93)
  src/
    config.js         lê e valida as variáveis de ambiente por processo (carregarConfig da API, carregarConfigWorker, carregarConfigFila da CLI)
    banco.js           pool do PostgreSQL (pg) e checagem de saúde (verificarBanco)
    app.js             fábrica construirApp(config, { pool, logStream, filas, asaas, pedidos }): Fastify, CORS, log, validação e erros
    log.js             log técnico: lista de campos mascarados, serializers, LogCitmail (linha única por requisição) e criarLogger (worker)
    erros.js           tratamento padronizado de erro (400 por campo, 404, 500) e ErroDeDominio
    servidor.js        ponto de entrada da API: carrega a config, sobe o Fastify, encerra em SIGTERM/SIGINT
    worker.js          ponto de entrada do worker da fila (npm run worker): pool do banco, publicador do outbox, enfileirador e handler do webhook do Asaas (com WEBHOOK_ASAAS_HABILITADO) e workers, sem CORS; encerra em SIGTERM/SIGINT esperando os ciclos do publicador e do enfileirador, o job ativo e os alertas em curso
    saude/rotas.js      GET /api/health
    precos/             POST /api/orcamento (público, sem banco): tabela.js (tabela do servidor, limites e tetoAddon; paridade com assets/precos.js), servico.js (validarLimites e calcularOrcamento), rotas.js (schemas gerados da tabela); o corpo aceita `dominio: { tipo: 'novo' | 'existente' }` (opcional) e, com `novo`, `avulsos` traz o item `dominio_principal` (1 por ano, mesmo preço do domínio extra)
    exemplo/rotas.js    POST /api/exemplos e POST /api/exemplos/job (só fora de produção; padrão de schema, erro e de rota que só enfileira)
    jobs/executar.js    executarJob: log correlacionado de job (job iniciado/concluído/falhou)
    jobs/exemplo.js     job de exemplo
    fila/conexao.js     conexões com o Redis: de worker (espera o Redis voltar) e de produtor (falha rápido)
    fila/filas.js       filas jobs e alertas (tentativas, backoff exponencial, retenção)
    fila/worker.js      workers: roda os handlers, alerta de job esgotado, envio de alertas com limite por minuto
    alertas/telegram.js envio do alerta ao Telegram (job esgotado e webhook do Asaas; só ids e códigos, token fora de log e erro)
    cli/reprocessar.js  npm run reprocessar -- <jobId>: devolve um job falhado à fila
    asaas/resumo.js     resumoEventoAsaas: o que do webhook do Asaas pode ir para o log
    asaas/cliente.js    criarClienteAsaas: adaptador HTTP da API v3 do Asaas (cliente, assinaturas, URL da 1ª fatura, remoção, buscarPagamento), ErroAsaas e centavosParaReais
    asaas/webhook-rotas.js POST /api/asaas/webhook (ADR 0015): token, schema, lista branca (extrairCamposBrutos) e gravação do bruto
    asaas/webhook-processamento.js enfileirador (iniciarEnfileiradorWebhook) e handler do job asaas_webhook (criarHandlerWebhook): conferência, matriz de status, pedido, conta do titular e eventos
    asaas/webhook-repositorio.js acesso a asaas_webhook_evento e às leituras de pedido e assinatura do processamento
    contas/repositorio.js conta_titular: inserirContaSeNova e buscarContaPorClienteOuEmail
    pedidos/            POST /api/pedidos (ADR 0014): rotas.js (schema a partir do orçamento), servico.js (fluxo de criação, idempotência, retomada e compensação), repositorio.js, documento.js (CPF e CNPJ, inclusive alfanumérico), dominio.js (mesmas regras de assets/checkout.js)
    eventos/            eventos de domínio pelo outbox (sem rota): servico.js (registrarEvento), publicador.js (publicarPendentes, iniciarPublicador), consumidores.js (registro, processarEvento, criarHandlersDeConsumidores), repositorio.js, vocabulario.js (12 nomes)
    auditoria/          trilha de auditoria (só serviço e repositório, sem rota): servico.js (registrarAuditoria), repositorio.js (INSERT), vocabulario.js (ações, autores, alvos, resultados e chaves proibidas)
  test/                suíte node:test (uma spec por critério de aceite)
```

Rotas de negócio futuras (pedidos, pagamentos, contas etc.) seguem a organização por módulo de domínio do [ADR 0002](../docs/adr/0002-organizacao-do-codigo-da-api.md): camadas rota → serviço → repositório dentro de cada módulo. A rota só valida e traduz HTTP; o serviço aplica a regra de negócio; o repositório é o único que consulta o banco. O health (`saude/rotas.js`) é a exceção: rota técnica, consulta o pool direto.

Padrões de `src/app.js` para todo módulo:

- Registro com prefixo: `app.register(rotasDoModulo, { prefix: '/api' })`; dentro do módulo, o caminho sem `/api` (ex.: `app.get('/health')`).
- Pool do banco em `app.banco` (`app.decorate('banco', pool)`), não por opção de plugin.
- Rota `POST`, `PUT` ou `PATCH` sem `schema.body` derruba a subida (hook `onRoute`, [ADR 0003](../docs/adr/0003-framework-http.md)); exceção só com justificativa na lista `rotasSemSchemaDeCorpo`.
- Corpo JSON validado sem coerção de tipo (`"2"` não vira `2`: responde 400 `tipo inválido`); querystring e params mantêm a coerção do Fastify.
- Regra de negócio violada: `throw new ErroDeDominio({ status: 409, erro: 'codigo_do_erro' })` (de `src/erros.js`); a resposta é o status e `{ "erro": "codigo_do_erro" }`.

## Requisitos

- Node.js ≥ 20.19.
- Docker com Docker Compose (para o PostgreSQL e o Redis locais).

## Setup

Todos os comandos abaixo rodam dentro de `api/`.

```sh
cp .env.example .env
```

Preencha em `api/.env` (nunca versionado): `POSTGRES_PASSWORD` (senha do PostgreSQL de desenvolvimento) e `DATABASE_URL` com a mesma senha, por exemplo `postgres://postgres:<mesma-senha-de-POSTGRES_PASSWORD>@127.0.0.1:55432/citmail`. Os demais valores já vêm com um padrão de desenvolvimento no `.env.example`.

```sh
docker compose up -d --wait banco
npm ci
npm run migrar
npm run dev
```

Fila de jobs (opcional para a API; a rota `POST /api/exemplos/job` só existe com `REDIS_URL`): defina `REDIS_URL=redis://127.0.0.1:56378` em `api/.env` e, em outro terminal:

```sh
docker compose up -d --wait redis
npm run worker
```

Em outro terminal, conferir o health check (HTTP: protocolo do navegador; health check: rota que confirma se o serviço está no ar):

```sh
curl -i http://127.0.0.1:3000/api/health
```

Resposta esperada: status `200`, cabeçalho `x-request-id` e corpo `{"status":"ok","banco":"ok"}`.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe a API em desenvolvimento (`--env-file=.env`, `--watch`: reinicia ao salvar um arquivo). |
| `npm start` | Sobe a API lendo as variáveis já exportadas no processo (sem `--env-file`); uso em produção. |
| `npm run migrar` | Aplica as migrações pendentes (`node-pg-migrate up`). |
| `npm run migrar:reverter` | Reverte a última leva de migrações (`node-pg-migrate down`). |
| `npm run nova-migracao` | Cria um novo arquivo de migração SQL em `migrations/`. |
| `npm run banco:teste` | Sobe o PostgreSQL de teste (perfil `teste` do `compose.yaml`, dados em `tmpfs`, sem senha, só loopback). |
| `npm run servicos:teste` | Sobe o PostgreSQL e o Redis de teste (`banco-teste` e `redis-teste`, perfil `teste`, dados em `tmpfs`, só loopback). |
| `npm run worker` | Sobe o worker da fila (processo separado da API; comando da futura unidade `systemd`, #57). Lê `api/.env` se existir. No SIGTERM/SIGINT espera o job ativo e os alertas em curso e ignora um segundo sinal; a unidade da #57 precisa de `TimeoutStopSec` maior que esse encerramento (ADR 0006). Em produção, o job `exemplo` não é registrado (vai a "falhou" como job desconhecido). |
| `npm run reprocessar -- <jobId>` | Devolve um job em "falhou" para a fila, com o mesmo id e as tentativas zeradas. Sai 0 se reenfileirou, 1 se o `jobId` é inválido (fora de `^[\w-]{1,64}$`; nada é alterado), se o job não existe ou se o Redis não respondeu em 10 s, e 2 se o job não está em "falhou". Não imprime os dados do job. Depois de um `TimeoutError` o reenfileiramento pode ter sido aplicado mesmo assim: confira o estado do job antes de repetir. |
| `npm run lint` | Roda o ESLint (regras recomendadas, `eslint.config.js`) sem tolerar aviso (`--max-warnings=0`). |
| `npm test` | Roda a suíte `node:test` sem acesso à rede externa (ver "Como rodar os testes"). |

## Variáveis de ambiente

Nomes usados por `src/config.js` e por `compose.yaml`; nenhum valor secreto vai neste documento nem no `.env.example`.

| Variável | Uso | Padrão |
|---|---|---|
| `DATABASE_URL` | String de conexão do PostgreSQL. | obrigatória, sem padrão |
| `POSTGRES_PASSWORD` | Senha do PostgreSQL de desenvolvimento; lida pelo `docker compose` a partir de `api/.env` e usada dentro de `DATABASE_URL`. Sem ela, o contêiner `banco` não sobe (a imagem do postgres recusa senha vazia); o `banco-teste` não precisa dela. | obrigatória para `banco`, sem padrão |
| `HOST` | Endereço em que a API escuta. | `127.0.0.1` |
| `PORT` | Porta em que a API escuta. | `3000` |
| `CORS_ORIGENS` | Lista de origens permitidas, separadas por vírgula (CORS: Cross-Origin Resource Sharing, compartilhamento de recursos entre origens). Cada item é uma origem exata, `esquema://host[:porta]` (ex.: `https://novo.citmail.com.br`), sem caminho, sem barra final, sem `*` e sem `null`. | obrigatória, sem padrão |
| `LOG_LEVEL` | Nível do log `pino` (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). | `info` |
| `NODE_ENV` | Ambiente: só `production`, `development` ou `test` (outro valor impede a subida); em produção, `POST /api/exemplos` e `POST /api/exemplos/job` não são registrados. O `.env` de desenvolvimento deve definir `development`. | `production` (ausente = produção, falha fechada) |

Fila e alertas (ADRs 0005 e 0011). Cada processo exige só o que usa: a API (`npm run dev`/`npm start`), o worker (`npm run worker`) e a CLI (`npm run reprocessar`). O worker lê `DATABASE_URL` (obrigatória: outbox de eventos, CIT-166); a CLI não a lê; nenhum dos dois lê `CORS_ORIGENS`; `NODE_ENV` e `LOG_LEVEL` valem para os três.

| Variável | API | Worker | CLI | Uso | Padrão |
|---|---|---|---|---|---|
| `REDIS_URL` | opcional | obrigatória | obrigatória | Conexão com o Redis da fila. Sem ela, a API sobe sem fila e sem `POST /api/exemplos/job`. A API não usa o Redis em produção: o webhook do Asaas só grava no banco, e quem enfileira é o worker (CIT-64). Nunca vai para o log. | sem padrão |
| `FILA_PREFIXO` | lida | lida | lida | Prefixo das chaves no Redis; separa ambientes no mesmo Redis (ADR 0006). Só letras minúsculas, dígitos e hífen. | `citmail` |
| `FILA_TENTATIVAS` | lida | lida | lida | Tentativas por job (inteiro de 1 a 20). | `8` |
| `FILA_BACKOFF_MS` | lida | lida | lida | Espera antes da 2ª tentativa, em ms (inteiro de 1 a 3600000); dobra a cada tentativa (exponencial: com os padrões, cerca de 2 h até esgotar). | `60000` |
| `DATABASE_URL` | obrigatória | obrigatória | não lê | String de conexão do PostgreSQL (tabela acima). No worker, conferida depois de `REDIS_URL`. | sem padrão |
| `OUTBOX_INTERVALO_MS` | não lê | lida | não lê | Intervalo entre ciclos do publicador do outbox, em ms (inteiro de 100 a 60000), contado do fim de um ciclo ao início do próximo. | `2000` |
| `TELEGRAM_BOT_TOKEN` | não lê | obrigatória em produção | não lê | Token do bot do alerta. Segredo: só no ambiente do worker. | sem padrão |
| `TELEGRAM_CHAT_ID` | não lê | obrigatória em produção | não lê | Id do grupo que recebe os alertas. Segredo: só no ambiente do worker. | sem padrão |

Fora de produção, sem as duas variáveis do Telegram, o alerta sai só no log (`alerta sem telegram`).

Pedido no Asaas ([ADR 0014](../docs/adr/0014-criacao-do-pedido-no-asaas.md)). Só a API lê (o worker lê `ASAAS_*` com o webhook ligado, tabela seguinte); nenhuma das cinco vai para o log.

| Variável | Uso | Padrão |
|---|---|---|
| `PEDIDOS_HABILITADO` | `true` ou `false` (outro valor impede a subida). Desligada, `POST /api/pedidos` não é registrada (404). **Só ligar em produção depois do limite de taxa da rota (E6-H4)** (ADR 0014). Ligada em produção com os termos em minuta ou a Política provisória (`TERMOS_MINUTA` ou `PRIVACIDADE_PROVISORIA` em `src/pedidos/aceite.js`), a API não sobe, salvo com `TERMOS_MINUTA_ACEITA`. | `false` em produção; `true` fora dela |
| `TERMOS_MINUTA_ACEITA` | `true` ou `false` (outro valor impede a subida, sempre, mesmo sem uso). Liberação explícita para subir com `PEDIDOS_HABILITADO=true` em produção com os termos em minuta ou a Política provisória; em uso, a partida loga `warn` `aceite liberado com termos em minuta ou política provisória`. **Só na homologação, se ela rodar como produção (#57). A produção real nunca usa esta variável** (ADR 0014, decisão 12). | ausente (trava ativa) |
| `ASAAS_BASE_URL` | URL base da API v3 do Asaas (sandbox ou produção). Em produção, só `https://` com o host `api.asaas.com` ou `api-sandbox.asaas.com` (sem porta nem credencial). Obrigatória com `ASAAS_API_KEY`, em qualquer ambiente: não há URL padrão. | sem padrão |
| `ASAAS_API_KEY` | Chave da API do Asaas, enviada no cabeçalho `access_token`. Segredo: só no ambiente da API. Com a rota ligada em produção, obrigatória; fora de produção, sem ela (e sem adaptador injetado nos testes), a rota responde 503 `asaas_nao_configurado`. | sem padrão |
| `ASAAS_TIMEOUT_MS` | Limite de cada chamada ao Asaas, em ms (inteiro de 1000 a 30000). O pedido inteiro tem ainda um prazo global de 45 s nas chamadas de criação. | `10000` |

Webhook do Asaas ([ADR 0015](../docs/adr/0015-webhook-do-asaas.md); CIT-64). Nenhuma vai para o log.

| Variável | API | Worker | Uso | Padrão |
|---|---|---|---|---|
| `WEBHOOK_ASAAS_HABILITADO` | lida | lida | `true` ou `false` (outro valor impede a subida). Desligada, a API não registra `POST /api/asaas/webhook` (404) e o worker não registra o handler `asaas_webhook` nem inicia o enfileirador. | `false` em produção; `true` fora dela |
| `ASAAS_WEBHOOK_TOKEN` | obrigatória em produção com a flag | não lê | Token que o Asaas envia no cabeçalho `asaas-access-token`. Segredo: só no ambiente da API. Em produção, com a flag ligada, ao menos 32 caracteres, senão a API não sobe; fora de produção, sem ele, a rota responde 503 `webhook_indisponivel`. | sem padrão |
| `ASAAS_API_KEY`, `ASAAS_BASE_URL`, `ASAAS_TIMEOUT_MS` | ver acima | lidas com a flag | Com a flag ligada, o worker as lê com a mesma validação da API (chave e URL obrigatórias em produção) para conferir o pagamento (`GET /payments/{id}`). Fora de produção, sem chave, o handler lança e o bruto fica para reenvio. | ver acima |

## Logs

JSON do `pino` na saída padrão (ADR 0013, item 8; código em `src/log.js`). Linhas:

- `request completed` (nível `info`, uma por requisição, também em 4xx/5xx): `reqId` (igual ao header `x-request-id` da resposta), `req.method`, `req.rota` (template, ex.: `/api/exemplos/:id`), `req.remoteAddress` (IP), `res.statusCode` e `responseTime` (ms). Sem URL concreta (nem query nem valor de parâmetro), sem headers e sem corpo. No 404, `req.rota` é `null` e `req.caminho` traz o path sem query (até 200 caracteres). Não há `incoming request` nem `Route ... not found`.
- `request aborted`: o cliente desistiu antes da resposta (`reqId`, `req.rota`).
- `GET /api/health` loga só a partir de `warn` (o monitoramento chama a cada minuto); a falha sai como `banco indisponível no health`, com `reqId`.
- Jobs: `executarJob({ nome, correlacaoId, log }, fn)` de `src/jobs/executar.js` registra `job iniciado`, `job concluído` (com `duracaoMs`) ou `job falhou` (`error`, com o erro original; relança à fila um erro saneado, só com `<name>` ou `<name> (<code>)` na mensagem, porque a fila guarda a mensagem no Redis), todas com `job` e `reqId` = `correlacaoId` (sem ele, um UUID novo). Passar em `log` o logger raiz (`app.log` ou o do worker), nunca `request.log`, que já tem `reqId` (a chave sairia repetida); dentro do job, logar só pelo `log` recebido em `fn`. Os dados do job não são logados. Exemplo: `POST /api/exemplos/job` (`{ "falhar": true }` simula a falha) só enfileira e responde 202 com `{ jobId }` (503 `{ "erro": "fila indisponível" }` com o Redis fora); o worker roda o job com `reqId` igual ao `x-request-id` da resposta.
- Fila (worker, mesma máscara do app por `criarLogger`): as linhas de job acima, agora pelo worker; `job desconhecido` (`error`, `jobId`: nome sem handler; vai a "falhou" sem novas tentativas); `alerta não enfileirado` (`error`, `jobId`: o job esgotou mas o alerta não entrou na fila); `alerta falhou` (`error`, `jobId`: o envio ao Telegram esgotou as tentativas); `envio ao telegram falhou` (`warn`, só `erro` com o nome do erro ou `status`, nunca a URL, que leva o token); `alerta sem telegram` (`warn`, `jobId`, `job`, `pedido`: fora de produção sem Telegram); `erro no worker` e `erro na fila` (`error`, só `erro` com o nome do erro e `fila`: a mensagem do Redis traz host e porta). Na API, `fila indisponível` (`warn`, `reqId`, só o nome do erro) quando o Redis não aceita o job em 2 s; a rota responde 503.
- Webhook do Asaas: logar só `resumoEventoAsaas(evento)` de `src/asaas/resumo.js` (`event`, `paymentId`, `paymentStatus`, `billingType`); nunca `request.body`, o `payment`/`customer` inteiro nem o header `asaas-access-token`.

**Máscara** (`redact`, censor `[mascarado]`): os 41 nomes de `camposSensiveis` em `src/log.js` (dados pessoais do pedido e do cliente do Asaas, credenciais, `creditCard` e `creditCardToken`) na raiz e em até 3 níveis de aninhamento (`x`, `a.x`, `a.b.x`, `a.b.c.x`), além dos campos `err.*` e `err.cause.*` do `pg` (`detail`, `where`, `parameters`, `hint`, `internalQuery`, `query`). Limites: o 5º nível não é mascarado; o nome precisa ser exato (`CPF` não casa com `cpf`); homônimos técnicos, se existirem, também são mascarados (ex.: um `name` próprio de erro, `numero` técnico; usar nomes distintos como `numeroPedido`); dado pessoal dentro de `err.message` e `err.stack` não é mascarado (o `pg` pode repetir o valor enviado; logar `code` e `routine`, não a mensagem do driver). Ficam em claro, de propósito, `uf`, `estado` e `state`. Ficam fora, para a #64 revisar, os textos livres do Asaas `description`, `observations`, `groupName` e `externalReference`.

**Retenção:** até 30 dias, em journald, com um namespace por ambiente: `citmail` (produção) e `citmail-homolog` (homologação). O arquivo `deploy/journald-namespace.conf` (`MaxRetentionSec=29day` + `MaxFileSec=1day`, porque o journald apaga arquivo inteiro; `SystemMaxUse=1G` por namespace; `ForwardToSyslog=no`, para o log não cair na retenção do logrotate) é instalado como `/etc/systemd/journald@<namespace>.conf`, e as unidades systemd da API e do worker usam `LogNamespace=<namespace>`. Consulta: `journalctl --namespace=<namespace>`. Premissa: systemd ≥ 245. A aplicação e a verificação na VPS ficam com a #57/#93.

## Auditoria

Trilha das ações críticas (ADR 0013, item 7; código em `src/auditoria/`, tabela criada pela migração `auditoria`). Só há serviço e repositório: nenhuma rota. Quem implementa uma ação da lista chama `registrarAuditoria`.

```js
import { registrarAuditoria } from './auditoria/servico.js'

const id = await registrarAuditoria(executor, {
  autor: { tipo: 'cliente', id: contaId },   // tipo: cliente | sistema | equipe
  acao: 'caixa_criada',
  alvo: { tipo: 'caixa', id: caixaId },      // tipo: conta | caixa | cliente | pedido | assinatura | dominio
  resultado: 'sucesso',                      // sucesso | falha
  ip: request.ip,                            // IPv4 ou IPv6 sem zona; nulo só com autor sistema
  requestId: request.id,                     // opcional, até 128 caracteres
  detalhes: { plano: '5gb' }                 // opcional, objeto sem chave sensível
})
```

- **Retorno:** o `id` do registro, como **string** (o `pg` devolve `bigint` como texto). `ocorrido_em` nunca vem do chamador: um trigger `BEFORE INSERT` (`auditoria_definir_ocorrido_em`) grava `clock_timestamp()` (o instante do registro, não o início da transação do chamador), mesmo que o dono ou um superusuário informe a coluna. A ordem confiável é o `id`.
- **`autor.id` e `alvo.id`** são chaves internas (`conta.id`, `caixa.id` etc.), nunca e-mail, domínio pessoal ou outro dado pessoal.
- **`executor`:** um `Pool` ou um `Client` (qualquer objeto com `query`). Com um `Client` dentro de transação, o registro é atômico com a ação: o rollback do chamador apaga o registro. O INSERT tem 9 parâmetros e devolve o `id` por `RETURNING`.
- **Falha vai pelo pool.** Registro de **falha** (de qualquer ação, inclusive login e bloqueio) é gravado pelo pool, fora da transação que vai sofrer rollback; no `Client` da transação, o registro sumiria junto com ela. Ordem: `ROLLBACK` → `client.release()` → `registrarAuditoria(pool, …)`. Liberar o `Client` antes evita segurar duas conexões do pool (`max` 5) por requisição. Erro da própria auditoria vai para o log e não mascara o erro original, que segue para o chamador.
- **Ações (12):** `login`, `login_falhou`, `conta_bloqueada`, `caixa_criada`, `caixa_excluida`, `senha_trocada`, `cadastro_alterado`, `assinatura_cancelada`, `dados_excluidos`, `conta_suspensa`, `conta_reativada`, `dominio_registrado_manualmente`. O vocabulário é fechado em `src/auditoria/vocabulario.js` e repetido nos `CHECK` da tabela: mudou num, muda no outro (nova migração) no mesmo PR.
- **Entrada inválida** lança `TypeError` antes de qualquer consulta, com mensagem `auditoria: <motivo>` que cita o campo e nunca o valor. Limites: `autor.id` e `alvo.id` com 1 a 64 caracteres; `requestId` com até 128; os três sem caractere nulo nem surrogate solitário; `ip` válido por `net.isIP` e sem `%` (o `inet` recusa zona, como `fe80::1%eth0`); `detalhes` objeto (não array nem escalar), serializável, com até 2048 bytes, 4 níveis (a raiz conta 1; objeto e array contam), sem caractere nulo nem surrogate solitário em chave ou valor (`detalhes com caractere inválido`) e com números em módulo abaixo de `1e15` e, se não zero, a partir de `1e-6` (`detalhes com número fora da faixa`; o `jsonb::text` escreve `1e300` por extenso). O banco repete o essencial em `CHECK` (ids de 1 a 64 caracteres, `detalhes` até 4096 bytes em `jsonb::text`).
- **Falha de login com e-mail inexistente:** `autor { tipo: 'cliente', id: null }` e `alvo { tipo: 'conta', id: null }`, sem o e-mail (evita enumerar contas e dado pessoal na trilha). `autor.id` nulo só vale com autor `sistema` ou ação `login_falhou`; `alvo.id` nulo só com `login_falhou`; `ip` nulo só com autor `sistema`. O banco confere o mesmo por `CHECK`.
- **A garantia é por chave, não por valor.** Em `detalhes`, chave proibida é **recusada** (não mascarada), em qualquer nível, inclusive dentro de array: as 41 chaves de `camposSensiveis` do log mais `ip` e variações de IP como `ip_origem`, `ipcliente`, `remote_addr` e `x-forwarded-for` (`CHAVES_PROIBIDAS`, igualdade sem diferenciar maiúsculas; inclui dado pessoal como `nome`, `email` e `numero`; IP fora da coluna escaparia da pseudonimização) e qualquer chave que contenha `senha`, `password`, `token`, `secret`, `authorization`, `cookie`, `apikey`, `api_key`, `email`, `cpf`, `cnpj` ou `telefone` (`TRECHOS_PROIBIDOS`: pega `novaSenha`, `refresh_token`, `x-api-key`, `email_contato`). O erro é `auditoria: chave proibida em detalhes: <chave>`, com a chave cortada em 64 caracteres. **Valores livres não são inspecionados**: senha ou dado pessoal sob uma chave permitida passa. Quem chama escolhe chaves distintas (ex.: `plano_nome`, não `nome`). Um teste confere que toda chave de `camposSensiveis` é recusada; quando a lista do log crescer, ele falha na CI e a chave entra também no vocabulário da auditoria.

**Só inclusão (duas camadas).** O papel da aplicação é **por banco**: `<banco>_aplicacao` (NOLOGIN), criado pela migração se ainda não existir, com `SELECT` em `auditoria` e `INSERT` só nas 9 colunas do serviço, e nada mais (o `REVOKE ALL ... FROM PUBLIC` e do papel anula também um `ALTER DEFAULT PRIVILEGES` futuro). Sem `INSERT` em `id` e `ocorrido_em`, a aplicação não escolhe nenhum dos dois (nem por `OVERRIDING SYSTEM VALUE`): `42501`. Se o papel já existir com `LOGIN`, `SUPERUSER`, `CREATEROLE`, `BYPASSRLS`, `REPLICATION` ou `CREATEDB`, ou for membro de outro papel (ex.: `pg_write_all_data`), a migração falha em vez de conceder a ele. Papéis do PostgreSQL são do cluster; com o nome derivado do banco, homologação e produção na mesma VPS (ADR 0006) não compartilham permissões. O nome do banco pode ter no máximo 53 bytes (`octet_length`): acima disso a migração falha, para o sufixo não ser truncado em silêncio. Um trigger (`auditoria_bloquear_alteracao`, `BEFORE UPDATE OR DELETE` por linha e `BEFORE TRUNCATE`) lança `P0001` (`auditoria só de inclusão: <operação> bloqueado`) até para o dono da tabela. Os triggers são `ENABLE ALWAYS` (valem também com `session_replication_role = replica`), e as funções têm `search_path` fixo (`pg_catalog, pg_temp`). Única exceção: o papel `<banco>_retencao` pode alterar **só** a coluna `ip` (pseudonimização aos 6 meses, ADR 0013 item 9); `DELETE` e `TRUNCATE` ficam bloqueados para todos. O trigger compara `current_user`: a rotina de retenção precisa de `SET ROLE <banco>_retencao` (só ser membro do papel cai no `P0001`). Pseudonimizar é truncar o IP (ex.: `/24` no IPv4, `/48` no IPv6), não apagar: `ip` nulo viola o `CHECK` para autor `cliente` e `equipe`. Esse papel e a rotina de retenção ainda não existem: até lá o IP fica em claro além dos 6 meses propostos.

Limites aceitos:

- Superusuário ou dono da tabela pode contornar o trigger (`ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`, `DROP TABLE`); `ENABLE ALWAYS` só fecha o contorno por `session_replication_role`.
- Enquanto a API conectar como superusuário (`postgres`), o `GRANT` é inócuo e só o trigger protege a tabela. A garantia contra a aplicação só fica completa depois da #57, que troca o login da app para um usuário membro de `<banco>_aplicacao`. A #57 também cria o papel antes da primeira migração (ou o migrador ganha `CREATEROLE`) e documenta a versão do PostgreSQL da VPS.
- O `down` da migração é recusado (`P0001`, `auditoria com registros: down recusado`) se a tabela tiver registros, porque `DROP TABLE` não dispara trigger. A tabela é travada (`ACCESS EXCLUSIVE`) antes da conferência, para nenhum INSERT entrar entre ela e o `DROP`. O papel não é apagado no `down`.

**Convenção de `GRANT` para tabelas futuras.** Toda migração que cria tabela concede, explicitamente, ao papel da aplicação só os privilégios de que a app precisa. Não usar `ALTER DEFAULT PRIVILEGES`. Sem o `GRANT`, a tabela nova falha com `42501` assim que a #57 trocar o login, o que é desejado: falha visível, não privilégio a mais.

```sql
DO $$
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON minha_tabela TO %I', current_database() || '_aplicacao');
END
$$;
```

**Consulta de exemplo** (no mvp a consulta é por SQL, sem tela). Lido sem cast, o `ip` vem como texto sem `/32` (`203.0.113.7`); com `ip::text` o PostgreSQL acrescenta `/32`.

```sql
SELECT id, ocorrido_em, autor_tipo, autor_id, acao, resultado, ip, request_id, detalhes
FROM auditoria
WHERE alvo_tipo = 'conta' AND alvo_id = '<id da conta>'
  AND ocorrido_em >= '2026-11-01' AND ocorrido_em < '2026-12-01'
ORDER BY id;
```

## Eventos de domínio

Outbox do [ADR 0005](../docs/adr/0005-fila-e-eventos-de-dominio.md) (código em `src/eventos/`, tabelas criadas pela migração `eventos`; lista de eventos no [anexo de eventos](../docs/adr/anexos/eventos-de-dominio.md)). Sem rota.

**Emitir:** `registrarEvento` na **mesma transação** da mudança de estado, com o `pg.Client` dela (o `Pool` é recusado; a função não confere se há `BEGIN` aberto, isso é do chamador).

```js
import { registrarEvento } from './eventos/servico.js'

await cliente.query('BEGIN')
// ... mudança de estado ...
const { id, criado } = await registrarEvento(cliente, {
  nome: 'pedido_pago',                              // um dos 12 de src/eventos/vocabulario.js
  agregado: { tipo: 'pedido', id: pedidoId },       // tipo: pedido | conta_titular | assinatura (CHECK no banco)
  chaveIdempotencia: `pedido_pago-${pedidoId}`,     // <nome>-<id>[-<id>], até 200 caracteres
  payload: { pedidoId, ciclo: 'mensal' },           // só ids e dados não pessoais, até 2048 bytes
  requestId: request.id                             // obrigatório, até 128 caracteres
})
await cliente.query('COMMIT')
```

- A mesma `chaveIdempotencia` devolve o id já gravado com `criado: false` (nada novo gravado).
- Entrada inválida lança `TypeError` antes de qualquer consulta, com mensagem `evento: <motivo>` sem o valor (`nome fora da lista`, `payload com campo sensível`, `chaveIdempotencia inválida`, `requestId obrigatório` etc.). Chave de `camposSensiveis` (`src/log.js`) em qualquer nível do payload, sem diferenciar maiúsculas, é recusada. **O filtro olha só os nomes de chave:** um valor pessoal sob chave neutra passa; o esquema de cada evento fica com o emissor.

**Publicar:** o worker roda o publicador (`iniciarPublicador`) a cada `OUTBOX_INTERVALO_MS`. Cada ciclo lê até 50 eventos com `publicado_em` nulo e cria, num só `addBulk` com prazo de 2 s, um job por consumidor inscrito no nome do evento: `name = <consumidor>`, `data = { eventoId, requestId }`, `jobId = <consumidor>-<eventoId>`. Deu certo: `publicado_em` preenchido. Redis fora ou prazo estourado: `tentativas_publicacao + 1` e o evento fica para o ciclo seguinte (represado no banco, não perdido). Evento sem consumidor inscrito é marcado publicado sem job. Um só worker (ADR 0006).

**Consumir:** registrar o consumidor em `consumidoresPadrao` de `src/eventos/consumidores.js` (vazio por enquanto):

```js
export const consumidoresPadrao = Object.freeze({
  provisionar_conta: {                       // ^[a-z][a-z0-9_]{0,47}$, sem hífen; não pode repetir um job de handlersPadrao
    eventos: ['pedido_pago'],
    async tratar({ cliente, evento, log }) { /* efeito no banco pelo cliente recebido */ }
  }
})
```

`processarEvento` abre a transação, lê o evento, grava `(consumidor, evento_id)` em `evento_processado` e roda `tratar` no mesmo cliente: o evento entregue de novo cai em `evento já processado` e o efeito não se repete. `tratar` que lança desfaz a marca (`ROLLBACK`) e a fila tenta de novo. **Efeito externo (e-mail, Skymail) não é transacional:** a marca garante "uma vez só" apenas para o efeito no banco; o consumidor consulta antes de criar no serviço externo. O log do job tem `reqId` = `requestId` do evento.

**Backfill** de um consumidor novo (republica para **todos** os inscritos; os que já processaram descartam pelo `evento_processado`):

```sql
UPDATE evento SET publicado_em = NULL WHERE nome = 'pedido_pago' AND ocorrido_em >= '2026-11-01';
```

O backfill **não reentrega** a consumidor cujo job `<consumidor>-<eventoId>` ainda está retido em `failed`: o `addBulk` com o mesmo `jobId` vira no-op. Nesse caso, reprocessar pelo retry do job (`npm run reprocessar -- <consumidor>-<eventoId>`, `src/cli/reprocessar.js`) ou remover o job antes.

Logs: `publicador iniciado` (`intervaloMs`), `evento sem consumidor` (`eventoId`, `evento` com o nome do evento; `nome` é chave mascarada pelo logger), `publicação falhou` (`warn`, `erro` com o nome do erro, `eventos` com a quantidade), `evento já processado` (`eventoId`, `consumidor`); erro de banco do ciclo sai com `erro` e `codigo`, sem mensagem. Sem retenção por enquanto: `evento` e `evento_processado` crescem até a história de limpeza.

## Pedidos

`POST /api/pedidos` ([ADR 0014](../docs/adr/0014-criacao-do-pedido-no-asaas.md); código em `src/pedidos/`, tabelas `cliente`, `pedido`, `pedido_dominio` e `assinatura` da migração `pedidos`). Corpo: o do orçamento com `dominio: { tipo, nome }` obrigatório, mais `dominios_extras` (tantos quantos `addons.extraDom`), `cliente { nome, email, telefone, documento }`, `chave_idempotencia` (UUID gerado pelo checkout), `versao_tabela`, `total_exibido_centavos` e `aceite { termos: true, versao_termos, versao_privacidade }` (CIT-62; obrigatório, sem coerção: `"true"` responde 400; versões de 1 a 32 e de 1 a 64 caracteres em `^[0-9A-Za-z._-]+$`). Todo objeto é fechado: campo de cartão responde 400. Nome, e-mail, telefone e documento com caractere de controle ou invisível (`\p{C}`) respondem 400 `requisicao_invalida`.

Respostas: 201 `{ pedidoId, estado: 'aguardando_pagamento', faturas: [{ tipo: 'contas' | 'dominios', url }], aviso? }` (`url` pode ser `null`; com `aviso: 'fatura_pendente'`, todas as `url` são `null`: ver abaixo); 400 validação; 404 com a rota desligada; 409 `versao_termos_divergente` (com as versões vigentes `versao_termos` e `versao_privacidade`; conferido antes do total), `total_divergente` (com `total_centavos` e `versao_tabela`) ou `pedido_em_criacao`; 422 `chave_reutilizada`; 500 `interno`; 502/504 `asaas_indisponivel` com `mensagem`; 503 `asaas_nao_configurado` (fora de produção).

- O pedido é gravado em `criando` (com `criando_desde`, a posse do fluxo) **antes** de qualquer chamada ao Asaas; nenhuma transação fica aberta durante uma chamada.
- Aceite (ADR 0014, decisão 11): gravado no mesmo `INSERT` (`aceite_em`, `versao_termos`, `versao_privacidade`, `ip_aceite` de `request.ip`, sem zona e com `::ffff:` convertido para IPv4). IP inválido responde 500 `interno` sem gravar (log `warn` `ip inválido`, sem o valor). O bloco `aceite` entra no `corpo_hash`; o IP não: o reenvio de outro IP devolve a resposta gravada sem mudar `ip_aceite`.
- Checklist da 1.0 dos termos (ADR 0014, decisão 12): no mesmo PR, trocar `TERMOS_MINUTA` e `VERSAO_TERMOS`, `PRIVACIDADE_PROVISORIA` e `VERSAO_PRIVACIDADE` (`src/pedidos/aceite.js`) e a página `termos.html`. O IP do aceite também fica no log de acesso (`req.remoteAddress` do `request completed`, ADR 0013), com a retenção de 30 dias. Pendência: a prova guarda as versões, sem hash do texto aceito.
- Antes de aplicar a migração `pedido-aceite` num banco com pedidos (desenvolvimento, homologação), limpe os pedidos de teste à mão (`assinatura`, `pedido_dominio`, `pedido` e, se quiser, `cliente`): com qualquer linha em `pedido`, a migração é recusada (`P0001`, `pedido sem aceite: ...`) e não apaga nada. O `down` também é recusado com pedidos.
- Antes de cada criação e antes de declarar falha, a API consulta o Asaas pelo documento (cliente) ou pelo `externalReference` `pedido:<id>:<tipo>` (assinatura) e reaproveita o que achar. A consulta de confirmação (depois de erro no `POST`) tem timeout próprio, fora do prazo global. Mais de uma assinatura ativa com a mesma referência: fica a mais antiga e as demais são removidas (log `warn` `assinatura duplicada`, só ids).
- Fatura retida (ADR 0014, decisão 10): nome normalizado ou e-mail do pedido diferente do cadastro do documento (tabela `cliente` e, se achado ou criado agora, o `GET /customers`) → o pedido segue normal, mas a URL da fatura não é buscada nem gravada, `pedido.fatura_retida = true` e o 201 traz `url: null` e `aviso: 'fatura_pendente'`, sem dado do cadastro. Log `fatura retida` com `codigo: 'contato_divergente'`. `cliente.asaas_contato_confere`, gravado com o `asaas_cliente_id`, diz se o cadastro do Asaas bate com a linha; falso retém a fatura de todo pedido do documento.
- A mesma chave com o mesmo corpo devolve a resposta gravada (201 ou a mesma falha); com outro corpo, 422. Pedido em `criando` responde 409 até o prazo de retomada (105 s com o padrão) e depois é retomado pela mesma chave. A retomada não impede de todo a duplicata (um `POST` em voo do fluxo anterior pode ser efetivado depois dela): a próxima consulta remove a sobra, e o fechamento definitivo fica para a reconciliação por job (ADR 0014).
- Falha do Asaas depois de criar uma assinatura: `DELETE` de todas as assinaturas ativas achadas pelo `externalReference` de cada tipo do pedido, mais as já obtidas (compensação, com timeout próprio fora do prazo global) e `falhou_na_criacao` com `falha_motivo` em código. `DELETE` que falha sai no log `error` `assinatura órfã` (só `pedidoId` e `asaasAssinaturaId`).
- Logs só com ids e códigos: `pedido criado`, `pedido retomado`, `pedido falhou na criação` (`pedidoId`, `falhaMotivo`, `operacao`, `statusAsaas`), `fatura sem url`, `posse perdida`, `assinatura órfã`, `assinatura duplicada`, `confirmação falhou` e `compensação sem consulta` (`operacao`, `tipo` do erro e `erro` com o nome do erro) e `erro de banco no pedido` (`code` e `routine`).
- Nos testes, `construirApp(config, { asaas, pedidos })` recebe o adaptador (stub local) e as opções do serviço (`agora`, `versaoTabela`, `versaoTermos`, `versaoPrivacidade`, `prazoPedidoMs`, `prazoCriandoMs`) e usa o IP de `request.ip` (`app.inject({ remoteAddress })`); `construirAppTeste` repassa as duas. `carregarConfig(env, { termosMinuta })` aceita a minuta injetada.

## Webhook do Asaas

`POST /api/asaas/webhook` ([ADR 0015](../docs/adr/0015-webhook-do-asaas.md); código em `src/asaas/webhook-*.js`, tabelas `asaas_webhook_evento` e `conta_titular` e coluna `pedido.dominio_pago_em` da migração `webhook-asaas`).

- **Recepção (API):** cabeçalho `asaas-access-token` conferido no `onRequest`, antes do corpo e do banco (SHA-256 e `timingSafeEqual`): ausente, vazio ou errado → 401 `{ erro: 'nao_autorizado' }`. Corpo até 16 KiB (413 acima); `id` em `^evt_[A-Za-z0-9_&.-]{1,120}$`, `event` e `payment.id` obrigatórios no formato (400 `validacao`). Grava o bruto só com a lista branca (`INSERT ... ON CONFLICT DO NOTHING`) e responde 200 `{ recebido: true }`, também ao repetido. Log `webhook do asaas recebido` só com `resumoEventoAsaas`, `brutoId` e `repetido`.
- **Enfileirador (worker):** a cada `OUTBOX_INTERVALO_MS`, até 50 brutos com `enfileirado_em` nulo viram jobs `asaas_webhook` (`jobId = asaas_webhook-<brutoId>`, `data = { brutoId, requestId }`) num `addBulk` com prazo de 2 s; depois `enfileirado_em` é marcado. Com o Redis fora, fica para o ciclo seguinte (log `enfileiramento do webhook falhou`).
- **Handler:** confere o pagamento no Asaas e aplica a matriz do ADR 0015. Resultado no bruto: `situacao` (`processado`, `ignorado`, `divergente`) e `codigo`. Erro de rede, 5xx, timeout ou pedido ainda em `criando`: o job tenta de novo com backoff e, esgotado, gera o alerta `job_esgotado`; o bruto continua `pendente`.
- **Alertas** (fila `alertas`, payload `{ tipo: 'webhook', codigo, brutoId, pedidoId }`): divergências da conferência, status sem efeito marcados na matriz, `pedido_falhou_na_criacao`, `pedido_cancelado`, `assinatura_desconhecida`, `contato_divergente` (fatura retida: pedido pago, conta não criada), `conta_email_em_uso` e `webhook_parado` (bruto `pendente` enfileirado há mais de 1 hora, uma vez por bruto).
- **Reprocessamento:** job em "falhou": `npm run reprocessar -- asaas_webhook-<brutoId>`. Job que já saiu do Redis (30 dias, ou alerta `webhook_parado`): zerar `enfileirado_em` do bruto pendente para o enfileirador criar o job de novo:

  ```sql
  UPDATE asaas_webhook_evento SET enfileirado_em = NULL, alertado_pendente_em = NULL
   WHERE id = '<brutoId>' AND situacao = 'pendente';
  ```

  Bruto `ignorado` ou `divergente` não é reprocessado pelo handler (resultado terminal); depois de corrigir a causa, volta à fila só por papel administrativo, com `situacao = 'pendente'`, `processado_em` e `codigo` nulos e `enfileirado_em` nulo.
- **Retenção:** limpeza após 90 dias em história própria (índice por `recebido_em` pronto).

## Como rodar os testes

Suíte `node:test` (nativa do Node.js) em `api/test/`, uma spec por critério de aceite. Nunca usa Playwright (isso é do site, na raiz).

```sh
npm run servicos:teste
npm test
```

`npm test` roda com `--import ./test/sem-rede.js`: uma guarda que bloqueia qualquer conexão a um host fora de `127.0.0.1`/`::1`/`localhost`. Nenhum teste depende de serviço externo; integrações futuras (Asaas, Skymail, RDAP) devem ser mockadas, nunca chamadas de verdade.

Sem Docker, um PostgreSQL 17 e um Redis 7 locais servem no lugar do `servicos:teste`: apontar `DATABASE_URL_TESTE` (padrão: `postgres://postgres@127.0.0.1:55433/postgres`) e `REDIS_URL_TESTE` (padrão: `redis://127.0.0.1:56379`) para eles. O host precisa ser loopback (`127.0.0.1`, `::1` ou `localhost`): a guarda sem-rede bloqueia qualquer outro. Os testes de fila usam o Redis real (o `ioredis-mock` não roda os scripts Lua do BullMQ), cada um com prefixo próprio (`teste-<pid>-<n>`), e conferem ao fim que não sobrou chave permanente no prefixo.

**O que a CI (Continuous Integration: verificação automática a cada mudança) roda** (job `api` de `.github/workflows/testes.yml`, em todo PR para `develop` e `main` e antes da publicação da homologação): um PostgreSQL 17 e um Redis 7 de serviço do GitHub Actions (`postgres:17-alpine`, sem senha, na porta `55433`; `redis:7-alpine` na porta `56379`), `DATABASE_URL_TESTE=postgres://postgres@127.0.0.1:55433/postgres`, `REDIS_URL_TESTE=redis://127.0.0.1:56379` e, a partir da raiz do repositório:

```sh
npm --prefix api ci && npm --prefix api run lint && npm --prefix api test
```

Para reproduzir localmente, subir antes o `banco-teste` e o `redis-teste` (`npm --prefix api run servicos:teste`), que usam as mesmas portas. Lint ou teste falhando bloqueia o merge do PR.

## Definition of Done

Definition of Done (DoD: lista do que precisa ser verdade antes de considerar uma rota ou mudança pronta). Vale para toda rota e mudança desta API:

1. **Todo endpoint declara `schema`** (tipos, tamanhos e limites; corpo com `additionalProperties: false`). Como cumprir: seguir o padrão de `src/saude/rotas.js` e `src/exemplo/rotas.js` — toda rota nova define `schema.body`/`schema.response` com limites explícitos (`minLength`, `maxLength`, `minimum`, `maximum` etc.). Rota `POST`/`PUT`/`PATCH` sem `schema.body` impede a API de subir.
2. **O banco só é acessado por consulta parametrizada** (`$1`, `$2`; nunca concatenar valor em SQL). Como cumprir: usar sempre `pool.query(texto, valores)`, como em `src/banco.js`; nunca montar SQL com template string a partir de entrada do usuário.
3. **Os testes automatizados rodam sem internet** (guarda `sem-rede`, serviços externos mockados). Como cumprir: manter `--import ./test/sem-rede.js` no script `test` e mockar qualquer serviço externo novo em vez de chamá-lo de verdade.
4. **As ações críticas chamam a auditoria** (E6-H7; lista no [ADR 0013](../docs/adr/0013-seguranca-transversal-e-observabilidade.md), item 7). Como cumprir: ao implementar uma ação da lista (login, falha de login, bloqueio, criação/exclusão de caixa, troca de senha, alteração cadastral, cancelamento etc.), chamar `registrarAuditoria` (seção [Auditoria](#auditoria)) antes de responder, com o `Client` da transação no sucesso e o pool na falha.
5. **Nenhum segredo, senha ou dado pessoal em log** (`redact` do [ADR 0013](../docs/adr/0013-seguranca-transversal-e-observabilidade.md); segredos só por variável de ambiente). Como cumprir: adicionar todo campo sensível novo, com o nome exato (o `redact` diferencia maiúsculas), à lista `camposSensiveis` de `src/log.js` (mascarada na raiz e em até 3 níveis de aninhamento; os campos `err.*` do `pg` já estão cobertos); não logar objeto com dado pessoal abaixo do 4º nível; logar o webhook do Asaas só por `resumoEventoAsaas`; e nunca logar `config.databaseUrl` nem outra variável de ambiente sensível.

## Próximos passos

Fora do escopo desta história (CIT-53), documentados aqui como referência:

- Sessão do painel, com cookie ([ADR 0008](../docs/adr/0008-sessao-do-painel-e-senhas.md)).
- Chamar a auditoria nas ações críticas reais (as histórias de cada ação); papel `<banco>_retencao` e rotina de pseudonimização do IP (ADR 0013, item 9).
- Webhook do Asaas (ADR 0015): configurar o webhook no sandbox e conferir as premissas (formato do `id`, `value` do 1º pagamento, status da matriz) na #57; limpeza do bruto após 90 dias; `cobranca_paga` para os pagamentos seguintes (E4-H5).
- Pedidos (ADR 0014): ligar `PEDIDOS_HABILITADO` em produção só depois do limite de taxa (E6-H4) e dos termos finais (fim da minuta); confirmar as premissas do Asaas no sandbox (#57); retomada de `criando` e reconciliação de assinatura órfã por job no worker.
- Deploy da API na VPS, com `systemd`, Caddy e HTTPS (#57 e #93); a #57 também troca o login da app para membro de `<banco>_aplicacao`.

## ADRs relacionados

- [0002 — Organização do código da API](../docs/adr/0002-organizacao-do-codigo-da-api.md)
- [0003 — Framework HTTP](../docs/adr/0003-framework-http.md)
- [0004 — PostgreSQL, acesso ao banco e migrações](../docs/adr/0004-banco-e-migracoes.md)
- [0005 — Fila de jobs e eventos de domínio](../docs/adr/0005-fila-e-eventos-de-dominio.md)
- [0006 — Execução na VPS, proxy reverso com HTTPS e backup](../docs/adr/0006-execucao-na-vps-proxy-e-backup.md)
- [0007 — Domínios, CORS e cookies por ambiente](../docs/adr/0007-dominios-cors-e-cookies-por-ambiente.md)
- [0011 — Canal de alerta da equipe](../docs/adr/0011-alertas-da-equipe.md)
- [0013 — Segurança transversal e observabilidade](../docs/adr/0013-seguranca-transversal-e-observabilidade.md)
- [0014 — Criação do pedido no Asaas](../docs/adr/0014-criacao-do-pedido-no-asaas.md)
- [0015 — Webhook do Asaas](../docs/adr/0015-webhook-do-asaas.md)
