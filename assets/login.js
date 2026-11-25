function setIcon(el, name) {
  el.style.display = '';
  el.querySelector('use').setAttribute('href', 'assets/icons.svg#' + name);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function togglePassword() {
  const input = document.getElementById('fPassword');
  const icon  = document.getElementById('eyeIcon');
  if (input.type === 'password') {
    input.type = 'text';
    setIcon(icon, 'eye-off');
  } else {
    input.type = 'password';
    setIcon(icon, 'eye');
  }
}

// Origem da página → origem da API. Cópia de assets/checkout.js (paridade por teste): as cópias mudam juntas, e com o
// connect-src da CSP (#57). Fora do mapa (Pages, homologação, 127.0.0.1) o login fica no modo local, sem formulário.
const ORIGENS_API = Object.freeze({ 'http://localhost:4200': 'http://localhost:4200' });
const LOGIN_TIMEOUT_MS = 15000;
const MSG_CREDENCIAIS = 'E-mail ou senha incorretos.';
const MSG_INDISPONIVEL = 'Não foi possível entrar agora. Tente novamente em instantes.';

function origemApi() {
  return Object.prototype.hasOwnProperty.call(ORIGENS_API, location.origin) ? ORIGENS_API[location.origin] : null;
}

const origem = origemApi();
let entrando = false;

function mostrarErroLogin(msg) {
  document.getElementById('alertErrorMsg').textContent = msg;
  document.getElementById('alertError').classList.add('visible');
}

function restaurarBotao() {
  const btn = document.getElementById('btnLogin');
  btn.disabled = false;
  btn.querySelector('.spinner')?.remove();
  document.getElementById('btnLabel').textContent = 'Entrar no Painel';
  setIcon(document.getElementById('btnIcon'), 'log-in');
}

// POST /api/painel/login (ADR 0008): 204 com o cookie de sessão; 401 genérico; demais respostas e rede, mensagem de
// indisponibilidade.
async function entrar(email, senha) {
  const controlador = new AbortController();
  // setTimeout + abort (e não AbortSignal.timeout) para o page.clock dos testes controlar o prazo.
  const prazo = setTimeout(() => controlador.abort(), LOGIN_TIMEOUT_MS);
  let status = 0;
  try {
    const r = await fetch(`${origem}/api/painel/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha }),
      credentials: 'include',
      cache: 'no-store',
      signal: controlador.signal,
    });
    status = r.status;
  } catch {
    status = 0;
  } finally {
    clearTimeout(prazo);
  }
  return status;
}

async function handleLogin(e) {
  e.preventDefault();
  if (!origem || entrando) return;
  const email = document.getElementById('fEmail').value.trim();
  const pass  = document.getElementById('fPassword').value;
  let ok = true;

  document.getElementById('errEmail').classList.remove('visible');
  document.getElementById('errPassword').classList.remove('visible');
  document.getElementById('alertError').classList.remove('visible');
  document.getElementById('fEmail').classList.remove('error');
  document.getElementById('fPassword').classList.remove('error');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('errEmail').classList.add('visible');
    document.getElementById('fEmail').classList.add('error');
    ok = false;
  }
  if (!pass) {
    document.getElementById('errPassword').classList.add('visible');
    document.getElementById('fPassword').classList.add('error');
    ok = false;
  }
  if (!ok) return;

  // Loading state
  entrando = true;
  const btn   = document.getElementById('btnLogin');
  const label = document.getElementById('btnLabel');
  const icon  = document.getElementById('btnIcon');
  btn.disabled = true;
  label.textContent = 'Entrando…';
  icon.style.display = 'none';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  btn.insertBefore(spinner, label);

  const status = await entrar(email, pass);
  if (status === 204) {
    location.replace('painel.html');
    return;
  }
  entrando = false;
  restaurarBotao();
  if (status === 401) {
    mostrarErroLogin(MSG_CREDENCIAIS);
    document.getElementById('fPassword').value = '';
    document.getElementById('fPassword').focus();
  } else {
    mostrarErroLogin(MSG_INDISPONIVEL);
  }
}

function showForgot(e) {
  e.preventDefault();
  const overlay = document.getElementById('forgotOverlay');
  overlay.style.display = 'flex';
  document.getElementById('fForgotEmail').classList.remove('error');
  const emailVal = document.getElementById('fEmail').value;
  if (emailVal) document.getElementById('fForgotEmail').value = emailVal;
  setTimeout(() => document.getElementById('fForgotEmail').focus(), 100);
}
function closeForgot() {
  document.getElementById('forgotOverlay').style.display = 'none';
}
function sendForgot() {
  const email = document.getElementById('fForgotEmail').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('fForgotEmail').classList.add('error');
    return;
  }
  /*
   * INTEGRAÇÃO BACKEND:
   * POST /api/forgot-password { email }
   */
  closeForgot();
  // show toast-like feedback
  const note = document.createElement('div');
  note.className = 'toast-link';
  note.innerHTML = `<svg class="icon icon--success" aria-hidden="true"><use href="assets/icons.svg#circle-check"></use></svg> Link enviado para <strong>${esc(email)}</strong>`;
  document.body.appendChild(note);
  setTimeout(() => { note.style.opacity='0'; note.style.transition='opacity .3s'; setTimeout(()=>note.remove(),300); }, 4000);
}

// Close forgot on overlay click
document.getElementById('forgotOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('forgotOverlay')) closeForgot();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && getComputedStyle(document.getElementById('forgotOverlay')).display !== 'none') closeForgot();
});

// Modo local: sem formulário, só o aviso "Painel disponível em breve" (nenhuma requisição à API).
if (!origem) {
  document.getElementById('loginIndisponivel').classList.remove('is-hidden');
  document.querySelector('.login-card').classList.add('login-card--local');
}

// Auto-focus email on load
window.addEventListener('load', () => {
  if (origem) document.getElementById('fEmail').focus();
});

// Volta pelo histórico (bfcache): a página não pode reaparecer presa em "Entrando…".
window.addEventListener('pageshow', e => {
  if (!e.persisted) return;
  entrando = false;
  restaurarBotao();
});

/* ================================================================
   VÍNCULOS — cada controle recebe o seu listener no próprio elemento
   (sem handler inline, por causa da CSP).
================================================================ */
document.querySelector('form').addEventListener('submit', e => handleLogin(e));
document.querySelectorAll('[data-login-acao="mostrar-senha"]').forEach(el => {
  el.addEventListener('click', () => togglePassword());
});
document.querySelectorAll('[data-login-acao="esqueci"]').forEach(el => {
  el.addEventListener('click', e => showForgot(e));
});
document.querySelectorAll('[data-login-acao="fechar"]').forEach(el => {
  el.addEventListener('click', () => closeForgot());
});
document.querySelectorAll('[data-login-acao="enviar"]').forEach(el => {
  el.addEventListener('click', () => sendForgot());
});
