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
const addonQtys   = { talk: 0, backup90: 0, backup365: 0, grupoEmail: 0, skybox: 0, extraDom: 0 };
let   skyboxPlan  = null; // '50gb' | '100gb' | '1tb'

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
  if (choice === 'new-br') document.getElementById('domNewTld').textContent = '.com.br';
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

// Marca o campo com a mensagem de erro (sem focar: quem chama foca depois de mostrar o passo).
function marcarCampoInvalido(campo, erroId, msg) {
  showErr(erroId, msg);
  campo.setAttribute('aria-invalid', 'true');
}

// Valida e normaliza o domínio principal (passo 2). Devolve o elemento a focar quando inválido, ou null.
function validarDominioPrincipal() {
  const errEl = document.getElementById('step2Error');
  if (!Object.keys(DOMAIN_OPTS).includes(domainChoice)) { errEl.style.display = 'flex'; return errEl; }
  limparErroDominio('fDomNew', 'err-dom-new');
  limparErroDominio('fDomExist', 'err-dom-exist');
  if (domainChoice === 'new-br') {
    const campo = document.getElementById('fDomNew');
    const bruto = campo.value.trim();
    const name = normalizarDominioNovo(bruto);
    if (!bruto) { marcarCampoInvalido(campo, 'err-dom-new', 'Informe o nome do domínio.'); return campo; }
    if (!dominioNovoValido(name)) { marcarCampoInvalido(campo, 'err-dom-new', 'Use de 2 a 26 letras, números ou hífen, sem hífen no início ou no fim e não só números.'); return campo; }
    campo.value = name;
  }
  if (domainChoice === 'existing') {
    const campo = document.getElementById('fDomExist');
    const bruto = campo.value.trim();
    const d = normalizarDominioExistente(bruto);
    if (!bruto) { marcarCampoInvalido(campo, 'err-dom-exist', 'Informe seu domínio.'); return campo; }
    if (!dominioExistenteValido(d)) { marcarCampoInvalido(campo, 'err-dom-exist', 'Domínio inválido. Ex.: minhaempresa.com.br'); return campo; }
    campo.value = d;
  }
  errEl.style.display = 'none';
  return null;
}

function goStep2Next() {
  const invalido = validarDominioPrincipal();
  if (invalido) { invalido.focus(); return; }
  goStep(3);
}

// Nome completo do domínio principal (novo: "<rótulo>.com.br"; existente: o nome normalizado), para comparar com os extras.
function nomePrincipalCompleto() {
  if (domainChoice === 'new-br') {
    const n = normalizarDominioNovo(document.getElementById('fDomNew').value);
    return n ? `${n}.com.br` : '';
  }
  if (domainChoice === 'existing') return normalizarDominioExistente(document.getElementById('fDomExist').value);
  return '';
}

/* ---- DOMÍNIOS EXTRAS (um campo .com.br por unidade de addonQtys.extraDom, no padrão do #fDomNew) ---- */
function camposExtras() {
  return [...document.querySelectorAll('#domExtrasCampos input')];
}

function criarCampoExtra(i) {
  const id = `fDomExtra${i}`;
  const erroId = `err-dom-extra-${i}`;
  const NS = 'http://www.w3.org/2000/svg';
  const campo = elementoResumo('div', 'field');
  const rotulo = elementoResumo('label', '', `Domínio extra ${i} `);
  rotulo.htmlFor = id;
  rotulo.appendChild(elementoResumo('span', 'req', '*'));
  const linha = elementoResumo('div', 'domain-row');
  const arroba = elementoResumo('div', 'domain-at');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon mr-4');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', 'assets/icons.svg#at-sign');
  svg.appendChild(use);
  arroba.appendChild(svg);
  const input = document.createElement('input');
  Object.assign(input, { type: 'text', id, placeholder: 'outraempresa', inputMode: 'text', spellcheck: false });
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('aria-describedby', erroId);
  input.addEventListener('input', () => limparErroDominio(id, erroId));
  linha.append(arroba, input, elementoResumo('div', 'domain-tld', '.com.br'));
  const erro = elementoResumo('span', 'field-error');
  erro.id = erroId;
  campo.append(rotulo, linha, erro);
  return campo;
}

// Um campo por domínio extra: reduzir remove os últimos e mantém os primeiros; aumentar abre a seção para mostrar o campo novo.
function sincronizarCamposExtras() {
  const box = document.getElementById('domExtrasCampos');
  const qtd = addonQtys.extraDom || 0;
  const antes = box.children.length;
  while (box.children.length > qtd) box.lastElementChild.remove();
  while (box.children.length < qtd) box.appendChild(criarCampoExtra(box.children.length + 1));
  box.hidden = qtd === 0;
  if (qtd > antes) definirSecao('Dominio', true);
}

// Valida e normaliza os extras: vazio, inválido ou repetido (entre si ou com o principal). Devolve o 1º campo inválido, ou null.
function validarDominiosExtras() {
  const principal = nomePrincipalCompleto();
  const vistos = new Set(principal ? [principal] : []);
  let primeiro = null;
  camposExtras().forEach((campo, i) => {
    const erroId = `err-dom-extra-${i + 1}`;
    limparErroDominio(campo.id, erroId);
    const bruto = campo.value.trim();
    const rotulo = normalizarDominioNovo(bruto);
    let msg = '';
    if (!bruto) msg = 'Informe o nome do domínio extra.';
    else if (!dominioNovoValido(rotulo)) msg = 'Domínio inválido.';
    else if (vistos.has(`${rotulo}.com.br`)) msg = 'Domínio repetido.';
    if (msg) {
      marcarCampoInvalido(campo, erroId, msg);
      if (!primeiro) primeiro = campo;
      return;
    }
    campo.value = rotulo;
    vistos.add(`${rotulo}.com.br`);
  });
  return primeiro;
}

function goStep3Next() {
  const invalido = validarDominiosExtras();
  if (invalido) { invalido.focus(); return; }
  goStep(4);
}

/* ---- ADD-ONS STEP ---- */
// Tabela dos add-ons: nomes e rótulos (valores em centavos vêm de PRECOS, assets/precos.js) usados no passo 3, no painel de
// selecionados e no resumo. `unidade` e `periodo` formam o texto do preço exibido ("/conta/mês").
// Domínio extra é cobrado por ano na fatura de domínios e fica fora do total mensal.
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
// no resumo e no total. Domínio extra fica fora: é anual, com fatura própria.
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

  // Domínios extras (anuais, na fatura de domínios): um campo de nome por unidade
  sincronizarCamposExtras();

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

/* ---- calc helpers ---- */
// Valores em centavos inteiros (PRECOS e funções em assets/precos.js).
function calcDiscount(qty)   { return percentualVolume(qty, annualBilling); }
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
  // Estado ambíguo do pedido: a revisão não sai do lugar (o reenvio usa o corpo guardado).
  if (pedidoAmbiguo && n !== 5) return;
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('step' + n).classList.add('active');
  currentStep = n;
  updateStepBar(n);
  if (n === 3) abrirSecoesIniciais();
  if (n === 5) renderRevisao();
  // Coluna única: o resumo fica no topo, então rola até a barra de etapas para o passo ficar à vista
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (window.matchMedia(COLUNA_UNICA_MQ).matches) {
    document.getElementById('stepsBar').scrollIntoView({ behavior, block: 'start' });
  } else {
    window.scrollTo({ top: 0, behavior });
  }
}

function updateStepBar(n) {
  for (let i = 1; i <= 5; i++) {
    const sc = document.getElementById('sc' + i);
    const sl = document.getElementById('sl' + i);
    if (!sc) continue;
    sc.className = 'step-circle' + (i < n ? ' done' : i === n ? ' active' : '');
    if (i < n) sc.innerHTML = '<svg class="icon icon--step-check" aria-hidden="true"><use href="assets/icons.svg#check"></use></svg>';
    else sc.textContent = i;
    if (sl) sl.className = 'step-label' + (i < n ? ' done' : i === n ? ' active' : '');
  }
  for (let i = 1; i <= 4; i++) {
    const conn = document.getElementById('conn' + i);
    if (conn) conn.className = 'step-connector' + (i < n ? ' done' : '');
  }
}

/* ================================================================
   SUMMARY (account-based)
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

/* ================================================================
   ORÇAMENTO DA API (POST /api/orcamento) — só quando a origem da página está em ORIGENS_API
================================================================ */
// Origem da página → origem da API. Fora do mapa (Pages, homologação, 127.0.0.1) o checkout fica no modo local.
// As origens publicadas entram com a #57, junto do connect-src da CSP.
const ORIGENS_API = Object.freeze({ 'http://localhost:4200': 'http://localhost:4200' });
const ORCAMENTO_DEBOUNCE_MS = 300;
const ORCAMENTO_TIMEOUT_MS  = 8000;
const TIPOS_DOMINIO_API = { 'new-br': 'novo', 'existing': 'existente' };
// Rótulos dos avulsos da resposta (cobrados à parte, por ano), com os nomes que o checkout já usa.
const ROTULOS_AVULSOS = { dominio_principal: 'Domínio .com.br', dominio_extra: ADDONS.extraDom.rotuloCurto };
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
    && it.descontos.every(d => d && typeof d.rotulo === 'string' && inteiroNaoNegativo(d.valor_centavos)))
    && r.avulsos.every(av => av && Object.prototype.hasOwnProperty.call(ROTULOS_AVULSOS, av.tipo)
      && inteiroNaoNegativo(av.quantidade) && inteiroNaoNegativo(av.subtotal_centavos));
}

function definirEstadoOrcamento(estado) {
  estadoOrcamento = estado;
  const resumo = document.getElementById('orderSummary');
  document.getElementById('orcamentoEstado').hidden = estado !== 'pendente' && estado !== 'falha';
  document.getElementById('orcamentoStatus').textContent = estado === 'pendente' ? 'Confirmando o valor…' : '';
  document.getElementById('orcamentoAlerta').hidden = estado !== 'falha';
  // aria-busy só nos valores (não no card): o #orcamentoStatus (role=status) continua anunciável no pendente.
  ['sumAccountLines', 'summaryTotal'].forEach(id => {
    const el = document.getElementById(id);
    if (estado === 'pendente') el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
  });
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
  if (tinhaConfirmado) updateSummary();
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
  const reenviar = mudou && reenviosAuto < 1;
  if (mudou) {
    // Mostra os valores corrigidos também quando não há nova tentativa (ex.: 2º 400 acusando outro campo).
    normalizandoOrcamento = true;
    try {
      ajustarAddonsAoTeto();
      renderContas();
      refreshAddons();
    } finally {
      normalizandoOrcamento = false;
    }
  }
  if (!reenviar) { definirEstadoOrcamento('falha'); return; }
  reenviosAuto++;
  pedirOrcamento();
}

function tentarOrcamentoDeNovo() {
  reenviosAuto = 0;
  pedirOrcamento();
}

// Guarda de #btnSubmitCadastro e #btnIrPagamento: no modo API só avança com orçamento confirmado.
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
  // Avulsos (domínio principal e extras): cobrados à parte, por ano; entram no total do pedido.
  if (linhas.length) {
    r.avulsos.filter(av => av.quantidade > 0).forEach(av => {
      const linha = linhaResumoApi(`${ROTULOS_AVULSOS[av.tipo]} ×${av.quantidade}`, av.subtotal_centavos);
      linha.lastChild.textContent += '/ano';
      linhas.push(linha);
    });
  }
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
  ['fCPF', 'fCNPJ'].forEach(id => limparMarcaCadastro(id));
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
// Campos do cadastro e o elemento de erro de cada um (marcados por um 400 do pedido).
const ERROS_CADASTRO = { fNome: 'err-nome', fEmail: 'err-email', fTelefone: 'err-telefone', fCPF: 'err-cpf', fCNPJ: 'err-cnpj' };
function limparMarcaCadastro(id) {
  document.getElementById(id).removeAttribute('aria-invalid');
  clearErr(ERROS_CADASTRO[id]);
}

function submitCadastro() {
  let ok = true;
  const nome  = document.getElementById('fNome').value.trim();
  const email = document.getElementById('fEmail').value.trim();
  const tel   = document.getElementById('fTelefone').value.trim();
  const isCPF = document.getElementById('btnCPF').classList.contains('active');
  const cep   = document.getElementById('fCEP').value.trim();
  const terms = document.getElementById('termsCheck').checked;

  ['fNome', 'fEmail', 'fTelefone', 'fCPF', 'fCNPJ'].forEach(id => limparMarcaCadastro(id));
  clearErr('err-nome'); clearErr('err-email'); clearErr('err-telefone');
  clearErr('err-cpf'); clearErr('err-cnpj');
  clearErr('err-razao'); clearErr('err-cep');

  if (nome.split(' ').length < 2) { showErr('err-nome','Informe nome e sobrenome.'); ok = false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('err-email','E-mail inválido.'); ok = false; }
  if (tel.replace(/\D/g,'').length < 10) { showErr('err-telefone','Telefone inválido.'); ok = false; }
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

  goStep(5);
}

/* ================================================================
   STEP 5 — REVISÃO
================================================================ */
// Domínio novo (principal ou extra) tem registro manual: o aviso de prazo aparece na revisão.
function temDominioNovo() {
  return domainChoice === 'new-br' || (addonQtys.extraDom || 0) > 0;
}

function itemRevisao(rotulo, valor) {
  const item = elementoResumo('div', 'revisao-item');
  item.append(elementoResumo('dt', 'revisao-rotulo', rotulo), elementoResumo('dd', 'revisao-valor', valor));
  return item;
}

// Resumo do que foi preenchido, só por textContent (o total fica no resumo do pedido).
function renderRevisao() {
  const contas = Object.entries(ACCOUNT_DEFS).filter(([t]) => ckQtys[t] > 0).map(([t, d]) => `${ckQtys[t]}× ${d.label}`);
  const addons = linhasAddonsMensais().map(l => `${l.rotulo} ×${l.qtd}`);
  const principal = nomePrincipalCompleto();
  const extras = camposExtras().map(c => normalizarDominioNovo(c.value)).filter(Boolean).map(r => `${r}.com.br`);
  const isCPF = document.getElementById('btnCPF').classList.contains('active');
  const valor = id => document.getElementById(id).value.trim() || '—';
  const itens = [
    itemRevisao('Contas', contas.join(', ') || '—'),
    itemRevisao('Cobrança', annualBilling ? 'Anual' : 'Mensal'),
    itemRevisao('Domínio', principal ? `${principal}${domainChoice === 'new-br' ? ' (registro novo)' : ' (domínio existente)'}` : '—'),
  ];
  if (extras.length) itens.push(itemRevisao('Domínios extras', extras.join(', ')));
  if (addons.length) itens.push(itemRevisao('Add-ons', addons.join(', ')));
  itens.push(
    itemRevisao('Nome', valor('fNome')),
    itemRevisao('E-mail', valor('fEmail')),
    itemRevisao('Telefone', valor('fTelefone')),
    isCPF ? itemRevisao('CPF', valor('fCPF')) : itemRevisao('CNPJ', valor('fCNPJ')),
  );
  document.getElementById('revisaoResumo').replaceChildren(...itens);
  document.getElementById('revisaoAvisoDominio').hidden = !temDominioNovo();
  // Erro de uma tentativa anterior sai ao voltar à revisão, salvo quando a edição está travada ou o envio, bloqueado.
  if (!pedidoAmbiguo && !pedidoBloqueado) limparErroPedido();
  atualizarBotaoPedido();
}

/* ================================================================
   PEDIDO (POST /api/pedidos) — só no modo API (origemApi())
================================================================ */
// Versões do aceite: iguais às vigentes na API (api/src/pedidos/aceite.js) e à de termos.html (#termosVersao).
const VERSAO_TERMOS = '0.1';
const VERSAO_PRIVACIDADE = 'externa-2026-11-23';
// Hosts aceitos para a fatura (igualdade exata): fora deles o comprador não é levado à URL recebida.
const HOSTS_FATURA = Object.freeze(['www.asaas.com', 'sandbox.asaas.com']);
const PEDIDO_TIMEOUT_MS = 90000;
const CONTATO_COMERCIAL = 'comercial@citmail.com.br';
const MSG_PEDIDO_GENERICA = 'Não foi possível gerar a fatura agora. Tente novamente.';
const MSG_PEDIDO_AMBIGUO = 'Seu pedido pode já ter sido criado. Tente de novo para recuperar a fatura; não altere os dados.';

// Regra da chave de idempotência (ADR 0014): a chave nasce no 1º envio e vive só em memória com o corpo enviado.
// Falha definitiva → chave nova no próximo envio; ambígua (inclusive o 1º 500 interno) → mesma chave e mesmo corpo,
// com a edição travada até um 201 ou uma resposta definitiva. O 2º 500 interno seguido na mesma chave é definitivo
// (o servidor pode ter gravado a falha e repetir o 500): chave nova e edição destravada.
let chavePedido = null;          // UUID em uso (null = o próximo envio gera outra)
let corpoPedidoEnviado = null;   // JSON do último envio (reenviado byte a byte no estado ambíguo)
let pedidoEnviando = false;      // guarda contra clique duplo (não depende só do disabled)
let pedidoAmbiguo = false;       // o pedido pode já existir
let pedidoBloqueado = false;     // sem novo envio pela página (404 ou chave reutilizada no ambíguo)
let pedidoConcluido = false;     // 201 válido: nada de 2º pedido na mesma página
let passoComErroPedido = null;   // 1º passo com campo acusado por um 400 (destino de #btnPedidoRevisar)
let ultimoErroInterno = false;   // a resposta anterior desta chave foi 500 interno

function urlFaturaSegura(url) {
  if (typeof url !== 'string') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !HOSTS_FATURA.includes(u.hostname) || u.port !== '' || u.username !== '' || u.password !== '') return null;
  return u.href;
}

// Corpo do pedido: o do orçamento + nomes dos domínios, cliente, chave, valores confirmados e aceite. Nenhum outro campo
// (CEP, endereço, razão social e nascimento ficam só na tela).
function montarCorpoPedido(chave) {
  const corpo = montarCorpoOrcamento();
  const isCPF = document.getElementById('btnCPF').classList.contains('active');
  const digitos = id => document.getElementById(id).value.replace(/\D/g, '');
  corpo.dominio = {
    ...corpo.dominio,
    nome: domainChoice === 'new-br'
      ? normalizarDominioNovo(document.getElementById('fDomNew').value)
      : normalizarDominioExistente(document.getElementById('fDomExist').value),
  };
  const extras = camposExtras().map(c => normalizarDominioNovo(c.value));
  if (extras.length) corpo.dominios_extras = extras;
  corpo.cliente = {
    nome: document.getElementById('fNome').value.trim(),
    email: document.getElementById('fEmail').value.trim(),
    telefone: digitos('fTelefone'),
    documento: digitos(isCPF ? 'fCPF' : 'fCNPJ'),
  };
  corpo.chave_idempotencia = chave;
  corpo.versao_tabela = ultimoOrcamentoConfirmado.versao_tabela;
  corpo.total_exibido_centavos = ultimoOrcamentoConfirmado.total_exibido_centavos;
  corpo.aceite = { termos: true, versao_termos: VERSAO_TERMOS, versao_privacidade: VERSAO_PRIVACIDADE };
  return corpo;
}

// Pré-condições de um envio novo: domínios revalidados, aceite marcado e orçamento confirmado.
function pedidoPodeSerEnviado() {
  const principal = validarDominioPrincipal();
  if (principal) { goStep(2); principal.focus(); return false; }
  const extra = validarDominiosExtras();
  if (extra) { goStep(3); extra.focus(); return false; }
  const termos = document.getElementById('termsCheck');
  if (!termos.checked) { goStep(4); termos.focus(); return false; }
  return orcamentoLiberaAvanco();
}

function atualizarBotaoPedido() {
  const btn = document.getElementById('btnIrPagamento');
  btn.hidden = !origemApi() || pedidoConcluido || pedidoBloqueado;
  btn.disabled = pedidoEnviando;
  if (pedidoEnviando) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
  document.getElementById('pedidoProgresso').textContent = pedidoEnviando ? 'Gerando sua fatura…' : '';
  // Edição dos passos 1-4 travada durante o envio e no estado ambíguo (goStep também recusa).
  document.querySelectorAll('#step5 [data-ir-passo]').forEach(b => { b.disabled = pedidoEnviando || pedidoAmbiguo; });
}

async function enviarPedido() {
  const origem = origemApi();
  if (!origem || pedidoEnviando || pedidoBloqueado || pedidoConcluido) return;
  let corpoTexto;
  if (pedidoAmbiguo) {
    corpoTexto = corpoPedidoEnviado;   // mesmo corpo e mesma chave, sem remontar da tela
  } else {
    if (!pedidoPodeSerEnviado()) return;
    if (!chavePedido) chavePedido = crypto.randomUUID();
    corpoTexto = JSON.stringify(montarCorpoPedido(chavePedido));
  }
  corpoPedidoEnviado = corpoTexto;
  pedidoEnviando = true;
  // Esvazia as regiões vivas: o texto da resposta (mesmo que repetido) é anunciado de novo.
  limparErroPedido();
  document.getElementById('pedidoAviso').textContent = '';
  atualizarBotaoPedido();
  const controlador = new AbortController();
  // setTimeout + abort (e não AbortSignal.timeout) para o page.clock dos testes controlar o prazo.
  const prazo = setTimeout(() => controlador.abort(), PEDIDO_TIMEOUT_MS);
  let status = 0;
  let dados = null;
  try {
    const r = await fetch(`${origem}/api/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: corpoTexto,
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
  pedidoEnviando = false;
  tratarRespostaPedido(status, dados);
  atualizarBotaoPedido();
}

function respostaCriadaValida(d) {
  return !!d && typeof d === 'object'
    && ((typeof d.pedidoId === 'string' && d.pedidoId !== '') || Number.isInteger(d.pedidoId))
    && Array.isArray(d.faturas)
    && d.faturas.every(f => f && typeof f === 'object' && (f.tipo === 'contas' || f.tipo === 'dominios')
      && (f.url === null || typeof f.url === 'string'));
}

// Classe da resposta (Decisão 8): o que não for reconhecido como definitivo ou retomável é ambíguo.
function classificarRespostaPedido(status, d) {
  const erro = d && typeof d === 'object' ? d.erro : undefined;
  if (status === 201) return respostaCriadaValida(d) ? 'criado' : 'ambigua';
  if (status === 404) return 'indisponivel';
  if (status === 400 && erro === 'validacao') return 'validacao';
  if (status === 409 && erro === 'total_divergente') return 'total';
  if (status === 409 && erro === 'versao_termos_divergente') return 'termos';
  if (status === 422 && erro === 'chave_reutilizada') return pedidoAmbiguo ? 'irrecuperavel' : 'definitiva';
  if ((status === 502 || status === 504) && erro === 'asaas_indisponivel') return 'definitiva';
  if (status === 500 && erro === 'interno') return ultimoErroInterno ? 'definitiva' : 'retomavel';
  return 'ambigua';
}

function tratarRespostaPedido(status, d) {
  const classe = classificarRespostaPedido(status, d);
  ultimoErroInterno = classe === 'retomavel';
  if (classe === 'criado') {
    pedidoAmbiguo = false;
    pedidoConcluido = true;
    chavePedido = null;
    limparMarcasPedido();
    mostrarResultadoPedido(d);
    return;
  }
  // Ambígua ou 1º 500 interno (o pedido pode estar em "criando"): mesma chave e mesmo corpo, edição travada.
  if (classe === 'ambigua' || classe === 'retomavel') {
    pedidoAmbiguo = true;
    mostrarErroPedido(MSG_PEDIDO_GENERICA, { retry: true, ambiguo: true });
    return;
  }
  if (classe === 'irrecuperavel') {   // sem chave nova silenciosa e sem novo envio pela página
    pedidoBloqueado = true;
    mostrarErroPedido(`Não conseguimos confirmar seu pedido. Fale com ${CONTATO_COMERCIAL} informando o e-mail do cadastro.`, {});
    return;
  }
  const msgIndisponivel = `A contratação online está indisponível no momento. Fale com ${CONTATO_COMERCIAL}.`;
  if (classe === 'indisponivel' && pedidoAmbiguo) {   // o pedido pode existir: mantém a chave e o aviso
    pedidoBloqueado = true;
    mostrarErroPedido(msgIndisponivel, { ambiguo: true });
    return;
  }
  // Definitivas: nenhum pedido ficou pendente com esta chave; o próximo envio gera outra (e o corpo pode mudar).
  chavePedido = null;
  pedidoAmbiguo = false;
  if (classe === 'indisponivel') {
    pedidoBloqueado = true;
    mostrarErroPedido(msgIndisponivel, {});
  } else if (classe === 'validacao') {
    const marcados = Array.isArray(d.campos) && marcarCamposPedido(d.campos);
    if (marcados) mostrarErroPedido('Revise os dados destacados.', { revisar: true });
    else mostrarErroPedido(MSG_PEDIDO_GENERICA, { retry: true });
  } else if (classe === 'total') {
    // O total mudou no servidor: refaz o orçamento na hora (sem debounce); o comprador confere e clica de novo.
    ultimoOrcamentoConfirmado = null;
    tentarOrcamentoDeNovo();
    mostrarErroPedido('O valor foi atualizado. Confira o novo total e clique de novo em Ir para pagamento.', { foco: 'btnIrPagamento' });
  } else if (classe === 'termos') {
    document.getElementById('termsCheck').checked = false;
    mostrarErroPedido('Os termos foram atualizados. Recarregue a página e aceite a versão nova.', {});
  } else {
    mostrarErroPedido(MSG_PEDIDO_GENERICA, { retry: true });
  }
}

// #pedidoErro é a única região role="alert" do pedido: fica sempre no DOM e recebe o texto a cada resposta.
function limparErroPedido() {
  document.getElementById('pedidoErroTexto').textContent = '';
  document.getElementById('pedidoAmbiguoAviso').textContent = '';
  document.getElementById('btnPedidoRetry').hidden = true;
  document.getElementById('btnPedidoRevisar').hidden = true;
  document.getElementById('pedidoErro').classList.remove('pedido-erro--ativo');
}

// opcoes: retry (mostra "Tentar novamente"), revisar (mostra "Revisar dados"), ambiguo (acrescenta o aviso de que o
// pedido pode já existir), foco (id a focar sem esses botões).
function mostrarErroPedido(texto, opcoes) {
  const retry = document.getElementById('btnPedidoRetry');
  const revisar = document.getElementById('btnPedidoRevisar');
  document.getElementById('pedidoErroTexto').textContent = texto;
  document.getElementById('pedidoAmbiguoAviso').textContent = opcoes.ambiguo ? MSG_PEDIDO_AMBIGUO : '';
  retry.hidden = !opcoes.retry;
  revisar.hidden = !opcoes.revisar;
  document.getElementById('pedidoErro').classList.add('pedido-erro--ativo');
  atualizarBotaoPedido();
  const foco = opcoes.retry ? retry : opcoes.revisar ? revisar : opcoes.foco && document.getElementById(opcoes.foco);
  if (foco && !foco.hidden) foco.focus();
}

// Campo da tela para cada campo acusado num 400 do pedido: { el, erroId, passo } ou null.
function campoDoErroPedido(nome) {
  const isCPF = document.getElementById('btnCPF').classList.contains('active');
  const cliente = {
    'cliente': ['fNome', 'err-nome'], 'cliente.nome': ['fNome', 'err-nome'], 'cliente.email': ['fEmail', 'err-email'],
    'cliente.telefone': ['fTelefone', 'err-telefone'],
    'cliente.documento': isCPF ? ['fCPF', 'err-cpf'] : ['fCNPJ', 'err-cnpj'],
  };
  if (Object.prototype.hasOwnProperty.call(cliente, nome)) {
    const [id, erroId] = cliente[nome];
    return { el: document.getElementById(id), erroId, passo: 4 };
  }
  if (nome === 'dominio' || nome === 'dominio.nome') {
    const [id, erroId] = domainChoice === 'existing' ? ['fDomExist', 'err-dom-exist'] : ['fDomNew', 'err-dom-new'];
    return { el: document.getElementById(id), erroId, passo: 2 };
  }
  const extra = /^dominios_extras\.(\d+)$/.exec(nome);
  const indice = extra ? Number(extra[1]) + 1 : (nome === 'dominios_extras' || nome === 'addons.extraDom' ? 1 : 0);
  const el = indice ? document.getElementById(`fDomExtra${indice}`) : null;
  return el ? { el, erroId: `err-dom-extra-${indice}`, passo: 3 } : null;
}

// Marca os campos acusados (aria-invalid e mensagem); devolve true se marcou algum.
function marcarCamposPedido(campos) {
  passoComErroPedido = null;
  campos.forEach(c => {
    const alvo = c && typeof c.campo === 'string' ? campoDoErroPedido(c.campo) : null;
    if (!alvo) return;
    marcarCampoInvalido(alvo.el, alvo.erroId, 'Confira este dado.');
    if (passoComErroPedido === null || alvo.passo < passoComErroPedido) passoComErroPedido = alvo.passo;
  });
  return passoComErroPedido !== null;
}

// Tira as marcas de um 400 de todos os campos (depois de um 201).
function limparMarcasPedido() {
  passoComErroPedido = null;
  Object.keys(ERROS_CADASTRO).forEach(id => limparMarcaCadastro(id));
  limparErroDominio('fDomNew', 'err-dom-new');
  limparErroDominio('fDomExist', 'err-dom-exist');
  camposExtras().forEach((campo, i) => limparErroDominio(campo.id, `err-dom-extra-${i + 1}`));
}

function revisarDadosPedido() {
  if (passoComErroPedido === null) return;
  goStep(passoComErroPedido);
  const marcado = document.querySelector(`#step${passoComErroPedido} [aria-invalid="true"]`);
  if (marcado) marcado.focus();
}

// 201: só a fatura das contas (segura) → vai para ela; com a de domínios → links em nova aba; sem URL segura → aviso.
function mostrarResultadoPedido(d) {
  const contas = d.faturas.find(f => f.tipo === 'contas');
  const dominios = d.faturas.find(f => f.tipo === 'dominios');
  const urlContas = contas ? urlFaturaSegura(contas.url) : null;
  limparErroPedido();
  if (d.aviso === 'fatura_pendente' || !urlContas) {
    document.getElementById('pedidoAviso').textContent =
      `Pedido recebido. Número do pedido: ${d.pedidoId}. Se não receber a fatura por e-mail, fale com ${CONTATO_COMERCIAL}.`;
    return;
  }
  if (!dominios) {
    location.assign(urlContas);
    return;
  }
  const urlDominios = urlFaturaSegura(dominios.url);
  const linkContas = document.getElementById('linkFaturaContas');
  const linkDominios = document.getElementById('linkFaturaDominios');
  linkContas.href = urlContas;
  linkContas.hidden = false;
  if (urlDominios) linkDominios.href = urlDominios;
  else linkDominios.removeAttribute('href');
  linkDominios.hidden = !urlDominios;
  document.getElementById('pedidoFaturasTexto').textContent = urlDominios
    ? `Pedido recebido (número ${d.pedidoId}). Abra as faturas abaixo para pagar.`
    : `Pedido recebido (número ${d.pedidoId}). Abra a fatura das contas abaixo para pagar; a do domínio foi enviada para o seu e-mail.`;
  document.getElementById('pedidoFaturas').hidden = false;
  linkContas.focus();
}

/* ================================================================
   VÍNCULOS — cada controle recebe o seu listener no próprio elemento
   (sem handler inline, por causa da CSP).
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
document.getElementById('btnStep3Next').addEventListener('click', () => goStep3Next());
document.querySelectorAll('[data-doc-tipo]').forEach(el => {
  el.addEventListener('click', e => setDocType(e.currentTarget.dataset.docTipo));
});
document.getElementById('btnSubmitCadastro').addEventListener('click', () => submitCadastro());
document.getElementById('btnIrPagamento').addEventListener('click', () => enviarPedido());
document.getElementById('btnPedidoRetry').addEventListener('click', () => enviarPedido());
document.getElementById('btnPedidoRevisar').addEventListener('click', () => revisarDadosPedido());
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
// aria-invalid posto por um 400 do pedido nos dados do cadastro sai quando o usuário edita o campo.
['fNome', 'fEmail', 'fTelefone', 'fCPF', 'fCNPJ'].forEach(id => {
  document.getElementById(id).addEventListener('input', e => e.currentTarget.removeAttribute('aria-invalid'));
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
  // Modo local (Pages, homologação, 127.0.0.1): contratação online em breve, sem envio do pedido.
  const modoLocal = !origemApi();
  ['avisoEmBreve', 'avisoEmBreveCadastro', 'revisaoEmBreve'].forEach(id => { document.getElementById(id).hidden = !modoLocal; });
  atualizarBotaoPedido();
})();
