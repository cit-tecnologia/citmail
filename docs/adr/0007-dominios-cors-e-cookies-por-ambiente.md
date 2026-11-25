# 0007. Domínios, CORS e cookies por ambiente

Status: aceito
Data: 2026-09-25

## Contexto

O site é estático e a API é outro processo, em outro host. O navegador só entrega respostas da API a páginas de outra origem se a API enviar os cabeçalhos CORS (compartilhamento de recursos entre origens). O cookie de sessão do painel (ADR 0008) só funciona se o navegador aceitar enviá-lo à API.

Decidido pelo responsável em 2026-09-25:

- A API de produção fica em `api.citmail.com.br`.
- A homologação da API fica num subdomínio equivalente, com nome ainda a definir.
- A landing está hoje em `https://cittecnologia.github.io/citmail/` (produção) e `https://novo.citmail.com.br` (homologação), e vai migrar para `https://citmail.com.br`.

O resto deste ADR é proposta.

Ponto técnico que orienta a proposta: `cittecnologia.github.io` e `citmail.com.br` são sites diferentes (`github.io` é sufixo público). Um cookie da API enviado a partir de uma página no GitHub Pages é cookie de terceiros, e os navegadores atuais bloqueiam ou vão bloquear esse tipo de cookie. Já `novo.citmail.com.br`, `citmail.com.br` e `api.citmail.com.br` são o mesmo site, então o cookie é de primeira parte.

## Opções consideradas

### Opção 1: API em subdomínio próprio, allow-list de origens e cookie de primeira parte
A API responde CORS só para origens listadas por ambiente. O painel roda sob `citmail.com.br` e usa cookie de sessão. A landing no Pages faz só chamadas sem cookie.

### Opção 2: Painel servido pela própria API
A API entrega as páginas do painel no mesmo host. Tudo vira mesma origem e CORS some para o painel. Em troca, a API passa a servir HTML e o painel sai do fluxo de publicação estática (Pages, rsync da homologação).

### Opção 3: Token em `Authorization` em vez de cookie
O painel guarda um token e o envia no cabeçalho. Funciona entre sites, mas o token fica acessível ao JavaScript da página (risco de roubo por XSS) e a revogação exige lista de bloqueio.

## Decisão

**Decidido pelo responsável em 2026-09-25:** API de produção em `api.citmail.com.br`; homologação da API em subdomínio próprio; migração da landing para `citmail.com.br`.

**Proposto:** Opção 1. Origens permitidas por ambiente:

| Ambiente | API | Origens permitidas | `credentials` |
|---|---|---|---|
| Produção | `https://api.citmail.com.br` | `https://citmail.com.br` (depois da migração) | sim, só para a origem do painel |
| Produção | `https://api.citmail.com.br` | `https://cittecnologia.github.io` (até a migração) | não |
| Homologação | subdomínio a definir (ex.: `api.novo.citmail.com.br` ou `api-homolog.citmail.com.br`) | `https://novo.citmail.com.br` | sim, só para a origem do painel |
| Desenvolvimento | API local (`<porta-da-api>`) | `http://127.0.0.1:4200` (Vite) | sim |

Regras:

- Sem curinga (`*`) e sem refletir o `Origin` recebido. A lista vem da configuração do ambiente, com comparação exata.
- `Access-Control-Allow-Credentials: true` só para as origens do painel. Rotas públicas (consulta de domínio, orçamento, criação de pedido) aceitam também as origens da landing, sem credenciais.
- Resposta com `Vary: Origin`. Preflight com métodos e cabeçalhos explícitos.
- Cookie de sessão sem atributo `Domain` (fica preso ao host da API) e com prefixo `__Host-`. Assim o cookie da API de produção não vaza para a homologação, que está no mesmo site.
- Origem do painel após a migração: `https://citmail.com.br/painel` ou `https://painel.citmail.com.br`. Os dois servem, desde que fiquem sob `citmail.com.br`. Em aberto.
- Homologação sem dados reais de clientes (só sandbox do Asaas e conta de teste da Skymail, E2-H5).

## Justificativa

- Mantém o site estático e o fluxo de publicação atual (Pages e rsync da homologação).
- Cookie de primeira parte evita o bloqueio de cookie de terceiros e permite `HttpOnly` (ADR 0008).
- Allow-list exata impede que outro site leia respostas autenticadas da API.
- A Opção 2 mistura servir páginas com a API; a Opção 3 expõe o token ao JavaScript.

## Consequências

- **Origem compartilhada do GitHub Pages:** `https://cittecnologia.github.io` é a mesma origem para todos os repositórios da organização publicados no Pages. Qualquer um deles passa na allow-list de produção até a migração. Risco baixo: essa origem só acessa rotas públicas, sem credenciais. Some quando a origem sair da lista.
- **Painel de produção depende de uma migração sem história.** Enquanto a landing estiver no GitHub Pages, o painel com sessão real só funciona na homologação (`novo.citmail.com.br`) e em desenvolvimento. Nenhuma história cobre a migração da landing para `citmail.com.br` (a E2-H6 a deixa fora do escopo). Caminhos: criar a história de migração ou publicar o painel antes em `painel.citmail.com.br`. Registrado em "Decisões em aberto" do README.
- **Divergência com a E2-H5.** A API de homologação em subdomínio próprio contradiz a E2-H5: o critério 1 espera `https://novo.citmail.com.br/api/health`, e o critério 3 supõe a API no mesmo host do rsync do site. Ajuste proposto na seção "Ajustes de critérios em outras histórias" do README.
- Na migração: incluir `https://citmail.com.br` na allow-list, marcar essa origem com `credentials`, manter `https://cittecnologia.github.io` por um período de transição e depois removê-la. O cookie não muda, porque é preso ao host da API.
- Homologação e produção compartilham o site `citmail.com.br`: `SameSite` não os separa. A separação vem do cookie sem `Domain` e da checagem de `Origin` (ADR 0008).
- Em desenvolvimento, confirmar na #53 se o navegador aceita cookie `Secure` na origem de desenvolvimento (HTTP sem TLS). Alternativa: proxy do Vite para a API local, deixando tudo na mesma origem.
- Certificado HTTPS para o subdomínio da API de homologação, a cargo do ADR 0006.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-11-23: o checkout ganhou o mapa fixo `ORIGENS_API` (CIT-176), hoje só com `http://localhost:4200` (desenvolvimento, mesma origem). As origens publicadas da API entram nesse mapa e no `connect-src` da CSP do checkout junto com a #57, sem curinga.
- 2026-11-23: ajuste da revisão (CIT-176): `npm run dev` aberto por `http://localhost:4200` usa o modo API do checkout e exige a API local ou um mock de `POST /api/orcamento` até a #57; aberto por `http://127.0.0.1:4200` segue o modo local.
- 2026-11-24: login e painel ganharam o mesmo mapa `ORIGENS_API` do checkout (CIT-70): fora dele (Pages, homologação, `127.0.0.1`), o login mostra "Painel disponível em breve" e o painel volta ao login, sem requisição à API. A API passa a responder CORS com credenciais só em `/api/painel/*` e só para `PAINEL_ORIGENS` (subconjunto de `CORS_ORIGENS`). A aceitação do cookie `__Host-`/`Secure` em `http://localhost` pelo navegador continua não exercitada: os testes de página usam mock da API, e os atributos do cookie são provados só nos testes da API. A conferência no navegador fica para a publicação da API (#57).
