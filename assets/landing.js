// Guarda de carga: sem assets/precos.js não há preço a exibir; avisa no lugar da calculadora.
// Só as funções da calculadora saem cedo (precosOk); header, menu, FAQ, busca e fade-in seguem.
const precosOk = typeof PRECOS !== 'undefined';
if (!precosOk) {
  document.querySelector('#pricing .calc-wrapper').innerHTML =
    '<p class="discount-info" role="alert">Não foi possível carregar os preços. Recarregue a página.</p>';
  document.querySelector('#pricing .billing-toggle').remove(); // sem preços, o ciclo não tem efeito
}
// ---- HEADER scroll effect ----
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 10);
  document.getElementById('scrollTop').classList.toggle('visible', window.scrollY > 400);
});

// ---- MOBILE NAV ----
const navToggle = document.getElementById('navToggle');
const nav = document.getElementById('nav');
function setNavOpen(open) {
  header.classList.toggle('nav-mobile-open', open);
  navToggle.setAttribute('aria-expanded', open);
  // Os botões ficam logo abaixo da lista de links, na altura real que ela ocupa.
  if (open) header.style.setProperty('--mobile-links-height', nav.querySelector('.nav-links').offsetHeight + 'px');
}
navToggle.addEventListener('click', () => setNavOpen(!header.classList.contains('nav-mobile-open')));
nav.querySelectorAll('.nav-links a, .nav-ctas a').forEach(a => a.addEventListener('click', () => setNavOpen(false)));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setNavOpen(false); });

// ---- BILLING TOGGLE ----
let billing = 'monthly';

function toggleBilling() {
  setBilling(billing === 'monthly' ? 'annual' : 'monthly');
}
function setBilling(mode) {
  if (!precosOk) return;
  billing = mode;
  document.getElementById('billingToggle').classList.toggle('annual', mode === 'annual');
  document.getElementById('toggleMonthly').classList.toggle('active', mode === 'monthly');
  document.getElementById('toggleAnnual').classList.toggle('active', mode === 'annual');
  document.getElementById('csAnnualNote').classList.toggle('visible', mode === 'annual');
  recalcAll();
}

// ---- CALCULADORA DE CONTAS ----
// Preços e descontos vêm de assets/precos.js (fonte única, mesma regra do checkout).
const ACCOUNT_TYPES = {
  '5gb':  { min:2, inputId:'qty5', subId:'sub5',  discTagId:'discTag5',  cardId:'card5',  unitId:'unitPrice5',  bdId:'breakdown5',  origId:'origPrice5',  finalId:'finalPrice5',  savId:'saving5'  },
  '25gb': { min:1, inputId:'qty25', subId:'sub25', discTagId:'discTag25', cardId:'card25', unitId:'unitPrice25', bdId:'breakdown25', origId:'origPrice25', finalId:'finalPrice25', savId:'saving25' },
  '50gb': { min:1, inputId:'qty50', subId:'sub50', discTagId:'discTag50', cardId:'card50', unitId:'unitPrice50', bdId:'breakdown50', origId:'origPrice50', finalId:'finalPrice50', savId:'saving50' },
};
const quantities = { '5gb': 0, '25gb': 0, '50gb': 0 };

// quantidade inteira ≥ 0; abaixo do mínimo do tipo sobe ao mínimo, ou zera ao diminuir
// regra duplicada em ckNormalizeQty (checkout.html): manter as duas iguais
function normalizeQty(type, raw, delta = 0) {
  const min = ACCOUNT_TYPES[type].min;
  const q   = Math.max(0, parseInt(raw) || 0);
  if (q > 0 && q < min) return delta < 0 ? 0 : min;
  return q;
}

function changeQty(type, delta) {
  if (!precosOk) return;
  const cfg  = ACCOUNT_TYPES[type];
  const next = normalizeQty(type, quantities[type] + delta, delta);
  quantities[type] = next;
  document.getElementById(cfg.inputId).value = next;
  recalcType(type);
  recalcSummary();
}

function updateQty(type, raw) {
  if (!precosOk) return;
  const cfg = ACCOUNT_TYPES[type];
  const val = normalizeQty(type, raw);
  quantities[type] = val;
  document.getElementById(cfg.inputId).value = val;
  recalcType(type);
  recalcSummary();
}

// Valores do tipo, em centavos: unitários e a cascata do tipo (tabela, atual, cobrado e segmentos),
// anual sem volume; volume só no mensal (cascataCentavos, assets/precos.js).
function valoresTipo(type, qty) {
  const anual = billing === 'annual';
  const atual = PRECOS.contas[type];
  return {
    unit: unitarioCobradoCentavos(type, qty, anual),
    tabelaUnit: tabelaCentavos(atual),
    ...cascataCentavos(atual, qty, { conta: true, anual }),
  };
}

function recalcType(type) {
  if (!precosOk) return;
  const cfg = ACCOUNT_TYPES[type];
  const qty = quantities[type];
  const v   = valoresTipo(type, qty);

  const subEl = document.getElementById(cfg.subId);
  subEl.textContent = `R$ ${fmtCentavos(v.cobrado)}/mês`;
  subEl.classList.toggle('has-value', qty > 0);
  document.getElementById(cfg.cardId).querySelector(`[data-preco-tabela="conta:${type}"]`).textContent = `R$ ${fmtCentavos(v.tabelaUnit)}`;
  document.getElementById(cfg.unitId).innerHTML = `<span class="sr-only">por </span>R$ ${fmtCentavos(v.unit)}`;
  document.getElementById(cfg.cardId).classList.toggle('has-qty', qty > 0);

  const bdEl = document.getElementById(cfg.bdId);
  if (qty > 0) {
    bdEl.style.display = 'flex';
    document.getElementById(cfg.origId).textContent = `R$ ${fmtCentavos(v.tabela)}`;
    document.getElementById(cfg.finalId).innerHTML  = `<span class="sr-only">por </span>R$ ${fmtCentavos(v.cobrado)}/mês`;
    document.getElementById(cfg.savId).textContent  = `economia −R$ ${fmtCentavos(v.tabela - v.cobrado)}/mês`;
  } else {
    bdEl.style.display = 'none';
  }

  // Selo e dica de volume só no mensal (no anual não há desconto por volume).
  const discTagEl = document.getElementById(cfg.discTagId);
  if (qty > 0 && billing === 'monthly') {
    if (percentualVolume(qty, false) > 0) {
      discTagEl.innerHTML = `<span class="vol-badge"><svg class="icon" aria-hidden="true"><use href="assets/icons.svg#tag"></use></svg> −${DESCONTO_VOLUME_PCT}% por volume aplicado</span>`;
    } else {
      discTagEl.textContent = `Adicione mais ${VOLUME_MIN_QTD - qty} conta(s) para −${DESCONTO_VOLUME_PCT}% de volume`;
    }
  } else { discTagEl.textContent = ''; }
}

function recalcAll() {
  if (!precosOk) return;
  Object.keys(ACCOUNT_TYPES).forEach(recalcType);
  recalcSummary();
}

// Cascata do tipo no resumo: "de R$ T · −15% contratação −R$ A[ · −20% anual −R$ B | · −5% volume −R$ B]".
// Mesmo formato da .sum-disc do checkout; só renderiza o resultado de cascataCentavos. Quebra só entre segmentos.
function htmlCsDisc(v) {
  const seg = t => `<span class="cs-disc-seg">${t}</span>`;
  const partes = [
    seg(`de <s>R$ ${fmtCentavos(v.tabela)}</s>`),
    ...v.segmentos.map(sg => seg(`${sg.rotulo} −R$ ${fmtCentavos(sg.valor)}`)),
  ];
  return `<div class="cs-disc"><svg class="icon" aria-hidden="true"><use href="assets/icons.svg#tag"></use></svg> ${partes.join(' · ')}</div>`;
}

function recalcSummary() {
  if (!precosOk) return;
  const csEmpty    = document.getElementById('csEmpty');
  const csLines    = document.getElementById('csLines');
  const linesEl    = document.getElementById('csSummaryLines');
  const totalEl    = document.getElementById('csTotal');
  const periodEl   = document.getElementById('csPeriod');
  const economiaEl = document.getElementById('csEconomia');
  const ctaBtn     = document.getElementById('calcCtaBtn');
  const names      = { '5gb':'E-mail 5 GB', '25gb':'E-mail 25 GB', '50gb':'E-mail 50 GB' };
  let grandTotal = 0, grandTabela = 0, totalAccounts = 0, html = '';

  Object.keys(ACCOUNT_TYPES).forEach(type => {
    const qty = quantities[type];
    if (qty === 0) return;
    totalAccounts += qty;
    const v = valoresTipo(type, qty);
    grandTotal += v.cobrado; grandTabela += v.tabela;
    html += `<div class="cs-line"><span class="lbl">${qty}× ${names[type]}</span><span class="val">R$ ${fmtCentavos(v.cobrado)}</span></div>`;
    html += htmlCsDisc(v);
  });

  const isEmpty = totalAccounts === 0;
  csEmpty.style.display = isEmpty ? 'block' : 'none';
  csLines.style.display = isEmpty ? 'none'  : 'block';
  economiaEl.hidden = isEmpty;

  if (!isEmpty) {
    html += `<div class="cs-line" style="margin-top:6px;border-top:1px dashed var(--gray-200);padding-top:6px"><span class="lbl" style="font-weight:700">Total de tabela</span><span class="val"><s>R$ ${fmtCentavos(grandTabela)}</s></span></div>`;
    linesEl.innerHTML = html;
    totalEl.textContent = `R$ ${fmtCentavos(grandTotal)}`;
    periodEl.textContent = billing === 'annual' ? `/mês · R$ ${fmtCentavos(grandTotal*12)}/ano` : '/mês';
    const economia = grandTabela - grandTotal;   // Σ por tipo de (tabela − cobrado)
    economiaEl.textContent = `Você economiza R$ ${fmtCentavos(economia)}/mês` + (billing === 'annual' ? ` (R$ ${fmtCentavos(economia*12)}/ano)` : '');
  } else {
    economiaEl.textContent = '';
  }

  const params = new URLSearchParams({ qty5:quantities['5gb'], qty25:quantities['25gb'], qty50:quantities['50gb'], cycle:billing });
  if (isEmpty) {
    ctaBtn.removeAttribute('href');
    ctaBtn.setAttribute('role', 'link');
    ctaBtn.setAttribute('aria-disabled', 'true');
  } else {
    ctaBtn.href = `checkout.html?${params}`;
    ctaBtn.removeAttribute('role');
    ctaBtn.removeAttribute('aria-disabled');
  }
  ctaBtn.style.pointerEvents = isEmpty ? 'none' : 'all';
  ctaBtn.style.opacity = isEmpty ? '0.45' : '1';
}

// ---- DOMAIN SEARCH ----
let selectedTld = '.com.br';
document.querySelectorAll('.tld-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.tld-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    selectedTld = chip.dataset.tld;
    document.getElementById('domainSuffix').textContent = selectedTld;
  });
});

function checkDomain() {
  const input = document.getElementById('domainInput').value.trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  const result = document.getElementById('domainResult');
  if (!input) { result.innerHTML = ''; return; }

  result.innerHTML = '<span class="domain-loading"><svg class="icon icon-spin" aria-hidden="true"><use href="assets/icons.svg#loader-circle"></use></svg> Verificando disponibilidade…</span>';

  // Simulate async check (replace with real API call)
  setTimeout(() => {
    const full = input + selectedTld;
    // Demo: domains containing "citmail" or "test" are "taken"
    const taken = input.includes('citmail') || input === 'google' || input === 'microsoft';
    const strong = document.createElement('strong');
    strong.textContent = full;
    const span = document.createElement('span');
    span.className = taken ? 'domain-taken' : 'domain-available';
    span.innerHTML = `<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#${taken ? 'x' : 'check'}"></use></svg> `;
    span.append(strong, taken
      ? ' parece já estar registrado. Tente outro nome ou extensão.'
      : ' parece disponível. A confirmação é feita na contratação. ');
    if (!taken) {
      const contratar = document.createElement('a');
      contratar.href = '#pricing';
      contratar.className = 'domain-contratar';
      contratar.textContent = 'Contratar →';
      span.append(contratar);
    }
    result.replaceChildren(span);
  }, 1200);
}

document.getElementById('domainInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') checkDomain();
});

// ---- FAQ ACCORDION ----
function toggleFaq(btn) {
  const item = btn.closest('.faq-item');
  const isOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}

// ---- INTERSECTION OBSERVER (fade-in) ----
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });
document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));

// ---- VÍNCULOS (sem handlers inline, CSP script-src 'self') ----
document.getElementById('domainCheckBtn').addEventListener('click', () => checkDomain());
document.getElementById('toggleMonthly')?.addEventListener('click', () => setBilling('monthly'));
document.getElementById('billingToggle')?.addEventListener('click', () => toggleBilling());
document.getElementById('toggleAnnual')?.addEventListener('click', () => setBilling('annual'));
document.querySelectorAll('button[data-qtd-tipo]').forEach(btn => {
  btn.addEventListener('click', e => changeQty(e.currentTarget.dataset.qtdTipo, Number(e.currentTarget.dataset.qtdDelta)));
});
document.querySelectorAll('input[data-qtd-tipo]').forEach(input => {
  input.addEventListener('change', e => updateQty(e.currentTarget.dataset.qtdTipo, e.currentTarget.value));
});
document.querySelectorAll('[data-faq-toggle]').forEach(btn => {
  btn.addEventListener('click', e => toggleFaq(e.currentTarget));
});
function voltarAoTopo() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.getElementById('scrollTop').addEventListener('click', voltarAoTopo);

// Cards e resumo dependem do JS (preços vêm de assets/precos.js): calcula na carga.
recalcAll();
