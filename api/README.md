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
    app.js             fábrica construirApp(config, { pool, logStream, filas, asaas, pedidos, painel }): Fastify, CORS (com credenciais só em /api/painel/*), cookie, log, validação e erros
    log.js             log técnico: lista de campos mascarados, serializers, LogCitmail (linha única por requisição) e criarLogger (worker)
    erros.js           tratamento padronizado de erro (400 por campo, 404, 500) e ErroDeDominio
    servidor.js        ponto de entrada da API: carrega a config, sobe o Fastify, encerra em SIGTERM/SIGINT
    worker.js          ponto de entrada do worker da fila (npm run worker): pool do banco, publicador do outbox, enfileirador e handler do webhook do Asaas (com WEBHOOK_ASAAS_HABILITADO), enfileirador e handler do e-mail transacional, consumidor do primeiro acesso e job do "esqueci a senha" (com PAINEL_HABILITADO) e workers, sem CORS; encerra em SIGTERM/SIGINT esperando os ciclos do publicador e dos enfileiradores, o job ativo e os alertas em curso
    saude/rotas.js      GET /api/health
    precos/             POST /api/orcamento (público, sem banco): tabela.js (tabela do servidor, limites e tetoAddon; paridade com assets/precos.js), servico.js (validarLimites e calcularOrcamento), rotas.js (schemas gerados da tabela); o corpo aceita `dominio: { tipo: 'novo' | 'existente' }` (opcional) e, com `novo`, `avulsos` traz o item `dominio_principal` (1 por ano, mesmo preço do domínio extra)
    exemplo/rotas.js    POST /api/exemplos e POST /api/exemplos/job (só fora de produção; padrão de schema, erro e de rota que só enfileira)
    jobs/executar.js    executarJob: log correlacionado de job (job iniciado/concluído/falhou)
    jobs/exemplo.js     job de exemplo
    fila/conexao.js     conexões com o Redis: de worker (espera o Redis voltar) e de produtor (falha rápido)
    fila/filas.js       filas jobs e alertas (tentativas, backoff exponencial, retenção)
    fila/worker.js      workers: roda os handlers, alerta de job esgotado, envio de alertas com limite por minuto
    alertas/telegram.js envio do alerta ao Telegram (job esgotado, webhook do Asaas e e-mail parado; só ids e códigos, token fora de log e erro)
    cli/reprocessar.js  npm run reprocessar -- <jobId>: devolve um job falhado à fila
    asaas/resumo.js     resumoEventoAsaas: o que do webhook do Asaas pode ir para o log
    asaas/cliente.js    criarClienteAsaas: adaptador HTTP da API v3 do Asaas (cliente, assinaturas, URL da 1ª fatura, remoção, buscarPagamento), ErroAsaas e centavosParaReais
    asaas/webhook-rotas.js POST /api/asaas/webhook (ADR 0015): token, schema, lista branca (extrairCamposBrutos) e gravação do bruto
    asaas/webhook-processamento.js enfileirador (iniciarEnfileiradorWebhook) e handler do job asaas_webhook (criarHandlerWebhook): conferência, matriz de status, pedido, conta do titular e eventos
    asaas/webhook-repositorio.js acesso a asaas_webhook_evento e às leituras de pedido e assinatura do processamento
    email/              e-mail transacional (ADR 0010; sem rota): servico.js (solicitarEmail, handler do job email_enviar, ErroEmail e classificação do erro SMTP), enfileirador.js (iniciarEnfileiradorEmail e alerta email_parado), transporte.js (nodemailer ou desligado), html.js (tagged templates html e texto, limparLinha), mascara.js (mascararEmail), repositorio.js (email_envio), modelos/ (registro e modelos; teste_exemplo só fora de produção)
    contas/repositorio.js conta_titular: inserirContaSeNova, buscarContaPorClienteOuEmail, buscarContaParaLogin e buscarContaPorId
    painel/             login do painel (ADR 0008; CIT-70): rotas.js (POST /api/painel/login, POST /api/painel/logout, GET /api/painel/sessao, exigirSessao), rotas-senha.js (POST /api/painel/senha/esqueci, /validar e /definir; CIT-71), sessoes.js (sessão no Redis, prazos de 30 min e 8 h, encerrarTodas), senha.js (Argon2id e hash falso)
    senhas/             senha do titular por link (ADR 0008; CIT-71): servico.js (criarSolicitacao, emitirToken, validarToken, definirSenha, prazos e política), repositorio.js (solicitacao_senha e senha da conta), consumidor-primeiro-acesso.js (senha_primeiro_acesso), job-esqueci.js (job senha_esqueci e alerta da última tentativa)
    pedidos/            POST /api/pedidos (ADR 0014) e POST /api/pedidos/status (ADR 0016): rotas.js (schema a partir do orçamento; consulta do status em lista branca), servico.js (fluxo de criação, idempotência, retomada e compensação), repositorio.js, token.js (token de acompanhamento e hash), documento.js (CPF e CNPJ, inclusive alfanumérico), dominio.js (mesmas regras de assets/checkout.js)
    eventos/            eventos de domínio pelo outbox (sem rota): servico.js (registrarEvento), publicador.js (publicarPendentes, iniciarPublicador), consumidores.js (registro, consumidoresDoAmbiente, processarEvento, criarHandlersDeConsumidores), repositorio.js, vocabulario.js (12 nomes)
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
| `npm run dominio -- <subcomando>` | Tarefas manuais de registro e renovação de domínio novo (CIT-77): `listar`, `mostrar`, `registrado`, `renovado` (ver "Tarefas de domínio"). Lê `api/.env` se existir; só `DATABASE_URL`, `NODE_ENV` e `LOG_LEVEL`. Sai 0 ok, 1 uso, entrada inválida, tarefa inexistente ou falha (nada gravado) e 2 estado que não permite (tarefa concluída, pedido cancelado, tipo de tarefa diferente). |
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
| `REDIS_URL` | opcional | obrigatória | obrigatória | Conexão com o Redis da fila. Sem ela, a API sobe sem fila, sem `POST /api/exemplos/job` e com o login e a sessão do painel em 503. A API ainda não usa o Redis em produção: o painel, único uso lá, fica recusado até o limitador de tentativas (CIT-78); o webhook do Asaas só grava no banco, e quem enfileira é o worker (CIT-64). Nunca vai para o log. | sem padrão |
| `FILA_PREFIXO` | lida | lida | lida | Prefixo das chaves no Redis; separa ambientes no mesmo Redis (ADR 0006). Só letras minúsculas, dígitos e hífen. | `citmail` |
| `FILA_TENTATIVAS` | lida | lida | lida | Tentativas por job (inteiro de 1 a 20). | `8` |
| `FILA_BACKOFF_MS` | lida | lida | lida | Espera antes da 2ª tentativa, em ms (inteiro de 1 a 3600000); dobra a cada tentativa (exponencial: com os padrões, cerca de 2 h até esgotar). | `60000` |
| `DATABASE_URL` | obrigatória | obrigatória | não lê | String de conexão do PostgreSQL (tabela acima). No worker, conferida depois de `REDIS_URL`. | sem padrão |
| `OUTBOX_INTERVALO_MS` | não lê | lida | não lê | Intervalo entre ciclos do publicador do outbox, em ms (inteiro de 100 a 60000), contado do fim de um ciclo ao início do próximo. | `2000` |
| `DOMINIO_TAREFAS_INTERVALO_MS` | não lê | lida | não lê | Intervalo entre ciclos do laço das tarefas de domínio (aviso, lembrete e renovação D-30; CIT-77), em ms (inteiro de 60000 a 3600000). | `300000` |
| `TELEGRAM_BOT_TOKEN` | não lê | obrigatória em produção | não lê | Token do bot do alerta. Segredo: só no ambiente do worker. | sem padrão |
| `TELEGRAM_CHAT_ID` | não lê | obrigatória em produção | não lê | Id do grupo que recebe os alertas. Segredo: só no ambiente do worker. | sem padrão |

Fora de produção, sem as duas variáveis do Telegram, o alerta sai só no log (`alerta sem telegram`).

Pedido no Asaas ([ADR 0014](../docs/adr/0014-criacao-do-pedido-no-asaas.md)). Só a API lê (o worker lê `ASAAS_*` com o webhook ligado, tabela seguinte); nenhuma das cinco vai para o log.

| Variável | Uso | Padrão |
|---|---|---|
| `PEDIDOS_HABILITADO` | `true` ou `false` (outro valor impede a subida). Desligada, `POST /api/pedidos` e `POST /api/pedidos/status` não são registradas (404). **Só ligar em produção depois do limite de taxa da rota (E6-H4)** (ADR 0014). Ligada em produção com os termos em minuta ou a Política provisória (`TERMOS_MINUTA` ou `PRIVACIDADE_PROVISORIA` em `src/pedidos/aceite.js`), a API não sobe, salvo com `TERMOS_MINUTA_ACEITA`. | `false` em produção; `true` fora dela |
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

Login do painel ([ADR 0008](../docs/adr/0008-sessao-do-painel-e-senhas.md); CIT-70). Só a API lê, exceto `PAINEL_HABILITADO`, que o worker também lê (CIT-71).

| Variável | Uso | Padrão |
|---|---|---|
| `PAINEL_HABILITADO` | `true` ou `false` (outro valor impede a subida). Desligada, `/api/painel/login`, `/api/painel/logout`, `/api/painel/sessao` e `/api/painel/senha/*` não são registradas (404) e o worker não registra o consumidor `senha_primeiro_acesso` nem o job `senha_esqueci`. **Ligada em produção, a API não sobe** (`PAINEL_HABILITADO recusada em produção`) enquanto não houver limitador de tentativas no login (CIT-78, ADR 0013): cada tentativa usa 19 MiB de memória no Argon2id. Fora de produção, sem `REDIS_URL`, login e sessão respondem 503 `sessao_indisponivel` (o logout, 204). | `false` em produção; `true` fora dela |
| `PAINEL_ORIGENS` | Origens do painel, separadas por vírgula, com a mesma regra de `CORS_ORIGENS` e contidas nela. Só elas recebem `access-control-allow-credentials` em `/api/painel/*` e são aceitas no `Origin` do login, do logout e das rotas de senha (senão 403 `origem_recusada`). | vazia (login e logout sempre 403) |

As chaves da sessão usam o prefixo `FILA_PREFIXO` (`<prefixo>:sessao:<sha256 do id>` e `<prefixo>:sessoes:conta:<contaId>`).

## Painel

- `POST /api/painel/login` `{ email, senha }` (corpo fechado; `email` 3..254, `senha` 1..1024): 204 com `Set-Cookie: __Host-citmail_sessao=<id>; Path=/; HttpOnly; Secure; SameSite=Lax` (sem `Domain`, `Max-Age` nem `Expires`); 401 `credenciais_invalidas` para e-mail inexistente, senha errada, conta `sem_senha`, `suspensa` ou `cancelada` e falha ao gravar a sessão (sempre uma verificação Argon2id, com hash falso quando não há conta ativa); 400 do schema; 403 `origem_recusada`; 503 `sessao_indisponivel`. Login com cookie anterior apaga a sessão anterior. A limpeza dos membros vencidos do conjunto da conta é manutenção: a falha vai ao log (`warn`) e não derruba o login. Audita `login` e `login_falhou` (sem e-mail).
- `POST /api/painel/logout` `{}`: sempre 204 com o cookie expirado (`Max-Age=0`), com ou sem sessão, com o Redis fora ou sem `REDIS_URL` (a falha da remoção vai só para o log); 403 sem `Origin` do painel.
- `GET /api/painel/sessao` (sem exigência de `Origin`): 200 `{ email }` e renova a sessão (só `SET XX`: um logout concorrente não é desfeito); 401 `sem_sessao` sem cookie, sessão vencida (30 min sem uso ou 8 h desde o login, conferidos também na leitura) ou conta que deixou de ser `ativa` (a sessão é apagada); 503 com o Redis ou o banco fora.
- `GET /api/painel/sessao` também recusa (401, sessão apagada) a sessão sem `senhaEm` (anterior à CIT-71) ou com `senhaEm` diferente da `senha_definida_em` atual da conta (`exigirSessao`, reutilizável pelas rotas autenticadas).
- Senha por link (CIT-71). As três exigem `Origin` de `PAINEL_ORIGENS` (403 `origem_recusada`, antes do corpo, do Redis e do banco) e respondem 503 `sessao_indisponivel` com o Redis fora, antes do banco e do hash:
  - `POST /api/painel/senha/esqueci` `{ email }` (3..254): enfileira o job `senha_esqueci` (`{ email, requestId }`, removido ao terminar e ao falhar) e responde 202 sem corpo, igual para qualquer e-mail; falha ao enfileirar em 2 s → 503. O job cria a solicitação (`redefinicao`, 1 h, ou `primeiro_acesso`, 72 h, conforme a conta tenha senha) para conta não `cancelada`, no máximo uma a cada 5 min e 5 abertas por conta; na última tentativa falha, alerta só com o `jobId`.
  - `POST /api/painel/senha/validar` `{ token }` (43 base64url): 200 `{ tipo }` (`primeiro_acesso` ou `redefinicao`) ou 410 `link_invalido`. Sem efeito colateral.
  - `POST /api/painel/senha/definir` `{ token, senha }` (`senha` 1..1024 no schema): 204; 400 `senha_fora_da_politica` (fora de 12 a 128 code points ou igual ao e-mail, sem consumir o token); 410 `link_invalido` (vencido, usado, desconhecido ou conta `cancelada`); 503 também com falha da auditoria. Consome o token, grava o hash, `sem_senha` vira `ativa`, invalida as outras abertas da conta e audita `senha_trocada` (`detalhes: { tipo }`) na mesma transação; depois apaga todas as sessões da conta.
  - O token do link só existe no envio (`emitirToken`, da #72); o banco guarda o SHA-256.
- Toda resposta de `/api/painel/*` leva `Cache-Control: no-store`. Ordem no login: `Origin` (403) → Redis pronto (503) → conta → Argon2id → sessão.

## Logs

JSON do `pino` na saída padrão (ADR 0013, item 8; código em `src/log.js`). Linhas:

- `request completed` (nível `info`, uma por requisição, também em 4xx/5xx): `reqId` (igual ao header `x-request-id` da resposta), `req.method`, `req.rota` (template, ex.: `/api/exemplos/:id`), `req.remoteAddress` (IP), `res.statusCode` e `responseTime` (ms). Sem URL concreta (nem query nem valor de parâmetro), sem headers e sem corpo. No 404, `req.rota` é `null` e `req.caminho` traz o path sem query (até 200 caracteres). Não há `incoming request` nem `Route ... not found`.
- `request aborted`: o cliente desistiu antes da resposta (`reqId`, `req.rota`).
- `GET /api/health` loga só a partir de `warn` (o monitoramento chama a cada minuto); a falha sai como `banco indisponível no health`, com `reqId`.
- Jobs: `executarJob({ nome, correlacaoId, log }, fn)` de `src/jobs/executar.js` registra `job iniciado`, `job concluído` (com `duracaoMs`) ou `job falhou` (`error`, com o erro original; relança à fila um erro saneado, só com `<name>` ou `<name> (<code>)` na mensagem, porque a fila guarda a mensagem no Redis), todas com `job` e `reqId` = `correlacaoId` (sem ele, um UUID novo). Passar em `log` o logger raiz (`app.log` ou o do worker), nunca `request.log`, que já tem `reqId` (a chave sairia repetida); dentro do job, logar só pelo `log` recebido em `fn`. Os dados do job não são logados. Exemplo: `POST /api/exemplos/job` (`{ "falhar": true }` simula a falha) só enfileira e responde 202 com `{ jobId }` (503 `{ "erro": "fila indisponível" }` com o Redis fora); o worker roda o job com `reqId` igual ao `x-request-id` da resposta.
- Fila (worker, mesma máscara do app por `criarLogger`): as linhas de job acima, agora pelo worker; `job desconhecido` (`error`, `jobId`: nome sem handler; vai a "falhou" sem novas tentativas); `alerta não enfileirado` (`error`, `jobId`: o job esgotou mas o alerta não entrou na fila); `alerta falhou` (`error`, `jobId`: o envio ao Telegram esgotou as tentativas); `envio ao telegram falhou` (`warn`, só `erro` com o nome do erro ou `status`, nunca a URL, que leva o token); `alerta sem telegram` (`warn`, `jobId`, `job`, `pedido`: fora de produção sem Telegram); `erro no worker` e `erro na fila` (`error`, só `erro` com o nome do erro e `fila`: a mensagem do Redis traz host e porta). Na API, `fila indisponível` (`warn`, `reqId`, só o nome do erro) quando o Redis não aceita o job em 2 s; a rota responde 503.
- Webhook do Asaas: logar só `resumoEventoAsaas(evento)` de `src/asaas/resumo.js` (`event`, `paymentId`, `paymentStatus`, `billingType`); nunca `request.body`, o `payment`/`customer` inteiro nem o header `asaas-access-token`.

**Máscara** (`redact`, censor `[mascarado]`): os 54 nomes de `camposSensiveis` em `src/log.js` (dados pessoais do pedido e do cliente do Asaas, credenciais, `creditCard` e `creditCardToken`, IP do aceite e, do e-mail transacional, `to`, `from`, `replyTo`, `destinatario`, `variaveis`, `html`, `text`, `subject` e `assunto`, e a senha do SMTP, `pass` e `smtpSenha`) na raiz e em até 3 níveis de aninhamento (`x`, `a.x`, `a.b.x`, `a.b.c.x`), além dos campos `err.*` e `err.cause.*` do `pg` (`detail`, `where`, `parameters`, `hint`, `internalQuery`, `query`). Limites: o 5º nível não é mascarado; o nome precisa ser exato (`CPF` não casa com `cpf`); homônimos técnicos, se existirem, também são mascarados (ex.: um `name` próprio de erro, `numero` técnico; usar nomes distintos como `numeroPedido`); dado pessoal dentro de `err.message` e `err.stack` não é mascarado (o `pg` pode repetir o valor enviado; logar `code` e `routine`, não a mensagem do driver). Ficam em claro, de propósito, `uf`, `estado` e `state`. Ficam fora, para a #64 revisar, os textos livres do Asaas `description`, `observations`, `groupName` e `externalReference`.

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
- **A garantia é por chave, não por valor.** Em `detalhes`, chave proibida é **recusada** (não mascarada), em qualquer nível, inclusive dentro de array: as 54 chaves de `camposSensiveis` do log mais `ip` e variações de IP como `ip_origem`, `ipcliente`, `remote_addr` e `x-forwarded-for` (`CHAVES_PROIBIDAS`, igualdade sem diferenciar maiúsculas; inclui dado pessoal como `nome`, `email` e `numero`; IP fora da coluna escaparia da pseudonimização) e qualquer chave que contenha `senha`, `password`, `token`, `secret`, `authorization`, `cookie`, `apikey`, `api_key`, `email`, `cpf`, `cnpj` ou `telefone` (`TRECHOS_PROIBIDOS`: pega `novaSenha`, `refresh_token`, `x-api-key`, `email_contato`). O erro é `auditoria: chave proibida em detalhes: <chave>`, com a chave cortada em 64 caracteres. **Valores livres não são inspecionados**: senha ou dado pessoal sob uma chave permitida passa. Quem chama escolhe chaves distintas (ex.: `plano_nome`, não `nome`). Um teste confere que toda chave de `camposSensiveis` é recusada; quando a lista do log crescer, ele falha na CI e a chave entra também no vocabulário da auditoria.

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

Respostas: 201 `{ pedidoId, estado: 'aguardando_pagamento', faturas: [{ tipo: 'contas' | 'dominios', url }], aviso?, token }` (`token`: ver "Status do pedido") (`url` pode ser `null`; com `aviso: 'fatura_pendente'`, todas as `url` são `null`: ver abaixo); 400 validação; 404 com a rota desligada; 409 `versao_termos_divergente` (com as versões vigentes `versao_termos` e `versao_privacidade`; conferido antes do total), `total_divergente` (com `total_centavos` e `versao_tabela`) ou `pedido_em_criacao`; 422 `chave_reutilizada`; 500 `interno`; 502/504 `asaas_indisponivel` com `mensagem`; 503 `asaas_nao_configurado` (fora de produção).

- O pedido é gravado em `criando` (com `criando_desde`, a posse do fluxo) **antes** de qualquer chamada ao Asaas; nenhuma transação fica aberta durante uma chamada.
- Aceite (ADR 0014, decisão 11): gravado no mesmo `INSERT` (`aceite_em`, `versao_termos`, `versao_privacidade`, `ip_aceite` de `request.ip`, sem zona e com `::ffff:` convertido para IPv4). IP inválido responde 500 `interno` sem gravar (log `warn` `ip inválido`, sem o valor). O bloco `aceite` entra no `corpo_hash`; o IP não: o reenvio de outro IP devolve a resposta gravada sem mudar `ip_aceite`.
- Checklist da 1.0 dos termos (ADR 0014, decisão 12): no mesmo PR, trocar `TERMOS_MINUTA` e `VERSAO_TERMOS`, `PRIVACIDADE_PROVISORIA` e `VERSAO_PRIVACIDADE` (`src/pedidos/aceite.js`) e a página `termos.html`. O IP do aceite também fica no log de acesso (`req.remoteAddress` do `request completed`, ADR 0013), com a retenção de 30 dias. Pendência: a prova guarda as versões, sem hash do texto aceito.
- Antes de aplicar a migração `pedido-aceite` num banco com pedidos (desenvolvimento, homologação), limpe os pedidos de teste à mão (`assinatura`, `pedido_dominio`, `pedido` e, se quiser, `cliente`): com qualquer linha em `pedido`, a migração é recusada (`P0001`, `pedido sem aceite: ...`) e não apaga nada. O `down` também é recusado com pedidos.
- Antes de cada criação e antes de declarar falha, a API consulta o Asaas pelo documento (cliente) ou pelo `externalReference` `pedido:<id>:<tipo>` (assinatura) e reaproveita o que achar. A consulta de confirmação (depois de erro no `POST`) tem timeout próprio, fora do prazo global. Mais de uma assinatura ativa com a mesma referência: fica a mais antiga e as demais são removidas (log `warn` `assinatura duplicada`, só ids).
- Fatura retida (ADR 0014, decisão 10): nome normalizado ou e-mail do pedido diferente do cadastro do documento (tabela `cliente` e, se achado ou criado agora, o `GET /customers`) → o pedido segue normal, mas a URL da fatura não é buscada nem gravada, `pedido.fatura_retida = true` e o 201 traz `url: null` e `aviso: 'fatura_pendente'`, sem dado do cadastro. Log `fatura retida` com `codigo: 'contato_divergente'`. `cliente.asaas_contato_confere`, gravado com o `asaas_cliente_id`, diz se o cadastro do Asaas bate com a linha; falso retém a fatura de todo pedido do documento.
- A mesma chave com o mesmo corpo devolve a resposta gravada (201 ou a mesma falha); com outro corpo, 422. Pedido em `criando` responde 409 até o prazo de retomada (105 s com o padrão) e depois é retomado pela mesma chave. A retomada não impede de todo a duplicata (um `POST` em voo do fluxo anterior pode ser efetivado depois dela): a próxima consulta remove a sobra, e o fechamento definitivo fica para a reconciliação por job (ADR 0014).
- Falha do Asaas depois de criar uma assinatura: `DELETE` de todas as assinaturas ativas achadas pelo `externalReference` de cada tipo do pedido, mais as já obtidas (compensação, com timeout próprio fora do prazo global) e `falhou_na_criacao` com `falha_motivo` em código. `DELETE` que falha sai no log `error` `assinatura órfã` (só `pedidoId` e `asaasAssinaturaId`).
- Logs só com ids e códigos: `pedido criado`, `pedido retomado`, `pedido falhou na criação` (`pedidoId`, `falhaMotivo`, `operacao`, `statusAsaas`), `fatura sem url`, `posse perdida`, `assinatura órfã`, `assinatura duplicada`, `confirmação falhou` e `compensação sem consulta` (`operacao`, `tipo` do erro e `erro` com o nome do erro) e `erro de banco no pedido` (`code` e `routine`).
### Status do pedido

`POST /api/pedidos/status` ([ADR 0016](../docs/adr/0016-status-do-pedido-por-token.md); CIT-69), com a mesma flag `PEDIDOS_HABILITADO`. Corpo fechado `{ token }` (string de até 128 caracteres; sem `token` ou de outro tipo, 400). O token vai só no corpo, nunca na URL (o log de acesso grava a URL; o corpo não é logado).

- **Token:** todo 201 de `POST /api/pedidos` traz um `token` novo (32 bytes aleatórios em base64url, 43 caracteres); o banco guarda só `pedido.token_hash` (SHA-256 em hex, migração `pedido-token`). Na criação e na retomada, o hash é gravado na transação final guardada pela posse; no reenvio pela mesma chave, um único `UPDATE ... RETURNING` grava o hash novo e o token anterior deixa de valer (rotação). Nenhuma resposta de erro traz `token`. Pedidos anteriores à migração ficam sem token.
- **Respostas:** 200 `{ etapa, dominioNovo, faturaContasUrl?, faturaDominioUrl? }`, com `etapa` em `aguardando_confirmacao`, `dominio_pendente`, `registro_dominio`, `ativando`, `ativo`, `erro_criacao`, `cancelado` ou `em_analise` (nunca o estado cru); 404 `{ erro: 'nao_encontrado' }`, idêntico para token fora do padrão, inexistente ou de pedido sem token. 200 e 404 com `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.
- **URLs da fatura:** `faturaContasUrl` só em `aguardando_confirmacao`; `faturaDominioUrl` em `dominio_pendente` e em `aguardando_confirmacao` com domínio novo ainda não pago. Cada uma só com `fatura_retida` falso e `https:` com host exatamente `www.asaas.com` ou `sandbox.asaas.com`, sem porta nem credenciais (`urlFaturaSegura`); senão a chave é omitida. Nunca `pedidoId`, nome, e-mail, domínio, valores nem datas.
- A rota só usa o pool: responde também sem adaptador do Asaas (sem o 503 `asaas_nao_configurado`). O CORS guarda o preflight por 10 minutos (`maxAge: 600`), porque a página consulta em polling.

- Nos testes, `construirApp(config, { asaas, pedidos })` recebe o adaptador (stub local) e as opções do serviço (`agora`, `versaoTabela`, `versaoTermos`, `versaoPrivacidade`, `prazoPedidoMs`, `prazoCriandoMs`) e usa o IP de `request.ip` (`app.inject({ remoteAddress })`); `construirAppTeste` repassa as duas. `carregarConfig(env, { termosMinuta })` aceita a minuta injetada.

E-mail transacional ([ADR 0010](../docs/adr/0010-email-transacional.md); CIT-65). Só o worker lê; nenhuma vai para o log.

| Variável | Uso | Padrão |
|---|---|---|
| `EMAIL_TRANSPORTE` | `desligado` ou `smtp` (outro valor impede a subida). Desligado, o job grava `nao_enviado` sem abrir conexão nem alertar; em produção, a partida loga `warn` `e-mail desligado em produção`. **Fica `desligado` até haver credencial SMTP e SPF/DKIM/DMARC (#57).** | `desligado` |
| `SMTP_HOST` | Host do SMTP (Skymail). Obrigatória com `smtp`; em produção, host de loopback ou não especificado (`localhost`, `127.x`, `127.1`, `0`, `::1`, `::`, `::ffff:127.0.0.1`) é recusado. | sem padrão |
| `SMTP_PORTA` | Porta do SMTP (inteiro de 1 a 65535). `465` usa TLS direto; as demais, STARTTLS, exigido (`requireTLS`) em todo host fora do loopback. | `587` |
| `SMTP_USUARIO` | Usuário do SMTP. Obrigatória com `smtp`. | sem padrão |
| `SMTP_SENHA` | Senha do SMTP. Obrigatória com `smtp`. Segredo: só no ambiente do worker. | sem padrão |
| `SMTP_TIMEOUT_MS` | Limite de conexão, saudação e inatividade do socket, em ms (inteiro de 1000 a 60000). | `10000` |
| `EMAIL_REMETENTE` | Remetente (`From` e `MAIL FROM`), ex.: `CITMail <naoresponda@citmail.com.br>`. Sem quebra de linha nem caractere de controle. | `CITMail <naoresponda@citmail.com.br>` |
| `EMAIL_RESPONDER_PARA` | Endereço do `Reply-To`. Vazio: sem `Reply-To`. Mesma validação do remetente. | vazio |
| `EMAIL_PARADO_HORAS` | Horas até uma linha `pendente` gerar o alerta `email_parado` (inteiro de 1 a 72); acima das ~2 h do backoff completo. | `6` |

## E-mail transacional

Envio por fila em duas etapas ([ADR 0010](../docs/adr/0010-email-transacional.md), adendo; código em `src/email/`, tabela `email_envio` da migração `email-envio`).

- **Pedido de envio (consumidor):** no `tratar` de um consumidor de evento, `await solicitarEmail(cliente, { eventoId: evento.id, chaveIdempotencia: '<modelo>-<eventoId>[-<contaId>]', modelo: '<nome>', refs: { pedidoId } })`, com o `cliente` da transação. Grava a linha `pendente` (a mesma chave repetida não grava de novo) com a versão do modelo. `refs` só com ids; modelo fora do registro, chave fora de `^[A-Za-z0-9_-]{1,200}$` ou `refs` com chave sensível ou valor que não é id lançam `TypeError`.
- **Modelos** (`src/email/modelos/<nome>.js`, registrados em `modelosPadrao` de `modelos/index.js`): `{ versao, carregar(cliente, refs), assunto(v), html(v), texto(v) }`. `carregar` lê do banco, no envio, `{ destinatario, variaveis }` ou devolve `null` (sem destinatário, ou destinatário que não é um único endereço `local@dominio`: `nao_enviado`, `SEM_DESTINATARIO`). O envelope SMTP leva só esse endereço. `html` usa o tagged template `html` (escape automático; só outro `html` entra cru; outro tipo de retorno faz o job falhar com `modelo sem escape`) e `texto`, o tagged template `texto` (valores sem quebra de linha); o assunto passa por `limparLinha`. Mudou o conteúdo, sobe a `versao`. O `teste_exemplo` (`refs: { pedidoId }`, contato do pedido) só existe fora de produção.
- **Compra confirmada (CIT-66):** o consumidor `email_compra_confirmada` (`src/email/consumidor-compra-confirmada.js`) consome `pedido_pago` e pede o modelo `compra_confirmada` (`chaveIdempotencia = compra_confirmada-<pedidoId>`, `refs: { pedidoId }`); evento com `agregado_tipo` diferente de `pedido`, `agregado_id` que não é UUID ou `payload.pedidoId` divergente vai a "falhou" sem novas tentativas. O e-mail vai ao `contato_email` do pedido, com itens (um por linha no texto), ciclo, valor das contas e add-ons (`assinatura.valor_centavos`) e dos domínios, e o prazo de ativação da landing (em até 5 minutos; com domínio novo, o aviso de registro manual pela equipe). No envio, pedido com `fatura_retida` (ADR 0014), `cancelado`, ainda não pago (`criando`, `aguardando_pagamento`, `falhou_na_criacao`) ou inexistente fica `nao_enviado`/`SEM_DESTINATARIO`, com o motivo em código no log (`motivo`: `fatura_retida`, `cancelado`, `nao_pago`, `inexistente`); `contato_email` que não é um único endereço também. Linha retida por `fatura_retida`: a equipe resolve o contato divergente e desmarca `fatura_retida` do pedido antes de reenviar a linha pelo SQL de reenvio abaixo (senão o reenvio volta a `nao_enviado`). Para o motivo, o handler passa a `carregar(cliente, refs, { log })` o `log` do job com `envioId`. Pedido sem item com rótulo conhecido sai sem o bloco de itens, com `aviso: itens_sem_rotulo` no log.
- **Envio (worker):** a cada `OUTBOX_INTERVALO_MS`, até 50 linhas `pendente` com `enfileirado_em` nulo viram jobs `email_enviar` (`jobId = email_enviar-<envioId>-<geracao>`, `data = { envioId, geracao }`). O job envia e grava `enviado`, `enviado_em`, `message_id` e o destinatário mascarado (`a***@exemplo.com.br`). Entrega "ao menos uma vez": um crash entre o aceite do SMTP e o registro reenvia.
- **Falha:** 4xx, rede, timeout e autenticação gravam `tentativas` e `erro_codigo` e tentam de novo pela fila; na última, `falhou`, e o alerta `job_esgotado`. 5xx em `RCPT`/`DATA` grava `falhou` na hora, sem novas tentativas, com alerta. O log e a fila levam só `envioId`, `modelo`, `estado` e `erro_codigo` (código SMTP ou do `nodemailer`), nunca endereço, assunto ou corpo.
- **Parado:** linha `pendente` enfileirada há mais de `EMAIL_PARADO_HORAS`, ou criada há mais que isso e nunca enfileirada, gera um alerta `email_parado` (`{ tipo: 'email_parado', envioId }`), uma vez por geração.
- **Reenvio de `falhou` ou `nao_enviado`** (pela equipe, depois de corrigir a causa; cria a geração seguinte e o enfileirador cria o job novo):

  ```sql
  UPDATE email_envio
     SET estado = 'pendente', geracao = geracao + 1, enfileirado_em = NULL, tentativas = 0,
         erro_codigo = NULL, alertado_parado_em = NULL
   WHERE id = '<envioId>' AND estado IN ('falhou', 'nao_enviado');
  ```

  Linha `enviado` não muda (0 linhas).

  **Linha `pendente` parada** (alerta `email_parado`; job perdido no Redis ou retido em "falhou" depois de 30 dias): a geração seguinte cria um job novo, e o job antigo, se ainda existir, conclui sem enviar:

  ```sql
  UPDATE email_envio
     SET geracao = geracao + 1, enfileirado_em = NULL, tentativas = 0, alertado_parado_em = NULL
   WHERE id = '<envioId>' AND estado = 'pendente';
  ```

  Antes, conferir que o job da geração atual não está ativo nem aguardando (senão o e-mail pode sair duas vezes). `npm run reprocessar -- email_enviar-<envioId>-<geracao>` só para job em "falhou" cuja linha ainda esteja `pendente` (falha antes de gravar o estado, ex.: banco fora); depois do reset acima, o job antigo não envia (geração diferente).
- **Conferência com o transporte desligado:** `SELECT count(*) FROM email_envio WHERE estado = 'nao_enviado' AND erro_codigo IS NULL;` conta os e-mails não enviados por `EMAIL_TRANSPORTE=desligado`.
- **Retenção:** limpeza após 90 dias em história própria (índice por `criado_em` pronto). SPF, DKIM e DMARC do remetente: pendência da #57.

## Webhook do Asaas

`POST /api/asaas/webhook` ([ADR 0015](../docs/adr/0015-webhook-do-asaas.md); código em `src/asaas/webhook-*.js`, tabelas `asaas_webhook_evento` e `conta_titular` e coluna `pedido.dominio_pago_em` da migração `webhook-asaas`).

- **Recepção (API):** cabeçalho `asaas-access-token` conferido no `onRequest`, antes do corpo e do banco (SHA-256 e `timingSafeEqual`): ausente, vazio ou errado → 401 `{ erro: 'nao_autorizado' }`. Corpo até 16 KiB (413 acima); `id` em `^evt_[A-Za-z0-9_&.-]{1,120}$`, `event` e `payment.id` obrigatórios no formato (400 `validacao`). Grava o bruto só com a lista branca (`INSERT ... ON CONFLICT DO NOTHING`) e responde 200 `{ recebido: true }`, também ao repetido. Log `webhook do asaas recebido` só com `resumoEventoAsaas`, `brutoId` e `repetido`.
- **Enfileirador (worker):** a cada `OUTBOX_INTERVALO_MS`, até 50 brutos com `enfileirado_em` nulo viram jobs `asaas_webhook` (`jobId = asaas_webhook-<brutoId>`, `data = { brutoId, requestId }`) num `addBulk` com prazo de 2 s; depois `enfileirado_em` é marcado. Com o Redis fora, fica para o ciclo seguinte (log `enfileiramento do webhook falhou`).
- **Handler:** confere o pagamento no Asaas e aplica a matriz do ADR 0015. Resultado no bruto: `situacao` (`processado`, `ignorado`, `divergente`) e `codigo`. Erro de rede, 5xx, timeout ou pedido ainda em `criando`: o job tenta de novo com backoff e, esgotado, gera o alerta `job_esgotado`; o bruto continua `pendente`.
- **Alertas** (fila `alertas`, payload `{ tipo: 'webhook', codigo, brutoId, pedidoId }`): divergências da conferência, status sem efeito marcados na matriz, `pedido_falhou_na_criacao`, `pedido_cancelado`, `assinatura_desconhecida`, `contato_divergente` (fatura retida: pedido pago, conta não criada), `conta_email_em_uso` e `webhook_parado` (bruto `pendente` enfileirado há mais de 1 hora, ou recebido há mais de 1 hora e nunca enfileirado; uma vez por bruto). Pedido relido como `cancelado` ou `falhou_na_criacao` depois da trava: `ignorado` `pedido_<estado>` com alerta. O 2º evento do mesmo pagamento (`CONFIRMED` e depois `RECEIVED`) fica `ignorado` `pagamento_repetido`; outro pagamento depois do 1º, `pagamento_seguinte`.
- **Reprocessamento:** job em "falhou": `npm run reprocessar -- asaas_webhook-<brutoId>`. Job que já saiu do Redis (30 dias, ou alerta `webhook_parado`): zerar `enfileirado_em` do bruto pendente para o enfileirador criar o job de novo:

  ```sql
  UPDATE asaas_webhook_evento SET enfileirado_em = NULL, alertado_pendente_em = NULL
   WHERE id = '<brutoId>' AND situacao = 'pendente';
  ```

  Zerar `enfileirado_em` **não reenfileira** enquanto o job `asaas_webhook-<brutoId>` estiver retido no Redis (em "falhou" ou "concluído"): o `addBulk` com o mesmo `jobId` vira no-op. Nesse caso, usar `npm run reprocessar -- asaas_webhook-<brutoId>` (job em "falhou") ou remover o job antes, como no backfill do outbox.

  Bruto `ignorado` ou `divergente` não é reprocessado pelo handler (resultado terminal); depois de corrigir a causa, volta à fila só por papel administrativo, com `situacao = 'pendente'`, `processado_em` e `codigo` nulos e `enfileirado_em` nulo.
- **Retenção:** limpeza após 90 dias em história própria (índice por `recebido_em` pronto).

## Tarefas de domínio

Registro e renovação manuais de domínio novo no Registro.br (E4-H4; CIT-77; código em `src/dominios/` e `src/cli/dominio.js`, tabela `tarefa_dominio` da migração `tarefa-dominio`). Sem endpoint: não há autenticação de equipe, e a equipe usa a CLI no servidor.

- **Abertura:** o consumidor `tarefa_registro_dominio` do `dominio_pago` abre uma tarefa `registro` por domínio novo do pedido (pedido cancelado não abre; fatura retida abre). O pedido só vai a `pago` quando todos os domínios novos estão registrados.
- **Laço no worker** (a cada `DOMINIO_TAREFAS_INTERVALO_MS`; alertas `{ tipo: 'dominio', codigo, tarefaId, pedidoId }`, só ids e códigos, nunca o nome do domínio nem dado do titular): aviso de abertura, 1 por pedido (`tarefa_registro`, ou `tarefa_registro_contas_pendentes` com o pedido ainda em `aguardando_pagamento`); lembrete `lembrete_registro`, 1 por tarefa por dia útil, quando passam mais de 2 dias úteis desde a abertura (pedido em `aguardando_registro_de_dominio`); abertura da tarefa `renovacao` em D-30 do `registro_expira_em` e aviso `renovacao_paga` ou `renovacao_pendente`. Cada aviso: SELECT → `addBulk` com `jobId` determinístico → marcar (`alertada_em`, `ultimo_lembrete_em`); fila fora não marca e o próximo ciclo tenta de novo.
- **Dias úteis:** segunda a sexta, pelas datas locais de America/Sao_Paulo, **sem feriados** (lembrete num feriado é aceito); conta as datas depois da abertura até hoje, inclusive.
- **Comandos** (`npm run dominio -- ...`):
  - `listar [--todas]`: tarefas abertas com tarefa, tipo, pedido, estado do pedido, domínio, data de abertura e dias úteis, sem dado do titular. Oculta as de pedido `cancelado`; `--todas` as mostra marcadas (`registrado`/`renovado` nelas saem 2).
  - `mostrar <tarefaId> --operador <apelido>`: grava antes a auditoria `dados_titular_consultados` (alvo `cliente`) e só então escreve no stdout domínio, vencimento, situação da fatura (renovação, recalculada na hora) e titular (nome, tipo de pessoa, documento, e-mail, telefone). Auditoria não gravada → saída 1, nada exibido. Não copiar essa saída para Taiga, PR ou chat.
  - `registrado <tarefaId> --expira-em AAAA-MM-DD --operador <apelido>`: grava `registrado_em` e o vencimento, conclui a tarefa e audita, numa transação; com o último domínio novo do pedido registrado, grava `pedido.dominio_registrado_em` e, com o pedido em `aguardando_registro_de_dominio`, vai a `pago` e emite `dominio_registrado` (sem consumidor até a #68). Com o pedido ainda em `aguardando_pagamento` (domínios pagos antes das contas), só grava a data; o `pedido_pago` do webhook leva o pedido a `pago` e emite os dois eventos.
  - `renovado <tarefaId> --expira-em AAAA-MM-DD --operador <apelido>`: grava o novo vencimento, conclui a tarefa de renovação e audita; a próxima renovação abre a 30 dias do novo vencimento.
  - `--expira-em`: data real entre hoje + 300 dias e hoje + 10 anos (data local). `--operador`: `^[a-z][a-z0-9_.-]{1,31}$` (apelido, nunca e-mail).
- **Auditoria:** `dominio_registrado_manualmente`, autor `equipe` com o `--operador`, alvo `dominio` (`pedido_dominio.id`), IP fixo `127.0.0.1` (origem CLI; a auditoria exige IP para autor `equipe`), `detalhes: { pedidoId, expiraEm, operacao: 'registro'|'renovacao', usuarioSistema }`. `usuarioSistema` é a conta Unix do servidor (`SUDO_USER` só quando a CLI roda como root, senão o usuário do processo; rode a CLI com `sudo` como root para a pessoa ficar registrada; fora de `^[a-z_][a-z0-9_-]{0,31}$` vira `-`), registrada para que o `--operador` livre não seja a única identificação. Sem nome do domínio nem dado do titular em `detalhes`.
- **Conexão e papel:** mesmo `DATABASE_URL` da aplicação (depois da #57, usuário membro de `<banco>_aplicacao`); os grants da migração cobrem a CLI. O stderr recebe só mensagens fixas e o `code` do erro (nunca a mensagem do `pg`).
- **Situação da fatura anual** (renovação): `paga` se o bruto do webhook tem pagamento recebido da assinatura `dominios` do pedido vencendo entre a referência − 60 e + 30 dias; senão `pendente`. Limites: em D-30 a fatura anual quase sempre ainda não venceu, então `pendente` é o caso comum e não significa inadimplência; estorno posterior não é descontado; a retenção de 90 dias do bruto pode apagar a linha. Conferir no Asaas; a fonte certa será `cobranca_paga` (E4-H5).

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
- [0016 — Status do pedido por token](../docs/adr/0016-status-do-pedido-por-token.md)
