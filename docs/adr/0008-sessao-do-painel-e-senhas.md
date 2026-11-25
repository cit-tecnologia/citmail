# 0008. Sessão do painel e armazenamento de senhas

Status: aceito
Data: 2026-09-25

## Contexto

O titular entra no painel com e-mail e senha (E5-H1). Os critérios pedem sessão em cookie `HttpOnly`, `Secure` e `SameSite`, logout que invalida a sessão no servidor e senha guardada com Argon2 ou bcrypt. O briefing exige hash seguro, bloqueio após falhas de login e auditoria.

O briefing cita JWT (JSON Web Token) para autenticar o "usuário de painel na API". Esse JWT é da API da Skymail: a CIT o monta com a chave da Skymail para chamar a API dela, no servidor. Ele não autentica o titular no painel CITMail e nunca chega ao navegador.

Painel e API ficam no mesmo site (`*.citmail.com.br`), conforme o ADR 0007.

## Opções consideradas

### Opção 1: Cookie com id opaco e sessão no Redis
O cookie leva só um id aleatório. Os dados da sessão ficam no Redis, com expiração. Revogar é apagar a chave.

### Opção 2: JWT próprio em cookie
O cookie leva um token assinado com os dados da sessão. Não exige consulta a cada requisição, mas revogar antes do vencimento exige lista de bloqueio, que é uma sessão no servidor com outro nome.

### Opção 3: Sessão no PostgreSQL
Igual à Opção 1, com a sessão numa tabela. Não adiciona dependência, mas põe uma escrita no banco a cada requisição (renovação da inatividade) e exige limpeza de sessões vencidas.

Para o hash de senha, as opções são Argon2id e bcrypt, ambas aceitas pelo briefing.

## Decisão

Proposto: Opção 1, com Argon2id.

Cookie:

- Nome `__Host-citmail_sessao`, `Path=/`, sem `Domain`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- Valor: id opaco de 32 bytes aleatórios (`crypto.randomBytes`), em base64url.
- Id novo no login e de novo após o 2FA (E5-H11): a sessão anterior é apagada (evita fixação de sessão).

Sessão no Redis (a mesma instância da fila, configurada no ADR 0006):

- Chave pelo hash SHA-256 do id, para que um dump do Redis não entregue sessões válidas.
- Dados: id do cliente, criação, último acesso, IP e agente de usuário do login.
- Expiração por inatividade (proposta: 30 min) e absoluta (proposta: 8 h). Valores finais na E5-H1. A sessão não fica guardada além disso: o Redis a apaga ao expirar.
- Revogação: logout apaga a sessão; troca ou redefinição de senha (E5-H2) apaga todas as sessões do cliente, por um conjunto de ids por cliente.
- Logout só por POST (GET não altera estado).

CSRF (falsificação de requisição entre sites):

- `SameSite=Lax` impede o envio do cookie em requisições vindas de outros sites, exceto navegação GET.
- Toda rota do painel que altera estado (POST, PUT, PATCH, DELETE) exige `Origin` presente e igual a uma origem do painel do ambiente (ADR 0007), com ou sem sessão já aberta. Sem `Origin` ou com outro valor, 403.
- A checagem vale também para login, verificação de 2FA (E5-H11) e logout do painel, mesmo sem sessão ainda: sem ela, uma página de terceiros poderia forçar o navegador da vítima a logar numa conta do atacante ou a se deslogar (CSRF de login), já que essas rotas não exigem o cookie de sessão para ser aceitas.
- Rotas GET não alteram estado.

Rotas isentas da checagem de `Origin` do painel (não usam o cookie de sessão), cada uma com sua autenticação:

| Rota | Autenticação |
|---|---|
| Webhook do Asaas (E3-H4) | cabeçalho `asaas-access-token`, comparado em tempo constante, e conferência no Asaas (ADR 0005) |
| `POST /api/pedidos` (E3-H2) | pública; CORS pela allow-list de origens do ADR 0007, sem cookie; chave de idempotência e limite de taxa |
| `POST /api/orcamento` (E3-H1) | pública; allow-list do ADR 0007, sem cookie |
| `GET /api/dominios/disponibilidade` (#90) | pública; allow-list do ADR 0007, sem cookie; limite de taxa (ADR 0009) |

Login, verificação de 2FA, logout do painel, "esqueci a senha" e definição de senha por link **não** estão na tabela acima: mesmo sem sessão, entram na regra geral de `Origin` do primeiro item (as rotas de senha saíram da tabela na revisão da CIT-71).

Link de definição ou redefinição de senha (E5-H2, E7-H3):

- O token vai no fragmento da URL (depois de `#`), que o navegador não envia ao servidor: não aparece no log do Caddy, do pino nem no cabeçalho `Referer`.
- A página do painel lê o fragmento, apaga-o da barra de endereço e envia o token por POST, no corpo.
- Só o hash do token é gravado (tabela de solicitação de senha, anexo de modelo de dados).

Senhas:

- Argon2id com os parâmetros mínimos recomendados pela OWASP (Password Storage Cheat Sheet): m=19 MiB (19456 KiB), t=2, p=1.
- Os parâmetros ficam no próprio hash. Se forem elevados, a senha é refeita no próximo login.
- Sem enumeração de contas (E5-H1, E5-H2):
  - Login com e-mail inexistente roda Argon2id contra um hash falso fixo, para o tempo de resposta não revelar se o e-mail existe.
  - Mensagem, código HTTP e contador de falhas iguais para e-mail inexistente e senha errada.
  - "Esqueci a senha" responde sempre igual; só contas existentes geram `definicao_senha_solicitada`.
  - A gravação da solicitação e a publicação do evento acontecem fora do caminho da resposta (job da fila, depois de responder): se só acontecessem para conta existente antes de responder, o tempo de resposta revelaria o que a mensagem igual já esconde.
- Bloqueio por tentativas no ADR 0013.

```js
// Ilustrativo (biblioteca argon2 do npm)
const hash = await argon2.hash(senha, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
```

## Justificativa

- Id opaco não carrega dado do cliente e é revogável na hora, o que atende ao logout da E5-H1 e à troca de senha da E5-H2.
- O Redis já está decidido para a fila, tem expiração nativa e aguenta a renovação a cada requisição sem pesar no PostgreSQL.
- `HttpOnly` tira o cookie do alcance do JavaScript da página.
- Argon2id resiste melhor a ataque com GPU que bcrypt, por exigir memória.
- Token no fragmento não passa por nenhum log de servidor nem pelo `Referer`, sem depender de máscara de query.
- Checagem de `Origin` só nas rotas de cookie evita bloquear o webhook e as rotas públicas da landing, que têm autenticação própria ou nenhuma credencial.

## Consequências

- Se o Redis cair, todos saem do painel. Aceito no mvp; o Redis precisa de persistência e proteção (ADRs 0006 e 0013).
- Cada requisição autenticada consulta o Redis.
- Argon2id com 19 MiB por hash limita logins simultâneos pela memória da VPS; considerar no teste de carga (E2-H12). O hash falso do login inexistente custa o mesmo.
- Biblioteca nativa (`argon2`) exige compilação ou binário pré-compilado na VPS.
- O 2FA (E5-H11) entra como etapa extra antes de criar a sessão definitiva.
- O link de senha exige JavaScript na página de definição; sem ele, o token não chega à API.
- Rota nova que use o cookie entra automaticamente na checagem de `Origin`; rota nova isenta precisa entrar na tabela acima, com sua autenticação.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-11-24: implementação na E5-H1 (CIT-70). Valores finais e detalhes:
  - Prazos: 30 min de inatividade e 8 h absolutas, finais para o mvp (a validar com o PO). TTL da chave no Redis = `min(30 min, criação + 8 h − agora)`; o servidor também confere os dois prazos ao ler a sessão (sessão vencida é apagada e responde 401). Cookie de sessão sem `Max-Age` nem `Expires`; logout devolve o mesmo cookie com `Max-Age=0`.
  - Redis: chave `<prefixo>:sessao:<sha256 hex do id>` gravada com `SET NX PX`; renovação só com `SET XX PX`, que não recria uma sessão apagada por logout concorrente (sem gravação, 401). Conjunto `<prefixo>:sessoes:conta:<contaId>` com o hash do id, nunca o id cru, e `PEXPIRE` de 8 h; se o registro no conjunto falhar, a chave recém-gravada é apagada e o login dá 401. Limpeza dos membros vencidos a cada login, com os `EXISTS` num só pipeline; a falha dela vai ao log e não derruba o login. Erro de comando dentro de `MULTI`/pipeline (que o `exec()` devolve em par, sem lançar) é tratado como falha. Login com cookie anterior válido apaga a sessão anterior.
  - Prefixo: reaproveita `FILA_PREFIXO` (padrão `citmail`), o mesmo que separa os ambientes da fila no Redis compartilhado (ADR 0006), em vez de uma variável própria.
  - Bibliotecas, com versão exata: `@node-rs/argon2` 2.2.2 (binário pré-compilado, sem toolchain na VPS) no lugar de `argon2`, `@fastify/cookie` 11.1.5 e `@fastify/cors` 11.3.0. Parâmetros sempre explícitos: `algorithm: 2` (Argon2id; o enum `Algorithm` da biblioteca é `const enum` do TypeScript e não existe em tempo de execução), `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`. Re-hash com parâmetros novos fica para a E5-H2 (#71).
  - Contas sem login (`sem_senha`, `suspensa`, `cancelada`) e e-mail inexistente: o mesmo 401 `credenciais_invalidas` da senha errada, sempre com uma verificação Argon2id (contra o hash falso quando não há hash ou a conta não está `ativa`). `GET /api/painel/sessao` responde 401 e apaga a sessão se a conta deixar de estar `ativa`.
  - Falhas: Redis fora do ar (ou sem `REDIS_URL`) responde 503 `sessao_indisponivel` no login e em `GET /api/painel/sessao`, conferido antes do banco e do Argon2 no login; o logout responde sempre 204 com o cookie expirado, e a falha da remoção vai só para o log. Falha do banco ao conferir a conta da sessão também responde 503. Falha ao gravar a sessão depois do Argon2 responde o mesmo 401 genérico, para o status não distinguir senha certa de errada; hash malformado no banco conta como senha errada, com uma verificação extra contra o hash falso (mesmo custo de tempo).
  - Rotas atrás de `PAINEL_HABILITADO` (desligada em produção; desligada, as rotas não são registradas e respondem 404). **Ligada em produção, a API não sobe** enquanto não houver limitador de tentativas no login (CIT-78, ADR 0013); quando ele existir, a guarda dá lugar à exigência de `REDIS_URL` e `PAINEL_ORIGENS`. Origens do painel em `PAINEL_ORIGENS`, lista exata e subconjunto de `CORS_ORIGENS`. Em `/api/painel/*`, CORS com credenciais só para essas origens; para outra origem, nem o preflight é respondido (`OPTIONS` cai no 404), e login e logout sem `Origin` do painel respondem 403 `origem_recusada` antes do Redis e do banco. Toda resposta de `/api/painel/*` leva `Cache-Control: no-store`.
  - Auditoria: `login` e `login_falhou` (sem e-mail); logout não é auditado (ação fora do vocabulário). Sem bloqueio por tentativas nem limite de taxa ainda (ADR 0013): a configuração recusa a flag em produção até lá.
- 2026-11-24: implementação na E5-H2 (CIT-71). Valores finais e detalhes:
  - Tabela `solicitacao_senha` (anexo de modelo de dados): nasce no pedido **sem token** (`token_hash` nulo). Prazos pelo relógio do banco (`expira_em = now() + prazo`): 72 h para `primeiro_acesso` e 1 h para `redefinicao`, constantes no código (a validar com o PO). Tipo pela conta: sem senha → `primeiro_acesso`; com senha → `redefinicao`. Contas `sem_senha`, `ativa` e `suspensa` geram; `cancelada` e e-mail inexistente não geram nada, com a mesma resposta.
  - `criarSolicitacao` única (consumidor do primeiro acesso e job do "esqueci"), sempre na transação do chamador: trava a conta com `SELECT ... FOR UPDATE` antes de tocar em `solicitacao_senha`. Limites por conta: no máximo um pedido a cada 5 min e 5 abertas (não usadas e no prazo); acima disso, descarta em silêncio. Sem teto diário: a recuperação não pode ficar bloqueada por terceiros por mais que a janela (ADR 0013). Limite por IP fica com a CIT-78. Nova solicitação não invalida as anteriores abertas: elas caem quando uma é usada ou vencem.
  - Token só no envio: `emitirToken(executor, solicitacaoId)` gera 32 bytes aleatórios em base64url (43 caracteres), grava o SHA-256 hex em `token_hash` só se a solicitação estiver aberta e devolve o token cru (`null` se não estiver). Cada chamada troca o hash: o reenvio invalida o link anterior. Contrato com o envio (E7-H3, #72): (a) `executor` em autocommit (Pool ou Client fora de transação), para o hash estar confirmado antes do SMTP; (b) `null` → envio `nao_enviado`, sem nova tentativa; (c) o token fica só em memória até montar o link, nunca em `refs`, log, `job.data`, evento ou auditoria; (d) quem envia grava `enviada_em` (o papel da aplicação já tem o UPDATE).
  - Primeiro acesso: consumidor `senha_primeiro_acesso` de `conta_titular_criada`, só para conta `sem_senha`, na transação do outbox. Ele e o job do "esqueci" só são registrados com `PAINEL_HABILITADO`, que o worker lê com a mesma trava da API (recusada em produção): sem o envio da #72, as solicitações venceriam sem uso. Contas criadas com a flag desligada recuperam o link pelo "esqueci" (`sem_senha` → `primeiro_acesso`).
  - "Esqueci a senha": `POST /api/painel/senha/esqueci` só enfileira o job `senha_esqueci` e responde 202 sem corpo, igual para qualquer e-mail; só a falha ao enfileirar (prazo de 2 s) muda a resposta (503), sem depender do e-mail. Exceção à regra "só ids em `job.data`": o job leva o e-mail digitado, com `removeOnComplete` e `removeOnFail`. Enquanto o job espera ou tenta, o e-mail fica no Redis e, com persistência ligada, no AOF/RDB; risco aceito (Redis só em loopback e com senha, ADR 0013). Como o job falho é apagado antes do aviso de esgotamento do worker, o próprio handler alerta na última tentativa, só com o `jobId` e o nome do job. Os dados do job não vão a log.
  - Política de senha: de 12 a 128 code points (sem normalização), diferente do e-mail da conta (comparado sem espaços nas pontas e em minúsculas), sem regra de composição. Texto único da regra: "Use de 12 a 128 caracteres, diferente do seu e-mail.". Lista de senhas vazadas fica para depois.
  - Definição: `POST /api/painel/senha/definir` confere, nesta ordem: `Origin` (403) → schema (400) → Redis pronto (503) → tamanho da senha (400) → solicitação aberta de conta não `cancelada` (410 `link_invalido`) → diferente do e-mail (400) → Argon2id. A política é sempre conferida antes de consumir o token: senha recusada não gasta o link. Depois, numa transação, com a mesma ordem de travas do pedido (conta primeiro, sem deadlock): consome o token com `UPDATE` condicional (`usada_em IS NULL` e no prazo), grava o hash e `senha_definida_em`, passa `sem_senha` a `ativa` (`ativa` e `suspensa` mantêm o estado), invalida as outras abertas da conta e audita `senha_trocada` (`detalhes: { tipo }`). Falha da auditoria desfaz tudo e responde 503, com o token preservado. Sem login automático: a página manda ao login. `POST /api/painel/senha/validar` responde 200 `{ tipo }` ou 410, sem efeito colateral.
  - Sessões amarradas à senha: depois do `COMMIT`, `encerrarTodas(contaId)` apaga, num `MULTI` com erro conferido por comando, todas as sessões da conta e o conjunto; a falha vai ao log e a resposta continua 204. Segunda defesa, independente de relógio: o login grava na sessão `senhaEm` (epoch ms de `senha_definida_em`, ou null), e `exigirSessao` (preHandler reutilizável pelas rotas autenticadas, usado por `GET /api/painel/sessao`) recusa com 401, apagando a sessão, quando a conta não está `ativa`, quando a sessão não tem `senhaEm` (anterior à CIT-71: o titular entra de novo uma vez) ou quando `senhaEm` diverge do valor atual da conta.
  - `Origin`: as três rotas de senha exigem `Origin` exato de `PAINEL_ORIGENS` (403 `origem_recusada`, antes do corpo, do Redis e do banco) e saíram da tabela de isenções. Redis fora: 503 `sessao_indisponivel` nas três, antes do banco e do hash.
  - Página `definir-senha.html`: lê `#t=<token>` para a memória e apaga o fragmento com `history.replaceState` antes de qualquer requisição; token só no corpo do POST, `referrerPolicy` e `<meta name="referrer" content="no-referrer">`. Risco residual aceito: a entrada original da URL pode ficar no histórico local do navegador até ser usada (token de uso único e prazo curto). Recarregar depois de apagar o fragmento mostra "link inválido", com "Pedir novo link".
  - Re-hash com parâmetros novos no login: fora do escopo (os parâmetros atuais são os mínimos da OWASP e não mudaram); fica para quando forem elevados.
  - Auditoria só do sucesso (`senha_trocada`); falhas de definição vão ao log.
