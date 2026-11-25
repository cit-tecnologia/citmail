/* Definir e redefinir a senha do titular por link (ADR 0008; CIT-71).
   O token chega no fragmento (#t=<43 base64url>), vai para a memória e sai da barra antes de qualquer outra coisa;
   só viaja no corpo de POST (nunca na URL nem no Referer). Texto só por textContent. */

const PADRAO_TOKEN = /^#t=([A-Za-z0-9_-]{43})$/;

// 1. Lê o fragmento e o apaga da barra imediatamente.
const fragmento = location.hash;
if (fragmento) history.replaceState(null, '', location.pathname);
let token = (PADRAO_TOKEN.exec(fragmento) || [])[1] || null;

// Origem da página → origem da API. Cópia de assets/checkout.js (paridade por teste): as cópias mudam juntas, e com o
// connect-src da CSP (#57). Fora do mapa (Pages, homologação, 127.0.0.1) a página fica no modo local, sem requisição.
const ORIGENS_API = Object.freeze({ 'http://localhost:4200': 'http://localhost:4200' });
const REQUISICAO_TIMEOUT_MS = 15000;
const REGRA_SENHA = 'Use de 12 a 128 caracteres, diferente do seu e-mail.';
const SENHA_MIN = 12;
const SENHA_MAX = 128;

function origemApi() {
  return Object.prototype.hasOwnProperty.call(ORIGENS_API, location.origin) ? ORIGENS_API[location.origin] : null;
}

const origem = origemApi();
const ESTADOS = ['definirCarregando', 'definirIndisponivel', 'linkInvalido', 'definirErro', 'definirNaoConfirmado', 'definirSucesso', 'definirForm'];
let enviando = false;

function el(id) { return document.getElementById(id); }

function mostrarEstado(id) {
  ESTADOS.forEach(e => el(e).classList.toggle('is-hidden', e !== id));
}

function linkInvalido() {
  token = null;
  mostrarEstado('linkInvalido');
}

// POST na API com o token no corpo; devolve { status, dados }. Status 0 = rede ou prazo.
async function postar(rota, corpo) {
  const controlador = new AbortController();
  // setTimeout + abort (e não AbortSignal.timeout) para o page.clock dos testes controlar o prazo.
  const prazo = setTimeout(() => controlador.abort(), REQUISICAO_TIMEOUT_MS);
  let status = 0;
  let dados = null;
  try {
    const r = await fetch(`${origem}/api/painel/senha/${rota}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controlador.signal,
    });
    status = r.status;
    dados = status === 200 ? await r.json().catch(() => null) : null;
  } catch {
    status = 0;
  } finally {
    clearTimeout(prazo);
  }
  return { status, dados };
}

// 200 { tipo } → formulário; 410 → link inválido; demais respostas e rede → erro com "Tentar novamente".
async function validar() {
  if (!token) { linkInvalido(); return; }
  mostrarEstado('definirCarregando');
  const { status, dados } = await postar('validar', { token });
  if (!token) return;   // a página foi abandonada/invalidada enquanto validava
  if (status === 410) { linkInvalido(); return; }
  if (status !== 200) { mostrarEstado('definirErro'); return; }
  el('definirTitulo').textContent = dados?.tipo === 'redefinicao' ? 'Redefina sua senha' : 'Defina sua senha';
  mostrarEstado('definirForm');
  restaurarBotao();
}

function limparErros() {
  el('errNovaSenha').classList.remove('visible');
  el('errConfirma').classList.remove('visible');
  el('fNovaSenha').classList.remove('error');
  el('fConfirmaSenha').classList.remove('error');
}

function erroPolitica() {
  el('errNovaSenha').textContent = REGRA_SENHA;
  el('errNovaSenha').classList.add('visible');
  el('fNovaSenha').classList.add('error');
  el('fNovaSenha').focus();
}

function restaurarBotao() {
  enviando = false;
  el('btnDefinir').disabled = false;
  el('btnDefinirLabel').textContent = 'Salvar senha';
}

async function definir(e) {
  e.preventDefault();
  if (!origem || !token || enviando) return;
  limparErros();
  const senha = el('fNovaSenha').value;
  const confirma = el('fConfirmaSenha').value;
  const tamanho = [...senha].length;
  if (tamanho < SENHA_MIN || tamanho > SENHA_MAX) { erroPolitica(); return; }
  if (senha !== confirma) {
    el('errConfirma').classList.add('visible');
    el('fConfirmaSenha').classList.add('error');
    el('fConfirmaSenha').focus();
    return;
  }

  enviando = true;
  el('btnDefinir').disabled = true;
  el('btnDefinirLabel').textContent = 'Salvando…';
  const { status } = await postar('definir', { token, senha });
  if (status === 204) {
    // Sem login automático (Decisão 7): zera o token e as senhas antes de sair.
    token = null;
    el('fNovaSenha').value = '';
    el('fConfirmaSenha').value = '';
    mostrarEstado('definirSucesso');
    location.replace('login.html?senha=definida');
    return;
  }
  if (status === 0) {
    // Sem resposta: a senha pode já ter sido gravada e o token consumido; repetir não ajuda. Orienta a entrar.
    token = null;
    el('fNovaSenha').value = '';
    el('fConfirmaSenha').value = '';
    mostrarEstado('definirNaoConfirmado');
    return;
  }
  restaurarBotao();
  if (status === 400) { erroPolitica(); return; }
  if (status === 410) { linkInvalido(); return; }
  mostrarEstado('definirErro');
}

function alternarSenha(botao) {
  const input = el(botao.dataset.alvo);
  if (!input) return;
  const mostrar = input.type === 'password';
  input.type = mostrar ? 'text' : 'password';
  const rotulo = mostrar ? 'Ocultar senha' : 'Mostrar senha';
  botao.setAttribute('aria-label', rotulo);
  botao.setAttribute('title', rotulo);
  botao.querySelector('use').setAttribute('href', 'assets/icons.svg#' + (mostrar ? 'eye-off' : 'eye'));
}

function iniciar() {
  // Outro token colado no endereço: recomeça do zero (o replaceState acima não dispara hashchange).
  window.addEventListener('hashchange', () => location.reload());

  // 2. Origem antes do fragmento: no modo local, nenhuma requisição, com ou sem #t.
  if (!origem) { token = null; mostrarEstado('definirIndisponivel'); return; }

  // 3. Fragmento ausente ou malformado: link inválido, sem requisição.
  if (!token) { linkInvalido(); return; }

  el('formDefinir').addEventListener('submit', definir);
  document.querySelectorAll('[data-definir-acao="mostrar-senha"]').forEach(b => {
    b.addEventListener('click', () => alternarSenha(b));
  });
  document.querySelectorAll('[data-definir-acao="tentar"]').forEach(b => {
    b.addEventListener('click', () => validar());
  });

  // Volta pelo histórico (bfcache): sem token em memória (já usado ou inválido) → link inválido; senão, botão livre.
  window.addEventListener('pageshow', ev => {
    if (!ev.persisted) return;
    if (!token) { linkInvalido(); return; }
    restaurarBotao();
  });

  // 4. Valida o link.
  validar();
}

iniciar();
