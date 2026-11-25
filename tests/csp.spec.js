// @ts-check
import { readFileSync, readdirSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import { test as testSemErros } from '@playwright/test';
import { BASE_API, EMAIL, SENHA, mockarPainel, descartarPainel } from './painel-mock.js';

// CIT-49: landing e checkout sem handler nem script inline, com CSP por meta (ADR 0013).
// Ver .omc/plans/CIT-49.md ("Testes por critério") para o desenho de cada verificação.

const RAIZ = new URL('../', import.meta.url);

/** Regex de handler on* embutido numa tag dentro de uma string do script (innerHTML), cobrindo
 * aspas, template literal, ${...} e valor sem aspas. Mesmo regex do CA1 do plano. */
const REGEX_HANDLER_EMBUTIDO = /<[^>]*\son[a-z]+\s*=\s*(["'`\\$]|[a-z])/i;
// Mesmo regex de caminho absoluto de tests/caminhos.spec.js, aplicado aqui a assets/*.js.
const REGEX_CAMINHO_ABSOLUTO = /\b(?:href|src|action)\s*=\s*["'](\/(?!\/)[^"']*)["']/g;

// CIT-52: fontes hospedadas localmente, sem Google Fonts; font-src 'self'.
// CIT-152: style-src sem 'unsafe-inline' (CSS em assets/<página>.css; D5 do plano).
const CSP_INDEX = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";
const CSP_CHECKOUT = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self' https://viacep.com.br; object-src 'none'; base-uri 'none'; form-action 'self'";
// CIT-158: mesma política do index (sem API própria ainda; connect-src ganha a origem quando o painel chamar a API — ADR 0013 item 5).
const CSP_LOGIN_PAINEL = CSP_INDEX;
// CIT-69: pedido.html consulta só a própria origem (connect-src 'self'; revisar quando a API mudar de origem, #57) e não tem formulário.
const CSP_PEDIDO = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

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

/** Percorre os passos 1 a 5 do checkout por clique: domínio, add-ons, CEP, revisão do pedido. */
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
  await page.locator('#fCPF').fill('11122233344');
  await page.locator('#fCEP').fill('01310-000');
  await expect(page.locator('#fLogradouro')).toHaveValue('Rua Fictícia');
  await page.locator('#fNumero').fill('100');
  await page.locator('#termsCheck').check();
  await page.locator('#btnSubmitCadastro').click();

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

// CIT-70: login e painel só existem por inteiro no modo API (http://localhost:4200, com /api/painel/* mockado por
// tests/painel-mock.js); no modo local o formulário fica oculto e o painel redireciona para o login.
const SECTION_TITLES_PAINEL = {
  dashboard: 'Dashboard', email: 'E-mail', financeiro: 'Financeiro', produtos: 'Meus Produtos',
  marketplace: 'Marketplace', dns: 'DNS', configuracoes: 'Configurações', suporte: 'Suporte',
};
/** Percorre os fluxos do login por clique, exceto o login válido (fica de fora porque zera window.__csp ao
 * navegar — ver CA3 "login + redirecionamento"). Exige o modo API (baseURL = BASE_API). Devolve o estado do mock. */
async function percorrerLogin(page, estado) {
  estado ??= await mockarPainel(page, { login: 401 });
  await page.goto('login.html', { waitUntil: 'networkidle' });
  await page.locator('[data-login-acao="mostrar-senha"]').click();
  await page.locator('[data-login-acao="mostrar-senha"]').click();

  await page.locator('[data-login-acao="esqueci"]').click();
  await expect(page.locator('#forgotOverlay')).toBeVisible();
  await page.locator('#fForgotEmail').fill('teste@fixture.com.br');
  await page.locator('[data-login-acao="enviar"]').click();
  // CIT-71: o modal chama POST senha/esqueci (mock: 202 por padrão), fecha e mostra o toast fixo
  await expect(page.locator('#forgotOverlay')).toBeHidden();
  await expect(page.locator('body > div', { hasText: 'Se houver uma conta com este e-mail' })).toBeVisible();

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

  // credenciais inválidas: alerta de erro (401 mockado), sem navegar
  await page.locator('#fEmail').fill(EMAIL);
  await page.locator('#fPassword').fill('senha-errada');
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#alertError')).toBeVisible({ timeout: 5000 });
  return estado;
}

/** No mobile, o menu só existe depois de abrir a sidebar (fora da tela abaixo de 768px);
 * navigate() a fecha de novo a cada navegação — por isso reabre antes de cada item. */
async function irParaSecao(page, secao, testInfo) {
  if (testInfo?.project.name === 'mobile') await page.locator('#sidebarToggle').click();
  await page.locator(`.nav-item[data-section="${secao}"]`).click();
}

/** Percorre o painel com a sessão mockada (200): carga, menu e avatar. "Sair" fica por conta do chamador
 * (`sair()`), porque navega para o login e zera window.__csp. Exige o modo API (baseURL = BASE_API). */
async function percorrerPainel(page, testInfo) {
  const estado = await mockarPainel(page, { sessao: 200 });
  await page.goto('painel.html', { waitUntil: 'networkidle' });
  await expect(page.locator('#painelEmail')).toHaveText(EMAIL);

  for (const secao of ['email', 'financeiro', 'produtos', 'marketplace', 'dns', 'configuracoes', 'suporte', 'dashboard']) {
    await irParaSecao(page, secao, testInfo);
    await expect(page.locator(`#sec-${secao}`)).toHaveClass(/active/);
  }
  await page.locator('#topbarAvatar').click();
  await expect(page.locator('#sec-configuracoes')).toHaveClass(/active/);
  return estado;
}

/** Clica em "Sair" (abre o menu no mobile) e espera o login. */
async function sair(page, testInfo) {
  if (testInfo?.project.name === 'mobile') await page.locator('#sidebarToggle').click();
  await page.locator('.sidebar-logout').click();
  await expect(page).toHaveURL(/\/login\.html$/);
}

async function listarIrPara(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-ir-para]')].map((el, idx) => ({
    idx,
    destino: el.getAttribute('data-ir-para'),
    secao: el.closest('.section')?.id?.replace(/^sec-/, '') || null,
  })));
}

test.describe('CSP — login e painel', { tag: ['@CIT-158', '@CIT-70'] }, () => {
  // CIT-70: login e painel só têm o formulário e o conteúdo no modo API (origem em ORIGENS_API), com /api/painel/* mockado.
  test.use({ baseURL: BASE_API });

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
    descartarPainel(erros);
  });

  test('CIT-158 CA1 (b) painel: nenhum atributo on* no DOM após os fluxos por clique', async ({ page, erros }, testInfo) => {
    await percorrerPainel(page, testInfo);
    expect(await atributosOnNoDom(page)).toEqual([]);
    descartarPainel(erros);
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

      await mockarPainel(page, { sessao: 200 });
      await page.goto(arquivo, { waitUntil: 'networkidle' });
      await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
      await expect(page.locator('meta[charset] + meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);

      const content = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
      expect(content).toBe(CSP_LOGIN_PAINEL);
      descartarPainel(erros);
    });
  }

  test('CIT-158 CA3 login + redirecionamento: zero violação de CSP em login.html e em painel.html', async ({ page, erros }) => {
    await registrarViolacoesCsp(page);
    const estado = await percorrerLogin(page);
    // window.__csp é lido ainda em login.html, antes do redirecionamento (zera ao navegar).
    expect(await violacoesCsp(page), 'violações de CSP no login').toEqual([]);

    estado.login = 204; // CIT-70: agora o servidor aceita a credencial (a sessão passa a existir)
    await page.locator('#fEmail').fill(EMAIL);
    await page.locator('#fPassword').fill(SENHA);
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/painel\.html/, { timeout: 10000 });
    await expect(page.locator('#painelEmail')).toHaveText(EMAIL);

    // o coletor é reaplicado pelo page.addInitScript em toda navegação; lido de novo já em painel.html.
    expect(await violacoesCsp(page), 'violações de CSP no painel após o redirecionamento').toEqual([]);
    descartarPainel(erros);
  });

  test('CIT-158 CA3 painel: zero violação de CSP na carga, na navegação e ao sair', async ({ page, erros }, testInfo) => {
    await registrarViolacoesCsp(page);
    await percorrerPainel(page, testInfo);
    expect(await violacoesCsp(page), 'violações de CSP no painel').toEqual([]);

    await sair(page, testInfo);
    expect(await violacoesCsp(page), 'violações de CSP no login depois de sair').toEqual([]);
    descartarPainel(erros);
  });

  for (const arquivo of ['login.html', 'painel.html']) {
    testSemErros(`CIT-158 CA3 bloqueio: <script> injetado em ${arquivo} não executa e gera 1 violação de script-src`, async ({ page }) => {
      await registrarViolacoesCsp(page);
      await mockarPainel(page, { sessao: 200 });
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
      // CA5 é desktop por desenho do plano; no mobile o menu fica fora da tela (sidebar off-canvas abaixo de 768px).
      test.skip(testInfo.project.name !== 'desktop', 'CA5 é desktop apenas');
    });

    test('CIT-158 CA5 navegação: cada [data-ir-para] leva à seção certa', async ({ page, erros }) => {
      await mockarPainel(page, { sessao: 200 });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      const casos = await listarIrPara(page);
      expect(casos.length, 'há ao menos um [data-ir-para]').toBeGreaterThan(0);

      for (const c of casos) {
        await test.step(`#${c.idx} -> ${c.destino}`, async () => {
          if (c.secao) await page.locator(`.nav-item[data-section="${c.secao}"]`).click();
          await page.locator('[data-ir-para]').nth(c.idx).click();
          await expect(page.locator('#topbarTitle')).toHaveText(SECTION_TITLES_PAINEL[c.destino]);
        });
      }
      descartarPainel(erros);
    });

    test('CIT-70 o painel não tem [data-toast], [data-abrir-modal], modais nem tabela de DNS (conteúdo fictício removido)', async ({ page, erros }) => {
      await mockarPainel(page, { sessao: 200 });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      for (const seletor of ['[data-toast]', '[data-abrir-modal]', '[data-fechar-modal]', '.modal-overlay', '[data-dns-acao]', '#dnsTableBody']) {
        await expect(page.locator(seletor), seletor).toHaveCount(0);
      }
      descartarPainel(erros);
    });
  });

  test.describe('CA8 — escape', () => {
    test('CIT-158 CA8 e-mail forjado em "esqueci a senha" aparece como texto', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await page.locator('[data-login-acao="esqueci"]').click();
      const emailForjado = '<b/id=x>a@b.co';
      await page.locator('#fForgotEmail').fill(emailForjado);
      await page.locator('[data-login-acao="enviar"]').click();

      // CIT-71: o toast é fixo (202 do mock) e não repete o e-mail digitado: nada é interpretado como HTML
      await expect(page.locator('body > div', { hasText: 'Se houver uma conta com este e-mail' })).toBeVisible();
      await expect(page.locator('body > div', { hasText: 'Se houver uma conta com este e-mail' })).not.toContainText(emailForjado);
      expect(await page.locator('#x').count(), 'elemento injetado não deveria existir').toBe(0);
      descartarPainel(erros);
    });

    test('CIT-70 CA8 e-mail forjado vindo de GET /sessao aparece como texto no painel', async ({ page, erros }) => {
      const forjado = '<b id=x>a</b>@exemplo.com.br';
      await mockarPainel(page, { sessao: 200, email: forjado });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#painelEmail')).toHaveText(forjado);
      expect(await page.locator('#x').count(), 'elemento injetado não deveria existir').toBe(0);
      descartarPainel(erros);
    });
  });

  test.describe('CA6 — mobile', () => {
    test('CIT-158 CA6 sidebar abre pelo toggle e fecha pelo backdrop e ao escolher item do menu', async ({ page, erros }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
      await mockarPainel(page, { sessao: 200 });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);

      await page.locator('#sidebarToggle').click();
      await expect(page.locator('#sidebar')).toHaveClass(/open/);
      // --sidebar-w é 248px; clicar fora dela (a 390px) garante não cair sobre o <aside>, que
      // intercepta o ponteiro na área que cobre (o backdrop ocupa a tela inteira por baixo dele).
      await page.locator('#sidebarBackdrop').click({ position: { x: 390, y: 50 } });
      await expect(page.locator('#sidebar')).not.toHaveClass(/open/);

      await page.locator('#sidebarToggle').click();
      await page.locator('.nav-item[data-section="email"]').click();
      await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
      descartarPainel(erros);
    });

    for (const largura of [320, 375]) {
      test(`CIT-158 CA6 ${largura}px: sem overflow horizontal no login (modal aberto) e no painel (menu aberto)`, async ({ page, erros }, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
        await page.setViewportSize({ width: largura, height: 800 });
        await mockarPainel(page, { sessao: 200 });

        await page.goto('login.html', { waitUntil: 'networkidle' });
        await page.locator('[data-login-acao="esqueci"]').click();
        await expect(page.locator('#forgotOverlay')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `login ${largura}px sem overflow horizontal`).toBe(true);

        await page.goto('painel.html', { waitUntil: 'networkidle' });
        await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
        await page.locator('#sidebarToggle').click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `painel ${largura}px sem overflow horizontal`).toBe(true);
        descartarPainel(erros);
      });
    }
  });
});

// CIT-152: style-src sem 'unsafe-inline' — CSS de cada página em assets/<página>.css, e nenhum estilo inline em HTML nem em markup montado por script.
// Ver .omc/plans/CIT-152.md ("Critérios de aceite" e "Testes por critério").

const PAGINAS_152 = ['index.html', 'checkout.html', 'login.html', 'painel.html', 'pedido.html', 'definir-senha.html'];
const CSP_POR_PAGINA_152 = { 'index.html': CSP_INDEX, 'checkout.html': CSP_CHECKOUT, 'login.html': CSP_LOGIN_PAINEL, 'painel.html': CSP_LOGIN_PAINEL, 'pedido.html': CSP_PEDIDO, 'definir-senha.html': CSP_LOGIN_PAINEL };
const FOLHA_DA_PAGINA = { 'index.html': 'landing', 'checkout.html': 'checkout', 'login.html': 'login', 'painel.html': 'painel', 'pedido.html': 'pedido', 'definir-senha.html': 'definir-senha' };
const SCRIPTS_152 = readdirSync(new URL('assets/', RAIZ)).filter(n => n.endsWith('.js')).map(n => `assets/${n}`);

/** Estilo inline proibido (CA1): <style>, atributo style= dentro de uma tag (HTML ou string/template JS;
 * ignora o CSSOM .style.x =), setAttribute('style' e createElement('style'. */
const REGEX_ESTILO_INLINE = [
  /<style\b/gi,
  /<[^>]*\sstyle\s*=/gi,
  /setAttribute\(\s*["']style/g,
  /createElement\(\s*["']style/g,
];

/** Ocorrências de cada regex como "arquivo:linha: trecho". */
function achadosComLinha(arquivo, fonte, regexes) {
  return regexes.flatMap(re => [...fonte.matchAll(re)].map(m => {
    const linha = fonte.slice(0, m.index).split('\n').length;
    const fim = m.index + m[0].length;
    return `${arquivo}:${linha}: ${fonte.slice(Math.max(fonte.lastIndexOf('\n', fim - 1) + 1, fim - 80), fim).trim()}`;
  }));
}

/** Cor calculada de uma propriedade com var(token), lida de um elemento sonda (como checkout.spec.js). */
async function corDoToken(page, token) {
  return page.evaluate(tok => {
    const sonda = document.createElement('div');
    sonda.style.backgroundColor = `var(${tok})`;
    document.body.appendChild(sonda);
    const cor = getComputedStyle(sonda).backgroundColor;
    sonda.remove();
    return cor;
  }, token);
}

test.describe('CSP sem estilo inline', { tag: '@CIT-152' }, () => {

  test.describe('leitura de arquivo (sem navegador)', () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'leitura de arquivo: roda num perfil só');
    });

    test('CA1 páginas, assets/*.js e o sprite sem <style>, sem atributo style= em tag e sem setAttribute/createElement de style', () => {
      // o sprite entra porque é parseado na página (DOMParser no smoke de ícones): style= nele vira violação style-src-attr
      const achados = [...PAGINAS_152, ...SCRIPTS_152, 'assets/icons.svg']
        .flatMap(arquivo => achadosComLinha(arquivo, lerFonte(arquivo), REGEX_ESTILO_INLINE));
      expect(achados, 'estilo inline (arquivo:linha)').toEqual([]);
    });

    test('CA2 cada página tem uma única meta CSP, logo após o charset, com o content exato de D5 e sem exceção inline', () => {
      for (const arquivo of PAGINAS_152) {
        const html = lerFonte(arquivo);
        const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)].map(m => m[1]);
        expect(metas, `${arquivo}: metas CSP`).toHaveLength(1);
        const [tag1, tag2] = primeirasTagsDoHead(html);
        expect(tag1, `${arquivo}: primeira tag do head`).toMatch(/^<meta\s+charset=/i);
        expect(tag2, `${arquivo}: segunda tag do head`).toMatch(/http-equiv="Content-Security-Policy"/i);
        expect(metas[0], `${arquivo}: content da CSP`).toBe(CSP_POR_PAGINA_152[arquivo]);
        expect(metas[0], `${arquivo}: exceção para estilo/script inline`).not.toMatch(/unsafe-inline|unsafe-hashes|sha256-|nonce-/);
      }
    });

    test('CA6 head da landing: preload da fonte, fonts.css, tokens.css e landing.css?v=, nessa ordem, sem <style>', () => {
      const head = lerFonte('index.html').replace(/<!--[\s\S]*?-->/g, '').split(/<\/head>/i)[0];
      const hrefs = [...head.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi)].map(m => m[1]);
      const pos = re => hrefs.findIndex(h => re.test(h));
      const ordem = [/montserrat-700\.woff2$/, /^assets\/fonts\.css$/, /^assets\/tokens\.css$/, /^assets\/landing\.css\?v=\d+$/].map(pos);
      expect(ordem.every(i => i >= 0), `links do head: ${hrefs.join(', ')}`).toBe(true);
      expect([...ordem].sort((a, b) => a - b), 'ordem preload → fonts.css → tokens.css → landing.css').toEqual(ordem);
      expect(head).not.toMatch(/<style\b/i);
    });

    test('CA7 toda referência a assets/(landing|checkout|login|painel).css tem ?v=<número>', () => {
      const RE_FOLHA = /assets\/(landing|checkout|login|painel|pedido|definir-senha)\.css[^"'`\s)>]*/g;
      const referencias = [...PAGINAS_152, 'assets/checkout.js']
        .flatMap(arquivo => [...lerFonte(arquivo).matchAll(RE_FOLHA)].map(m => ({ arquivo, ref: m[0], folha: m[1] })));
      // cada página referencia a própria folha (o pop-up do boleto saiu na CIT-63)
      for (const arquivo of PAGINAS_152) {
        expect(referencias.some(r => r.arquivo === arquivo && r.folha === FOLHA_DA_PAGINA[arquivo]),
          `${arquivo} deveria referenciar assets/${FOLHA_DA_PAGINA[arquivo]}.css`).toBe(true);
      }
      const semVersao = referencias.filter(r => !/\?v=\d+$/.test(r.ref)).map(r => `${r.arquivo}: ${r.ref}`);
      expect(semVersao, 'referência sem ?v=<número>').toEqual([]);
    });

    test('CA8 landing.js não estiliza o CTA por CSSOM (o estado desabilitado vem de [aria-disabled])', () => {
      const fonte = lerFonte('assets/landing.js');
      expect(fonte, 'CSSOM no #calcCtaBtn').not.toMatch(/ctaBtn\.style\b/);
    });
  });

  test('CA3 landing: calculadora até "Total de tabela", CTA habilitado e desabilitado, sem violação de CSP', async ({ page, erros }) => {
    await registrarViolacoesCsp(page);
    await page.goto('index.html', { waitUntil: 'networkidle' });
    await page.locator('#card5 .qty-btn[data-qtd-delta="1"]').click();
    await expect(page.locator('#csSummaryLines .cs-line', { hasText: 'Total de tabela' })).toBeVisible();
    await expect(page.locator('#calcCtaBtn')).not.toHaveAttribute('aria-disabled');
    await page.locator('#card5 .qty-btn[data-qtd-delta="-1"]').click();
    await expect(page.locator('#calcCtaBtn')).toHaveAttribute('aria-disabled', 'true');
    expect(await violacoesCsp(page), 'violações de CSP na landing').toEqual([]);
  });

  test('CA3 checkout: indicador de passos com o ícone check sem violação de CSP', async ({ page, erros }) => {
    await registrarViolacoesCsp(page);
    await page.goto('checkout.html', { waitUntil: 'networkidle' });
    await page.locator('#ckCard5 .mini-qty-btn').last().click();
    await page.locator('#step1 .btn-primary').click();
    await expect(page.locator('#sc1 .icon use')).toHaveAttribute('href', 'assets/icons.svg#check');
    await expect(page.locator('#sc1 .icon')).toBeVisible();
    expect(await violacoesCsp(page), 'violações de CSP no checkout').toEqual([]);
  });

  // CIT-70: login e painel exigem o modo API (baseURL = BASE_API) com /api/painel/* mockado.
  test.describe('login e painel (modo API)', () => {
    test.use({ baseURL: BASE_API });

    test('CA3 login: toast "Se houver uma conta..." com svg.icon e Escape sem violação de CSP', async ({ page, erros }) => {
      await registrarViolacoesCsp(page);
      await mockarPainel(page);
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await page.locator('[data-login-acao="esqueci"]').click();
      await page.locator('#fForgotEmail').fill('teste@fixture.com.br');
      await page.locator('[data-login-acao="enviar"]').click();
      const toast = page.locator('body > div', { hasText: 'Se houver uma conta com este e-mail, enviaremos um link em instantes.' });
      await expect(toast).toBeVisible();
      await expect(toast.locator('svg.icon')).toBeVisible();
      await page.locator('[data-login-acao="esqueci"]').click();
      await page.keyboard.press('Escape');
      await expect(page.locator('#forgotOverlay')).toBeHidden();
      expect(await violacoesCsp(page), 'violações de CSP no login').toEqual([]);
      descartarPainel(erros);
    });

    test('CA3 painel: erro de "Sair" mostra o toast com o ícone e sem violação de CSP', async ({ page, erros }, testInfo) => {
      await registrarViolacoesCsp(page);
      await mockarPainel(page, { sessao: 200, logout: 503 });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      if (testInfo.project.name === 'mobile') await page.locator('#sidebarToggle').click();
      await page.locator('.sidebar-logout').click();
      const toast = page.locator('#toastWrap .toast', { hasText: 'Não foi possível sair' });
      await expect(toast).toBeVisible();
      await expect(toast.locator('.icon')).toBeVisible();
      expect(await violacoesCsp(page), 'violações de CSP no painel').toEqual([]);
      descartarPainel(erros);
    });

    test('CA8 login: Escape com o modal fechado não chama closeForgot; com o modal aberto, fecha', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        // @ts-ignore
        window.__fechamentos = 0;
        // @ts-ignore
        const original = window.closeForgot;
        // @ts-ignore
        window.closeForgot = function () { window.__fechamentos++; return original(); };
      });
      const fechamentos = () => page.evaluate(() => /** @type {any} */ (window).__fechamentos);

      await expect(page.locator('#forgotOverlay')).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.locator('#forgotOverlay')).toBeHidden();
      expect(await fechamentos(), 'Escape com o modal fechado não deveria fechar nada').toBe(0);

      await page.locator('[data-login-acao="esqueci"]').click();
      await expect(page.locator('#forgotOverlay')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#forgotOverlay')).toBeHidden();
      expect(await fechamentos(), 'Escape com o modal aberto fecha uma vez').toBe(1);
      descartarPainel(erros);
    });
  });

  test('CA8/CA9 landing: CTA desabilitado com o carrinho vazio e habilitado após escolher um plano', async ({ page, erros }) => {
    await page.goto('index.html', { waitUntil: 'networkidle' });
    const cta = page.locator('#calcCtaBtn');
    await expect(cta).toHaveAttribute('aria-disabled', 'true');
    await expect(cta).toHaveCSS('pointer-events', 'none');
    await expect(cta).toHaveCSS('opacity', '0.45');
    await expect(cta).toHaveCSS('justify-content', 'center');

    await page.locator('#card5 .qty-btn[data-qtd-delta="1"]').click();
    await expect(cta).not.toHaveAttribute('aria-disabled');
    // hoje o CSSOM grava 'all'; com o estado por [aria-disabled] passa ao padrão 'auto' — ambos clicáveis
    await expect(cta).toHaveCSS('pointer-events', /^(auto|all)$/);
    await expect(cta).toHaveCSS('opacity', '1');
    await expect(cta).toHaveAttribute('href', /checkout\.html\?/);

    await page.locator('#card5 .qty-btn[data-qtd-delta="-1"]').click();
    await expect(cta).toHaveAttribute('aria-disabled', 'true');
    await expect(cta).toHaveCSS('pointer-events', 'none');
    await expect(cta).toHaveCSS('opacity', '0.45');
  });

  test('CA8 checkout: painéis ocultos na carga aparecem e somem como hoje', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2', { waitUntil: 'networkidle' });
    for (const id of ['step1Error', 'domainNewPanel', 'domainExistPanel', 'step2Error', 'domExtrasCampos', 'addonsSubtotal', 'cnpjRow']) {
      await expect(page.locator(`#${id}`), `#${id} oculto na carga`).toBeHidden();
    }

    await page.evaluate(() => goStep(2));
    await page.locator('#doptBr').click();
    await expect(page.locator('#domainNewPanel')).toBeVisible();
    await expect(page.locator('#domainExistPanel')).toBeHidden();
    await page.locator('#doptExist').click();
    await expect(page.locator('#domainExistPanel')).toBeVisible();
    await expect(page.locator('#domainNewPanel')).toBeHidden();

    await page.evaluate(() => goStep(3));
    const secaoDominio = page.locator('#step3 .addon-sec-btn')
      .filter({ has: page.locator('.addon-sec-nome', { hasText: /^Domínio secundário$/ }) });
    await secaoDominio.click();
    await page.locator('button[data-addon="extraDom"][data-addon-delta="1"]').click();
    await expect(page.locator('#domExtrasCampos')).toBeVisible();
    await page.locator('button[data-addon="extraDom"][data-addon-delta="-1"]').click();
    await expect(page.locator('#domExtrasCampos')).toBeHidden();
    // subtotal só soma add-ons mensais (o domínio extra é anual, em fatura própria)
    await page.locator('button[data-addon="grupoEmail"][data-addon-delta="1"]').click();
    await expect(page.locator('#addonsSubtotal')).toBeVisible();
    await page.locator('button[data-addon="grupoEmail"][data-addon-delta="-1"]').click();
    await expect(page.locator('#addonsSubtotal')).toBeHidden();

    await page.evaluate(() => goStep(4));
    await page.locator('[data-doc-tipo="cnpj"]').click();
    await expect(page.locator('#cnpjRow')).toBeVisible();
    await expect(page.locator('#cpfRow')).toBeHidden();
    await page.locator('[data-doc-tipo="cpf"]').click();
    await expect(page.locator('#cnpjRow')).toBeHidden();
    await expect(page.locator('#cpfRow')).toBeVisible();
  });

  test('CA9 landing: títulos de seção com margin-top 14px e avatares do mockup com o fundo de cada token', async ({ page, erros }) => {
    await page.goto('index.html', { waitUntil: 'networkidle' });
    const titulos = ['E-mail, domínio e proteção', 'Consulte o domínio', 'Pague só pelas contas', 'Do pagamento ao e-mail ativo',
      'Sua equipe gerencia', 'Serviços extras para', 'Perguntas frequentes', 'E-mail com o domínio da empresa'];
    for (const texto of titulos) {
      await expect(page.locator('h2', { hasText: texto }), `h2 "${texto}"`).toHaveCSS('margin-top', '14px');
    }

    const avatares = [['CL', '--cit-blue-500'], ['MK', '--cit-turquoise-800'], ['FN', '--cit-blue-700'], ['DI', '--cit-neutral-600']];
    for (const [sigla, token] of avatares) {
      await expect(page.locator('.avatar', { hasText: new RegExp(`^${sigla}$`) }), `.avatar ${sigla}`)
        .toHaveCSS('background-color', await corDoToken(page, token));
    }
  });
});
