/* ── SESSÃO (ADR 0008; CIT-70) ── */
// Origem da página → origem da API. Cópia de assets/checkout.js (paridade por teste): as cópias mudam juntas, e com o
// connect-src da CSP (#57). Fora do mapa (Pages, homologação, 127.0.0.1) o painel volta ao login sem pintar nada.
const ORIGENS_API = Object.freeze({ 'http://localhost:4200': 'http://localhost:4200' });
const SESSAO_TIMEOUT_MS = 15000;

function origemApi() {
  return Object.prototype.hasOwnProperty.call(ORIGENS_API, location.origin) ? ORIGENS_API[location.origin] : null;
}

const origem = origemApi();
if (!origem) location.replace('login.html');

/* ── NAVIGATION ── */
const SECTION_TITLES = {
  dashboard: 'Dashboard',
  email: 'E-mail',
  financeiro: 'Financeiro',
  produtos: 'Meus Produtos',
  marketplace: 'Marketplace',
  dns: 'DNS',
  configuracoes: 'Configurações',
  suporte: 'Suporte',
};

function navigate(id) {
  if (!Object.prototype.hasOwnProperty.call(SECTION_TITLES, id)) return;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('sec-' + id).classList.add('active');
  const navItem = document.querySelector(`.nav-item[data-section="${id}"]`);
  if (navItem) navItem.classList.add('active');
  document.getElementById('topbarTitle').textContent = SECTION_TITLES[id] || id;
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── SIDEBAR (mobile) ── */
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSidebar();
});

/* ── ESCAPE de texto em HTML montado por innerHTML ── */
function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ── TOAST ── */
function showToast(msg, type = 'info') {
  const icons = { success: 'circle-check', error: 'circle-x', info: 'info' };
  const wrap = document.getElementById('toastWrap');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#${icons[type]}"></use></svg><span>${esc(msg)}</span>`;
  wrap.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, 3800);
}

/* ── USUÁRIO DA SESSÃO (só por textContent) ── */
function preencherUsuario(email) {
  const inicial = (Array.from(email)[0] || '').toUpperCase();
  document.getElementById('painelEmail').textContent = email;
  document.getElementById('sidebarName').textContent = email;
  document.getElementById('sidebarInitials').textContent = inicial;
  document.getElementById('topbarAvatar').textContent = inicial;
}

// Esconde o painel e apaga o e-mail: estado de antes de GET /sessao responder 200.
function ocultarPainel() {
  document.body.classList.add('sessao-pendente');
  preencherUsuario('');
}

// setTimeout + abort (e não AbortSignal.timeout) para o page.clock dos testes controlar o prazo.
async function chamarApi(caminho, opcoes) {
  const controlador = new AbortController();
  const prazo = setTimeout(() => controlador.abort(), SESSAO_TIMEOUT_MS);
  let status = 0;
  let dados = null;
  try {
    const r = await fetch(`${origem}${caminho}`, { ...opcoes, credentials: 'include', cache: 'no-store', signal: controlador.signal });
    status = r.status;
    dados = status === 200 ? await r.json().catch(() => null) : null;
  } catch {
    status = 0;
  } finally {
    clearTimeout(prazo);
  }
  return { status, dados };
}

// GET /api/painel/sessao: 200 mostra o painel; 401 volta ao login; demais respostas e rede, tela de erro.
let consultandoSessao = false;
async function carregarSessao() {
  if (consultandoSessao) return;
  consultandoSessao = true;
  ocultarPainel();
  document.getElementById('painelErro').classList.add('is-hidden');
  const { status, dados } = await chamarApi('/api/painel/sessao', { method: 'GET' });
  consultandoSessao = false;
  if (status === 200 && dados && typeof dados.email === 'string' && dados.email !== '') {
    preencherUsuario(dados.email);
    document.body.classList.remove('sessao-pendente');
    return;
  }
  if (status === 401) {
    location.replace('login.html');
    return;
  }
  document.getElementById('painelErro').classList.remove('is-hidden');
}

// POST /api/painel/logout: 204 volta ao login; 403, 5xx ou rede mantêm o painel com um aviso.
let saindo = false;
async function sair() {
  if (saindo) return;
  saindo = true;
  const btn = document.getElementById('btnSair');
  btn.disabled = true;
  const { status } = await chamarApi('/api/painel/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (status === 204) {
    ocultarPainel();
    location.replace('login.html');
    return;
  }
  saindo = false;
  btn.disabled = false;
  showToast('Não foi possível sair. Tente novamente.', 'error');
}

/* ================================================================
   VÍNCULOS — sem handler inline, por causa da CSP.
================================================================ */
document.querySelectorAll('.nav-item[data-section]').forEach(el => {
  el.addEventListener('click', e => navigate(e.currentTarget.dataset.section));
});
document.querySelectorAll('[data-ir-para]').forEach(el => {
  el.addEventListener('click', e => navigate(e.currentTarget.dataset.irPara));
});
document.getElementById('sidebarToggle').addEventListener('click', () => toggleSidebar());
document.getElementById('sidebarBackdrop').addEventListener('click', () => closeSidebar());
document.getElementById('btnSair').addEventListener('click', () => sair());
document.getElementById('btnPainelTentar').addEventListener('click', () => carregarSessao());

if (origem) {
  carregarSessao();
  // bfcache: a cópia guardada sai sem o e-mail e, ao voltar, a sessão é consultada de novo.
  window.addEventListener('pagehide', () => ocultarPainel());
  window.addEventListener('pageshow', e => {
    if (!e.persisted) return;
    saindo = false;
    document.getElementById('btnSair').disabled = false;
    carregarSessao();
  });
}
