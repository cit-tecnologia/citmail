# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versionamento semântico.

## [Não lançado]

Ambiente de desenvolvimento e processo: história CIT-12 no Taiga.

### Adicionado
- Vite como servidor de desenvolvimento (`npm run dev`), no mesmo subcaminho `/citmail/` do GitHub Pages.
- Testes E2E com Playwright (`npm test`), em desktop e mobile: páginas sem erros, ícones do sprite existentes e recursos locais com caminho relativo.
- Workflow de CI que roda os testes em PRs para `develop` e `main`.
- Fluxo de desenvolvimento de história no `CLAUDE.md`.
- Publicação automática da `develop` na homologação (`https://novo.citmail.com.br`), com testes antes e smoke depois do deploy (CIT-13).
- Testes de páginas rodam contra um site publicado com `CITMAIL_BASE_URL` (CIT-13).
- Testes E2E dos ajustes de textos e componentes da landing e do checkout (CIT-15).
- Testes E2E de layout, rolagem e tipografia do checkout (CIT-19).
- Checkout: aviso de desconto no passo de add-ons (CIT-21).
- Testes E2E dos preços, da sanfona e do aviso de desconto dos add-ons (CIT-21).
- Preço de tabela riscado ao lado do preço cobrado, no checkout (passos 1 e 3) e na landing (cards e calculadora). O preço de tabela é o atual ÷ 0,85, arredondado em centavos, e o preço cobrado não muda (CIT-22).
- Checkout e landing: cascata de descontos por item ("−15% contratação", "−20% anual" ou "−5% volume") e "Você economiza R$ X/mês", com o valor anual no plano anual. A linha "−15% contratação" soma a diferença entre tabela e preço atual de cada item, e não 15% da tabela exibida: 5 contas de 5 GB mostram −R$ 8,80, não −R$ 8,82 (CIT-22).
- `assets/precos.js`: fonte única de preços e da regra de desconto, compartilhada pela landing e pelo checkout, inclusive a montagem da cascata, conferida no build e no smoke da homologação (CIT-22).
- Testes E2E dos preços com desconto e testes que fixam os valores cobrados antes da mudança (CIT-22).
- Registros de decisão de arquitetura (ADRs) do back-end em `docs/adr/`: organização da API, framework HTTP, banco e migrações, fila e eventos, execução na VPS, CORS e cookies, sessão do painel, consulta de domínio, e-mail transacional, alertas, fonte única de preços e segurança, com anexos de modelo de dados e eventos de domínio (CIT-47).
- API em `api/` (Node.js, Fastify e PostgreSQL): `GET /api/health` com o estado do banco (200 ou 503), migrações SQL com `node-pg-migrate`, validação por schema com erro 400 por campo, CORS por lista de origens do ambiente, log JSON com `requestId` e dados sensíveis mascarados, PostgreSQL local por Docker Compose e testes com `node:test` que rodam sem internet. O `api/README.md` traz o setup e a Definition of Done da API (CIT-53).
- CI da API em todo PR para `develop` e `main`: lint (ESLint) e testes com PostgreSQL de serviço (job `api`) e scan de segredos nos commits do PR com gitleaks e regras em `.gitleaks.toml` (job `segredos`), ambos exigidos para o merge (CIT-54).
- API: log de requisição em uma linha JSON (`request completed`) com `reqId` igual ao `x-request-id`, método, rota, IP, status e duração, sem query string nem valores da URL; linha `request aborted` quando o cliente desiste; jobs registram início, fim ou falha com o mesmo `reqId` da requisição que os disparou (`executarJob`, com job de exemplo fora de produção); máscara ampliada para 41 campos sensíveis (dados pessoais do pedido e do cliente do Asaas, como CPF/CNPJ, nascimento, CEP e endereço, e o token de cartão do webhook) em até 4 níveis, mais os campos de erro do `pg` (inclusive em `err.cause`); `resumoEventoAsaas` define o que do webhook do Asaas pode ir para o log; retenção de até 30 dias dos logs técnicos em journald, com um namespace por ambiente (`api/deploy/journald-namespace.conf`), registrada no ADR 0013 (CIT-55).
- API: fila de jobs com Redis e BullMQ e processo worker separado (`npm run worker`): novas tentativas com backoff exponencial (padrão 8 tentativas a partir de 60 s), job que falha de vez vai para "falhou" e gera alerta no Telegram só com ids (no máximo 20 por minuto; o excedente espera); o Redis não guarda mensagem nem pilha do erro do job (erro saneado, `stackTraceLimit: 0`), reprocessamento por `npm run reprocessar -- <jobId>` (id validado); encerramento do worker espera os alertas em curso, retenção limitada de concluídos (24 h) e falhos (30 dias); `POST /api/exemplos/job` passa a só enfileirar (202; 503 com a fila fora); configuração separada por processo (API, worker, CLI); Redis no `compose.yaml` e no CI (CIT-56).
- Testes E2E dos textos, do FAQ, das contas 4→5, dos links e do mobile da landing (CIT-50).

### Alterado
- Landing: o título do hero carrega mais cedo, com a fonte pré-carregada e sem o CSS do Google Fonts bloqueando a renderização; no Lighthouse local (mobile, mediana de 5, servidor local: medida relativa, não de produção) o LCP caiu de ~3,1 s para ~2,2 s (CIT-52).
- Landing e checkout: logo do cabeçalho em WebP (12 KB em vez de 25 KB), sem mudança visual (CIT-52).
- Landing: novos textos do hero (título, subtítulo e indicadores), da faixa de confiança e da seção Recursos (CIT-15).
- Landing: busca de domínio com um único "@" como prefixo e sem a extensão .com (CIT-15).
- Toggle do plano anual fica verde quando ativo, na landing e no checkout (CIT-15).
- Mínimo de 2 contas passa a valer só para o plano de 5 GB (CIT-15).
- Marketplace com os novos serviços, sem preços e sem os cards de Servidores e DevOps (CIT-15).
- Checkout: barra de etapas com os rótulos abaixo dos círculos, sem sobrepor o resumo do pedido (CIT-19).
- Checkout: coluna única até 960px, com rolagem até a barra de etapas ao trocar de passo (CIT-19).
- Checkout: resumo do pedido com rolagem interna quando não cabe na janela e acessível por teclado (CIT-19).
- Checkout: fontes maiores nas etapas, nos cards e no resumo do pedido (CIT-19).
- Checkout: ajustes de transbordo no webmail, nos add-ons e no Skybox (CIT-19).
- Checkout: add-ons em seções recolhíveis (Armazenamento em nuvem, Talk, Backup e Domínio secundário), com subtotal no cabeçalho da seção fechada; Grupo de E-mail fica fora das seções (CIT-21).
- Checkout: botões − e + e campos de quantidade dos add-ons com nome acessível próprio (CIT-21).
- Checkout: preços dos add-ons numa tabela única, usada no passo 3, no subtotal e no resumo (CIT-21).
- Checkout: linhas de add-ons sem cursor de clique nem destaque ao passar o mouse (CIT-21).
- Checkout: título do passo de add-ons como `h2` (CIT-21).
- Landing: o plano anual passa a seguir a regra do checkout, com 20% de desconto e sem o desconto por volume; o total exibido do anual com 5 ou mais contas do mesmo tipo sobe para o valor que o checkout já cobrava. O selo e a dica de volume aparecem só no plano mensal (CIT-22).
- Landing: cards de conta mostram "de/por" no lugar de "a partir de"; a calculadora mostra "Total de tabela" no lugar de "Subtotal s/ desc."; novos textos de desconto (CIT-22).
- Landing: até 960 px, o resumo da calculadora deixa de acompanhar a rolagem; sem transbordo horizontal nos cards a 360/412 px e na página a 320 px (CIT-22).
- Checkout e landing: valor cobrado em verde sempre que aparece ao lado do preço de tabela; aviso visível se os preços não carregarem, com o restante da página funcionando e sem o seletor Mensal/Anual na landing (CIT-22).
- Checkout: aviso dos add-ons passa a "GARANTA 15% DE DESCONTO NESTA CONTRATAÇÃO" (CIT-22).
- Checkout: valores calculados em centavos inteiros; Pix e boleto de demonstração sem erro de ponto flutuante (CIT-22).
- Checkout: o preço do registro do domínio principal (passo 2) e do domínio extra vem da mesma constante `PRECOS.dominio` em `assets/precos.js`, sem valor escrito à mão; os valores exibidos e cobrados não mudam (CIT-31).
- Actions do workflow de testes fixadas por SHA, como na homologação (CIT-54).
- Landing: textos revisados para prometer só o que o lançamento entrega: indicadores do hero ("Meta de disponibilidade" e "5 min · Ativação após o pagamento"), faixa de confiança com o horário do suporte (dias úteis, 08h00 às 18h00), recursos, busca de domínio ("parece disponível", com confirmação na contratação), como funciona, painel e marketplace; FAQ reescrito com ativação, DNS em até 48 horas, Pix/boleto (até 3 dias úteis)/cartão pela fatura do Asaas, suporte, cancelamento no fim do ciclo pago, direito de arrependimento de 7 dias e contato do encarregado de dados; `meta description` sem preço; rodapé com razão social e CNPJ e só links com destino (CIT-50).

### Removido
- `serve.py`, substituído pelo Vite.
- Landing: seção de depoimentos (volta com depoimentos reais e autorizados); recursos ainda não confirmados com a Skymail (backup automático, IA na conta de 50 GB, agenda, calendário, apelidos e os add-ons de backup, armazenamento em nuvem e Talk); chat de suporte e "500+ clientes"; links sem destino do rodapé (Sobre nós, Blog, Parceiros, redes sociais, e Política de Privacidade e Termos de Uso até as páginas existirem) (CIT-50).
- Prazo de ativação de 5 minutos dos textos da landing e do checkout (CIT-15).
- Opção de registro de domínio .com no checkout (CIT-15).

### Corrigido
- Checkout: o código Pix do domínio extra (passo 3) não muda mais ao alterar outros add-ons; só é gerado de novo quando o valor do domínio extra muda (CIT-30).
- Checkout: ao copiar o código Pix do pagamento, o próprio botão mostra "Copiado"; antes, o aviso aparecia no botão do Pix do domínio, no passo 2 (CIT-153).
- Checkout: clicar de novo num botão "Copiar" do Pix mantém o "Copiado" por 2 s a partir do último clique (antes, voltava a "Copiar" antes da hora); quando o navegador não deixa copiar, os botões do Pix e do boleto mostram "Erro ao copiar", deixam o código selecionado e explicam como copiar manualmente (antes, nada acontecia) (CIT-163).
- Landing: respostas do FAQ sem corte de texto a 320 px; o botão "Contratar Agora" sem contas no carrinho não leva mais ao topo da página (`href="#"`) e é anunciado como indisponível (CIT-50).

### Segurança
- Login e painel sem handlers nem scripts inline (código em `assets/login.js` e `assets/painel.js`) e com a mesma Content Security Policy por `<meta>` da landing: nenhuma página do site aceita mais script inline. Os botões que o painel redesenha (DNS) usam um listener por lista, com o valor conferido antes de agir. O host, o valor, o tipo e a prioridade do DNS, o e-mail do "esqueci a senha" e as mensagens de aviso passam a ser escapados ao entrar no HTML: um registro com HTML deixa de ser executado na página. O `connect-src` muda quando o login e o painel chamarem a API. O smoke da homologação confere a CSP e os novos arquivos (CIT-158).
- Login e painel também passam a usar as fontes do próprio site (`assets/fonts.css`), sem Google Fonts: nenhuma página envia mais o IP do visitante ao Google para carregar fontes (CIT-156).
- Landing e checkout sem Google Fonts: Montserrat e Poppins servidas do próprio site (`assets/fonts/`, subset latin, licença OFL), e a CSP deixa de liberar os domínios do Google. O navegador do visitante não envia mais o IP ao Google ao abrir essas páginas (CIT-52).
- Landing e checkout sem handlers nem scripts inline (código em `assets/landing.js` e `assets/checkout.js`) e com Content Security Policy por `<meta>`: scripts só da própria origem, sem `unsafe-inline` nem `unsafe-eval`, e conexões externas só para o ViaCEP no checkout. `style-src` ainda mantém `'unsafe-inline'` (issue #152); a CSP por cabeçalho, com `frame-ancestors`, fica com a #94, e o `connect-src` e o `img-src` mudam quando as páginas chamarem a API e o Pix do Asaas. O smoke da homologação confere a CSP e os novos arquivos (CIT-49).
- Arquivos de ambiente locais (`.env`, `.env.*` e `.envrc`, exceto `.env.example`) ignorados pelo Git e com leitura negada a agentes (`.claude/settings.json`); regra de segredos documentada: só nos environments do GitHub ou em arquivo de ambiente com permissão 600 no servidor, nunca no repositório (CIT-46).

## [1.0.0] - 2026-09-13

Primeira versão publicada. Migra o site para o [Brandbook CIT v1.0](https://github.com/cittecnologia/brandbook-cit): história US#2 no Taiga, PR #2.

### Adicionado
- `assets/tokens.css` com os tokens do brandbook: cores, tipografia, espaçamento, raio, sombra e movimento.
- Logos oficiais do CITMail em `assets/brand/`, com favicon e apple-touch-icon.
- Sprite de ícones `assets/icons.svg`: biblioteca do brandbook, complementos Lucide e marcas parceiras.
- Download do boleto em PDF no checkout, pela página de impressão.
- Tecla ESC fecha modais e menus; `aria-label` em todos os botões só com ícone.

### Alterado
- Landing, login, checkout e painel com os componentes do brandbook:
  - base branca e navy nos blocos escuros;
  - botões 32/40/48 com raio 8;
  - badges e alertas com cores funcionais.
- Fonte Inter substituída por Montserrat (títulos e números) e Poppins (texto). Texto só em 16, 13 e 11 px, e títulos na escala responsiva.
- Textos revisados conforme Voz & Tom:
  - sem superlativos;
  - frases curtas com evidência;
  - slogan oficial literal.
- `serve.py` serve a pasta do próprio script, de qualquer diretório.

### Removido
- Font Awesome e emojis usados como ícone.
- Gradientes, sombras decorativas e cores fora da paleta.

### Corrigido
- Transbordo horizontal no mobile do checkout e do painel.
- Resumo do pedido fixo cobria o formulário no mobile.
- Vão no menu mobile da landing.
- "Configurar DNS" levava a Configurações.
- Card de propagação DNS espremido no mobile.
- Contrastes abaixo de WCAG AA.

### Pendente
- Meta description e card do marketplace dizem "a partir de R$ 19,90/mês", mas a tabela de planos começa em R$ 10,00 por conta. A definição de preço está com o PO.

[1.0.0]: https://github.com/cittecnologia/citmail/compare/e8b8810...v1.0.0
