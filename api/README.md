# API do CITMail

API (Application Programming Interface: interface que outros programas usam para conversar com o sistema) em Node.js, com [Fastify](https://fastify.dev/) e PostgreSQL. Serve as rotas de back-end do CITMail; o site estático (`index.html`, `login.html`, `checkout.html`, `painel.html`) continua publicado à parte, sem build.

Pacote independente, sem workspace npm: `npm ci` aqui não mexe no `package.json`/`package-lock.json` da raiz, e o `npm ci`/`npm test` da raiz não instala nem roda nada desta pasta.

## Estrutura de pastas

```
api/
  compose.yaml        PostgreSQL local (desenvolvimento e teste) por Docker Compose
  .env.example        nomes das variáveis de ambiente (sem valores secretos)
  package.json        scripts e dependências da API
  eslint.config.js    configuração do lint (ESLint, regras recomendadas)
  migrations/         migrações SQL do node-pg-migrate (uma por arquivo, com Up/Down)
  deploy/journald-namespace.conf  retenção dos logs (journald, até 30 dias; instalado na VPS pela #57/#93)
  src/
    config.js         lê e valida as variáveis de ambiente (carregarConfig)
    banco.js           pool do PostgreSQL (pg) e checagem de saúde (verificarBanco)
    app.js             fábrica construirApp(config, { pool, logStream }): Fastify, CORS, log, validação e erros
    log.js             log técnico: lista de campos mascarados, serializers e LogCitmail (linha única por requisição)
    erros.js           tratamento padronizado de erro (400 por campo, 404, 500) e ErroDeDominio
    servidor.js        ponto de entrada: carrega a config, sobe o Fastify, encerra em SIGTERM/SIGINT
    saude/rotas.js      GET /api/health
    exemplo/rotas.js    POST /api/exemplos e POST /api/exemplos/job (só fora de produção; padrão de schema, erro e log de job)
    jobs/executar.js    executarJob: log correlacionado de job (job iniciado/concluído/falhou)
    jobs/exemplo.js     job de exemplo
    asaas/resumo.js     resumoEventoAsaas: o que do webhook do Asaas pode ir para o log
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
- Docker com Docker Compose (para o PostgreSQL local).

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

## Logs

JSON do `pino` na saída padrão (ADR 0013, item 8; código em `src/log.js`). Linhas:

- `request completed` (nível `info`, uma por requisição, também em 4xx/5xx): `reqId` (igual ao header `x-request-id` da resposta), `req.method`, `req.rota` (template, ex.: `/api/exemplos/:id`), `req.remoteAddress` (IP), `res.statusCode` e `responseTime` (ms). Sem URL concreta (nem query nem valor de parâmetro), sem headers e sem corpo. No 404, `req.rota` é `null` e `req.caminho` traz o path sem query (até 200 caracteres). Não há `incoming request` nem `Route ... not found`.
- `request aborted`: o cliente desistiu antes da resposta (`reqId`, `req.rota`).
- `GET /api/health` loga só a partir de `warn` (o monitoramento chama a cada minuto); a falha sai como `banco indisponível no health`, com `reqId`.
- Jobs: `executarJob({ nome, correlacaoId, log }, fn)` de `src/jobs/executar.js` registra `job iniciado`, `job concluído` (com `duracaoMs`) ou `job falhou` (`error`, e relança o erro), todas com `job` e `reqId` = `correlacaoId` (sem ele, um UUID novo). Passar em `log` o logger raiz (`app.log` ou o do worker), nunca `request.log`, que já tem `reqId` (a chave sairia repetida); dentro do job, logar só pelo `log` recebido em `fn`. Os dados do job não são logados. Exemplo: `POST /api/exemplos/job` (`{ "falhar": true }` simula a falha).
- Webhook do Asaas: logar só `resumoEventoAsaas(evento)` de `src/asaas/resumo.js` (`event`, `paymentId`, `paymentStatus`, `billingType`); nunca `request.body`, o `payment`/`customer` inteiro nem o header `asaas-access-token`.

**Máscara** (`redact`, censor `[mascarado]`): os 41 nomes de `camposSensiveis` em `src/log.js` (dados pessoais do pedido e do cliente do Asaas, credenciais, `creditCard` e `creditCardToken`) na raiz e em até 3 níveis de aninhamento (`x`, `a.x`, `a.b.x`, `a.b.c.x`), além dos campos `err.*` e `err.cause.*` do `pg` (`detail`, `where`, `parameters`, `hint`, `internalQuery`, `query`). Limites: o 5º nível não é mascarado; o nome precisa ser exato (`CPF` não casa com `cpf`); homônimos técnicos, se existirem, também são mascarados (ex.: um `name` próprio de erro, `numero` técnico; usar nomes distintos como `numeroPedido`); dado pessoal dentro de `err.message` e `err.stack` não é mascarado (o `pg` pode repetir o valor enviado; logar `code` e `routine`, não a mensagem do driver). Ficam em claro, de propósito, `uf`, `estado` e `state`. Ficam fora, para a #64 revisar, os textos livres do Asaas `description`, `observations`, `groupName` e `externalReference`.

**Retenção:** até 30 dias, em journald, com um namespace por ambiente: `citmail` (produção) e `citmail-homolog` (homologação). O arquivo `deploy/journald-namespace.conf` (`MaxRetentionSec=29day` + `MaxFileSec=1day`, porque o journald apaga arquivo inteiro; `SystemMaxUse=1G` por namespace; `ForwardToSyslog=no`, para o log não cair na retenção do logrotate) é instalado como `/etc/systemd/journald@<namespace>.conf`, e as unidades systemd da API e do worker usam `LogNamespace=<namespace>`. Consulta: `journalctl --namespace=<namespace>`. Premissa: systemd ≥ 245. A aplicação e a verificação na VPS ficam com a #57/#93.

## Como rodar os testes

Suíte `node:test` (nativa do Node.js) em `api/test/`, uma spec por critério de aceite. Nunca usa Playwright (isso é do site, na raiz).

```sh
npm run banco:teste
npm test
```

`npm test` roda com `--import ./test/sem-rede.js`: uma guarda que bloqueia qualquer conexão a um host fora de `127.0.0.1`/`::1`/`localhost`. Nenhum teste depende de serviço externo; integrações futuras (Asaas, Skymail, RDAP) devem ser mockadas, nunca chamadas de verdade.

Sem Docker, um PostgreSQL 17 local serve no lugar do `banco:teste`: apontar `DATABASE_URL_TESTE` para ele (padrão: `postgres://postgres@127.0.0.1:55433/postgres`). O host precisa ser loopback (`127.0.0.1`, `::1` ou `localhost`): a guarda sem-rede bloqueia qualquer outro.

**O que a CI (Continuous Integration: verificação automática a cada mudança) roda** (job `api` de `.github/workflows/testes.yml`, em todo PR para `develop` e `main` e antes da publicação da homologação): um PostgreSQL 17 de serviço do GitHub Actions (`postgres:17-alpine`, sem senha, na porta `55433`), `DATABASE_URL_TESTE=postgres://postgres@127.0.0.1:55433/postgres` e, a partir da raiz do repositório:

```sh
npm --prefix api ci && npm --prefix api run lint && npm --prefix api test
```

Para reproduzir localmente, subir antes o `banco-teste` (`npm --prefix api run banco:teste`), que usa a mesma porta. Lint ou teste falhando bloqueia o merge do PR.

## Definition of Done

Definition of Done (DoD: lista do que precisa ser verdade antes de considerar uma rota ou mudança pronta). Vale para toda rota e mudança desta API:

1. **Todo endpoint declara `schema`** (tipos, tamanhos e limites; corpo com `additionalProperties: false`). Como cumprir: seguir o padrão de `src/saude/rotas.js` e `src/exemplo/rotas.js` — toda rota nova define `schema.body`/`schema.response` com limites explícitos (`minLength`, `maxLength`, `minimum`, `maximum` etc.). Rota `POST`/`PUT`/`PATCH` sem `schema.body` impede a API de subir.
2. **O banco só é acessado por consulta parametrizada** (`$1`, `$2`; nunca concatenar valor em SQL). Como cumprir: usar sempre `pool.query(texto, valores)`, como em `src/banco.js`; nunca montar SQL com template string a partir de entrada do usuário.
3. **Os testes automatizados rodam sem internet** (guarda `sem-rede`, serviços externos mockados). Como cumprir: manter `--import ./test/sem-rede.js` no script `test` e mockar qualquer serviço externo novo em vez de chamá-lo de verdade.
4. **As ações críticas chamam a auditoria** (E6-H7; lista no [ADR 0013](../docs/adr/0013-seguranca-transversal-e-observabilidade.md), item 7). Como cumprir: ao implementar uma ação da lista (login, falha de login, bloqueio, criação/exclusão de caixa, troca de senha, alteração cadastral, cancelamento etc.), gravar na tabela de auditoria antes de responder — a auditoria em si ainda não existe nesta história (CIT-53), fica para a E6-H7.
5. **Nenhum segredo, senha ou dado pessoal em log** (`redact` do [ADR 0013](../docs/adr/0013-seguranca-transversal-e-observabilidade.md); segredos só por variável de ambiente). Como cumprir: adicionar todo campo sensível novo, com o nome exato (o `redact` diferencia maiúsculas), à lista `camposSensiveis` de `src/log.js` (mascarada na raiz e em até 3 níveis de aninhamento; os campos `err.*` do `pg` já estão cobertos); não logar objeto com dado pessoal abaixo do 4º nível; logar o webhook do Asaas só por `resumoEventoAsaas`; e nunca logar `config.databaseUrl` nem outra variável de ambiente sensível.

## Próximos passos

Fora do escopo desta história (CIT-53), documentados aqui como referência:

- Fila e eventos de domínio com Redis/BullMQ ([ADR 0005](../docs/adr/0005-fila-e-eventos-de-dominio.md)).
- Sessão do painel, com cookie ([ADR 0008](../docs/adr/0008-sessao-do-painel-e-senhas.md)).
- Auditoria efetiva das ações críticas (E6-H7).
- Webhooks (ex.: Asaas).
- Deploy da API na VPS, com `systemd`, Caddy e HTTPS (#57 e #93).

## ADRs relacionados

- [0002 — Organização do código da API](../docs/adr/0002-organizacao-do-codigo-da-api.md)
- [0003 — Framework HTTP](../docs/adr/0003-framework-http.md)
- [0004 — PostgreSQL, acesso ao banco e migrações](../docs/adr/0004-banco-e-migracoes.md)
- [0007 — Domínios, CORS e cookies por ambiente](../docs/adr/0007-dominios-cors-e-cookies-por-ambiente.md)
- [0013 — Segurança transversal e observabilidade](../docs/adr/0013-seguranca-transversal-e-observabilidade.md)
