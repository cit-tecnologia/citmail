function setIcon(el, name) {
  el.style.display = '';
  el.querySelector('use').setAttribute('href', 'assets/icons.svg#' + name);
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
const MSG_ESQUECI = 'Se houver uma conta com este e-mail, enviaremos um link em instantes.';

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
  e?.preventDefault();
  const overlay = document.getElementById('forgotOverlay');
  overlay.classList.remove('is-hidden');
  overlay.style.display = 'flex';
  document.getElementById('fForgotEmail').classList.remove('error');
  document.getElementById('forgotErro').classList.remove('visible');
  const emailVal = document.getElementById('fEmail').value;
  if (emailVal) document.getElementById('fForgotEmail').value = emailVal;
  setTimeout(() => document.getElementById('fForgotEmail').focus(), 100);
}
function closeForgot() {
  const overlay = document.getElementById('forgotOverlay');
  overlay.style.display = 'none';
  overlay.classList.add('is-hidden');
}

// Resposta fixa, sem o e-mail digitado (CIT-71): o mesmo texto exista a conta ou não. Montado por createElementNS,
// sem innerHTML.
function mostrarToastEsqueci() {
  const NS = 'http://www.w3.org/2000/svg';
  const note = document.createElement('div');
  note.className = 'toast-link';
  note.setAttribute('role', 'status');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon icon--success');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', 'assets/icons.svg#circle-check');
  svg.appendChild(use);
  note.append(svg, document.createTextNode(' ' + MSG_ESQUECI));
  document.body.appendChild(note);
  setTimeout(() => { note.style.opacity='0'; note.style.transition='opacity .3s'; setTimeout(()=>note.remove(),300); }, 4000);
}

// POST /api/painel/senha/esqueci (ADR 0008; CIT-71): 202 sem corpo para qualquer e-mail; demais respostas e rede, erro
// no modal.
async function pedirLink(email) {
  const controlador = new AbortController();
  const prazo = setTimeout(() => controlador.abort(), LOGIN_TIMEOUT_MS);
  let status = 0;
  try {
    const r = await fetch(`${origem}/api/painel/senha/esqueci`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
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

let pedindoLink = false;
async function sendForgot() {
  if (!origem || pedindoLink) return;
  const email = document.getElementById('fForgotEmail').value.trim();
  document.getElementById('forgotErro').classList.remove('visible');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('fForgotEmail').classList.add('error');
    return;
  }
  document.getElementById('fForgotEmail').classList.remove('error');
  pedindoLink = true;
  const botao = document.querySelector('[data-login-acao="enviar"]');
  botao.disabled = true;
  const status = await pedirLink(email);
  pedindoLink = false;
  botao.disabled = false;
  if (status === 202) {
    closeForgot();
    mostrarToastEsqueci();
  } else {
    document.getElementById('forgotErro').classList.add('visible');
  }
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

// Parâmetros de chegada (CIT-71), tirados da barra depois de lidos: ?senha=definida (vindo de definir-senha.html)
// mostra o aviso, também no modo local; ?esqueci=1 ("Pedir novo link") abre o modal no modo API.
(function lerParametros() {
  const url = new URL(location.href);
  const senhaDefinida = url.searchParams.get('senha') === 'definida';
  const esqueci = url.searchParams.get('esqueci') === '1';
  if (!url.searchParams.has('senha') && !url.searchParams.has('esqueci')) return;
  url.searchParams.delete('senha');
  url.searchParams.delete('esqueci');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  if (senhaDefinida) document.getElementById('loginAviso').classList.remove('is-hidden');
  if (esqueci && origem) showForgot();
})();

// Auto-focus email on load
window.addEventListener('load', () => {
  if (origem && document.getElementById('forgotOverlay').classList.contains('is-hidden')) document.getElementById('fEmail').focus();
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
