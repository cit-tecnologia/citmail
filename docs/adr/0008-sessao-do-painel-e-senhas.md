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
| "Esqueci a senha" e definição de senha por link (E5-H2) | token de uso único no corpo; limite de taxa (ADR 0013) |

Login, verificação de 2FA e logout do painel **não** estão na tabela acima: mesmo sem sessão, entram na regra geral de `Origin` do primeiro item.

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
  - Redis: chave `<prefixo>:sessao:<sha256 hex do id>` gravada com `SET NX PX`; renovação só com `SET XX PX`, que não recria uma sessão apagada por logout concorrente (sem gravação, 401). Conjunto `<prefixo>:sessoes:conta:<contaId>` com o hash do id, nunca o id cru, `PEXPIRE` de 8 h e limpeza dos membros vencidos a cada login. Login com cookie anterior válido apaga a sessão anterior.
  - Prefixo: reaproveita `FILA_PREFIXO` (padrão `citmail`), o mesmo que separa os ambientes da fila no Redis compartilhado (ADR 0006), em vez de uma variável própria.
  - Bibliotecas, com versão exata: `@node-rs/argon2` 2.2.2 (binário pré-compilado, sem toolchain na VPS) no lugar de `argon2`, `@fastify/cookie` 11.1.5 e `@fastify/cors` 11.3.0. Parâmetros sempre explícitos: `algorithm: 2` (Argon2id; o enum `Algorithm` da biblioteca é `const enum` do TypeScript e não existe em tempo de execução), `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`. Re-hash com parâmetros novos fica para a E5-H2 (#71).
  - Contas sem login (`sem_senha`, `suspensa`, `cancelada`) e e-mail inexistente: o mesmo 401 `credenciais_invalidas` da senha errada, sempre com uma verificação Argon2id (contra o hash falso quando não há hash ou a conta não está `ativa`). `GET /api/painel/sessao` responde 401 e apaga a sessão se a conta deixar de estar `ativa`.
  - Falhas: Redis fora do ar responde 503 `sessao_indisponivel` nas três rotas, conferido antes do banco e do Argon2 no login; falha ao gravar a sessão depois do Argon2 responde o mesmo 401 genérico, para o status não distinguir senha certa de errada.
  - Rotas atrás de `PAINEL_HABILITADO` (desligada em produção; desligada, as rotas não são registradas e respondem 404). Origens do painel em `PAINEL_ORIGENS`, lista exata e subconjunto de `CORS_ORIGENS`; ligada em produção, exige `REDIS_URL` e `PAINEL_ORIGENS`. Em `/api/painel/*`, CORS com credenciais só para essas origens; para outra origem, nem o preflight é respondido (`OPTIONS` cai no 404), e login e logout sem `Origin` do painel respondem 403 `origem_recusada` antes do Redis e do banco. Toda resposta de `/api/painel/*` leva `Cache-Control: no-store`.
  - Auditoria: `login` e `login_falhou` (sem e-mail); logout não é auditado (ação fora do vocabulário). Sem bloqueio por tentativas nem limite de taxa ainda (ADR 0013): a flag fica desligada em produção até lá.
