// @ts-check
// CIT-70/CIT-71: mock de /api/painel/* para as specs de página (login e painel). Não é spec (não termina em .spec.js).
// Modo API = origem http://localhost:4200 (a mesma do Vite, presente em ORIGENS_API de login.js e painel.js);
// o modo local é o baseURL padrão do Playwright (127.0.0.1). Só dados fictícios.

/** baseURL do modo API: `test.use({ baseURL: BASE_API })`. */
export const BASE_API = 'http://localhost:4200/citmail/';
export const EMAIL = 'titular@exemplo.com.br';
export const SENHA = 'Senha-de-teste-123';
/** Quando definida, as specs rodam contra um site publicado (sem Vite em localhost:4200): os casos de modo API pulam. */
export const CONTRA_SITE_PUBLICADO = !!process.env.CITMAIL_BASE_URL;

/**
 * Estado vivo do mock: o teste pode trocar `sessao`, `login`, `logout`, `esqueci`, `validar` e `definir` no meio do caminho.
 * Cada campo é um status HTTP (204, 200, 401, 403, 503...) ou 'abort' (falha de rede).
 * @typedef {object} EstadoPainel
 * @property {number|'abort'} sessao   resposta de GET /api/painel/sessao (200 devolve { email })
 * @property {number|'abort'} login    resposta de POST /api/painel/login (204 passa a sessão para 200)
 * @property {number|'abort'} logout   resposta de POST /api/painel/logout (204 passa a sessão para 401)
 * @property {number|'abort'} esqueci  resposta de POST /api/painel/senha/esqueci (CIT-71; padrão 202, sem corpo)
 * @property {number|'abort'} validar  resposta de POST /api/painel/senha/validar (CIT-71; padrão 200 com { tipo })
 * @property {number|'abort'} definir  resposta de POST /api/painel/senha/definir (CIT-71; padrão 204)
 * @property {'primeiro_acesso'|'redefinicao'} tipo  tipo devolvido por `validar` em 200
 * @property {string} email            e-mail devolvido por GET /sessao
 * @property {number} [atrasoSessao]   atraso (ms) da resposta de GET /sessao, para o painel ter tempo de (não) pintar
 * @property {{ rota: string, metodo: string, corpo: any }[]} reqs  requisições recebidas, em ordem
 */

const CORPO_ERRO = {
  sessao: { 401: { erro: 'sem_sessao' }, 503: { erro: 'sessao_indisponivel' } },
  login: { 401: { erro: 'credenciais_invalidas' }, 403: { erro: 'origem_recusada' }, 503: { erro: 'sessao_indisponivel' } },
  logout: { 403: { erro: 'origem_recusada' }, 503: { erro: 'sessao_indisponivel' } },
  esqueci: { 400: { erro: 'requisicao_invalida' }, 403: { erro: 'origem_recusada' }, 503: { erro: 'sessao_indisponivel' } },
  validar: { 400: { erro: 'requisicao_invalida' }, 403: { erro: 'origem_recusada' }, 410: { erro: 'link_invalido' }, 503: { erro: 'sessao_indisponivel' } },
  definir: { 400: { erro: 'senha_fora_da_politica' }, 403: { erro: 'origem_recusada' }, 410: { erro: 'link_invalido' }, 503: { erro: 'sessao_indisponivel' } },
};

/** @param {any} route @param {number|'abort'} status @param {any} [corpo] */
function responder(route, status, corpo) {
  if (status === 'abort') return route.abort('failed');
  const headers = { 'cache-control': 'no-store' };
  if (status === 204 || status === 202) return route.fulfill({ status, headers });
  return route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(corpo ?? {}) });
}

/**
 * Registra o mock das rotas do painel e das de senha. Chamar antes do `goto`.
 * @param {import('@playwright/test').Page} page
 * @param {Partial<EstadoPainel>} [inicial]
 * @returns {Promise<EstadoPainel>}
 */
export async function mockarPainel(page, inicial = {}) {
  /** @type {EstadoPainel} */
  const estado = { sessao: 401, login: 401, logout: 204, esqueci: 202, validar: 200, definir: 204, tipo: 'primeiro_acesso', email: EMAIL, reqs: [], ...inicial };
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
  // CIT-71: o corpo de cada POST fica em estado.reqs (rota 'esqueci' | 'validar' | 'definir'); o token só aparece aí.
  await page.route('**/api/painel/senha/esqueci', route => {
    registrar('esqueci', route.request());
    return responder(route, estado.esqueci, CORPO_ERRO.esqueci[/** @type {number} */ (estado.esqueci)]);
  });
  await page.route('**/api/painel/senha/validar', route => {
    registrar('validar', route.request());
    if (estado.validar === 200) return responder(route, 200, { tipo: estado.tipo });
    return responder(route, estado.validar, CORPO_ERRO.validar[/** @type {number} */ (estado.validar)]);
  });
  await page.route('**/api/painel/senha/definir', route => {
    registrar('definir', route.request());
    return responder(route, estado.definir, CORPO_ERRO.definir[/** @type {number} */ (estado.definir)]);
  });
  return estado;
}

/** Quantas vezes a rota foi chamada. @param {EstadoPainel} estado @param {'sessao'|'login'|'logout'|'esqueci'|'validar'|'definir'} rota */
export const chamadas = (estado, rota) => estado.reqs.filter(r => r.rota === rota).length;

/**
 * Retira da fixture `erros` o que o próprio mock provoca em /api/painel/* (4xx/5xx e aborts), no padrão de
 * tests/pedido.spec.js (descartarStatus). Chamar no fim do teste.
 * @param {string[]} erros
 */
export function descartarPainel(erros) {
  for (let i = erros.length - 1; i >= 0; i--) {
    if (/\/api\/painel\/(sessao|login|logout|senha\/(esqueci|validar|definir))$/.test(erros[i].split(' ').slice(1).join(' '))) erros.splice(i, 1);
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
