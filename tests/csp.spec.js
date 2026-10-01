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
      // interno: o handler de #btnCopyPix copia o código Pix de pagamento (#pixCode) para a área de
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
