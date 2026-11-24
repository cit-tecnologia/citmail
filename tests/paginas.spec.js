// @ts-check
import { test, expect } from './fixtures.js';
import { BASE_API, CONTRA_SITE_PUBLICADO, mockarPainel, descartarPainel } from './painel-mock.js';

const paginas = [
  { arquivo: 'index.html', titulo: 'CITMail — E-mail corporativo com domínio próprio' },
  { arquivo: 'login.html', titulo: 'Entrar — CITMail' },
  { arquivo: 'checkout.html', titulo: 'Contratar Plano — CITMail' },
  // CIT-70: painel.html sem sessão redireciona para login.html (caso próprio abaixo, fora desta lista).
  { arquivo: 'termos.html', titulo: 'Termos de Uso — CITMail' },
  { arquivo: 'pedido.html', titulo: 'Acompanhe seu pedido — CITMail' },
];

// CIT-49/CIT-158: páginas com CSP por meta e script externo (smoke também roda contra CITMAIL_BASE_URL).
const comCsp = ['index.html', 'checkout.html', 'login.html', 'painel.html', 'termos.html', 'pedido.html'];
const scriptDaPagina = { 'index.html': 'landing.js', 'checkout.html': 'checkout.js', 'login.html': 'login.js', 'painel.html': 'painel.js', 'pedido.html': 'pedido.js' };
// CIT-51: termos.html não tem JS (fica fora de scriptDaPagina).
// CIT-152: CSS de cada página em assets/<página>.css (conferido pelo caminho, sem a query ?v=).
const folhaDaPagina = { 'index.html': 'landing.css', 'checkout.html': 'checkout.css', 'login.html': 'login.css', 'painel.html': 'painel.css', 'termos.html': 'termos.css', 'pedido.html': 'pedido.css' };
// login.html/painel.html entraram na CIT-158, não na CIT-49/CIT-52 (ver CA7 do plano).
const tagsCspPorPagina = {
  'index.html': ['@CIT-49', '@CIT-52'],
  'checkout.html': ['@CIT-49', '@CIT-52'],
  'login.html': ['@CIT-158'],
  'painel.html': ['@CIT-158'],
  'termos.html': ['@CIT-51'],
  'pedido.html': ['@CIT-69'],
};
// CIT-52: fontes locais — lista fixa (smoke não lê assets/fonts.css do disco; roda também na homologação).
const arquivosDeFonte = [
  'assets/fonts.css',
  'assets/fonts/montserrat-600.woff2',
  'assets/fonts/montserrat-700.woff2',
  'assets/fonts/montserrat-800.woff2',
  'assets/fonts/poppins-400.woff2',
  'assets/fonts/poppins-500.woff2',
  'assets/fonts/poppins-600.woff2',
];

for (const { arquivo, titulo } of paginas) {
  const tags = ['@CIT-12', '@CIT-13'];
  if (comCsp.includes(arquivo)) tags.push(...tagsCspPorPagina[arquivo], '@CIT-152');

  // também é o smoke da homologação (CITMAIL_BASE_URL), por isso não fixa o subcaminho /citmail/
  test(`${arquivo} carrega sem erros e com todos os ícones do sprite`, { tag: tags }, async ({ page, baseURL, erros }) => {
    if (comCsp.includes(arquivo)) {
      // CA7: zero violação de CSP na carga (registrado antes do goto).
      await page.addInitScript(() => {
        // @ts-ignore
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', e => {
          // @ts-ignore
          window.__csp.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
        });
      });
    }

    await page.goto(arquivo, { waitUntil: 'networkidle' });

    // garante que é a página pedida (e não um fallback ou redirecionamento)
    await expect(page).toHaveURL(new URL(arquivo, baseURL).href);
    await expect(page).toHaveTitle(titulo);

    // todo <use href="...icons.svg#id"> precisa apontar para um símbolo existente no sprite
    const ausentes = await page.evaluate(async () => {
      const usos = [...document.querySelectorAll('use')]
        .map(u => u.getAttribute('href') || u.getAttribute('xlink:href') || '')
        .filter(href => href.includes('icons.svg#'));
      if (!usos.length) return [];
      const resposta = await fetch(new URL(usos[0].split('#')[0], location.href));
      if (!resposta.ok) return [`sprite ${resposta.status}`];
      const sprite = new DOMParser().parseFromString(await resposta.text(), 'image/svg+xml');
      const ids = new Set([...sprite.querySelectorAll('[id]')].map(el => el.id));
      return [...new Set(usos.map(href => href.split('#')[1]))].filter(id => !ids.has(id));
    });
    expect(ausentes, 'ícones referenciados que não existem no sprite').toEqual([]);

    if (comCsp.includes(arquivo)) {
      // CA7: meta CSP presente, zero violação na carga, e o script novo respondendo 200.
      await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
      const violacoes = await page.evaluate(() => /** @type {any} */ (window).__csp || []);
      expect(violacoes, 'violações de CSP na carga').toEqual([]);

      const arquivoJs = scriptDaPagina[arquivo];
      if (arquivoJs) {
        const status = await page.evaluate(async js => (await fetch(new URL(`assets/${js}`, location.href))).status, arquivoJs);
        expect(status, `assets/${arquivoJs} não respondeu 200`).toBe(200);
      }

      // CA7 (CIT-152): a página carregou a própria folha pelo caminho assets/<página>.css, ignorando a query.
      const folha = folhaDaPagina[arquivo];
      const folhasCarregadas = await page.evaluate(() => [...document.styleSheets]
        .filter(f => f.href).map(f => new URL(/** @type {string} */ (f.href)).pathname));
      expect(folhasCarregadas.some(caminho => caminho.endsWith(`/assets/${folha}`)), `assets/${folha} entre as folhas carregadas: ${folhasCarregadas.join(', ')}`).toBe(true);
      const statusFolha = await page.evaluate(async css => (await fetch(new URL(`assets/${css}`, location.href))).status, folha);
      expect(statusFolha, `assets/${folha} não respondeu 200`).toBe(200);

      // CA3 (CIT-52): fontes locais (CSS + 6 woff2) servidas, inclusive na homologação.
      const statusFontes = await page.evaluate(async lista => {
        const respostas = await Promise.all(lista.map(caminho => fetch(new URL(caminho, location.href))));
        return respostas.map(r => r.status);
      }, arquivosDeFonte);
      for (const [i, codigo] of statusFontes.entries()) {
        expect(codigo, `${arquivosDeFonte[i]} não respondeu 200`).toBe(200);
      }
    }
  });
}

// CIT-70: sem a API (modo local: Pages, homologação, 127.0.0.1) o painel não tem sessão e vai para o login.
// Roda também contra CITMAIL_BASE_URL (smoke da homologação); por isso não fixa o subcaminho /citmail/.
test('painel.html sem sessão redireciona para login.html, com os assets do painel servidos', { tag: ['@CIT-70', '@CIT-158', '@CIT-152'] }, async ({ page, baseURL, erros }) => {
  await page.goto('painel.html', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(new URL('login.html', baseURL).href);
  await expect(page).toHaveTitle('Entrar — CITMail');

  // os assets de painel.html continuam publicados (a página nunca os usa no modo local, mas o modo API depende deles)
  const status = await page.evaluate(async lista => (await Promise.all(lista.map(c => fetch(new URL(c, location.href))))).map(r => r.status), ['assets/painel.js', 'assets/painel.css']);
  expect(status, 'assets/painel.js e assets/painel.css respondem 200').toEqual([200, 200]);
});

// CIT-152, CA5: a 320 px, nenhuma das quatro páginas (nem os modais) rola na horizontal.
test.describe('CIT-152 CA5 — 320 px', { tag: '@CIT-152' }, () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
    await page.setViewportSize({ width: 320, height: 640 });
  });
  const semRolagemHorizontal = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  for (const { arquivo } of paginas) {
    test(`CA5 ${arquivo} a 320 px sem rolagem horizontal`, async ({ page, erros }) => {
      await page.goto(arquivo, { waitUntil: 'networkidle' });
      expect(await semRolagemHorizontal(page), `${arquivo}: scrollWidth <= innerWidth`).toBe(true);
    });
  }

  // CIT-70: no modo local o formulário e o modal ficam ocultos; o modal "Recuperar senha" só existe no modo API
  // (localhost:4200, com /api/painel/* mockado). Pulado quando CITMAIL_BASE_URL aponta para um site publicado.
  test.describe('modo API', { tag: '@CIT-70' }, () => {
    test.use({ baseURL: BASE_API });
    test.skip(CONTRA_SITE_PUBLICADO, 'modo API só existe em http://localhost:4200 (Vite local)');

    test('CA5 login a 320 px com o modal "Recuperar senha" aberto e com o toast sem rolagem horizontal', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await page.locator('[data-login-acao="esqueci"]').click();
      await expect(page.locator('#forgotOverlay')).toBeVisible();
      expect(await semRolagemHorizontal(page), 'modal aberto').toBe(true);
      await page.locator('#fForgotEmail').fill('teste@fixture.com.br');
      await page.locator('[data-login-acao="enviar"]').click();
      await expect(page.locator('body > div', { hasText: 'Link enviado' })).toBeVisible();
      expect(await semRolagemHorizontal(page), 'toast visível').toBe(true);
      descartarPainel(erros);
    });

    test('CA5 painel a 320 px com a sessão mockada e o menu aberto sem rolagem horizontal', async ({ page, erros }) => {
      await mockarPainel(page, { sessao: 200 });
      await page.goto('painel.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#painelEmail')).toHaveText('titular@exemplo.com.br');
      await page.locator('#sidebarToggle').click();
      await expect(page.locator('#sidebar')).toHaveClass(/open/);
      expect(await semRolagemHorizontal(page), 'menu aberto').toBe(true);
      descartarPainel(erros);
    });
  });
});
