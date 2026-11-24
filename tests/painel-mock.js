// @ts-check
// CIT-70: mock de /api/painel/* para as specs de página (login e painel). Não é spec (não termina em .spec.js).
// Modo API = origem http://localhost:4200 (a mesma do Vite, presente em ORIGENS_API de login.js e painel.js);
// o modo local é o baseURL padrão do Playwright (127.0.0.1). Só dados fictícios.

/** baseURL do modo API: `test.use({ baseURL: BASE_API })`. */
export const BASE_API = 'http://localhost:4200/citmail/';
export const EMAIL = 'titular@exemplo.com.br';
export const SENHA = 'Senha-de-teste-123';
/** Quando definida, as specs rodam contra um site publicado (sem Vite em localhost:4200): os casos de modo API pulam. */
export const CONTRA_SITE_PUBLICADO = !!process.env.CITMAIL_BASE_URL;

/**
 * Estado vivo do mock: o teste pode trocar `sessao`, `login` e `logout` no meio do caminho.
 * Cada campo é um status HTTP (204, 200, 401, 403, 503...) ou 'abort' (falha de rede).
 * @typedef {object} EstadoPainel
 * @property {number|'abort'} sessao   resposta de GET /api/painel/sessao (200 devolve { email })
 * @property {number|'abort'} login    resposta de POST /api/painel/login (204 passa a sessão para 200)
 * @property {number|'abort'} logout   resposta de POST /api/painel/logout (204 passa a sessão para 401)
 * @property {string} email            e-mail devolvido por GET /sessao
 * @property {number} [atrasoSessao]   atraso (ms) da resposta de GET /sessao, para o painel ter tempo de (não) pintar
 * @property {{ rota: string, metodo: string, corpo: any }[]} reqs  requisições recebidas, em ordem
 */

const CORPO_ERRO = {
  sessao: { 401: { erro: 'sem_sessao' }, 503: { erro: 'sessao_indisponivel' } },
  login: { 401: { erro: 'credenciais_invalidas' }, 403: { erro: 'origem_recusada' }, 503: { erro: 'sessao_indisponivel' } },
  logout: { 403: { erro: 'origem_recusada' }, 503: { erro: 'sessao_indisponivel' } },
};

/** @param {any} route @param {number|'abort'} status @param {any} [corpo] */
function responder(route, status, corpo) {
  if (status === 'abort') return route.abort('failed');
  const headers = { 'cache-control': 'no-store' };
  if (status === 204) return route.fulfill({ status, headers });
  return route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(corpo ?? {}) });
}

/**
 * Registra o mock das três rotas. Chamar antes do `goto`.
 * @param {import('@playwright/test').Page} page
 * @param {Partial<EstadoPainel>} [inicial]
 * @returns {Promise<EstadoPainel>}
 */
export async function mockarPainel(page, inicial = {}) {
  /** @type {EstadoPainel} */
  const estado = { sessao: 401, login: 401, logout: 204, email: EMAIL, reqs: [], ...inicial };
  const registrar = (rota, req) => {
    let corpo = null;
    try { corpo = req.postDataJSON(); } catch { /* sem corpo JSON */ }
    estado.reqs.push({ rota, metodo: req.method(), corpo });
  };

  await page.route('**/api/painel/sessao', async route => {
    registrar('sessao', route.request());
    if (estado.atrasoSessao) await new Promise(resolve => setTimeout(resolve, estado.atrasoSessao));
    if (estado.sessao === 200) return responder(route, 200, { email: estado.email });
    return responder(route, estado.sessao, CORPO_ERRO.sessao[/** @type {number} */ (estado.sessao)]);
  });
  await page.route('**/api/painel/login', route => {
    registrar('login', route.request());
    if (estado.login === 204) estado.sessao = 200;
    return responder(route, estado.login, CORPO_ERRO.login[/** @type {number} */ (estado.login)]);
  });
  await page.route('**/api/painel/logout', route => {
    registrar('logout', route.request());
    if (estado.logout === 204) estado.sessao = 401;
    return responder(route, estado.logout, CORPO_ERRO.logout[/** @type {number} */ (estado.logout)]);
  });
  return estado;
}

/** Quantas vezes a rota foi chamada. @param {EstadoPainel} estado @param {'sessao'|'login'|'logout'} rota */
export const chamadas = (estado, rota) => estado.reqs.filter(r => r.rota === rota).length;

/**
 * Retira da fixture `erros` o que o próprio mock provoca em /api/painel/* (4xx/5xx e aborts), no padrão de
 * tests/pedido.spec.js (descartarStatus). Chamar no fim do teste.
 * @param {string[]} erros
 */
export function descartarPainel(erros) {
  for (let i = erros.length - 1; i >= 0; i--) {
    if (/\/api\/painel\/(sessao|login|logout)$/.test(erros[i].split(' ').slice(1).join(' '))) erros.splice(i, 1);
  }
}

/** No perfil mobile o menu lateral fica fora da tela: abre-o antes de usar um item dele. @param {import('@playwright/test').Page} page */
export async function abrirMenuSeMobile(page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.locator('#sidebarToggle').click();
}

/**
 * Observador de `.app` visível em painel.html, em qualquer documento carregado depois (sobrevive a navegações):
 * cada vez que o DOM muda e `.app` está visível, chama window.__appVisivel(e-mail mostrado). Chamar antes do goto.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<(string|null)[]>} lista viva dos e-mails vistos com `.app` visível
 */
export async function observarAppVisivel(page) {
  /** @type {(string|null)[]} */
  const vistos = [];
  await page.exposeFunction('__appVisivel', (/** @type {string|null} */ email) => { vistos.push(email); });
  await page.addInitScript(() => {
    if (!location.pathname.endsWith('/painel.html')) return;
    const checar = () => {
      const app = document.querySelector('.app');
      if (!app) return;
      // antes de assets/painel.css carregar, .app ainda não tem o display:none da classe sessao-pendente (falso positivo)
      if (![...document.styleSheets].some(f => f.href && f.href.includes('/painel.css'))) return;
      const cs = getComputedStyle(app);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') {
        // @ts-ignore
        window.__appVisivel(document.getElementById('painelEmail')?.textContent || '');
      }
    };
    new MutationObserver(checar).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
    document.addEventListener('DOMContentLoaded', checar);
    window.addEventListener('load', checar);
    window.addEventListener('pageshow', checar);
    // quadro a quadro durante a carga: pega o painel pintado antes de qualquer mutação do DOM
    const fim = Date.now() + 3000;
    const quadro = () => { checar(); if (Date.now() < fim) requestAnimationFrame(quadro); };
    requestAnimationFrame(quadro);
  });
  return vistos;
}
