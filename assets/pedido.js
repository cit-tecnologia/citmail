// Página de status do pedido (CIT-69, ADR 0016). O token vem do fragmento (#t=<token>), que não vai ao servidor nem ao
// Referer; a consulta é POST /api/pedidos/status com o token no corpo. DOM só por textContent/createElement.

// Origem da página → origem da API. Cópia de assets/checkout.js (teste de paridade em tests/paginas.spec.js): as duas
// mudam juntas, e com o connect-src da CSP de pedido.html (#57).
const ORIGENS_API = Object.freeze({ 'http://localhost:4200': 'http://localhost:4200' });
const HOSTS_FATURA = Object.freeze(['www.asaas.com', 'sandbox.asaas.com']);
const PADRAO_TOKEN = /^#t=([A-Za-z0-9_-]{43})$/;
const CONTATO_COMERCIAL = 'comercial@citmail.com.br';
const CONSULTA_TIMEOUT_MS = 15000;
const LIMITE_VISIVEL_MS = 30 * 60 * 1000;   // conta só o tempo com a aba visível
// Backoff por respostas seguidas com a mesma etapa: 1-4 → 10 s, 5-9 → 20 s, 10 ou mais → 60 s.
const INTERVALOS_MS = [{ ate: 5, ms: 10000 }, { ate: 10, ms: 20000 }, { ate: Infinity, ms: 60000 }];

const AVISO_DOMINIO = 'O registro do domínio .com.br é feito manualmente pela nossa equipe depois do pagamento. '
  + 'Seu e-mail é ativado quando o domínio estiver registrado.';

// Etapa → texto, passos (data-estado de pagamento, ativação e pronto; null = sem passos) e se encerra a consulta.
const ETAPAS = Object.freeze({
  aguardando_confirmacao: { texto: 'Aguardando a confirmação do pagamento.', passos: ['atual', null, null], final: false },
  dominio_pendente: { texto: 'Falta pagar a fatura do domínio.', passos: ['atual', null, null], final: false },
  registro_dominio: {
    texto: 'Pagamento confirmado. Nossa equipe registra o domínio manualmente e avisa por e-mail quando concluir.',
    passos: ['feito', 'atual', null], final: false,
  },
  ativando: { texto: 'Pagamento confirmado. Estamos ativando seu e-mail.', passos: ['feito', 'atual', null], final: false },
  ativo: {
    texto: 'Seu e-mail está ativo. Enviamos as instruções de acesso para o e-mail do cadastro.',
    passos: ['feito', 'feito', 'feito'], final: true,
  },
  erro_criacao: { texto: `Não foi possível concluir o pedido. Fale com ${CONTATO_COMERCIAL}.`, passos: null, final: true, contato: true },
  cancelado: { texto: 'Pedido cancelado.', passos: null, final: true, contato: true },
  em_analise: { texto: 'Estamos verificando seu pedido.', passos: null, final: true, contato: true },
});

const el = id => document.getElementById(id);

let token = null;
let origem = null;
let ultimaEtapa = null;
let iguais = 0;              // respostas 200 seguidas com a mesma etapa (erro não conta e não zera)
let temporizador = null;
let emVoo = false;
let parado = false;
let visivelAcumuladoMs = 0;
let visivelDesde = null;     // instante em que a aba ficou visível (null com a aba oculta)

function origemApi() {
  return Object.prototype.hasOwnProperty.call(ORIGENS_API, location.origin) ? ORIGENS_API[location.origin] : null;
}

function urlFaturaSegura(url) {
  if (typeof url !== 'string') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !HOSTS_FATURA.includes(u.hostname) || u.port !== '' || u.username !== '' || u.password !== '') return null;
  return u.href;
}

function tempoVisivel() {
  return visivelAcumuladoMs + (visivelDesde === null ? 0 : Date.now() - visivelDesde);
}

function intervaloAtual() {
  return INTERVALOS_MS.find(i => iguais < i.ate).ms;
}

function definirTexto(no, texto) {
  if (no.textContent !== texto) no.textContent = texto;   // sem reescrever: a região viva não repete o anúncio
}

function mostrarLink(link, url) {
  if (url) {
    if (link.getAttribute('href') !== url) link.setAttribute('href', url);
    link.hidden = false;
  } else {
    link.removeAttribute('href');
    link.hidden = true;
  }
}

// Resposta 200 dentro do contrato (lista branca da API): etapa conhecida, dominioNovo boolean, URLs string.
function respostaValida(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (typeof d.etapa !== 'string' || !Object.prototype.hasOwnProperty.call(ETAPAS, d.etapa)) return false;
  if (d.dominioNovo !== undefined && typeof d.dominioNovo !== 'boolean') return false;
  return ['faturaContasUrl', 'faturaDominioUrl'].every(k => d[k] === undefined || typeof d[k] === 'string');
}

function mostrarStatus(d) {
  const etapa = ETAPAS[d.etapa];
  const urlContas = d.etapa === 'aguardando_confirmacao' ? urlFaturaSegura(d.faturaContasUrl) : null;
  const urlDominio = d.etapa === 'aguardando_confirmacao' || d.etapa === 'dominio_pendente'
    ? urlFaturaSegura(d.faturaDominioUrl) : null;
  // Fatura esperada sem URL segura (retida, nula ou fora da allowlist): chega por e-mail.
  const semFatura = (d.etapa === 'aguardando_confirmacao' && !urlContas) || (d.etapa === 'dominio_pendente' && !urlDominio);

  definirTexto(el('statusEtapa'), semFatura ? `${etapa.texto} A fatura chega por e-mail.` : etapa.texto);

  const passos = el('statusPassos');
  passos.hidden = etapa.passos === null;
  ['pagamento', 'ativacao', 'pronto'].forEach((nome, i) => {
    const li = passos.querySelector(`[data-passo="${nome}"]`);
    const estado = etapa.passos ? etapa.passos[i] : null;
    if (estado) li.setAttribute('data-estado', estado);
    else li.removeAttribute('data-estado');
    if (estado === 'atual') li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });

  const dominio = el('statusDominio');
  const comAvisoDominio = d.dominioNovo === true && !etapa.final;
  if (comAvisoDominio) definirTexto(dominio, AVISO_DOMINIO);
  dominio.hidden = !comAvisoDominio;

  mostrarLink(el('linkFaturaContas'), urlContas);
  mostrarLink(el('linkFaturaDominio'), urlDominio);
  el('statusFaturas').hidden = !urlContas && !urlDominio;

  el('statusContato').hidden = !(semFatura || etapa.contato);
  el('statusAviso').hidden = true;
  el('statusPedido').hidden = false;
}

function mostrarNaoEncontrado() {
  const p = document.createElement('p');
  p.append('Pedido não encontrado. Confira o endereço ou fale com ');
  const a = document.createElement('a');
  a.href = `mailto:${CONTATO_COMERCIAL}`;
  a.textContent = CONTATO_COMERCIAL;
  p.append(a, '.');
  const caixa = el('statusInvalido');
  caixa.querySelector('p').replaceWith(p);
  el('statusPedido').hidden = true;
  caixa.hidden = false;
}

function mostrarFalhaAtualizacao() {
  el('statusAviso').hidden = false;
  if (ultimaEtapa === null) el('statusPassos').hidden = true;   // nenhuma etapa ainda: só o aviso
  el('statusPedido').hidden = false;
}

function limparTemporizador() {
  if (temporizador !== null) { clearTimeout(temporizador); temporizador = null; }
}

function parar(comBotao) {
  parado = true;
  limparTemporizador();
  el('btnAtualizar').hidden = !comBotao;
}

function agendar() {
  limparTemporizador();
  if (parado || document.hidden) return;
  const restante = LIMITE_VISIVEL_MS - tempoVisivel();
  if (restante <= 0) { parar(true); return; }
  // O intervalo vale do fim de uma resposta ao início da próxima; o limite de 30 min pode chegar antes.
  temporizador = setTimeout(() => {
    temporizador = null;
    if (tempoVisivel() >= LIMITE_VISIVEL_MS) parar(true);
    else consultar();
  }, Math.min(intervaloAtual(), restante));
}

async function consultar() {
  if (emVoo || parado || document.hidden) return;
  emVoo = true;
  limparTemporizador();
  const controlador = new AbortController();
  // setTimeout + abort (e não AbortSignal.timeout) para o page.clock dos testes controlar o prazo.
  const prazo = setTimeout(() => controlador.abort(), CONSULTA_TIMEOUT_MS);
  let status = 0;
  let dados = null;
  try {
    const r = await fetch(`${origem}/api/pedidos/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
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
  emVoo = false;
  tratarResposta(status, dados);
}

function tratarResposta(status, d) {
  if (status === 404) {
    mostrarNaoEncontrado();
    parar(false);
    return;
  }
  if (status !== 200 || !respostaValida(d)) {   // rede, prazo, 5xx ou fora do contrato: mantém a última tela
    mostrarFalhaAtualizacao();
    agendar();
    return;
  }
  if (d.etapa === ultimaEtapa) iguais += 1;
  else { ultimaEtapa = d.etapa; iguais = 1; }
  mostrarStatus(d);
  if (ETAPAS[d.etapa].final) { parar(true); return; }
  agendar();
}

function aoMudarVisibilidade() {
  if (document.hidden) {
    if (visivelDesde !== null) { visivelAcumuladoMs += Date.now() - visivelDesde; visivelDesde = null; }
    limparTemporizador();   // nenhuma requisição com a aba oculta (a que está em voo termina e não agenda)
    return;
  }
  if (visivelDesde === null) visivelDesde = Date.now();
  if (parado || emVoo) return;
  if (tempoVisivel() >= LIMITE_VISIVEL_MS) { parar(true); return; }
  consultar();
}

function atualizarAgora() {
  if (emVoo) return;
  // Nova janela de 30 min; o contador de respostas iguais segue (só zera na mudança de etapa).
  visivelAcumuladoMs = 0;
  visivelDesde = document.hidden ? null : Date.now();
  parado = false;
  el('btnAtualizar').hidden = true;
  consultar();
}

function iniciar() {
  const m = PADRAO_TOKEN.exec(location.hash);
  if (!m) { el('statusInvalido').hidden = false; return; }   // sem requisição
  origem = origemApi();
  if (!origem) { el('statusIndisponivel').hidden = false; return; }   // modo local: sem requisição
  token = m[1];
  el('btnAtualizar').addEventListener('click', atualizarAgora);
  document.addEventListener('visibilitychange', aoMudarVisibilidade);
  if (!document.hidden) {
    visivelDesde = Date.now();
    consultar();
  }
}

iniciar();
