/**
 * SSC Catalog Intelligence — Single Page Application
 * Pure JavaScript (no build step required for development)
 * Uses SAP UI5 Web Components loaded from CDN or public assets
 */

// ── Configuration ─────────────────────────────────────────────────────────────
const CAP_BACKEND_URL = window.CAP_BACKEND_URL || 'http://localhost:4004';
const AGENT_BASE_URL  = window.AGENT_BASE_URL  || 'http://localhost:5000';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  currentPage: 'catalog',
  catalog: { services: [], lastUpdated: null, loading: false, error: null },
  filters: { query: '', engagementType: '', businessScenario: '', module: '', modules: [], phases: [], supercats: [], deckName: '', namingType: '' },
  filteredServices: [],
  exportCart: JSON.parse(sessionStorage.getItem('exportCart') || '[]'),
  selectedServices: new Set(),
  incident: { file: null, results: [], loading: false, error: null, selectedCodes: new Set() },
  pptx: { template: 'short-description', generating: false, error: null, downloadUrl: null },
  chat: { messages: [], loading: false, input: '' }
};

function saveCart() {
  sessionStorage.setItem('exportCart', JSON.stringify(state.exportCart));
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function loadCatalog() {
  state.catalog.loading = true; render();
  try {
    // Load only metadata — BS list, module list, engagement types
    // Do NOT download full snapshot to browser
    const data = await apiFetch(`${CAP_BACKEND_URL}/api/catalog/metadata`);

    state.catalog.bsMap = data.bsMap || {};
    state.catalog.moduleMap = data.moduleMap || {};
    state.catalog.bsToMods = data.bsToMods || {};
    state.catalog.engagementTypes = data.engagementTypes || [];
    state.catalog.phases = data.phases || [];
    state.catalog.supercategories = data.supercategories || [];
    state.catalog.lastUpdated = data.lastUpdated;
    state.catalog.serviceCount = data.serviceCount;
    state.catalog.services = []; // not loaded upfront
    state.filteredServices = [];
    state.catalog.hasSearched = false;
    state.catalog.error = null;
  } catch (e) {
    state.catalog.error = e.message;
  }
  state.catalog.loading = false; render();
}

async function applyFilters() {
  const { query, engagementType, businessScenario, module: mod } = state.filters;
  const mods     = state.filters.modules    || [];
  const phases   = state.filters.phases     || [];
  const supercats = state.filters.supercats || [];

  // Nothing selected — clear results and show prompt
  if (!query && !engagementType && !businessScenario && !mod && mods.length === 0 && phases.length === 0 && supercats.length === 0) {
    state.filteredServices = [];
    state.catalog.hasSearched = false;
    render(); return;
  }

  state.catalog.hasSearched = true;
  state.catalog.loading = true; render();

  try {
    // Build query params for server-side filtering
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (engagementType) params.set('engagementType', engagementType);
    if (businessScenario) params.set('businessScenario', businessScenario);
    // multi-module support
    if (mods.length > 0) mods.forEach(m => params.append('module', m));
    else if (mod) params.set('module', mod);
    // phases
    phases.forEach(p => params.append('phase', p));
    // supercategories
    supercats.forEach(s => params.append('supercat', s));

    const url = query
      ? `${CAP_BACKEND_URL}/api/catalog/searchServices?${params}`
      : `${CAP_BACKEND_URL}/api/catalog/filterServices?${params}`;

    const data = await apiFetch(url);
    state.filteredServices = data.services || [];
  } catch (e) {
    state.filteredServices = [];
  }
  state.catalog.loading = false; render();
}

// ── Engagement type badge ─────────────────────────────────────────────────────
function engagementBadge(et) {
  // et may be an array — show first value only as a badge
  const val = Array.isArray(et) ? et[0] : et;
  const cls = val?.includes('Max') ? 'badge-max' : val?.includes('Advanced') ? 'badge-adv' : 'badge-ent';
  return val ? `<span class="badge ${cls}">${val}</span>` : '—';
}

// ── Pages ─────────────────────────────────────────────────────────────────────

function renderCatalogPage() {
  const { services, loading, error, lastUpdated, moduleMap = {}, bsMap = {}, engagementTypes = [], phases = [], supercategories = [], hasSearched } = state.catalog;
  const cartCount = state.exportCart.length;

  // Fixed engagement type options
  const ET_OPTIONS = [
    { value: 'Max Success Plan',      label: 'Max Success Plan' },
    { value: 'Advanced Success Plan', label: 'Advanced Success Plan' },
    { value: 'Enterprise Support',    label: 'Foundational Success Plan' },
  ];

  const uniqueBS = Object.entries(bsMap).sort((a, b) => a[1].localeCompare(b[1]));

  // Modules — only shown when BS is selected, multiselect
  const showModuleFilter = !!state.filters.businessScenario;
  let uniqueMods = [];
  if (showModuleFilter) {
    const bsToMods = state.catalog.bsToMods || {};
    const modCodes = bsToMods[state.filters.businessScenario] || [];
    uniqueMods = modCodes
      .filter(code => moduleMap[code])
      .map(code => [code, moduleMap[code]])
      .sort((a, b) => a[1].localeCompare(b[1]));
  }

  // Selected modules as array
  const selectedMods = state.filters.modules || [];

  // Naming type selector — only shown when BS is selected
  const showNamingFilter = !!state.filters.businessScenario;

  return `
    <h2>Catalog Browser</h2>
    ${error ? `<div class="error-strip">⚠ ${error}</div>` : ''}
    <div class="filter-row">
      <div class="filter-group">
        <label>Search</label>
        <ui5-input id="filter-query" placeholder="Search services..." value="${state.filters.query}"
          style="min-width:220px" oninput="updateFilter('query', this.value)">
        </ui5-input>
      </div>
      <div class="filter-group">
        <label>Engagement Type</label>
        <ui5-select id="filter-et" onchange="updateFilter('engagementType', this.selectedOption?.dataset?.value||'')">
          <ui5-option data-value="" ${!state.filters.engagementType?'selected':''}>All</ui5-option>
          ${ET_OPTIONS.map(o => `<ui5-option data-value="${o.value}" ${state.filters.engagementType===o.value?'selected':''}>${o.label}</ui5-option>`).join('')}
        </ui5-select>
      </div>
      <div class="filter-group">
        <label>Business Scenario</label>
        <ui5-select id="filter-bs" style="min-width:280px" onchange="updateFilter('businessScenario', this.selectedOption?.dataset?.value||'')">
          <ui5-option data-value="" ${!state.filters.businessScenario?'selected':''}>All</ui5-option>
          ${uniqueBS.map(([code, name]) => `<ui5-option data-value="${code}" ${state.filters.businessScenario===code?'selected':''}>${name}</ui5-option>`).join('')}
        </ui5-select>
      </div>
      ${showModuleFilter ? `
      <div class="filter-group">
        <label>Module</label>
        <ui5-multi-combobox id="filter-mod" style="min-width:280px"
          placeholder="Select modules..."
          onselection-change="updateMultiFilterUI5('modules', this)">
          ${uniqueMods.map(([code, name]) => `<ui5-mcb-item text="${name.replace(/"/g,'&quot;')}" data-value="${code}" ${selectedMods.includes(code)?'selected':''}></ui5-mcb-item>`).join('')}
        </ui5-multi-combobox>
      </div>` : ''}
      ${phases.length > 0 ? `
      <div class="filter-group">
        <label>SAP Activate Phase</label>
        <ui5-multi-combobox id="filter-phase" style="min-width:220px"
          placeholder="Select phases..."
          onselection-change="updateMultiFilterUI5('phases', this)">
          ${phases.map(p => `<ui5-mcb-item text="${p.replace(/"/g,'&quot;')}" data-value="${p}" ${(state.filters.phases||[]).includes(p)?'selected':''}></ui5-mcb-item>`).join('')}
        </ui5-multi-combobox>
      </div>` : ''}
      ${supercategories.length > 0 ? `
      <div class="filter-group">
        <label>Supercategory</label>
        <ui5-multi-combobox id="filter-supercat" style="min-width:280px"
          placeholder="Select supercategories..."
          onselection-change="updateMultiFilterUI5('supercats', this)">
          ${supercategories.map(s => `<ui5-mcb-item text="${s.replace(/"/g,'&quot;')}" data-value="${s}" ${(state.filters.supercats||[]).includes(s)?'selected':''}></ui5-mcb-item>`).join('')}
        </ui5-multi-combobox>
      </div>` : ''}
      ${showNamingFilter ? `
      <div class="filter-group">
        <label>Service Name</label>
        <div class="toggle-group">
          <button class="toggle-btn ${state.filters.namingType !== 'deck' ? 'active' : ''}" onclick="updateFilter('namingType', 'catalog')">Catalog Name</button>
          <button class="toggle-btn ${state.filters.namingType === 'deck' ? 'active' : ''}" onclick="updateFilter('namingType', 'deck')">Deck Name</button>
        </div>
      </div>` : ''}
      <ui5-button design="Transparent" onclick="clearFilters()">Clear</ui5-button>
      ${lastUpdated ? `<span class="last-updated">Last updated: ${new Date(lastUpdated).toLocaleString()}</span>` : ''}
    </div>
    ${loading ? '<div class="loading"><div class="loading-spinner"></div> Loading...</div>' : ''}
    ${!hasSearched && !loading ? `
      <div class="empty-state">
        <div style="font-size:2.5rem">🔍</div>
        <p style="font-size:1rem;font-weight:600">Use the filters above to explore the catalog</p>
        <p style="font-size:0.875rem">Search by keyword, select an Engagement Type, Business Scenario, or Module to get started.</p>
      </div>` : !loading && state.filteredServices.length === 0 ? `
      <div class="empty-state">
        <div style="font-size:2rem">😕</div>
        <p>No services found. Try adjusting your filters.</p>
      </div>` : !loading ? `
    <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;align-items:center;flex-wrap:wrap">
      <span class="results-info" style="margin:0;flex:1">${state.filteredServices.length} service(s) found
        ${state.selectedServices.size > 0 ? ` — <strong>${state.selectedServices.size} selected</strong>` : ''}
      </span>
      <button class="btn btn-secondary btn-sm" onclick="exportExcel()" title="Export selected (or all) to Excel">
        📊 Export Excel ${state.selectedServices.size > 0 ? `(${state.selectedServices.size})` : '(all)'}
      </button>
      <button class="btn btn-secondary btn-sm" onclick="generatePptx('short-description')" title="Short description list PPTX">
        📋 PPTX List ${state.selectedServices.size > 0 ? `(${state.selectedServices.size})` : '(all)'}
      </button>
      <button class="btn btn-primary btn-sm" onclick="generatePptx('one-pager')" title="One-pager per service PPTX">
        📄 PPTX One-Pagers ${state.selectedServices.size > 0 ? `(${state.selectedServices.size})` : '(all)'}
      </button>
    </div>
    ${state.pptx.error ? `<div class="error-strip" style="margin-bottom:0.5rem">⚠ ${state.pptx.error}</div>` : ''}
    ${state.pptx.downloadUrl ? `<div class="success-strip" style="margin-bottom:0.5rem">
      ✅ Ready! <a href="${CAP_BACKEND_URL}${state.pptx.downloadUrl}" download class="btn btn-primary btn-sm" style="margin-left:1rem">⬇ Download PPTX</a>
    </div>` : ''}
    <table class="service-table">
      <thead>
        <tr>
          <th style="width:2.5rem"><input type="checkbox" title="Select all" onchange="toggleSelectAll(this.checked)" /></th>
          <th>Service Name</th>
          <th>Short Description</th>
          <th>Engagement Type</th>
          <th>Module</th>
          <th>Code</th>
        </tr>
      </thead>
      <tbody>
        ${state.filteredServices.slice(0, 300).map(svc => {
          const useDeck = state.filters.namingType === 'deck' && state.filters.businessScenario;
          const bsNaming = svc.business_scenario_naming || svc.businessScenarioNaming || {};
          const bsCode = state.filters.businessScenario;
          // deck name stored by enrichment = actual name used in customer deck from Excel col 0
          // it is NOT "Foundational"/"Advanced" — those come from col H (engagementType label)
          // col 0 carry-forward deck name is stored as-is from the Excel
          const deckNameVal = useDeck ? (bsNaming[bsCode] || null) : null;
          const displayName = deckNameVal || svc.name;
          const subName     = deckNameVal && deckNameVal !== svc.name ? svc.name : null;
          return `
          <tr class="${state.selectedServices.has(svc.code) ? 'selected' : ''}">
            <td><input type="checkbox" ${state.selectedServices.has(svc.code)?'checked':''} onchange="toggleSelect('${svc.code}')" /></td>
            <td title="${(() => {
              const strip = h => (h||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
              const alt = strip(svc.summary) || strip(svc.keyBenefits) || strip(svc.description) || '';
              return alt.substring(0,300).replace(/"/g,'&quot;');
            })()}">
              <strong>${displayName}</strong>
              ${subName ? `<div style="font-size:0.75rem;color:#6a6a6a">${subName}</div>` : ''}
            </td>
            <td style="max-width:300px;font-size:0.8rem">${(svc.shortDescription||'').substring(0,120)}${(svc.shortDescription||'').length>120?'…':''}</td>
            <td>${engagementBadge(svc.engagementType)}</td>
            <td style="font-size:0.8rem">${moduleMap[svc.parentCode] || svc.parentCode || '—'}</td>
            <td style="font-size:0.75rem;color:#6a6a6a">${svc.code}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : ''}`;
}

function renderIncidentsPage() {
  const { file, results, loading, error } = state.incident;
  return `
    <h2>Incident Analysis</h2>
    <div class="card">
      <h3>Upload Customer Incident File</h3>
      <p style="color:#6a6a6a;font-size:0.875rem">Supported formats: .csv, .xlsx, .txt — max 5 MB</p>
      <div class="upload-area" id="upload-area" ondragover="event.preventDefault(); this.classList.add('dragover')"
           ondragleave="this.classList.remove('dragover')" ondrop="handleDrop(event)">
        <div style="font-size:2rem">📄</div>
        <p>${file ? `<strong>${file.name}</strong> (${(file.size/1024).toFixed(1)} KB)` : 'Drag & drop a file here, or click to browse'}</p>
        <input type="file" id="incident-file" accept=".csv,.xlsx,.txt" style="display:none" onchange="handleFileSelect(event)" />
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('incident-file').click()">Browse</button>
      </div>
      ${error ? `<div class="error-strip" style="margin-top:1rem">⚠ ${error}</div>` : ''}
      ${file ? `<button class="btn btn-primary" style="margin-top:1rem" onclick="analyzeIncidents()" ${loading?'disabled':''}>
        ${loading ? '⏳ Analyzing...' : '🔍 Analyze Incidents'}
      </button>` : ''}
    </div>
    ${loading ? '<div class="loading"><div class="loading-spinner"></div> Analyzing incidents with AI agent...</div>' : ''}
    ${results.length > 0 ? `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
        <h3 style="margin:0">${results.length} Recommended Services</h3>
        <button class="btn btn-primary btn-sm" onclick="addIncidentResultsToCart()">
          Add Selected to Export Cart (${state.incident.selectedCodes.size})
        </button>
      </div>
      ${results.map(svc => `
        <div class="incident-result">
          <input type="checkbox" ${state.incident.selectedCodes.has(svc.code)?'checked':''} onchange="toggleIncidentSelect('${svc.code}')" />
          <div style="flex:1">
            <div style="font-weight:600">${svc.name}</div>
            <div style="font-size:0.8rem;color:#6a6a6a;margin-top:2px">${svc.shortDescription}</div>
            ${svc.relevance_rationale ? `<div style="font-size:0.8rem;color:#0070F2;margin-top:4px;font-style:italic">💡 ${svc.relevance_rationale}</div>` : ''}
            ${engagementBadge(svc.engagementType)}
          </div>
        </div>`).join('')}
    </div>` : ''}`;
}

function renderExportPage() {
  const cartServices = state.exportCart.map(code => {
    const svc = state.catalog.services.find(s => s.code === code);
    return svc || { code, name: code, shortDescription: 'Service details not loaded' };
  });

  return `
    <h2>PPTX Export</h2>
    ${state.pptx.error ? `<div class="error-strip">⚠ ${state.pptx.error}</div>` : ''}
    ${state.pptx.downloadUrl ? `
    <div class="success-strip">
      ✅ Your PowerPoint is ready!
      <a href="${CAP_BACKEND_URL}${state.pptx.downloadUrl}" download class="btn btn-primary btn-sm" style="margin-left:1rem">
        ⬇ Download
      </a>
    </div>` : ''}
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
        <h3 style="margin:0">Export Cart (${cartServices.length} services)</h3>
        <button class="btn btn-danger btn-sm" onclick="clearCart()">🗑 Clear Cart</button>
      </div>
      ${cartServices.length > 50 ? `<div class="error-strip">⚠ Maximum 50 services per export. Please remove ${cartServices.length - 50} service(s).</div>` : ''}
      ${cartServices.length === 0 ? `
        <div class="empty-state">
          <p>Your export cart is empty. Go to the <a href="#" onclick="navigate('catalog')">Catalog Browser</a> or
          <a href="#" onclick="navigate('incidents')">Incident Analysis</a> to add services.</p>
        </div>` : `
      <table class="service-table">
        <thead><tr><th>Service Name</th><th>Short Description</th><th>Code</th><th></th></tr></thead>
        <tbody>
          ${cartServices.map(svc => `
            <tr>
              <td><strong>${svc.name}</strong></td>
              <td style="font-size:0.8rem">${(svc.shortDescription||'').substring(0,100)}</td>
              <td style="font-size:0.75rem;color:#6a6a6a">${svc.code}</td>
              <td><button class="btn btn-danger btn-sm" onclick="removeFromCart('${svc.code}')">✕</button></td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="card">
      <h3>Choose Template</h3>
      <div class="template-option ${state.pptx.template==='short-description'?'selected':''}" onclick="selectTemplate('short-description')">
        <input type="radio" name="template" value="short-description" ${state.pptx.template==='short-description'?'checked':''} />
        <div>
          <label style="font-weight:600">📋 Short Description List</label>
          <div style="font-size:0.8rem;color:#6a6a6a;margin-top:2px">One summary slide with all selected services — names, short descriptions, engagement types, and modules in a table.</div>
        </div>
      </div>
      <div class="template-option ${state.pptx.template==='one-pager'?'selected':''}" onclick="selectTemplate('one-pager')">
        <input type="radio" name="template" value="one-pager" ${state.pptx.template==='one-pager'?'checked':''} />
        <div>
          <label style="font-weight:600">📄 One-Pager per Service</label>
          <div style="font-size:0.8rem;color:#6a6a6a;margin-top:2px">One dedicated slide per service with full details — name, description, engagement type, module, and business scenarios.</div>
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:1rem" onclick="generatePptx()"
        ${state.pptx.generating || cartServices.length === 0 || cartServices.length > 50 ? 'disabled' : ''}>
        ${state.pptx.generating ? '⏳ Generating...' : '⬇ Generate & Download PowerPoint'}
      </button>
    </div>`;
}

function renderChatPage() {
  const { messages, loading, input } = state.chat;
  return `
    <h2>Agent Chat</h2>
    <div class="card" style="padding:0">
      <div class="chat-messages" id="chat-messages">
        ${messages.length === 0 ? `<div style="text-align:center;color:#6a6a6a;margin:auto">
          <p>💬 Ask me anything about the SSC Services Catalog.</p>
          <p style="font-size:0.8rem">Examples:<br>
          "Which services are in Max Success Plan for SAP IBP?"<br>
          "Show me all data migration services"<br>
          "What services help with performance optimization?"</p>
        </div>` : ''}
        ${messages.map(m => `<div class="chat-msg ${m.role}">${m.content}</div>`).join('')}
        ${loading ? '<div class="loading"><div class="loading-spinner"></div> Agent is thinking...</div>' : ''}
      </div>
      <div class="chat-input-row" style="padding:0.75rem;border-top:1px solid #e0e0e0">
        <input type="text" id="chat-input" value="${input}" placeholder="Ask a question..."
          onkeydown="if(event.key==='Enter')sendMessage()" oninput="state.chat.input=this.value" />
        <label style="cursor:pointer" title="Attach incident file">
          📎
          <input type="file" accept=".csv,.xlsx,.txt" style="display:none" onchange="attachFileToChat(event)" />
        </label>
        <button class="btn btn-primary" onclick="sendMessage()" ${loading?'disabled':''}>Send</button>
      </div>
    </div>`;
}

// ── Event handlers ─────────────────────────────────────────────────────────────

window.navigate = function(page) {
  state.currentPage = page;
  render();
  if (page === 'catalog' && state.catalog.services.length === 0) loadCatalog();
};

window.updateFilter = function(key, value) {
  state.filters[key] = value;
  // Reset cascading filters downstream
  if (key === 'businessScenario') { state.filters.modules = []; state.filters.module = ''; state.filters.deckName = ''; state.filters.namingType = ''; }
  clearTimeout(window._filterDebounce);
  window._filterDebounce = setTimeout(applyFilters, 300);
};

window.updateMultiFilter = function(key, selectEl) {
  const selected = Array.from(selectEl.selectedOptions).map(o => o.value);
  state.filters[key] = selected;
  if (key === 'modules') state.filters.module = selected.length === 1 ? selected[0] : '';
  clearTimeout(window._filterDebounce);
  window._filterDebounce = setTimeout(applyFilters, 300);
};

window.updateMultiFilterUI5 = function(key, combobox) {
  const selected = Array.from(combobox.querySelectorAll('ui5-mcb-item[selected]')).map(i => i.dataset.value || i.getAttribute('text'));
  state.filters[key] = selected;
  if (key === 'modules') state.filters.module = selected.length === 1 ? selected[0] : '';
  clearTimeout(window._filterDebounce);
  window._filterDebounce = setTimeout(applyFilters, 300);
};

window.clearFilters = function() {
  state.filters = { query: '', engagementType: '', businessScenario: '', module: '', modules: [], phases: [], supercats: [], deckName: '', namingType: '' };
  state.filteredServices = [];
  state.catalog.hasSearched = false;
  render();
};

window.toggleSelect = function(code) {
  if (state.selectedServices.has(code)) state.selectedServices.delete(code);
  else state.selectedServices.add(code);
  render();
};

window.addSelectedToCart = function() {
  state.selectedServices.forEach(code => {
    if (!state.exportCart.includes(code)) state.exportCart.push(code);
  });
  state.selectedServices.clear();
  saveCart();
  render();
  alert(`Added to export cart! Cart now has ${state.exportCart.length} service(s).`);
};

window.removeFromCart = function(code) {
  state.exportCart = state.exportCart.filter(c => c !== code);
  saveCart(); render();
};

window.clearCart = function() {
  state.exportCart = []; saveCart(); state.pptx.downloadUrl = null; render();
};

window.handleFileSelect = function(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('File too large (max 5 MB)'); return; }
  state.incident.file = file;
  state.incident.results = []; state.incident.error = null;
  render();
};

window.handleDrop = function(event) {
  event.preventDefault();
  document.getElementById('upload-area')?.classList.remove('dragover');
  const file = event.dataTransfer.files[0];
  if (file) { const dt = new DataTransfer(); dt.items.add(file); document.getElementById('incident-file').files = dt.files; window.handleFileSelect({ target: { files: [file] }}); }
};

window.analyzeIncidents = async function() {
  if (!state.incident.file) return;
  state.incident.loading = true; state.incident.error = null; render();
  try {
    const text = await state.incident.file.text();
    const body = JSON.stringify({
      message: `Analyze these customer incidents and recommend relevant SSC catalog services. Here is the file content:\n\n${text.substring(0, 50000)}`,
      contextId: 'incident-analysis-' + Date.now()
    });
    const res = await fetch(`${CAP_BACKEND_URL}/api/agent/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Analyze these customer incidents and recommend relevant SSC catalog services. Here is the file content:\n\n${text.substring(0, 50000)}`, contextId: 'incident-analysis-' + Date.now() }) });
    if (!res.ok) throw new Error(`Agent API error ${res.status}`);
    const data = await res.json();
    const content = data.message || data.content || JSON.stringify(data);
    // Parse service codes from agent response text
    state.incident.results = (state.catalog.services || [])
      .filter(s => content.toLowerCase().includes(s.name.toLowerCase().substring(0, 20)))
      .slice(0, 15)
      .map(s => ({ ...s, relevance_rationale: 'Matched based on incident content analysis' }));
    if (state.incident.results.length === 0) {
      state.incident.results = [{ code: 'info', name: 'Agent response', shortDescription: content.substring(0, 300), relevance_rationale: '' }];
    }
  } catch (e) { state.incident.error = e.message; }
  state.incident.loading = false; render();
};

window.toggleIncidentSelect = function(code) {
  if (state.incident.selectedCodes.has(code)) state.incident.selectedCodes.delete(code);
  else state.incident.selectedCodes.add(code);
  render();
};

window.addIncidentResultsToCart = function() {
  state.incident.selectedCodes.forEach(code => {
    if (!state.exportCart.includes(code)) state.exportCart.push(code);
  });
  state.incident.selectedCodes.clear();
  saveCart();
  alert(`Added to export cart! Cart now has ${state.exportCart.length} service(s).`);
  render();
};

window.toggleSelectAll = function(checked) {
  if (checked) state.filteredServices.forEach(s => state.selectedServices.add(s.code));
  else state.selectedServices.clear();
  render();
};

window.generatePptx = async function(template) {
  const codes = state.selectedServices.size > 0
    ? [...state.selectedServices]
    : state.filteredServices.map(s => s.code);
  if (codes.length === 0) { alert('No services to export.'); return; }
  if (codes.length > 50) { alert(`Too many services (${codes.length}). Max 50 for PPTX. Please select fewer.`); return; }
  state.pptx.generating = true; state.pptx.error = null; state.pptx.downloadUrl = null; render();
  try {
    const data = await apiFetch(`${CAP_BACKEND_URL}/api/pptx/generatePptx`, {
      method: 'POST',
      body: JSON.stringify({ serviceCodes: codes, template: template || 'short-description' })
    });
    state.pptx.downloadUrl = data.downloadUrl;
    const a = document.createElement('a');
    a.href = `${CAP_BACKEND_URL}${data.downloadUrl}`;
    a.download = data.filename;
    a.click();
  } catch (e) { state.pptx.error = e.message; }
  state.pptx.generating = false; render();
};

window.exportExcel = function() {
  const svcs = state.selectedServices.size > 0
    ? state.filteredServices.filter(s => state.selectedServices.has(s.code))
    : state.filteredServices;
  if (svcs.length === 0) { alert('No services to export.'); return; }

  // Build CSV
  const strip = html => (html||'').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const esc = v => `"${String(v||'').replace(/"/g,'""')}"`;

  const headers = ['Code','ServiceNumber','Name','ShortDescription','EngagementType','BusinessScenarioNaming','Summary','TeaserText','BusinessNeeds','KeyBenefits','DeliveryApproach','Description'];
  const rows = [headers.join(',')];
  for (const s of svcs) {
    const bsNaming = s.business_scenario_naming || s.businessScenarioNaming || {};
    const bsNamingStr = Object.entries(bsNaming).map(([k,v]) => `${k}:${v}`).join('; ');
    const et = Array.isArray(s.engagementType) ? s.engagementType.join('; ') : (s.engagementType||'');
    rows.push([
      esc(s.code), esc(s.serviceNumber||s.number||''), esc(s.name), esc(strip(s.shortDescription)),
      esc(et), esc(bsNamingStr),
      esc(strip(s.summary)), esc(strip(s.serviceTeaserText||s.teaserText)),
      esc(strip(s.businessNeeds)), esc(strip(s.keyBenefits)),
      esc(strip(s.deliveryApproach)), esc(strip(s.description))
    ].join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ssc_services_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

window.sendMessage = async function() {
  const input = document.getElementById('chat-input')?.value || state.chat.input;
  if (!input.trim()) return;
  state.chat.messages.push({ role: 'user', content: input });
  state.chat.input = ''; state.chat.loading = true; render();
  scrollChatToBottom();
  try {
    const res = await fetch(`${CAP_BACKEND_URL}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input, contextId: 'chat-session' })
    });
    if (!res.ok) throw new Error(`Agent error ${res.status}`);
    const data = await res.json();
    state.chat.messages.push({ role: 'agent', content: data.message || data.content || 'No response received.' });
  } catch (e) {
    state.chat.messages.push({ role: 'agent', content: `Error: ${e.message}` });
  }
  state.chat.loading = false; render(); scrollChatToBottom();
};

window.attachFileToChat = function(event) {
  const file = event.target.files[0];
  if (!file) return;
  state.incident.file = file;
  navigate('incidents');
};

function scrollChatToBottom() {
  setTimeout(() => {
    const el = document.getElementById('chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }, 50);
}

// ── Render ─────────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  const pages = [
    { id: 'catalog',   label: 'Catalog' },
    { id: 'incidents', label: 'Incidents' },
    { id: 'chat',      label: 'Chat' }
  ];

  let content = '';
  switch (state.currentPage) {
    case 'catalog':   content = renderCatalogPage(); break;
    case 'incidents': content = renderIncidentsPage(); break;
    case 'chat':      content = renderChatPage(); break;
  }

  app.innerHTML = `
    <div class="shell-bar">
      <span class="shell-bar-title">🗂 SSC Catalog Intelligence</span>
      <nav class="shell-nav">
        ${pages.map(p => `<a href="#" class="shell-nav-item ${state.currentPage===p.id?'active':''}" onclick="navigate('${p.id}');return false">${p.label}</a>`).join('')}
      </nav>
    </div>
    <div class="page-content">${content}</div>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render();
loadCatalog();
