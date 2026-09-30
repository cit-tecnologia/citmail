# 0013. Segurança transversal e observabilidade

Status: aceito
Data: 2026-09-25

## Contexto

O briefing exige senha com hash seguro, bloqueio temporário após falhas de login e auditoria das ações críticas (criação, exclusão, troca de senha). As histórias E6-H4 (bloqueio), E6-H7 (auditoria), E2-H9 (logs) e E6-H3 (exclusão de dados, LGPD) detalham esses pontos. O repositório é público.

Decidido pelo responsável em 2026-09-25 (CIT-46, registrado no `CLAUDE.md`), sem rediscussão:

- Segredos só em environment do GitHub ou em arquivo de ambiente com `chmod 600` no servidor. Nunca no repositório nem em `.env` commitado (`.env`, `.env.*` e `.envrc` estão no `.gitignore`, exceto `.env.example`).
- Chave de terceiro sem consumidor (ex.: Skymail) fica no gerenciador de senhas do time até haver consumidor.
- Só o processo que usa o segredo lê o arquivo. Asaas, banco e SMTP seguem a mesma regra.

O resto deste ADR é proposta.

## Opções consideradas

As opções abaixo tratam da trilha de auditoria. Os demais itens seguem as histórias citadas.

### Opção 1: Auditoria em tabela própria, só de inclusão
Tabela `auditoria` no PostgreSQL. O usuário de banco da aplicação só tem permissão de inserir e ler.

### Opção 2: Auditoria só no log
Cada ação vira uma linha de log marcada. Mais simples, mas o log é rotacionado, é mais fácil de apagar e é difícil de consultar por cliente.

## Decisão

**Decidido pelo responsável em 2026-09-25:** item 1 (segredos, regras da CIT-46).

**Proposto:** itens 2 a 9.

1. **Segredos:** regras da CIT-46, acima.
2. **Senhas:** Argon2id com m=19 MiB, t=2, p=1, e login sem enumeração de contas (ADR 0008).
3. **IP do cliente:** o Fastify usa `trustProxy` restrito ao loopback (o Caddy, ADR 0006). Um `X-Forwarded-For` enviado pelo cliente não muda o IP usado no limite de taxa, no bloqueio e na auditoria.
4. **Força bruta (E6-H4):**
   - Contador de falhas por conta no Redis, com expiração de 15 min a partir da primeira falha. Chave por HMAC (segredo do servidor) do e-mail normalizado, sem e-mail em claro; HMAC e não hash simples, porque o espaço de e-mails é adivinhável (busca por dicionário reverteria um SHA-256 puro) e o segredo do HMAC impede reconstruir a chave sem ele. O contador existe também para e-mail inexistente, com a mesma resposta (sem enumeração).
   - Com 5 falhas, a 6ª tentativa de login é recusada até o contador expirar: **HTTP 429 com `Retry-After`** (segundos até liberar). Mesma resposta para conta existente e inexistente.
   - Contador por IP entre contas diferentes, também 429 com `Retry-After` acima do limite (valor na E6-H4).
   - "Esqueci a senha" (E5-H2) e o 2FA (E5-H11) têm limite próprio, por IP + conta. O bloqueio de login da conta **não** impede a recuperação de senha: um atacante que trava a conta não tira da vítima o caminho de volta.
   - O bloqueio vai para a auditoria.
5. **Cabeçalhos HTTP:**
   - API (`api.` de cada ambiente): `Strict-Transport-Security` (HSTS), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
   - Painel: HSTS, CSP restrita (`default-src 'self'`, `connect-src` só com a origem da API, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
   - HSTS sem `includeSubDomains` até conferir que todos os subdomínios de `citmail.com.br` servem HTTPS. Conferido, acrescentar `includeSubDomains`.
   - Os cabeçalhos saem do Caddy. Enquanto o painel estiver num host que não permite cabeçalhos (GitHub Pages), a CSP vai em `<meta>`, e HSTS e `frame-ancestors` (que não funcionam em `<meta>`) ficam pendentes até o painel sair desse host (ADR 0007).
   - Landing e checkout (CIT-49): CSP em `<meta>` logo depois do `<meta charset>`, igual no GitHub Pages e na homologação: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`, e no checkout `connect-src 'self' https://viacep.com.br`. Sem handler nem script inline: o código fica em `assets/landing.js` e `assets/checkout.js`, sem hash nem nonce na política.
   - Fontes (CIT-52): Montserrat e Poppins servidas da própria origem (`assets/fonts/`, woff2 do fontsource com subset latin, licença OFL 1.1 em `assets/fonts/OFL-*.txt`; `@font-face` em `assets/fonts.css`), sem Google Fonts. Por isso a política não libera `fonts.googleapis.com` nem `fonts.gstatic.com`: além do desempenho (o CSS do Google bloqueava a renderização), o navegador do visitante deixa de enviar o IP ao Google ao abrir a landing ou o checkout. Login e painel ainda usam o Google Fonts até história própria. O pop-up do boleto herda a CSP do checkout e cita as famílias sem `@font-face` próprio: usa a fonte do sistema, como antes.
   - Dívida: `style-src` mantém `'unsafe-inline'` porque as páginas ainda têm atributos `style=` (inclusive em HTML montado por script) e o `<style>` do pop-up do boleto. Uma injeção de HTML não executa script, mas ainda pode aplicar CSS. A remoção fica com a issue #152.
   - A meta é estática. Quando a landing ou o checkout chamarem a API (ADR 0007 e 0009), o `connect-src` precisa incluir a origem da API de cada ambiente; quando o Pix do Asaas entrar, o `img-src` precisa aceitar o QR Code (`pixQrCode`, imagem em `data:`). A CSP por cabeçalho (#94) repete esta política e soma à meta (vale a interseção das duas).
   - Limites da meta: sem `frame-ancestors` (não vale em `<meta>`), o checkout pode ser embutido em iframe até o cabeçalho da #94 existir. No GitHub Pages, `'self'` é `https://cittecnologia.github.io`, a origem de todos os repositórios publicados da organização: um script de outro repositório passaria no `script-src`, se houvesse também uma injeção de HTML nas páginas. A homologação e a produção fora do Pages (ADR 0007) não têm esse limite. Se `assets/precos.js` não carregar, o checkout mostra o aviso e para antes de vincular os botões, como já acontecia com o fluxo do passo 1.
6. **Webhook do Asaas:** autenticação por `asaas-access-token` em tempo constante e conferência no Asaas antes de mudar estado (ADR 0005).
7. **Auditoria (E6-H7):** Opção 1.
   - Ações: login, falha de login, bloqueio, criação e exclusão de caixa, troca de senha, alteração cadastral, cancelamento, exclusão de dados, suspensão, reativação e registro manual de domínio pela equipe (E4-H4).
   - Campos: autor (cliente, sistema ou equipe), ação, alvo, data e hora, IP, resultado e `requestId`. Sem senha nem token.
   - O usuário de banco da aplicação não tem `UPDATE`, `DELETE` nem `TRUNCATE` na tabela.
8. **Logs (E2-H9)** (revisado em 2026-09-27, CIT-55; implementação em `api/src/log.js`):
   - `pino` em JSON (logger do Fastify, ADR 0003). O identificador da requisição sai no campo `reqId` do log (nome do Fastify) e no header de resposta `x-request-id`; o cliente não escolhe o valor.
   - **Uma linha por requisição**, `request completed` (nível `info`, também em 4xx/5xx; o 5xx já tem a linha `error` do tratador), com `req.method`, `req.rota` (template da rota, ex.: `/api/exemplos/:id`), `req.remoteAddress` (IP, mantido por decisão do responsável e sujeito aos 30 dias abaixo), `res.statusCode` e `responseTime` (ms). **Sem URL concreta**: nem query string nem valores de parâmetro de rota. Só no 404 (`req.rota: null`) sai `req.caminho`, o path sem query, truncado em 200 caracteres. Sem headers nem corpo.
   - Feito com `LogController` próprio (`LogCitmail`, opção `logController` do Fastify): `incomingRequest` e `routeNotFound` não logam (a linha padrão do 404 leva a URL crua com query) e `requestCompleted` monta a linha única. Não se usa `disableRequestLogging`: está deprecado no Fastify 5.12 (FSTDEP023) e calaria também os logs de erro de stream, de `writeHead` e de serializer, que continuam herdados.
   - Cliente que desiste antes da resposta gera `request aborted` (hook `onRequestAbort`), com `reqId` e `req.rota`.
   - `GET /api/health` roda com `logLevel: 'warn'`: o monitoramento externo (ADR 0011) chama a rota a cada minuto; a falha (`warn` "banco indisponível no health") continua no log.
   - **Máscara por nome de campo** (`redact`, censor `[mascarado]`, valor inteiro substituído, inclusive objeto), não por padrão de valor (regex de CPF em todo valor custaria CPU em toda linha e daria falso positivo em ids e valores). Lista `camposSensiveis` (41 nomes) na raiz, em `*.`, `*.*.` e `*.*.*.`:
     - pedido: `senha`, `token`, `email`, `telefone`, `nome`, `cpf`, `cnpj`, `cpfCnpj`, `documento`, `razaoSocial`, `nascimento`, `dataNascimento`, `cep`, `endereco`, `logradouro`, `numero`, `complemento`, `bairro`, `cidade`; ViaCEP: `localidade`;
     - credenciais: `password`, `authorization`, `accessToken`, `access_token`, `refreshToken`, `apiKey`;
     - cliente e pagamento do Asaas: `name`, `phone`, `mobilePhone`, `company`, `postalCode`, `address`, `addressNumber`, `complement`, `province`, `cityName`, `additionalEmails`, `municipalInscription`, `stateInscription`, `creditCard`, `creditCardToken`. Ficam fora, para a #64 revisar: `description`, `observations`, `groupName` e `externalReference` (texto livre).
     - Mais `req.headers.cookie`, `req.headers.authorization`, `req.headers["asaas-access-token"]`, `res.headers["set-cookie"]` (defesa: o serializer não loga headers) e `err.detail|where|parameters|hint|internalQuery|query` do `pg`, também em `err.cause.*` (o serializer `err` do pino copia a `cause` atribuída que não é Error).
   - **Fora da máscara, com motivo:** `uf`, `estado` e `state` (27 valores, pouco identificáveis sozinhos e úteis para operação; cidade e CEP ficam mascarados). Nomes só do formulário de cartão (`cartao`, `numeroCartao`, `cvv`, `validade`, `ccv`, `creditCardHolderInfo`): o checkout é hospedado no Asaas e a API não recebe número completo nem CVV (o `checkout.html` é adaptado na #63). Pelo webhook, porém, chegam os 4 finais e o `creditCardToken` (que permite cobrar de novo), por isso `creditCard` e `creditCardToken` estão mascarados. Se alguma história passar a receber dado de cartão na API, a lista e este item são revistos nela.
   - **Limites aceitos:** 5º nível não é mascarado; o `redact` diferencia maiúsculas (`CPF` e `Authorization` não casam), então campo novo entra com o nome exato; homônimos técnicos, se existirem, também são mascarados (ex.: um `name` próprio de erro, `numero` técnico, `address`, `token`): campo técnico usa nome distinto (ex.: `numeroPedido`). Dado pessoal dentro de `err.message` não é mascarado: tratadores logam códigos, não mensagens de driver. `err.message` e `err.stack` do `pg` podem repetir o valor enviado (ex.: `invalid input syntax for type uuid: "..."`), por isso o tratador de erro de repositório deve logar `code` e `routine`, não a mensagem do driver (hoje o `erro não tratado` loga o `err` inteiro). Dois avisos internos do Fastify em nível `warn` (resposta enviada duas vezes, `FST_ERR_REP_ALREADY_SENT`) levam a URL crua com query; só disparam por bug de código. No 404, `req.caminho` guarda os segmentos do path em claro (truncado em 200, sem query); a #64 avalia mascarar segmentos com dígitos ou `@`.
   - **Custo medido** (uma vez, 10 mil linhas com objeto de 3 níveis para stream nulo, pino 10.3.1, Node 24, Intel Xeon E-2388G com 1 vCPU, mediana de 5 rodadas): sem `redact` ~1,6 µs/linha; `redact` anterior (8 nomes × 3 níveis, 34 caminhos) ~12 µs/linha; com 39 nomes × 4 níveis (166 caminhos) ~110 µs/linha (cerca de 9×). A configuração atual tem 180 caminhos (41 nomes × 4 níveis, 4 de headers e 12 de erro do `pg`, em `err.*` e `err.cause.*`) e não foi medida de novo: o custo cresce na proporção dos caminhos com curinga; a 10 linhas/s são ~1 ms de CPU por segundo. **Aceito pelo responsável em 2026-09-29** (acima do teto de 2× do plano da CIT-55, que era arbitrário): a proteção dos 4 níveis vale mais que o custo absoluto; reavaliar se o volume de log crescer.
   - **Webhook do Asaas:** o evento só vai para o log por `resumoEventoAsaas(evento)` (`api/src/asaas/resumo.js`), que devolve só `event`, `paymentId`, `paymentStatus` e `billingType`. Nunca `request.body`, o `payment`/`customer` inteiro nem o header `asaas-access-token`. A máscara é rede de segurança, não permissão para logar o corpo. Coerente com o ADR 0005 (item 6).
   - **Jobs:** o `reqId` da requisição vai nos dados do job da fila (`job.data.requestId`) e no registro do evento (ADR 0005). `executarJob({ nome, correlacaoId, log }, fn)` (`api/src/jobs/executar.js`) cria `log.child({ reqId: correlacaoId, job: nome })` (sem `correlacaoId`, UUID novo) e registra `job iniciado`, `job concluído` (com `duracaoMs`) ou `job falhou` (`error`, relançando o erro para a nova tentativa da fila). `log` é o logger raiz (`app.log` ou o do worker), nunca `request.log`, que já tem `reqId`. Os dados do job não são logados. **Trade-off:** AsyncLocalStorage com `mixin` do pino daria `reqId` a qualquer log feito durante o job (inclusive de bibliotecas, como o pool do `pg`); o id explícito depende de disciplina (logar pelo `log` recebido em `fn`), em troca de não ter contexto implícito nem o custo de ALS em toda requisição. No job de exemplo (`POST /api/exemplos/job`, só fora de produção) a rota aguarda o job, então a falha gera duas linhas `error` (`job falhou` e `erro não tratado`); na fila real (#56) a requisição só enfileira e sai uma.
   - A query string não leva segredo: o token de senha vai no fragmento da URL (ADR 0008). Mesmo assim, a query não vai para o log.
   - **Retenção dos logs técnicos: até 30 dias, em journald**, um namespace por ambiente (homologação e produção na mesma VPS, ADR 0006): `citmail` (produção) e `citmail-homolog` (homologação). Configuração versionada em `api/deploy/journald-namespace.conf` (`Storage=persistent`, `MaxRetentionSec=29day`, `MaxFileSec=1day`, `SystemMaxUse=1G`, `ForwardToSyslog=no`: encaminhar ao syslog levaria o log para a retenção do logrotate, fora dos 30 dias), instalada como `/etc/systemd/journald@<namespace>.conf`; a unidade systemd da API e a do worker usam `LogNamespace=<namespace>` e a consulta é `journalctl --namespace=<namespace>`. O journald apaga arquivo inteiro: 29 dias mais arquivo de até 1 dia dá até 30. `SystemMaxUse` é teto de disco por namespace. Premissa: systemd ≥ 245 na VPS. Aplicação e verificação na VPS ficam com a #57/#93, assim como o log de acesso do Caddy (desligado ou com os mesmos 30 dias, porque guarda IP e URL com query). Os 6 meses do Marco Civil ficam com a auditoria (item 7).
9. **Retenção e LGPD** (prazos propostos, a confirmar pelo responsável):
   - Auditoria: IP guardado em claro por 6 meses (guarda de registros de acesso do Marco Civil da Internet, art. 15); depois pseudonimizado (HMAC com chave fora do banco) ou apagado. O registro em si fica 5 anos.
   - Sessão: no máximo 8 h no Redis (ADR 0008); IP e agente de usuário somem com ela.
   - Evento bruto do Asaas: 90 dias (ADR 0005).
   - Exclusão de dados (E6-H3): a anonimização do cliente não apaga a auditoria. A auditoria só tem ids, IP (pseudonimizado após o prazo) e `detalhes` sem dado pessoal; referencia o alvo sem chave estrangeira, e o registro sobrevive à anonimização.

**Redis:** escuta só na interface de loopback, com `protected-mode` ligado e autenticação por senha ou ACL. A senha fica em arquivo `chmod 600`. Sem porta aberta no firewall. Persistência e política de memória no ADR 0006.

```js
// Ilustrativo: máscara no logger (lista completa no item 8 e em api/src/log.js)
const camposSensiveis = ['senha', 'token', 'email', 'cpfCnpj', 'creditCardToken' /* ... 41 nomes */]
redact: {
  paths: [
    ...camposSensiveis, ...camposSensiveis.map(c => `*.${c}`),
    ...camposSensiveis.map(c => `*.*.${c}`), ...camposSensiveis.map(c => `*.*.*.${c}`),
    'req.headers.cookie', 'req.headers.authorization',
    'req.headers["asaas-access-token"]', 'res.headers["set-cookie"]'
  ],
  censor: '[mascarado]'
}
```

## Justificativa

- Tabela só de inclusão impede que um erro ou invasão na aplicação apague o rastro, e permite consulta por SQL no mvp.
- Contador no Redis tem expiração nativa e já é dependência decidida.
- `trustProxy` restrito evita que o atacante escolha o próprio IP e escape do limite de taxa.
- Resposta igual e tempo igual para conta existente e inexistente não revelam quem é cliente.
- Recuperação de senha fora do bloqueio de login reduz o dano do bloqueio forçado por terceiros.
- Cabeçalhos de segurança fecham clickjacking (`frame-ancestors`), rebaixamento para HTTP (HSTS) e interpretação errada de tipo (`nosniff`).
- O mesmo `requestId` da requisição ao job liga falhas de pagamento e de provisionamento a uma causa.
- Redis sem autenticação e exposto é vetor comum de invasão; aqui ele guarda sessão e fila.
- Prazos de retenção limitam o dado pessoal guardado ao necessário (LGPD), sem perder o rastro exigido.

## Consequências

- Duas permissões de banco distintas: a de migração (dona das tabelas) e a da aplicação (restrita na auditoria).
- Pseudonimizar o IP da auditoria exige uma rotina com permissão própria de `UPDATE` só na coluna `ip`, separada do usuário da aplicação.
- Máscara de log por lista de caminhos exige manutenção quando surgir campo sensível novo ou nível mais fundo.
- Bloqueio por conta ainda permite que um atacante trave o login de outra pessoa por 15 min; a recuperação de senha continua livre. Aceito no mvp; CAPTCHA está fora do escopo da E6-H4.
- Enquanto o painel estiver no GitHub Pages, parte dos cabeçalhos do painel não se aplica.
- Os prazos de retenção entram em "Decisões em aberto" do README até o responsável confirmar.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-09-27: item 8 detalhado (CIT-55): log de requisição em uma linha com rota, status, duração e IP, sem URL concreta; máscara ampliada para 41 campos (dados pessoais do pedido e do cliente do Asaas e token de cartão do webhook) em 4 níveis; webhook do Asaas logado só pelo resumo resumoEventoAsaas; correlação de job por id explícito; retenção dos logs técnicos de até 30 dias em journald, com um namespace por ambiente (decisão do responsável).
- 2026-09-29: ajustes da revisão do item 8 (CIT-55): custo de ~9× do `redact` aceito pelo responsável; inscrições municipal e estadual do Asaas incluídas na máscara (41 campos); `err.cause.*` do `pg` na máscara; `ForwardToSyslog=no` no journald e `LogNamespace=` também na unidade do worker; limites registrados (mensagem do `pg`, avisos internos do Fastify com URL crua, segmentos do path no 404).
- 2026-09-30: item 5 estendido (CIT-49): CSP por `<meta>` na landing e no checkout, sem handler nem script inline; dívida do `style-src 'unsafe-inline'` (#152); mudanças futuras do `connect-src` (API) e do `img-src` (QR Code Pix).
- 2026-09-30: item 5 (CIT-52): landing e checkout sem Google Fonts; `style-src` sem `fonts.googleapis.com` e `font-src 'self'`, com as fontes em `assets/fonts/`.
