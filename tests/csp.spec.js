// @ts-check
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import { test as testSemErros } from '@playwright/test';

// CIT-49: landing e checkout sem handler nem script inline, com CSP por meta (ADR 0013).
// Ver .omc/plans/CIT-49.md ("Testes por critério") para o desenho de cada verificação.

const RAIZ = new URL('../', import.meta.url);

/** Regex de handler on* embutido numa tag dentro de uma string do script (innerHTML), cobrindo
 * aspas, template literal, ${...} e valor sem aspas. Mesmo regex do CA1 do plano. */
const REGEX_HANDLER_EMBUTIDO = /<[^>]*\son[a-z]+\s*=\s*(["'`\\$]|[a-z])/i;
// Mesmo regex de caminho absoluto de tests/caminhos.spec.js, aplicado aqui a assets/*.js.
const REGEX_CAMINHO_ABSOLUTO = /\b(?:href|src|action)\s*=\s*["'](\/(?!\/)[^"']*)["']/g;

// CIT-52: fontes hospedadas localmente, sem Google Fonts; font-src 'self'.
const CSP_INDEX = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";
const CSP_CHECKOUT = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self' https://viacep.com.br; object-src 'none'; base-uri 'none'; form-action 'self'";
// CIT-158: mesma política do index (sem API própria ainda; connect-src ganha a origem quando o painel chamar a API — ADR 0013 item 5).
const CSP_LOGIN_PAINEL = CSP_INDEX;

function lerFonte(nome) {
  return readFileSync(new URL(nome, RAIZ), 'utf8');
}

/** Primeiras duas tags do <head> no arquivo-fonte (antes de qualquer reescrita do Vite). */
function primeirasTagsDoHead(html) {
  const head = html.slice(html.search(/<head[^>]*>/i));
  return [...head.matchAll(/<(meta|link|script|title|style|base)\b[^>]*>/gi)].slice(0, 2).map(m => m[0]);
}

/** Registra em window.__csp as violações de CSP da própria página (não do pop-up). Chamar antes do goto. */
async function registrarViolacoesCsp(page) {
  await page.addInitScript(() => {
    // @ts-ignore
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => {
      // @ts-ignore
      window.__csp.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
    });
  });
}

async function violacoesCsp(page) {
  return page.evaluate(() => /** @type {any} */ (window).__csp || []);
}

/** Atributos on* que sobrarem em qualquer elemento do DOM (pega markup montado por innerHTML). */
async function atributosOnNoDom(page) {
  return page.evaluate(() => [...document.querySelectorAll('*')]
    .flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => `${el.tagName} ${a.name}`)));
}

/** Mocka o ViaCEP com um endereço fictício (sem rede externa). */
async function mockarViaCep(page) {
  await page.route('https://viacep.com.br/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ logradouro: 'Rua Fictícia', bairro: 'Bairro Teste', localidade: 'São Paulo', uf: 'SP' }),
  }));
}

/** Neutraliza w.print() do pop-up (senão trava o teste headless); não altera o código, só o teste. */
async function neutralizarPrintDoPopup(page) {
  await page.addInitScript(() => {
    const abrirOriginal = window.open;
    // @ts-ignore
    window.open = function (...args) {
      // @ts-ignore
      const w = abrirOriginal.apply(window, args);
      if (w) w.print = () => {};
      return w;
    };
  });
}

/** Percorre os fluxos por clique da landing: quantidades, ciclo, FAQ, menu mobile, domínio, voltar ao topo. */
async function percorrerLanding(page) {
  await page.goto('index.html', { waitUntil: 'networkidle' });

  await page.locator('#card5 .qty-btn[data-qtd-delta="1"]').click();
  await page.locator('#card5 .qty-btn[data-qtd-delta="-1"]').click();
  await page.locator('#qty5').fill('3');
  await page.locator('#qty5').press('Tab'); // dispara o "change" -> updateQty

  await page.locator('#toggleAnnual').click();
  await page.locator('#toggleMonthly').click();
  await page.locator('#billingToggle').click();
  await page.locator('#billingToggle').click(); // volta ao mensal
  await page.locator('.faq-item').first().locator('.faq-question').click();

  const navToggle = page.locator('#navToggle');
  if (await navToggle.isVisible()) {
    await navToggle.click();
    await expect(page.locator('#header')).toHaveClass(/nav-mobile-open/);
    await navToggle.click();
  }

  await page.locator('.tld-chip[data-tld=".net.br"]').click();
  await page.locator('#domainInput').fill('minhaempresateste');
  await page.locator('#domainCheckBtn').click();
  await expect(page.locator('#domainResult .domain-available, #domainResult .domain-taken')).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 800));
  await expect(page.locator('#scrollTop')).toHaveClass(/visible/);
  await page.locator('#scrollTop').click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

/** Percorre os passos 1 a 5 do checkout por clique: domínio, add-ons, CEP, formas de pagamento. */
async function percorrerCheckout(page) {
  await mockarViaCep(page);
  await page.goto('checkout.html', { waitUntil: 'networkidle' });

  // passo 1: contas
  await page.locator('#ckCard5 .mini-qty-btn').last().click();
  await page.locator('#ckQty5').fill('3');
  await page.locator('#ckQty5').press('Tab'); // dispara o "change" -> ckUpdateQty
  await page.locator('#step1 .btn-primary').click();

  // passo 2: domínio
  await page.locator('#doptBr').click();
  await page.locator('#fDomNew').fill('minhaempresateste');
  await page.locator('#step2 .btn-primary').click();

  // passo 3: add-ons
  const secaoNuvem = page.locator('#step3 .addon-sec-btn')
    .filter({ has: page.locator('.addon-sec-nome', { hasText: /^Armazenamento em nuvem$/ }) });
  await secaoNuvem.click();
  await page.getByRole('button', { name: 'Aumentar Grupo de E-mail', exact: true }).click();
  await secaoNuvem.click();
  await page.locator('#step3 .btn-primary').click();

  // passo 4: cadastro + CEP (fictício); alterna para CNPJ e volta para CPF no caminho
  await page.locator('[data-doc-tipo="cnpj"]').click();
  await expect(page.locator('#cnpjRow')).toBeVisible();
  await page.locator('[data-doc-tipo="cpf"]').click();
  await expect(page.locator('#cpfRow')).toBeVisible();

  await page.locator('#fNome').fill('Maria Fictícia');
  await page.locator('#fEmail').fill('maria@fixture.teste');
  await page.locator('#fTelefone').fill('11999998888');
  await page.locator('#fSenha').fill('senhaFicticia1');
  await page.locator('#fCPF').fill('11122233344');
  await page.locator('#fCEP').fill('01310-000');
  await expect(page.locator('#fLogradouro')).toHaveValue('Rua Fictícia');
  await page.locator('#fNumero').fill('100');
  await page.locator('#termsCheck').check();
  await page.locator('#btnSubmitCadastro').click();

  // passo 5 -> 6: formas de pagamento (Pix selecionado ao final) e confirmação
  await page.locator('#payBoleto .payment-name').click();
  await page.locator('#payCard .payment-name').click();
  await page.locator('#fCardNum').fill('4111111111111111');
  await page.locator('#payPix .payment-name').click();
  await expect(page.locator('#payPix')).toHaveClass(/selected/);
  await page.locator('#btnPagar').click();
  await expect(page.locator('#step6')).toHaveClass(/active/, { timeout: 10000 });
}

test.describe('CSP — landing e checkout', { tag: '@CIT-49' }, () => {

  test('CA1 (a) HTML fonte da landing e do checkout: nenhum <script> inline nem atributo on*', async ({ page }) => {
    for (const arquivo of ['index.html', 'checkout.html']) {
      const html = lerFonte(arquivo);
      const achados = await page.evaluate(fonte => {
        const doc = new DOMParser().parseFromString(fonte, 'text/html');
        const scriptsInline = [...doc.querySelectorAll('script:not([src])')].length;
        const onAttrs = [...doc.querySelectorAll('*')]
          .flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => `${el.tagName} ${a.name}`));
        return { scriptsInline, onAttrs };
      }, html);
      expect(achados.scriptsInline, `${arquivo}: <script> sem src`).toBe(0);
      expect(achados.onAttrs, `${arquivo}: atributo on*`).toEqual([]);
    }
  });

  test('CA1 (b) landing: nenhum atributo on* no DOM após os fluxos por clique', async ({ page, erros }) => {
    await percorrerLanding(page);
    expect(await atributosOnNoDom(page)).toEqual([]);
  });

  test('CA1 (b) checkout: nenhum atributo on* no DOM após os fluxos por clique', async ({ page, erros }) => {
    await percorrerCheckout(page);
    expect(await atributosOnNoDom(page)).toEqual([]);
  });

  test('CA1 (c)/(d) assets/landing.js e assets/checkout.js: sem handler on* embutido em string nem caminho absoluto', () => {
    for (const arquivo of ['assets/landing.js', 'assets/checkout.js']) {
      const fonte = lerFonte(arquivo);
      expect(fonte, `${arquivo}: handler on* embutido em string`).not.toMatch(REGEX_HANDLER_EMBUTIDO);
      const absolutos = [...fonte.matchAll(REGEX_CAMINHO_ABSOLUTO)].map(m => m[1]);
      expect(absolutos, `${arquivo}: caminho absoluto`).toEqual([]);
    }
  });

  for (const [arquivo, cspEsperada] of [['index.html', CSP_INDEX], ['checkout.html', CSP_CHECKOUT]]) {
    test(`CA2 meta CSP única, na posição certa do head e com o content exato — ${arquivo}`, { tag: '@CIT-52' }, async ({ page, erros }) => {
      const [tag1, tag2] = primeirasTagsDoHead(lerFonte(arquivo));
      expect(tag1, 'primeira tag do head').toMatch(/^<meta\s+charset=/i);
      expect(tag2, 'segunda tag do head').toMatch(/http-equiv="Content-Security-Policy"/i);

      await page.goto(arquivo, { waitUntil: 'networkidle' });
      await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
      await expect(page.locator('meta[charset] + meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);

      const content = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
      expect(content).toBe(cspEsperada);
      const scriptSrc = content?.match(/script-src [^;]*/)?.[0] ?? '';
      expect(scriptSrc, 'script-src não pode ter unsafe-inline/unsafe-eval').not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(content).toContain("base-uri 'none'");
    });
  }

  test('CA3 landing: zero violação de CSP na carga e nos fluxos por clique', async ({ page, erros }) => {
    await registrarViolacoesCsp(page);
    await percorrerLanding(page);
    expect(await violacoesCsp(page), 'violações de CSP na landing').toEqual([]);
  });

  test('CA3 checkout: zero violação de CSP na carga e nos fluxos por clique', async ({ page, erros }) => {
    await registrarViolacoesCsp(page);
    await percorrerCheckout(page);
    expect(await violacoesCsp(page), 'violações de CSP no checkout').toEqual([]);
  });

  test('CA3 checkout: pop-up do boleto sem violação de CSP e com o título correto', async ({ page, erros }) => {
    await neutralizarPrintDoPopup(page);
    await mockarViaCep(page);
    await page.goto('checkout.html', { waitUntil: 'networkidle' });

    await page.locator('#ckCard5 .mini-qty-btn').last().click();
    await page.locator('#step1 .btn-primary').click();
    await page.locator('#doptBr').click();
    await page.locator('#fDomNew').fill('minhaempresateste');
    await page.locator('#step2 .btn-primary').click();
    await page.locator('#step3 .btn-primary').click();
    await page.locator('#fNome').fill('Maria Fictícia');
    await page.locator('#fEmail').fill('maria@fixture.teste');
    await page.locator('#fTelefone').fill('11999998888');
    await page.locator('#fSenha').fill('senhaFicticia1');
    await page.locator('#fCPF').fill('11122233344');
    await page.locator('#fCEP').fill('01310-000');
    await page.locator('#fNumero').fill('100');
    await page.locator('#termsCheck').check();
    await page.locator('#btnSubmitCadastro').click();
    await page.locator('#payBoleto .payment-name').click();

    // registrado antes do clique que abre o pop-up, sem corrida com a abertura.
    const mensagens = [];
    page.context().on('console', msg => mensagens.push(msg));
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#downloadBoleto').click();
    const popup = await popupPromise;

    await expect(popup.locator('h1')).toHaveText('Boleto CITMail');

    const mensagensDoPopup = mensagens
      .filter(m => m.page() === popup && (m.type() === 'error' || /Content Security Policy/i.test(m.text())))
      .map(m => m.text());
    expect(mensagensDoPopup, 'violações de CSP no pop-up do boleto').toEqual([]);

    await popup.close();
  });

  for (const arquivo of ['index.html', 'checkout.html']) {
    testSemErros(`CA3 bloqueio: <script> injetado em ${arquivo} não executa e gera 1 violação de script-src`, async ({ page }) => {
      await registrarViolacoesCsp(page);
      await page.goto(arquivo, { waitUntil: 'networkidle' });

      await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__injetado = 1;';
        document.body.append(s);
      });
      await page.waitForFunction(() => /** @type {any} */ (window).__csp?.length > 0);

      const injetado = await page.evaluate(() => /** @type {any} */ (window).__injetado);
      expect(injetado, 'script injetado não deveria executar').toBeUndefined();

      const violacoes = await violacoesCsp(page);
      expect(violacoes, 'deveria haver exatamente 1 violação').toHaveLength(1);
      expect(violacoes[0].violatedDirective).toMatch(/^script-src/);
    });
  }

  test.describe('CA5 — aninhados e vínculos (checkout)', () => {
    test.beforeEach(async ({ page }) => {
      await neutralizarPrintDoPopup(page);
      await page.goto('checkout.html', { waitUntil: 'networkidle' });
      // O passo 5 (pagamento) não é o alvo destes testes (CA1/CA3 já provam a navegação por
      // clique entre passos); ir direto a ele evita repetir os passos 1-4 em cada subteste.
      await page.evaluate(() => goStep(5));
    });

    test('CA5 (a) com o cartão selecionado, copiar o Pix aciona o handler interno (clipboard) e seleciona #payPix por bubbling', { tag: '@CIT-153' }, async ({ page, context, erros }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('#payCard .payment-name').click();
      await expect(page.locator('#payCard')).toHaveClass(/selected/);

      const codigoPix = await page.locator('#pixCode').textContent();

      // #btnCopyPix fica oculto com o cartão selecionado (.pix-panel só é exibido com
      // #payPix.selected); dispatchEvent ignora a checagem de visibilidade do Playwright, como o
      // executor precisou fazer.
      await page.locator('#btnCopyPix').dispatchEvent('click');

      // o aviso "Copiado" aparece no próprio #btnCopyPix e não no botão do Pix do domínio (CIT-153);
      // conferido antes da área de transferência porque dura só 2 s
      await expect(page.locator('#btnCopyPix')).toContainText('Copiado');
      await expect(page.locator('#btnCopyDomPix')).not.toContainText('Copiado');
      // interno: copyPix() copia o código Pix de pagamento (#pixCode) para a área de
      // transferência — prova que o handler do próprio #btnCopyPix rodou (não só o bubbling).
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(codigoPix);
      // externo: bubbling até o listener de #payPix
      await expect(page.locator('#payPix')).toHaveClass(/selected/);
    });

    test('CA5 (b) com o cartão selecionado, baixar o boleto seleciona #payBoleto por bubbling', async ({ page, erros }) => {
      await page.locator('#payCard .payment-name').click();
      await expect(page.locator('#payCard')).toHaveClass(/selected/);

      // #downloadBoleto fica oculto com o cartão selecionado (.boleto-panel só é exibido com
      // #payBoleto.selected); dispatchEvent ignora a checagem de visibilidade.
      const popupPromise = page.waitForEvent('popup');
      await page.locator('#downloadBoleto').dispatchEvent('click');
      const popup = await popupPromise;
      await expect(page.locator('#payBoleto')).toHaveClass(/selected/);
      await popup.close();
    });

    test('CA5 (c) com o Pix selecionado, digitar no número do cartão seleciona #payCard', async ({ page, erros }) => {
      await page.locator('#payPix .payment-name').click();
      await expect(page.locator('#payPix')).toHaveClass(/selected/);

      // #fCardNum fica oculto enquanto o cartão não está selecionado (.card-panel só aparece
      // com #payCard.selected); dispatchEvent ignora a checagem de visibilidade só neste
      // primeiro clique, que seleciona o cartão por bubbling e revela o campo.
      await page.locator('#fCardNum').dispatchEvent('click');
      await expect(page.locator('#payCard')).toHaveClass(/selected/);
      await page.locator('#fCardNum').pressSequentially('4111111111111111');
      await expect(page.locator('#fCardNum')).toHaveValue('4111 1111 1111 1111');
    });
  });

  test('CA5 (e) vínculos restantes: cópia do Pix do domínio/extra e do boleto, validade do cartão', async ({ page, context, erros }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockarViaCep(page);
    await page.goto('checkout.html', { waitUntil: 'networkidle' });

    // passo 2: domínio novo — #btnCopyDomPix (escopado a #domPixBox .pix-copy, sem o bug do #btnCopyPix)
    await page.evaluate(() => goStep(2));
    await page.locator('#doptBr').click();
    await page.locator('#fDomNew').fill('minhaempresateste');
    const codigoDomPix = await page.locator('#domPixCode').textContent();
    await page.locator('#btnCopyDomPix').click();
    await expect(page.locator('#btnCopyDomPix')).toContainText('Copiado');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(codigoDomPix);

    // passo 3: domínio extra — #btnCopyExtraDomPix
    await page.evaluate(() => goStep(3));
    const secaoDominio = page.locator('#step3 .addon-sec-btn')
      .filter({ has: page.locator('.addon-sec-nome', { hasText: /^Domínio secundário$/ }) });
    await secaoDominio.click();
    await page.locator('button[data-addon="extraDom"][data-addon-delta="1"]').click();
    await expect(page.locator('#extraDomPixPanel')).toBeVisible();
    const codigoExtraPix = await page.locator('#extraDomPixCode').textContent();
    await page.locator('#btnCopyExtraDomPix').click();
    await expect(page.locator('#btnCopyExtraDomPix')).toContainText('Copiado');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(codigoExtraPix);

    // passo 5: validade do cartão (#fCardExp) e cópia do código do boleto (#btnCopyBoleto, usa alert)
    await page.evaluate(() => goStep(5));
    await page.locator('#payCard .payment-name').click();
    await page.locator('#fCardExp').fill('1225');
    await expect(page.locator('#fCardExp')).toHaveValue('12/25');

    await page.locator('#payBoleto .payment-name').click();
    const codigoBoleto = (await page.locator('#boletoCode').textContent())?.trim();
    page.once('dialog', d => d.accept());
    await page.locator('#btnCopyBoleto').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(codigoBoleto);
  });

  test('CA5 (d) clicar em #scrollTop rola a página ao topo (landing)', async ({ page, erros }) => {
    await page.goto('index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => window.scrollTo(0, 800));
    await expect(page.locator('#scrollTop')).toHaveClass(/visible/);
    await page.locator('#scrollTop').click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('CA6 menu mobile abre e fecha por clique real sem violação de CSP', async ({ page, erros }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
    await registrarViolacoesCsp(page);
    await page.goto('index.html', { waitUntil: 'networkidle' });

    const navToggle = page.locator('#navToggle');
    await navToggle.click();
    await expect(page.locator('#header')).toHaveClass(/nav-mobile-open/);
    await page.locator('.nav-links a').first().click();
    await expect(page.locator('#header')).not.toHaveClass(/nav-mobile-open/);

    expect(await violacoesCsp(page), 'violações de CSP no menu mobile').toEqual([]);
  });
});

// CIT-158: login e painel sem handler nem script inline, com CSP por meta, delegação limitada no
// DNS e esc() no texto do usuário. Ver .omc/plans/CIT-158.md ("Testes por critério") e as Decisões
// (atributos genéricos fixados, modelo assets/checkout.js:753-783).

// Atributos únicos do login (login.js, vinculados por data-login-acao).
const MODAIS_PAINEL = ['modalDnsRecord', 'modalNovaContaEmail', 'modalNovoTicket', 'modalVerTicket', 'modalContratarConsultoria', 'modalContratarServidor'];
const SECTION_TITLES_PAINEL = {
  dashboard: 'Dashboard', email: 'E-mail', financeiro: 'Financeiro', produtos: 'Meus Produtos',
  marketplace: 'Marketplace', dns: 'DNS', configuracoes: 'Configurações', suporte: 'Suporte',
};
const ABA_TEXTO = { 'tab-perfil': 'Perfil', 'tab-seguranca': 'Segurança', 'tab-notif': 'Notificações' };

/** Percorre os fluxos do login por clique, exceto o redirecionamento com credenciais demo (fica de
 * fora porque zera window.__csp — ver CA3 "login + redirecionamento"). */
async function percorrerLogin(page) {
  await page.goto('login.html', { waitUntil: 'networkidle' });
  await page.locator('[data-login-acao="mostrar-senha"]').click();
  await page.locator('[data-login-acao="mostrar-senha"]').click();

  await page.locator('[data-login-acao="esqueci"]').click();
  await expect(page.locator('#forgotOverlay')).toBeVisible();
  await page.locator('#fForgotEmail').fill('teste@fixture.com.br');
  await page.locator('[data-login-acao="enviar"]').click();
  await expect(page.locator('#forgotOverlay')).toBeHidden();

  await page.locator('[data-login-acao="esqueci"]').click();
  await page.locator('[data-login-acao="fechar"]').first().click(); // X
  await expect(page.locator('#forgotOverlay')).toBeHidden();

  await page.locator('[data-login-acao="esqueci"]').click();
  await page.locator('[data-login-acao="fechar"]').last().click(); // Cancelar
  await expect(page.locator('#forgotOverlay')).toBeHidden();

  await page.locator('[data-login-acao="esqueci"]').click();
  await page.locator('#forgotOverlay').click({ position: { x: 5, y: 5 } }); // overlay, fora do modal
  await expect(page.locator('#forgotOverlay')).toBeHidden();

  await page.locator('[data-login-acao="esqueci"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#forgotOverlay')).toBeHidden();

  await page.locator('#fEmail').fill('demo@citmail.com.br');
  await page.locator('#fPassword').fill('senhaErrada');
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#alertError')).toBeVisible({ timeout: 5000 });
}

/** No mobile, o menu só existe depois de abrir a sidebar (fora da tela abaixo de 768px);
 * navigate() a fecha de novo a cada navegação — por isso reabre antes de cada item. */
async function irParaSecao(page, secao, testInfo) {
  if (testInfo?.project.name === 'mobile') await page.locator('#sidebarToggle').click();
  await page.locator(`.nav-item[data-section="${secao}"]`).click();
}

/** Percorre os fluxos do painel por clique: menu, tabs, os 6 modais, plano, ticket e DNS. */
async function percorrerPainel(page, testInfo) {
  await page.goto('painel.html', { waitUntil: 'networkidle' });

  for (const secao of ['email', 'financeiro', 'produtos', 'marketplace', 'dns', 'configuracoes', 'suporte', 'dashboard']) {
    await irParaSecao(page, secao, testInfo);
    await expect(page.locator(`#sec-${secao}`)).toHaveClass(/active/);
  }
  await page.locator('#topbarAvatar').click();
  await expect(page.locator('#sec-configuracoes')).toHaveClass(/active/);

  await page.locator('[data-aba="tab-seguranca"]').click();
  await page.locator('[data-aba="tab-notif"]').click();
  await page.locator('[data-aba="tab-perfil"]').click();

  // abre pelo gatilho real (não por window.openModal) — modalDnsRecord e modalVerTicket não têm
  // data-abrir-modal (são vínculo único) e já são exercidos abaixo, no bloco do DNS e do ticket.
  const MODAIS_COM_GATILHO = { modalNovaContaEmail: 'email', modalNovoTicket: 'suporte', modalContratarConsultoria: 'marketplace', modalContratarServidor: 'marketplace' };
  for (const [modal, secao] of Object.entries(MODAIS_COM_GATILHO)) {
    await irParaSecao(page, secao, testInfo);
    // escopado à seção ativa: modalNovaContaEmail também tem gatilho no dashboard (oculto aqui
    // por CSS, mas antes de .first() no DOM) — sem o escopo, .first() cairia nele.
    await page.locator(`#sec-${secao} [data-abrir-modal="${modal}"]`).first().click();
    await expect(page.locator(`#${modal}`)).toHaveClass(/open/);
    if (modal === 'modalNovoTicket') {
      await page.locator(`#${modal}`).click({ position: { x: 5, y: 5 } }); // overlay, fora do modal
    } else {
      await page.locator(`[data-fechar-modal="${modal}"]`).first().click();
    }
    await expect(page.locator(`#${modal}`)).not.toHaveClass(/open/);
  }

  await irParaSecao(page, 'marketplace', testInfo);
  await page.locator('[data-abrir-modal="modalContratarServidor"]').click();
  await page.locator('[data-plano-opcao]').nth(1).click();
  await expect(page.locator('[data-plano-opcao]').nth(1)).toHaveClass(/selected/);
  await page.locator('[data-fechar-modal="modalContratarServidor"]').first().click();

  await irParaSecao(page, 'suporte', testInfo);
  await page.locator('[data-ver-ticket="olho"]').click();
  await expect(page.locator('#modalVerTicket')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#modalVerTicket')).not.toHaveClass(/open/);

  await irParaSecao(page, 'dns', testInfo);
  await page.locator('[data-dns-dominio="empresa.com"]').click();
  await page.locator('[data-dns-dominio="empresa.com.br"]').click();
  await page.locator('[data-dns-tipo="MX"]').click();
  await page.locator('[data-dns-tipo="Todos"]').click();
  await page.locator('#dnsSearch').fill('webmail');
  await page.locator('#dnsSearch').fill('');

  await page.locator('#btnDnsAdd').click();
  await page.locator('#dnsRType').selectOption('MX');
  await expect(page.locator('#dnsRPrioField')).toBeVisible();
  await page.locator('#dnsRHost').fill('teste');
  await page.locator('#dnsRValue').fill('valor.ficticio.teste');
  await page.locator('#btnDnsSave').click();

  await page.locator('#btnDnsCheckProp').click();
  await expect(page.locator('#toastWrap .toast', { hasText: 'DNS propagado' })).toBeVisible({ timeout: 5000 });

  page.once('dialog', d => d.accept());
  await page.locator('[data-dns-acao="excluir"][data-dns-id="1"]').click();
}

/** Lê do DOM (já no painel) cada [data-toast] com o contexto (seção/modal/aba) para abrir antes de
 * clicar — equivalente a "ler do fonte", mas pela árvore viva (não quebra com reordenação). */
async function listarToasts(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-toast]')].map((el, idx) => ({
    idx,
    texto: el.getAttribute('data-toast'),
    tipo: el.getAttribute('data-toast-tipo'),
    secao: el.closest('.section')?.id?.replace(/^sec-/, '') || null,
    modal: el.closest('.modal-overlay')?.id || null,
    aba: el.closest('.tab-panel')?.id || null,
    checkbox: el.matches('input[type="checkbox"]'),
  })));
}

async function listarIrPara(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-ir-para]')].map((el, idx) => ({
    idx,
    destino: el.getAttribute('data-ir-para'),
    secao: el.closest('.section')?.id?.replace(/^sec-/, '') || null,
  })));
}

test.describe('CSP — login e painel', { tag: '@CIT-158' }, () => {

  test('CIT-158 CA1 (a) HTML fonte do login e do painel: nenhum <script> inline nem atributo on*', async ({ page }) => {
    for (const arquivo of ['login.html', 'painel.html']) {
      const html = lerFonte(arquivo);
      const achados = await page.evaluate(fonte => {
        const doc = new DOMParser().parseFromString(fonte, 'text/html');
        const scriptsInline = [...doc.querySelectorAll('script:not([src])')].length;
        const onAttrs = [...doc.querySelectorAll('*')]
          .flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => `${el.tagName} ${a.name}`));
        return { scriptsInline, onAttrs };
      }, html);
      expect(achados.scriptsInline, `${arquivo}: <script> sem src`).toBe(0);
      expect(achados.onAttrs, `${arquivo}: atributo on*`).toEqual([]);
    }
  });

  test('CIT-158 CA1 (b) login: nenhum atributo on* no DOM após os fluxos por clique', async ({ page, erros }) => {
    await percorrerLogin(page);
    expect(await atributosOnNoDom(page)).toEqual([]);
  });

  test('CIT-158 CA1 (b) painel: nenhum atributo on* no DOM após os fluxos por clique', async ({ page, erros }, testInfo) => {
    await percorrerPainel(page, testInfo);
    expect(await atributosOnNoDom(page)).toEqual([]);
  });

  test('CIT-158 CA1 (c)/(d) assets/login.js e assets/painel.js: sem handler on* embutido em string nem caminho absoluto', () => {
    for (const arquivo of ['assets/login.js', 'assets/painel.js']) {
      const fonte = lerFonte(arquivo);
      expect(fonte, `${arquivo}: handler on* embutido em string`).not.toMatch(REGEX_HANDLER_EMBUTIDO);
      const absolutos = [...fonte.matchAll(REGEX_CAMINHO_ABSOLUTO)].map(m => m[1]);
      expect(absolutos, `${arquivo}: caminho absoluto`).toEqual([]);
    }
  });

  for (const arquivo of ['login.html', 'painel.html']) {
    test(`CIT-158 CA2 meta CSP única, na posição certa do head e com o content exato — ${arquivo}`, async ({ page, erros }) => {
      const [tag1, tag2] = primeirasTagsDoHead(lerFonte(arquivo));
      expect(tag1, 'primeira tag do head').toMatch(/^<meta\s+charset=/i);
      expect(tag2, 'segunda tag do head').toMatch(/http-equiv="Content-Security-Policy"/i);

      await page.goto(arquivo, { waitUntil: 'networkidle' });
      await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
      await expect(page.locator('meta[charset] + meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);

      const content = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
      expect(content).toBe(CSP_LOGIN_PAINEL);
    });
  }

  test('CIT-158 CA3 login + redirecionamento: zero violação de CSP em login.html e em painel.html', async ({ page, erros }) => {
    await registrarViolacoesCsp(page);
    await percorrerLogin(page);
    // window.__csp é lido ainda em login.html, antes do redirecionamento (zera ao navegar).
    expect(await violacoesCsp(page), 'violações de CSP no login').toEqual([]);

    await page.locator('#fEmail').fill('demo@citmail.com.br');
    await page.locator('#fPassword').fill('demo123');
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/painel\.html/, { timeout: 10000 });

    // o coletor é reaplicado pelo page.addInitScript em toda navegação; lido de novo já em painel.html.
    expect(await violacoesCsp(page), 'violações de CSP no painel após o redirecionamento').toEqual([]);
  });

  test('CIT-158 CA3 painel: zero violação de CSP na carga e nos fluxos por clique', async ({ page, erros }, testInfo) => {
    await registrarViolacoesCsp(page);
    await percorrerPainel(page, testInfo);
    expect(await violacoesCsp(page), 'violações de CSP no painel').toEqual([]);
  });

  for (const arquivo of ['login.html', 'painel.html']) {
    testSemErros(`CIT-158 CA3 bloqueio: <script> injetado em ${arquivo} não executa e gera 1 violação de script-src`, async ({ page }) => {
      await registrarViolacoesCsp(page);
      await page.goto(arquivo, { waitUntil: 'networkidle' });

      await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__injetado = 1;';
        document.body.append(s);
      });
      await page.waitForFunction(() => /** @type {any} */ (window).__csp?.length > 0);

      const injetado = await page.evaluate(() => /** @type {any} */ (window).__injetado);
      expect(injetado, 'script injetado não deveria executar').toBeUndefined();

      const violacoes = await violacoesCsp(page);
      expect(violacoes, 'deveria haver exatamente 1 violação').toHaveLength(1);
      expect(violacoes[0].violatedDirective).toMatch(/^script-src/);
    });
  }

  test.describe('CA5 — vínculos (painel, desktop)', () => {
    test.beforeEach(({}, testInfo) => {
      // CA5 é desktop por desenho do plano (ver "Testes por critério"); no mobile o menu fica
      // fora da tela (sidebar off-canvas abaixo de 768px) e a maioria dos seletores pressupõe
      // layout desktop.
      test.skip(testInfo.project.name !== 'desktop', 'CA5 é desktop apenas');
    });

    test('CIT-158 CA5 contagens: atributos novos batem com o inventário de 206ba52', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      // Contagens fixadas no plano contra o commit 206ba52 (ver "Testes por critério" / CA5).
      await expect(page.locator('[data-ir-para]')).toHaveCount(9);
      await expect(page.locator('[data-abrir-modal]')).toHaveCount(8);
      await expect(page.locator('[data-fechar-modal]')).toHaveCount(17);
      await expect(page.locator('[data-toast]')).toHaveCount(29);
      await expect(page.locator('input[type="checkbox"][data-toast]')).toHaveCount(4);
      await expect(page.locator('[data-fechar-modal][data-toast]')).toHaveCount(5);
      await expect(page.locator('[data-toast-tipo="success"]')).toHaveCount(16);
      await expect(page.locator('[data-toast-tipo="info"]')).toHaveCount(12);
      await expect(page.locator('[data-toast-tipo="error"]')).toHaveCount(1);

      const idsAbrir = await page.evaluate(() => [...document.querySelectorAll('[data-abrir-modal]')].map(el => el.getAttribute('data-abrir-modal')));
      const idsFechar = await page.evaluate(() => [...document.querySelectorAll('[data-fechar-modal]')].map(el => el.getAttribute('data-fechar-modal')));
      expect(idsAbrir.every(id => MODAIS_PAINEL.includes(id)), 'todo data-abrir-modal aponta para um modal da lista fixa').toBe(true);
      expect(idsFechar.every(id => MODAIS_PAINEL.includes(id)), 'todo data-fechar-modal aponta para um modal da lista fixa').toBe(true);
    });

    test('CIT-158 CA5 navegação: cada [data-ir-para] leva à seção certa', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      const casos = await listarIrPara(page);
      expect(casos, 'contagem de [data-ir-para]').toHaveLength(9);

      for (const c of casos) {
        await test.step(`#${c.idx} -> ${c.destino}`, async () => {
          if (c.secao) await page.locator(`.nav-item[data-section="${c.secao}"]`).click();
          await page.locator('[data-ir-para]').nth(c.idx).click();
          await expect(page.locator('#topbarTitle')).toHaveText(SECTION_TITLES_PAINEL[c.destino]);
        });
      }
    });

    test('CIT-158 CA5 modais: cada [data-abrir-modal] abre e cada [data-fechar-modal] fecha', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });

      const abrir = await page.evaluate(() => [...document.querySelectorAll('[data-abrir-modal]')].map(el => ({
        modal: el.getAttribute('data-abrir-modal'),
        secao: el.closest('.section')?.id?.replace(/^sec-/, '') || null,
      })));
      for (let i = 0; i < abrir.length; i++) {
        await test.step(`abrir #${i}: ${abrir[i].modal}`, async () => {
          await page.locator(`.nav-item[data-section="${abrir[i].secao}"]`).click();
          await page.locator('[data-abrir-modal]').nth(i).click();
          await expect(page.locator(`#${abrir[i].modal}`)).toHaveClass(/open/);
          await page.evaluate(id => window.closeModal(id), abrir[i].modal);
        });
      }

      const fechar = await page.evaluate(() => [...document.querySelectorAll('[data-fechar-modal]')].map(el => el.getAttribute('data-fechar-modal')));
      for (let i = 0; i < fechar.length; i++) {
        await test.step(`fechar #${i}: ${fechar[i]}`, async () => {
          await page.evaluate(id => window.openModal(id), fechar[i]);
          await page.locator('[data-fechar-modal]').nth(i).click();
          await expect(page.locator(`#${fechar[i]}`)).not.toHaveClass(/open/);
        });
      }
    });

    test('CIT-158 CA5 toasts: cada [data-toast] mostra o texto exato ao clicar', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      const casos = await listarToasts(page);
      expect(casos, 'contagem de [data-toast]').toHaveLength(29);

      for (const c of casos) {
        await test.step(`#${c.idx} "${c.texto}" (${c.tipo})`, async () => {
          if (c.modal) await page.evaluate(id => window.openModal(id), c.modal);
          else if (c.secao) await page.locator(`.nav-item[data-section="${c.secao}"]`).click();
          if (c.aba) await page.locator('.tab-btn', { hasText: ABA_TEXTO[c.aba] }).click();

          // checkboxes dos toggles de notificação são opacity:0/0x0 por design (o .toggle-knob
          // visível é irmão, não ancestral, do <input>) — fora da área clicável que o Playwright
          // aceita. O .click() nativo do elemento alterna o estado e dispara click+change, igual
          // ao usuário clicando no .toggle-knob.
          if (c.checkbox) await page.evaluate(idx => document.querySelectorAll('[data-toast]')[idx].click(), c.idx);
          else await page.locator('[data-toast]').nth(c.idx).click();
          await expect(page.locator('#toastWrap .toast span', { hasText: c.texto })).toBeVisible({ timeout: 5000 });

          await page.evaluate(() => document.querySelectorAll('#toastWrap .toast').forEach(t => t.remove()));
          if (c.modal) await page.evaluate(id => window.closeModal(id), c.modal);
        });
      }
    });

    test('CIT-158 CA5 ticket: só a 1ª linha e o 1º olho abrem o modal; a 2ª linha não abre', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await page.locator('.nav-item[data-section="suporte"]').click();
      await page.evaluate(() => {
        // @ts-ignore
        window.__chamadas = [];
        const original = window.openModal;
        // @ts-ignore
        window.openModal = function (id) { window.__chamadas.push(id); return original(id); };
      });

      await page.locator('.ticket-row').nth(1).click(); // 2ª linha, sem data-ver-ticket
      expect(await page.evaluate(() => window.__chamadas.length), '2ª linha não deveria chamar openModal').toBe(0);

      await page.locator('[data-ver-ticket="olho"]').click();
      expect(await page.evaluate(() => window.__chamadas.length), '1º olho deve chamar openModal 1 vez').toBe(1);
      await page.evaluate(() => window.closeModal('modalVerTicket'));

      await page.locator('[data-ver-ticket="linha"]').locator('.cell-sub').first().click();
      expect(await page.evaluate(() => window.__chamadas.length), '1ª linha deve abrir (acumulado = 2)').toBe(2);
    });

    test('CIT-158 CA5 DNS: navegação, filtro, busca, editar e excluir mantêm o comportamento (ordem fixa, filtro Todos no excluir)', async ({ page, erros }) => {
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await page.locator('.nav-item[data-section="dns"]').click();

      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(8);

      await page.locator('[data-dns-tipo="MX"]').click();
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(2);
      await page.locator('[data-dns-tipo="Todos"]').click();
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(8);

      await page.locator('#dnsSearch').fill('webmail');
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(1);
      await page.locator('#dnsSearch').fill('');
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(8);

      await page.locator('[data-dns-acao="editar"][data-dns-id="1"]').click();
      await expect(page.locator('#dnsRHost')).toHaveValue('@');
      await expect(page.locator('#dnsRValue')).toHaveValue('177.126.48.201');
      await page.locator('#dnsRValue').fill('177.126.48.202');
      await page.locator('#btnDnsSave').click();
      await expect(page.locator('#dnsTableBody .dns-table-row').first().locator('.dns-val')).toHaveText('177.126.48.202');

      await page.locator('[data-dns-dominio="empresa.com"]').click();
      await page.locator('[data-dns-dominio="empresa.com.br"]').click();
      await page.locator('[data-dns-acao="editar"][data-dns-id="1"]').click();
      await expect(page.locator('#dnsRValue')).toHaveValue('177.126.48.202'); // o domínio voltou intacto
      await page.locator('[data-fechar-modal="modalDnsRecord"]').first().click();

      await page.locator('[data-dns-acao="excluir"][data-dns-id="2"]').click();
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(7);
      await expect(page.locator('#dnsRecordCount')).toHaveText('7 de 7 registros');

      // "excluir" não serve para flagrar listener duplicado: dnsDeleteRecord já é idempotente
      // (early-return por findIndex quando o id não existe mais), então a 2ª chamada de um
      // listener duplicado não acha o registro e nem chega a abrir o confirm() — mascara o bug.
      // "editar" não tem esse guard (dnsOpenEditRecord acha o registro de novo todas as vezes),
      // então espiar dnsOpenEditRecord flagra a duplicação de verdade.
      await page.evaluate(() => {
        // @ts-ignore
        window.__chamadasEditar = 0;
        const original = window.dnsOpenEditRecord;
        // @ts-ignore
        window.dnsOpenEditRecord = function (id) { window.__chamadasEditar++; return original(id); };
      });
      await page.locator('.nav-item[data-section="email"]').click();
      await page.locator('.nav-item[data-section="dns"]').click();
      await page.locator('[data-dns-acao="editar"][data-dns-id="4"]').click();
      expect(await page.evaluate(() => window.__chamadasEditar), 'o listener do DNS não deveria duplicar após revisitar a seção').toBe(1);
      await page.locator('[data-fechar-modal="modalDnsRecord"]').first().click();

      await page.locator('[data-dns-acao="excluir"][data-dns-id="3"]').click();
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(6);
    });

    test('CIT-158 CA5 DNS forjado: atributo num ancestral de #dnsTableBody não é acionado pelo clique dentro de .dns-host', async ({ page, erros }) => {
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await page.locator('.nav-item[data-section="dns"]').click();
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(8);

      await page.evaluate(() => {
        const ancestral = document.getElementById('dnsTableBody').parentElement;
        ancestral.setAttribute('data-dns-acao', 'excluir');
        ancestral.setAttribute('data-dns-id', '1');
      });
      await page.locator('.dns-host').first().click();

      expect(dialogs, 'não deveria abrir confirm()').toHaveLength(0);
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(8);
    });

    test('CIT-158 CA5 DNS forjado: data-dns-id não numérico ("1abc") é ignorado', async ({ page, erros }) => {
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await page.locator('.nav-item[data-section="dns"]').click();

      await page.evaluate(() => {
        const btn = document.createElement('button');
        btn.textContent = 'forjado';
        btn.setAttribute('data-dns-acao', 'excluir');
        btn.setAttribute('data-dns-id', '1abc');
        document.getElementById('dnsTableBody').appendChild(btn);
      });
      await page.locator('#dnsTableBody').getByRole('button', { name: 'forjado' }).click();

      expect(dialogs, 'data-dns-id não numérico não deveria passar do parseInt/regex').toHaveLength(0);
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(8);
    });

    test('CIT-158 CA5 DNS forjado: chip de tipo inexistente ("xyz") mantém as 8 linhas', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await page.locator('.nav-item[data-section="dns"]').click();

      await page.evaluate(() => {
        const chip = document.createElement('button');
        chip.textContent = 'xyz';
        chip.setAttribute('data-dns-tipo', 'xyz');
        document.getElementById('dnsTypeFilters').appendChild(chip);
      });
      await page.getByRole('button', { name: 'xyz', exact: true }).click();
      await expect(page.locator('#dnsTableBody .dns-table-row')).toHaveCount(8);
    });

    test('CIT-158 CA5 DNS forjado: aba de domínio "__proto__" não muda o domínio ativo', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await page.locator('.nav-item[data-section="dns"]').click();
      // activeDnsDomain é `let` no topo de um script clássico: não vira window.activeDnsDomain,
      // mas é visível por nome no mesmo escopo léxico global. Expressão em string (sem function
      // nem eval local): sob a CSP sem 'unsafe-eval', Runtime.evaluate ainda enxerga o `let`
      // top-level, mas um eval() dentro de uma function avaliada violaria script-src.
      const antes = await page.evaluate('activeDnsDomain');

      await page.evaluate(() => {
        const aba = document.createElement('button');
        aba.textContent = '__proto__';
        aba.setAttribute('data-dns-dominio', '__proto__');
        document.getElementById('dnsDomainTabs').appendChild(aba);
      });
      await page.getByRole('button', { name: '__proto__', exact: true }).click();

      const depois = await page.evaluate('activeDnsDomain');
      expect(depois, 'domínio ativo não deveria mudar com um domínio forjado').toBe(antes);
    });
  });

  test.describe('CA8 — escape', () => {
    test('CIT-158 CA8 host/valor forjados no registro DNS aparecem como texto, nunca como marcação', async ({ page, erros }, testInfo) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await irParaSecao(page, 'dns', testInfo);
      await page.locator('#btnDnsAdd').click();

      const forjado = '"><b id=x>forjado';
      await page.locator('#dnsRHost').fill(forjado);
      await page.locator('#dnsRValue').fill(forjado);
      await page.locator('#btnDnsSave').click();

      const linha = page.locator('#dnsTableBody .dns-table-row', { hasText: 'forjado' }).first();
      await expect(linha.locator('.dns-host')).toHaveText(forjado);
      await expect(linha.locator('.dns-val')).toHaveText(forjado);
      await expect(linha.locator('.dns-host')).toHaveAttribute('title', forjado);
      expect(await page.locator('#x').count(), 'elemento injetado não deveria existir').toBe(0);
    });

    test('CIT-158 CA8 e-mail forjado em "esqueci a senha" aparece como texto', async ({ page, erros }) => {
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await page.locator('[data-login-acao="esqueci"]').click();
      const emailForjado = '<b/id=x>a@b.co';
      await page.locator('#fForgotEmail').fill(emailForjado);
      await page.locator('[data-login-acao="enviar"]').click();

      await expect(page.locator('body')).toContainText(emailForjado);
      expect(await page.locator('#x').count(), 'elemento injetado não deveria existir').toBe(0);
    });

    test('CIT-158 CA8 showToast com marcação forjada mostra o texto literal', async ({ page, erros }) => {
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await page.evaluate(() => window.showToast('<b id=x>forjado</b>', 'info'));
      await expect(page.locator('#toastWrap .toast span')).toHaveText('<b id=x>forjado</b>');
      expect(await page.locator('#x').count(), 'elemento injetado não deveria existir').toBe(0);
    });
  });

  test.describe('CA6 — mobile', () => {
    test('CIT-158 CA6 sidebar abre pelo toggle e fecha pelo backdrop e ao escolher item do menu', async ({ page, erros }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
      await page.goto('painel.html', { waitUntil: 'networkidle' });

      await page.locator('#sidebarToggle').click();
      await expect(page.locator('#sidebar')).toHaveClass(/open/);
      // --sidebar-w é 248px; clicar fora dela (a 390px) garante não cair sobre o <aside>, que
      // intercepta o ponteiro na área que cobre (o backdrop ocupa a tela inteira por baixo dele).
      await page.locator('#sidebarBackdrop').click({ position: { x: 390, y: 50 } });
      await expect(page.locator('#sidebar')).not.toHaveClass(/open/);

      await page.locator('#sidebarToggle').click();
      await page.locator('.nav-item[data-section="email"]').click();
      await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
    });

    for (const largura of [320, 375]) {
      test(`CIT-158 CA6 ${largura}px: sem overflow horizontal no login (modal aberto) e no painel (DNS aberto)`, async ({ page, erros }, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
        await page.setViewportSize({ width: largura, height: 800 });

        await page.goto('login.html', { waitUntil: 'networkidle' });
        await page.locator('[data-login-acao="esqueci"]').click();
        await expect(page.locator('#forgotOverlay')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `login ${largura}px sem overflow horizontal`).toBe(true);

        await page.goto('painel.html', { waitUntil: 'networkidle' });
        await page.locator('#sidebarToggle').click();
        await page.locator('.nav-item[data-section="dns"]').click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `painel ${largura}px sem overflow horizontal`).toBe(true);
      });
    }
  });
});
