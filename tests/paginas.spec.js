// @ts-check
import { test, expect } from './fixtures.js';

const paginas = [
  { arquivo: 'index.html', titulo: 'CITMail — E-mail corporativo com domínio próprio' },
  { arquivo: 'login.html', titulo: 'Entrar — CITMail' },
  { arquivo: 'checkout.html', titulo: 'Contratar Plano — CITMail' },
  { arquivo: 'painel.html', titulo: 'Painel do Cliente — CITMail' },
];

// CIT-49/CIT-158: páginas com CSP por meta e script externo (smoke também roda contra CITMAIL_BASE_URL).
const comCsp = ['index.html', 'checkout.html', 'login.html', 'painel.html'];
const scriptDaPagina = { 'index.html': 'landing.js', 'checkout.html': 'checkout.js', 'login.html': 'login.js', 'painel.html': 'painel.js' };
// login.html/painel.html entraram na CIT-158, não na CIT-49/CIT-52 (ver CA7 do plano).
const tagsCspPorPagina = {
  'index.html': ['@CIT-49', '@CIT-52'],
  'checkout.html': ['@CIT-49', '@CIT-52'],
  'login.html': ['@CIT-158'],
  'painel.html': ['@CIT-158'],
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
  if (comCsp.includes(arquivo)) tags.push(...tagsCspPorPagina[arquivo]);

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
      const status = await page.evaluate(async js => (await fetch(new URL(`assets/${js}`, location.href))).status, arquivoJs);
      expect(status, `assets/${arquivoJs} não respondeu 200`).toBe(200);

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
