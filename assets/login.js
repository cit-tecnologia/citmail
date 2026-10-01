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

function handleLogin(e) {
  e.preventDefault();
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
  if (pass.length < 3) {
    document.getElementById('errPassword').classList.add('visible');
    document.getElementById('fPassword').classList.add('error');
    ok = false;
  }
  if (!ok) return;

  // Loading state
  const btn   = document.getElementById('btnLogin');
  const label = document.getElementById('btnLabel');
  const icon  = document.getElementById('btnIcon');
  btn.disabled = true;
  label.textContent = 'Entrando…';
  icon.style.display = 'none';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  btn.insertBefore(spinner, label);

  /*
   * INTEGRAÇÃO BACKEND:
   * POST /api/login  { email, password }
   * Resposta: { token, user } ou { error: 'credenciais inválidas' }
   * Em sucesso: salvar token em localStorage/sessionStorage → redirecionar para painel.html
   */
  setTimeout(() => {
    btn.disabled = false;
    spinner.remove();
    label.textContent = 'Entrar no Painel';
    setIcon(icon, 'log-in');

    // Demo: credenciais de teste
    if (email === 'demo@citmail.com.br' && pass === 'demo123') {
      label.textContent = 'Abrindo painel…';
      setIcon(icon, 'check');
      btn.style.background = 'var(--cit-success)';
      setTimeout(() => { window.location.href = 'painel.html'; }, 600);
    } else {
      document.getElementById('alertErrorMsg').textContent = 'E-mail ou senha incorretos. Tente novamente.';
      document.getElementById('alertError').classList.add('visible');
      document.getElementById('fPassword').value = '';
      document.getElementById('fPassword').focus();
    }
  }, 1400);
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
  note.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--cit-navy-500);color:white;padding:12px 18px;border-radius:var(--cit-radius-md);font-size:.875rem;display:flex;align-items:center;gap:10px;box-shadow:var(--shadow-lg);z-index:9999;animation:cit-fade-up var(--cit-duration-enter) var(--cit-ease) both';
  note.innerHTML = `<svg class="icon" style="color:var(--cit-success)" aria-hidden="true"><use href="assets/icons.svg#circle-check"></use></svg> Link enviado para <strong>${esc(email)}</strong>`;
  document.body.appendChild(note);
  setTimeout(() => { note.style.opacity='0'; note.style.transition='opacity .3s'; setTimeout(()=>note.remove(),300); }, 4000);
}

// Close forgot on overlay click
document.getElementById('forgotOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('forgotOverlay')) closeForgot();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('forgotOverlay').style.display !== 'none') closeForgot();
});

// Auto-focus email on load
window.addEventListener('load', () => {
  document.getElementById('fEmail').focus();
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
