// @ts-check
import { readFileSync, readdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// Em produção o site fica em subcaminho (cittecnologia.github.io/citmail/), então caminhos locais precisam ser relativos.
// O Vite reescreve "/assets/..." para "/citmail/assets/..." ao servir o HTML, por isso a checagem é feita no arquivo original.
const raiz = new URL('../', import.meta.url);
const paginas = readdirSync(raiz).filter(nome => nome.endsWith('.html'));

test.describe('caminhos relativos', { tag: '@CIT-12' }, () => {
  for (const pagina of paginas) {
    test(`${pagina} não usa caminho absoluto para recursos locais`, () => {
      const html = readFileSync(new URL(pagina, raiz), 'utf8');
      const absolutos = [...html.matchAll(/\b(?:href|src|action)\s*=\s*["'](\/(?!\/)[^"']*)["']/g)].map(m => m[1]);
      expect(absolutos).toEqual([]);
    });
  }
});

// CIT-52: assets/fonts.css usa url("fonts/...") relativo à própria folha; um caminho absoluto
// quebraria no GitHub Pages (subcaminho /citmail/).
test.describe('caminhos relativos em CSS', { tag: '@CIT-52' }, () => {
  const pastaAssets = new URL('../assets/', import.meta.url);
  const arquivosCss = readdirSync(pastaAssets).filter(nome => nome.endsWith('.css'));

  for (const arquivo of arquivosCss) {
    test(`assets/${arquivo} não usa url() absoluto`, () => {
      const css = readFileSync(new URL(arquivo, pastaAssets), 'utf8');
      const absolutos = [...css.matchAll(/url\(\s*["']?(\/(?!\/)[^"')]*)["']?\s*\)/g)].map(m => m[1]);
      expect(absolutos).toEqual([]);
    });
  }
});
