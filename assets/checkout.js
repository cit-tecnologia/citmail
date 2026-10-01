// Guarda de carga: sem assets/precos.js (ou com uma versão antiga, sem PRECOS.dominio) não há preço a exibir; avisa no lugar dos preços e do resumo e para aqui.
if (typeof PRECOS === 'undefined' || !Number.isInteger(PRECOS.dominio)) {
  const avisoPrecos = '<div class="sum-empty" role="alert">Não foi possível carregar os preços. Recarregue a página.</div>';
  document.getElementById('step1').innerHTML = avisoPrecos;
  document.getElementById('sumAccountLines').innerHTML = avisoPrecos;
  document.querySelector('.summary-total').hidden = true;
  throw new Error('assets/precos.js não carregou: checkout interrompido.');
}
/* ================================================================
   DOMAIN & ADD-ONS STATE
================================================================ */
let domainChoice  = null;   // 'new-br' | 'existing'
let domPixSec     = 1800;
let domPixIntvl   = null;
const addonQtys   = { talk: 0, backup90: 0, backup365: 0, grupoEmail: 0, skybox: 0, extraDom: 0 };
let   skyboxPlan  = null; // '50gb' | '100gb' | '1tb'
let   extraDomPixVal = null; // centavos do último Pix gerado para os domínios extras

/* ---- DOMAIN STEP ---- */
const DOMAIN_OPTS = { 'new-br':'doptBr', 'existing':'doptExist' };
function selectDomainOpt(choice) {
  if (!Object.keys(DOMAIN_OPTS).includes(choice)) return;
  domainChoice = choice;
  Object.values(DOMAIN_OPTS).forEach(id => document.getElementById(id).classList.remove('selected'));
  document.getElementById(DOMAIN_OPTS[choice]).classList.add('selected');
  document.getElementById('domainNewPanel').style.display  = choice === 'new-br' ? 'block' : 'none';
  document.getElementById('domainExistPanel').style.display = choice === 'existing' ? 'block' : 'none';
  document.getElementById('step2Error').style.display = 'none';
  if (choice === 'new-br') {
    document.getElementById('domNewTld').textContent = '.com.br';
    document.getElementById('domPixDesc').textContent = `Registrar domínio .com.br — R$ ${fmtCentavos(PRECOS.dominio)}/ano`;
    document.getElementById('domPixCode').textContent = genFakePix(PRECOS.dominio / 100);
    startDomPixTimer();
  } else {
    clearInterval(domPixIntvl);
  }
}

function onDomNewInput() {
  document.getElementById('err-dom-new').classList.remove('visible');
}

function genFakePix(val) {
  return '00020126580014br.gov.bcb.pix0136a1b2c3d4-e5f6-7890-abcd-ef1234567890' +
    '520400005303986540' + String(val).padStart(6,'0') +
    '5802BR5912CITMail Ltda6009SaoPaulo62070503***6304' + Math.random().toString(36).slice(-4).toUpperCase();
}

function startDomPixTimer() {
  clearInterval(domPixIntvl);
  domPixSec = 1800;
  domPixIntvl = setInterval(() => {
    domPixSec--;
    if (domPixSec <= 0) { clearInterval(domPixIntvl); document.getElementById('domPixCountdown').textContent = 'Pix expirado. Selecione novamente.'; return; }
    const m = Math.floor(domPixSec/60).toString().padStart(2,'0');
    const s = (domPixSec%60).toString().padStart(2,'0');
    document.getElementById('domPixCountdown').textContent = `Pix válido por ${m}:${s}`;
  }, 1000);
}

function copyDomPix() {
  navigator.clipboard.writeText(document.getElementById('domPixCode').textContent).then(() => {
    const btn = document.querySelector('#domPixBox .pix-copy');
    if (btn) { btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#check"></use></svg> Copiado'; setTimeout(() => btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#copy"></use></svg> Copiar', 2000); }
  });
}

function goStep2Next() {
  const errEl = document.getElementById('step2Error');
  if (!Object.keys(DOMAIN_OPTS).includes(domainChoice)) { errEl.style.display = 'flex'; return; }
  if (domainChoice === 'new-br') {
    const name = document.getElementById('fDomNew').value.trim();
    if (!name) { document.getElementById('err-dom-new').classList.add('visible'); return; }
    document.getElementById('successWebmail').textContent = 'webmail.' + name + '.com.br';
  }
  if (domainChoice === 'existing') {
    const d = document.getElementById('fDomExist').value.trim();
    if (!d) { document.getElementById('err-dom-exist').classList.add('visible'); return; }
    document.getElementById('successWebmail').textContent = 'webmail.' + d;
  }
  errEl.style.display = 'none';
  goStep(3);
}

/* ---- ADD-ONS STEP ---- */
// Tabela dos add-ons: nomes e rótulos (valores em centavos vêm de PRECOS, assets/precos.js) usados no passo 3, no painel de
// selecionados e no resumo. `unidade` e `periodo` formam o texto do preço exibido ("/conta/mês").
// Domínio extra é cobrado por ano via Pix separado e fica fora do total mensal.
const ADDONS = {
  talk:       { nome: 'Talk',            rotuloCurto: 'Talk',         centavos: PRECOS.addons.talk,       unidade: 'conta',   periodo: 'mês', linha: 'adTalk',      sub: 'asTalk',      qtd: 'aqTalk' },
  backup90:   { nome: 'Backup 90 dias',  rotuloCurto: 'Backup 90d',   centavos: PRECOS.addons.backup90,   unidade: 'conta',   periodo: 'mês', linha: 'adBackup90',  sub: 'asBackup90',  qtd: 'aqBackup90' },
  backup365:  { nome: 'Backup 365 dias', rotuloCurto: 'Backup 365d',  centavos: PRECOS.addons.backup365,  unidade: 'conta',   periodo: 'mês', linha: 'adBackup365', sub: 'asBackup365', qtd: 'aqBackup365' },
  grupoEmail: { nome: 'Grupo de E-mail', rotuloCurto: 'Grupo E-mail', centavos: PRECOS.addons.grupoEmail, unidade: 'conta',   periodo: 'mês', linha: 'adGrupo',     sub: 'asGrupo',     qtd: 'aqGrupo' },
  skybox:     { nome: 'Skybox',          rotuloCurto: 'Skybox',                     unidade: 'conta',   periodo: 'mês', linha: 'adSkybox',    sub: 'asSkybox',    qtd: 'aqSkybox',
    // Nome acessível do campo contém o texto visível "Quantidade de licenças" (WCAG 2.5.3).
    rotuloQtd: 'Quantidade de licenças de Skybox',
    planos: {
      '50gb':  { centavos: PRECOS.addons.skybox['50gb'],  rotuloCurto: '50GB',  opcao: 'skyOpt50' },
      '100gb': { centavos: PRECOS.addons.skybox['100gb'], rotuloCurto: '100GB', opcao: 'skyOpt100' },
      '1tb':   { centavos: PRECOS.addons.skybox['1tb'],   rotuloCurto: '1TB',   opcao: 'skyOpt1tb' },
    } },
  extraDom:   { nome: 'Domínio extra',   rotuloCurto: 'Domínio extra', centavos: PRECOS.dominio, unidade: 'domínio', periodo: 'ano', linha: 'adExtraDom',  sub: 'asExtraDom',  qtd: 'aqExtraDom' },
};
// Add-ons cobrados na mensalidade, na ordem do painel de selecionados e do resumo.
const ADDONS_MENSAIS = ['talk', 'backup90', 'backup365', 'grupoEmail', 'skybox'];

// Ponto único do cálculo, em centavos: preço unitário (Skybox pelo plano escolhido; sem plano, 0) e valor = qtd × preço.
function precoUnitario(key) {
  if (key === 'skybox') return skyboxPlan ? (ADDONS.skybox.planos[skyboxPlan]?.centavos || 0) : 0;
  return ADDONS[key].centavos;
}
function valorAddon(key) {
  return (addonQtys[key] || 0) * precoUnitario(key);
}
// Rótulo curto da linha (Skybox com o plano, ex.: "Skybox 50GB").
function rotuloAddon(key) {
  const a = ADDONS[key];
  return key === 'skybox' && skyboxPlan ? `${a.rotuloCurto} ${a.planos[skyboxPlan].rotuloCurto}` : a.rotuloCurto;
}
// Linhas mensais com valor (Skybox só com plano e quantidade), usadas no painel de selecionados,
// no resumo e no total. Domínio extra fica fora: é anual, com Pix próprio.
function linhasAddonsMensais() {
  return ADDONS_MENSAIS
    .filter(key => valorAddon(key) > 0)
    .map(key => ({ key, rotulo: rotuloAddon(key), qtd: addonQtys[key], valor: valorAddon(key) }));
}

// Preenche os preços exibidos no passo 3 (atributo data-preco = chave ou "skybox:plano")
// e os nomes acessíveis dos controles de quantidade de cada add-on.
function preencherTextosAddons() {
  document.querySelectorAll('[data-preco]').forEach(el => {
    const [key, plano] = el.dataset.preco.split(':');
    const a = ADDONS[key];
    const preco = plano ? a?.planos?.[plano]?.centavos : a?.centavos;
    if (preco === undefined) { console.warn(`data-preco desconhecido: ${el.dataset.preco}`); return; }
    el.textContent = `R$ ${fmtCentavos(preco)}/${a.unidade}/${a.periodo}`;
    // Riscado irmão com a mesma chave (só add-ons mensais e Skybox; domínio extra não tem)
    const tabelaEl = el.parentElement.querySelector(`[data-preco-tabela="${el.dataset.preco}"]`);
    if (tabelaEl) tabelaEl.textContent = `R$ ${fmtCentavos(tabelaCentavos(preco))}`;
  });
  Object.values(ADDONS).forEach(a => {
    const inp = document.getElementById(a.qtd);
    const ctrl = inp?.closest('.mini-qty-ctrl');
    if (!ctrl) { console.warn(`controle de quantidade não encontrado: #${a.qtd}`); return; }
    inp.setAttribute('aria-label', a.rotuloQtd || `Quantidade de ${a.nome}`);
    ctrl.querySelector('[data-acao="menos"]')?.setAttribute('aria-label', `Diminuir ${a.nome}`);
    ctrl.querySelector('[data-acao="mais"]')?.setAttribute('aria-label', `Aumentar ${a.nome}`);
  });
}

// Seções da sanfona do passo 3 (id do botão = 'sec' + chave). Grupo de E-mail fica fora.
// O período do indicador vem da tabela ADDONS (todos os add-ons de uma seção têm o mesmo).
const SECOES_ADDONS = {
  Armazenamento: { addons: ['skybox'], abertaPorPadrao: true },
  Talk:          { addons: ['talk'] },
  Backup:        { addons: ['backup90', 'backup365'] },
  Dominio:       { addons: ['extraDom'] },
};
// Skybox conta como seleção com plano OU quantidade (critério 5). Hoje a parte do plano não muda
// o resultado, porque Armazenamento já abre por padrão; fica para o caso de o padrão mudar.
function secaoTemSelecao(sec) {
  return sec.addons.some(key => (addonQtys[key] || 0) > 0 || (key === 'skybox' && !!skyboxPlan));
}
function definirSecao(id, aberta) {
  document.getElementById('sec' + id).setAttribute('aria-expanded', String(aberta));
  document.getElementById('sec' + id + 'Painel').hidden = !aberta;
}
function alternarSecao(id) {
  definirSecao(id, document.getElementById('sec' + id).getAttribute('aria-expanded') !== 'true');
  atualizarIndicadoresSecoes();
}
// Estado inicial a cada entrada no passo 3: padrão aberta ou com seleção; demais fechadas.
function abrirSecoesIniciais() {
  Object.entries(SECOES_ADDONS).forEach(([id, sec]) => definirSecao(id, !!sec.abertaPorPadrao || secaoTemSelecao(sec)));
  atualizarIndicadoresSecoes();
}
// Indicador no cabeçalho: subtotal da seção só quando fechada e com valor. O prefixo "subtotal"
// é só para leitor de tela (span .sr-only fixo); sem valor, o indicador inteiro fica hidden.
function atualizarIndicadoresSecoes() {
  Object.entries(SECOES_ADDONS).forEach(([id, sec]) => {
    const aberta = document.getElementById('sec' + id).getAttribute('aria-expanded') === 'true';
    const valor = sec.addons.reduce((s, key) => s + valorAddon(key), 0);
    const texto = !aberta && valor > 0 ? `R$ ${fmtCentavos(valor)}/${ADDONS[sec.addons[0]].periodo}` : '';
    const ind = document.getElementById('sec' + id + 'Ind');
    ind.querySelector('.addon-sec-ind-val').textContent = texto;
    ind.hidden = !texto;
  });
}

function addonChange(key, delta) {
  let q = (addonQtys[key] || 0) + delta;
  if (q < 0) q = 0;
  addonQtys[key] = q;
  const inp = document.getElementById(ADDONS[key].qtd);
  if (inp) inp.value = q;
  refreshAddons();
}

function addonInput(key, raw) {
  const q = Math.max(0, parseInt(raw) || 0);
  addonQtys[key] = q;
  // O campo mostra o que é cobrado (ex.: -3 → 0, 2.7 → 2).
  const inp = document.getElementById(ADDONS[key].qtd);
  if (inp) inp.value = q;
  refreshAddons();
}

function selectSkybox(plan) {
  skyboxPlan = plan;
  Object.entries(ADDONS.skybox.planos).forEach(([p, cfg]) => {
    const el = document.getElementById(cfg.opcao);
    if (el) el.classList.toggle('selected', p === plan);
    const radio = el && el.querySelector('input[type=radio]');
    if (radio) radio.checked = p === plan;
  });
  refreshAddons();
}

function refreshAddons() {
  // Subtotal e estado ativo de cada linha (Skybox sem plano fica em R$ 0,00 e inativo)
  Object.entries(ADDONS).forEach(([key, cfg]) => {
    const val = valorAddon(key);
    const subEl = document.getElementById(cfg.sub);
    if (subEl) subEl.textContent = `R$ ${fmtCentavos(val)}`;
    document.getElementById(cfg.linha)?.classList.toggle('active', val > 0);
  });

  // Extra domain (anual, Pix separado)
  const domQ   = addonQtys.extraDom || 0;
  const domVal = valorAddon('extraDom');
  const pixPanel = document.getElementById('extraDomPixPanel');
  if (pixPanel) {
    pixPanel.style.display = domQ > 0 ? 'block' : 'none';
    if (domQ > 0) {
      document.getElementById('extraDomPixTotal').textContent = `R$ ${fmtCentavos(domVal)}`;
      // refreshAddons roda a cada add-on alterado: o código só é gerado de novo quando o valor muda,
      // para o código já copiado continuar valendo.
      if (domVal !== extraDomPixVal) {
        document.getElementById('extraDomPixCode').textContent = genFakePix(domVal / 100);
        extraDomPixVal = domVal;
      }
    }
  }

  // Subtotal summary panel
  const lines = linhasAddonsMensais();

  const box = document.getElementById('addonsSubtotal');
  if (lines.length) {
    const total = lines.reduce((s,l) => s + l.valor, 0);
    document.getElementById('addonsSubtotalVal').textContent = `+ R$ ${fmtCentavos(total)}/mês`;
    document.getElementById('addonsSubtotalLines').innerHTML = lines.map(l =>
      `<div class="addon-sub-line">
        <span>${l.rotulo}</span><span>R$ ${fmtCentavos(l.valor)}/mês</span>
      </div>`).join('');
    box.style.display = 'block';
  } else {
    box.style.display = 'none';
  }

  updateSummary();
  updateInstallments();
  atualizarIndicadoresSecoes();
}

function copyExtraDomPix() {
  navigator.clipboard.writeText(document.getElementById('extraDomPixCode').textContent).then(() => {
    const btn = document.querySelector('#extraDomPixPanel .pix-copy');
    if (btn) { btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#check"></use></svg> Copiado'; setTimeout(() => btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#copy"></use></svg> Copiar', 2000); }
  });
}

/* ================================================================
   ACCOUNT TYPES DATA
================================================================ */
const ACCOUNT_DEFS = {
  '5gb':  { min: 2, label: 'E-mail 5 GB', unitId:'ckUnit5',  qtyId:'ckQty5',  subId:'ckSub5',  discId:'ckDisc5',  cardId:'ckCard5'  },
  '25gb': { min: 1, label: 'E-mail 25 GB', unitId:'ckUnit25', qtyId:'ckQty25', subId:'ckSub25', discId:'ckDisc25', cardId:'ckCard25' },
  '50gb': { min: 1, label: 'E-mail 50 GB', unitId:'ckUnit50', qtyId:'ckQty50', subId:'ckSub50', discId:'ckDisc50', cardId:'ckCard50' },
};
const ckQtys      = { '5gb': 0, '25gb': 0, '50gb': 0 };
let annualBilling = false;
// domainOk removed — domain handled in step 2
let currentStep   = 1;
let pixInterval   = null;

/* ---- calc helpers ---- */
// Valores em centavos inteiros (PRECOS e funções em assets/precos.js); fmtR só nas parcelas.
function calcDiscount(qty)   { return percentualVolume(qty, annualBilling); }
function fmtR(v)             { return v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function unitPriceCentavos(type) { return unitarioCobradoCentavos(type, ckQtys[type], annualBilling); }
function addonsMonthly()     { return linhasAddonsMensais().reduce((s, l) => s + l.valor, 0); }
function grandTotalCentavos() { return Object.keys(ACCOUNT_DEFS).reduce((s,t) => s + ckQtys[t]*unitPriceCentavos(t), 0) + addonsMonthly(); }
function totalAccounts()     { return Object.values(ckQtys).reduce((a,b) => a+b, 0); }

// quantidade inteira ≥ 0; abaixo do mínimo do tipo sobe ao mínimo, ou zera ao diminuir
// regra duplicada em normalizeQty (index.html): manter as duas iguais
function ckNormalizeQty(type, raw, delta = 0) {
  const min = ACCOUNT_DEFS[type].min;
  const q   = Math.max(0, parseInt(raw)||0);
  if (q > 0 && q < min) return delta < 0 ? 0 : min;
  return q;
}
function ckChangeQty(type, delta) {
  const d = ACCOUNT_DEFS[type];
  const q = ckNormalizeQty(type, ckQtys[type] + delta, delta);
  ckQtys[type] = q;
  document.getElementById(d.qtyId).value = q;
  ckRefresh();
}
function ckUpdateQty(type, raw) {
  const d = ACCOUNT_DEFS[type];
  const q = ckNormalizeQty(type, raw);
  ckQtys[type] = q;
  document.getElementById(d.qtyId).value = q;
  ckRefresh();
}

function ckRefresh() {
  Object.entries(ACCOUNT_DEFS).forEach(([type, d]) => {
    const qty  = ckQtys[type];
    const unit = unitPriceCentavos(type);
    const sub  = qty * unit;
    const disc = calcDiscount(qty);
    const annualDisc = annualBilling ? DESCONTO_ANUAL_PCT : 0;
    document.getElementById(d.unitId).textContent = fmtCentavos(unit);
    document.getElementById(d.subId).textContent  = qty > 0 ? `R$ ${fmtCentavos(sub)}` : 'R$ 0,00';
    // Riscados irmãos: tabela mensal cheia (também no anual) no unitário e qtd × tabela no subtotal
    const card = document.getElementById(d.cardId);
    const tabela = tabelaCentavos(PRECOS.contas[type]);
    card.querySelector(`[data-preco-tabela="conta:${type}"]`).textContent = `R$ ${fmtCentavos(tabela)}`;
    const subTabelaEl = card.querySelector(`[data-preco-tabela="sub:${type}"]`);
    subTabelaEl.textContent = `R$ ${fmtCentavos(qty * tabela)}`;
    subTabelaEl.parentElement.hidden = qty === 0;
    document.getElementById(d.cardId).classList.toggle('has-qty', qty > 0);
    const discEl = document.getElementById(d.discId);
    if (qty > 0 && (disc > 0 || annualDisc > 0)) {
      const parts = [];
      if (annualDisc > 0) parts.push(`−${annualDisc}% anual`);
      if (disc > 0)       parts.push(`−${disc}% volume`);
      discEl.textContent = parts.join(' + ');
    } else if (qty > 0 && !annualBilling) {
      const need = VOLUME_MIN_QTD - qty;
      discEl.textContent = need > 0 ? `Adicione mais ${need} conta(s) para −${DESCONTO_VOLUME_PCT}% volume` : '';
    } else {
      discEl.textContent = '';
    }
  });
  updateSummary();
  updateInstallments();
}

function toggleCycle() {
  annualBilling = !annualBilling;
  document.getElementById('cycleMini').classList.toggle('on', annualBilling);
  document.getElementById('cycleLabel').textContent = annualBilling ? 'Cobrado anualmente (ativo)' : 'Cobrar anualmente';
  ckRefresh();
}

function goStep1Next() {
  const errEl = document.getElementById('step1Error');
  if (totalAccounts() === 0) { errEl.style.display = 'flex'; return; }
  errEl.style.display = 'none';
  goStep(2);
}

/* ================================================================
   STEP NAVIGATION
================================================================ */
// Mesmo limite dos dois @media (max-width: 960px) do CSS (grid em coluna única e resumo não fixo).
const COLUNA_UNICA_MQ = '(max-width: 960px)';
function goStep(n) {
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('step' + n).classList.add('active');
  currentStep = n;
  updateStepBar(n);
  if (n === 3) abrirSecoesIniciais();
  if (n === 5) generatePaymentData();
  // Coluna única: o resumo fica no topo, então rola até a barra de etapas para o passo ficar à vista
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (window.matchMedia(COLUNA_UNICA_MQ).matches) {
    document.getElementById('stepsBar').scrollIntoView({ behavior, block: 'start' });
  } else {
    window.scrollTo({ top: 0, behavior });
  }
}

function updateStepBar(n) {
  for (let i = 1; i <= 6; i++) {
    const sc = document.getElementById('sc' + i);
    const sl = document.getElementById('sl' + i);
    if (!sc) continue;
    sc.className = 'step-circle' + (i < n ? ' done' : i === n ? ' active' : '');
    if (i < n || i === 6) sc.innerHTML = '<svg class="icon" style="font-size:.7rem" aria-hidden="true"><use href="assets/icons.svg#check"></use></svg>';
    else sc.textContent = i;
    if (sl) sl.className = 'step-label' + (i < n ? ' done' : i === n ? ' active' : '');
  }
  for (let i = 1; i <= 5; i++) {
    const conn = document.getElementById('conn' + i);
    if (conn) conn.className = 'step-connector' + (i < n ? ' done' : '');
  }
}

/* ================================================================
   SUMMARY & INSTALLMENTS (account-based)
================================================================ */
// Cascata de um item do resumo: "de R$ T · −15% contratação −R$ A[ · −20% anual −R$ B | · −5% volume −R$ B]".
// Só renderiza o resultado de cascataCentavos (assets/precos.js). Segmentos não quebram por dentro.
function htmlSumDisc(c) {
  const seg = t => `<span class="sum-disc-seg">${t}</span>`;
  const partes = [
    seg(`de <s>R$ ${fmtCentavos(c.tabela)}</s>`),
    ...c.segmentos.map(sg => seg(`${sg.rotulo} −R$ ${fmtCentavos(sg.valor)}`)),
  ];
  return `<div class="sum-disc">
        <svg class="icon" aria-hidden="true"><use href="assets/icons.svg#tag"></use></svg> ${partes.join(' · ')}
      </div>`;
}

function updateSummary() {
  const total = grandTotalCentavos();
  const linesEl = document.getElementById('sumAccountLines');
  document.getElementById('sumCycle').textContent = annualBilling ? 'Cobrança Anual' : 'Cobrança Mensal';
  document.getElementById('sumTotal').textContent = `R$ ${fmtCentavos(total)}`;
  document.getElementById('sumPeriod').textContent = annualBilling
    ? `/mês · R$ ${fmtCentavos(total*12)}/ano`
    : '/mês';

  const names = {'5gb':'E-mail 5 GB','25gb':'E-mail 25 GB','50gb':'E-mail 50 GB'};
  let html = '';
  let hasAny = false;
  let economia = 0;   // Σ por item de (tabela − cobrado), em centavos
  Object.entries(ACCOUNT_DEFS).forEach(([type, d]) => {
    const qty = ckQtys[type];
    if (qty === 0) return;
    hasAny = true;
    const unit = unitPriceCentavos(type);
    const sub  = qty * unit;
    const cascata = cascataCentavos(PRECOS.contas[type], qty, { conta: true, anual: annualBilling });
    economia += cascata.tabela - sub;
    html += `<div class="sum-line">
      <span>${qty}× ${names[type]}</span>
      <span>R$ ${fmtCentavos(sub)}</span>
    </div>`;
    html += htmlSumDisc(cascata);
  });
  // Add-ons lines (sem desconto anual nem de volume: cobrado = atual)
  linhasAddonsMensais().forEach(l => {
    hasAny = true;
    const cascata = cascataCentavos(precoUnitario(l.key), l.qtd);
    economia += cascata.tabela - l.valor;
    html += `<div class="sum-line">
      <span>${l.rotulo} ×${l.qtd}</span>
      <span>R$ ${fmtCentavos(l.valor)}</span>
    </div>`;
    html += htmlSumDisc(cascata);
  });
  linesEl.innerHTML = hasAny ? html
    : '<div class="sum-empty">Nenhuma conta selecionada</div>';

  const economiaEl = document.getElementById('sumEconomia');
  economiaEl.hidden = !hasAny;
  economiaEl.textContent = hasAny
    ? `Você economiza R$ ${fmtCentavos(economia)}/mês` + (annualBilling ? ` (R$ ${fmtCentavos(economia * 12)}/ano)` : '')
    : '';
}

function updateInstallments() {
  const total = grandTotalCentavos() / 100;
  const sel   = document.getElementById('fInstallments');
  if (!sel) return;
  sel.innerHTML = '';
  const maxInst = annualBilling ? 12 : 3;
  for (let n = 1; n <= maxInst; n++) {
    if (![1,2,3,6,12].includes(n)) continue;
    const val = total > 0 ? fmtR(total / n) : '0,00';
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = `${n}× de R$ ${val} (sem juros)`;
    sel.appendChild(opt);
  }
}

/* ================================================================
   FORM — DOCUMENT TYPE
================================================================ */
function setDocType(type) {
  document.getElementById('btnCPF').classList.toggle('active', type === 'cpf');
  document.getElementById('btnCNPJ').classList.toggle('active', type === 'cnpj');
  document.getElementById('cpfRow').style.display  = type === 'cpf'  ? 'grid' : 'none';
  document.getElementById('cnpjRow').style.display = type === 'cnpj' ? 'grid' : 'none';
}

/* ================================================================
   FORM — MASKS
================================================================ */
function maskCPF(v) {
  return v.replace(/\D/g,'').slice(0,11)
    .replace(/(\d{3})(\d)/,'$1.$2')
    .replace(/(\d{3})(\d)/,'$1.$2')
    .replace(/(\d{3})(\d{1,2})$/,'$1-$2');
}
function maskCNPJ(v) {
  return v.replace(/\D/g,'').slice(0,14)
    .replace(/(\d{2})(\d)/,'$1.$2')
    .replace(/(\d{3})(\d)/,'$1.$2')
    .replace(/(\d{3})(\d)/,'$1/$2')
    .replace(/(\d{4})(\d{1,2})$/,'$1-$2');
}
function maskPhone(v) {
  const n = v.replace(/\D/g,'').slice(0,11);
  if (n.length <= 10) return n.replace(/(\d{2})(\d{4})(\d{0,4})/,'($1) $2-$3');
  return n.replace(/(\d{2})(\d{5})(\d{0,4})/,'($1) $2-$3');
}
function maskCEP(v) {
  return v.replace(/\D/g,'').slice(0,8).replace(/(\d{5})(\d{0,3})/,'$1-$2');
}

document.getElementById('fCPF').addEventListener('input', e => { e.target.value = maskCPF(e.target.value); });
document.getElementById('fCNPJ').addEventListener('input', e => { e.target.value = maskCNPJ(e.target.value); });
document.getElementById('fTelefone').addEventListener('input', e => { e.target.value = maskPhone(e.target.value); });
document.getElementById('fCEP').addEventListener('input', e => {
  e.target.value = maskCEP(e.target.value);
  if (e.target.value.replace(/\D/g,'').length === 8) fetchCEP(e.target.value);
});

async function fetchCEP(cep) {
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep.replace(/\D/g,'')}/json/`);
    const d = await r.json();
    if (!d.erro) {
      document.getElementById('fLogradouro').value = d.logradouro || '';
      document.getElementById('fBairro').value     = d.bairro     || '';
      document.getElementById('fCidade').value     = d.localidade || '';
      document.getElementById('fEstado').value     = d.uf         || '';
      document.getElementById('fNumero').focus();
    }
  } catch {}
}

/* ================================================================
   CARD FORMATTING
================================================================ */
function formatCard(el) {
  let v = el.value.replace(/\D/g,'').slice(0,16);
  el.value = v.replace(/(.{4})/g,'$1 ').trim();
  const brands = { visa:'^4', master:'^5[1-5]', elo:'^(4011|4312|4389|4514|4576|5041|5066|5090|6277|6362|6363|6516)', amex:'^3[47]' };
  const icon   = document.getElementById('cardBrandIcon');
  for (const [brand, pattern] of Object.entries(brands)) {
    if (new RegExp(pattern).test(v)) { icon.dataset.brand = brand; return; }
  }
  icon.dataset.brand = '';
}
function formatExpiry(el) {
  let v = el.value.replace(/\D/g,'').slice(0,4);
  if (v.length >= 2) v = v.slice(0,2) + '/' + v.slice(2);
  el.value = v;
}

/* ================================================================
   STEP 4 — VALIDATE & SUBMIT (Cadastro)
================================================================ */
function showErr(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.add('visible'); }
}
function clearErr(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('visible');
}

function submitCadastro() {
  let ok = true;
  const nome  = document.getElementById('fNome').value.trim();
  const email = document.getElementById('fEmail').value.trim();
  const tel   = document.getElementById('fTelefone').value.trim();
  const senha = document.getElementById('fSenha').value;
  const isCPF = document.getElementById('btnCPF').classList.contains('active');
  const cep   = document.getElementById('fCEP').value.trim();
  const terms = document.getElementById('termsCheck').checked;

  clearErr('err-nome'); clearErr('err-email'); clearErr('err-telefone');
  clearErr('err-senha'); clearErr('err-cpf'); clearErr('err-cnpj');
  clearErr('err-razao'); clearErr('err-cep');

  if (nome.split(' ').length < 2) { showErr('err-nome','Informe nome e sobrenome.'); ok = false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('err-email','E-mail inválido.'); ok = false; }
  if (tel.replace(/\D/g,'').length < 10) { showErr('err-telefone','Telefone inválido.'); ok = false; }
  if (senha.length < 8) { showErr('err-senha','Mínimo 8 caracteres.'); ok = false; }
  if (cep.replace(/\D/g,'').length < 8) { showErr('err-cep','CEP inválido.'); ok = false; }
  if (!terms) { alert('Aceite os Termos de Uso e a Política de Privacidade para continuar.'); ok = false; }

  if (isCPF) {
    const cpf = document.getElementById('fCPF').value.replace(/\D/g,'');
    if (cpf.length !== 11) { showErr('err-cpf','CPF deve ter 11 dígitos.'); ok = false; }
  } else {
    const cnpj = document.getElementById('fCNPJ').value.replace(/\D/g,'');
    if (cnpj.length !== 14) { showErr('err-cnpj','CNPJ deve ter 14 dígitos.'); ok = false; }
    if (!document.getElementById('fRazao').value.trim()) { showErr('err-razao','Informe a razão social.'); ok = false; }
  }

  if (!ok) return;

  document.getElementById('successEmail').textContent = email;
  goStep(5);
}

/* ================================================================
   PAYMENT SELECTION
================================================================ */
function selectPayment(type) {
  document.querySelectorAll('.payment-option').forEach(el => el.classList.remove('selected'));
  const map = { pix:'payPix', boleto:'payBoleto', card:'payCard' };
  document.getElementById(map[type]).classList.add('selected');
  const labels = { pix:'Pagar com Pix', boleto:'Gerar Boleto', card:'Pagar com Cartão' };
  document.getElementById('btnPagarLabel').textContent = labels[type];
}

/* ================================================================
   GENERATE PAYMENT DATA (Asaas integration point)
================================================================ */
function generatePaymentData() {
  /*
   * INTEGRAÇÃO ASAAS — substituir por chamadas reais ao backend:
   *
   * 1. POST /backend/create-customer
   *    Body: { nome, email, cpfCnpj, phone, address }
   *    Retorna: { asaasCustomerId }
   *
   * 2. POST /backend/create-subscription
   *    Body: { customerId, planId, cycle, billingType, value }
   *    Retorna: { subscriptionId, pixQrCode, pixCopiaECola, boletoUrl, boletoBarCode }
   *
   * 3. Webhook: POST /backend/asaas-webhook
   *    Evento: PAYMENT_CONFIRMED → provisionar serviço + liberar painel
   */

  // Demo: populate with mock data
  const price = grandTotalCentavos();

  document.getElementById('pixCode').textContent =
    '00020126580014br.gov.bcb.pix0136a1b2c3d4-e5f6-7890-abcd-ef1234567890' +
    '520400005303986540' + reaisTxt(price).padStart(7,'0') +
    '5802BR5912CITMail Ltda6009Sao Paulo62070503***6304ABCD';

  document.getElementById('boletoCode').textContent =
    '34191.09008 05487.010103 0800' + reaisTxt(price) + '.000000 5 0000' + String(price).padStart(14,'0');

  startPixTimer();
}

let pixSeconds = 1800;
function startPixTimer() {
  clearInterval(pixInterval);
  pixSeconds = 1800;
  pixInterval = setInterval(() => {
    pixSeconds--;
    if (pixSeconds <= 0) { clearInterval(pixInterval); document.getElementById('pixCountdown').textContent = 'QR Code expirado. Gere um novo.'; return; }
    const m = Math.floor(pixSeconds / 60).toString().padStart(2,'0');
    const s = (pixSeconds % 60).toString().padStart(2,'0');
    document.getElementById('pixCountdown').textContent = `QR Code válido por ${m}:${s}`;
  }, 1000);
}

/* ================================================================
   PROCESS PAYMENT
================================================================ */
async function processPayment() {
  const overlay = document.getElementById('loadingOverlay');
  const txt     = document.getElementById('loadingText');
  const payPix  = document.getElementById('payPix').classList.contains('selected');
  const payCard = document.getElementById('payCard').classList.contains('selected');

  if (payCard) {
    const num  = document.getElementById('fCardNum').value.replace(/\s/g,'');
    const name = document.getElementById('fCardName').value.trim();
    const exp  = document.getElementById('fCardExp').value;
    const cvv  = document.getElementById('fCardCvv').value;
    if (num.length < 16 || !name || exp.length < 5 || cvv.length < 3) {
      alert('Preencha número, nome, validade e CVV do cartão.');
      return;
    }
  }

  txt.textContent = 'Processando pagamento…';
  overlay.classList.add('active');

  /*
   * INTEGRAÇÃO ASAAS — ponto de chamada:
   *
   * Para PIX/Boleto: o pagamento foi gerado em generatePaymentData().
   * Aqui apenas aguardamos confirmação via polling ou WebSocket.
   *
   * Para cartão:
   * POST /backend/pay-with-card
   * Body: { subscriptionId, cardNumber, holderName, expiryMonth, expiryYear, ccv, installments }
   * Resposta: { success: true } ou { error: 'mensagem' }
   *
   * Após confirmação de qualquer método:
   * POST /backend/provision-service
   * Body: { customerId, subscriptionId, domain, planId }
   * → cria domínio, caixas de e-mail, envia credenciais, libera acesso ao painel
   */

  // Demo: simulate API call delay
  await new Promise(r => setTimeout(r, 2800));

  txt.textContent = 'Ativando seu serviço…';
  await new Promise(r => setTimeout(r, 1500));

  overlay.classList.remove('active');
  clearInterval(pixInterval);
  goStep(6);
}

/* ================================================================
   COPY HELPERS
================================================================ */
function copyPix() {
  const code = document.getElementById('pixCode').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('btnCopyPix');
    btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#check"></use></svg> Copiado';
    setTimeout(() => { btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#copy"></use></svg> Copiar'; }, 2000);
  });
}
// Abre o boleto numa página própria e aciona a impressão, onde o cliente escolhe "Salvar como PDF".
function downloadBoleto() {
  const code = document.getElementById('boletoCode').textContent.trim();
  const total = document.getElementById('sumTotal').textContent.trim();
  const w = window.open('', '_blank');
  if (!w) { alert('Permita pop-ups deste site para baixar o boleto em PDF.'); return; }
  w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Boleto CITMail</title>
    <style>body{font-family:Poppins,system-ui,sans-serif;color:#23344E;padding:40px;line-height:1.6}h1{font-family:Montserrat,system-ui,sans-serif;font-size:22px;font-weight:600}code{font-family:ui-monospace,Consolas,monospace;font-size:16px}</style>
    </head><body><h1>Boleto CITMail</h1><p>Valor: ${total}</p><p>Linha digitável:<br><code>${code}</code></p>
    <p>Compensação em até 3 dias úteis após o pagamento.</p></body></html>`);
  w.document.close();
  w.focus();
  w.print();
}
function copyBoleto() {
  const code = document.getElementById('boletoCode').textContent.trim();
  navigator.clipboard.writeText(code).then(() => alert('Código do boleto copiado.'));
}

/* ================================================================
   VÍNCULOS — cada controle recebe o seu listener no próprio elemento
   (sem handler inline, por causa da CSP). Os aninhados (.pix-copy em
   #payPix, copiar/#downloadBoleto em #payBoleto) disparam o interno e
   depois o externo, por bubbling.
================================================================ */
document.querySelectorAll('button[data-qtd-conta]').forEach(el => {
  el.addEventListener('click', e => ckChangeQty(e.currentTarget.dataset.qtdConta, Number(e.currentTarget.dataset.qtdDelta)));
});
document.querySelectorAll('input[data-qtd-conta]').forEach(el => {
  el.addEventListener('change', e => ckUpdateQty(e.currentTarget.dataset.qtdConta, e.currentTarget.value));
});
document.getElementById('cycleToggle').addEventListener('click', () => toggleCycle());
document.getElementById('btnStep1Next').addEventListener('click', () => goStep1Next());
document.querySelectorAll('[data-dominio-opcao]').forEach(el => {
  el.addEventListener('click', e => selectDomainOpt(e.currentTarget.dataset.dominioOpcao));
});
document.getElementById('fDomNew').addEventListener('input', () => onDomNewInput());
document.getElementById('btnCopyDomPix').addEventListener('click', () => copyDomPix());
document.getElementById('btnStep2Next').addEventListener('click', () => goStep2Next());
document.querySelectorAll('[data-ir-passo]').forEach(el => {
  el.addEventListener('click', e => goStep(Number(e.currentTarget.dataset.irPasso)));
});
document.querySelectorAll('[data-secao]').forEach(el => {
  el.addEventListener('click', e => alternarSecao(e.currentTarget.dataset.secao));
});
document.querySelectorAll('[data-skybox]').forEach(el => {
  el.addEventListener('click', e => selectSkybox(e.currentTarget.dataset.skybox));
});
document.querySelectorAll('button[data-addon]').forEach(el => {
  el.addEventListener('click', e => addonChange(e.currentTarget.dataset.addon, Number(e.currentTarget.dataset.addonDelta)));
});
document.querySelectorAll('input[data-addon]').forEach(el => {
  el.addEventListener('change', e => addonInput(e.currentTarget.dataset.addon, e.currentTarget.value));
});
document.getElementById('btnCopyExtraDomPix').addEventListener('click', () => copyExtraDomPix());
document.querySelectorAll('[data-doc-tipo]').forEach(el => {
  el.addEventListener('click', e => setDocType(e.currentTarget.dataset.docTipo));
});
document.getElementById('btnSubmitCadastro').addEventListener('click', () => submitCadastro());
document.querySelectorAll('[data-pagamento]').forEach(el => {
  el.addEventListener('click', e => selectPayment(e.currentTarget.dataset.pagamento));
});
document.getElementById('btnCopyPix').addEventListener('click', () => copyPix());
document.getElementById('btnCopyBoleto').addEventListener('click', () => copyBoleto());
document.getElementById('downloadBoleto').addEventListener('click', () => downloadBoleto());
document.getElementById('fCardNum').addEventListener('input', e => formatCard(e.currentTarget));
document.getElementById('fCardExp').addEventListener('input', e => formatExpiry(e.currentTarget));
document.getElementById('btnPagar').addEventListener('click', () => processPayment());

/* ================================================================
   INIT — read qty5, qty25, qty50, cycle from URL params
================================================================ */
(function init() {
  const params = new URLSearchParams(window.location.search);
  const qty5   = ckNormalizeQty('5gb',  params.get('qty5'));
  const qty25  = ckNormalizeQty('25gb', params.get('qty25'));
  const qty50  = ckNormalizeQty('50gb', params.get('qty50'));
  const cycle  = params.get('cycle');

  ckQtys['5gb']  = qty5;
  ckQtys['25gb'] = qty25;
  ckQtys['50gb'] = qty50;

  // Set input values
  document.getElementById('ckQty5').value  = qty5;
  document.getElementById('ckQty25').value = qty25;
  document.getElementById('ckQty50').value = qty50;

  if (cycle === 'annual') {
    annualBilling = true;
    document.getElementById('cycleMini').classList.add('on');
    document.getElementById('cycleLabel').textContent = 'Cobrado anualmente (ativo)';
  }

  preencherTextosAddons();
  document.getElementById('doptBrPreco').textContent = `R$ ${fmtCentavos(PRECOS.dominio)}`;
  abrirSecoesIniciais();
  ckRefresh();
  updateStepBar(1);
})();
