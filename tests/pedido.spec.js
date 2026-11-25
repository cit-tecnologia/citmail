// @ts-check
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';

// CIT-69: página de status do pedido (pedido.html#t=<token>). Modo API = origem http://localhost:4200 (a mesma do Vite,
// presente em ORIGENS_API); a consulta (POST /api/pedidos/status) é sempre mockada com page.route. Modo local = 127.0.0.1.
// Os tempos (atualização a cada 10/20/60 s, limite de 30 min) usam page.clock: instalado e pausado ANTES do goto, para a
// 1ª consulta nascer no instante zero; cada avanço de runFor termina exatamente no disparo do próximo timer, e a página
// registra o instante (Date.now simulado) de cada fetch em window.__t. Só dados fictícios.
// Ver .omc/plans/CIT-69.md ("Critérios de aceite" e "Testes por critério").

const ORIGEM_API = { baseURL: 'http://localhost:4200/citmail/' };
const TOKEN = 'A'.repeat(42) + 'g';
const URL_PEDIDO = `pedido.html#t=${TOKEN}`;
const FATURA_CONTAS = 'https://sandbox.asaas.com/i/abc';
const FATURA_DOMINIO = 'https://www.asaas.com/i/def';
const CONTATO = 'comercial@citmail.com.br';
const INICIO_RELOGIO = new Date('2030-01-01T10:00:00Z');
const LIMITE_VISIVEL_S = 30 * 60;

/** @param {any} route @param {number} status @param {any} corpo */
const json = (route, status, corpo) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(corpo) });

/** @param {string} etapa @param {object} [extra] */
const resposta = (etapa, extra = {}) => (/** @type {any} */ route) => json(route, 200, { etapa, dominioNovo: false, ...extra });

/**
 * @typedef {object} Opcoes
 * @property {(route: any, n: number) => any} [resposta] resposta do POST /api/pedidos/status (n = 1, 2, …); padrão: aguardando_confirmacao
 * @property {boolean} [relogio] instala page.clock pausado antes do goto
 * @property {string} [url] caminho relativo a abrir (padrão: pedido.html#t=<TOKEN>)
 */

/**
 * Registra o mock e abre a página. `estado.resposta` pode ser trocado pelo teste no meio do caminho.
 * @param {import('@playwright/test').Page} page
 * @param {Opcoes} [o]
 */
async function abrir(page, o = {}) {
  /** @type {import('@playwright/test').Request[]} */
  const reqs = [];
  const estado = { resposta: o.resposta ?? ((/** @type {any} */ route) => json(route, 200, { etapa: 'aguardando_confirmacao', dominioNovo: false })) };
  await page.addInitScript(() => {
    /** @type {any} */ (window).__t = [];
    const original = window.fetch;
    window.fetch = function (...args) {
      /** @type {any} */ (window).__t.push(Date.now());
      return original.apply(this, args);
    };
  });
  await page.route('**/api/pedidos/status', route => {
    reqs.push(route.request());
    return estado.resposta(route, reqs.length);
  });
  if (o.relogio) {
    await page.clock.install({ time: INICIO_RELOGIO });
    await page.clock.pauseAt(new Date(INICIO_RELOGIO.getTime() + 1000));
  }
  await page.goto(o.url ?? URL_PEDIDO);
  return { reqs, estado };
}

/** Retira da fixture `erros` o que o próprio mock provoca em /api/pedidos/status (4xx/5xx e aborts). @param {string[]} erros */
function descartarStatus(erros) {
  for (let i = erros.length - 1; i >= 0; i--) {
    if (/\/api\/pedidos\/status$/.test(erros[i].split(' ').slice(1).join(' '))) erros.splice(i, 1);
  }
}

const assentar = () => new Promise(resolve => setTimeout(resolve, 150));

/** Instantes (s, relativos à 1ª consulta) em que a página chamou fetch. @param {import('@playwright/test').Page} page */
const instantes = page => page.evaluate(() => {
  const t = /** @type {number[]} */ (/** @type {any} */ (window).__t);
  return t.map(x => (x - t[0]) / 1000);
});

/** Espera a 1ª consulta e a página processar a resposta. */
async function aguardarPrimeira(/** @type {import('@playwright/test').Request[]} */ reqs) {
  await expect.poll(() => reqs.length).toBe(1);
  await assentar();
}

/**
 * Avança o relógio da página `ms` e confere quantas consultas novas nasceram (0 = nenhuma).
 * Cada avanço termina no disparo do timer esperado: um timer mais curto ou mais longo muda os instantes registrados.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Request[]} reqs
 */
async function avancar(page, reqs, ms, novas = 1) {
  const antes = reqs.length;
  await page.clock.runFor(ms);
  if (novas > 0) await expect.poll(() => reqs.length).toBe(antes + novas);
  await assentar();
  expect(reqs.length, `consultas depois de avançar ${ms} ms`).toBe(antes + novas);
}

/** Intervalo esperado até a próxima consulta, por nº de respostas 200 seguidas com a mesma etapa (Decisão 7). @param {number} k */
const intervaloS = k => (k < 5 ? 10 : k < 10 ? 20 : 60);

/**
 * Segue o ciclo de consultas até o limite de tempo visível (parada sem nova consulta).
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Request[]} reqs
 * @param {{ t: number, k: number }} rel t = s desde a 1ª consulta; k = respostas 200 iguais até aqui
 * @param {number} limiteS instante (s) em que o tempo visível acumulado chega a 30 min
 */
async function rodarAteALimite(page, reqs, rel, limiteS) {
  for (;;) {
    const restante = limiteS - rel.t;
    const gap = intervaloS(rel.k);
    if (restante <= gap) {
      await avancar(page, reqs, restante * 1000, 0);
      rel.t = limiteS;
      return;
    }
    await avancar(page, reqs, gap * 1000);
    rel.t += gap;
    rel.k += 1;
    await expect(page.locator('#btnAtualizar'), `botão oculto enquanto consulta (t=${rel.t} s)`).toBeHidden();
  }
}

/** @param {import('@playwright/test').Page} page @param {boolean} oculta */
const definirOculta = (page, oculta) => page.evaluate(valor => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => valor });
  document.dispatchEvent(new Event('visibilitychange'));
}, oculta);

/* ---------------- CA5: URLs da fatura na página ---------------- */

test.describe('pedido — CA5: links de fatura', { tag: '@CIT-69' }, () => {
  test.use(ORIGEM_API);

  test('CA5 URL do Asaas vira link seguro: href do mock, nova aba, noopener e noreferrer', async ({ page, erros }) => {
    await abrir(page, {
      resposta: resposta('aguardando_confirmacao', { dominioNovo: true, faturaContasUrl: FATURA_CONTAS, faturaDominioUrl: FATURA_DOMINIO }),
    });

    for (const [seletor, href] of [['#linkFaturaContas', FATURA_CONTAS], ['#linkFaturaDominio', FATURA_DOMINIO]]) {
      const link = page.locator(seletor);
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', href);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expect(link).toHaveAttribute('rel', /noreferrer/);
    }
  });

  for (const [rotulo, url] of [
    ['host fora da allowlist', 'https://evil.example/i/x'],
    ['host que termina em asaas.com sem ser o Asaas', 'https://asaas.com.evil.example/i/x'],
    ['http em vez de https', 'http://sandbox.asaas.com/i/x'],
    ['porta explícita', 'https://www.asaas.com:444/x'],
    ['usuário e senha na URL', 'https://u:p@www.asaas.com/i/x'],
    ['esquema javascript:', 'javascript:alert(1)'],
  ]) {
    test(`CA5 URL com ${rotulo}: nenhum link e o aviso "chega por e-mail"`, async ({ page, erros }) => {
      await abrir(page, { resposta: resposta('aguardando_confirmacao', { faturaContasUrl: url }) });

      await expect(page.locator('#statusPedido')).toContainText('chega por e-mail');
      await expect(page.locator('#linkFaturaContas')).toBeHidden();
      await expect(page.locator('#statusPedido a[href*="evil"], #statusPedido a[href^="javascript:" i], #statusPedido a[href^="http://"]')).toHaveCount(0);
    });
  }

  test('CA5 sem URL de fatura: aviso "chega por e-mail" e o contato comercial', async ({ page, erros }) => {
    await abrir(page, { resposta: resposta('aguardando_confirmacao') });

    await expect(page.locator('#statusPedido')).toContainText('chega por e-mail');
    await expect(page.locator('#statusContato a[href="mailto:comercial@citmail.com.br"]')).toBeVisible();
  });
});

/* ---------------- CA6: aguardando e atualização sem recarregar ---------------- */

test.describe('pedido — CA6: aguardando confirmação e atualização', { tag: '@CIT-69' }, () => {
  test.use(ORIGEM_API);

  test('CA6 mostra "Aguardando a confirmação" e, 10 s depois, "ativando" sem recarregar, com 2 requisições', async ({ page, erros }) => {
    /** @type {string[]} */
    const navegacoes = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navegacoes.push(frame.url()); });
    const { reqs, estado } = await abrir(page, { relogio: true });

    await expect(page.locator('#statusEtapa')).toContainText('Aguardando a confirmação');
    estado.resposta = resposta('ativando');
    await page.clock.runFor(10000);

    await expect(page.locator('#statusEtapa')).toContainText('ativando');
    expect(reqs, 'exatamente 2 requisições').toHaveLength(2);
    expect(navegacoes, 'só a navegação inicial').toHaveLength(1);
  });
});

/* ---------------- CA7: etapas finais e parada ---------------- */

/** @type {{ etapa: string, textos: string[] }[]} */
const ETAPAS_FINAIS = [
  { etapa: 'ativo', textos: ['está ativo', 'instruções de acesso'] },
  { etapa: 'erro_criacao', textos: [CONTATO] },
  { etapa: 'cancelado', textos: ['Pedido cancelado', CONTATO] },
];

test.describe('pedido — CA7: etapa final para a consulta', { tag: '@CIT-69' }, () => {
  test.use(ORIGEM_API);

  for (const { etapa, textos } of ETAPAS_FINAIS) {
    test(`CA7 ${etapa}: mostra o texto da etapa, não consulta mais em 2 min e oferece "Atualizar"`, async ({ page, erros }) => {
      const { reqs } = await abrir(page, { relogio: true, resposta: resposta(etapa) });

      for (const texto of textos) await expect(page.locator('#statusPedido')).toContainText(texto);
      await aguardarPrimeira(reqs);
      await avancar(page, reqs, 120000, 0);
      await expect(page.locator('#btnAtualizar')).toBeVisible();
    });
  }

  test('CA7 ativo: "Atualizar" consulta uma vez e não retoma o ciclo (etapa final)', async ({ page, erros }) => {
    const { reqs } = await abrir(page, { relogio: true, resposta: resposta('ativo') });
    await aguardarPrimeira(reqs);

    await page.locator('#btnAtualizar').click();
    await expect.poll(() => reqs.length).toBe(2);
    await assentar();

    await avancar(page, reqs, 120000, 0);
  });
});

/* ---------------- CA8: domínio novo ---------------- */

test.describe('pedido — CA8: domínio novo', { tag: '@CIT-69' }, () => {
  test.use(ORIGEM_API);

  test('CA8 registro_dominio com domínio novo: registro manual, aviso por e-mail e nenhum prazo em dias', async ({ page, erros }) => {
    await abrir(page, { resposta: resposta('registro_dominio', { dominioNovo: true }) });

    await expect(page.locator('#statusEtapa')).toContainText('registra o domínio manualmente');
    await expect(page.locator('#statusEtapa')).toContainText('avisa por e-mail');
    expect(await page.locator('#statusPedido').innerText()).not.toMatch(/\d+\s*dias/);
  });

  test('CA8 dominio_pendente com URL: link da fatura do domínio em nova aba', async ({ page, erros }) => {
    await abrir(page, { resposta: resposta('dominio_pendente', { dominioNovo: true, faturaDominioUrl: FATURA_DOMINIO }) });

    const link = page.locator('#linkFaturaDominio');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', FATURA_DOMINIO);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(page.locator('#linkFaturaContas')).toBeHidden();
  });

  test('CA8 aguardando_confirmacao com domínio novo e as duas URLs: os dois links visíveis', async ({ page, erros }) => {
    await abrir(page, {
      resposta: resposta('aguardando_confirmacao', { dominioNovo: true, faturaContasUrl: FATURA_CONTAS, faturaDominioUrl: FATURA_DOMINIO }),
    });

    await expect(page.locator('#linkFaturaContas')).toBeVisible();
    await expect(page.locator('#linkFaturaDominio')).toBeVisible();
    await expect(page.locator('#linkFaturaContas')).toHaveAttribute('href', FATURA_CONTAS);
    await expect(page.locator('#linkFaturaDominio')).toHaveAttribute('href', FATURA_DOMINIO);
  });

  test('CA8 dominioNovo true mostra o aviso de registro manual; false o omite', async ({ page, erros }) => {
    const { estado } = await abrir(page, { resposta: resposta('aguardando_confirmacao', { dominioNovo: true }) });
    await expect(page.locator('#statusDominio')).toBeVisible();
    await expect(page.locator('#statusDominio')).toContainText('registro do domínio');

    estado.resposta = resposta('aguardando_confirmacao', { dominioNovo: false });
    await page.reload();

    await expect(page.locator('#statusEtapa')).toContainText('Aguardando a confirmação');
    await expect(page.locator('#statusDominio')).toBeHidden();
    await expect(page.locator('#statusPedido')).not.toContainText('registro do domínio');
  });
});

/* ---------------- CA9: backoff, aba oculta e limite ---------------- */

test.describe('pedido — CA9: intervalo, aba oculta e limite de 30 min', { tag: '@CIT-69' }, () => {
  test.use(ORIGEM_API);
  // 1 CPU e dezenas de avanços do relógio: o ciclo completo de 30 min leva alguns segundos reais.
  test.slow();

  test('CA9 mesma etapa: consultas em 0, 10, 20, 30, 40, 60, 80, 100, 120, 140, 200 e 260 s', async ({ page, erros }) => {
    const { reqs } = await abrir(page, { relogio: true });
    await aguardarPrimeira(reqs);

    for (const gap of [10, 10, 10, 10, 20, 20, 20, 20, 20, 60, 60]) await avancar(page, reqs, gap * 1000);

    expect(await instantes(page)).toEqual([0, 10, 20, 30, 40, 60, 80, 100, 120, 140, 200, 260]);
  });

  test('CA9 mudança de etapa na consulta de 60 s volta o intervalo a 10 s (70 e 80 s)', async ({ page, erros }) => {
    const { reqs } = await abrir(page, {
      relogio: true,
      resposta: (route, n) => json(route, 200, { etapa: n >= 6 ? 'ativando' : 'aguardando_confirmacao', dominioNovo: false }),
    });
    await aguardarPrimeira(reqs);

    for (const gap of [10, 10, 10, 10, 20, 10, 10]) await avancar(page, reqs, gap * 1000);

    expect(await instantes(page)).toEqual([0, 10, 20, 30, 40, 60, 70, 80]);
    await expect(page.locator('#statusEtapa')).toContainText('ativando');
  });

  for (const [rotulo, falha] of /** @type {[string, (route: any) => any][]} */ ([
    ['route.abort()', route => route.abort()],
    ['500', route => json(route, 500, { erro: 'interno' })],
  ])) {
    test(`CA9 erro (${rotulo}) na consulta de 20 s: mantém a etapa, mostra o aviso, tenta de novo em 30 s e o contador segue`, async ({ page, erros }) => {
      const { reqs } = await abrir(page, {
        relogio: true,
        resposta: (route, n) => (n === 3 ? falha(route) : json(route, 200, { etapa: 'aguardando_confirmacao', dominioNovo: false })),
      });
      await aguardarPrimeira(reqs);

      await avancar(page, reqs, 10000);
      await avancar(page, reqs, 10000);
      await expect(page.locator('#statusEtapa')).toContainText('Aguardando a confirmação');
      await expect(page.locator('#statusAviso')).toBeVisible();

      for (const gap of [10, 10, 10]) await avancar(page, reqs, gap * 1000);
      await expect(page.locator('#statusAviso')).toBeHidden();
      // 5ª resposta 200 igual (o erro não conta nem zera): depois dela o intervalo é de 20 s
      await avancar(page, reqs, 20000);

      expect(await instantes(page)).toEqual([0, 10, 20, 30, 40, 50, 70]);
      descartarStatus(erros);
    });
  }

  test('CA9 aba oculta por 5 min: nenhuma consulta; ao voltar, 1 imediata; o limite de 30 min desconta o tempo oculto (para em 35 min)', async ({ page, erros }) => {
    test.setTimeout(180000);
    const { reqs } = await abrir(page, { relogio: true });
    await aguardarPrimeira(reqs);

    await definirOculta(page, true);
    await avancar(page, reqs, 300000, 0);
    await definirOculta(page, false);
    await expect.poll(() => reqs.length, 'consulta imediata ao voltar').toBe(2);
    await assentar();

    // 2 respostas iguais até aqui, 300 s de relógio; os 30 min visíveis acabam em 300 + 1800 s
    const rel = { t: 300, k: 2 };
    await rodarAteALimite(page, reqs, rel, 300 + LIMITE_VISIVEL_S);

    expect(rel.t).toBe(300 + LIMITE_VISIVEL_S);
    await expect(page.locator('#btnAtualizar')).toBeVisible();
    const instantesFinais = await instantes(page);
    expect(instantesFinais[instantesFinais.length - 1], 'a última consulta é anterior ao limite').toBeLessThan(300 + LIMITE_VISIVEL_S);
    expect(instantesFinais.filter(t => t > 0 && t < 300), 'nenhuma consulta com a aba oculta').toEqual([]);
  });

  test('CA9 depois de 30 min visíveis: para, mostra "Atualizar" e o clique faz 1 consulta', async ({ page, erros }) => {
    test.setTimeout(180000);
    const { reqs } = await abrir(page, { relogio: true });
    await aguardarPrimeira(reqs);

    await rodarAteALimite(page, reqs, { t: 0, k: 1 }, LIMITE_VISIVEL_S);
    await expect(page.locator('#btnAtualizar')).toBeVisible();
    const antes = reqs.length;

    await page.locator('#btnAtualizar').click();

    await expect.poll(() => reqs.length).toBe(antes + 1);
  });

  test('CA9 404: "Pedido não encontrado", sem "Atualizar" e sem nova consulta', async ({ page, erros }) => {
    const { reqs } = await abrir(page, { relogio: true, resposta: route => json(route, 404, { erro: 'nao_encontrado' }) });

    await expect(page.locator('main')).toContainText('Pedido não encontrado');
    await expect(page.locator('main')).toContainText(CONTATO);
    await avancar(page, reqs, 120000, 0);
    await expect(page.locator('#btnAtualizar')).toBeHidden();
    descartarStatus(erros);
  });
});

/* ---------------- CA10: token inválido, 404 e modo local ---------------- */

test.describe('pedido — CA10: link inválido, não encontrado e modo local', { tag: '@CIT-69' }, () => {
  test.describe('modo API', () => {
    test.use(ORIGEM_API);

    for (const [rotulo, url] of [['sem hash', 'pedido.html'], ['com #t=abc', 'pedido.html#t=abc']]) {
      test(`CA10 ${rotulo}: "Link de acompanhamento inválido" e nenhuma requisição à API`, async ({ page, erros }) => {
        /** @type {string[]} */
        const chamadasApi = [];
        page.on('request', req => { if (new URL(req.url()).pathname.includes('/api/')) chamadasApi.push(req.url()); });
        await abrir(page, { url });

        await expect(page.locator('main')).toContainText('Link de acompanhamento inválido');
        await expect(page.locator('#statusPedido')).toBeHidden();
        await page.waitForLoadState('networkidle');
        expect(chamadasApi).toEqual([]);
      });
    }

    test('CA10 404: "Pedido não encontrado" e nenhuma nova requisição', async ({ page, erros }) => {
      const { reqs } = await abrir(page, { relogio: true, resposta: route => json(route, 404, { erro: 'nao_encontrado' }) });

      await expect(page.locator('main')).toContainText('Pedido não encontrado');
      await avancar(page, reqs, 60000, 0);
      descartarStatus(erros);
    });

    test('CA10 a requisição leva só { token } no corpo, sem cookie e sem o token na URL', async ({ page, erros }) => {
      const { reqs } = await abrir(page);
      await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);

      const req = reqs[0];
      expect(req.method()).toBe('POST');
      expect(req.postDataJSON()).toEqual({ token: TOKEN });
      expect(Object.keys(req.headers())).not.toContain('cookie');
      expect(req.url()).not.toContain(TOKEN);
      expect(new URL(req.url()).search).toBe('');
    });
  });

  test.describe('modo local (127.0.0.1)', () => {
    test('CA10 sem API: "Status indisponível" com o e-mail comercial, sem requisição e sem erro no console', async ({ page, erros }) => {
      /** @type {string[]} */
      const chamadasApi = [];
      page.on('request', req => { if (new URL(req.url()).pathname.includes('/api/')) chamadasApi.push(req.url()); });
      await page.goto(URL_PEDIDO);

      await expect(page.locator('#statusIndisponivel')).toBeVisible();
      await expect(page.locator('#statusIndisponivel a[href="mailto:comercial@citmail.com.br"]')).toBeVisible();
      await expect(page.locator('#statusPedido')).toBeHidden();
      await page.waitForLoadState('networkidle');
      expect(chamadasApi).toEqual([]);
    });
  });
});

/* ---------------- CA12: página, CSP e publicação (sem navegador) ---------------- */

const CSP_PEDIDO = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'";

/** @param {string} caminho */
const ler = caminho => readFileSync(new URL(`../${caminho}`, import.meta.url), 'utf8');

test.describe('pedido — CA12: contrato do arquivo e da publicação', { tag: '@CIT-69' }, () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'leitura de arquivo: roda num perfil só');
  });

  test('CA12 pedido.html tem a CSP exata, referrer no-referrer, robots noindex e título', () => {
    const html = ler('pedido.html');
    expect(/Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)?.[1]).toBe(CSP_PEDIDO);
    expect(html).toMatch(/<meta\s+name="referrer"\s+content="no-referrer"/i);
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex"/i);
    expect(html).toContain('<title>Acompanhe seu pedido — CITMail</title>');
  });

  test('CA12 pedido.html tem exatamente 1 h1, sem style= nem handler inline', () => {
    const html = ler('pedido.html').replace(/<!--[\s\S]*?-->/g, '');
    expect(html.match(/<h1\b/gi) ?? []).toHaveLength(1);
    expect(html, 'atributo style= em tag').not.toMatch(/<[^>]*\sstyle\s*=/i);
    expect(html, 'handler on* em tag').not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(html, '<script> inline').not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
  });

  test('CA12 ORIGENS_API de assets/pedido.js é igual à de assets/checkout.js', () => {
    const declaracao = fonte => /const ORIGENS_API = Object\.freeze\([\s\S]*?\);/.exec(fonte)?.[0];
    const checkout = declaracao(ler('assets/checkout.js'));
    expect(checkout, 'ORIGENS_API em checkout.js').toBeTruthy();
    expect(declaracao(ler('assets/pedido.js'))).toBe(checkout);
  });

  // CIT-70: login.js e painel.js usam a mesma lista de origens do modo API.
  for (const arquivo of ['assets/login.js', 'assets/painel.js']) {
    test(`CIT-70 CA10 ORIGENS_API de ${arquivo} é igual à de assets/checkout.js`, { tag: '@CIT-70' }, () => {
      const declaracao = fonte => /const ORIGENS_API = Object\.freeze\([\s\S]*?\);/.exec(fonte)?.[0];
      const checkout = declaracao(ler('assets/checkout.js'));
      expect(checkout, 'ORIGENS_API em checkout.js').toBeTruthy();
      expect(declaracao(ler(arquivo)), `ORIGENS_API em ${arquivo}`).toBe(checkout);
    });
  }

  // CIT-71: definir-senha.js usa a mesma lista de origens do modo API.
  test('CIT-71 CA10 ORIGENS_API de assets/definir-senha.js é igual à de assets/checkout.js', { tag: '@CIT-71' }, () => {
    const declaracao = fonte => /const ORIGENS_API = Object\.freeze\([\s\S]*?\);/.exec(fonte)?.[0];
    const checkout = declaracao(ler('assets/checkout.js'));
    expect(checkout, 'ORIGENS_API em checkout.js').toBeTruthy();
    expect(declaracao(ler('assets/definir-senha.js')), 'ORIGENS_API em assets/definir-senha.js').toBe(checkout);
  });

  test('CIT-71 CA12 a homologação confere e publica definir-senha.html, assets/definir-senha.js e assets/definir-senha.css nas duas listas', { tag: '@CIT-71' }, () => {
    const workflow = ler('.github/workflows/publicar-homologacao.yml');
    for (const arquivo of ['definir-senha.html', 'assets/definir-senha.js', 'assets/definir-senha.css']) {
      const escapado = arquivo.replace(/[.]/g, '\\.');
      expect(workflow, `${arquivo} na verificação do dist (test -f)`).toMatch(new RegExp(`test -f dist/${escapado}(\\s|$)`));
      expect(workflow, `${arquivo} no laço de comparação com o publicado`).toMatch(new RegExp(`for arquivo in [^;]*\\b${escapado}\\b`));
    }
  });

  test('CA12 a homologação confere e publica pedido.html, assets/pedido.js e assets/pedido.css nas duas listas', () => {
    const workflow = ler('.github/workflows/publicar-homologacao.yml');
    for (const arquivo of ['pedido.html', 'assets/pedido.js', 'assets/pedido.css']) {
      const escapado = arquivo.replace(/[.]/g, '\\.');
      expect(workflow, `${arquivo} na verificação do dist (test -f)`).toMatch(new RegExp(`test -f dist/${escapado}(\\s|$)`));
      expect(workflow, `${arquivo} no laço de comparação com o publicado`).toMatch(new RegExp(`for arquivo in [^;]*\\b${escapado}\\b`));
    }
  });
});

/* ---------------- CA13: mobile ---------------- */

/** @param {import('@playwright/test').Page} page */
async function semRolagem(page) {
  const m = await page.evaluate(() => ({ rolagem: document.documentElement.scrollWidth, largura: window.innerWidth }));
  expect(m.rolagem, 'sem rolagem horizontal').toBeLessThanOrEqual(m.largura);
  return m.largura;
}

/** @param {import('@playwright/test').Locator} el @param {number} largura @param {boolean} minimo44 */
async function caixaOk(el, largura, minimo44) {
  await el.scrollIntoViewIfNeeded();
  const c = await el.boundingBox();
  expect(c, 'elemento com caixa').not.toBeNull();
  const caixa = /** @type {{ x: number, width: number, height: number }} */ (c);
  expect(caixa.x).toBeGreaterThanOrEqual(0);
  expect(caixa.x + caixa.width).toBeLessThanOrEqual(largura);
  if (minimo44) expect(caixa.height).toBeGreaterThanOrEqual(44);
}

test.describe('pedido — CA13: estados em 320, 375 e 1280 px', { tag: '@CIT-69' }, () => {
  for (const largura of [320, 375, 1280]) {
    const mobile = largura <= 375;
    const altura = mobile ? 700 : 800;

    test.describe(`${largura} px, modo API`, () => {
      test.use(ORIGEM_API);

      test(`CA13 aguardando com link, domínio pendente com aviso, ativo e falha de atualização em ${largura} px: sem rolagem horizontal e controles dentro da tela`, async ({ page, erros }, testInfo) => {
        await page.setViewportSize({ width: largura, height: altura });
        const { estado } = await abrir(page);

        /** @type {[string, (route: any) => any, (() => Promise<void>)][]} */
        const estados = [
          ['aguardando', resposta('aguardando_confirmacao', { faturaContasUrl: FATURA_CONTAS }),
            () => caixaOk(page.locator('#linkFaturaContas'), largura, mobile)],
          ['dominio-pendente', resposta('dominio_pendente', { dominioNovo: true, faturaDominioUrl: FATURA_DOMINIO }),
            async () => {
              await caixaOk(page.locator('#statusDominio'), largura, false);
              await caixaOk(page.locator('#linkFaturaDominio'), largura, mobile);
            }],
          ['ativo', resposta('ativo'), () => caixaOk(page.locator('#btnAtualizar'), largura, mobile)],
          ['falha', route => json(route, 500, { erro: 'interno' }),
            async () => {
              await expect(page.locator('#statusAviso')).toBeVisible();
              await caixaOk(page.locator('#statusAviso'), largura, false);
            }],
        ];
        for (const [nome, mock, conferir] of estados) {
          estado.resposta = mock;
          await page.goto('about:blank');
          await page.goto(URL_PEDIDO);
          await expect(nome === 'falha' ? page.locator('#statusAviso') : page.locator('#statusEtapa')).toBeVisible();
          await semRolagem(page);
          await conferir();
          await page.screenshot({ path: testInfo.outputPath(`pedido-${nome}-${largura}.png`), fullPage: true });
        }
        descartarStatus(erros);
      });
    });

    test.describe(`${largura} px, modo local`, () => {
      test(`CA13 status indisponível em ${largura} px: sem rolagem horizontal e e-mail dentro da tela`, async ({ page, erros }, testInfo) => {
        await page.setViewportSize({ width: largura, height: altura });
        await page.goto(URL_PEDIDO);

        await expect(page.locator('#statusIndisponivel')).toBeVisible();
        await semRolagem(page);
        await caixaOk(page.locator('#statusIndisponivel'), largura, false);
        await page.screenshot({ path: testInfo.outputPath(`pedido-local-${largura}.png`), fullPage: true });
      });
    });
  }
});
