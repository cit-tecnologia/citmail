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
    app.js             fábrica construirApp(config, { pool, logStream, filas }): Fastify, CORS, log, validação e erros
    log.js             log técnico: lista de campos mascarados, serializers, LogCitmail (linha única por requisição) e criarLogger (worker)
    erros.js           tratamento padronizado de erro (400 por campo, 404, 500) e ErroDeDominio
    servidor.js        ponto de entrada da API: carrega a config, sobe o Fastify, encerra em SIGTERM/SIGINT
    worker.js          ponto de entrada do worker da fila (npm run worker): sem banco nem CORS; encerra em SIGTERM/SIGINT esperando o job ativo e os alertas em curso
    saude/rotas.js      GET /api/health
    precos/             POST /api/orcamento (público, sem banco): tabela.js (tabela do servidor, limites e tetoAddon; paridade com assets/precos.js), servico.js (validarLimites e calcularOrcamento), rotas.js (schemas gerados da tabela)
    exemplo/rotas.js    POST /api/exemplos e POST /api/exemplos/job (só fora de produção; padrão de schema, erro e de rota que só enfileira)
    jobs/executar.js    executarJob: log correlacionado de job (job iniciado/concluído/falhou)
    jobs/exemplo.js     job de exemplo
    fila/conexao.js     conexões com o Redis: de worker (espera o Redis voltar) e de produtor (falha rápido)
    fila/filas.js       filas jobs e alertas (tentativas, backoff exponencial, retenção)
    fila/worker.js      workers: roda os handlers, alerta de job esgotado, envio de alertas com limite por minuto
    alertas/telegram.js envio do alerta ao Telegram (só ids, token fora de log e erro)
    cli/reprocessar.js  npm run reprocessar -- <jobId>: devolve um job falhado à fila
    asaas/resumo.js     resumoEventoAsaas: o que do webhook do Asaas pode ir para o log
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

Fila e alertas (ADRs 0005 e 0011). Cada processo exige só o que usa: a API (`npm run dev`/`npm start`), o worker (`npm run worker`) e a CLI (`npm run reprocessar`). Worker e CLI não leem `DATABASE_URL` nem `CORS_ORIGENS`; `NODE_ENV` e `LOG_LEVEL` valem para os três.

| Variável | API | Worker | CLI | Uso | Padrão |
|---|---|---|---|---|---|
| `REDIS_URL` | opcional | obrigatória | obrigatória | Conexão com o Redis da fila. Sem ela, a API sobe sem fila e sem `POST /api/exemplos/job` (a #64 a torna obrigatória na API em produção). Nunca vai para o log. | sem padrão |
| `FILA_PREFIXO` | lida | lida | lida | Prefixo das chaves no Redis; separa ambientes no mesmo Redis (ADR 0006). Só letras minúsculas, dígitos e hífen. | `citmail` |
| `FILA_TENTATIVAS` | lida | lida | lida | Tentativas por job (inteiro de 1 a 20). | `8` |
| `FILA_BACKOFF_MS` | lida | lida | lida | Espera antes da 2ª tentativa, em ms (inteiro de 1 a 3600000); dobra a cada tentativa (exponencial: com os padrões, cerca de 2 h até esgotar). | `60000` |
| `TELEGRAM_BOT_TOKEN` | não lê | obrigatória em produção | não lê | Token do bot do alerta. Segredo: só no ambiente do worker. | sem padrão |
| `TELEGRAM_CHAT_ID` | não lê | obrigatória em produção | não lê | Id do grupo que recebe os alertas. Segredo: só no ambiente do worker. | sem padrão |

Fora de produção, sem as duas variáveis do Telegram, o alerta sai só no log (`alerta sem telegram`).

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

- Eventos de domínio pelo outbox, com consumidores idempotentes ([ADR 0005](../docs/adr/0005-fila-e-eventos-de-dominio.md); a fila de jobs já existe, CIT-56).
- Sessão do painel, com cookie ([ADR 0008](../docs/adr/0008-sessao-do-painel-e-senhas.md)).
- Chamar a auditoria nas ações críticas reais (as histórias de cada ação); papel `<banco>_retencao` e rotina de pseudonimização do IP (ADR 0013, item 9).
- Webhooks (ex.: Asaas).
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
