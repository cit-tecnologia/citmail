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

/* ── TABS ── */
function switchTab(btn, panelId) {
  const section = btn.closest('.section');
  section.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  section.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(panelId).classList.add('active');
}

/* ── MODALS ── */
function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay.open').forEach(overlay => closeModal(overlay.id));
  closeSidebar();
});

/* ── SELEÇÃO DE PLANO (modal servidor) ── */
function selectPlanOpt(label) {
  label.parentElement.querySelectorAll('.plan-opt').forEach(o => o.classList.toggle('selected', o === label));
}

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

/* ── DEMO: personalize sidebar with URL name param ── */
(function init() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('nome') || 'João da Silva';
  const initials = name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
  document.getElementById('sidebarName').textContent = name;
  document.getElementById('sidebarInitials').textContent = initials;
  document.getElementById('topbarAvatar').textContent = initials;
})();

/* ── DNS MANAGEMENT ── */
const dnsData = {
  'empresa.com.br': {
    status: 'active',
    lastCheck: '5 minutos atrás',
    records: [
      { id:1,  type:'A',     host:'@',            value:'177.126.48.201',                                          ttl:'300',  priority:null },
      { id:2,  type:'MX',    host:'@',            value:'mail.citmail.com.br',                                     ttl:'3600', priority:'10' },
      { id:3,  type:'MX',    host:'@',            value:'mail2.citmail.com.br',                                    ttl:'3600', priority:'20' },
      { id:4,  type:'TXT',   host:'@',            value:'v=spf1 include:citmail.com.br ~all',                      ttl:'3600', priority:null },
      { id:5,  type:'TXT',   host:'_dmarc',       value:'v=DMARC1; p=quarantine; rua=mailto:dmarc@citmail.com.br',ttl:'3600', priority:null },
      { id:6,  type:'TXT',   host:'_domainkey',   value:'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4G…',        ttl:'3600', priority:null },
      { id:7,  type:'CNAME', host:'webmail',      value:'webmail.citmail.com.br',                                  ttl:'3600', priority:null },
      { id:8,  type:'CNAME', host:'autodiscover', value:'autodiscover.citmail.com.br',                             ttl:'3600', priority:null },
    ]
  },
  'empresa.com': {
    status: 'propagating',
    lastCheck: '10 minutos atrás',
    records: [
      { id:9,  type:'A',     host:'@',   value:'177.126.48.201',                     ttl:'300',  priority:null },
      { id:10, type:'MX',    host:'@',   value:'mail.citmail.com.br',                ttl:'3600', priority:'10' },
      { id:11, type:'TXT',   host:'@',   value:'v=spf1 include:citmail.com.br ~all', ttl:'3600', priority:null },
      { id:12, type:'CNAME', host:'www', value:'empresa.com.br',                     ttl:'3600', priority:null },
    ]
  }
};
let activeDnsDomain = 'empresa.com.br';
let dnsActiveTypeFilter = 'Todos';
let dnsNextId = 30;

function dnsInit() {
  const tabsEl = document.getElementById('dnsDomainTabs');
  tabsEl.innerHTML = Object.keys(dnsData).map(d => {
    const s = dnsData[d].status;
    const dotClass = s === 'active' ? 'active' : s === 'propagating' ? 'propagating' : 'error';
    const label = s === 'active' ? 'Ativo' : s === 'propagating' ? 'Propagando' : 'Erro';
    return `<button class="domain-tab ${d === activeDnsDomain ? 'active' : ''}" data-dns-dominio="${esc(d)}">
      <span class="domain-status-dot ${dotClass}"></span>
      <span>${esc(d)}</span>
      <span class="domain-tab-status">${label}</span>
    </button>`;
  }).join('');
  dnsRenderTypeFilters();
  dnsUpdatePropCard();
  dnsRender();
}

function dnsSwitchDomain(domain) {
  activeDnsDomain = domain;
  dnsActiveTypeFilter = 'Todos';
  dnsInit();
}

function dnsUpdatePropCard() {
  const d = dnsData[activeDnsDomain];
  const iconEl  = document.getElementById('dnsPropIcon');
  const titleEl = document.getElementById('dnsPropTitle');
  const subEl   = document.getElementById('dnsPropSub');
  if (d.status === 'active') {
    iconEl.className = 'stat-icon green';
    iconEl.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#circle-check"></use></svg>';
    titleEl.textContent = 'DNS Ativo e Propagado';
    subEl.textContent   = `Todos os registros estão respondendo corretamente. Última verificação: ${d.lastCheck}.`;
  } else if (d.status === 'propagating') {
    iconEl.className = 'stat-icon yellow';
    iconEl.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#clock"></use></svg>';
    titleEl.textContent = 'Propagação em andamento';
    subEl.textContent   = `Alterações recentes ainda podem estar propagando (até 48h). Última verificação: ${d.lastCheck}.`;
  } else {
    iconEl.className = 'stat-icon red';
    iconEl.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#circle-alert"></use></svg>';
    titleEl.textContent = 'Problema detectado';
    subEl.textContent   = `Um ou mais registros não estão respondendo. Última verificação: ${d.lastCheck}.`;
  }
}

function dnsRenderTypeFilters() {
  const records = dnsData[activeDnsDomain].records;
  const types = ['Todos', ...new Set(records.map(r => r.type))];
  document.getElementById('dnsTypeFilters').innerHTML = types.map(t =>
    `<button class="dns-filter-chip ${t === dnsActiveTypeFilter ? 'active' : ''}" data-dns-tipo="${esc(t)}">${esc(t)}</button>`
  ).join('');
}

function dnsSetFilter(type) {
  dnsActiveTypeFilter = type;
  dnsRenderTypeFilters();
  dnsRender();
}

function dnsRender() {
  const search  = (document.getElementById('dnsSearch')?.value || '').toLowerCase();
  const records = dnsData[activeDnsDomain].records;
  document.getElementById('dnsActiveDomainLabel').textContent = activeDnsDomain;
  const filtered = records.filter(r => {
    const matchType   = dnsActiveTypeFilter === 'Todos' || r.type === dnsActiveTypeFilter;
    const matchSearch = !search || r.host.toLowerCase().includes(search) || r.value.toLowerCase().includes(search) || r.type.toLowerCase().includes(search);
    return matchType && matchSearch;
  });
  document.getElementById('dnsRecordCount').textContent = `${filtered.length} de ${records.length} registro${records.length !== 1 ? 's' : ''}`;
  const body  = document.getElementById('dnsTableBody');
  const empty = document.getElementById('dnsEmpty');
  if (!filtered.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  body.innerHTML = filtered.map(r => {
    const ttlLabel = r.ttl === '300' ? '5min' : r.ttl === '1800' ? '30min' : r.ttl === '3600' ? '1h' : r.ttl === '21600' ? '6h' : r.ttl === '86400' ? '24h' : r.ttl;
    return `<div class="dns-table-row">
      <span class="rt rt-${esc(r.type)}">${esc(r.type)}</span>
      <span class="dns-host" title="${esc(r.host)}">${esc(r.host)}</span>
      <span class="dns-val" title="${esc(r.value)}">${esc(r.value)}</span>
      <span class="dns-ttl">${esc(ttlLabel)}</span>
      <span class="dns-prio">${esc(r.priority || '—')}</span>
      <div class="dns-actions">
        <button class="dns-btn dns-btn-edit" aria-label="Editar" data-tip="Editar" data-dns-acao="editar" data-dns-id="${r.id}"><svg class="icon" aria-hidden="true"><use href="assets/icons.svg#pencil"></use></svg></button>
        <button class="dns-btn dns-btn-del" aria-label="Excluir" data-tip="Excluir" data-dns-acao="excluir" data-dns-id="${r.id}"><svg class="icon" aria-hidden="true"><use href="assets/icons.svg#trash-2"></use></svg></button>
      </div>
    </div>`;
  }).join('');
}

function dnsOpenAddRecord() {
  document.getElementById('modalDnsTitle').innerHTML = '<svg class="icon" style="margin-right:8px" aria-hidden="true"><use href="assets/icons.svg#plus"></use></svg>Adicionar Registro';
  document.getElementById('dnsRType').value  = 'A';
  document.getElementById('dnsRHost').value  = '';
  document.getElementById('dnsRValue').value = '';
  document.getElementById('dnsRTtl').value   = '3600';
  document.getElementById('dnsRPrio').value  = '10';
  document.getElementById('dnsREditId').value = '';
  dnsTogglePriority();
  openModal('modalDnsRecord');
}

function dnsOpenEditRecord(id) {
  const records = dnsData[activeDnsDomain].records;
  const r = records.find(x => x.id === id);
  if (!r) return;
  document.getElementById('modalDnsTitle').innerHTML = '<svg class="icon" style="margin-right:8px" aria-hidden="true"><use href="assets/icons.svg#pencil"></use></svg>Editar Registro';
  document.getElementById('dnsRType').value  = r.type;
  document.getElementById('dnsRHost').value  = r.host;
  document.getElementById('dnsRValue').value = r.value;
  document.getElementById('dnsRTtl').value   = r.ttl;
  document.getElementById('dnsRPrio').value  = r.priority || '10';
  document.getElementById('dnsREditId').value = id;
  dnsTogglePriority();
  openModal('modalDnsRecord');
}

function dnsTogglePriority() {
  const type = document.getElementById('dnsRType').value;
  const show = type === 'MX' || type === 'SRV';
  document.getElementById('dnsRPrioField').style.display = show ? 'block' : 'none';
  const hints = { A:'Ex: 177.126.48.201', AAAA:'Ex: 2001:db8::1', CNAME:'Ex: destino.exemplo.com.br', MX:'Ex: mail.citmail.com.br', TXT:'Ex: v=spf1 include:... ~all', NS:'Ex: ns1.citmail.com.br', SRV:'Ex: 10 20 443 srv.exemplo.com', CAA:'Ex: 0 issue "letsencrypt.org"' };
  document.getElementById('dnsRValueHint').textContent = hints[type] || '';
}

function dnsSaveRecord() {
  const type  = document.getElementById('dnsRType').value.trim();
  const host  = document.getElementById('dnsRHost').value.trim();
  const value = document.getElementById('dnsRValue').value.trim();
  const ttl   = document.getElementById('dnsRTtl').value;
  const prio  = document.getElementById('dnsRPrio').value;
  const editId = parseInt(document.getElementById('dnsREditId').value) || null;
  if (!host || !value) { showToast('Preencha Host e Valor.', 'error'); return; }
  const records = dnsData[activeDnsDomain].records;
  const priority = (type === 'MX' || type === 'SRV') ? prio : null;
  if (editId) {
    const idx = records.findIndex(r => r.id === editId);
    if (idx > -1) records[idx] = { id: editId, type, host, value, ttl, priority };
    showToast('Registro DNS atualizado.', 'success');
  } else {
    records.push({ id: dnsNextId++, type, host, value, ttl, priority });
    showToast('Registro DNS adicionado. A propagação leva até 48h.', 'success');
  }
  closeModal('modalDnsRecord');
  dnsRenderTypeFilters();
  dnsRender();
}

function dnsDeleteRecord(id) {
  const records = dnsData[activeDnsDomain].records;
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return;
  const r = records[idx];
  if (!confirm(`Excluir registro ${r.type} "${r.host}" → ${r.value}?`)) return;
  records.splice(idx, 1);
  dnsRenderTypeFilters();
  dnsRender();
  showToast('Registro excluído.', 'success');
}

function dnsCheckProp() {
  showToast('Verificando propagação DNS…', 'info');
  const d = dnsData[activeDnsDomain];
  d.lastCheck = 'agora mesmo';
  setTimeout(() => {
    d.status = 'active';
    dnsUpdatePropCard();
    dnsInit();
    showToast('DNS propagado. Todos os registros estão respondendo.', 'success');
  }, 2200);
}

/* ================================================================
   VÍNCULOS — sem handler inline, por causa da CSP. Atributos genéricos
   (modelo de assets/checkout.js); navigate sempre pelo nome dentro de
   arrow, para pegar o wrapper do fim do arquivo.
================================================================ */
const MODAIS = ['modalDnsRecord', 'modalNovaContaEmail', 'modalNovoTicket', 'modalVerTicket', 'modalContratarConsultoria', 'modalContratarServidor'];

document.querySelectorAll('.nav-item[data-section]').forEach(el => {
  el.addEventListener('click', e => navigate(e.currentTarget.dataset.section));
});
document.querySelectorAll('[data-ir-para]').forEach(el => {
  el.addEventListener('click', e => navigate(e.currentTarget.dataset.irPara));
});
document.querySelectorAll('[data-abrir-modal]').forEach(el => {
  el.addEventListener('click', e => {
    const id = e.currentTarget.dataset.abrirModal;
    if (MODAIS.includes(id)) openModal(id);
  });
});
// Antes dos toasts: nos compostos, fecha o modal e depois mostra o toast.
document.querySelectorAll('[data-fechar-modal]').forEach(el => {
  el.addEventListener('click', e => {
    const id = e.currentTarget.dataset.fecharModal;
    if (MODAIS.includes(id)) closeModal(id);
  });
});
document.querySelectorAll('[data-toast]').forEach(el => {
  const evento = el.matches('input[type="checkbox"]') ? 'change' : 'click';
  el.addEventListener(evento, e => showToast(e.currentTarget.dataset.toast, e.currentTarget.dataset.toastTipo));
});
// Ticket: só a 1ª linha e o 1º olho abrem o modal (comportamento anterior).
document.querySelectorAll('[data-ver-ticket]').forEach(el => {
  el.addEventListener('click', e => {
    if (e.currentTarget.dataset.verTicket === 'olho') e.stopPropagation();
    openModal('modalVerTicket');
  });
});
document.querySelectorAll('[data-aba]').forEach(el => {
  el.addEventListener('click', e => switchTab(e.currentTarget, e.currentTarget.dataset.aba));
});
document.querySelectorAll('[data-plano-opcao]').forEach(el => {
  el.addEventListener('click', e => selectPlanOpt(e.currentTarget));
});
document.getElementById('sidebarToggle').addEventListener('click', () => toggleSidebar());
document.getElementById('sidebarBackdrop').addEventListener('click', () => closeSidebar());
document.getElementById('btnDnsAdd').addEventListener('click', () => dnsOpenAddRecord());
document.getElementById('btnDnsCheckProp').addEventListener('click', () => dnsCheckProp());
document.getElementById('btnDnsSave').addEventListener('click', () => dnsSaveRecord());
document.getElementById('dnsRType').addEventListener('change', () => dnsTogglePriority());
document.getElementById('dnsSearch').addEventListener('input', () => dnsRender());

// DNS: o conteúdo é recriado por innerHTML a cada render, então a delegação
// fica no contêiner, vinculada uma vez aqui (nunca em dnsInit), limitada a
// ele e com o valor validado antes de agir.
document.getElementById('dnsDomainTabs').addEventListener('click', e => {
  const alvo = e.target.closest('[data-dns-dominio]');
  if (!alvo || !e.currentTarget.contains(alvo)) return;
  const dominio = alvo.dataset.dnsDominio;
  if (!Object.hasOwn(dnsData, dominio)) return;
  dnsSwitchDomain(dominio);
});
document.getElementById('dnsTypeFilters').addEventListener('click', e => {
  const alvo = e.target.closest('[data-dns-tipo]');
  if (!alvo || !e.currentTarget.contains(alvo)) return;
  const tipo = alvo.dataset.dnsTipo;
  const tipos = ['Todos', ...dnsData[activeDnsDomain].records.map(r => r.type)];
  if (!tipos.includes(tipo)) return;
  dnsSetFilter(tipo);
});
document.getElementById('dnsTableBody').addEventListener('click', e => {
  const alvo = e.target.closest('[data-dns-acao]');
  if (!alvo || !e.currentTarget.contains(alvo)) return;
  const v = alvo.dataset.dnsId;
  if (!/^\d+$/.test(v || '')) return;
  const id = Number(v);
  if (!dnsData[activeDnsDomain].records.some(r => r.id === id)) return;
  const acao = alvo.dataset.dnsAcao;
  if (acao === 'editar') dnsOpenEditRecord(id);
  else if (acao === 'excluir') dnsDeleteRecord(id);
});

// Init DNS when section becomes visible
const _origNavigate = navigate;
navigate = function(id) {
  _origNavigate(id);
  if (id === 'dns') dnsInit();
};
