// @ts-check
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import { BASE_API, CONTRA_SITE_PUBLICADO, mockarPainel, descartarPainel, chamadas } from './painel-mock.js';

// CIT-71: página definir-senha.html (token no fragmento #t=<43>, POST senha/validar e senha/definir) e o "Esqueci a senha"
// real do login. Modo API = origem http://localhost:4200 (a mesma do Vite, presente em ORIGENS_API); /api/painel/senha/* é
// sempre mockado por tests/painel-mock.js. Modo local = baseURL padrão (127.0.0.1). Só dados fictícios.
// Ver .omc/plans/CIT-71.md ("Critérios de aceite" e "Testes por critério"): CA2, CA3, CA4, CA5, CA7, CA10, CA11 e CA12 (versões).

const TOKEN = 'B'.repeat(42) + 'h'; // 43 caracteres base64url, fictício
const SENHA_OK = 'Senha-nova-de-teste'; // 19
const REGRA = 'Use de 12 a 128 caracteres, diferente do seu e-mail.';
const AVISO_SUCESSO = 'Senha definida. Entre com seu e-mail e a nova senha.';
const TOAST_ESQUECI = 'Se houver uma conta com este e-mail, enviaremos um link em instantes.';
const ERRO_ESQUECI = 'Não foi possível enviar agora. Tente novamente em instantes.';
const URL_DEFINIR = `definir-senha.html#t=${TOKEN}`;

const ler = caminho => readFileSync(new URL(`../${caminho}`, import.meta.url), 'utf8');
const toast = (/** @type {import('@playwright/test').Page} */ page, texto = TOAST_ESQUECI) => page.locator('body > div', { hasText: texto });
const semRolagem = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Registra as requisições a /api/ da página (URLs). Chamar antes do goto. @param {import('@playwright/test').Page} page */
function contarApi(page) {
  /** @type {string[]} */
  const urls = [];
  page.on('request', req => { if (new URL(req.url()).pathname.includes('/api/')) urls.push(req.url()); });
  return urls;
}

/** @param {import('@playwright/test').Page} page @param {string} senha @param {string} [confirma] */
async function preencherEEnviar(page, senha, confirma = senha) {
  await page.locator('#fNovaSenha').fill(senha);
  await page.locator('#fConfirmaSenha').fill(confirma);
  await page.locator('#btnDefinir').click();
}

/** @param {import('@playwright/test').Locator} alvo @param {string} nome */
async function alvoDeToque(alvo, nome) {
  const caixa = await alvo.boundingBox();
  expect(caixa, `${nome} visível`).not.toBeNull();
  expect(caixa?.width ?? 0, `${nome}: largura`).toBeGreaterThanOrEqual(44);
  expect(caixa?.height ?? 0, `${nome}: altura`).toBeGreaterThanOrEqual(44);
}

test.describe('CIT-71 definir-senha.html (modo API)', { tag: '@CIT-71' }, () => {
  test.use({ baseURL: BASE_API });
  test.skip(CONTRA_SITE_PUBLICADO, 'modo API só existe em http://localhost:4200 (Vite local)');

  test.describe('CA3 — definir com link válido', () => {
    test('CA3 validar 200 de primeiro acesso mostra o formulário com o título "Defina sua senha"', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { validar: 200, tipo: 'primeiro_acesso' });
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#definirForm')).toBeVisible();
      await expect(page.locator('#definirTitulo')).toHaveText('Defina sua senha');
      await expect(page.locator('#linkInvalido')).toBeHidden();
      await expect(page.locator('#definirIndisponivel')).toBeHidden();
      expect(chamadas(estado, 'validar')).toBe(1);
      descartarPainel(erros);
    });

    test('CA3 validar 200 de redefinição mostra o título "Redefina sua senha"', async ({ page, erros }) => {
      await mockarPainel(page, { validar: 200, tipo: 'redefinicao' });
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#definirTitulo')).toHaveText('Redefina sua senha');
      descartarPainel(erros);
    });

    test('CA3 validar envia o token só no corpo do POST', async ({ page, erros }) => {
      const estado = await mockarPainel(page);
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#definirForm')).toBeVisible();
      const req = estado.reqs.find(r => r.rota === 'validar');
      expect(req?.metodo).toBe('POST');
      expect(req?.corpo).toEqual({ token: TOKEN });
      descartarPainel(erros);
    });

    test('CA3 definir 204 envia { token, senha } e leva ao login com o aviso de sucesso, sem ?senha na URL', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { definir: 204 });
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#definirForm')).toBeVisible();
      await preencherEEnviar(page, SENHA_OK);

      await expect(page).toHaveURL(/login\.html/, { timeout: 10000 });
      const req = estado.reqs.find(r => r.rota === 'definir');
      expect(req?.corpo).toEqual({ token: TOKEN, senha: SENHA_OK });
      await expect(page.locator('#loginAviso')).toBeVisible();
      await expect(page.locator('#loginAviso')).toContainText(AVISO_SUCESSO);
      await expect.poll(() => new URL(page.url()).search, 'o login tira ?senha=definida da barra').not.toContain('senha=');
      descartarPainel(erros);
    });

    test('CA3 o botão de mostrar senha alterna o tipo do campo', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      const campo = page.locator('#fNovaSenha');
      await expect(campo).toHaveAttribute('type', 'password');
      await page.locator('[data-definir-acao="mostrar-senha"][data-alvo="fNovaSenha"]').click();
      await expect(campo).toHaveAttribute('type', 'text');
      await page.locator('[data-definir-acao="mostrar-senha"][data-alvo="fNovaSenha"]').click();
      await expect(campo).toHaveAttribute('type', 'password');
      descartarPainel(erros);
    });
  });

  test.describe('CA4 — link expirado, usado ou inválido', () => {
    test('CA4 validar 410 mostra "Este link expirou ou já foi usado." e "Pedir novo link" para login.html?esqueci=1', async ({ page, erros }) => {
      await mockarPainel(page, { validar: 410 });
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#linkInvalido')).toBeVisible();
      await expect(page.locator('#linkInvalido')).toContainText('Este link expirou ou já foi usado.');
      await expect(page.locator('#definirForm')).toBeHidden();
      await expect(page.locator('#btnPedirNovo')).toHaveText('Pedir novo link');
      await expect(page.locator('#btnPedirNovo')).toHaveAttribute('href', 'login.html?esqueci=1');
      expect(await page.evaluate(() => location.hash), 'fragmento apagado da barra').toBe('');
      descartarPainel(erros);
    });

    test('CA4 "Pedir novo link" leva ao login com o modal "Recuperar senha" aberto', async ({ page, erros }) => {
      await mockarPainel(page, { validar: 410 });
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await page.locator('#btnPedirNovo').click();
      await expect(page).toHaveURL(/login\.html/);
      await expect(page.locator('#forgotOverlay')).toBeVisible();
      descartarPainel(erros);
    });

    for (const [nome, caminho] of [['sem fragmento', 'definir-senha.html'], ['com fragmento malformado (#t=abc)', 'definir-senha.html#t=abc']]) {
      test(`CA4 ${nome} mostra #linkInvalido sem nenhuma requisição a /api/ e com o fragmento apagado`, async ({ page, erros }) => {
        const api = contarApi(page);
        await mockarPainel(page);
        await page.goto(caminho, { waitUntil: 'networkidle' });
        await expect(page.locator('#linkInvalido')).toBeVisible();
        await expect(page.locator('#definirForm')).toBeHidden();
        expect(api, 'requisições a /api/').toEqual([]);
        expect(await page.evaluate(() => location.hash)).toBe('');
        descartarPainel(erros);
      });
    }

    for (const falha of /** @type {const} */ ([503, 'abort'])) {
      test(`CA4 validar ${falha} mostra #definirErro e "Tentar novamente" repete a validação até abrir o formulário`, async ({ page, erros }) => {
        const estado = await mockarPainel(page, { validar: falha });
        await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
        await expect(page.locator('#definirErro')).toBeVisible();
        await expect(page.locator('#linkInvalido')).toBeHidden();
        await expect(page.locator('#definirForm')).toBeHidden();

        estado.validar = 200;
        await page.locator('#btnTentarNovamente').click();
        await expect(page.locator('#definirForm')).toBeVisible();
        await expect(page.locator('#definirErro')).toBeHidden();
        // o token continua em memória: a repetição reenvia o mesmo, sem fragmento na URL
        const validacoes = estado.reqs.filter(r => r.rota === 'validar');
        expect(validacoes.length).toBe(2);
        expect(validacoes[1].corpo).toEqual({ token: TOKEN });
        descartarPainel(erros);
      });
    }
  });

  test.describe('CA5 — política de senha', () => {
    test('CA5 #senhaRegra fica sempre visível com a regra', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#senhaRegra')).toBeVisible();
      await expect(page.locator('#senhaRegra')).toHaveText(REGRA);
      await page.locator('#fNovaSenha').fill('curta');
      await expect(page.locator('#senhaRegra')).toBeVisible();
      descartarPainel(erros);
    });

    test('CA5 senha de 11 caracteres mostra a regra em #errNovaSenha e não envia o POST', async ({ page, erros }) => {
      const estado = await mockarPainel(page);
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await preencherEEnviar(page, 'a'.repeat(11));
      await expect(page.locator('#errNovaSenha')).toBeVisible();
      await expect(page.locator('#errNovaSenha')).toContainText(REGRA);
      expect(chamadas(estado, 'definir')).toBe(0);
      descartarPainel(erros);
    });

    test('CA5 confirmação diferente mostra "As senhas não conferem." em #errConfirma e não envia o POST', async ({ page, erros }) => {
      const estado = await mockarPainel(page);
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await preencherEEnviar(page, SENHA_OK, SENHA_OK + 'x');
      await expect(page.locator('#errConfirma')).toBeVisible();
      await expect(page.locator('#errConfirma')).toHaveText('As senhas não conferem.');
      expect(chamadas(estado, 'definir')).toBe(0);
      descartarPainel(erros);
    });

    test('CA5 definir 400 mockado mostra a regra em #errNovaSenha e mantém o formulário', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { definir: 400 });
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await preencherEEnviar(page, SENHA_OK);
      await expect(page.locator('#errNovaSenha')).toBeVisible();
      await expect(page.locator('#errNovaSenha')).toContainText(REGRA);
      await expect(page.locator('#definirForm')).toBeVisible();
      expect(chamadas(estado, 'definir')).toBe(1);
      descartarPainel(erros);
    });
  });

  test.describe('CA7 — token fora da URL e dos cabeçalhos', () => {
    test('CA7 nenhuma requisição tem o token na URL nem no referer; o token só viaja no corpo do POST', async ({ page, erros }) => {
      /** @type {import('@playwright/test').Request[]} */
      const requisicoes = [];
      page.on('request', req => { if (!req.isNavigationRequest()) requisicoes.push(req); });
      const estado = await mockarPainel(page, { definir: 204 });
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#definirForm')).toBeVisible();
      await preencherEEnviar(page, SENHA_OK);
      await expect(page).toHaveURL(/login\.html/, { timeout: 10000 });

      expect(requisicoes.length, 'houve requisições observadas').toBeGreaterThan(0);
      for (const req of requisicoes) {
        expect(req.url(), 'URL da requisição').not.toContain(TOKEN);
        const cabecalhos = await req.allHeaders();
        expect(cabecalhos.referer ?? '', `referer de ${req.url()}`).not.toContain(TOKEN);
      }
      const posts = requisicoes.filter(r => new URL(r.url()).pathname.includes('/api/painel/senha/'));
      expect(posts.length).toBe(2);
      for (const post of posts) {
        expect(post.postDataJSON().token, `token no corpo de ${post.url()}`).toBe(TOKEN);
        expect((await post.allHeaders()).referer, `referer de ${post.url()}`).toBeUndefined();
      }
      expect(estado.reqs.map(r => r.rota)).toEqual(expect.arrayContaining(['validar', 'definir']));
      descartarPainel(erros);
    });

    test('CA7 meta[name="referrer"] vale no-referrer', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
      descartarPainel(erros);
    });

    test('CA7 o fragmento sai da barra de endereço logo após a carga', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      expect(await page.evaluate(() => location.hash)).toBe('');
      expect(page.url()).not.toContain(TOKEN);
      descartarPainel(erros);
    });
  });

  test.describe('CA12 — CSP', () => {
    test('CA12 definir-senha.html (formulário e link inválido) carrega sem violação de CSP', async ({ page, erros }) => {
      await page.addInitScript(() => {
        // @ts-ignore
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', e => {
          // @ts-ignore
          window.__csp.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
        });
      });
      const estado = await mockarPainel(page);
      const violacoes = () => page.evaluate(() => /** @type {any} */ (window).__csp || []);

      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#definirForm')).toBeVisible();
      await preencherEEnviar(page, 'curta');
      await expect(page.locator('#errNovaSenha')).toBeVisible();
      expect(await violacoes(), 'violações com o formulário').toEqual([]);

      estado.validar = 410;
      await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
      await expect(page.locator('#linkInvalido')).toBeVisible();
      expect(await violacoes(), 'violações com o link inválido').toEqual([]);
      descartarPainel(erros);
    });
  });
});

test.describe('CIT-71 login: "Esqueci a senha" real e aviso de senha definida (modo API)', { tag: '@CIT-71' }, () => {
  test.use({ baseURL: BASE_API });
  test.skip(CONTRA_SITE_PUBLICADO, 'modo API só existe em http://localhost:4200 (Vite local)');

  test.describe('CA2 — modal', () => {
    test('CA2 202 fecha o modal e mostra o toast fixo com svg.icon, sem o e-mail digitado', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { esqueci: 202 });
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await page.locator('[data-login-acao="esqueci"]').click();
      const digitado = 'quem-digitou@exemplo.com.br';
      await page.locator('#fForgotEmail').fill(digitado);
      await page.locator('[data-login-acao="enviar"]').click();

      await expect(page.locator('#forgotOverlay')).toBeHidden();
      await expect(toast(page)).toBeVisible();
      await expect(toast(page).locator('svg.icon')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(digitado);
      const req = estado.reqs.find(r => r.rota === 'esqueci');
      expect(req?.metodo).toBe('POST');
      expect(req?.corpo).toEqual({ email: digitado });
      descartarPainel(erros);
    });

    for (const falha of /** @type {const} */ ([503, 400, 403, 'abort'])) {
      test(`CA2 esqueci ${falha} mostra #forgotErro e mantém o modal aberto`, async ({ page, erros }) => {
        await mockarPainel(page, { esqueci: falha });
        await page.goto('login.html', { waitUntil: 'networkidle' });
        await page.locator('[data-login-acao="esqueci"]').click();
        await page.locator('#fForgotEmail').fill('titular@exemplo.com.br');
        await page.locator('[data-login-acao="enviar"]').click();

        await expect(page.locator('#forgotErro')).toBeVisible();
        await expect(page.locator('#forgotErro')).toContainText(ERRO_ESQUECI);
        await expect(page.locator('#forgotOverlay')).toBeVisible();
        await expect(toast(page)).toHaveCount(0);
        descartarPainel(erros);
      });
    }

    test('CA2 login.html?esqueci=1 abre o modal ao carregar e tira o parâmetro da barra', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto('login.html?esqueci=1', { waitUntil: 'networkidle' });
      await expect(page.locator('#forgotOverlay')).toBeVisible();
      expect(new URL(page.url()).search).not.toContain('esqueci');
      descartarPainel(erros);
    });
  });

  test.describe('CA3 — aviso de senha definida', () => {
    test('CA3 login.html?senha=definida mostra #loginAviso e tira o parâmetro da barra', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto('login.html?senha=definida', { waitUntil: 'networkidle' });
      await expect(page.locator('#loginAviso')).toBeVisible();
      await expect(page.locator('#loginAviso')).toContainText(AVISO_SUCESSO);
      expect(new URL(page.url()).search).not.toContain('senha=');
      descartarPainel(erros);
    });

    test('CA3 sem ?senha=definida o #loginAviso fica oculto', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#loginAviso')).toBeHidden();
      descartarPainel(erros);
    });
  });
});

// CA10: sem API (127.0.0.1, baseURL padrão) a página não faz requisição e mostra "disponível em breve".
test.describe('CIT-71 modo local', { tag: '@CIT-71' }, () => {
  for (const [nome, caminho] of [['com fragmento #t=<43>', URL_DEFINIR], ['sem fragmento', 'definir-senha.html']]) {
    test(`CA10 definir-senha.html ${nome}: só #definirIndisponivel, sem requisição a /api/ e com o fragmento apagado`, async ({ page, erros }) => {
      const api = contarApi(page);
      await page.goto(caminho, { waitUntil: 'networkidle' });
      await expect(page.locator('#definirIndisponivel')).toBeVisible();
      await expect(page.locator('#definirIndisponivel')).toContainText('Definição de senha disponível em breve');
      await expect(page.locator('#definirIndisponivel a[href="mailto:comercial@citmail.com.br"]')).toBeVisible();
      await expect(page.locator('#linkInvalido')).toBeHidden();
      await expect(page.locator('#definirForm')).toBeHidden();
      expect(api, 'requisições a /api/').toEqual([]);
      expect(await page.evaluate(() => location.hash)).toBe('');
    });
  }

  test('CA10 login.html?senha=definida mostra #loginAviso sem requisição a /api/', async ({ page, erros }) => {
    const api = contarApi(page);
    await page.goto('login.html?senha=definida', { waitUntil: 'networkidle' });
    await expect(page.locator('#loginAviso')).toBeVisible();
    await expect(page.locator('#loginAviso')).toContainText(AVISO_SUCESSO);
    expect(api, 'requisições a /api/').toEqual([]);
  });

  test('CA12 definir-senha.html local carrega sem violação de CSP', async ({ page, erros }) => {
    await page.addInitScript(() => {
      // @ts-ignore
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', e => {
        // @ts-ignore
        window.__csp.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
      });
    });
    await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
    await expect(page.locator('#definirIndisponivel')).toBeVisible();
    expect(await page.evaluate(() => /** @type {any} */ (window).__csp || [])).toEqual([]);
  });
});

// CA11: mobile a 375 e 320 px, sem rolagem horizontal e com alvos de toque de 44 x 44 px.
test.describe('CIT-71 mobile', { tag: '@CIT-71' }, () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
  });

  for (const largura of [375, 320]) {
    test.describe(`${largura} px`, () => {
      test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: largura, height: 800 }); });

      test.describe('modo API', () => {
        test.use({ baseURL: BASE_API });
        test.skip(CONTRA_SITE_PUBLICADO, 'modo API só existe em http://localhost:4200 (Vite local)');

        test(`CA11 formulário com #errNovaSenha visível a ${largura} px sem rolagem horizontal e com #btnDefinir de 44 px`, async ({ page, erros }) => {
          await mockarPainel(page);
          await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
          await preencherEEnviar(page, 'curta');
          await expect(page.locator('#errNovaSenha')).toBeVisible();
          expect(await semRolagem(page), 'scrollWidth <= innerWidth').toBe(true);
          await alvoDeToque(page.locator('#btnDefinir'), '#btnDefinir');
          descartarPainel(erros);
        });

        test(`CA11 #linkInvalido a ${largura} px sem rolagem horizontal e com #btnPedirNovo de 44 px`, async ({ page, erros }) => {
          await mockarPainel(page, { validar: 410 });
          await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
          await expect(page.locator('#linkInvalido')).toBeVisible();
          expect(await semRolagem(page), 'scrollWidth <= innerWidth').toBe(true);
          await alvoDeToque(page.locator('#btnPedirNovo'), '#btnPedirNovo');
          descartarPainel(erros);
        });

        test(`CA11 login a ${largura} px com o modal e #forgotErro, com o toast e com #loginAviso sem rolagem horizontal`, async ({ page, erros }) => {
          const estado = await mockarPainel(page, { esqueci: 503 });
          await page.goto('login.html?senha=definida', { waitUntil: 'networkidle' });
          await expect(page.locator('#loginAviso')).toBeVisible();
          expect(await semRolagem(page), '#loginAviso visível').toBe(true);

          await page.locator('[data-login-acao="esqueci"]').click();
          await page.locator('#fForgotEmail').fill('titular@exemplo.com.br');
          await page.locator('[data-login-acao="enviar"]').click();
          await expect(page.locator('#forgotErro')).toBeVisible();
          expect(await semRolagem(page), 'modal com #forgotErro').toBe(true);

          estado.esqueci = 202;
          await page.locator('[data-login-acao="enviar"]').click();
          await expect(toast(page)).toBeVisible();
          expect(await semRolagem(page), 'toast visível').toBe(true);
          descartarPainel(erros);
        });
      });

      test(`CA11 #definirIndisponivel a ${largura} px sem rolagem horizontal`, async ({ page, erros }) => {
        await page.goto(URL_DEFINIR, { waitUntil: 'networkidle' });
        await expect(page.locator('#definirIndisponivel')).toBeVisible();
        expect(await semRolagem(page), 'scrollWidth <= innerWidth').toBe(true);
      });
    });
  }
});

// CA12: versões dos assets alterados (padrão de tests/checkout-pedido.spec.js, CA15).
test.describe('CIT-71 versões dos assets', { tag: '@CIT-71' }, () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'leitura de arquivo: roda num perfil só');
  });

  test('CA12 login.html referencia login.js?v=4 e login.css?v=3', () => {
    const html = ler('login.html');
    expect(html).toContain('assets/login.js?v=4"');
    expect(html).toContain('assets/login.css?v=3"');
  });

  test('CA12 definir-senha.html referencia definir-senha.js?v=1 e definir-senha.css?v=1', () => {
    const html = ler('definir-senha.html');
    expect(html).toContain('assets/definir-senha.js?v=1"');
    expect(html).toContain('assets/definir-senha.css?v=1"');
  });
});
