// @ts-check
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
// CIT-22: guarda de carga (assets/precos.js não carrega) — espera erro de propósito, por isso usa o
// `test` puro do Playwright em vez da fixture `erros` (que falharia com qualquer erro registrado).
import { test as testSemErros } from '@playwright/test';

// CIT-15: ajuste de textos e componentes do checkout (checkout.html).
// Cada teste roda nos dois perfis configurados em playwright.config.js (desktop e mobile).

/**
 * Cor calculada de var(--cit-success) na página, lida de um elemento sonda,
 * para os testes não fixarem o valor do token.
 * @param {import('@playwright/test').Page} page
 */
async function corSucesso(page) {
  return page.evaluate(() => {
    const sonda = document.createElement('div');
    sonda.style.backgroundColor = 'var(--cit-success)';
    document.body.appendChild(sonda);
    const cor = getComputedStyle(sonda).backgroundColor;
    sonda.remove();
    return cor;
  });
}

// CIT-19: layout, rolagem e tipografia do checkout (checkout.html).

/**
 * Tamanho de fonte computado de uma variável CSS, lido de um elemento sonda,
 * para os testes de tipografia não fixarem o valor do token.
 * @param {import('@playwright/test').Page} page
 * @param {string} token nome da variável CSS, ex.: '--cit-text-small'
 */
async function tamanhoToken(page, token) {
  return page.evaluate((tok) => {
    const sonda = document.createElement('div');
    sonda.style.fontSize = `var(${tok})`;
    document.body.appendChild(sonda);
    const tam = getComputedStyle(sonda).fontSize;
    sonda.remove();
    return tam;
  }, token);
}

/**
 * CIT-22: cor computada de um token de cor qualquer (ex.: '--cit-error', '--cit-success-strong'),
 * lida de um elemento sonda, para os testes não fixarem o valor do token.
 * @param {import('@playwright/test').Page} page
 * @param {string} token
 */
async function corToken(page, token) {
  return page.evaluate((tok) => {
    const sonda = document.createElement('div');
    sonda.style.backgroundColor = `var(${tok})`;
    document.body.appendChild(sonda);
    const cor = getComputedStyle(sonda).backgroundColor;
    sonda.remove();
    return cor;
  }, token);
}

/**
 * CIT-22: contraste (WCAG) entre a cor do texto e o fundo efetivo (compõe os fundos dos ancestrais
 * com alfa até opacidade total), para uma lista de seletores, num único evaluate.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} seletores
 * @returns {Promise<Record<string, number>>}
 */
async function contrastes(page, seletores) {
  return page.evaluate((sels) => {
    const rgba = (/** @type {string} */ c) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (/** @type {number[]} */ [r, g, b]) => {
      const f = (/** @type {number} */ v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fundo = (/** @type {Element} */ el) => {
      const camadas = [];
      for (let e = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        const a = c.length > 3 ? c[3] : 1;
        if (a > 0) camadas.push([c[0], c[1], c[2], a]);
        if (a >= 1) break;
      }
      let cor = [255, 255, 255];
      for (const [r, g, b, a] of camadas.reverse()) cor = [r * a + cor[0] * (1 - a), g * a + cor[1] * (1 - a), b * a + cor[2] * (1 - a)];
      return cor;
    };
    const contraste = (/** @type {string} */ sel) => {
      const el = /** @type {Element} */ (document.querySelector(sel));
      const l1 = lum(rgba(getComputedStyle(el).color).slice(0, 3));
      const l2 = lum(fundo(el));
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    return Object.fromEntries(sels.map(sel => [sel, contraste(sel)]));
  }, seletores);
}

/**
 * CIT-22: espera o scroll do documento estabilizar (3 frames seguidos com o mesmo scrollY) antes de
 * medir `window.scrollY` como referência. `html { scroll-behavior: smooth }` (checkout.html) anima o
 * scrollIntoView que o Playwright faz sozinho antes de cliques/preenchimentos; sem esperar, a leitura
 * "antes" pode cair no meio dessa animação e a leitura "depois" já com ela terminada, sem relação com
 * a rolagem do resumo que o teste está medindo.
 * @param {import('@playwright/test').Page} page
 */
async function esperarScrollEstavel(page) {
  await page.evaluate(() => new Promise((resolve) => {
    let ultimo = -1, estavel = 0;
    const checar = () => {
      const y = window.scrollY;
      if (y === ultimo) estavel++; else { estavel = 0; ultimo = y; }
      if (estavel >= 3) resolve(undefined); else requestAnimationFrame(checar);
    };
    requestAnimationFrame(checar);
  }));
}

/**
 * Mede a barra de etapas (#stepsBar) no passo indicado: transbordo do documento e da
 * própria barra, posição em relação ao resumo (duas colunas), rótulo ativo, rótulos
 * cortados/fora da .main-col e tamanho dos círculos. Mesma lógica dos scripts de
 * medição do architect (scratchpad/cit19/exec-medir.cjs).
 * @param {import('@playwright/test').Page} page
 * @param {number} passo
 */
async function medirBarra(page, passo) {
  return page.evaluate(async (n) => {
    goStep(n);
    // Força o layout do passo novo (dispara o carregamento de fontes ainda não usadas) e espera as fontes.
    void document.body.offsetWidth;
    await document.fonts.ready;
    const doc = document.documentElement;
    const bar = document.getElementById('stepsBar');
    const mc = document.querySelector('.main-col');
    const sum = document.getElementById('orderSummary');
    const mcR = mc.getBoundingClientRect();
    const sumR = sum.getBoundingClientRect();
    const barRight = Math.max(...[...bar.children].map(k => k.getBoundingClientRect().right));
    const labels = [...bar.querySelectorAll('.step-label')].filter(l => getComputedStyle(l).display !== 'none');
    const ativo = bar.querySelector('.step-label.active');
    const duasColunas = getComputedStyle(document.querySelector('.checkout-wrapper')).gridTemplateColumns.trim().split(/\s+/).length > 1;
    return {
      docOverflow: doc.scrollWidth - doc.clientWidth,
      barOverflow: bar.scrollWidth - bar.clientWidth,
      mcWidth: mcR.width,
      barRight, sumLeft: sumR.left, duasColunas,
      nLabels: labels.length,
      ativoVisivel: !!ativo && getComputedStyle(ativo).display !== 'none',
      ativoCortado: ativo ? ativo.scrollWidth > ativo.clientWidth + 1 : true,
      labelsCortados: labels.filter(l => {
        const b = l.getBoundingClientRect();
        return l.scrollWidth > l.clientWidth + 1 || b.left < mcR.left - 0.5 || b.right > mcR.right + 0.5;
      }).map(l => l.id),
      circulos: [...bar.querySelectorAll('.step-circle')].map(c => {
        const b = c.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      }),
    };
  }, passo);
}

/**
 * Preenche o checkout com dados pesados (quantidades altas nos 3 planos, todos os
 * add-ons, Skybox 1 TB e domínio/e-mail fictícios longos) para os testes de
 * transbordo e do resumo. Chama direto as funções globais do checkout.html: se alguma
 * deixar de existir, o teste falha.
 * @param {import('@playwright/test').Page} page
 */
async function preencherCheckoutPesado(page) {
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) { ckChangeQty('5gb', 1); ckChangeQty('25gb', 1); ckChangeQty('50gb', 1); }
    ['talk', 'backup90', 'backup365', 'grupoEmail', 'skybox', 'extraDom'].forEach(k => { for (let i = 0; i < 40; i++) addonChange(k, 1); });
    selectSkybox('1tb');
    selectDomainOpt('new-br');
    document.getElementById('fDomNew').value = 'empresaficticiacomnomebemcomprido';
    onDomNewInput();
    document.getElementById('successWebmail').textContent = 'webmail.empresaficticiacomnomemuitolongoparateste.com.br';
    document.getElementById('successEmail').textContent = 'contato.financeiro@empresaficticiacomnomemuitolongo.com.br';
  });
}

/**
 * Lê num único evaluate o font-size computado de TODAS as ocorrências de cada seletor.
 * Elementos que casam com um seletor de exceção são agrupados na chave da exceção.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} seletores
 * @param {string[]} excecoes
 * @returns {Promise<Record<string, string[]>>}
 */
async function lerFontes(page, seletores, excecoes = []) {
  return page.evaluate(([sels, excs]) => {
    /** @type {Record<string, string[]>} */
    const res = {};
    for (const sel of [...sels, ...excs]) res[sel] = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const exc = excs.find(e => el.matches(e));
        res[exc || sel].push(getComputedStyle(el).fontSize);
      }
    }
    return res;
  }, [seletores, excecoes]);
}

// Larguras da barra: limiares do container (coluna 300px ↔ 331/332; coluna 500px ↔ 543/544)
// e do grid (960/961), além de larguras comuns.
const LARGURAS_BARRA = [320, 331, 332, 412, 500, 521, 543, 544, 744, 960, 961, 1024, 1243, 1920];
// Rótulos visíveis esperados por largura, fixados a partir da geometria medida (coluna ≈ 92% da largura
// até 960px): 543 → coluna 499,6px → só o ativo; 544 → coluna 500,5px → todos.
// O limite de 500px deixa folga para as métricas da fonte no Linux (6 rótulos ≈ 472px) e no Windows (≈ 453px).
const ROTULOS_POR_LARGURA = /** @type {Record<number, number>} */ ({
  320: 1, 331: 1, 332: 1, 412: 1, 500: 1, 521: 1, 543: 1,
  544: 6, 744: 6, 960: 6, 961: 6, 1024: 6, 1243: 6, 1920: 6,
});
// Círculos da barra por largura: 32px só com coluna < 300px (320 → 288px, 331 → 299px).
const CIRCULO_POR_LARGURA = /** @type {Record<number, number>} */ ({ 320: 32, 331: 32 });

// Seletores cujo font-size deve ser var(--cit-text-small) após a CIT-19 (tarefa #24).
// .sum-empty fica de fora: só existe com o checkout vazio (lido à parte).
const SELETORES_TIPO_SMALL = [
  '.step-label', '.step-circle',
  '.mini-row-price', '.mini-row-tabela', '.mini-row-disc', '.cycle-toggle .left',
  '.opt-desc', '.opt-price-note', '.domain-tld', '.domain-at',
  '.field label', '.field-hint', '.field-error', '.doc-type-btn', '.terms-check',
  '.payment-desc', '.pix-box-title', '.pix-box--sm .pix-box-title', '.pix-box-desc', '.pix-copy-label', '.pix-note', '.pix-copy', '.pix-timer', '.pix-status', '.asaas-notice',
  '.access-label', '.access-value', '.access-item', '.success-help',
  '.alert-box', '.btn-back-row',
  '.summary-plan-cycle', '.sum-lines', '.sum-disc', '.sum-economia', '.summary-feature', '.secure-badge', '.summary-total .period',
];
// Seletores cujo font-size deve ser var(--cit-text-body).
const SELETORES_TIPO_BODY = [
  '.mini-row-name', '.mini-qty-val', '.mini-row-sub', '.mini-row-sub-tabela',
  '.opt-name',
  '.field input', '.field select', '.installments-select',
];
// Passo 3 (add-ons), incluindo o cabeçalho das seções da sanfona, o indicador de subtotal e o aviso de desconto (CIT-21).
const SELETORES_TIPO_SMALL_PASSO3 = [
  '.addon-desc', '.addon-price', '.addon-price-tabela', '.addon-period', '.sky-opts-title', '.sky-opt-name', '.sky-opt-price', '.sky-opt-price-tabela', '.sky-qty-label', '.addon-sub-line', '.addons-subtotal-head',
  '.addon-sec-ind', '.aviso-desconto-texto',
];
const SELETORES_TIPO_BODY_PASSO3 = ['.addon-name', '.addon-sub-val', '.addon-sec-nome', '.aviso-desconto-titulo'];
// Exceções documentadas: alertas com explicação longa usam o corpo de leitura (16px), ver checkout.html.
const EXCECOES_TIPO_BODY = ['#domainExistPanel .alert-box', '.boleto-inner .alert-box'];

test.describe('checkout — ciclo de cobrança', { tag: '@CIT-15' }, () => {
  test('toggle do ciclo fica verde com ?cycle=annual e alterna ao clicar', async ({ page, erros }) => {
    await page.goto('checkout.html?cycle=annual');
    const verde = await corSucesso(page);
    const toggle = page.locator('#cycleMini');
    await expect(toggle).toHaveCSS('background-color', verde);

    await page.locator('#cycleToggle').click();
    await expect(toggle).not.toHaveCSS('background-color', verde);

    await page.locator('#cycleToggle').click();
    await expect(toggle).toHaveCSS('background-color', verde);
  });
});

test.describe('checkout — quantidade de contas', { tag: '@CIT-15' }, () => {
  test('quantidade mínima por tipo via parâmetros de URL (qty5=1&qty25=1&qty50=-3)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=1&qty25=1&qty50=-3');
    await expect(page.locator('#ckQty5')).toHaveValue('2');
    await expect(page.locator('#ckQty25')).toHaveValue('1');
    await expect(page.locator('#ckQty50')).toHaveValue('0');
  });

  test('parâmetros de URL inválidos ou fracionários (qty50=1&qty5=abc&qty25=2.7)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty50=1&qty5=abc&qty25=2.7');
    await expect(page.locator('#ckQty50')).toHaveValue('1');
    await expect(page.locator('#ckQty5')).toHaveValue('0');
    await expect(page.locator('#ckQty25')).toHaveValue('2');
  });

  test('plano de 5 GB: botões e digitação respeitam o mínimo de 2 contas', async ({ page, erros }) => {
    await page.goto('checkout.html');
    const botoes = page.locator('#ckCard5 .mini-qty-btn');
    const diminuir = botoes.first();
    const aumentar = botoes.last();
    const input = page.locator('#ckQty5');

    await aumentar.click();
    await expect(input).toHaveValue('2');

    // abaixo do mínimo zera em um único clique
    await diminuir.click();
    await expect(input).toHaveValue('0');

    await input.fill('1');
    await input.press('Tab');
    await expect(input).toHaveValue('2');

    await input.fill('-3');
    await input.press('Tab');
    await expect(input).toHaveValue('0');
  });

  test('plano de 5 GB: diminuir de 3 contas vai para 2', async ({ page, erros }) => {
    await page.goto('checkout.html');
    const input = page.locator('#ckQty5');
    await input.fill('3');
    await input.press('Tab');
    await expect(input).toHaveValue('3');

    await page.locator('#ckCard5 .mini-qty-btn').first().click();
    await expect(input).toHaveValue('2');
  });

  test('planos de 25 GB e 50 GB aceitam quantidade mínima de 1 conta', async ({ page, erros }) => {
    await page.goto('checkout.html');
    const qty25 = page.locator('#ckQty25');
    const qty50 = page.locator('#ckQty50');

    await page.locator('#ckCard25 .mini-qty-btn').last().click();
    await expect(qty25).toHaveValue('1');

    await page.locator('#ckCard25 .mini-qty-btn').first().click();
    await expect(qty25).toHaveValue('0');

    await qty50.fill('1');
    await qty50.press('Tab');
    await expect(qty50).toHaveValue('1');
  });
});

test.describe('checkout — domínio', { tag: '@CIT-15' }, () => {
  test('opção de registro de domínio .com foi removida', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await expect(page.locator('#doptCom')).toHaveCount(0);
    // guarda de regressão: a opção .com.br continua disponível
    await expect(page.locator('#doptBr')).toHaveCount(1);
  });

  test('fluxo até o passo 3 com domínio .com.br novo conclui sem erros', async ({ page, erros }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
    await page.goto('checkout.html');

    await page.locator('#ckCard5 .mini-qty-btn').last().click();
    await page.locator('#step1 .btn-primary').click();
    await expect(page.locator('#step1Error')).toBeHidden();

    await page.locator('#doptBr').click();
    await page.locator('#fDomNew').fill('minhaempresateste');
    await page.locator('#step2 .btn-primary').click();

    await expect(page.locator('#step2Error')).toBeHidden();
    await expect(page.locator('#step3')).toHaveClass(/active/);
    await expect(page.locator('#successWebmail')).toHaveText('webmail.minhaempresateste.com.br');
  });

  test('fluxo até o passo 3 com domínio existente conclui sem erros', async ({ page, erros }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
    await page.goto('checkout.html');

    await page.locator('#ckCard5 .mini-qty-btn').last().click();
    await page.locator('#step1 .btn-primary').click();
    await expect(page.locator('#step1Error')).toBeHidden();

    await page.locator('#doptExist').click();
    await page.locator('#fDomExist').fill('minhaempresateste.com.br');
    await page.locator('#step2 .btn-primary').click();

    await expect(page.locator('#step2Error')).toBeHidden();
    await expect(page.locator('#step3')).toHaveClass(/active/);
  });
});

test.describe('checkout — textos', { tag: '@CIT-15' }, () => {
  test('texto de mínimo de contas mantém a frase de desconto do checkout', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await expect(page.locator('.step-intro').first()).toHaveText(
      'Escolha a quantidade de contas de cada tipo. Mínimo de 2 contas no plano de 5 GB. Desconto de 5% a partir de 5 contas do mesmo tipo (não se aplica ao plano anual).'
    );
  });

  test('nenhuma referência a prazo de "5 min" resta no HTML do checkout', async ({ page, erros }) => {
    await page.goto('checkout.html');
    const html = await page.content();
    expect(html).not.toMatch(/\b5(?:\s|&nbsp;)*min/i);
  });

  test('<title> do checkout permanece inalterado', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await expect(page).toHaveTitle('Contratar Plano — CITMail');
  });
});

test.describe('checkout — CIT-19', { tag: '@CIT-19' }, () => {
  // ViaCEP mockado em todos os testes da CIT-19 (sem rede externa).
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test.describe('checkout — barra de etapas', () => {
    for (const largura of LARGURAS_BARRA) {
      test(`largura ${largura}px: sem transbordo e rótulos corretos nos passos 1, 5 e 6`, async ({ page, erros }) => {
        await page.goto('checkout.html?qty5=2');
        await page.evaluate(() => document.fonts.ready);
        await page.setViewportSize({ width: largura, height: 800 });

        const rotulosEsperados = ROTULOS_POR_LARGURA[largura];
        const circuloEsperado = CIRCULO_POR_LARGURA[largura] ?? 36;

        for (const passo of [1, 5, 6]) {
          const m = await medirBarra(page, passo);
          const contexto = `largura ${largura}px, passo ${passo} (coluna ${Math.round(m.mcWidth)}px)`;

          expect(m.docOverflow, `${contexto}: documento com rolagem horizontal`).toBeLessThanOrEqual(0);
          expect(m.barOverflow, `${contexto}: #stepsBar transborda`).toBeLessThanOrEqual(0);
          if (m.duasColunas) {
            expect(m.barRight, `${contexto}: barra invade o resumo`).toBeLessThanOrEqual(m.sumLeft + 0.5);
          }
          expect(m.ativoVisivel, `${contexto}: rótulo ativo não está visível`).toBe(true);
          expect(m.ativoCortado, `${contexto}: rótulo ativo está cortado`).toBe(false);
          expect(m.labelsCortados, `${contexto}: rótulos cortados ou fora da .main-col`).toEqual([]);
          expect(m.nLabels, `${contexto}: quantidade de rótulos visíveis`).toBe(rotulosEsperados);
          expect(m.circulos, `${contexto}: tamanho dos círculos`).toEqual(Array(6).fill({ w: circuloEsperado, h: circuloEsperado }));
        }
      });
    }
  });

  test.describe('checkout — layout responsivo', () => {
    test('960px: coluna única, resumo acima da coluna principal', async ({ page, erros }) => {
      await page.goto('checkout.html');
      await page.evaluate(() => document.fonts.ready);
      await page.setViewportSize({ width: 960, height: 800 });

      const colunas = await page.evaluate(() => getComputedStyle(document.querySelector('.checkout-wrapper')).gridTemplateColumns.trim().split(/\s+/).length);
      expect(colunas, '960px deveria ter uma única trilha no grid').toBe(1);

      const mcBox = await page.locator('.main-col').boundingBox();
      const resumoBox = await page.locator('#orderSummary').boundingBox();
      expect(resumoBox.y, '960px: resumo deveria ficar acima da coluna principal').toBeLessThan(mcBox.y);
    });

    test('961px: duas colunas, resumo ao lado da coluna principal', async ({ page, erros }) => {
      await page.goto('checkout.html');
      await page.evaluate(() => document.fonts.ready);
      await page.setViewportSize({ width: 961, height: 800 });

      const colunas = await page.evaluate(() => getComputedStyle(document.querySelector('.checkout-wrapper')).gridTemplateColumns.trim().split(/\s+/).length);
      expect(colunas, '961px deveria ter duas trilhas no grid').toBe(2);

      const mcBox = await page.locator('.main-col').boundingBox();
      const resumoBox = await page.locator('#orderSummary').boundingBox();
      expect(resumoBox.x, '961px: resumo deveria ficar ao lado da coluna principal').toBeGreaterThanOrEqual(mcBox.x + mcBox.width - 1);
    });

    for (const largura of [320, 412, 961]) {
      test(`largura ${largura}px: sem rolagem horizontal nem card transbordando em nenhum passo com dados pesados`, async ({ page, erros }) => {
        await page.goto('checkout.html?qty5=2');
        await page.evaluate(() => document.fonts.ready);
        await preencherCheckoutPesado(page);
        await page.setViewportSize({ width: largura, height: 900 });

        const variantes = /** @type {[number, string?][]} */ ([[1], [2], [3], [4], [5, 'pix'], [5, 'boleto'], [5, 'card'], [6]]);
        for (const [passo, pagamento] of variantes) {
          const m = await page.evaluate(([n, pay]) => {
            goStep(n);
            if (pay) selectPayment(pay);
            const doc = document.documentElement;
            const cards = [...document.querySelectorAll('.card')].filter(c => c.getClientRects().length > 0);
            return {
              docOverflow: doc.scrollWidth - doc.clientWidth,
              cardsVisiveis: cards.length,
              cardsTransbordando: cards.filter(c => c.scrollWidth > c.clientWidth + 1)
                .map(c => `${c.closest('[id]')?.id}: ${c.scrollWidth}>${c.clientWidth}`),
            };
          }, [passo, pagamento]);
          const id = pagamento ? `${passo}/${pagamento}` : `${passo}`;
          expect(m.docOverflow, `largura ${largura}px, passo ${id}: rolagem horizontal do documento`).toBeLessThanOrEqual(0);
          expect(m.cardsVisiveis, `largura ${largura}px, passo ${id}: nenhum .card visível medido`).toBeGreaterThan(0);
          expect(m.cardsTransbordando, `largura ${largura}px, passo ${id}: .card com conteúdo mais largo que o card`).toEqual([]);
        }

        // Passo 6 com webmail fictício longo: precisa caber inteiramente dentro do card.
        const dentroDoCard = await page.evaluate(() => {
          const el = document.getElementById('successWebmail');
          const card = el.closest('.card');
          const b = el.getBoundingClientRect();
          const c = card.getBoundingClientRect();
          return b.left >= c.left - 0.5 && b.right <= c.right + 0.5 && el.scrollWidth <= el.clientWidth + 1;
        });
        expect(dentroDoCard, `largura ${largura}px: #successWebmail transborda do card`).toBe(true);
      });
    }
  });

  test.describe('checkout — navegação entre passos', () => {
    test('mobile (412px): avançar do passo 1 ao 2 rola até a barra de etapas e mostra o título do passo', async ({ page, erros }) => {
      await page.setViewportSize({ width: 412, height: 839 });
      await page.goto('checkout.html?qty5=2');
      await page.evaluate(() => document.fonts.ready);

      await page.locator('#step1 .btn-primary').click();

      await expect.poll(async () => page.evaluate(() => {
        const barTop = document.getElementById('stepsBar').getBoundingClientRect().top;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const titulo = document.querySelector('.step-panel.active .card-title').getBoundingClientRect();
        const tituloVisivel = titulo.top >= 0 && titulo.bottom <= window.innerHeight;
        return barTop >= 60 && (barTop <= 100 || Math.abs(window.scrollY - max) < 1) && tituloVisivel;
      }), {
        message: 'barra de etapas e título do passo 2 deveriam ficar visíveis após a rolagem',
        timeout: 6000,
      }).toBe(true);
    });

    test('desktop (1280px): trocar de passo com a página rolada volta o scroll ao topo', async ({ page, erros }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto('checkout.html?qty5=2');
      await page.evaluate(() => document.fonts.ready);
      await preencherCheckoutPesado(page);

      await page.evaluate(() => window.scrollTo(0, 300));
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), 'a página deveria estar rolada antes de trocar de passo').toBeGreaterThan(0);

      await page.evaluate(() => goStep(3));

      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), {
        message: 'scrollY deveria voltar a 0 ao trocar de passo no desktop',
        timeout: 6000,
      }).toBe(0);
    });
  });

  test.describe('checkout — resumo sticky', () => {
    for (const pagina of ['no topo', 'rolada até o fim']) {
      test(`1280x720 com resumo cheio e página ${pagina}: resumo cabe na janela e rola por dentro até o último selo`, async ({ page, erros }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto('checkout.html?qty5=2');
        await page.evaluate(() => document.fonts.ready);
        await preencherCheckoutPesado(page);

        if (pagina === 'no topo') {
          await page.evaluate(() => window.scrollTo(0, 0));
          await expect.poll(() => page.evaluate(() => window.scrollY), 'a página deveria estar no topo').toBe(0);
        } else {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await expect.poll(() => page.evaluate(() => window.scrollY), 'a página deveria estar rolada').toBeGreaterThan(0);
        }

        const antes = await page.evaluate(() => {
          const el = document.getElementById('orderSummary');
          return {
            bottom: el.getBoundingClientRect().bottom, innerHeight: window.innerHeight,
            scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollY: window.scrollY,
          };
        });
        expect(antes.bottom, `página ${pagina}: fundo do resumo fora da janela`).toBeLessThanOrEqual(antes.innerHeight);
        expect(antes.scrollHeight, `página ${pagina}: resumo cheio deveria ter rolagem interna`).toBeGreaterThan(antes.clientHeight);

        const scrollYDepois = await page.evaluate(() => {
          const el = document.getElementById('orderSummary');
          el.scrollTop = el.scrollHeight;
          return window.scrollY;
        });
        await expect(page.locator('.secure-badge').last(), `página ${pagina}: último selo deveria aparecer rolando só o resumo`).toBeInViewport();
        expect(scrollYDepois, `página ${pagina}: rolar o resumo não deveria rolar a página`).toBe(antes.scrollY);
      });
    }

    test('1280x900 com pedido simples: resumo cabe sem barra de rolagem', async ({ page, erros }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('checkout.html?qty5=2');
      await page.evaluate(() => document.fonts.ready);

      const m = await page.evaluate(() => {
        const el = document.getElementById('orderSummary');
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      expect(m.scrollHeight, 'pedido simples não deveria ter rolagem interna no resumo').toBeLessThanOrEqual(m.clientHeight);
    });

    test('resumo é alcançável por teclado e identificado como região', async ({ page, erros }) => {
      await page.goto('checkout.html');
      const resumo = page.locator('#orderSummary');
      await expect(resumo).toHaveAttribute('tabindex', '0');
      await expect(resumo).toHaveAttribute('role', 'region');
      await expect(resumo).toHaveAttribute('aria-label', 'Resumo do pedido');
    });
  });

  test.describe('checkout — tipografia', () => {
    for (const largura of [1280, 412]) {
      test(`largura ${largura}px: tamanhos de fonte batem com os tokens --cit-text-small/--cit-text-body`, async ({ page, erros }) => {
        await page.goto('checkout.html');
        await page.evaluate(() => document.fonts.ready);
        await page.setViewportSize({ width: largura, height: 900 });

        const small = await tamanhoToken(page, '--cit-text-small');
        const body = await tamanhoToken(page, '--cit-text-body');
        // Sanidade dos tokens: se mudarem, os tamanhos esperados desta história precisam ser revistos.
        expect({ small, body }, 'tokens de texto do brandbook').toEqual({ small: '14px', body: '16px' });

        // .sum-empty só existe com o checkout vazio — ler antes de preencher.
        const vazio = await lerFontes(page, ['.sum-empty']);
        await preencherCheckoutPesado(page);

        const selsSmall = [...SELETORES_TIPO_SMALL, ...SELETORES_TIPO_SMALL_PASSO3];
        const selsBody = [...SELETORES_TIPO_BODY, ...SELETORES_TIPO_BODY_PASSO3];
        const cheio = await lerFontes(page, [...selsSmall, ...selsBody, '.card-title', '.summary-total .price'], EXCECOES_TIPO_BODY);
        const lido = { ...vazio, ...cheio };

        // Esperado com a mesma quantidade de ocorrências lidas (mínimo 1: seletor sem elemento falha).
        const n = (/** @type {string} */ sel) => Math.max(lido[sel]?.length ?? 0, 1);
        /** @type {Record<string, string[]>} */
        const esperado = { '.sum-empty': Array(n('.sum-empty')).fill(small) };
        for (const sel of selsSmall) esperado[sel] = Array(n(sel)).fill(small);
        for (const sel of selsBody) esperado[sel] = Array(n(sel)).fill(body);
        for (const sel of EXCECOES_TIPO_BODY) esperado[sel] = Array(n(sel)).fill(body);
        esperado['.card-title'] = Array(n('.card-title')).fill('20px');
        // Guarda de regressão: o preço total do resumo não muda nesta história.
        esperado['.summary-total .price'] = Array(n('.summary-total .price')).fill('25.6px');

        expect(lido, `largura ${largura}px: font-size por seletor (todas as ocorrências)`).toEqual(esperado);
      });
    }
  });
});

// CIT-21: add-ons do passo 3 (tabela única de preços, sanfona e aviso de desconto).

/**
 * Abre a seção de add-ons indicada no passo 3, se estiver fechada.
 * @param {import('@playwright/test').Page} page
 * @param {string} nome nome visível da seção, ex.: 'Backup'
 */
async function abrirSecao(page, nome) {
  const botao = botaoSecao(page, nome);
  if (await botao.getAttribute('aria-expanded') !== 'true') await botao.click();
  await expect(botao).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Botão do cabeçalho de uma seção da sanfona de add-ons (nome acessível começa pelo nome da seção;
 * o indicador de subtotal, quando visível, entra depois).
 * @param {import('@playwright/test').Page} page
 * @param {string} nome
 */
function botaoSecao(page, nome) {
  const esc = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator('#step3 .addon-sec-btn').filter({ has: page.locator('.addon-sec-nome', { hasText: new RegExp(`^${esc}$`) }) });
}

/**
 * Digita a quantidade de um add-on no campo do passo 3 (dispara o onchange com Tab).
 * @param {import('@playwright/test').Page} page
 * @param {string} secao nome da seção que contém o add-on
 * @param {string} inputId id do campo de quantidade, ex.: 'aqTalk'
 * @param {number} qtd
 */
async function definirQtdAddon(page, secao, inputId, qtd) {
  await abrirSecao(page, secao);
  const input = page.locator(`#${inputId}`);
  await input.fill(String(qtd));
  await input.press('Tab');
}

/**
 * Textos das linhas (cada filho da linha, sem espaços extras) de um contêiner de linhas.
 * @param {import('@playwright/test').Page} page
 * @param {string} seletor seletor das linhas, ex.: '#sumAccountLines .sum-line'
 */
async function linhas(page, seletor) {
  return page.evaluate(sel => [...document.querySelectorAll(sel)]
    .map(l => [...l.children].map(s => s.textContent.replace(/\s+/g, ' ').trim())), seletor);
}

test.describe('checkout — add-ons: preços (não regressão)', { tag: '@CIT-21' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('preços exibidos em cada add-on do passo 3', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    const precos = await page.evaluate(() => Object.fromEntries(
      ['#adTalk .addon-price', '#adBackup90 .addon-price', '#adBackup365 .addon-price', '#adGrupo .addon-price', '#adExtraDom .addon-price',
        '#skyOpt50 .sky-opt-price', '#skyOpt100 .sky-opt-price', '#skyOpt1tb .sky-opt-price']
        .map(sel => [sel, document.querySelector(sel)?.textContent.trim()])));
    expect(precos).toEqual({
      '#adTalk .addon-price': 'R$ 4,70/conta/mês',
      '#adBackup90 .addon-price': 'R$ 6,00/conta/mês',
      '#adBackup365 .addon-price': 'R$ 19,00/conta/mês',
      '#adGrupo .addon-price': 'R$ 2,00/conta/mês',
      '#adExtraDom .addon-price': 'R$ 79,00/domínio/ano',
      '#skyOpt50 .sky-opt-price': 'R$ 17,70/conta/mês',
      '#skyOpt100 .sky-opt-price': 'R$ 28,70/conta/mês',
      '#skyOpt1tb .sky-opt-price': 'R$ 319,00/conta/mês',
    });
  });

  test('mensal: subtotais por linha, painel de selecionados, resumo e total com todos os add-ons', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 3);
    await definirQtdAddon(page, 'Backup', 'aqBackup90', 2);
    await definirQtdAddon(page, 'Backup', 'aqBackup365', 1);
    await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 2);
    await page.locator('#skyOpt100').click();
    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 2);
    const grupo = page.locator('#aqGrupo');
    await grupo.fill('4');
    await grupo.press('Tab');

    await expect(page.locator('#asTalk')).toHaveText('R$ 14,10');
    await expect(page.locator('#asBackup90')).toHaveText('R$ 12,00');
    await expect(page.locator('#asBackup365')).toHaveText('R$ 19,00');
    await expect(page.locator('#asGrupo')).toHaveText('R$ 8,00');
    await expect(page.locator('#asSkybox')).toHaveText('R$ 57,40');
    await expect(page.locator('#asExtraDom')).toHaveText('R$ 158,00');
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 158,00');

    // Domínio extra (anual, via Pix) fica fora do subtotal mensal dos add-ons.
    await expect(page.locator('#addonsSubtotalVal')).toHaveText('+ R$ 110,50/mês');
    expect(await linhas(page, '#addonsSubtotalLines .addon-sub-line')).toEqual([
      ['Talk', 'R$ 14,10/mês'],
      ['Backup 90d', 'R$ 12,00/mês'],
      ['Backup 365d', 'R$ 19,00/mês'],
      ['Grupo E-mail', 'R$ 8,00/mês'],
      ['Skybox 100GB', 'R$ 57,40/mês'],
    ]);

    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([
      ['2× E-mail 5 GB', 'R$ 20,00'],
      ['Talk ×3', 'R$ 14,10'],
      ['Backup 90d ×2', 'R$ 12,00'],
      ['Backup 365d ×1', 'R$ 19,00'],
      ['Grupo E-mail ×4', 'R$ 8,00'],
      ['Skybox 100GB ×2', 'R$ 57,40'],
    ]);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 130,50');
    await expect(page.locator('#sumPeriod')).toHaveText('/mês');
  });

  test('anual: total mensal com add-ons e valor anual (total × 12)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2&cycle=annual');
    await page.evaluate(() => goStep(3));

    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 1);
    await definirQtdAddon(page, 'Backup', 'aqBackup365', 2);
    await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 1);
    await page.locator('#skyOpt50').click();

    // 2 × 8,00 (−20% anual) + 4,70 + 2 × 19,00 + 17,70 = 76,40
    await expect(page.locator('#sumTotal')).toHaveText('R$ 76,40');
    await expect(page.locator('#sumPeriod')).toHaveText('/mês · R$ 916,80/ano');
    await expect(page.locator('#addonsSubtotalVal')).toHaveText('+ R$ 60,40/mês');
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([
      ['2× E-mail 5 GB', 'R$ 16,00'],
      ['Talk ×1', 'R$ 4,70'],
      ['Backup 365d ×2', 'R$ 38,00'],
      ['Skybox 50GB ×1', 'R$ 17,70'],
    ]);
  });

  test('Skybox 1 TB: preço por licença no subtotal, no painel e no resumo', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    await abrirSecao(page, 'Armazenamento em nuvem');
    await page.locator('#skyOpt1tb').click();
    await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 3);

    await expect(page.locator('#asSkybox')).toHaveText('R$ 957,00');
    await expect(page.locator('#addonsSubtotalVal')).toHaveText('+ R$ 957,00/mês');
    expect(await linhas(page, '#addonsSubtotalLines .addon-sub-line')).toEqual([['Skybox 1TB', 'R$ 957,00/mês']]);
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([
      ['2× E-mail 5 GB', 'R$ 20,00'],
      ['Skybox 1TB ×3', 'R$ 957,00'],
    ]);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 977,00');
  });

  test('Skybox com quantidade e sem plano: R$ 0,00 e sem linha no painel nem no resumo', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 5);

    await expect(page.locator('#asSkybox')).toHaveText('R$ 0,00');
    await expect(page.locator('#addonsSubtotal')).toBeHidden();
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['2× E-mail 5 GB', 'R$ 20,00']]);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 20,00');
  });

  test('domínio extra: 2 × R$ 79,00 no Pix anual, fora do total mensal e do resumo', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 2);

    await expect(page.locator('#asExtraDom')).toHaveText('R$ 158,00');
    await expect(page.locator('#extraDomPixPanel')).toBeVisible();
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 158,00');
    await expect(page.locator('#addonsSubtotal')).toBeHidden();
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['2× E-mail 5 GB', 'R$ 20,00']]);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 20,00');
  });
});

// Seções da sanfona do passo 3, na ordem da tela.
const SECOES_ADDONS = ['Armazenamento em nuvem', 'Talk – Videoconferência', 'Backup', 'Domínio secundário'];
// Nomes dos add-ons nos rótulos dos controles de quantidade (campo `nome` da tabela de preços).
const NOMES_ADDONS = ['Talk', 'Backup 90 dias', 'Backup 365 dias', 'Skybox', 'Domínio extra', 'Grupo de E-mail'];

/**
 * Estado aberto/fechado de cada seção (aria-expanded do botão), na ordem da tela.
 * @param {import('@playwright/test').Page} page
 */
async function estadoSecoes(page) {
  return page.locator('#step3 .addon-sec-btn').evaluateAll(bs => bs.map(b => b.getAttribute('aria-expanded')));
}

/**
 * Painel controlado pelo botão da seção (via aria-controls).
 * @param {import('@playwright/test').Page} page
 * @param {string} nome
 */
async function painelSecao(page, nome) {
  const id = await botaoSecao(page, nome).getAttribute('aria-controls');
  return page.locator(`#${id}`);
}

test.describe('checkout — add-ons: sanfona', { tag: '@CIT-21' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('título do passo é h2 e as seções são h3 com botão, nesta ordem e com estes nomes', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    await expect(page.locator('#step3').getByRole('heading', { level: 2 })).toHaveText('Add-ons e Serviços Extras');
    // innerText: o indicador sem valor (com o prefixo só para leitor de tela) fica hidden.
    await expect(page.locator('#step3 h3')).toHaveText(SECOES_ADDONS, { useInnerText: true });
    await expect(page.locator('#step3 h3 > button.addon-sec-btn')).toHaveCount(SECOES_ADDONS.length);

    for (const nome of SECOES_ADDONS) {
      const botao = botaoSecao(page, nome);
      await expect(botao).toHaveCount(1);
      await expect(botao).toHaveAccessibleName(nome);
      const painel = await painelSecao(page, nome);
      await expect(painel).toHaveAttribute('role', 'region');
      await expect(painel).toHaveAttribute('aria-labelledby', await botao.getAttribute('id') ?? '');
    }
    // Conteúdo de cada seção.
    await expect((await painelSecao(page, 'Armazenamento em nuvem')).locator('#adSkybox')).toHaveCount(1);
    await expect((await painelSecao(page, 'Talk – Videoconferência')).locator('#adTalk')).toHaveCount(1);
    await expect((await painelSecao(page, 'Backup')).locator('#adBackup90, #adBackup365')).toHaveCount(2);
    await expect((await painelSecao(page, 'Domínio secundário')).locator('#adExtraDom, #extraDomPixPanel')).toHaveCount(2);
  });

  test('Grupo de E-mail fica fora das seções, sempre visível, e entra no subtotal, no resumo e no total', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    await expect(page.locator('.addon-sec #adGrupo')).toHaveCount(0);
    // Abaixo da última seção.
    const depois = await page.evaluate(() => {
      const secoes = document.querySelectorAll('#step3 .addon-sec');
      return !!(secoes[secoes.length - 1].compareDocumentPosition(document.getElementById('adGrupo')) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(depois, '#adGrupo deveria vir depois das seções').toBe(true);

    await botaoSecao(page, 'Armazenamento em nuvem').click();
    expect(await estadoSecoes(page)).toEqual(['false', 'false', 'false', 'false']);
    await expect(page.locator('#adGrupo')).toBeVisible();

    await page.getByRole('button', { name: 'Aumentar Grupo de E-mail', exact: true }).click();
    await page.getByRole('button', { name: 'Aumentar Grupo de E-mail', exact: true }).click();
    await expect(page.locator('#asGrupo')).toHaveText('R$ 4,00');
    await expect(page.locator('#addonsSubtotalVal')).toHaveText('+ R$ 4,00/mês');
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['2× E-mail 5 GB', 'R$ 20,00'], ['Grupo E-mail ×2', 'R$ 4,00']]);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 24,00');
  });

  test('seções são independentes: várias abertas ao mesmo tempo', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    expect(await estadoSecoes(page)).toEqual(['true', 'false', 'false', 'false']);

    await botaoSecao(page, 'Talk – Videoconferência').click();
    await botaoSecao(page, 'Backup').click();
    await botaoSecao(page, 'Domínio secundário').click();
    expect(await estadoSecoes(page)).toEqual(['true', 'true', 'true', 'true']);
    for (const nome of SECOES_ADDONS) await expect(await painelSecao(page, nome)).toBeVisible();

    await botaoSecao(page, 'Backup').click();
    expect(await estadoSecoes(page)).toEqual(['true', 'true', 'false', 'true']);
    await expect(await painelSecao(page, 'Backup')).toBeHidden();
    await expect(await painelSecao(page, 'Talk – Videoconferência')).toBeVisible();
  });

  test('teclado: Enter e Espaço abrem e fecham a seção', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    const botao = botaoSecao(page, 'Talk – Videoconferência');
    const painel = await painelSecao(page, 'Talk – Videoconferência');

    await botao.focus();
    await page.keyboard.press('Enter');
    await expect(botao).toHaveAttribute('aria-expanded', 'true');
    await expect(painel).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(botao).toHaveAttribute('aria-expanded', 'false');
    await expect(painel).toBeHidden();

    await page.keyboard.press('Space');
    await expect(botao).toHaveAttribute('aria-expanded', 'true');
    await expect(painel).toBeVisible();
    await page.keyboard.press('Space');
    await expect(botao).toHaveAttribute('aria-expanded', 'false');
    await expect(painel).toBeHidden();
  });

  test('estado inicial: sem seleção só Armazenamento aberta', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    expect(await estadoSecoes(page)).toEqual(['true', 'false', 'false', 'false']);
    await expect(await painelSecao(page, 'Armazenamento em nuvem')).toBeVisible();
    for (const nome of SECOES_ADDONS.slice(1)) await expect(await painelSecao(page, nome)).toBeHidden();
  });

  test('estado inicial: seções com seleção abrem ao entrar no passo 3 e ao voltar do passo 4', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    await abrirSecao(page, 'Backup');
    await page.getByRole('button', { name: 'Aumentar Backup 365 dias', exact: true }).click();
    await abrirSecao(page, 'Domínio secundário');
    await page.getByRole('button', { name: 'Aumentar Domínio extra', exact: true }).click();
    // Fecha tudo antes de sair do passo.
    for (const nome of SECOES_ADDONS) {
      const b = botaoSecao(page, nome);
      if (await b.getAttribute('aria-expanded') === 'true') await b.click();
    }
    expect(await estadoSecoes(page)).toEqual(['false', 'false', 'false', 'false']);

    await page.locator('#step3 .btn-primary').click();
    await expect(page.locator('#step4')).toHaveClass(/active/);
    await page.locator('#step4 .btn-back-row').click();
    await expect(page.locator('#step3')).toHaveClass(/active/);

    // Armazenamento (padrão) + Backup e Domínio (com seleção); Talk fechada.
    expect(await estadoSecoes(page)).toEqual(['true', 'false', 'true', 'true']);
    await expect(page.getByRole('button', { name: 'Aumentar Backup 365 dias', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aumentar Talk', exact: true })).toBeHidden();

    // Entrada vinda do passo 2 (goStep) também reaplica o estado.
    await botaoSecao(page, 'Armazenamento em nuvem').click();
    await page.evaluate(() => goStep(2));
    await page.evaluate(() => goStep(3));
    expect(await estadoSecoes(page)).toEqual(['true', 'false', 'true', 'true']);
  });

  // A regra "Skybox com plano conta como seleção" não é observável hoje: Armazenamento já abre por padrão.
  test('estado inicial: Talk com quantidade abre a seção; Armazenamento reabre mesmo fechada pelo usuário', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    await abrirSecao(page, 'Talk – Videoconferência');
    await page.getByRole('button', { name: 'Aumentar Talk', exact: true }).click();
    await botaoSecao(page, 'Talk – Videoconferência').click();
    await botaoSecao(page, 'Armazenamento em nuvem').click();

    await page.evaluate(() => { goStep(4); goStep(3); });
    expect(await estadoSecoes(page)).toEqual(['true', 'true', 'false', 'false']);
  });

  test('entrar no passo 3 não move o foco para as seções', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(4));
    await page.locator('#step4 .btn-back-row').click();
    await expect(page.locator('#step3')).toHaveClass(/active/);
    const focoNaSanfona = await page.evaluate(() => !!document.activeElement?.closest('.addon-list'));
    expect(focoNaSanfona).toBe(false);
  });

  test('indicador: subtotal da seção só quando fechada e com valor', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    // Valor visível do indicador (o prefixo "subtotal" é só para leitor de tela).
    const ind = (/** @type {string} */ nome) => botaoSecao(page, nome).locator('.addon-sec-ind-val');

    // Sem seleção: vazio, aberta ou fechada.
    for (const nome of SECOES_ADDONS) await expect(ind(nome)).toHaveText('');

    // Talk ×3: vazio aberta, subtotal fechada (e no nome acessível do botão).
    await abrirSecao(page, 'Talk – Videoconferência');
    await page.getByRole('spinbutton', { name: 'Quantidade de Talk', exact: true }).fill('3');
    await page.getByRole('spinbutton', { name: 'Quantidade de Talk', exact: true }).press('Tab');
    await expect(ind('Talk – Videoconferência')).toHaveText('');
    await expect(botaoSecao(page, 'Talk – Videoconferência')).toHaveAccessibleName('Talk – Videoconferência');
    await botaoSecao(page, 'Talk – Videoconferência').click();
    await expect(ind('Talk – Videoconferência')).toHaveText('R$ 14,10/mês');
    await expect(page.getByRole('button', { name: 'Talk – Videoconferência subtotal R$ 14,10/mês', exact: true })).toHaveCount(1);
    // "subtotal" não aparece na tela.
    await expect(botaoSecao(page, 'Talk – Videoconferência').locator('.addon-sec-ind .sr-only')).toHaveCSS('position', 'absolute');
    await botaoSecao(page, 'Talk – Videoconferência').click();
    await expect(ind('Talk – Videoconferência')).toHaveText('');
    await expect(botaoSecao(page, 'Talk – Videoconferência')).toHaveAccessibleName('Talk – Videoconferência');

    // Backup: soma dos dois add-ons.
    await abrirSecao(page, 'Backup');
    await page.getByRole('button', { name: 'Aumentar Backup 90 dias', exact: true }).click();
    await page.getByRole('button', { name: 'Aumentar Backup 365 dias', exact: true }).click();
    await botaoSecao(page, 'Backup').click();
    await expect(ind('Backup')).toHaveText('R$ 25,00/mês');

    // Domínio: por ano.
    await abrirSecao(page, 'Domínio secundário');
    await page.getByRole('button', { name: 'Aumentar Domínio extra', exact: true }).click();
    await page.getByRole('button', { name: 'Aumentar Domínio extra', exact: true }).click();
    await botaoSecao(page, 'Domínio secundário').click();
    await expect(ind('Domínio secundário')).toHaveText('R$ 158,00/ano');

    // Skybox: só com plano e quantidade.
    const arm = 'Armazenamento em nuvem';
    await page.getByRole('button', { name: 'Aumentar Skybox', exact: true }).click();
    await botaoSecao(page, arm).click();
    await expect(ind(arm), 'Skybox com quantidade e sem plano').toHaveText('');
    await abrirSecao(page, arm);
    await page.getByRole('button', { name: 'Diminuir Skybox', exact: true }).click();
    await page.locator('#skyOpt100').click();
    await botaoSecao(page, arm).click();
    await expect(ind(arm), 'Skybox com plano e sem quantidade').toHaveText('');
    await abrirSecao(page, arm);
    await page.getByRole('button', { name: 'Aumentar Skybox', exact: true }).click();
    await botaoSecao(page, arm).click();
    await expect(ind(arm), 'Skybox com plano e quantidade').toHaveText('R$ 28,70/mês');

    // Indicador atualiza com a seção fechada quando o valor muda por fora (resumo segue igual).
    await page.evaluate(() => addonChange('talk', 1));
    await expect(ind('Talk – Videoconferência')).toHaveText('');
    await botaoSecao(page, 'Talk – Videoconferência').click();
    await expect(ind('Talk – Videoconferência')).toHaveText('R$ 18,80/mês');
  });

  test('controles de quantidade: nomes acessíveis únicos e campos rotulados', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    for (const nome of SECOES_ADDONS) await abrirSecao(page, nome);

    for (const nome of NOMES_ADDONS) {
      await expect(page.getByRole('button', { name: `Diminuir ${nome}`, exact: true }), `Diminuir ${nome}`).toHaveCount(1);
      await expect(page.getByRole('button', { name: `Aumentar ${nome}`, exact: true }), `Aumentar ${nome}`).toHaveCount(1);
      // Skybox tem rótulo visível "Quantidade de licenças:"; o nome acessível o contém (WCAG 2.5.3).
      const rotulo = nome === 'Skybox' ? 'Quantidade de licenças de Skybox' : `Quantidade de ${nome}`;
      await expect(page.getByRole('spinbutton', { name: rotulo, exact: true }), rotulo).toHaveCount(1);
    }
    const rotuloVisivelSkybox = (await page.locator('#adSkybox .sky-qty-label').textContent())?.replace(/:\s*$/, '').trim();
    expect(rotuloVisivelSkybox).toBe('Quantidade de licenças');
    await expect(page.locator('#aqSkybox')).toHaveAccessibleName(new RegExp(`^${rotuloVisivelSkybox}`));
    // Todos os botões − e + do passo 3 têm nome próprio (nenhum fica só com "−"/"+").
    const nomes = await page.locator('#step3 .mini-qty-btn').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')));
    expect(nomes.length).toBe(NOMES_ADDONS.length * 2);
    expect(new Set(nomes).size, 'aria-label repetido nos botões −/+').toBe(nomes.length);

    await page.getByRole('button', { name: 'Aumentar Talk', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Quantidade de Talk', exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Diminuir Talk', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Quantidade de Talk', exact: true })).toHaveValue('0');
  });

  test('campo de quantidade mostra o valor cobrado: negativo vira 0 e fracionário é truncado', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    await abrirSecao(page, 'Talk – Videoconferência');
    const campo = page.getByRole('spinbutton', { name: 'Quantidade de Talk', exact: true });

    await campo.fill('-3');
    await campo.press('Tab');
    await expect(campo).toHaveValue('0');
    await expect(page.locator('#asTalk')).toHaveText('R$ 0,00');

    await campo.fill('2.7');
    await campo.press('Tab');
    await expect(campo).toHaveValue('2');
    await expect(page.locator('#asTalk')).toHaveText('R$ 9,40');
    expect(await linhas(page, '#addonsSubtotalLines .addon-sub-line')).toEqual([['Talk', 'R$ 9,40/mês']]);
  });

  test('painel fechado: atributo hidden e controles ocultos', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    const painel = await painelSecao(page, 'Backup');
    await expect(botaoSecao(page, 'Backup')).toHaveAttribute('aria-expanded', 'false');
    await expect(painel).toHaveAttribute('hidden', '');
    await expect(painel).toBeHidden();
    await expect(page.getByRole('button', { name: 'Aumentar Backup 90 dias', exact: true })).toBeHidden();
    await expect(page.locator('#aqBackup365')).toBeHidden();

    await botaoSecao(page, 'Backup').click();
    await expect(painel).not.toHaveAttribute('hidden');
    await expect(page.getByRole('button', { name: 'Aumentar Backup 90 dias', exact: true })).toBeVisible();

    await botaoSecao(page, 'Armazenamento em nuvem').click();
    await expect(page.locator('#skyOpt50')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Aumentar Skybox', exact: true })).toBeHidden();
  });

  test('chevron gira 180° fechada; com movimento reduzido não há transição', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    const chevron = (/** @type {string} */ nome) => botaoSecao(page, nome).locator('.addon-sec-chevron');

    await expect(chevron('Armazenamento em nuvem')).toHaveCSS('transform', 'none');
    await expect(chevron('Backup')).toHaveCSS('transform', /^matrix\(-1, .*, -1, 0, 0\)$/);
    await expect(chevron('Backup')).not.toHaveCSS('transition-duration', '0s');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(chevron('Backup')).toHaveCSS('transition-duration', '0s');
    await expect(chevron('Armazenamento em nuvem')).toHaveCSS('transition-duration', '0s');
  });

  for (const largura of [320, 412, 1280]) {
    test(`largura ${largura}px: passo 3 sem transbordo com seções todas abertas e todas fechadas com indicador`, async ({ page, erros }) => {
      await page.goto('checkout.html?qty5=2');
      await page.evaluate(() => document.fonts.ready);
      await preencherCheckoutPesado(page);
      await page.setViewportSize({ width: largura, height: 900 });
      await page.evaluate(() => goStep(3));

      for (const estado of ['abertas', 'fechadas']) {
        for (const nome of SECOES_ADDONS) {
          const b = botaoSecao(page, nome);
          if ((await b.getAttribute('aria-expanded') === 'true') !== (estado === 'abertas')) await b.click();
        }
        expect(await estadoSecoes(page)).toEqual(Array(4).fill(estado === 'abertas' ? 'true' : 'false'));

        const m = await page.evaluate(() => {
          const doc = document.documentElement;
          const els = [...document.querySelectorAll('#step3 .addon-sec-btn, #step3 .addon-sec-painel, #step3 .addon-sec')]
            .filter(e => e.getClientRects().length > 0);
          return {
            docOverflow: doc.scrollWidth - doc.clientWidth,
            medidos: els.length,
            transbordando: els.filter(e => e.scrollWidth > e.clientWidth)
              .map(e => `${e.id || e.className}: ${e.scrollWidth}>${e.clientWidth}`),
            // Filhos do botão (nome, indicador, chevron) dentro da caixa do botão.
            foraDoBotao: [...document.querySelectorAll('#step3 .addon-sec-btn')].flatMap(b => {
              const r = b.getBoundingClientRect();
              return [...b.children].filter(c => {
                const cr = c.getBoundingClientRect();
                return cr.width > 0 && (cr.left < r.left - 0.5 || cr.right > r.right + 0.5);
              }).map(c => `${b.id} > ${c.getAttribute('class')}`);
            }),
            indicadores: [...document.querySelectorAll('#step3 .addon-sec-ind-val')].map(i => i.textContent),
          };
        });
        const ctx = `largura ${largura}px, seções ${estado}`;
        expect(m.docOverflow, `${ctx}: rolagem horizontal do documento`).toBeLessThanOrEqual(0);
        expect(m.medidos, `${ctx}: elementos medidos`).toBe(estado === 'abertas' ? 12 : 8);
        expect(m.transbordando, `${ctx}: botão ou painel transbordando`).toEqual([]);
        expect(m.foraDoBotao, `${ctx}: conteúdo fora do botão`).toEqual([]);
        expect(m.indicadores, `${ctx}: indicadores`).toEqual(estado === 'abertas'
          ? ['', '', '', '']
          : ['R$ 12.760,00/mês', 'R$ 188,00/mês', 'R$ 1.000,00/mês', 'R$ 3.160,00/ano']);
      }
    });
  }
});

test.describe('checkout — add-ons: aviso de desconto', { tag: '@CIT-21' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('aviso visível só no passo 3, entre a introdução e as seções', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    const aviso = page.locator('#avisoDescontoAddons');
    await expect(aviso).toHaveCount(1);

    for (const passo of [1, 2, 3, 4, 5, 6]) {
      await page.evaluate(n => goStep(n), passo);
      if (passo === 3) await expect(aviso, 'passo 3').toBeVisible();
      else await expect(aviso, `passo ${passo}`).toBeHidden();
    }

    await page.evaluate(() => goStep(3));
    const ordem = await page.evaluate(() => {
      const aviso = document.getElementById('avisoDescontoAddons');
      const intro = document.querySelector('#step3 .step-intro');
      const lista = document.querySelector('#step3 .addon-list');
      const segue = (/** @type {Node} */ a, /** @type {Node} */ b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return segue(intro, aviso) && segue(aviso, lista);
    });
    expect(ordem, 'aviso deveria ficar entre a introdução e as seções').toBe(true);
  });

  test('texto exato, em maiúsculas no HTML e com 15%', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    const aviso = page.locator('#avisoDescontoAddons');

    // CIT-22 (CA11, única exceção à CA1): título e regex invertidos de propósito — o aviso passa a citar o percentual.
    await expect(aviso.locator('.aviso-desconto-titulo')).toHaveText('GARANTA 15% DE DESCONTO NESTA CONTRATAÇÃO');
    // Maiúsculas vêm do próprio HTML (o texto acima), não de text-transform.
    await expect(aviso.locator('.aviso-desconto-titulo')).toHaveCSS('text-transform', 'none');
    await expect(aviso.locator('.aviso-desconto-texto')).toHaveText('Condição exclusiva desta contratação');
    expect(await aviso.textContent()).toMatch(/15\s?%/);
  });

  test('contraste do título e do texto do aviso é de pelo menos 4,5:1', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    const contrastes = await page.evaluate(() => {
      const rgba = (/** @type {string} */ c) => (c.match(/[\d.]+/g) || []).map(Number);
      const lum = (/** @type {number[]} */ [r, g, b]) => {
        const f = (/** @type {number} */ v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      // Fundo efetivo: compõe os fundos dos ancestrais (com alfa) sobre branco.
      const fundo = (/** @type {Element} */ el) => {
        const camadas = [];
        for (let e = el; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor);
          const a = c.length > 3 ? c[3] : 1;
          if (a > 0) camadas.push([c[0], c[1], c[2], a]);
          if (a >= 1) break;
        }
        let cor = [255, 255, 255];
        for (const [r, g, b, a] of camadas.reverse()) cor = [r * a + cor[0] * (1 - a), g * a + cor[1] * (1 - a), b * a + cor[2] * (1 - a)];
        return cor;
      };
      const contraste = (/** @type {string} */ sel) => {
        const el = /** @type {Element} */ (document.querySelector(sel));
        const l1 = lum(rgba(getComputedStyle(el).color).slice(0, 3));
        const l2 = lum(fundo(el));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      return { titulo: contraste('#avisoDescontoAddons .aviso-desconto-titulo'), texto: contraste('#avisoDescontoAddons .aviso-desconto-texto') };
    });
    expect(contrastes.titulo, 'contraste do título').toBeGreaterThanOrEqual(4.5);
    expect(contrastes.texto, 'contraste do texto').toBeGreaterThanOrEqual(4.5);
  });
});

// CIT-22, Passo 1: caracterização dos valores ATUAIS do checkout (antes do refactor de preços em
// centavos e do riscado). Não são testes de comportamento novo — travam o que a develop já faz hoje,
// para os passos seguintes provarem que os preços cobrados não mudaram (CA1). Valores conferidos no
// código de `checkout.html` (ACCOUNT_DEFS, calcDiscount, unitPrice) antes de escrever.
test.describe('checkout — CIT-22: caracterização dos valores atuais', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  /** @type {{ label: string, qs: string, total: string, period: string, unit: Record<'5'|'25'|'50', string>, sub: Record<'5'|'25'|'50', string> }[]} */
  const CASOS = [
    { label: '5× E-mail 5 GB, mensal', qs: 'qty5=5', total: 'R$ 47,50', period: '/mês',
      unit: { '5': '9,50', '25': '16,00', '50': '25,00' }, sub: { '5': 'R$ 47,50', '25': 'R$ 0,00', '50': 'R$ 0,00' } },
    { label: '5× E-mail 5 GB, anual', qs: 'qty5=5&cycle=annual', total: 'R$ 40,00', period: '/mês · R$ 480,00/ano',
      unit: { '5': '8,00', '25': '12,80', '50': '20,00' }, sub: { '5': 'R$ 40,00', '25': 'R$ 0,00', '50': 'R$ 0,00' } },
    { label: '5× E-mail 25 GB, mensal', qs: 'qty25=5', total: 'R$ 76,00', period: '/mês',
      unit: { '5': '10,00', '25': '15,20', '50': '25,00' }, sub: { '5': 'R$ 0,00', '25': 'R$ 76,00', '50': 'R$ 0,00' } },
    { label: '5× E-mail 25 GB, anual', qs: 'qty25=5&cycle=annual', total: 'R$ 64,00', period: '/mês · R$ 768,00/ano',
      unit: { '5': '8,00', '25': '12,80', '50': '20,00' }, sub: { '5': 'R$ 0,00', '25': 'R$ 64,00', '50': 'R$ 0,00' } },
    { label: '5× E-mail 50 GB, mensal', qs: 'qty50=5', total: 'R$ 118,75', period: '/mês',
      unit: { '5': '10,00', '25': '16,00', '50': '23,75' }, sub: { '5': 'R$ 0,00', '25': 'R$ 0,00', '50': 'R$ 118,75' } },
    { label: '5× E-mail 50 GB, anual', qs: 'qty50=5&cycle=annual', total: 'R$ 100,00', period: '/mês · R$ 1.200,00/ano',
      unit: { '5': '8,00', '25': '12,80', '50': '20,00' }, sub: { '5': 'R$ 0,00', '25': 'R$ 0,00', '50': 'R$ 100,00' } },
    { label: '1× E-mail 25 GB, anual', qs: 'qty25=1&cycle=annual', total: 'R$ 12,80', period: '/mês · R$ 153,60/ano',
      unit: { '5': '8,00', '25': '12,80', '50': '20,00' }, sub: { '5': 'R$ 0,00', '25': 'R$ 12,80', '50': 'R$ 0,00' } },
    { label: '1× E-mail 50 GB, anual', qs: 'qty50=1&cycle=annual', total: 'R$ 20,00', period: '/mês · R$ 240,00/ano',
      unit: { '5': '8,00', '25': '12,80', '50': '20,00' }, sub: { '5': 'R$ 0,00', '25': 'R$ 0,00', '50': 'R$ 20,00' } },
  ];

  for (const c of CASOS) {
    test(`${c.label}: #sumTotal, #sumPeriod, #ckUnit* e #ckSub* atuais`, async ({ page, erros }) => {
      await page.goto(`checkout.html?${c.qs}`);
      await expect(page.locator('#sumTotal')).toHaveText(c.total);
      await expect(page.locator('#sumPeriod')).toHaveText(c.period);
      for (const tipo of /** @type {const} */ (['5', '25', '50'])) {
        await expect(page.locator(`#ckUnit${tipo}`), `#ckUnit${tipo}`).toHaveText(c.unit[tipo]);
        await expect(page.locator(`#ckSub${tipo}`), `#ckSub${tipo}`).toHaveText(c.sub[tipo]);
      }
    });
  }

  test('opções de #fInstallments no mensal (5× E-mail 5 GB, R$ 47,50)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=5');
    await expect(page.locator('#fInstallments option')).toHaveText([
      '1× de R$ 47,50 (sem juros)',
      '2× de R$ 23,75 (sem juros)',
      '3× de R$ 15,83 (sem juros)',
    ]);
  });

  test('opções de #fInstallments no anual (5× E-mail 5 GB, R$ 40,00)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=5&cycle=annual');
    await expect(page.locator('#fInstallments option')).toHaveText([
      '1× de R$ 40,00 (sem juros)',
      '2× de R$ 20,00 (sem juros)',
      '3× de R$ 13,33 (sem juros)',
      '6× de R$ 6,67 (sem juros)',
      '12× de R$ 3,33 (sem juros)',
    ]);
  });

  test('Pix do domínio principal: #domPixCode contém 540000079', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await page.evaluate(() => selectDomainOpt('new-br'));
    await expect(page.locator('#domPixCode')).toContainText('540000079');
  });

  test('Pix de domínio extra (2×): #extraDomPixTotal e #extraDomPixCode', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 2);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 158,00');
    await expect(page.locator('#extraDomPixCode')).toContainText('540000158');
  });
});

// CIT-22, Passo 5: preço de tabela riscado, cascata, economia e checkout em centavos inteiros.
// Termos do plano: "atual" = preço de lista de hoje; "tabela" = atual / 0,85, arredondado ao centavo;
// "cobrado" = o que entra no total; "economia" = Σ por item de (tabela − cobrado).

test.describe('checkout — CIT-22: preço de tabela por item (CA2)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('cada um dos 10 itens mostra a tabela riscada exata, lida dentro do próprio contêiner', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    for (const nome of SECOES_ADDONS) await abrirSecao(page, nome);

    /** @type {[string, string, string][]} */
    const casos = [
      ['#ckCard5 .mini-row-tabela', '#ckCard5 [data-preco-tabela="conta:5gb"]', 'R$ 11,76'],
      ['#ckCard25 .mini-row-tabela', '#ckCard25 [data-preco-tabela="conta:25gb"]', 'R$ 18,82'],
      ['#ckCard50 .mini-row-tabela', '#ckCard50 [data-preco-tabela="conta:50gb"]', 'R$ 29,41'],
      ['#adTalk .addon-price-tabela', '#adTalk [data-preco-tabela="talk"]', 'R$ 5,53'],
      ['#adBackup90 .addon-price-tabela', '#adBackup90 [data-preco-tabela="backup90"]', 'R$ 7,06'],
      ['#adBackup365 .addon-price-tabela', '#adBackup365 [data-preco-tabela="backup365"]', 'R$ 22,35'],
      ['#adGrupo .addon-price-tabela', '#adGrupo [data-preco-tabela="grupoEmail"]', 'R$ 2,35'],
      ['#skyOpt50 .sky-opt-price-tabela', '#skyOpt50 [data-preco-tabela="skybox:50gb"]', 'R$ 20,82'],
      ['#skyOpt100 .sky-opt-price-tabela', '#skyOpt100 [data-preco-tabela="skybox:100gb"]', 'R$ 33,76'],
      ['#skyOpt1tb .sky-opt-price-tabela', '#skyOpt1tb [data-preco-tabela="skybox:1tb"]', 'R$ 375,29'],
    ];
    for (const [contSel, sSel, texto] of casos) {
      const s = page.locator(sSel);
      await expect(s, sSel).toHaveCount(1);
      await expect(s, sSel).toHaveText(texto);
      // O "de" fica no irmão .sr-only, dentro do mesmo contêiner do item — leitura em ordem não junta os valores.
      await expect(page.locator(contSel), contSel).toHaveText(`de ${texto}`);
    }
  });
});

test.describe('checkout — CIT-22: economia com volume no mensal (CA3)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('10×5GB mensal: tabela, −15% contratação, −5% volume e economia', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=10');
    await expect(page.locator('#sumAccountLines .sum-disc')).toHaveText(
      'de R$ 117,60 · −15% contratação −R$ 17,60 · −5% volume −R$ 5,00'
    );
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 22,60/mês');
  });

  test('4×5GB mensal: sem volume, só a contratação', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=4');
    await expect(page.locator('#sumAccountLines .sum-disc')).toHaveText('de R$ 47,04 · −15% contratação −R$ 7,04');
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 7,04/mês');
  });

  test('5×5GB mensal: "−15% contratação" é Σ(tabela − atual), não 15% da tabela (−R$ 8,80, não 8,82)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=5');
    await expect(page.locator('#sumAccountLines .sum-disc')).toContainText('−15% contratação −R$ 8,80');
    await expect(page.locator('#sumAccountLines .sum-disc')).not.toContainText('8,82');
  });
});

test.describe('checkout — CIT-22: rótulos com 15% e sem frases de urgência falsa (CA4)', { tag: '@CIT-22' }, () => {
  const PROIBIDAS = [/volta ao preço/i, /voltará/i, /por tempo limitado/i, /oferta termina/i, /até o dia/i, /últimos dias/i, /preço original/i, /somente hoje/i];

  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('aviso, cards de conta, add-ons e resumo não citam frases de urgência falsa (lista fechada)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=5&cycle=annual');
    await page.evaluate(() => goStep(3));
    for (const nome of SECOES_ADDONS) await abrirSecao(page, nome);

    const textos = await page.evaluate(() => {
      const sels = ['#avisoDescontoAddons', '.mini-calc-row', '.addon-row', '.sky-opt', '#orderSummary'];
      return sels.map(sel => /** @type {[string, string]} */ ([sel, [...document.querySelectorAll(sel)].map(e => e.textContent).join(' ')]));
    });
    for (const [sel, texto] of textos) {
      for (const re of PROIBIDAS) expect(texto, `${sel} não deveria casar com ${re}`).not.toMatch(re);
    }
  });
});

test.describe('checkout — CIT-22: passo 1 com tabela riscada por tipo (CA8)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('anual, 2×5GB: unitário "de R$ 11,76" + #ckUnit5 "8,00"; subtotal "de R$ 23,52" + #ckSub5 "R$ 16,00"', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2&cycle=annual');
    await expect(page.locator('#ckCard5 .mini-row-tabela')).toHaveText('de R$ 11,76');
    await expect(page.locator('#ckUnit5')).toHaveText('8,00');
    await expect(page.locator('#ckCard5 .mini-row-sub-tabela')).toHaveText('de R$ 23,52');
    await expect(page.locator('#ckSub5')).toHaveText('R$ 16,00');
  });

  test('mensal, 5×25GB: tabela riscada e cobrado com volume', async ({ page, erros }) => {
    await page.goto('checkout.html?qty25=5');
    await expect(page.locator('#ckCard25 .mini-row-tabela')).toHaveText('de R$ 18,82');
    await expect(page.locator('#ckUnit25')).toHaveText('15,20');
    await expect(page.locator('#ckCard25 .mini-row-sub-tabela')).toHaveText('de R$ 94,10');
    await expect(page.locator('#ckSub25')).toHaveText('R$ 76,00');
  });

  test('sem quantidade: o subtotal riscado do tipo fica oculto', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await expect(page.locator('#ckCard50 .mini-row-sub-tabela')).toBeHidden();
  });
});

test.describe('checkout — CIT-22: passo 3 com tabela riscada em add-ons e Skybox (CA9)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('add-ons mensais e Skybox mostram a tabela riscada; [data-preco] mantém o texto de hoje; domínio extra sem riscado', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    for (const nome of SECOES_ADDONS) await abrirSecao(page, nome);

    await expect(page.locator('#adTalk .addon-price')).toHaveText('R$ 4,70/conta/mês');
    await expect(page.locator('#adTalk .addon-price-tabela')).toHaveText('de R$ 5,53');
    await expect(page.locator('#adBackup90 .addon-price')).toHaveText('R$ 6,00/conta/mês');
    await expect(page.locator('#adBackup90 .addon-price-tabela')).toHaveText('de R$ 7,06');
    await expect(page.locator('#adBackup365 .addon-price')).toHaveText('R$ 19,00/conta/mês');
    await expect(page.locator('#adBackup365 .addon-price-tabela')).toHaveText('de R$ 22,35');
    await expect(page.locator('#adGrupo .addon-price')).toHaveText('R$ 2,00/conta/mês');
    await expect(page.locator('#adGrupo .addon-price-tabela')).toHaveText('de R$ 2,35');
    await expect(page.locator('#skyOpt50 .sky-opt-price')).toHaveText('R$ 17,70/conta/mês');
    await expect(page.locator('#skyOpt50 .sky-opt-price-tabela')).toHaveText('de R$ 20,82');
    await expect(page.locator('#skyOpt100 .sky-opt-price-tabela')).toHaveText('de R$ 33,76');
    await expect(page.locator('#skyOpt1tb .sky-opt-price-tabela')).toHaveText('de R$ 375,29');

    await expect(page.locator('#adExtraDom .addon-price')).toHaveText('R$ 79,00/domínio/ano');
    await expect(page.locator('#adExtraDom [data-preco-tabela]')).toHaveCount(0);
  });
});

test.describe('checkout — CIT-22: cascata e economia no resumo (CA10)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('2×5GB mensal', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['2× E-mail 5 GB', 'R$ 20,00']]);
    await expect(page.locator('#sumAccountLines .sum-disc')).toHaveText('de R$ 23,52 · −15% contratação −R$ 3,52');
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 3,52/mês');
  });

  test('2×5GB anual', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2&cycle=annual');
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['2× E-mail 5 GB', 'R$ 16,00']]);
    await expect(page.locator('#sumAccountLines .sum-disc')).toHaveText('de R$ 23,52 · −15% contratação −R$ 3,52 · −20% anual −R$ 4,00');
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 7,52/mês (R$ 90,24/ano)');
  });

  test('5×5GB anual', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=5&cycle=annual');
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['5× E-mail 5 GB', 'R$ 40,00']]);
    await expect(page.locator('#sumAccountLines .sum-disc')).toHaveText('de R$ 58,80 · −15% contratação −R$ 8,80 · −20% anual −R$ 10,00');
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 18,80/mês (R$ 225,60/ano)');
  });

  test('5×25GB mensal', async ({ page, erros }) => {
    await page.goto('checkout.html?qty25=5');
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['5× E-mail 25 GB', 'R$ 76,00']]);
    await expect(page.locator('#sumAccountLines .sum-disc')).toHaveText('de R$ 94,10 · −15% contratação −R$ 14,10 · −5% volume −R$ 4,00');
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 18,10/mês');
  });

  test('2×5GB anual + Talk ×3', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2&cycle=annual');
    await page.evaluate(() => goStep(3));
    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 3);

    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([
      ['2× E-mail 5 GB', 'R$ 16,00'],
      ['Talk ×3', 'R$ 14,10'],
    ]);
    const discs = page.locator('#sumAccountLines .sum-disc');
    await expect(discs).toHaveCount(2);
    await expect(discs.nth(0)).toHaveText('de R$ 23,52 · −15% contratação −R$ 3,52 · −20% anual −R$ 4,00');
    await expect(discs.nth(1)).toHaveText('de R$ 16,59 · −15% contratação −R$ 2,49');
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 10,01/mês (R$ 120,12/ano)');
  });

  test('caso do teste 664: 2×5GB anual + Talk ×1 + Backup 365 ×2 + Skybox 50 ×1', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2&cycle=annual');
    await page.evaluate(() => goStep(3));
    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 1);
    await definirQtdAddon(page, 'Backup', 'aqBackup365', 2);
    await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 1);
    await page.locator('#skyOpt50').click();
    await expect(page.locator('#sumTotal')).toHaveText('R$ 76,40'); // guarda: total não muda (CA1)

    const discs = page.locator('#sumAccountLines .sum-disc');
    await expect(discs).toHaveCount(4);
    await expect(discs.nth(0)).toHaveText('de R$ 23,52 · −15% contratação −R$ 3,52 · −20% anual −R$ 4,00');
    await expect(discs.nth(1)).toHaveText('de R$ 5,53 · −15% contratação −R$ 0,83');
    await expect(discs.nth(2)).toHaveText('de R$ 44,70 · −15% contratação −R$ 6,70');
    await expect(discs.nth(3)).toHaveText('de R$ 20,82 · −15% contratação −R$ 3,12');
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 18,17/mês (R$ 218,04/ano)');
  });

  test('pedido só com add-ons: cada um tem sua cascata; #sumEconomia soma; sem itens fica oculto', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await expect(page.locator('#sumEconomia')).toBeHidden();

    await page.evaluate(() => goStep(3));
    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 2);
    expect(await linhas(page, '#sumAccountLines .sum-line')).toEqual([['Talk ×2', 'R$ 9,40']]);
    await expect(page.locator('#sumAccountLines .sum-disc')).toHaveText('de R$ 11,06 · −15% contratação −R$ 1,66');
    await expect(page.locator('#sumEconomia')).toBeVisible();
    await expect(page.locator('#sumEconomia')).toHaveText('Você economiza R$ 1,66/mês');
  });
});

test.describe('checkout — CIT-22: cores dos riscados e dos preços cobrados (CA12)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('riscado usa --cit-error; cobrado de add-ons/Skybox e a economia usam --cit-success-strong, nunca --cit-success', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));

    const erro = await corToken(page, '--cit-error');
    const sucessoForte = await corToken(page, '--cit-success-strong');
    const sucesso = await corToken(page, '--cit-success');
    expect(sucessoForte).not.toBe(sucesso);

    await expect(page.locator('#ckCard5 [data-preco-tabela="conta:5gb"]')).toHaveCSS('color', erro);
    await expect(page.locator('#sumAccountLines .sum-disc s').first()).toHaveCSS('color', erro);
    await expect(page.locator('#adTalk .addon-price')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#skyOpt50 .sky-opt-price')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#sumEconomia')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#adTalk .addon-price')).not.toHaveCSS('color', sucesso);
    await expect(page.locator('#sumEconomia')).not.toHaveCSS('color', sucesso);
  });

  test('mini-row-price, mini-row-sub e valores das sum-line usam --cit-success-strong; o total geral não muda', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    const sucessoForte = await corToken(page, '--cit-success-strong');
    const primaria = await corToken(page, '--cit-primary');

    await expect(page.locator('#ckCard5 .mini-row-price')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#ckCard5 .mini-row-sub')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#sumAccountLines .sum-line span:last-child').first()).toHaveCSS('color', sucessoForte);

    // Guarda de regressão (CA12): #sumTotal (total geral) mantém a cor de hoje, não vira --cit-success-strong.
    await expect(page.locator('#sumTotal')).toHaveCSS('color', primaria);
    await expect(page.locator('#sumTotal')).not.toHaveCSS('color', sucessoForte);
  });

  test('#ckSub5 sem quantidade (sem riscado ao lado) usa --cit-primary; com quantidade usa --cit-success-strong', async ({ page, erros }) => {
    await page.goto('checkout.html');
    const sucessoForte = await corToken(page, '--cit-success-strong');
    const primaria = await corToken(page, '--cit-primary');

    await expect(page.locator('#ckCard5 .mini-row-sub-tabela')).toBeHidden();
    await expect(page.locator('#ckSub5')).toHaveCSS('color', primaria);
    await expect(page.locator('#ckSub5')).not.toHaveCSS('color', sucessoForte);

    await page.evaluate(() => ckChangeQty('5gb', 1));

    await expect(page.locator('#ckCard5 .mini-row-sub-tabela')).toBeVisible();
    await expect(page.locator('#ckSub5')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#ckSub5')).not.toHaveCSS('color', primaria);
  });
});

test.describe('checkout — CIT-22: contraste do riscado e do cobrado (CA13)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('tabela riscada e valores cobrados têm contraste de pelo menos 4,5:1 no card e no resumo', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    const c = await contrastes(page, [
      '#ckCard5 [data-preco-tabela="conta:5gb"]',
      '#adTalk .addon-price',
      '#skyOpt50 .sky-opt-price',
      '#sumEconomia',
      '#sumAccountLines .sum-disc s',
    ]);
    for (const [sel, valor] of Object.entries(c)) expect(valor, `contraste de ${sel}`).toBeGreaterThanOrEqual(4.5);
  });

  test('add-ons ativos (Talk ×1, Skybox 50 selecionado) mantêm contraste ≥ 4,5:1 sobre o fundo real de seleção', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 1);
    await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 1);
    await page.locator('#skyOpt50').click();
    await expect(page.locator('#adTalk')).toHaveClass(/active/);
    await expect(page.locator('#skyOpt50')).toHaveClass(/selected/);

    const c = await contrastes(page, [
      '#adTalk [data-preco-tabela="talk"]',
      '#adTalk .addon-price',
      '#skyOpt50 [data-preco-tabela="skybox:50gb"]',
      '#skyOpt50 .sky-opt-price',
    ]);
    for (const [sel, valor] of Object.entries(c)) expect(valor, `contraste de ${sel} (ativo)`).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe('checkout — CIT-22: riscado e cobrado não dependem só de cor (CA14)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('o riscado é anunciado com "de" em texto e a cascata usa o sinal "−" (U+2212), não hífen', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2&cycle=annual');
    await expect(page.locator('#ckCard5 .mini-row-tabela .sr-only')).toHaveText('de ');
    const disc = /** @type {string} */ (await page.locator('#sumAccountLines .sum-disc').first().textContent());
    expect(disc).toContain('−15% contratação −R$');
    expect(disc.replace(/−/g, '')).not.toContain('-R$'); // nenhum hífen comum (U+002D) faz as vezes do sinal
  });
});

test.describe('checkout — CIT-22: altura do resumo com cascata e economia (CA15)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  for (const largura of [1280, 961]) {
    test(`${largura}x900 com pedido simples (qty5=2): resumo cabe sem barra de rolagem`, async ({ page, erros }) => {
      await page.setViewportSize({ width: largura, height: 900 });
      await page.goto('checkout.html?qty5=2');
      await page.evaluate(() => document.fonts.ready);
      const m = await page.evaluate(() => {
        const el = document.getElementById('orderSummary');
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      expect(m.scrollHeight, `${largura}x900: pedido simples não deveria ter rolagem interna no resumo`).toBeLessThanOrEqual(m.clientHeight);
    });
  }

  for (const largura of [1280, 961]) {
    test(`${largura}x900, caso do teste 664 (2×5GB anual + Talk + Backup 365×2 + Skybox 50): total e economia alcançáveis rolando só o resumo`, async ({ page, erros }) => {
      await page.setViewportSize({ width: largura, height: 900 });
      await page.goto('checkout.html?qty5=2&cycle=annual');
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => goStep(3));
      await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 1);
      await definirQtdAddon(page, 'Backup', 'aqBackup365', 2);
      await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 1);
      await page.locator('#skyOpt50').click();
      await esperarScrollEstavel(page);

      const scrollYAntes = await page.evaluate(() => window.scrollY);
      await page.evaluate(() => { document.getElementById('orderSummary').scrollTop = document.getElementById('orderSummary').scrollHeight; });
      await expect(page.locator('#sumTotal'), `${largura}x900: #sumTotal deveria ficar alcançável rolando só o resumo`).toBeInViewport();
      await expect(page.locator('#sumEconomia'), `${largura}x900: #sumEconomia deveria ficar alcançável rolando só o resumo`).toBeInViewport();
      const scrollYDepois = await page.evaluate(() => window.scrollY);
      expect(scrollYDepois, `${largura}x900: rolar o resumo não deveria rolar a página`).toBe(scrollYAntes);
    });
  }

  for (const largura of [320, 412, 961, 1280]) {
    test(`largura ${largura}px: sem transbordo horizontal com 1000 contas (tabela R$ 11.760,00)`, async ({ page, erros }) => {
      await page.goto('checkout.html?qty5=1000');
      await page.evaluate(() => document.fonts.ready);
      await page.setViewportSize({ width: largura, height: 900 });
      await expect(page.locator('#sumAccountLines .sum-disc').first()).toContainText('R$ 11.760,00');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `largura ${largura}px: rolagem horizontal do documento`).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('checkout — CIT-22: fonte única de preços, sem valor fixo no HTML bruto (CA17)', { tag: '@CIT-22' }, () => {
  test('contêineres certos, sem preço fixo fora de PRECOS, sem chaves antigas', async ({ page, baseURL, erros }) => {
    await page.goto('checkout.html');

    // HTML bruto, sem executar scripts: contagem de contêineres e regex de preço por dentro deles.
    const resp = await page.request.get(new URL('checkout.html', baseURL).toString());
    const html = await resp.text();
    const resultado = await page.evaluate((rawHtml) => {
      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      const contadores = {
        '.mini-calc-row': doc.querySelectorAll('.mini-calc-row').length,
        '.addon-row': doc.querySelectorAll('.addon-row').length,
        '.sky-opt': doc.querySelectorAll('.sky-opt').length,
      };
      const regex = /\d+,\d\d/g;
      const achados = [];
      for (const sel of ['.mini-calc-row', '.addon-row', '.sky-opt', '#doptBr', '#domPixDesc']) {
        doc.querySelectorAll(sel).forEach(el => {
          const casados = (el.textContent.match(regex) || []).filter(v => v !== '0,00');
          if (casados.length) achados.push(`${sel}#${el.id || ''}: ${casados.join(',')}`);
        });
      }
      return { contadores, achados };
    }, html);

    expect(resultado.contadores, 'contagem de contêineres do checkout').toEqual({ '.mini-calc-row': 3, '.addon-row': 6, '.sky-opt': 3 });
    expect(resultado.achados, 'preço fixo no HTML bruto do checkout (sem executar JS)').toEqual([]);

    // Chaves antigas removidas; domínio principal e extra derivam da mesma PRECOS.dominio (CIT-31).
    const chaves = await page.evaluate(() => ({
      accountDefsComBase: Object.values(ACCOUNT_DEFS).some(d => 'base' in d),
      addonsComPreco: Object.values(ADDONS).some(a => 'preco' in a),
      elementosComDataBase: document.querySelectorAll('[data-base]').length,
      extraDomIgualDominio: ADDONS.extraDom.centavos === PRECOS.dominio,
      addonsTemExtraDom: 'extraDom' in PRECOS.addons,
    }));
    expect(chaves).toEqual({ accountDefsComBase: false, addonsComPreco: false, elementosComDataBase: 0, extraDomIgualDominio: true, addonsTemExtraDom: false });
  });
});

test.describe('checkout — domínio: preço de PRECOS.dominio', { tag: '@CIT-31' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('CIT-31 CA1 — texto inicial de #domPixDesc e chaves sem duplicar o preço do domínio', async ({ page, baseURL, erros }) => {
    await page.goto('checkout.html');

    // Texto inicial de #domPixDesc no HTML bruto, sem executar JS; o scan de preço fixo por
    // contêiner (inclusive #doptBr e #domPixDesc) já é feito pelo CA17 (@CIT-22).
    const resp = await page.request.get(new URL('checkout.html', baseURL).toString());
    const html = await resp.text();
    const domPixDescBruto = await page.evaluate((rawHtml) => {
      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      return doc.getElementById('domPixDesc')?.textContent.trim();
    }, html);
    expect(domPixDescBruto).toBe('Registrar domínio .com.br');

    const chaves = await page.evaluate(() => ({
      dominio: PRECOS.dominio,
      temExtraDom: 'extraDom' in PRECOS.addons,
      extraDomCentavos: ADDONS.extraDom.centavos,
    }));
    expect(chaves).toEqual({ dominio: 7900, temExtraDom: false, extraDomCentavos: 7900 });
  });

  test('CIT-31 CA2 — valores exibidos e cobrados não mudam (principal e extra)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(2));
    await expect(page.locator('#doptBr .opt-price')).toHaveText('R$ 79,00');

    await page.locator('#doptBr').click();
    await expect(page.locator('#domPixDesc')).toHaveText('Registrar domínio .com.br — R$ 79,00/ano');
    await expect(page.locator('#domPixCode')).toContainText('540000079');

    await page.evaluate(() => goStep(3));
    await expect(page.locator('#adExtraDom .addon-price')).toHaveText('R$ 79,00/domínio/ano');
    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 2);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 158,00');
    await expect(page.locator('#extraDomPixCode')).toContainText('540000158');
  });

  test('CIT-31 CA3 — principal e extra derivam da mesma constante PRECOS.dominio', async ({ page, erros }) => {
    await page.goto('checkout.html');
    const ckUnit5Ref = await page.locator('#ckUnit5').textContent();

    const fonte = readFileSync(new URL('../assets/precos.js', import.meta.url), 'utf8');
    const body = fonte.replace('dominio: 7900', 'dominio: 8900');
    expect(body).toContain('dominio: 8900');
    await page.route('**/assets/precos.js*', route => route.fulfill({ contentType: 'application/javascript', body }));
    await page.goto('checkout.html');

    await expect(page.locator('#ckUnit5'), 'controle: preço das contas não deveria mudar').toHaveText(/** @type {string} */ (ckUnit5Ref));
    await expect(page.locator('#doptBr .opt-price')).toHaveText('R$ 89,00');

    await page.evaluate(() => selectDomainOpt('new-br'));
    await expect(page.locator('#domPixDesc')).toHaveText('Registrar domínio .com.br — R$ 89,00/ano');
    await expect(page.locator('#domPixCode')).toContainText('540000089');

    await page.evaluate(() => goStep(3));
    await expect(page.locator('#adExtraDom .addon-price')).toHaveText('R$ 89,00/domínio/ano');
    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 1);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 89,00');
    await expect(page.locator('#extraDomPixCode')).toContainText('540000089');
  });

  test('CIT-31 CA4 — mobile 320px: preço do domínio sem corte nem rolagem horizontal', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.evaluate(() => goStep(2));
    await page.evaluate(() => selectDomainOpt('new-br'));
    await page.locator('#fDomNew').fill('empresateste');
    await expect(page.locator('#doptBr .opt-price'), 'preço do domínio deveria carregar antes de medir').toHaveText('R$ 79,00');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, '320px: rolagem horizontal do documento').toBeLessThanOrEqual(0);

    const caixa = await page.evaluate(() => {
      const el = document.getElementById('doptBr');
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(caixa.scrollWidth, '#doptBr: preço cortado dentro da caixa').toBeLessThanOrEqual(caixa.clientWidth + 1);
  });
});

/**
 * Abre o passo 3 com 2 contas de 5 GB, define o domínio extra = 1 e devolve o texto do
 * código Pix gerado (para comparar com toHaveText nos passos seguintes).
 * @param {import('@playwright/test').Page} page
 */
async function configurarExtraDom1(page) {
  await page.goto('checkout.html?qty5=2');
  await page.evaluate(() => goStep(3));
  await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 1);
  return /** @type {string} */ (await page.locator('#extraDomPixCode').textContent());
}

test.describe('checkout — domínio extra: Pix estável', { tag: '@CIT-30' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('CA1 — regressão: código Pix do domínio extra não muda com Talk, Backup, Skybox nem evento repetido; sem rolagem horizontal', async ({ page, erros }, testInfo) => {
    const c1 = await configurarExtraDom1(page);
    const loc = page.locator('#extraDomPixCode');
    expect(c1).toContain('540000079');
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 79,00');

    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 1);
    await expect(loc).toHaveText(c1);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 79,00');

    await definirQtdAddon(page, 'Backup', 'aqBackup90', 1);
    await expect(loc).toHaveText(c1);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 79,00');

    await abrirSecao(page, 'Armazenamento em nuvem');
    await page.locator('#skyOpt50').click();
    await expect(loc).toHaveText(c1);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 79,00');

    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 0);
    await expect(loc).toHaveText(c1);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 79,00');

    // dispatchEvent('change') com o mesmo valor 1: fill() com valor igual não dispara onchange sozinho.
    await page.locator('#aqExtraDom').dispatchEvent('change');
    await expect(loc).toHaveText(c1);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 79,00');

    // Rolagem horizontal incondicional (não é específica do mobile); com o painel do Pix visível.
    await expect(loc).toBeVisible();
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth, `${testInfo.project.name}: rolagem horizontal com o painel do Pix visível`).toBeLessThanOrEqual(innerWidth);
  });

  test('CA2 — mudar o valor regenera com o valor certo (1 → 2 → 1)', async ({ page, erros }) => {
    const c1 = await configurarExtraDom1(page);
    const loc = page.locator('#extraDomPixCode');

    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 2);
    const c2 = /** @type {string} */ (await loc.textContent());
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 158,00');
    await expect(loc).toContainText('540000158');
    expect(c2, 'código de 2× deveria diferir do código de 1×').not.toBe(c1);

    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 1);
    await expect(loc).toHaveText(c2);
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 158,00');

    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 1);
    await expect(loc).toContainText('540000079');
    await expect(page.locator('#extraDomPixTotal')).toHaveText('R$ 79,00');
  });

  test('CA3 — 1 → 0 → 1: painel some e volta com o mesmo código', async ({ page, erros }) => {
    const c1 = await configurarExtraDom1(page);
    const loc = page.locator('#extraDomPixCode');
    const panel = page.locator('#extraDomPixPanel');
    expect(c1).toContain('540000079');

    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 0);
    await expect(panel).toBeHidden();

    await definirQtdAddon(page, 'Domínio secundário', 'aqExtraDom', 1);
    await expect(panel).toBeVisible();
    await expect(loc).toHaveText(c1);
  });
});

// CIT-31 CA6: precos.js antigo (sem PRECOS.dominio) aciona a mesma guarda de carga do CIT-22 — a
// guarda lança erro de propósito, por isso usa o `test` puro do Playwright (testSemErros), como a
// guarda "sem assets/precos.js" (~:1875), em vez da fixture `erros`.
testSemErros.describe('checkout — CIT-31: precos.js antigo sem PRECOS.dominio (CA6)', { tag: '@CIT-31' }, () => {
  testSemErros('mostra o aviso "Não foi possível carregar os preços. Recarregue a página." e nenhum NaN', async ({ page }) => {
    const fonte = readFileSync(new URL('../assets/precos.js', import.meta.url), 'utf8');
    const body = fonte.replace('dominio: 7900,', '');
    expect(body).not.toContain('dominio:');
    await page.route('**/assets/precos.js*', route => route.fulfill({ contentType: 'application/javascript', body }));
    await page.goto('checkout.html');

    await expect(page.locator('#step1 .sum-empty[role="alert"]')).toHaveText(
      'Não foi possível carregar os preços. Recarregue a página.'
    );
    await expect(page.locator('#sumAccountLines .sum-empty[role="alert"]')).toHaveText(
      'Não foi possível carregar os preços. Recarregue a página.'
    );
    await expect(page.locator('.summary-total')).toBeHidden();
    await expect(page.locator('body')).not.toContainText('NaN');
  });
});

test.describe('checkout — CIT-22: Pix e boleto em centavos inteiros (CA18)', { tag: '@CIT-22' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://viacep.com.br/**', route => route.abort());
  });

  test('caso obrigatório: anual de R$ 76,40 — Pix e boleto sem resto de ponto flutuante', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2&cycle=annual');
    await page.evaluate(() => goStep(3));
    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 1);
    await definirQtdAddon(page, 'Backup', 'aqBackup365', 2);
    await definirQtdAddon(page, 'Armazenamento em nuvem', 'aqSkybox', 1);
    await page.locator('#skyOpt50').click();
    await expect(page.locator('#sumTotal')).toHaveText('R$ 76,40'); // guarda: total não muda (CA1)

    await page.evaluate(() => goStep(5));
    await expect(page.locator('#pixCode')).toContainText('5400076.40');
    await expect(page.locator('#boletoCode')).toContainText('080076.40.000000');
    const boleto = /** @type {string} */ (await page.locator('#boletoCode').textContent());
    expect(boleto).toMatch(/00000000007640$/);
    expect(boleto).not.toMatch(/000000000001/);
  });

  test('caso complementar: mensal de R$ 34,10 (2×5GB + Talk ×3)', async ({ page, erros }) => {
    await page.goto('checkout.html?qty5=2');
    await page.evaluate(() => goStep(3));
    await definirQtdAddon(page, 'Talk – Videoconferência', 'aqTalk', 3);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 34,10');

    await page.evaluate(() => goStep(5));
    await expect(page.locator('#pixCode')).toContainText('5400034.10');
    const boleto = /** @type {string} */ (await page.locator('#boletoCode').textContent());
    expect(boleto).toMatch(/00000000003410$/);
  });

  test('genFakePix do domínio principal não muda: recebe reais inteiros', async ({ page, erros }) => {
    await page.goto('checkout.html');
    await page.evaluate(() => selectDomainOpt('new-br'));
    await expect(page.locator('#domPixCode')).toContainText('540000079');
  });
});

// CIT-22: guarda de carga quando assets/precos.js não carrega. Estes testes ESPERAM erro de rede/console
// de propósito (abortam o script e conferem o aviso), por isso não usam a fixture `erros` — usam o `test`
// puro do Playwright (testSemErros), que não falha ao ver erros registrados.
testSemErros.describe('checkout — CIT-22: guarda quando assets/precos.js não carrega', { tag: '@CIT-22' }, () => {
  testSemErros('mostra o aviso "Não foi possível carregar os preços. Recarregue a página." no passo 1 e no resumo', async ({ page }) => {
    await page.route('**/assets/precos.js*', route => route.abort());
    await page.goto('checkout.html');
    await expect(page.locator('#step1 .sum-empty[role="alert"]')).toHaveText(
      'Não foi possível carregar os preços. Recarregue a página.'
    );
    await expect(page.locator('#sumAccountLines .sum-empty[role="alert"]')).toHaveText(
      'Não foi possível carregar os preços. Recarregue a página.'
    );
    await expect(page.locator('.summary-total')).toBeHidden();
  });
});

// CIT-153: o aviso "Copiado" do Pix de pagamento (passo 5) deve aparecer no próprio #btnCopyPix, não em
// outro botão .pix-copy do checkout (copyPix() usava document.querySelector('.pix-copy') sem escopo).
test.describe('checkout — Pix de pagamento: feedback de cópia', { tag: '@CIT-153' }, () => {
  test('CA1 copiar o Pix no passo 5 mostra "Copiado" só em #btnCopyPix, copia #pixCode e o botão volta a "Copiar"', async ({ page, context, erros }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('checkout.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => goStep(5));
    await page.locator('#payPix .payment-name').click();

    const codigoPix = await page.locator('#pixCode').textContent();
    await page.locator('#btnCopyPix').click();

    await expect(page.locator('#btnCopyPix')).toContainText('Copiado');
    for (const id of ['#btnCopyDomPix', '#btnCopyExtraDomPix']) {
      await expect(page.locator(id)).toContainText('Copiar');
      await expect(page.locator(id)).not.toContainText('Copiado');
    }
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(codigoPix);

    await expect(page.locator('#btnCopyPix')).toContainText('Copiar', { timeout: 5000 });
    await expect(page.locator('#btnCopyPix')).not.toContainText('Copiado');
  });

  test('CA3 a 320px, com #btnCopyPix mostrando "Copiado", a página não tem rolagem horizontal', async ({ page, context, erros }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'CA3 só se aplica ao perfil mobile');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('checkout.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => goStep(5));
    await page.locator('#payPix .payment-name').click();
    await page.locator('#btnCopyPix').click();

    await expect(page.locator('#btnCopyPix')).toContainText('Copiado');
    const semRolagem = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(semRolagem).toBe(true);
  });
});

// CIT-163: feedback dos botões de cópia do checkout — janela de 2 s a partir do último clique (#161)
// e falha na área de transferência (#162). Dados fictícios; sem terceiros.
test.describe('checkout — cópia: feedback e falha', { tag: '@CIT-163' }, () => {
  /** Preparos que deixam cada botão de cópia visível (mesma navegação do CA5 (e) de tests/csp.spec.js). */
  const preparos = {
    /** @param {import('@playwright/test').Page} page */
    async domPix(page) {
      await page.evaluate(() => goStep(2));
      await page.locator('#doptBr').click();
      await page.locator('#fDomNew').fill('minhaempresateste');
    },
    /** @param {import('@playwright/test').Page} page */
    async extraDomPix(page) {
      await page.evaluate(() => goStep(3));
      const secaoDominio = page.locator('#step3 .addon-sec-btn')
        .filter({ has: page.locator('.addon-sec-nome', { hasText: /^Domínio secundário$/ }) });
      await secaoDominio.click();
      await page.locator('button[data-addon="extraDom"][data-addon-delta="1"]').click();
      await expect(page.locator('#extraDomPixPanel')).toBeVisible();
    },
    /** @param {import('@playwright/test').Page} page */
    async pix(page) {
      await page.evaluate(() => goStep(5));
      await page.locator('#payPix .payment-name').click();
    },
    /** @param {import('@playwright/test').Page} page */
    async boleto(page) {
      await page.evaluate(() => goStep(5));
      await page.locator('#payBoleto .payment-name').click();
    },
  };

  const botoes = [
    { nome: 'domínio novo', preparo: 'domPix', botao: '#btnCopyDomPix', codigo: '#domPixCode', aviso: '#domPixCopiaAviso', original: 'Copiar' },
    { nome: 'domínio extra', preparo: 'extraDomPix', botao: '#btnCopyExtraDomPix', codigo: '#extraDomPixCode', aviso: '#extraDomPixCopiaAviso', original: 'Copiar' },
    { nome: 'Pix', preparo: 'pix', botao: '#btnCopyPix', codigo: '#pixCode', aviso: '#pixCopiaAviso', original: 'Copiar' },
    { nome: 'boleto', preparo: 'boleto', botao: '#btnCopyBoleto', codigo: '#boletoCode', aviso: '#boletoCopiaAviso', original: 'Copiar código' },
  ];

  for (const b of botoes.filter(x => x.preparo !== 'boleto')) {
    test(`CA1 (#161) em ${b.nome}, o segundo clique mantém "Copiado" por 2 s a partir dele (t=2,3 s ainda "Copiado"; t=3,6 s "Copiar")`, async ({ page, context, erros }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.addInitScript(() => {
        // @ts-ignore
        window.__copiasOk = 0;
        const original = Clipboard.prototype.writeText;
        Clipboard.prototype.writeText = function (...args) {
          const promessa = original.apply(this, args);
          promessa.then(() => { /** @type {any} */ (window).__copiasOk++; }, () => {});
          return promessa;
        };
      });
      await page.clock.install({ time: new Date('2026-01-01T10:00:00') });
      await page.goto('checkout.html', { waitUntil: 'networkidle' });
      await preparos[/** @type {'domPix'|'extraDomPix'|'pix'} */ (b.preparo)](page);

      const agora = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(agora + 1000);
      const botao = page.locator(b.botao);
      const copias = () => page.evaluate(() => /** @type {any} */ (window).__copiasOk);

      await botao.click();
      await expect.poll(copias).toBe(1);
      await expect(botao).toContainText('Copiado');

      await page.clock.runFor(1500);
      await botao.click();
      await expect.poll(copias).toBe(2);

      await page.clock.runFor(800);
      await expect(botao).toContainText('Copiado');

      await page.clock.runFor(1300);
      await expect(botao).toContainText('Copiar');
      await expect(botao).not.toContainText('Copiado');
    });
  }

  /**
   * @param {string} titulo
   * @param {'rejeicao'|'ausente'} variante
   * @param {typeof botoes[number]} b
   */
  function testeFalha(titulo, variante, b) {
    test(titulo, async ({ page, context, erros }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      if (variante === 'rejeicao') {
        await page.addInitScript(() => {
          Clipboard.prototype.writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
        });
      } else {
        await page.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
        });
      }
      let dialogs = 0;
      page.on('dialog', d => { dialogs++; d.dismiss(); });
      await page.goto('checkout.html', { waitUntil: 'networkidle' });
      await preparos[/** @type {'domPix'|'extraDomPix'|'pix'|'boleto'} */ (b.preparo)](page);

      const codigo = ((await page.locator(b.codigo).textContent()) ?? '').trim();
      const botao = page.locator(b.botao);
      await botao.click();

      await expect(botao).toContainText('Erro ao copiar');
      await expect(botao).not.toContainText('Copiado');
      await expect(page.locator(b.aviso)).toBeVisible();
      await expect(page.locator(b.aviso)).toContainText('Não foi possível copiar');
      await expect.poll(() => page.evaluate(() => (window.getSelection()?.toString() ?? '').trim())).toBe(codigo);
      expect(dialogs).toBe(0);

      await expect(botao).toContainText(b.original, { timeout: 5000 });
      await expect(botao).not.toContainText('Erro ao copiar');
      await expect(page.locator(b.aviso)).toContainText('Não foi possível copiar');
    });
  }

  for (const b of botoes) {
    testeFalha(`CA2 (#162) com writeText rejeitando, o botão de ${b.nome} mostra "Erro ao copiar", avisa, seleciona o código e volta ao normal`, 'rejeicao', b);
  }
  for (const b of botoes.filter(x => x.preparo === 'pix' || x.preparo === 'boleto')) {
    testeFalha(`CA2 (#162) sem navigator.clipboard, o botão de ${b.nome} mostra "Erro ao copiar", avisa, seleciona o código e volta ao normal`, 'ausente', b);
  }
});
