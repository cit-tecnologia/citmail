// @ts-check
import { readFileSync, existsSync } from 'node:fs';
import { test, expect } from './fixtures.js';

// CIT-51: Termos de Uso (termos.html, minuta 0.1). Sem rede externa: o link da Política só tem os atributos conferidos.

const POLITICA = 'https://privacidade.cittecnologia.com.br/';
const VERSAO = 'Versão 0.1 (minuta) · vigência a partir de [PREENCHER data]';
const H2 = [
  '1. Partes e aceite', '2. O serviço', '3. Domínio', '4. Contratação, preço e pagamento', '5. Ativação',
  '6. Inadimplência e suspensão', '7. Uso aceitável', '8. Disponibilidade, backup e suporte', '9. Cancelamento',
  '10. Dados pessoais', '11. Responsabilidade', '12. Mudanças nestes termos', '13. Foro',
];
const FOOTER_LEGAL = ['Termos de Uso', 'Política de Privacidade (abre em nova aba)'];
const lerFonte = (/** @type {string} */ arquivo) => readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');

test.describe('termos — CIT-51: conteúdo', { tag: '@CIT-51' }, () => {
  test('CA1 título, h1 e aviso de versão preliminar', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page).toHaveTitle('Termos de Uso — CITMail');
    await expect(page.locator('h1')).toHaveText('Termos de Uso da CITMail');
    await expect(page.locator('.termos-aviso')).toHaveText('Versão preliminar em revisão jurídica. Os trechos entre colchetes serão completados antes da vigência.');
  });

  test('CA1 versão e vigência no topo e no fim', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('#termosVersao')).toHaveText(VERSAO);
    await expect(page.locator('#termosVersaoFim')).toHaveText(VERSAO);
  });

  test('CA1 seção 1 traz razão social e CNPJ da CIT Tecnologia', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('main')).toContainText('Estes termos regem o uso da CITMail, serviço de e-mail corporativo da CIT TECNOLOGIA DA INFORMACAO LTDA - ME ("CIT Tecnologia"), CNPJ 22.080.376/0001-96, por quem contrata o serviço ("cliente").');
  });

  test('CA1 seção 8 traz o horário de suporte da landing', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('main')).toContainText('Suporte: por ticket no painel e por e-mail, em dias úteis, das 08h00 às 18h00.');
  });

  test('CA1 seção 11 traz o limite de responsabilidade em parágrafo próprio', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('main p', { hasText: /^Limite de responsabilidade:/ })).toHaveText('Limite de responsabilidade: [a definir].');
  });

  test('CA1 as 13 seções (h2) na ordem', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('main h2')).toHaveText(H2);
  });

  test('CA1 há 10 marcadores pendentes e todos no formato [PREENCHER ...] ou [a definir]', async ({ page, erros }) => {
    await page.goto('termos.html');
    const marcadores = page.locator('.termos-pendente');
    await expect(marcadores).toHaveCount(10);
    const textos = (await marcadores.allTextContents()).map(t => t.trim());
    for (const t of textos) expect(t).toMatch(/^\[(PREENCHER( [a-zà-ú ]+)?|a definir)\]$/);
  });

  test('CA1 o fonte não tem notas internas, style, atributos on* nem script', async ({ erros }) => {
    const fonte = lerFonte('termos.html');
    for (const proibido of ['CONFIRMAR', 'jurídico', 'Jurídico', '#48']) {
      expect(fonte, `fonte contém "${proibido}"`).not.toContain(proibido);
    }
    expect(fonte, 'atributo style').not.toMatch(/\sstyle=/);
    expect(fonte, 'atributo on*').not.toMatch(/\son[a-z]+=/i);
    expect(fonte, 'script').not.toMatch(/<script/i);
  });

  test('CA1 meta robots é noindex enquanto for minuta', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  });

  test('CA1 termos.html e index.html referenciam o mesmo landing.css?v=', async ({ erros }) => {
    const versao = (/** @type {string} */ arquivo) => lerFonte(arquivo).match(/assets\/landing\.css\?v=([^"']+)/)?.[1];
    expect(versao('termos.html'), 'landing.css?v= em termos.html').toBeTruthy();
    expect(versao('termos.html')).toBe(versao('index.html'));
  });

  test('CA1 e CA2 os 2 links da Política no main são externos, em nova aba, com ícone e aviso para leitor de tela', async ({ page, erros }) => {
    const externas = [];
    page.on('request', req => { if (req.url().includes('privacidade.cittecnologia')) externas.push(req.url()); });
    await page.goto('termos.html');
    const links = page.locator(`main a[href^="https://privacidade"]`);
    await expect(links).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const link = links.nth(i);
      await expect(link).toHaveAttribute('href', POLITICA);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expect(link).toHaveAttribute('rel', /noreferrer/);
      await expect(link.locator('.sr-only')).toHaveText(' (abre em nova aba)');
      await expect(link.locator('svg.icon use[href$="#external-link"]')).toHaveCount(1);
      await expect(link.locator('svg.icon')).toHaveAttribute('aria-hidden', 'true');
    }
    expect(externas).toEqual([]);
  });

  test('CA2 privacidade.html não existe', async ({ erros }) => {
    expect(existsSync(new URL('../privacidade.html', import.meta.url))).toBe(false);
  });
});

test.describe('termos — CIT-51: navegação e rodapé', { tag: '@CIT-51' }, () => {
  test('CA3 header tem um só .nav-logo para index.html com aria-label CITMail', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('.nav-logo')).toHaveCount(1);
    await expect(page.locator('.nav-logo').first()).toHaveAttribute('href', 'index.html');
    await expect(page.locator('.nav-logo').first()).toHaveAttribute('aria-label', 'CITMail');
  });

  test('CA3 "Voltar ao site" aponta para index.html', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('.termos-voltar')).toHaveAttribute('href', 'index.html');
    await expect(page.locator('.termos-voltar')).toHaveText('Voltar ao site');
    await expect(page.locator('.termos-voltar')).toBeVisible();
  });

  test('CA3 "Voltar ao site" leva à landing', async ({ page, erros }) => {
    await page.goto('termos.html');
    await page.locator('.termos-voltar').click();
    await expect(page).toHaveURL(/index\.html$/);
  });

  test('CA3 rodapé tem os links legais e marca Termos como página atual', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('.footer-legal a')).toHaveText(FOOTER_LEGAL);
    await expect(page.locator('.footer-legal a').first()).toHaveAttribute('aria-current', 'page');
  });

  test('CA2 link da Política no rodapé é externo, em nova aba, com ícone e aviso para leitor de tela', async ({ page, erros }) => {
    await page.goto('termos.html');
    const link = page.locator('.footer-legal a', { hasText: 'Política de Privacidade' });
    await expect(link).toHaveAttribute('href', POLITICA);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
    await expect(link.locator('.sr-only')).toHaveText(' (abre em nova aba)');
    await expect(link.locator('svg.icon use[href$="#external-link"]')).toHaveCount(1);
    await expect(link.locator('svg.icon')).toHaveAttribute('aria-hidden', 'true');
  });

  test('CA3 nenhum a[href="#"] na página', async ({ page, erros }) => {
    await page.goto('termos.html');
    await expect(page.locator('a[href="#"]')).toHaveCount(0);
  });
});

test.describe('termos — CIT-51: mobile', { tag: '@CIT-51' }, () => {
  for (const largura of [320, 375]) {
    test(`CA5 ${largura}px: sem rolagem horizontal, blocos dentro da tela e logo sem sobrepor "Voltar ao site"`, async ({ page, erros }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'CA5 só no perfil mobile');
      await page.setViewportSize({ width: largura, height: 800 });
      await page.goto('termos.html', { waitUntil: 'networkidle' });

      const m = await page.evaluate(() => {
        const caixa = (/** @type {Element} */ el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        const doc = document.documentElement;
        return {
          scrollWidth: doc.scrollWidth,
          largura: window.innerWidth,
          main: caixa(/** @type {Element} */ (document.querySelector('main'))),
          pendentes: [...document.querySelectorAll('.termos-pendente')].map(caixa),
          legal: caixa(/** @type {Element} */ (document.querySelector('.footer-legal'))),
          logo: caixa(/** @type {Element} */ (document.querySelector('.nav-logo'))),
          voltar: caixa(/** @type {Element} */ (document.querySelector('.termos-voltar'))),
        };
      });
      expect(m.scrollWidth, 'scrollWidth <= innerWidth').toBeLessThanOrEqual(m.largura);
      const dentro = (/** @type {{x:number,w:number}} */ c, /** @type {string} */ nome) => {
        expect(c.x, `${nome} x`).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w, `${nome} x+largura`).toBeLessThanOrEqual(m.largura);
      };
      dentro(m.main, 'main');
      dentro(m.legal, '.footer-legal');
      m.pendentes.forEach((c, i) => dentro(c, `.termos-pendente[${i}]`));
      const interseccao = m.logo.x < m.voltar.x + m.voltar.w && m.voltar.x < m.logo.x + m.logo.w
        && m.logo.y < m.voltar.y + m.voltar.h && m.voltar.y < m.logo.y + m.logo.h;
      expect(interseccao, '.nav-logo e .termos-voltar se sobrepõem').toBe(false);
    });
  }
});
