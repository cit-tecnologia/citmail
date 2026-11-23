// Guarda de carga: sem assets/precos.js (ou com uma versão antiga, sem PRECOS.dominio ou PRECOS.limites) não há preço a exibir; avisa no lugar dos preços e do resumo e para aqui.
if (typeof PRECOS === 'undefined' || !Number.isInteger(PRECOS.dominio) || !PRECOS.limites) {
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
  limparErroDominio('fDomNew', 'err-dom-new');
  limparErroDominio('fDomExist', 'err-dom-exist');
  if (choice === 'new-br') {
    document.getElementById('domNewTld').textContent = '.com.br';
    document.getElementById('domPixDesc').textContent = `Registrar domínio .com.br — R$ ${fmtCentavos(PRECOS.dominio)}/ano`;
    document.getElementById('domPixCode').textContent = genFakePix(PRECOS.dominio / 100);
    startDomPixTimer();
  } else {
    clearInterval(domPixIntvl);
  }
  agendarOrcamento();
}

function limparErroDominio(campoId, erroId) {
  const erro = document.getElementById(erroId);
  erro.classList.remove('visible');
  erro.textContent = '';
  document.getElementById(campoId).removeAttribute('aria-invalid');
}

function onDomNewInput() {
  limparErroDominio('fDomNew', 'err-dom-new');
}

function onDomExistInput() {
  limparErroDominio('fDomExist', 'err-dom-exist');
}

// Normaliza o que o cliente digitou: minúsculas, sem "www." inicial e sem ponto final (e, no novo domínio, sem ".com.br").
function normalizarDominioNovo(v) {
  return v.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '').replace(/\.com\.br$/, '');
}
function normalizarDominioExistente(v) {
  return v.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}
// .com.br: 2 a 26 caracteres a-z/0-9/hífen, sem hífen nas pontas, não só números, sem "--" nas posições 3-4 (posições contadas a partir de 1; no código, slice(2, 4) = índices 2-3).
function dominioNovoValido(n) {
  return /^[a-z0-9][a-z0-9-]{0,24}[a-z0-9]$/.test(n) && !/^[0-9]+$/.test(n) && n.slice(2, 4) !== '--';
}
function dominioExistenteValido(d) {
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);
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

function goStep2Next() {
  const errEl = document.getElementById('step2Error');
  if (!Object.keys(DOMAIN_OPTS).includes(domainChoice)) { errEl.style.display = 'flex'; return; }
  const campoInvalido = (campo, erroId, msg) => {
    showErr(erroId, msg);
    campo.setAttribute('aria-invalid', 'true');
    campo.focus();
  };
  if (domainChoice === 'new-br') {
    const campo = document.getElementById('fDomNew');
    const bruto = campo.value.trim();
    const name = normalizarDominioNovo(bruto);
    if (!bruto) { campoInvalido(campo, 'err-dom-new', 'Informe o nome do domínio.'); return; }
    if (!dominioNovoValido(name)) { campoInvalido(campo, 'err-dom-new', 'Use de 2 a 26 letras, números ou hífen, sem hífen no início ou no fim e não só números.'); return; }
    campo.value = name;
    document.getElementById('successWebmail').textContent = 'webmail.' + name + '.com.br';
  }
  if (domainChoice === 'existing') {
    const campo = document.getElementById('fDomExist');
    const bruto = campo.value.trim();
    const d = normalizarDominioExistente(bruto);
    if (!bruto) { campoInvalido(campo, 'err-dom-exist', 'Informe seu domínio.'); return; }
    if (!dominioExistenteValido(d)) { campoInvalido(campo, 'err-dom-exist', 'Domínio inválido. Ex.: minhaempresa.com.br'); return; }
    campo.value = d;
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

// Quantidade do add-on entre 0 e o teto (tetoAddon, assets/precos.js: depende do total de contas; sem contas, 0).
function limitarAddon(key, q) {
  return Math.min(Math.max(0, q), tetoAddon(key, totalAccounts()));
}

function addonChange(key, delta) {
  const q = limitarAddon(key, (addonQtys[key] || 0) + delta);
  if (q !== (addonQtys[key] || 0)) document.getElementById('addonsAjusteAviso').textContent = '';
  addonQtys[key] = q;
  const inp = document.getElementById(ADDONS[key].qtd);
  if (inp) inp.value = q;
  refreshAddons();
}

function addonInput(key, raw) {
  const q = limitarAddon(key, parseInt(raw) || 0);
  if (q !== (addonQtys[key] || 0)) document.getElementById('addonsAjusteAviso').textContent = '';
  addonQtys[key] = q;
  // O campo mostra o que é cobrado (ex.: -3 → 0, 2.7 → 2, acima do teto → teto).
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

// Leva cada add-on ao teto do total de contas atual e atualiza o max dos campos. Chamado quando as contas mudam
// (e na carga): se algum add-on desceu, avisa em #addonsAjusteAviso; senão, limpa o aviso.
// Não renderiza: quem chama renderiza em seguida (refreshAddons).
function ajustarAddonsAoTeto() {
  let ajustou = false;
  Object.entries(ADDONS).forEach(([key, cfg]) => {
    const teto = tetoAddon(key, totalAccounts());
    if (addonQtys[key] > teto) { addonQtys[key] = teto; ajustou = true; }
    const inp = document.getElementById(cfg.qtd);
    if (inp) { inp.max = teto; inp.value = addonQtys[key]; }
  });
  document.getElementById('addonsAjusteAviso').textContent = ajustou
    ? 'Os add-ons foram ajustados ao número de contas escolhido.'
    : '';
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
  agendarOrcamento();
}

/* ================================================================
   ACCOUNT TYPES DATA
================================================================ */
// Mínimo por tipo vem de PRECOS.limites (assets/precos.js); o teto é PRECOS.limites.contasPorTipo.
const ACCOUNT_DEFS = {
  '5gb':  { min: PRECOS.limites.minimoPorTipo['5gb'], label: 'E-mail 5 GB', unitId:'ckUnit5',  qtyId:'ckQty5',  subId:'ckSub5',  discId:'ckDisc5',  cardId:'ckCard5'  },
  '25gb': { min: PRECOS.limites.minimoPorTipo['25gb'], label: 'E-mail 25 GB', unitId:'ckUnit25', qtyId:'ckQty25', subId:'ckSub25', discId:'ckDisc25', cardId:'ckCard25' },
  '50gb': { min: PRECOS.limites.minimoPorTipo['50gb'], label: 'E-mail 50 GB', unitId:'ckUnit50', qtyId:'ckQty50', subId:'ckSub50', discId:'ckDisc50', cardId:'ckCard50' },
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

// quantidade inteira entre 0 e o teto do tipo; abaixo do mínimo do tipo sobe ao mínimo, ou zera ao diminuir
// regra duplicada em normalizeQty (landing.js): manter as duas iguais
function ckNormalizeQty(type, raw, delta = 0) {
  const min = ACCOUNT_DEFS[type].min;
  const q   = Math.min(Math.max(0, parseInt(raw)||0), PRECOS.limites.contasPorTipo);
  if (q > 0 && q < min) return delta < 0 ? 0 : min;
  return q;
}
function ckChangeQty(type, delta) {
  const d = ACCOUNT_DEFS[type];
  const q = ckNormalizeQty(type, ckQtys[type] + delta, delta);
  ckQtys[type] = q;
  document.getElementById(d.qtyId).value = q;
  ajustarAddonsAoTeto();
  renderContas();
  refreshAddons();
}
function ckUpdateQty(type, raw) {
  const d = ACCOUNT_DEFS[type];
  const q = ckNormalizeQty(type, raw);
  ckQtys[type] = q;
  document.getElementById(d.qtyId).value = q;
  ajustarAddonsAoTeto();
  renderContas();
  refreshAddons();
}

function ckRefresh() {
  renderContas();
  updateSummary();
  updateInstallments();
  agendarOrcamento();
}

function renderContas() {
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
    if (i < n || i === 6) sc.innerHTML = '<svg class="icon icon--step-check" aria-hidden="true"><use href="assets/icons.svg#check"></use></svg>';
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
  if (ultimoOrcamentoConfirmado) { renderResumoApi(ultimoOrcamentoConfirmado.resposta); return; }
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
  const total = (ultimoOrcamentoConfirmado ? ultimoOrcamentoConfirmado.resposta.totais.recorrente_mensal_centavos : grandTotalCentavos()) / 100;
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
   ORÇAMENTO DA API (POST /api/orcamento) — só quando a origem da página está em ORIGENS_API
================================================================ */
// Origem da página → origem da API. Fora do mapa (Pages, homologação, 127.0.0.1) o checkout fica no modo local.
// As origens publicadas entram com a #57, junto do connect-src da CSP.
const ORIGENS_API = Object.freeze({ 'http://localhost:4200': 'http://localhost:4200' });
const ORCAMENTO_DEBOUNCE_MS = 300;
const ORCAMENTO_TIMEOUT_MS  = 8000;
const TIPOS_DOMINIO_API = { 'new-br': 'novo', 'existing': 'existente' };
const CAMPOS_TOTAIS = ['recorrente_mensal_centavos', 'recorrente_ciclo_centavos', 'tabela_mensal_centavos', 'economia_mensal_centavos', 'avulso_centavos'];

// { corpo, versao_tabela, total_exibido_centavos, resposta } do último 200 válido; null desde a mudança até a nova confirmação.
let ultimoOrcamentoConfirmado = null;
let estadoOrcamento = 'local';      // 'local' | 'vazio' | 'pendente' | 'confirmado' | 'falha'
let seqOrcamento = 0;               // só a resposta da sequência mais recente é aplicada
let controladorOrcamento = null;    // AbortController da requisição em voo
let temporizadorOrcamento = null;   // debounce
let reenviosAuto = 0;               // novas tentativas automáticas após 400 (máx. 1 por mudança do usuário)
let normalizandoOrcamento = false;  // true enquanto a página corrige campos por causa de um 400

function origemApi() {
  return Object.prototype.hasOwnProperty.call(ORIGENS_API, location.origin) ? ORIGENS_API[location.origin] : null;
}

// Corpo só com as chaves aceitas pelo schema da API (criarCorpoOrcamento, api/src/precos/rotas.js).
function montarCorpoOrcamento() {
  const corpo = { ciclo: annualBilling ? 'anual' : 'mensal', contas: {} };
  Object.keys(ACCOUNT_DEFS).forEach(tipo => { if (ckQtys[tipo] > 0) corpo.contas[tipo] = ckQtys[tipo]; });
  const addons = {};
  ['talk', 'backup90', 'backup365', 'grupoEmail', 'extraDom'].forEach(key => { if (addonQtys[key] > 0) addons[key] = addonQtys[key]; });
  if (skyboxPlan && addonQtys.skybox > 0) addons.skybox = { plano: skyboxPlan, quantidade: addonQtys.skybox };
  if (Object.keys(addons).length) corpo.addons = addons;
  if (TIPOS_DOMINIO_API[domainChoice]) corpo.dominio = { tipo: TIPOS_DOMINIO_API[domainChoice] };
  return corpo;
}

function inteiroNaoNegativo(v) { return Number.isInteger(v) && v >= 0; }

// 200 só vale com o formato esperado; qualquer desvio é tratado como falha.
function validarRespostaOrcamento(r, ciclo) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.versao_tabela !== 'string' || !r.versao_tabela || r.ciclo !== ciclo) return false;
  if (!Array.isArray(r.itens) || !Array.isArray(r.avulsos) || !r.totais || typeof r.totais !== 'object') return false;
  if (!CAMPOS_TOTAIS.every(c => inteiroNaoNegativo(r.totais[c]))) return false;
  return r.itens.every(it => it && typeof it === 'object'
    && (it.tipo === 'conta' ? Object.prototype.hasOwnProperty.call(ACCOUNT_DEFS, it.chave)
      : it.tipo === 'addon' && Object.prototype.hasOwnProperty.call(ADDONS, it.chave))
    && (it.plano === undefined || (it.chave === 'skybox' && Object.prototype.hasOwnProperty.call(ADDONS.skybox.planos, it.plano)))
    && inteiroNaoNegativo(it.quantidade) && inteiroNaoNegativo(it.subtotal_centavos) && inteiroNaoNegativo(it.tabela_centavos)
    && Array.isArray(it.descontos)
    && it.descontos.every(d => d && typeof d.rotulo === 'string' && inteiroNaoNegativo(d.valor_centavos)));
}

function definirEstadoOrcamento(estado) {
  estadoOrcamento = estado;
  const card = document.querySelector('#orderSummary > .card');
  const resumo = document.getElementById('orderSummary');
  document.getElementById('orcamentoEstado').hidden = estado !== 'pendente' && estado !== 'falha';
  document.getElementById('orcamentoStatus').textContent = estado === 'pendente' ? 'Confirmando o valor…' : '';
  document.getElementById('orcamentoAlerta').hidden = estado !== 'falha';
  if (estado === 'pendente') card.setAttribute('aria-busy', 'true');
  else card.removeAttribute('aria-busy');
  if (estado === 'confirmado') {
    resumo.dataset.totalConfirmado = String(ultimoOrcamentoConfirmado.total_exibido_centavos);
    resumo.dataset.versaoTabela = ultimoOrcamentoConfirmado.versao_tabela;
  } else {
    delete resumo.dataset.totalConfirmado;
    delete resumo.dataset.versaoTabela;
  }
}

// Chamado a cada mudança da seleção: anula o confirmado, põe em pendente na hora e agenda o envio (debounce).
// Durante a correção de um 400 só marca pendente: quem corrige envia a nova tentativa.
function agendarOrcamento() {
  if (!origemApi()) return;
  clearTimeout(temporizadorOrcamento);
  seqOrcamento++;
  if (controladorOrcamento) { controladorOrcamento.abort(); controladorOrcamento = null; }
  if (!normalizandoOrcamento) reenviosAuto = 0;
  const tinhaConfirmado = ultimoOrcamentoConfirmado !== null;
  ultimoOrcamentoConfirmado = null;
  if (totalAccounts() === 0) {
    definirEstadoOrcamento('vazio');
  } else {
    definirEstadoOrcamento('pendente');
    if (!normalizandoOrcamento) temporizadorOrcamento = setTimeout(pedirOrcamento, ORCAMENTO_DEBOUNCE_MS);
  }
  if (tinhaConfirmado) { updateSummary(); updateInstallments(); }
}

async function pedirOrcamento() {
  const origem = origemApi();
  if (!origem || totalAccounts() === 0) return;
  clearTimeout(temporizadorOrcamento);
  if (controladorOrcamento) controladorOrcamento.abort();
  const seq = ++seqOrcamento;
  const corpo = montarCorpoOrcamento();
  const controlador = new AbortController();
  controladorOrcamento = controlador;
  definirEstadoOrcamento('pendente');
  // setTimeout + abort (e não AbortSignal.timeout) para o page.clock dos testes controlar o prazo.
  const prazo = setTimeout(() => controlador.abort(), ORCAMENTO_TIMEOUT_MS);
  let status = 0;
  let dados = null;
  try {
    const r = await fetch(`${origem}/api/orcamento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      credentials: 'omit',
      signal: controlador.signal,
    });
    status = r.status;
    dados = await r.json().catch(() => null);
  } catch {
    status = 0;
  } finally {
    clearTimeout(prazo);
  }
  if (seq !== seqOrcamento) return;   // resposta antiga (ou abortada por uma mais nova): ignora
  controladorOrcamento = null;
  if (status === 200 && validarRespostaOrcamento(dados, corpo.ciclo)) {
    const t = dados.totais;
    ultimoOrcamentoConfirmado = {
      corpo,
      versao_tabela: dados.versao_tabela,
      total_exibido_centavos: t.recorrente_ciclo_centavos + t.avulso_centavos,
      resposta: dados,
    };
    definirEstadoOrcamento('confirmado');
    updateSummary();
    updateInstallments();
    return;
  }
  if (status === 400 && dados && dados.erro === 'validacao' && Array.isArray(dados.campos)) {
    tratarValidacaoOrcamento(dados.campos);
    return;
  }
  definirEstadoOrcamento('falha');
}

// 400 de validação: marca e normaliza os campos acusados (contas.<tipo>, addons.<chave>[.…]); se algo mudou e ainda não
// houve nova tentativa automática nesta mudança do usuário, reenvia uma vez; senão, falha genérica.
function tratarValidacaoOrcamento(campos) {
  let mudou = false;
  campos.forEach(c => {
    if (!c || typeof c.campo !== 'string') return;
    const [grupo, chave] = c.campo.split('.');
    if (grupo === 'contas' && Object.prototype.hasOwnProperty.call(ACCOUNT_DEFS, chave)) {
      const inp = document.getElementById(ACCOUNT_DEFS[chave].qtyId);
      inp.setAttribute('aria-invalid', 'true');
      const q = ckNormalizeQty(chave, ckQtys[chave]);
      if (q !== ckQtys[chave]) { ckQtys[chave] = q; inp.value = q; mudou = true; }
    } else if (grupo === 'addons' && Object.prototype.hasOwnProperty.call(ADDONS, chave)) {
      const inp = document.getElementById(ADDONS[chave].qtd);
      if (inp) inp.setAttribute('aria-invalid', 'true');
      const atual = addonQtys[chave] || 0;
      const q = limitarAddon(chave, atual);
      if (q !== atual) { addonQtys[chave] = q; if (inp) inp.value = q; mudou = true; }
    }
  });
  if (!mudou || reenviosAuto >= 1) { definirEstadoOrcamento('falha'); return; }
  reenviosAuto++;
  normalizandoOrcamento = true;
  try {
    ajustarAddonsAoTeto();
    renderContas();
    refreshAddons();
  } finally {
    normalizandoOrcamento = false;
  }
  pedirOrcamento();
}

function tentarOrcamentoDeNovo() {
  reenviosAuto = 0;
  pedirOrcamento();
}

// Guarda de #btnSubmitCadastro e #btnPagar: no modo API só avança com orçamento confirmado.
function orcamentoLiberaAvanco() {
  if (!origemApi() || ultimoOrcamentoConfirmado) return true;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const bloco = document.getElementById('orcamentoEstado');
  if (!bloco.hidden) bloco.scrollIntoView({ behavior, block: 'center' });
  if (estadoOrcamento === 'falha') document.getElementById('btnOrcamentoRetry').focus({ preventScroll: true });
  return false;
}

// Resumo a partir da resposta da API: mesmas classes e textos do modo local; dado da resposta só por textContent.
function elementoResumo(tag, classe, texto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (texto !== undefined) el.textContent = texto;
  return el;
}
function linhaResumoApi(rotulo, valor) {
  const linha = elementoResumo('div', 'sum-line');
  linha.append(elementoResumo('span', '', rotulo), elementoResumo('span', '', `R$ ${fmtCentavos(valor)}`));
  return linha;
}
function cascataResumoApi(tabela, descontos) {
  const NS = 'http://www.w3.org/2000/svg';
  const disc = elementoResumo('div', 'sum-disc');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', 'assets/icons.svg#tag');
  svg.appendChild(use);
  disc.append(svg, ' ');
  const primeiro = elementoResumo('span', 'sum-disc-seg', 'de ');
  primeiro.appendChild(elementoResumo('s', '', `R$ ${fmtCentavos(tabela)}`));
  disc.appendChild(primeiro);
  descontos.forEach(d => {
    disc.append(' · ', elementoResumo('span', 'sum-disc-seg', `${d.rotulo} −R$ ${fmtCentavos(d.valor_centavos)}`));
  });
  return disc;
}
function rotuloItemApi(it) {
  if (it.tipo === 'conta') return `${it.quantidade}× ${ACCOUNT_DEFS[it.chave].label}`;
  const a = ADDONS[it.chave];
  const nome = it.chave === 'skybox' && it.plano ? `${a.rotuloCurto} ${a.planos[it.plano].rotuloCurto}` : a.rotuloCurto;
  return `${nome} ×${it.quantidade}`;
}
function renderResumoApi(r) {
  const anual = r.ciclo === 'anual';
  const t = r.totais;
  document.getElementById('sumCycle').textContent = anual ? 'Cobrança Anual' : 'Cobrança Mensal';
  document.getElementById('sumTotal').textContent = `R$ ${fmtCentavos(t.recorrente_mensal_centavos)}`;
  document.getElementById('sumPeriod').textContent = anual
    ? `/mês · R$ ${fmtCentavos(t.recorrente_ciclo_centavos)}/ano`
    : '/mês';
  const linhas = [];
  r.itens.filter(it => it.quantidade > 0).forEach(it => {
    linhas.push(linhaResumoApi(rotuloItemApi(it), it.subtotal_centavos), cascataResumoApi(it.tabela_centavos, it.descontos));
  });
  const linesEl = document.getElementById('sumAccountLines');
  if (linhas.length) linesEl.replaceChildren(...linhas);
  else linesEl.replaceChildren(elementoResumo('div', 'sum-empty', 'Nenhuma conta selecionada'));
  const economiaEl = document.getElementById('sumEconomia');
  const economia = t.economia_mensal_centavos;
  economiaEl.hidden = !linhas.length;
  economiaEl.textContent = linhas.length
    ? `Você economiza R$ ${fmtCentavos(economia)}/mês` + (anual ? ` (R$ ${fmtCentavos(economia * 12)}/ano)` : '')
    : '';
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
  if (!orcamentoLiberaAvanco()) return;

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
  const price = ultimoOrcamentoConfirmado ? ultimoOrcamentoConfirmado.total_exibido_centavos : grandTotalCentavos();

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
  if (!orcamentoLiberaAvanco()) return;
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
// Conteúdo original de cada botão de cópia e timer da restauração (um por botão).
const conteudoOriginalCopia = new WeakMap();
const temporizadorCopia = new WeakMap();
// Geração do último clique por botão (ignora promessas antigas) e frame pendente da falha por aviso.
const geracaoCopia = new WeakMap();
const quadroAviso = new WeakMap();
// Copia `texto` e dá feedback no botão. opcoes: codigo (elemento selecionado na falha),
// aviso (região role="status" da falha), aoCopiar (substitui o feedback de sucesso do botão).
function copiarComFeedback(botao, texto, opcoes = {}) {
  if (!conteudoOriginalCopia.has(botao)) conteudoOriginalCopia.set(botao, botao.innerHTML);
  const geracao = (geracaoCopia.get(botao) || 0) + 1;
  geracaoCopia.set(botao, geracao);
  function mostrarFeedback(icone, rotulo) {
    clearTimeout(temporizadorCopia.get(botao));
    botao.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#' + icone + '"></use></svg> ' + rotulo;
    temporizadorCopia.set(botao, setTimeout(() => { botao.innerHTML = conteudoOriginalCopia.get(botao); }, 2000));
  }
  function sucesso() {
    if (opcoes.aviso) {
      cancelAnimationFrame(quadroAviso.get(opcoes.aviso));
      opcoes.aviso.textContent = '';
    }
    if (opcoes.aoCopiar) {
      clearTimeout(temporizadorCopia.get(botao));
      botao.innerHTML = conteudoOriginalCopia.get(botao);
      opcoes.aoCopiar();
    } else {
      mostrarFeedback('check', 'Copiado');
    }
  }
  function falha() {
    mostrarFeedback('triangle-alert', 'Erro ao copiar');
    if (opcoes.codigo) window.getSelection().selectAllChildren(opcoes.codigo);
    if (opcoes.aviso) {
      // Limpa e regrava no próximo frame para o leitor de tela reanunciar a mensagem.
      const aviso = opcoes.aviso;
      aviso.textContent = '';
      cancelAnimationFrame(quadroAviso.get(aviso));
      quadroAviso.set(aviso, requestAnimationFrame(() => {
        aviso.textContent = 'Não foi possível copiar automaticamente. O código foi selecionado: copie com Ctrl+C (Cmd+C no Mac) ou, no celular, toque e segure.';
      }));
    }
  }
  // Chamada síncrona no clique (preserva o gesto do usuário); sem clipboard ou exceção = falha tratada.
  let promessa;
  try { promessa = navigator.clipboard.writeText(texto); } catch (err) { falha(); return; }
  const atual = () => geracaoCopia.get(botao) === geracao;
  promessa.then(() => { if (atual()) sucesso(); }, () => { if (atual()) falha(); });
}
// Abre o boleto numa página própria e aciona a impressão, onde o cliente escolhe "Salvar como PDF".
// Escapa texto antes de ir para o HTML do pop-up (o código e o valor do boleto virão do Asaas).
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function downloadBoleto() {
  const code = escHtml(document.getElementById('boletoCode').textContent.trim());
  const total = escHtml(document.getElementById('sumTotal').textContent.trim());
  const w = window.open('', '_blank');
  if (!w) { alert('Permita pop-ups deste site para baixar o boleto em PDF.'); return; }
  // URL absoluta: o about:blank do pop-up não tem a base do checkout. Folha da mesma origem (CSP style-src 'self').
  const folha = new URL('assets/boleto.css?v=1', document.baseURI).href;
  w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Boleto CITMail</title>
    <link rel="stylesheet" href="${folha}">
    </head><body><h1>Boleto CITMail</h1><p>Valor: ${total}</p><p>Linha digitável:<br><code>${code}</code></p>
    <p>Compensação em até 3 dias úteis após o pagamento.</p></body></html>`);
  w.document.close();
  w.focus();
  // Imprime uma única vez, depois que a folha carregar ou falhar (o load dispara também com a folha em cache);
  // se a folha travar, imprime assim mesmo após 3 s.
  const link = w.document.querySelector('link[rel="stylesheet"]');
  let impresso = false;
  const imprimir = () => {
    if (impresso) return;
    impresso = true;
    w.print();
  };
  link.addEventListener('load', imprimir, { once: true });
  link.addEventListener('error', imprimir, { once: true });
  setTimeout(imprimir, 3000);
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
document.getElementById('fDomExist').addEventListener('input', () => onDomExistInput());
document.getElementById('btnCopyDomPix').addEventListener('click', e =>
  copiarComFeedback(e.currentTarget, document.getElementById('domPixCode').textContent,
    { codigo: document.getElementById('domPixCode'), aviso: document.getElementById('domPixCopiaAviso') }));
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
document.getElementById('btnCopyExtraDomPix').addEventListener('click', e =>
  copiarComFeedback(e.currentTarget, document.getElementById('extraDomPixCode').textContent,
    { codigo: document.getElementById('extraDomPixCode'), aviso: document.getElementById('extraDomPixCopiaAviso') }));
document.querySelectorAll('[data-doc-tipo]').forEach(el => {
  el.addEventListener('click', e => setDocType(e.currentTarget.dataset.docTipo));
});
document.getElementById('btnSubmitCadastro').addEventListener('click', () => submitCadastro());
document.querySelectorAll('[data-pagamento]').forEach(el => {
  el.addEventListener('click', e => selectPayment(e.currentTarget.dataset.pagamento));
});
document.getElementById('btnCopyPix').addEventListener('click', e =>
  copiarComFeedback(e.currentTarget, document.getElementById('pixCode').textContent,
    { codigo: document.getElementById('pixCode'), aviso: document.getElementById('pixCopiaAviso') }));
document.getElementById('btnCopyBoleto').addEventListener('click', e =>
  copiarComFeedback(e.currentTarget, document.getElementById('boletoCode').textContent.trim(),
    { codigo: document.getElementById('boletoCode'), aviso: document.getElementById('boletoCopiaAviso'), aoCopiar: () => alert('Código do boleto copiado.') }));
document.getElementById('downloadBoleto').addEventListener('click', () => downloadBoleto());
document.getElementById('fCardNum').addEventListener('input', e => formatCard(e.currentTarget));
document.getElementById('fCardExp').addEventListener('input', e => formatExpiry(e.currentTarget));
document.getElementById('btnPagar').addEventListener('click', () => processPayment());
document.getElementById('btnOrcamentoRetry').addEventListener('click', () => tentarOrcamentoDeNovo());
// aria-invalid posto por um 400 da API só sai quando o usuário mexe no próprio campo (digitando ou nos botões − / +).
document.querySelectorAll('input[data-qtd-conta], input[data-addon]').forEach(el => {
  el.addEventListener('input', e => e.currentTarget.removeAttribute('aria-invalid'));
});
document.querySelectorAll('button[data-qtd-conta]').forEach(el => {
  el.addEventListener('click', e => document.getElementById(ACCOUNT_DEFS[e.currentTarget.dataset.qtdConta]?.qtyId)?.removeAttribute('aria-invalid'));
});
document.querySelectorAll('button[data-addon]').forEach(el => {
  el.addEventListener('click', e => document.getElementById(ADDONS[e.currentTarget.dataset.addon]?.qtd)?.removeAttribute('aria-invalid'));
});

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
  ajustarAddonsAoTeto();
  renderContas();
  refreshAddons();
  updateStepBar(1);
})();
