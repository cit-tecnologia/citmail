// @ts-check
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';

// CIT-63: o checkout envia o pedido (POST /api/pedidos) e leva o comprador à fatura do Asaas.
// Modo API = origem http://localhost:4200 (a mesma do Vite, presente em ORIGENS_API); a API (/api/orcamento e
// /api/pedidos) e os hosts do Asaas são sempre mockados com page.route. Dados fictícios (CPF com dígito verificador válido).
// Como a origem do teste é a da API, a fixture `erros` registra os 4xx/5xx e as falhas mockados: `descartarApi` os retira.
// Os testes que dependem de prazo (90 s) ou de "sem debounce" (CA8) usam page.clock (instalado antes do goto, pausado).

const ORIGEM_API = { baseURL: 'http://localhost:4200/citmail/' };
const CPF = '52998224725';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FATURA_CONTAS = 'https://sandbox.asaas.com/i/abc';
const FATURA_DOMINIOS = 'https://sandbox.asaas.com/i/def';
const PEDIDO_ID = 'ped-ficticio-0001';
const VERSAO_TABELA = '2099-01-01.1';

/* ---------------- mocks ---------------- */

/**
 * Resposta 200 de /api/orcamento coerente com o corpo recebido (avulso de 40,00 só com domínio novo).
 * @param {any} corpo
 * @param {{ mensal: number, versao: string }} estado
 */
function orcamento(corpo, estado) {
  const avulso = corpo.dominio?.tipo === 'novo' ? 4000 : 0;
  const itens = Object.entries(corpo.contas ?? {})
    .filter(([, q]) => /** @type {number} */ (q) > 0)
    .map(([chave, q], i) => {
      const quantidade = /** @type {number} */ (q);
      const subtotal = i === 0 ? estado.mensal : 0;
      return {
        tipo: 'conta', chave, quantidade,
        unit_atual_centavos: Math.floor(subtotal / quantidade), unit_tabela_centavos: Math.floor(subtotal / quantidade),
        unit_cobrado_centavos: Math.floor(subtotal / quantidade),
        tabela_centavos: subtotal, atual_centavos: subtotal, subtotal_centavos: subtotal, descontos: [],
      };
    });
  return {
    versao_tabela: estado.versao,
    ciclo: corpo.ciclo,
    itens,
    avulsos: avulso > 0
      ? [{ tipo: 'dominio_principal', quantidade: 1, periodo: 'ano', unit_centavos: avulso, subtotal_centavos: avulso }]
      : [],
    totais: {
      recorrente_mensal_centavos: estado.mensal,
      recorrente_ciclo_centavos: corpo.ciclo === 'anual' ? estado.mensal * 12 : estado.mensal,
      tabela_mensal_centavos: estado.mensal,
      economia_mensal_centavos: 0,
      avulso_centavos: avulso,
    },
  };
}

/** @param {any} route @param {number} status @param {any} corpo */
const json = (route, status, corpo) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(corpo) });

/** @param {any} route @param {{ tipo: string, url: string | null }[]} faturas @param {object} [extra] */
const criado = (route, faturas, extra = {}) =>
  json(route, 201, { pedidoId: PEDIDO_ID, estado: 'criado', faturas, ...extra });

const soContas = (/** @type {any} */ route) => criado(route, [{ tipo: 'contas', url: FATURA_CONTAS }]);

/** Resposta 504 do proxy: HTML, sem JSON (classe ambígua da Decisão 8). */
const proxy504 = (/** @type {any} */ route) =>
  route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body>Gateway Time-out</body></html>' });

/**
 * Retira da fixture `erros` o que o próprio mock provoca em /api/orcamento e /api/pedidos (status 4xx/5xx e aborts).
 * @param {string[]} erros
 */
function descartarApi(erros) {
  for (let i = erros.length - 1; i >= 0; i--) {
    const url = erros[i].split(' ').slice(1).join(' ');
    if (/\/api\/(orcamento|pedidos)$/.test(url)) erros.splice(i, 1);
  }
}

/**
 * @typedef {object} Opcoes
 * @property {(route: any, corpo: any, n: number) => any} [pedido] resposta do POST /api/pedidos (n = 1, 2, …); padrão: 201 só contas
 * @property {boolean} [relogio] instala page.clock pausado (debounce e prazo só andam por runFor)
 * @property {{ mensal: number, versao: string }} [orc] estado do orçamento mockado (mutável pelo teste)
 */

/**
 * Registra os mocks e abre o checkout em modo API.
 * @param {import('@playwright/test').Page} page
 * @param {Opcoes} [o]
 */
async function abrir(page, o = {}) {
  /** @type {import('@playwright/test').Request[]} */
  const posts = [];
  /** @type {any[]} */
  const orcamentos = [];
  /** @type {string[]} */
  const externas = [];
  const orc = o.orc ?? { mensal: 12345, versao: VERSAO_TABELA };
  let n = 0;
  page.on('request', req => {
    const u = new URL(req.url());
    if (req.method() === 'POST' && u.pathname.endsWith('/api/pedidos')) posts.push(req);
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && /asaas|evil\.example/.test(u.hostname)) externas.push(req.url());
  });
  await page.route('**/viacep.com.br/**', route => route.fulfill({ json: { erro: true } }));
  await page.route('**/api/orcamento', route => {
    const corpo = route.request().postDataJSON();
    orcamentos.push(corpo);
    return json(route, 200, orcamento(corpo, orc));
  });
  await page.route('**/api/pedidos', route => {
    n += 1;
    return (o.pedido ?? soContas)(route, route.request().postDataJSON(), n);
  });
  await page.route(url => !['localhost', '127.0.0.1'].includes(url.hostname) && /asaas|evil\.example/.test(url.hostname),
    route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Fatura fictícia</title><p>Fatura</p>' }));
  if (o.relogio) await page.clock.install();
  await page.goto('checkout.html');
  await page.waitForLoadState('networkidle'); // evita a recarga do Vite na 1ª carga a frio
  if (o.relogio) await page.clock.pauseAt(new Date(Date.now() + 5000));
  return { posts, orcamentos, externas, orc };
}

/**
 * Do passo 1 até a revisão, com dados fictícios.
 * @param {import('@playwright/test').Page} page
 * @param {{ dominio?: 'novo' | 'existente', extras?: string[], relogio?: boolean }} [o]
 */
async function chegarRevisao(page, o = {}) {
  const { dominio = 'novo', extras = ['outraempresa'], relogio = false } = o;
  await page.evaluate(() => ckChangeQty('25gb', 2));
  await page.locator('#btnStep1Next').click();
  if (dominio === 'novo') {
    await page.locator('#doptBr').click();
    await page.locator('#fDomNew').fill('minhaempresa');
  } else {
    await page.locator('#doptExist').click();
    await page.locator('#fDomExist').fill('minhaempresa.com.br');
  }
  await page.locator('#btnStep2Next').click();
  if (extras.length) await page.evaluate(n => addonChange('extraDom', n), extras.length);
  await expect(page.locator('#step3')).toHaveClass(/active/);
  for (const [i, rotulo] of extras.entries()) await page.locator(`#fDomExtra${i + 1}`).fill(rotulo);
  await page.locator('#btnStep3Next').click();
  await expect(page.locator('#step4')).toHaveClass(/active/);
  await page.locator('#fNome').fill('Maria Ficticia');
  await page.locator('#fEmail').fill('maria@exemplo.test');
  await page.locator('#fTelefone').fill('11999990000');
  await page.locator('#fCPF').fill(CPF);
  await page.locator('#fCEP').fill('01001000');
  if (relogio) await page.clock.runFor(400);
  await expect(page.locator('#orderSummary')).toHaveAttribute('data-total-confirmado', /^\d+$/);
  await page.locator('#termsCheck').check({ force: true });
  await expect(page.locator('#termsCheck')).toBeChecked();
  await page.locator('#btnSubmitCadastro').click();
  await expect(page.locator('#step5')).toHaveClass(/active/);
  await expect(page.locator('#btnIrPagamento')).toBeVisible();
}

const pagar = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#btnIrPagamento').click();

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

/* ---------------- CA3: envio e redirecionamento ---------------- */

test.describe('checkout-pedido — CA3: envio do pedido e redirecionamento', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  test('CA3 o clique em "Ir para pagamento" envia 1 POST com o corpo exato e sem cookie', async ({ page, erros }) => {
    const { posts, orcamentos } = await abrir(page, {
      pedido: route => criado(route, [{ tipo: 'contas', url: FATURA_CONTAS }, { tipo: 'dominios', url: FATURA_DOMINIOS }]),
    });
    await chegarRevisao(page);
    await pagar(page);
    await expect.poll(() => posts.length).toBe(1);
    await page.waitForTimeout(500);
    expect(posts.length, 'exatamente 1 POST').toBe(1);

    const req = posts[0];
    expect(req.headers()['content-type']).toContain('application/json');
    expect(Object.keys(req.headers())).not.toContain('cookie');
    const corpo = req.postDataJSON();
    const base = orcamentos[orcamentos.length - 1];
    expect(corpo).toEqual({
      ...base,
      dominio: { tipo: 'novo', nome: 'minhaempresa' },
      dominios_extras: ['outraempresa'],
      cliente: { nome: 'Maria Ficticia', email: 'maria@exemplo.test', telefone: '11999990000', documento: CPF },
      chave_idempotencia: expect.stringMatching(UUID_V4),
      versao_tabela: VERSAO_TABELA,
      total_exibido_centavos: 16345,
      aceite: { termos: true, versao_termos: '0.1', versao_privacidade: 'externa-2026-11-23' },
    });
    for (const chave of ['cep', 'senha', 'endereco']) expect(corpo).not.toHaveProperty(chave);
    descartarApi(erros);
  });

  test('CA3 com domínio existente e sem extras o corpo não leva dominios_extras e o total é o do orçamento', async ({ page, erros }) => {
    const { posts } = await abrir(page);
    await chegarRevisao(page, { dominio: 'existente', extras: [] });
    await pagar(page);
    await expect.poll(() => posts.length).toBe(1);
    const corpo = posts[0].postDataJSON();
    expect(corpo.dominio).toEqual({ tipo: 'existente', nome: 'minhaempresa.com.br' });
    expect(corpo).not.toHaveProperty('dominios_extras');
    expect(corpo.total_exibido_centavos).toBe(12345);
    descartarApi(erros);
  });

  test('CA3 só fatura de contas com URL do Asaas: o navegador vai para a fatura', async ({ page, erros }) => {
    await abrir(page);
    await chegarRevisao(page, { dominio: 'existente', extras: [] });
    await pagar(page);
    await page.waitForURL(FATURA_CONTAS);
    descartarApi(erros);
  });

  test('CA3 com fatura de domínios não navega e mostra os dois links seguros em nova aba', async ({ page, erros }) => {
    await abrir(page, {
      pedido: route => criado(route, [{ tipo: 'contas', url: FATURA_CONTAS }, { tipo: 'dominios', url: FATURA_DOMINIOS }]),
    });
    await chegarRevisao(page);
    await pagar(page);
    const contas = page.locator('#linkFaturaContas');
    const dominios = page.locator('#linkFaturaDominios');
    await expect(contas).toBeVisible();
    await expect(dominios).toBeVisible();
    await expect(contas).toHaveAttribute('href', FATURA_CONTAS);
    await expect(dominios).toHaveAttribute('href', FATURA_DOMINIOS);
    for (const link of [contas, dominios]) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expect(link).toHaveAttribute('rel', /noreferrer/);
    }
    expect(page.url()).toContain('checkout.html');
    await expect(page.locator('#btnIrPagamento'), 'nada de 2º pedido na mesma página').toBeHidden();
    descartarApi(erros);
  });
});

/* ---------------- CA4: URL não confiável ou fatura pendente ---------------- */

/** @type {{ nome: string, faturas: { tipo: string, url: string | null }[], extra?: object }[]} */
const NAO_CONFIAVEIS = [
  { nome: 'outro domínio', faturas: [{ tipo: 'contas', url: 'https://evil.example/i/x' }] },
  { nome: 'host que termina em asaas.com sem ser o Asaas', faturas: [{ tipo: 'contas', url: 'https://asaas.com.evil.example/i/x' }] },
  { nome: 'http em vez de https', faturas: [{ tipo: 'contas', url: 'http://sandbox.asaas.com/i/x' }] },
  { nome: 'porta explícita', faturas: [{ tipo: 'contas', url: 'https://www.asaas.com:444/x' }] },
  { nome: 'usuário e senha na URL', faturas: [{ tipo: 'contas', url: 'https://u:p@www.asaas.com/i/x' }] },
  { nome: 'esquema javascript:', faturas: [{ tipo: 'contas', url: 'javascript:alert(1)' }] },
  { nome: 'URL nula', faturas: [{ tipo: 'contas', url: null }] },
  { nome: 'aviso fatura_pendente', faturas: [{ tipo: 'contas', url: FATURA_CONTAS }], extra: { aviso: 'fatura_pendente' } },
];

test.describe('checkout-pedido — CA4: URL de fatura não confiável', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  for (const caso of NAO_CONFIAVEIS) {
    test(`CA4 ${caso.nome}: sem navegação, com "Pedido recebido" e o número do pedido`, async ({ page, erros }) => {
      /** @type {string[]} */
      const dialogos = [];
      page.on('dialog', d => { dialogos.push(d.message()); d.dismiss().catch(() => {}); });
      const { externas } = await abrir(page, { pedido: route => criado(route, caso.faturas, caso.extra) });
      await chegarRevisao(page, { dominio: 'existente', extras: [] });
      await pagar(page);

      const aviso = page.locator('#pedidoAviso');
      await expect(aviso).toBeVisible();
      await expect(aviso).toHaveAttribute('role', 'status');
      await expect(aviso).toContainText('Pedido recebido');
      await expect(aviso).toContainText(PEDIDO_ID);
      await page.waitForTimeout(500);
      expect(page.url()).toContain('checkout.html');
      expect(externas, 'nenhuma requisição ao host da fatura').toEqual([]);
      await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
      expect(dialogos).toEqual([]);
      descartarApi(erros);
    });
  }
});

/* ---------------- CA6: erro, nova tentativa e chave ---------------- */

/** @param {import('@playwright/test').Page} page */
async function conferirErro(page) {
  const erro = page.locator('#pedidoErro');
  await expect(erro).toBeVisible();
  await expect(erro).toHaveAttribute('role', 'alert');
  expect(page.url()).toContain('checkout.html');
}

test.describe('checkout-pedido — CA6: erro, nova tentativa e chave de idempotência', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  for (const status of [502, 504]) {
    test(`CA6a ${status} asaas_indisponivel: mantém os campos, foca "Tentar novamente" e o 2º POST leva chave nova`, async ({ page, erros }) => {
      const { posts } = await abrir(page, {
        pedido: (route, _corpo, n) => (n === 1 ? json(route, status, { erro: 'asaas_indisponivel' }) : soContas(route)),
      });
      await chegarRevisao(page);
      await pagar(page);
      await conferirErro(page);
      await expect(page.locator('#btnPedidoRetry')).toBeFocused();
      await expect(page.locator('#pedidoAmbiguoAviso')).toBeHidden();
      for (const [seletor, valor] of [['#fNome', 'Maria Ficticia'], ['#fEmail', 'maria@exemplo.test'], ['#fTelefone', /11.*99999.*0000/],
        ['#fCPF', /529.*982.*247.*25/], ['#fDomNew', 'minhaempresa'], ['#fDomExtra1', 'outraempresa']]) {
        await expect(page.locator(String(seletor))).toHaveValue(valor);
      }
      await page.locator('#btnPedidoRetry').click();
      await page.waitForURL(FATURA_CONTAS);
      expect(posts.length).toBe(2);
      expect(posts[1].postDataJSON().chave_idempotencia).toMatch(UUID_V4);
      expect(posts[1].postDataJSON().chave_idempotencia).not.toBe(posts[0].postDataJSON().chave_idempotencia);
      descartarApi(erros);
    });
  }

  test('CA6b 500 interno (pedido retomável): o 2º POST leva a mesma chave', async ({ page, erros }) => {
    const { posts } = await abrir(page, {
      pedido: (route, _corpo, n) => (n === 1 ? json(route, 500, { erro: 'interno' }) : soContas(route)),
    });
    await chegarRevisao(page);
    await pagar(page);
    await conferirErro(page);
    await expect(page.locator('#btnPedidoRetry')).toBeFocused();
    await page.locator('#btnPedidoRetry').click();
    await page.waitForURL(FATURA_CONTAS);
    expect(posts.length).toBe(2);
    expect(posts[1].postDataJSON().chave_idempotencia).toBe(posts[0].postDataJSON().chave_idempotencia);
    descartarApi(erros);
  });

  /** @type {{ nome: string, resposta: (route: any) => any, relogio?: boolean }[]} */
  const AMBIGUOS = [
    { nome: '504 com corpo HTML do proxy', resposta: proxy504 },
    { nome: 'conexão abortada', resposta: route => route.abort() },
    { nome: '90 s sem resposta', resposta: () => new Promise(() => {}), relogio: true },
    { nome: '201 sem faturas', resposta: route => json(route, 201, { pedidoId: PEDIDO_ID, estado: 'criado' }) },
    { nome: '409 pedido_em_criacao', resposta: route => json(route, 409, { erro: 'pedido_em_criacao' }) },
  ];

  for (const caso of AMBIGUOS) {
    test(`CA6c ${caso.nome}: avisa que o pedido pode já existir, trava a edição e reenvia a mesma chave e o mesmo corpo`, async ({ page, erros }) => {
      const { posts } = await abrir(page, {
        relogio: caso.relogio,
        pedido: (route, _corpo, n) => (n === 1 ? caso.resposta(route) : soContas(route)),
      });
      await chegarRevisao(page, { relogio: caso.relogio });
      await pagar(page);
      await expect.poll(() => posts.length).toBe(1);
      if (caso.relogio) await page.clock.runFor(90000);

      await conferirErro(page);
      await expect(page.locator('#btnPedidoRetry')).toBeFocused();
      await expect(page.locator('#pedidoAmbiguoAviso')).toContainText('pode já ter sido criado');
      const navegacao = page.locator('#step5 [data-ir-passo]');
      expect(await navegacao.count(), 'a revisão tem botões de voltar').toBeGreaterThan(0);
      for (const botao of await navegacao.all()) await expect(botao).toBeDisabled();

      await page.locator('#btnPedidoRetry').click();
      if (caso.relogio) await page.clock.runFor(1000);
      await expect.poll(() => posts.length).toBe(2);
      expect(posts[1].postDataJSON()).toEqual(posts[0].postDataJSON());
      descartarApi(erros);
    });
  }

  test('CA6d ambíguo seguido de 422 chave_reutilizada: manda falar com o comercial, sem retry e sem 3º POST', async ({ page, erros }) => {
    const { posts } = await abrir(page, {
      pedido: (route, _corpo, n) => (n === 1 ? proxy504(route) : json(route, 422, { erro: 'chave_reutilizada' })),
    });
    await chegarRevisao(page);
    await pagar(page);
    await conferirErro(page);
    await page.locator('#btnPedidoRetry').click();
    await expect.poll(() => posts.length).toBe(2);

    await conferirErro(page);
    await expect(page.locator('#pedidoErroTexto')).toContainText('comercial@citmail.com.br');
    await expect(page.locator('#btnPedidoRetry')).toBeHidden();
    for (const botao of await page.locator('#step5 button').all()) await botao.dispatchEvent('click');
    await page.waitForTimeout(500);
    expect(posts.length, 'nenhum 3º POST').toBe(2);
    descartarApi(erros);
  });

  test('CA6e 404 (API desabilitada): mensagem de indisponível e sem "Tentar novamente"', async ({ page, erros }) => {
    await abrir(page, { pedido: route => json(route, 404, { erro: 'nao_encontrado' }) });
    await chegarRevisao(page);
    await pagar(page);
    await conferirErro(page);
    await expect(page.locator('#pedidoErroTexto')).toContainText('indisponível');
    await expect(page.locator('#btnPedidoRetry')).toBeHidden();
    descartarApi(erros);
  });
});

/* ---------------- CA7: clique duplo ---------------- */

test.describe('checkout-pedido — CA7: clique duplo', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  test('CA7 com a resposta retida, o 2º clique não gera 2º POST e o botão mostra o andamento', async ({ page, erros }) => {
    /** @type {() => void} */
    let liberar = () => {};
    const gate = new Promise(resolve => { liberar = () => resolve(undefined); });
    const { posts } = await abrir(page, { pedido: async route => { await gate; await soContas(route); } });
    await chegarRevisao(page);

    await pagar(page);
    await page.locator('#btnIrPagamento').dispatchEvent('click');
    await expect.poll(() => posts.length).toBe(1);
    await page.waitForTimeout(500);
    expect(posts.length, 'um só POST').toBe(1);
    await expect(page.locator('#btnIrPagamento')).toBeDisabled();
    await expect(page.locator('#btnIrPagamento')).toHaveAttribute('aria-busy', 'true');
    const progresso = page.locator('#pedidoProgresso');
    await expect(progresso).toHaveAttribute('role', 'status');
    await expect(progresso).toContainText('Gerando sua fatura…');

    liberar();
    await page.waitForURL(FATURA_CONTAS);
    expect(posts.length).toBe(1);
    descartarApi(erros);
  });
});

/* ---------------- CA8: 409 total e termos divergentes ---------------- */

test.describe('checkout-pedido — CA8: total e termos divergentes', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  test('CA8 total_divergente refaz o orçamento na hora (sem debounce), atualiza o total e exige novo clique com chave nova', async ({ page, erros }) => {
    const orc = { mensal: 12345, versao: VERSAO_TABELA };
    const { posts, orcamentos } = await abrir(page, {
      relogio: true,
      orc,
      pedido: (route, _corpo, n) => {
        if (n > 1) return soContas(route);
        orc.mensal = 13000; // o próximo orçamento já responde o valor novo (13000 + 4000 de domínio = 17000)
        orc.versao = '2099-01-02.1';
        return json(route, 409, { erro: 'total_divergente', total_centavos: 17000, versao_tabela: '2099-01-02.1' });
      },
    });
    await chegarRevisao(page, { relogio: true });
    const antes = orcamentos.length;
    await pagar(page);
    await expect.poll(() => posts.length).toBe(1);

    // relógio parado: só um orçamento disparado direto (sem os 300 ms do debounce) chega aqui
    await expect.poll(() => orcamentos.length).toBe(antes + 1);
    await expect(page.locator('#orderSummary')).toHaveAttribute('data-total-confirmado', '17000');
    await expect(page.locator('#sumTotal')).toHaveText('R$ 130,00');
    await expect(page.locator('#pedidoErroTexto')).toContainText('O valor foi atualizado');
    expect(page.url()).toContain('checkout.html');
    await page.clock.runFor(1000);
    expect(posts.length, 'sem 2º POST de pedido até novo clique').toBe(1);

    await pagar(page);
    await page.clock.runFor(1000);
    await expect.poll(() => posts.length).toBe(2);
    const [primeiro, segundo] = posts.map(p => p.postDataJSON());
    expect(segundo.total_exibido_centavos).toBe(17000);
    expect(segundo.versao_tabela).toBe('2099-01-02.1');
    expect(segundo.chave_idempotencia).not.toBe(primeiro.chave_idempotencia);
    descartarApi(erros);
  });

  test('CA8 versao_termos_divergente desmarca o aceite e pede para recarregar a página', async ({ page, erros }) => {
    await abrir(page, { pedido: route => json(route, 409, { erro: 'versao_termos_divergente' }) });
    await chegarRevisao(page);
    await pagar(page);
    await conferirErro(page);
    await expect(page.locator('#termsCheck')).not.toBeChecked();
    await expect(page.locator('#pedidoErroTexto')).toContainText('termos foram atualizados');
    descartarApi(erros);
  });
});

/* ---------------- CA9: 400 de validação ---------------- */

/** @param {{ campo: string }[]} campos */
const validacao = campos => (/** @type {any} */ route) =>
  json(route, 400, { erro: 'validacao', campos: campos.map(c => ({ ...c, mensagem: 'inválido' })) });

test.describe('checkout-pedido — CA9: 400 de validação', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  test('CA9 marca os campos do cliente e do domínio extra e "Revisar dados" leva ao primeiro passo com erro', async ({ page, erros }) => {
    await abrir(page, { pedido: validacao([{ campo: 'cliente.documento' }, { campo: 'dominios_extras.0' }]) });
    await chegarRevisao(page);
    await pagar(page);
    await conferirErro(page);
    await expect(page.locator('#fCPF')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#fDomExtra1')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#pedidoErroTexto')).toContainText('Revise os dados destacados');
    await page.locator('#btnPedidoRevisar').click();
    await expect(page.locator('#step3')).toHaveClass(/active/);
    descartarApi(erros);
  });

  test('CA9 dominios_extras sem índice marca o primeiro campo de extra', async ({ page, erros }) => {
    await abrir(page, { pedido: validacao([{ campo: 'dominios_extras' }]) });
    await chegarRevisao(page);
    await pagar(page);
    await conferirErro(page);
    await expect(page.locator('#fDomExtra1')).toHaveAttribute('aria-invalid', 'true');
    descartarApi(erros);
  });

  test('CA9 campo desconhecido vira mensagem genérica, sem "Revisar dados", e a nova tentativa leva chave nova', async ({ page, erros }) => {
    const { posts } = await abrir(page, {
      pedido: (route, corpo, n) => (n === 1 ? validacao([{ campo: 'desconhecido' }])(route) : soContas(route)),
    });
    await chegarRevisao(page);
    await pagar(page);
    await conferirErro(page);
    await expect(page.locator('#btnPedidoRevisar')).toBeHidden();
    await expect(page.locator('#pedidoErroTexto')).not.toContainText('Revise os dados destacados');
    await page.locator('#btnPedidoRetry').click();
    await page.waitForURL(FATURA_CONTAS);
    expect(posts[1].postDataJSON().chave_idempotencia).not.toBe(posts[0].postDataJSON().chave_idempotencia);
    descartarApi(erros);
  });
});

/* ---------------- CA10: revalidação dos extras antes do POST ---------------- */

test.describe('checkout-pedido — CA10: domínio extra revalidado antes do POST', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  test('CA10 extra alterado para inválido depois do passo 3 bloqueia o POST e leva ao passo 3', async ({ page, erros }) => {
    const { posts } = await abrir(page);
    await chegarRevisao(page);
    await page.locator('#fDomExtra1').evaluate(el => {
      /** @type {HTMLInputElement} */ (el).value = '-x';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await pagar(page);
    await expect(page.locator('#step3')).toHaveClass(/active/);
    await expect(page.locator('#err-dom-extra-1')).toBeVisible();
    await page.waitForTimeout(500);
    expect(posts.length, 'nenhum POST de pedido').toBe(0);
    descartarApi(erros);
  });
});

/* ---------------- CA11: avisos do modo local ocultos no modo API ---------------- */

test.describe('checkout-pedido — CA11: sem avisos de "em breve" no modo API', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  test('CA11 em localhost os três avisos do modo local ficam ocultos', async ({ page, erros }) => {
    await abrir(page);
    await expect(page.locator('#avisoEmBreve')).toBeHidden();
    await chegarRevisao(page);
    await expect(page.locator('#avisoEmBreveCadastro')).toBeHidden();
    await expect(page.locator('#revisaoEmBreve')).toBeHidden();
    descartarApi(erros);
  });
});

/* ---------------- CA14: mobile (estados do modo API) ---------------- */

test.describe('checkout-pedido — CA14: estados do modo API em 320, 375 e 1280 px', { tag: '@CIT-63' }, () => {
  test.use(ORIGEM_API);

  for (const largura of [320, 375, 1280]) {
    const mobile = largura <= 375;
    const altura = mobile ? 700 : 800;

    test(`CA14 revisão em ${largura} px: sem rolagem horizontal e botão de pagamento dentro da tela`, async ({ page, erros }, testInfo) => {
      await page.setViewportSize({ width: largura, height: altura });
      await abrir(page);
      await chegarRevisao(page);
      await semRolagem(page);
      await caixaOk(page.locator('#btnIrPagamento'), largura, mobile);
      await page.screenshot({ path: testInfo.outputPath(`revisao-${largura}.png`), fullPage: true });
      descartarApi(erros);
    });

    test(`CA14 erro ambíguo em ${largura} px: alerta, aviso e "Tentar novamente" cabem na tela`, async ({ page, erros }, testInfo) => {
      await page.setViewportSize({ width: largura, height: altura });
      await abrir(page, { pedido: proxy504 });
      await chegarRevisao(page);
      await pagar(page);
      await conferirErro(page);
      await expect(page.locator('#pedidoAmbiguoAviso')).toBeVisible();
      await semRolagem(page);
      await caixaOk(page.locator('#pedidoErro'), largura, false);
      await caixaOk(page.locator('#pedidoAmbiguoAviso'), largura, false);
      await caixaOk(page.locator('#btnPedidoRetry'), largura, mobile);
      await page.screenshot({ path: testInfo.outputPath(`erro-${largura}.png`), fullPage: true });
      descartarApi(erros);
    });

    test(`CA14 aviso de pedido recebido em ${largura} px: cabe na tela`, async ({ page, erros }, testInfo) => {
      await page.setViewportSize({ width: largura, height: altura });
      await abrir(page, { pedido: route => criado(route, [{ tipo: 'contas', url: null }]) });
      await chegarRevisao(page);
      await pagar(page);
      await expect(page.locator('#pedidoAviso')).toBeVisible();
      await semRolagem(page);
      await caixaOk(page.locator('#pedidoAviso'), largura, false);
      await page.screenshot({ path: testInfo.outputPath(`aviso-${largura}.png`), fullPage: true });
      descartarApi(erros);
    });

    test(`CA14 links das faturas em ${largura} px: cabem na tela e têm altura de toque`, async ({ page, erros }, testInfo) => {
      await page.setViewportSize({ width: largura, height: altura });
      await abrir(page, {
        pedido: route => criado(route, [{ tipo: 'contas', url: FATURA_CONTAS }, { tipo: 'dominios', url: FATURA_DOMINIOS }]),
      });
      await chegarRevisao(page);
      await pagar(page);
      await expect(page.locator('#pedidoFaturas')).toBeVisible();
      await semRolagem(page);
      await caixaOk(page.locator('#linkFaturaContas'), largura, mobile);
      await caixaOk(page.locator('#linkFaturaDominios'), largura, mobile);
      await page.screenshot({ path: testInfo.outputPath(`faturas-${largura}.png`), fullPage: true });
      descartarApi(erros);
    });
  }
});

/* ---------------- CA15: paridade e versões (sem navegador) ---------------- */

test.describe('checkout-pedido — CA15: paridade das versões e dos recursos', { tag: '@CIT-63' }, () => {
  const ler = (/** @type {string} */ caminho) => readFileSync(new URL(caminho, import.meta.url), 'utf8');
  const constante = (/** @type {string} */ fonte, /** @type {string} */ nome) =>
    new RegExp(`${nome}\\s*=\\s*'([^']+)'`).exec(fonte)?.[1];

  test('CA15 VERSAO_TERMOS e VERSAO_PRIVACIDADE do checkout são iguais às da API', async () => {
    const front = ler('../assets/checkout.js');
    const api = ler('../api/src/pedidos/aceite.js');
    for (const nome of ['VERSAO_TERMOS', 'VERSAO_PRIVACIDADE']) {
      expect(constante(front, nome), `${nome} no checkout`).toBeTruthy();
      expect(constante(front, nome)).toBe(constante(api, nome));
    }
  });

  test('CA15 #termosVersao de termos.html cita a versão dos termos enviada no aceite', async () => {
    const versao = constante(ler('../assets/checkout.js'), 'VERSAO_TERMOS');
    expect(ler('../termos.html')).toMatch(new RegExp(`id="termosVersao"[^>]*>Versão ${versao}\\b`));
  });

  test('CA15 checkout.html referencia checkout.js?v=9, checkout.css?v=5 e precos.js?v=26', async () => {
    const html = ler('../checkout.html');
    expect(html).toContain('assets/checkout.js?v=9');
    expect(html).toContain('assets/checkout.css?v=5');
    expect(html).toContain('assets/precos.js?v=26');
  });

  test('CA15 a CSP do checkout segue idêntica à anterior', async () => {
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/i.exec(ler('../checkout.html'))?.[1];
    expect(csp).toBe("default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; "
      + "connect-src 'self' https://viacep.com.br; object-src 'none'; base-uri 'none'; form-action 'self'");
  });
});
