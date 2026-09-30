// @ts-check
import { readFileSync, existsSync } from 'node:fs';
import { test, expect } from './fixtures.js';

// CIT-52: landing e checkout passam a hospedar Montserrat e Poppins em assets/fonts/ (6 woff2),
// com @font-face em assets/fonts.css, sem Google Fonts. Ver .omc/plans/CIT-52.md
// ("Critérios de aceite" e "Testes por critério") para o desenho de cada verificação.

const RAIZ = new URL('../', import.meta.url);
const PAGINAS = ['index.html', 'checkout.html'];

/** Lê um arquivo do disco (não do Vite: um fetch de .css sem Accept: text/css volta como módulo JS). */
function lerDoDisco(nome) {
  return readFileSync(new URL(nome, RAIZ), 'utf8');
}

const REGEX_HOST_GOOGLE_FONTS = /fonts\.(googleapis|gstatic)\.com/;

/** unicode-range do subset latin do Google (idêntico ao do fontsource), do "Resultado do passo 0" do plano. */
const UNICODE_RANGE_LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, ' +
  'U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

/** Caracteres com fallback conhecido, já registrados no plano (fora do subset latin). */
const FALLBACK_CONHECIDO = ['→'];

/** "U+0000-00FF, U+0131, ..." -> [[0, 255], [0x131, 0x131], ...] */
function analisarUnicodeRange(valor) {
  return valor.split(',').map(token => {
    const m = token.trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!m) throw new Error(`token de unicode-range não reconhecido: "${token}"`);
    const inicio = parseInt(m[1], 16);
    return [inicio, m[2] ? parseInt(m[2], 16) : inicio];
  });
}

/** Normaliza para comparar duas listas de unicode-range sem depender da ordem dos tokens. */
function normalizarUnicodeRange(valor) {
  return valor.split(',').map(t => t.trim().toUpperCase()).sort().join(', ');
}

function estaNoIntervalo(codePoint, intervalos) {
  return intervalos.some(([inicio, fim]) => codePoint >= inicio && codePoint <= fim);
}

/** Extrai, em ordem, o valor de unicode-range de cada bloco @font-face do CSS. */
function unicodeRangesDoCss(css) {
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)]
    .map(bloco => bloco[1].match(/unicode-range\s*:\s*([^;]+);/i)?.[1]?.trim())
    .filter(Boolean);
}

/** As 6 faces esperadas em assets/fonts.css (uma por peso). */
const FACES_ESPERADAS = [
  ['Montserrat', '600'], ['Montserrat', '700'], ['Montserrat', '800'],
  ['Poppins', '400'], ['Poppins', '500'], ['Poppins', '600'],
];

test.describe('CA1 — sem Google Fonts', { tag: '@CIT-52' }, () => {
  for (const arquivo of PAGINAS) {
    test(`CA1 ${arquivo}: nenhuma requisição nem referência a host do Google Fonts`, async ({ page, erros }) => {
      const requisicoesGoogle = [];
      page.on('request', req => {
        if (REGEX_HOST_GOOGLE_FONTS.test(new URL(req.url()).host)) requisicoesGoogle.push(req.url());
      });

      await page.goto(arquivo, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);

      expect(requisicoesGoogle, `${arquivo}: requisição a host do Google Fonts`).toEqual([]);
      expect(lerDoDisco(arquivo), `${arquivo}: host do Google Fonts no HTML fonte`).not.toMatch(REGEX_HOST_GOOGLE_FONTS);
    });
  }
});

test.describe('CA2 — fontes locais aplicadas', { tag: '@CIT-52' }, () => {
  test('CA2 index.html: h1.hero-title em Montserrat 700 e body em Poppins 400', async ({ page, erros }) => {
    await page.goto('index.html', { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    const hero = await page.locator('h1.hero-title').evaluate(el => {
      const cs = getComputedStyle(el);
      return { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight };
    });
    expect(hero.fontFamily, 'font-family de h1.hero-title').toMatch(/^"?Montserrat/);
    expect(hero.fontWeight, 'font-weight de h1.hero-title').toBe('700');

    const corpo = await page.locator('body').evaluate(el => {
      const cs = getComputedStyle(el);
      return { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight };
    });
    expect(corpo.fontFamily, 'font-family do body').toMatch(/^"?Poppins/);
    expect(corpo.fontWeight, 'font-weight do body').toBe('400');
  });

  test('CA2 checkout.html: body em Poppins 400', async ({ page, erros }) => {
    await page.goto('checkout.html', { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    const corpo = await page.locator('body').evaluate(el => {
      const cs = getComputedStyle(el);
      return { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight };
    });
    expect(corpo.fontFamily, 'font-family do body').toMatch(/^"?Poppins/);
    expect(corpo.fontWeight, 'font-weight do body').toBe('400');
  });

  test('CA2 index.html: as 6 faces registradas (família + peso) batem exatamente com o esperado e cada uma carrega', async ({ page, erros }) => {
    await page.goto('index.html', { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    // document.fonts.check() não distingue origem (local x Google), e document.fonts.load('<peso> ...')
    // pode "casar" com o peso mais próximo registrado em vez de falhar quando o peso exato não existe
    // (algoritmo de correspondência de fontes do navegador). Por isso a prova lê o conjunto real de
    // FontFace registradas por @font-face (document.fonts, a FontFaceSet) e exige igualdade exata de
    // família+peso com o esperado — um peso errado ou ausente aparece como diferença no conjunto.
    const registradas = await page.evaluate(() =>
      [...document.fonts].map(f => `${f.family.replace(/^"|"$/g, '')} ${f.weight}`).sort());
    const esperadas = FACES_ESPERADAS.map(([familia, peso]) => `${familia} ${peso}`).sort();
    expect(registradas, 'FontFace registradas (família + peso) via @font-face').toEqual(esperadas);

    const status = await page.evaluate(async () => {
      const carregadas = await Promise.all([...document.fonts].map(f => f.load()));
      return carregadas.map(f => f.status);
    });
    for (const s of status) expect(s, 'FontFace não carregou (status loaded)').toBe('loaded');
  });

  test('CA2 assets/fonts.css: unicode-range das 6 faces idêntico ao subset latin do Google', () => {
    const ranges = unicodeRangesDoCss(lerDoDisco('assets/fonts.css'));
    expect(ranges, 'quantidade de blocos @font-face com unicode-range').toHaveLength(6);
    for (const valor of ranges) {
      expect(normalizarUnicodeRange(valor), 'unicode-range de uma face').toBe(normalizarUnicodeRange(UNICODE_RANGE_LATIN));
    }
  });

  test('CA2 cobertura de glifos: todo caractere do texto da landing e do checkout está no subset latin (exceto o fallback conhecido)', async ({ page, erros }) => {
    const intervalos = analisarUnicodeRange(UNICODE_RANGE_LATIN);
    const foraDoIntervalo = [];

    for (const arquivo of PAGINAS) {
      await page.goto(arquivo, { waitUntil: 'load' });
      const texto = await page.evaluate(() => document.body.textContent || '');
      for (const caractere of texto) {
        if (FALLBACK_CONHECIDO.includes(caractere)) continue;
        const codePoint = caractere.codePointAt(0);
        if (codePoint !== undefined && !estaNoIntervalo(codePoint, intervalos)) {
          foraDoIntervalo.push(`${arquivo}: "${caractere}" (U+${codePoint.toString(16).toUpperCase()})`);
        }
      }
    }

    expect([...new Set(foraDoIntervalo)], 'caracteres fora do subset latin').toEqual([]);
  });
});

test.describe('CA3 — arquivos servidos', { tag: '@CIT-52' }, () => {
  test('CA3 assets/fonts.css: exatamente 6 url("fonts/...woff2") e as licenças OFL presentes', () => {
    const css = lerDoDisco('assets/fonts.css');
    const urls = [...css.matchAll(/url\(\s*["']?fonts\/([^"')]+\.woff2)["']?\s*\)/g)].map(m => m[1]);
    expect(urls, 'URLs de woff2 em assets/fonts.css').toHaveLength(6);

    expect(existsSync(new URL('../assets/fonts/OFL-montserrat.txt', import.meta.url)), 'OFL-montserrat.txt ausente').toBe(true);
    expect(existsSync(new URL('../assets/fonts/OFL-poppins.txt', import.meta.url)), 'OFL-poppins.txt ausente').toBe(true);
  });

  test('CA3 cada woff2 referenciado em assets/fonts.css responde 200', async ({ page, erros }) => {
    const css = lerDoDisco('assets/fonts.css');
    const urls = [...css.matchAll(/url\(\s*["']?(fonts\/[^"')]+\.woff2)["']?\s*\)/g)].map(m => m[1]);

    await page.goto('index.html', { waitUntil: 'load' });
    const status = await page.evaluate(async lista => {
      const base = new URL('assets/fonts.css', location.href);
      const respostas = await Promise.all(lista.map(u => fetch(new URL(u, base))));
      return respostas.map(r => r.status);
    }, urls);

    for (const [i, codigo] of status.entries()) expect(codigo, `${urls[i]} não respondeu 200`).toBe(200);
  });

  test('CA3 index.html: preload do Montserrat 700, correto e baixado uma vez só', async ({ page, erros }) => {
    // conferir o atributo no HTML fonte (não no DOM já resolvido pelo Vite/navegador)
    const html = lerDoDisco('index.html');
    const tagPreload = html.match(/<link[^>]*rel="preload"[^>]*as="font"[^>]*>/i)?.[0];
    expect(tagPreload, 'index.html sem <link rel="preload" as="font">').toBeTruthy();
    expect(tagPreload).toMatch(/type="font\/woff2"/);
    expect(tagPreload).toMatch(/\bcrossorigin\b/);
    expect(tagPreload).toMatch(/href="assets\/fonts\/montserrat-700\.woff2"/);
    expect(tagPreload, 'href do preload não pode ser absoluto').not.toMatch(/href="\//);

    const requisicoes = [];
    page.on('request', req => { if (req.url().endsWith('montserrat-700.woff2')) requisicoes.push(req.url()); });
    await page.goto('index.html', { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    expect(requisicoes, 'requisições a montserrat-700.woff2 (preload + @font-face devem reaproveitar a mesma)').toHaveLength(1);
  });

  test('CA3 checkout.html: sem preload de fonte (decidido de antemão, sem meta de LCP no checkout)', () => {
    const html = lerDoDisco('checkout.html');
    expect(html, 'checkout.html não deveria ter preload de fonte').not.toMatch(/<link[^>]*rel="preload"[^>]*as="font"/i);
  });
});

test.describe('CA5 — mobile e estabilidade', { tag: '@CIT-52' }, () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'CA5 só se aplica ao perfil mobile');
  });

  for (const arquivo of PAGINAS) {
    for (const largura of [320, 375]) {
      test(`CA5 ${arquivo} a ${largura}px: sem rolagem horizontal`, async ({ page, erros }) => {
        await page.setViewportSize({ width: largura, height: 800 });
        await page.goto(arquivo, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);

        const semRolagem = await page.evaluate(() =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth);
        expect(semRolagem, `${arquivo} a ${largura}px: scrollWidth > clientWidth`).toBe(true);
      });
    }
  }

  test('CA5 landing a 320px: CLS com fontes atrasadas dentro da referência e altura do hero estável após o swap', async ({ page, erros }) => {
    // Referência medida no develop (passo 0, 2026-09-30), mesmo método (fontes atrasadas ~1,5s): 0,0013.
    // Teto absoluto do critério: 0,1.
    const CLS_REFERENCIA_DEVELOP = 0.0013;
    const CLS_TETO = 0.1;
    const LIMITE = Math.min(CLS_REFERENCIA_DEVELOP, CLS_TETO);

    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(() => {
      // @ts-ignore
      window.__cls = 0;
      new PerformanceObserver(lista => {
        for (const entrada of lista.getEntries()) {
          // @ts-ignore
          if (!entrada.hadRecentInput) window.__cls += entrada.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    // 1ª carga: fontes atrasadas, força o swap depois do primeiro paint (mesmo cenário do passo 0).
    await page.route('**/assets/fonts/*.woff2', route => setTimeout(() => route.continue(), 1500));
    await page.goto('index.html', { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);

    const cls = await page.evaluate(() => /** @type {any} */ (window).__cls);
    const alturaComSwap = await page.locator('h1.hero-title').evaluate(el => el.getBoundingClientRect().height);

    expect(cls, 'CLS acumulado da carga com fontes atrasadas').toBeLessThanOrEqual(LIMITE);

    // 2ª carga, mesma execução, sem atraso: fontes já em cache do navegador -> referência sem swap visível.
    await page.unroute('**/assets/fonts/*.woff2');
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const alturaEmCache = await page.locator('h1.hero-title').evaluate(el => el.getBoundingClientRect().height);

    expect(Math.abs(alturaComSwap - alturaEmCache), 'altura de h1.hero-title antes/depois do swap (±1px)').toBeLessThanOrEqual(1);
  });
});

test.describe('CA8 (trecho) — imagens com dimensões explícitas', { tag: '@CIT-52' }, () => {
  for (const arquivo of PAGINAS) {
    test(`CA8 ${arquivo}: toda <img> tem width e height`, async ({ page, erros }) => {
      await page.goto(arquivo, { waitUntil: 'load' });
      await expect(page.locator('img:not([width]), img:not([height])')).toHaveCount(0);
    });
  }
});
