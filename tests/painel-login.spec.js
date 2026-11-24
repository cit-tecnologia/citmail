// @ts-check
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import {
  BASE_API, EMAIL, SENHA, CONTRA_SITE_PUBLICADO,
  mockarPainel, chamadas, descartarPainel, abrirMenuSeMobile, observarAppVisivel,
} from './painel-mock.js';

// CIT-70: entrar no painel com e-mail e senha (login.html e painel.html). Modo API = origem http://localhost:4200
// (em ORIGENS_API), com /api/painel/* sempre mockado por page.route; modo local = 127.0.0.1 (baseURL padrão).
// Cookie, Argon2id, Redis e CSRF são provados em api/test/ (aqui o navegador não fala com a API real).
// Ver .omc/plans/CIT-70.md ("Critérios de aceite" e "Testes por critério"). Só dados fictícios.

const RAIZ = new URL('../', import.meta.url);
const ler = (/** @type {string} */ nome) => readFileSync(new URL(nome, RAIZ), 'utf8');

const MSG_INVALIDAS = 'E-mail ou senha incorretos.';
const MSG_INDISPONIVEL = 'Não foi possível entrar agora. Tente novamente em instantes.';
const MSG_SAIR = 'Não foi possível sair. Tente novamente.';

/** @param {import('@playwright/test').Page} page */
async function entrar(page, email = EMAIL, senha = SENHA) {
  await page.locator('#fEmail').fill(email);
  await page.locator('#fPassword').fill(senha);
  await page.locator('#btnLogin').click();
}

/** @param {import('@playwright/test').Page} page */
const semRolagem = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('CIT-70 modo API', { tag: '@CIT-70' }, () => {
  test.use({ baseURL: BASE_API });
  test.skip(CONTRA_SITE_PUBLICADO, 'modo API só existe em http://localhost:4200 (Vite local)');

  test.describe('CA1 — login válido', () => {
    test('CA1 credenciais válidas levam ao painel com o e-mail da sessão no dashboard e na barra lateral', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { login: 204 });
      await page.goto('login.html');
      await entrar(page);

      await expect(page).toHaveURL(/\/painel\.html$/);
      await expect(page.locator('#sec-dashboard')).toBeVisible();
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      await expect(page.locator('#sidebarName')).toHaveText(EMAIL);
      // o login manda e-mail e senha em JSON para a rota certa, por POST
      const login = estado.reqs.find(r => r.rota === 'login');
      expect(login?.metodo).toBe('POST');
      expect(login?.corpo).toEqual({ email: EMAIL, senha: SENHA });
      descartarPainel(erros);
    });

    test('CA1 o painel só pinta depois de GET /sessao 200 e mostra a inicial do e-mail no avatar', async ({ page, erros }) => {
      await mockarPainel(page, { sessao: 200 });
      await page.goto('painel.html');
      await expect(page.locator('.app')).toBeVisible();
      await expect(page.locator('#topbarAvatar')).toHaveText(new RegExp(`^${EMAIL[0]}$`, 'i'));
      descartarPainel(erros);
    });
  });

  test.describe('CA1/CA4 — opções do fetch', () => {
    /** Registra em window.__fetches as opções de cada fetch para /api/painel/*. Chamar antes do goto. @param {import('@playwright/test').Page} page */
    async function registrarFetches(page) {
      await page.addInitScript(() => {
        const original = window.fetch;
        // @ts-ignore
        window.__fetches = [];
        window.fetch = function (entrada, init) {
          // @ts-ignore
          window.__fetches.push({ url: String(entrada), credentials: init?.credentials, cache: init?.cache, method: init?.method });
          return original.call(this, entrada, init);
        };
      });
    }
    const fetches = (/** @type {import('@playwright/test').Page} */ page) =>
      page.evaluate(() => /** @type {any} */ (window).__fetches.filter(f => f.url.includes('/api/painel/')));

    test('CA1 login envia o cookie (credentials include) e não usa cache', async ({ page, erros }) => {
      await mockarPainel(page, { login: 401 });
      await registrarFetches(page);
      await page.goto('login.html');
      await entrar(page);
      await expect(page.locator('#alertError')).toBeVisible();
      const [login] = await fetches(page);
      expect(login).toMatchObject({ method: 'POST', credentials: 'include' });
      expect(login.url).toMatch(/\/api\/painel\/login$/);
      descartarPainel(erros);
    });

    test('CA4 sessão e logout enviam o cookie (credentials include) e não usam cache', async ({ page, erros }) => {
      await mockarPainel(page, { sessao: 200, logout: 403 });
      await registrarFetches(page);
      await page.goto('painel.html');
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      await abrirMenuSeMobile(page);
      await page.locator('.sidebar-logout').click();
      await expect(page.locator('#toastWrap .toast', { hasText: MSG_SAIR })).toBeVisible();
      const chamadas = await fetches(page);
      expect(chamadas.map(f => f.method)).toEqual(['GET', 'POST']);
      for (const f of chamadas) expect(f, f.url).toMatchObject({ credentials: 'include', cache: 'no-store' });
      descartarPainel(erros);
    });
  });

  test.describe('CA2 — mensagem genérica e falhas', () => {
    test('CA2 credenciais inválidas mostram a mensagem genérica, limpam a senha e não navegam', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { login: 401 });
      await page.goto('login.html');
      await expect(page.locator('#alertError')).toBeHidden();

      await entrar(page, EMAIL, 'senha-errada');

      await expect(page.locator('#alertError')).toBeVisible();
      await expect(page.locator('#alertErrorMsg')).toHaveText(MSG_INVALIDAS);
      await expect(page.locator('#fPassword')).toHaveValue('');
      await expect(page).toHaveURL(/\/login\.html$/);
      expect(chamadas(estado, 'login')).toBe(1);
      descartarPainel(erros);
    });

    for (const [rotulo, status] of /** @type {[string, number|'abort'][]} */ ([
      ['503', 503], ['403', 403], ['falha de rede', 'abort'],
    ])) {
      test(`CA2 ${rotulo} no login mostra "Não foi possível entrar agora" e não navega`, async ({ page, erros }) => {
        await mockarPainel(page, { login: status });
        await page.goto('login.html');
        await entrar(page);

        await expect(page.locator('#alertError')).toBeVisible();
        await expect(page.locator('#alertErrorMsg')).toHaveText(MSG_INDISPONIVEL);
        await expect(page).toHaveURL(/\/login\.html$/);
        descartarPainel(erros);
      });
    }

    test('CA2 depois de um erro, uma nova tentativa válida entra no painel', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { login: 401 });
      await page.goto('login.html');
      await entrar(page, EMAIL, 'senha-errada');
      await expect(page.locator('#alertError')).toBeVisible();

      estado.login = 204;
      await entrar(page);
      await expect(page).toHaveURL(/\/painel\.html$/);
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      descartarPainel(erros);
    });
  });

  test.describe('CA4 — sair', () => {
    test('CA4 Sair encerra a sessão com POST e vai para o login (a entrada do painel sai do histórico)', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { sessao: 200 });
      await page.goto('painel.html');
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      expect(chamadas(estado, 'sessao')).toBe(1);

      await abrirMenuSeMobile(page);
      await page.locator('.sidebar-logout').click();
      await expect(page).toHaveURL(/\/login\.html$/);
      expect(estado.reqs.filter(r => r.rota === 'logout').map(r => r.metodo)).toEqual(['POST']);
      expect(estado.sessao, 'o mock encerrou a sessão').toBe(401);

      // voltar não chega a um painel: a entrada do painel foi trocada pelo login (location.replace)
      await page.goBack();
      await expect(page).not.toHaveURL(/painel\.html/);
      expect(chamadas(estado, 'sessao'), 'nenhuma nova consulta de sessão').toBe(1);
      descartarPainel(erros);
    });

    test('CA4 voltar ao painel depois de a sessão acabar consulta de novo, volta ao login e nunca mostra o painel nem o e-mail', async ({ page, erros }) => {
      const vistos = await observarAppVisivel(page);
      const estado = await mockarPainel(page, { sessao: 200 });
      await page.goto('login.html');
      await page.goto('painel.html');
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      await page.goto('login.html'); // sai do painel sem encerrar a sessão no navegador

      estado.sessao = 401; // a sessão acaba no servidor (sair em outra aba, expiração)
      vistos.length = 0;
      await page.goBack();
      await expect(page).toHaveURL(/\/login\.html$/);
      expect(chamadas(estado, 'sessao'), 'o painel reconsultou GET /sessao').toBe(2);
      expect(vistos, '.app visível depois de a sessão acabar').toEqual([]);
      await expect(page.locator('#painelEmail')).toHaveCount(0);
      descartarPainel(erros);
    });

    test('CA4 pageshow vindo do cache reconsulta a sessão mesmo com a consulta anterior ainda pendente, escondendo o e-mail até a resposta', async ({ page, erros }) => {
      const estado = await mockarPainel(page, { sessao: 200, atrasoSessao: 1200 });
      await page.goto('painel.html', { waitUntil: 'commit' });
      await expect.poll(() => chamadas(estado, 'sessao')).toBe(1);

      // simula a ida ao bfcache e a volta enquanto a 1ª consulta ainda está pendente
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expect.poll(() => chamadas(estado, 'sessao'), 'pageshow reconsulta a sessão').toBe(2);
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      await expect(page.locator('.app')).toBeVisible();
      descartarPainel(erros);
    });

    for (const [rotulo, status] of /** @type {[string, number|'abort'][]} */ ([
      ['403', 403], ['500', 500], ['falha de rede', 'abort'],
    ])) {
      test(`CA4 logout com ${rotulo} mostra o toast de erro e permanece no painel`, async ({ page, erros }) => {
        const estado = await mockarPainel(page, { sessao: 200, logout: status });
        await page.goto('painel.html');
        await expect(page.locator('#painelEmail')).toHaveText(EMAIL);

        await abrirMenuSeMobile(page);
        await page.locator('.sidebar-logout').click();

        await expect(page.locator('#toastWrap .toast', { hasText: MSG_SAIR })).toBeVisible();
        await expect(page).toHaveURL(/\/painel\.html$/);
        await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
        expect(chamadas(estado, 'logout')).toBe(1);
        descartarPainel(erros);
      });
    }

    test('CA4 .sidebar-logout é um botão sem data-toast', async ({ page, erros }) => {
      await mockarPainel(page, { sessao: 200 });
      await page.goto('painel.html');
      await expect(page.locator('.sidebar-logout')).not.toHaveAttribute('data-toast', /.*/);
      descartarPainel(erros);
    });
  });

  test.describe('CA5 — painel sem sessão', () => {
    test('CA5 GET /sessao 401 leva ao login sem nunca mostrar o painel nem o e-mail', async ({ page, erros }) => {
      const vistos = await observarAppVisivel(page);
      const estado = await mockarPainel(page, { sessao: 401, atrasoSessao: 400 }); // atraso: dá tempo de um painel pintado cedo aparecer
      await page.goto('painel.html');

      await expect(page).toHaveURL(/\/login\.html$/);
      expect(chamadas(estado, 'sessao')).toBe(1);
      expect(vistos, '.app visível sem sessão').toEqual([]);
      descartarPainel(erros);
    });

    test('CA5 erro ao consultar a sessão mostra #painelErro, mantém o painel oculto e "Tentar novamente" recupera', async ({ page, erros }) => {
      const vistos = await observarAppVisivel(page);
      const estado = await mockarPainel(page, { sessao: 503 });
      await page.goto('painel.html');

      await expect(page.locator('#painelErro')).toBeVisible();
      await expect(page.locator('#btnPainelTentar')).toBeVisible();
      await expect(page.locator('.app')).toBeHidden();
      await expect(page).toHaveURL(/\/painel\.html$/);
      expect(vistos).toEqual([]);

      estado.sessao = 200;
      await page.locator('#btnPainelTentar').click();
      await expect(page.locator('.app')).toBeVisible();
      await expect(page.locator('#painelEmail')).toHaveText(EMAIL);
      await expect(page.locator('#painelErro')).toBeHidden();
      descartarPainel(erros);
    });

    test('CA5 falha de rede ao consultar a sessão também mostra #painelErro (não redireciona)', async ({ page, erros }) => {
      await mockarPainel(page, { sessao: 'abort' });
      await page.goto('painel.html');
      await expect(page.locator('#painelErro')).toBeVisible();
      await expect(page).toHaveURL(/\/painel\.html$/);
      descartarPainel(erros);
    });

    test('CA5 o e-mail da sessão aparece como texto, nunca como marcação', async ({ page, erros }) => {
      const forjado = '<b id=x>a</b>@exemplo.com.br';
      await mockarPainel(page, { sessao: 200, email: forjado });
      await page.goto('painel.html');
      await expect(page.locator('#painelEmail')).toHaveText(forjado);
      await expect(page.locator('#sidebarName')).toHaveText(forjado);
      expect(await page.locator('#x').count(), 'elemento injetado não deveria existir').toBe(0);
      descartarPainel(erros);
    });
  });

  test.describe('CA10 — formulário no modo API', () => {
    test('CA10 o aviso "Painel disponível em breve" fica oculto e o formulário aparece', async ({ page, erros }) => {
      await mockarPainel(page);
      await page.goto('login.html');
      await expect(page.locator('#loginIndisponivel')).toBeHidden();
      await expect(page.locator('form')).toBeVisible();
      await expect(page.locator('.login-card')).not.toHaveClass(/login-card--local/);
      descartarPainel(erros);
    });
  });

  test.describe('CA11 — mobile (modo API)', () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
    });

    for (const largura of [320, 375]) {
      test(`CA11 login a ${largura} px com o alerta de erro visível: sem rolagem horizontal e botão ≥ 44 × 44`, async ({ page, erros }) => {
        await page.setViewportSize({ width: largura, height: 800 });
        await mockarPainel(page, { login: 401 });
        await page.goto('login.html');
        await entrar(page, EMAIL, 'senha-errada');
        await expect(page.locator('#alertError')).toBeVisible();

        expect(await semRolagem(page), `login ${largura}px: scrollWidth <= innerWidth`).toBe(true);
        const caixa = await page.locator('#btnLogin').boundingBox();
        expect(caixa?.width, '#btnLogin largura').toBeGreaterThanOrEqual(44);
        expect(caixa?.height, '#btnLogin altura').toBeGreaterThanOrEqual(44);
        descartarPainel(erros);
      });

      test(`CA11 painel a ${largura} px com e-mail de 64 caracteres, seção "Em breve" e menu aberto: sem rolagem horizontal e Sair ≥ 44 × 44`, async ({ page, erros }) => {
        const longo = `${'a'.repeat(64 - '@exemplo.com.br'.length)}@exemplo.com.br`;
        expect(longo).toHaveLength(64);
        await page.setViewportSize({ width: largura, height: 800 });
        await mockarPainel(page, { sessao: 200, email: longo });
        await page.goto('painel.html');
        await expect(page.locator('#painelEmail')).toHaveText(longo);
        expect(await semRolagem(page), `dashboard ${largura}px`).toBe(true);

        await page.locator('#sidebarToggle').click();
        await expect(page.locator('#sidebar')).toHaveClass(/open/);
        expect(await semRolagem(page), `menu aberto ${largura}px`).toBe(true);
        const sair = await page.locator('.sidebar-logout').boundingBox();
        expect(sair?.width, '.sidebar-logout largura').toBeGreaterThanOrEqual(44);
        expect(sair?.height, '.sidebar-logout altura').toBeGreaterThanOrEqual(44);

        await page.locator('.nav-item[data-section="email"]').click();
        await expect(page.locator('#sec-email')).toBeVisible();
        await expect(page.locator('#sec-email .empty-state')).toContainText('Em breve');
        expect(await semRolagem(page), `seção "Em breve" ${largura}px`).toBe(true);

        await page.locator('#sidebarToggle').click();
        expect(await semRolagem(page), `menu reaberto ${largura}px`).toBe(true);
        descartarPainel(erros);
      });
    }
  });
});

// Modo local (127.0.0.1, baseURL padrão; também é o comportamento do GitHub Pages e da homologação).
test.describe('CIT-70 modo local', { tag: '@CIT-70' }, () => {
  /** Páginas que o teste abriu falando com /api/. @param {import('@playwright/test').Page} page */
  function requisicoesApi(page) {
    /** @type {string[]} */
    const urls = [];
    page.on('request', req => { if (new URL(req.url()).pathname.includes('/api/')) urls.push(req.url()); });
    return urls;
  }

  test('CA5 painel.html sem modo API vai para login.html sem requisição a /api/ e sem mostrar o painel', async ({ page, erros }) => {
    const apis = requisicoesApi(page);
    const vistos = await observarAppVisivel(page);
    await page.goto('painel.html');
    await expect(page).toHaveURL(/\/login\.html$/);
    expect(apis, 'requisições a /api/').toEqual([]);
    expect(vistos, '.app visível no modo local').toEqual([]);
  });

  test('CA10 login.html mostra "Painel disponível em breve" com o contato, oculta o formulário e não chama /api/', async ({ page, erros }) => {
    const apis = requisicoesApi(page);
    await page.goto('login.html', { waitUntil: 'networkidle' });

    await expect(page.locator('h1')).toHaveText('Acesse seu painel');
    await expect(page.locator('#loginIndisponivel')).toBeVisible();
    await expect(page.locator('#loginIndisponivel')).toContainText('Painel disponível em breve');
    await expect(page.locator('#loginIndisponivel a[href="mailto:comercial@citmail.com.br"]')).toBeVisible();
    await expect(page.locator('.login-card')).toHaveClass(/login-card--local/);
    await expect(page.locator('form')).toBeHidden();
    await expect(page.locator('#fEmail')).toBeHidden();
    await expect(page.locator('#btnLogin')).toBeHidden();
    await expect(page.locator('#alertError')).toBeHidden();
    expect(apis, 'requisições a /api/').toEqual([]);
  });

  test('CA10 assets/login.js não contém a credencial de demonstração', () => {
    const fonte = ler('assets/login.js');
    expect(fonte).not.toContain('demo123');
    expect(fonte).not.toContain('demo@citmail.com.br');
  });

  test('CA5 painel.html e assets/painel.js não contêm dados fictícios nem os modais removidos', () => {
    const proibidos = [
      'João da Silva', 'empresa.com.br', 'dnsData',
      'modalDnsRecord', 'modalNovaContaEmail', 'modalNovoTicket', 'modalVerTicket', 'modalContratarConsultoria', 'modalContratarServidor',
    ];
    for (const arquivo of ['painel.html', 'assets/painel.js']) {
      const fonte = ler(arquivo);
      for (const termo of proibidos) expect(fonte, `${arquivo} contém "${termo}"`).not.toContain(termo);
    }
  });

  test('CA5 painel.html e login.html não têm credencial nem e-mail fictício embutido no HTML', () => {
    for (const arquivo of ['login.html', 'painel.html']) {
      expect(ler(arquivo), arquivo).not.toMatch(/demo123|demo@citmail/);
    }
  });

  for (const largura of [320, 375]) {
    test(`CA11 login em modo local a ${largura} px: sem rolagem horizontal`, async ({ page, erros }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'só aplica no perfil mobile');
      await page.setViewportSize({ width: largura, height: 800 });
      await page.goto('login.html', { waitUntil: 'networkidle' });
      await expect(page.locator('#loginIndisponivel')).toBeVisible();
      expect(await semRolagem(page), `login local ${largura}px: scrollWidth <= innerWidth`).toBe(true);
    });
  }
});
