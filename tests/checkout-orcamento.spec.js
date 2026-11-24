// @ts-check
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
// Só depende de tabela.js/servico.js da API; se passar a importar dependência da API, o job `playwright` do CI quebra.
import { criarCorpoOrcamento } from '../api/src/precos/rotas.js';

// CIT-176: checkout exibe o orçamento confirmado pela API (POST /api/orcamento).
// CA1 roda em 127.0.0.1 (baseURL padrão: origem fora do mapa, modo local); CA2-CA10 em localhost:4200
// (mesmo Vite, origem que está no mapa ORIGENS_API). A API é sempre mockada com page.route; dados fictícios.
// O relógio é instalado antes do goto e congelado: o debounce de 300 ms e o timeout de 8 s só andam por runFor.

const ORIGEM_API = { baseURL: 'http://localhost:4200/citmail/' };
const ROTA_API = /\/api\/orcamento$/;
const MSG_FALHA = 'Não foi possível confirmar o valor.';

/* ---------------- validador mínimo do schema do corpo (type, enum, min/max, required, additionalProperties) ---------------- */

/**
 * @param {any} schema
 * @param {any} valor
 * @param {string} caminho
 * @returns {string[]} problemas encontrados
 */
function validar(schema, valor, caminho = '$') {
  /** @type {string[]} */
  const problemas = [];
  if (schema.type === 'object') {
    if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return [`${caminho}: não é objeto`];
    for (const chave of schema.required ?? []) if (!(chave in valor)) problemas.push(`${caminho}.${chave}: ausente`);
    for (const [chave, v] of Object.entries(valor)) {
      if (schema.properties?.[chave]) problemas.push(...validar(schema.properties[chave], v, `${caminho}.${chave}`));
      else if (schema.additionalProperties === false) problemas.push(`${caminho}.${chave}: chave não permitida`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(valor)) return [`${caminho}: não é inteiro`];
    if (schema.minimum !== undefined && valor < schema.minimum) problemas.push(`${caminho}: abaixo do mínimo`);
    if (schema.maximum !== undefined && valor > schema.maximum) problemas.push(`${caminho}: acima do máximo`);
  } else if (schema.type === 'string') {
    if (typeof valor !== 'string') return [`${caminho}: não é string`];
    if (schema.minLength !== undefined && valor.length < schema.minLength) problemas.push(`${caminho}: curta demais`);
    if (schema.maxLength !== undefined && valor.length > schema.maxLength) problemas.push(`${caminho}: longa demais`);
  }
  if (schema.enum && !schema.enum.includes(valor)) problemas.push(`${caminho}: fora do enum`);
  return problemas;
}

const schemaCorpo = criarCorpoOrcamento();

/** Valida o corpo enviado pela página contra o schema real da API. */
function problemasDoCorpo(/** @type {any} */ corpo) { return validar(schemaCorpo, corpo); }

/* ---------------- mock da API ---------------- */

/**
 * Resposta 200 de /api/orcamento coerente com o corpo recebido.
 * @param {any} corpo
 * @param {{ mensal?: number, cicloMensal?: number, cicloAnual?: number, avulso?: number, economia?: number,
 *   versao?: string, descontos?: { rotulo: string, valor_centavos: number }[], avulsos?: any[] }} [o]
 */
function orcamento(corpo, o = {}) {
  const mensal = o.mensal ?? 12345;
  const economia = o.economia ?? 2000;
  const avulso = o.avulso ?? 0;
  const ciclo = corpo.ciclo === 'anual' ? (o.cicloAnual ?? mensal * 12) : (o.cicloMensal ?? mensal);
  const descontos = o.descontos ?? [];
  const totalDesc = descontos.reduce((s, d) => s + d.valor_centavos, 0);
  const itens = Object.entries(corpo.contas ?? {})
    .filter(([, q]) => /** @type {number} */ (q) > 0)
    .map(([chave, q], i) => {
      const quantidade = /** @type {number} */ (q);
      const subtotal = i === 0 ? mensal : 0;
      const atual = subtotal + (i === 0 ? totalDesc : 0);
      return {
        tipo: 'conta', chave, quantidade,
        unit_atual_centavos: Math.floor(atual / quantidade), unit_tabela_centavos: Math.floor(atual / quantidade),
        unit_cobrado_centavos: Math.floor(subtotal / quantidade),
        tabela_centavos: atual, atual_centavos: atual, subtotal_centavos: subtotal,
        descontos: i === 0 ? descontos : [],
      };
    });
  return {
    versao_tabela: o.versao ?? '2026-01-01.1',
    ciclo: corpo.ciclo,
    itens,
    avulsos: o.avulsos ?? (avulso > 0
      ? [{ tipo: 'dominio_principal', quantidade: 1, periodo: 'ano', unit_centavos: avulso, subtotal_centavos: avulso }]
      : []),
    totais: {
      recorrente_mensal_centavos: mensal,
      recorrente_ciclo_centavos: ciclo,
      tabela_mensal_centavos: mensal + economia,
      economia_mensal_centavos: economia,
      avulso_centavos: avulso,
    },
  };
}

/** @param {any} route @param {any} corpo @param {Parameters<typeof orcamento>[1]} [o] */
function responder200(route, corpo, o) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(orcamento(corpo, o)) });
}

/** @param {any} route @param {string} campo */
function responder400(route, campo) {
  return route.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ erro: 'validacao', campos: [{ campo, mensagem: 'fora do limite' }] }),
  });
}

/**
 * Descarta de `erros` só as entradas de /api/orcamento esperadas no caso (status "500" ou erro de rede "ERR_ABORTED").
 * @param {string[]} erros
 * @param {...string} tipos
 */
function descartar(erros, ...tipos) {
  for (let i = erros.length - 1; i >= 0; i--) {
    const e = erros[i];
    const [prefixo, url] = [e.split(' ')[0], e.split(' ').slice(1).join(' ')];
    if (ROTA_API.test(url) && tipos.some(t => prefixo === t || prefixo === `net::${t}`)) erros.splice(i, 1);
  }
}

/**
 * Instala o relógio, registra os mocks e abre o checkout (relógio congelado logo após o carregamento).
 * `responder(route, corpo, n)` recebe o corpo JSON do POST e o número da chamada (1, 2, …).
 * @param {import('@playwright/test').Page} page
 * @param {(route: any, corpo: any, n: number) => any} responder
 */
async function abrir(page, responder) {
  /** @type {import('@playwright/test').Request[]} */
  const posts = [];
  let n = 0;
  page.on('request', req => { if (req.method() === 'POST' && ROTA_API.test(new URL(req.url()).pathname)) posts.push(req); });
  await page.route('**/viacep.com.br/**', route => route.fulfill({ json: { erro: true } }));
  await page.route('**/api/orcamento', route => {
    n += 1;
    return responder(route, route.request().postDataJSON(), n);
  });
  await page.clock.install();
  await page.goto('checkout.html');
  await page.clock.pauseAt(new Date(Date.now() + 5000));
  return { posts };
}

/** Deixa passar o debounce (e uma segunda janela, para a nova tentativa automática, se houver). */
async function debounce(/** @type {import('@playwright/test').Page} */ page, vezes = 1) {
  for (let i = 0; i < vezes; i++) await page.clock.runFor(300);
}

const mais25 = (/** @type {import('@playwright/test').Page} */ page) =>
  page.locator('button[data-qtd-conta="25gb"][data-qtd-delta="1"]').click();
const menos25 = (/** @type {import('@playwright/test').Page} */ page) =>
  page.locator('button[data-qtd-conta="25gb"][data-qtd-delta="-1"]').click();

/** Vai ao passo 4 (cadastro) e preenche com dados fictícios válidos, sem enviar. */
async function preencherCadastro(/** @type {import('@playwright/test').Page} */ page) {
  await page.evaluate(() => goStep(4));
  await page.locator('#fNome').fill('Maria Ficticia');
  await page.locator('#fEmail').fill('maria@exemplo.test');
  await page.locator('#fTelefone').fill('11999990000');
  await page.locator('#fCPF').fill('12345678901');
  await page.locator('#fCEP').fill('01001000');
  // clique direto no input: o clique por coordenada pode cair em elemento sobreposto durante o re-render (CI com vários workers)
  await page.locator('#termsCheck').evaluate(el => { if (!el.checked) el.click(); });
}

/* ---------------- auto-teste do validador ---------------- */

test.describe('checkout-orcamento — validador do schema do corpo', { tag: '@CIT-176' }, () => {
  test('CA2 o validador aceita corpo válido e recusa chave extra, ciclo fora do enum, obrigatório ausente e acima do limite', async () => {
    expect(problemasDoCorpo({ ciclo: 'mensal', contas: { '25gb': 2 } })).toEqual([]);
    expect(problemasDoCorpo({ ciclo: 'mensal', contas: { '25gb': 2 }, extra: 1 })).not.toEqual([]);
    expect(problemasDoCorpo({ ciclo: 'semanal', contas: { '25gb': 2 } })).not.toEqual([]);
    expect(problemasDoCorpo({ contas: { '25gb': 2 } })).not.toEqual([]);
    expect(problemasDoCorpo({ ciclo: 'mensal', contas: { '25gb': 501 } })).not.toEqual([]);
    expect(problemasDoCorpo({ ciclo: 'mensal', contas: { '25gb': 1 }, dominio: { tipo: 'outro' } })).not.toEqual([]);
  });
});

/* ---------------- CA1: API não configurada (127.0.0.1) ---------------- */

test.describe('checkout-orcamento — CA1: origem fora do mapa (modo local)', { tag: '@CIT-176' }, () => {
  test('CA1 em 127.0.0.1 o resumo é local, sem requisição à API, e o fluxo avança até o passo 5', async ({ page, erros }) => {
    /** @type {string[]} */
    const requisicoesApi = [];
    page.on('request', req => { if (req.url().includes('/api/')) requisicoesApi.push(req.url()); });
    await page.route('**/viacep.com.br/**', route => route.fulfill({ json: { erro: true } }));
    await page.goto('checkout.html');

    await mais25(page);
    await mais25(page);
    await page.waitForTimeout(1000);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 32,00');
    await expect(page.locator('#sumPeriod')).toHaveText('/mês');
    await expect(page.locator('#orcamentoEstado')).toBeHidden();

    await page.locator('#cycleToggle').click();
    await expect(page.locator('#sumTotal')).toHaveText('R$ 25,60');
    await expect(page.locator('#sumPeriod')).toContainText('R$ 307,20/ano');

    await preencherCadastro(page);
    await page.locator('#btnSubmitCadastro').click();
    await expect(page.locator('#step5')).toHaveClass(/active/);
    await page.waitForTimeout(500);
    expect(requisicoesApi, 'nenhuma requisição com /api/ na URL').toEqual([]);
  });
});

/* ---------------- CA2: orçamento confirmado ---------------- */

test.describe('checkout-orcamento — CA2: orçamento confirmado', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  test('CA2 cinco mudanças em menos de 300 ms geram um único POST válido e o resumo mostra o valor do servidor', async ({ page, erros }) => {
    const { posts } = await abrir(page, (route, corpo) => responder200(route, corpo, {
      mensal: 12345, cicloMensal: 12345, avulso: 0, economia: 2000, cicloAnual: 148140,
    }));

    await mais25(page);
    await mais25(page);
    await page.locator('#cycleToggle').click();
    await page.locator('#cycleToggle').click();
    await mais25(page);
    expect(posts.length, 'nada enviado antes do debounce').toBe(0);

    await debounce(page);
    await expect.poll(() => posts.length).toBe(1);
    await page.clock.runFor(1000);
    expect(posts.length, 'exatamente 1 POST').toBe(1);

    const req = posts[0];
    expect(req.headers()['content-type']).toContain('application/json');
    expect(Object.keys(req.headers())).not.toContain('cookie');
    const corpo = req.postDataJSON();
    expect(problemasDoCorpo(corpo)).toEqual([]);
    expect(corpo.ciclo).toBe('mensal');
    expect(corpo.contas['25gb']).toBe(3);

    await expect(page.locator('#sumTotal')).toHaveText('R$ 123,45');
    await expect(page.locator('#sumEconomia')).toContainText('R$ 20,00');
    await expect(page.locator('#sumAccountLines')).toContainText('R$ 123,45');
    descartar(erros, 'ERR_ABORTED');
  });

  test('CA2 no passo 5 a revisão usa o total do pedido confirmado pelo servidor', async ({ page, erros }) => {
    await abrir(page, (route, corpo) => responder200(route, corpo, { mensal: 12345, cicloMensal: 12345, avulso: 0 }));
    await mais25(page);
    await debounce(page);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 123,45');

    await preencherCadastro(page);
    await page.locator('#btnSubmitCadastro').click();
    await expect(page.locator('#step5')).toHaveClass(/active/);
    await expect(page.locator('#orderSummary')).toHaveAttribute('data-total-confirmado', '12345');
    descartar(erros, 'ERR_ABORTED');
  });

  test('CA2 no anual o período mostra o valor do ciclo confirmado pelo servidor', async ({ page, erros }) => {
    await abrir(page, (route, corpo) => responder200(route, corpo, { mensal: 12345, cicloAnual: 148140, economia: 2000 }));
    await mais25(page);
    await page.locator('#cycleToggle').click();
    await debounce(page);
    await expect(page.locator('#sumPeriod')).toContainText('R$ 1.481,40/ano');
    descartar(erros, 'ERR_ABORTED');
  });
});

/* ---------------- CA3: pendente ---------------- */

test.describe('checkout-orcamento — CA3: estado pendente', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  test('CA3 pendente marca aria-busy, mostra o valor local, bloqueia o avanço e libera quando a resposta chega', async ({ page, erros }) => {
    /** @type {() => void} */
    let liberar = () => {};
    const gate = new Promise(resolve => { liberar = () => resolve(undefined); });
    const { posts } = await abrir(page, async (route, corpo) => {
      await gate;
      await responder200(route, corpo, { mensal: 9990, cicloMensal: 9990, avulso: 7900, economia: 0 });
    });
    const busy = [page.locator('#sumAccountLines'), page.locator('#summaryTotal')];

    await mais25(page);
    for (const el of busy) await expect(el).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#orcamentoStatus')).toHaveText('Confirmando o valor…');
    await expect(page.locator('#sumTotal')).toHaveText('R$ 16,00');

    await preencherCadastro(page);
    await page.locator('#btnSubmitCadastro').click();
    await expect(page.locator('#step5')).not.toHaveClass(/active/);

    await debounce(page);
    await expect.poll(() => posts.length).toBe(1);
    for (const el of busy) await expect(el).toHaveAttribute('aria-busy', 'true');
    await page.locator('#btnSubmitCadastro').click();
    await expect(page.locator('#step5')).not.toHaveClass(/active/);

    liberar();
    for (const el of busy) await expect(el).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#sumTotal')).toHaveText('R$ 99,90');
    await page.locator('#btnSubmitCadastro').click();
    await expect(page.locator('#step5')).toHaveClass(/active/);
    await expect(page.locator('#orderSummary')).toHaveAttribute('data-total-confirmado', '17890');
    descartar(erros, 'ERR_ABORTED');
  });
});

/* ---------------- CA2/CA3 (novos): avulsos no resumo e troca de plano do Skybox ---------------- */

test.describe('checkout-orcamento — avulsos e Skybox', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  test('CA2 os avulsos da resposta viram linhas "×N … R$ X/ano" no resumo, com o nome de cada domínio', async ({ page, erros }) => {
    await abrir(page, (route, corpo) => responder200(route, corpo, {
      mensal: 12345,
      avulsos: [
        { tipo: 'dominio_principal', quantidade: 1, periodo: 'ano', unit_centavos: 7900, subtotal_centavos: 7900 },
        { tipo: 'dominio_extra', quantidade: 2, periodo: 'ano', unit_centavos: 7900, subtotal_centavos: 15800 },
      ],
    }));
    await mais25(page);
    await debounce(page);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 123,45');
    const linhas = page.locator('#sumAccountLines .sum-line');
    await expect(linhas.filter({ hasText: 'Domínio .com.br' })).toContainText(['×1', 'R$ 79,00/ano'].join(''));
    await expect(linhas.filter({ hasText: 'Domínio extra' })).toContainText(['×2', 'R$ 158,00/ano'].join(''));
    descartar(erros, 'ERR_ABORTED');
  });

  test('CA3 trocar o plano do Skybox com quantidade maior que zero volta ao pendente e gera um novo POST', async ({ page, erros }) => {
    const { posts } = await abrir(page, (route, corpo) => responder200(route, corpo, { mensal: 12345 }));
    await page.evaluate(() => { ckChangeQty('25gb', 1); selectSkybox('50gb'); addonChange('skybox', 1); });
    await debounce(page);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].postDataJSON().addons.skybox).toEqual({ plano: '50gb', quantidade: 1 });
    await expect(page.locator('#orderSummary')).toHaveAttribute('data-total-confirmado', '12345');

    await page.evaluate(() => selectSkybox('100gb')); // o clique em #skyOpt100 chama esta função; a seção fica recolhida
    await expect(page.locator('#orcamentoStatus')).toHaveText('Confirmando o valor…');
    await expect(page.locator('#orderSummary')).not.toHaveAttribute('data-total-confirmado', /.*/);
    await debounce(page);
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1].postDataJSON().addons.skybox).toEqual({ plano: '100gb', quantidade: 1 });
    await expect(page.locator('#orderSummary')).toHaveAttribute('data-total-confirmado', '12345');
    descartar(erros, 'ERR_ABORTED');
  });
});

/* ---------------- CA4: falhas ---------------- */

/** @type {{ nome: string, modo: (route: any, corpo?: any) => any, descarta: string[], avancaRelogio?: number }[]} */
const FALHAS = [
  { nome: 'requisição abortada', modo: route => route.abort(), descarta: ['ERR_FAILED'] },
  { nome: 'resposta 500', modo: route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"erro":"interno"}' }), descarta: ['500'] },
  { nome: 'resposta 429', modo: route => route.fulfill({ status: 429, contentType: 'application/json', body: '{"erro":"limite"}' }), descarta: ['429'] },
  { nome: '200 malformado', modo: route => route.fulfill({ status: 200, contentType: 'application/json', body: '{ "totais": {} }' }), descarta: [] },
  { nome: 'avulso de tipo desconhecido', modo: (route, corpo) => responder200(route, corpo, { avulsos: [{ tipo: 'dominio_desconhecido', quantidade: 1, periodo: 'ano', unit_centavos: 100, subtotal_centavos: 100 }] }), descarta: [] },
  { nome: 'sem resposta por 8 s', modo: () => new Promise(() => {}), descarta: ['ERR_ABORTED', 'ERR_FAILED'], avancaRelogio: 8000 },
];

test.describe('checkout-orcamento — CA4: falha ao confirmar o valor', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  for (const falha of FALHAS) {
    test(`CA4 ${falha.nome}: mostra o alerta, bloqueia o avanço e o "Tentar novamente" recupera`, async ({ page, erros }) => {
      let falhando = true;
      const { posts } = await abrir(page, (route, corpo) => (falhando
        ? falha.modo(route, corpo)
        : responder200(route, corpo, { mensal: 12345, cicloMensal: 12345, economia: 2000 })));

      await mais25(page);
      await debounce(page);
      if (falha.avancaRelogio) await page.clock.runFor(falha.avancaRelogio);

      const alerta = page.locator('#orcamentoAlerta');
      await expect(alerta).toBeVisible();
      await expect(alerta).toHaveAttribute('role', 'alert');
      await expect(page.locator('#orcamentoAlertaTexto')).toHaveText(MSG_FALHA);
      const retry = page.getByRole('button', { name: 'Tentar novamente' });
      await expect(retry).toBeVisible();

      await preencherCadastro(page);
      await page.locator('#btnSubmitCadastro').click();
      await debounce(page);
      await expect(page.locator('#step5')).not.toHaveClass(/active/);

      falhando = false;
      const antes = posts.length;
      await retry.click();
      await debounce(page);
      await expect.poll(() => posts.length).toBe(antes + 1);
      await expect(alerta).toBeHidden();
      await expect(page.locator('#sumTotal')).toHaveText('R$ 123,45');
      await page.locator('#btnSubmitCadastro').click();
      await expect(page.locator('#step5')).toHaveClass(/active/);
      descartar(erros, ...falha.descarta, 'ERR_ABORTED');
    });
  }
});

/* ---------------- CA5: respostas fora de ordem ---------------- */

test.describe('checkout-orcamento — CA5: resposta fora de ordem', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  test('CA5 a resposta da 1ª requisição, que chega depois da 2ª, não sobrescreve o valor mais recente', async ({ page, erros }) => {
    /** @type {() => void} */
    let liberar1 = () => {};
    const gate1 = new Promise(resolve => { liberar1 = () => resolve(undefined); });
    /** @type {() => void} */
    let liberar2 = () => {};
    const gate2 = new Promise(resolve => { liberar2 = () => resolve(undefined); });
    const { posts } = await abrir(page, async (route, corpo, n) => {
      if (n === 1) {
        await gate1;
        // pode já ter sido abortada pela página: não é erro do teste
        await responder200(route, corpo, { mensal: 11111, cicloMensal: 11111 }).catch(() => {});
        return;
      }
      await gate2;
      await responder200(route, corpo, { mensal: 22222, cicloMensal: 22222 });
    });

    await mais25(page);
    await debounce(page);
    await expect.poll(() => posts.length).toBe(1);
    await mais25(page);
    // a mudança aborta a 1ª requisição: o abort não pode aparecer como falha
    await page.waitForTimeout(300);
    await expect(page.locator('#orcamentoAlerta')).toBeHidden();
    await debounce(page);
    await expect.poll(() => posts.length).toBe(2);
    // a 1ª foi abortada pela 2ª: o abort não pode virar falha nem sobrescrever o pendente da 2ª
    await page.waitForTimeout(300);
    await expect(page.locator('#orcamentoAlerta')).toBeHidden();
    await expect(page.locator('#sumAccountLines')).toHaveAttribute('aria-busy', 'true');

    liberar1();
    await page.waitForTimeout(300);
    await expect(page.locator('#orcamentoAlerta')).toBeHidden();
    liberar2();
    await expect(page.locator('#sumTotal')).toHaveText('R$ 222,22');
    await page.waitForTimeout(300);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 222,22');
    descartar(erros, 'ERR_ABORTED');
  });
});

/* ---------------- CA6: 400 validacao ---------------- */

/**
 * Deixa 2 contas de 25 GB já confirmadas por um 200 (POST nº 1); o POST nº 2 em diante responde conforme `responderMudanca`.
 * A página envia o estado (ckQtys/addonQtys), já limitado no cliente: para provocar o 400, o teste força um valor fora
 * do limite direto no estado e dispara uma mudança que não passa por ajustarAddonsAoTeto (alternar o ciclo).
 * @param {import('@playwright/test').Page} page
 * @param {(route: any, corpo: any, n: number) => any} responderMudanca
 */
async function prepararDuasContas(page, responderMudanca) {
  const { posts } = await abrir(page, (route, corpo, n) => (n === 1
    ? responder200(route, corpo, { mensal: 11111, cicloMensal: 11111 })
    : responderMudanca(route, corpo, n)));
  await page.evaluate(() => ckChangeQty('25gb', 2));
  await debounce(page);
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.locator('#sumTotal')).toHaveText('R$ 111,11');
  return posts;
}

/** Digita no campo como o usuário (evento input), o que limpa aria-invalid. */
async function digitar(/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ seletor, /** @type {string} */ valor) {
  await page.locator(seletor).evaluate((el, v) => {
    /** @type {HTMLInputElement} */ (el).value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, valor);
}

test.describe('checkout-orcamento — CA6: 400 de validação', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  test('CA6a 400 em addons.talk leva o Talk ao teto, marca aria-invalid e reenvia uma vez com sucesso', async ({ page, erros }) => {
    const posts = await prepararDuasContas(page, (route, corpo, n) => (n === 2
      ? responder400(route, 'addons.talk')
      : responder200(route, corpo, { mensal: 33333, cicloMensal: 33333 })));
    await page.evaluate(() => { addonQtys.talk = 3; });

    await page.locator('#cycleToggle').click();
    await debounce(page, 2);
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[1].postDataJSON().addons.talk, 'o 2º POST leva Talk acima do teto').toBe(3);
    expect(posts[2].postDataJSON().addons.talk, 'a nova tentativa leva o teto').toBe(2);
    await expect(page.locator('#aqTalk')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#aqTalk')).toHaveValue('2');
    await expect(page.locator('#sumTotal')).toHaveText('R$ 333,33');

    await mais25(page);
    await debounce(page, 2);
    await expect(page.locator('#aqTalk'), 'a re-renderização não limpa aria-invalid').toHaveAttribute('aria-invalid', 'true');
    await digitar(page, '#aqTalk', '1');
    await expect(page.locator('#aqTalk')).not.toHaveAttribute('aria-invalid', 'true');
    descartar(erros, '400', 'ERR_ABORTED');
  });

  test('CA6b 400 em contas.25gb normaliza a quantidade dentro de PRECOS.limites, marca aria-invalid e reenvia uma vez', async ({ page, erros }) => {
    const posts = await prepararDuasContas(page, (route, corpo, n) => (n === 2
      ? responder400(route, 'contas.25gb')
      : responder200(route, corpo, { mensal: 33333, cicloMensal: 33333 })));
    await page.evaluate(() => { ckQtys['25gb'] = 9999; });

    await page.locator('#cycleToggle').click();
    await debounce(page, 2);
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[1].postDataJSON().contas['25gb'], 'o 2º POST leva a quantidade acima do limite').toBe(9999);
    await expect(page.locator('#ckQty25')).toHaveAttribute('aria-invalid', 'true');
    const max = await page.evaluate(() => PRECOS.limites.contasPorTipo);
    const qtd = Number(await page.locator('#ckQty25').inputValue());
    expect(qtd).toBeGreaterThanOrEqual(1);
    expect(qtd).toBeLessThanOrEqual(max);
    expect(posts[2].postDataJSON().contas['25gb']).toBe(qtd);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 333,33');

    await digitar(page, '#ckQty25', '2');
    await expect(page.locator('#ckQty25')).not.toHaveAttribute('aria-invalid', 'true');
    descartar(erros, '400', 'ERR_ABORTED');
  });

  test('CA6c 400 também na nova tentativa vira falha genérica com 2 POSTs no total e sem laço', async ({ page, erros }) => {
    const posts = await prepararDuasContas(page, route => responder400(route, 'addons.talk'));
    await page.evaluate(() => { addonQtys.talk = 3; });
    const antes = posts.length;

    await page.locator('#cycleToggle').click();
    await debounce(page, 2);
    await expect(page.locator('#orcamentoAlerta')).toBeVisible();
    await page.clock.runFor(2000);
    expect(posts.length - antes, '2 POSTs após a mudança, nenhum 3º').toBe(2);
    descartar(erros, '400', 'ERR_ABORTED');
  });

  test('CA6d 400 num campo que já está no limite vira falha genérica com 1 POST só', async ({ page, erros }) => {
    const posts = await prepararDuasContas(page, route => responder400(route, 'addons.talk'));
    const antes = posts.length;
    await page.evaluate(() => addonChange('talk', 2)); // Talk = 2 com 2 contas: já está no teto
    await debounce(page, 2);
    await expect(page.locator('#orcamentoAlerta')).toBeVisible();
    await page.clock.runFor(2000);
    expect(posts.length - antes, 'só 1 POST após a mudança').toBe(1);
    await expect(page.locator('#aqTalk')).toHaveAttribute('aria-invalid', 'true');
    descartar(erros, '400', 'ERR_ABORTED');
  });
});

/* ---------------- CA7: CSP (também coberto por tests/csp.spec.js, sem mudança) ---------------- */

test.describe('checkout-orcamento — CA7: CSP inalterada', { tag: '@CIT-176' }, () => {
  test('CA7 a CSP do checkout não tem curinga e o connect-src segue só com self e ViaCEP', async () => {
    const html = readFileSync(new URL('../checkout.html', import.meta.url), 'utf8');
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)?.[1] ?? '';
    expect(csp).not.toBe('');
    expect(csp).not.toMatch(/\*/);
    expect(csp).toMatch(/connect-src 'self' https:\/\/viacep\.com\.br(;|$)/);
  });
});

/* ---------------- CA8: orçamento guardado ---------------- */

test.describe('checkout-orcamento — CA8: orçamento guardado', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  test('CA8 o total e a versão confirmados vão para data-* e somem na mudança seguinte, antes da nova resposta', async ({ page, erros }) => {
    /** @type {() => void} */
    let liberar = () => {};
    const gate = new Promise(resolve => { liberar = () => resolve(undefined); });
    const { posts } = await abrir(page, async (route, corpo, n) => {
      if (n === 2) await gate;
      await responder200(route, corpo, { mensal: 12345, cicloMensal: 12345, avulso: 4000, versao: '2099-01-01.1' }).catch(() => {});
    });
    const resumo = page.locator('#orderSummary');

    await mais25(page);
    await page.locator('#btnStep1Next').click();
    await page.locator('#doptBr').click();
    await debounce(page);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].postDataJSON().dominio).toEqual({ tipo: 'novo' });
    await expect(resumo).toHaveAttribute('data-total-confirmado', '16345');
    await expect(resumo).toHaveAttribute('data-versao-tabela', '2099-01-01.1');

    await page.evaluate(() => ckChangeQty('25gb', 1));
    await expect(resumo).not.toHaveAttribute('data-total-confirmado', /.*/);
    await expect(resumo).not.toHaveAttribute('data-versao-tabela', /.*/);
    liberar();
    descartar(erros, 'ERR_ABORTED');
  });
});

/* ---------------- CA9: segurança do DOM ---------------- */

test.describe('checkout-orcamento — CA9: dado da resposta entra como texto', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  test('CA9 rótulo de desconto com HTML aparece literal, sem criar elemento nem diálogo', async ({ page, erros }) => {
    const rotulo = '<img src=x onerror=alert(1)>';
    /** @type {string[]} */
    const dialogos = [];
    page.on('dialog', d => { dialogos.push(d.message()); d.dismiss().catch(() => {}); });
    await abrir(page, (route, corpo) => responder200(route, corpo, {
      mensal: 12345, descontos: [{ rotulo, valor_centavos: 500 }],
    }));

    await mais25(page);
    await debounce(page);
    await expect(page.locator('#sumTotal')).toHaveText('R$ 123,45');
    await expect(page.locator('#sumAccountLines')).toContainText(rotulo);
    await expect(page.locator('#sumAccountLines img')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(dialogos).toEqual([]);
    descartar(erros, 'ERR_ABORTED');
  });
});

/* ---------------- CA10: mobile ---------------- */

test.describe('checkout-orcamento — CA10: falha legível em 320, 375 e 1280 px', { tag: '@CIT-176' }, () => {
  test.use(ORIGEM_API);

  for (const largura of [320, 375, 1280]) {
    test(`CA10 em ${largura} px o alerta e o botão cabem, sem rolagem horizontal, e o clique bloqueado traz o alerta à tela`, async ({ page, erros }, testInfo) => {
      await page.setViewportSize({ width: largura, height: largura === 1280 ? 800 : 700 });
      await abrir(page, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"erro":"interno"}' }));

      await mais25(page);
      await page.screenshot({ path: testInfo.outputPath(`pendente-${largura}.png`), fullPage: true });
      await debounce(page);

      const alerta = page.locator('#orcamentoAlerta');
      const retry = page.locator('#btnOrcamentoRetry');
      await expect(alerta).toBeVisible();
      await expect(retry).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`falha-${largura}.png`), fullPage: true });

      const medidas = await page.evaluate(() => ({ rolagem: document.documentElement.scrollWidth, largura: window.innerWidth }));
      expect(medidas.rolagem, 'sem rolagem horizontal').toBeLessThanOrEqual(medidas.largura);
      const caixa = await alerta.boundingBox();
      expect(caixa).not.toBeNull();
      expect(caixa.x).toBeGreaterThanOrEqual(0);
      expect(caixa.x + caixa.width).toBeLessThanOrEqual(medidas.largura);
      const botao = await retry.boundingBox();
      expect(botao).not.toBeNull();
      expect(botao.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator('#orderSummary > .card').locator('#orcamentoAlerta')).toBeVisible();

      await preencherCadastro(page);
      await page.locator('#btnSubmitCadastro').click();
      await page.clock.runFor(1000); // rolagem suave depende do relógio da página
      await expect(page.locator('#step5')).not.toHaveClass(/active/);
      await expect(alerta).toBeInViewport();
      descartar(erros, '500', 'ERR_ABORTED');
    });
  }
});

/* ---------------- CA11: sem regressão (estático; as specs existentes rodam à parte) ---------------- */

test.describe('checkout-orcamento — CA11: versões dos recursos', { tag: '@CIT-176' }, () => {
  test('CA11 checkout.html referencia checkout.js?v=9 e checkout.css?v=5', async () => {
    const html = readFileSync(new URL('../checkout.html', import.meta.url), 'utf8');
    expect(html).toContain('assets/checkout.js?v=9');
    expect(html).toContain('assets/checkout.css?v=5');
  });
});
