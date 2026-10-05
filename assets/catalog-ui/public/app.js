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
  filters: { query: '', engagementType: '', businessScenario: '', module: '', modules: [], phases: [], phaseMode: 'merge', supercats: [], advancedLoS: [], advancedLoSMode: 'merge', foundationalCats: [], foundationalCatsMode: 'merge', maxFocusTopics: [], maxFocusTopicsMode: 'merge', deckName: '', namingType: '' },
  filteredServices: [],
  exportCart: JSON.parse(sessionStorage.getItem('exportCart') || '[]'),
  filtersExpanded: false,
  debug: { bsCode: '', module: '', status: '', rows: [], totals: null, loading: false, error: null, selectedRow: null },
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
    state.catalog.maxFocusTopics = data.maxFocusTopics || [];
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

function patchResults() {
  const el = document.getElementById('catalog-results');
  if (el) el.innerHTML = renderCatalogResults();
  else render();
}

function patchFilters() {
  const el = document.getElementById('catalog-filters');
  if (el) el.innerHTML = renderCatalogFilters();
  else render();
}

async function applyFilters() {
  const { query, engagementType, businessScenario, module: mod } = state.filters;
  const mods            = state.filters.modules       || [];
  const phases          = state.filters.phases        || [];
  const phaseMode       = state.filters.phaseMode      || 'merge';
  const supercats       = state.filters.supercats     || [];
  const advancedLoS     = state.filters.advancedLoS   || [];
  const advancedLoSMode = state.filters.advancedLoSMode || 'merge';
  const foundationalCats = state.filters.foundationalCats || [];
  const foundationalCatsMode = state.filters.foundationalCatsMode || 'merge';
  const maxFocusTopics  = state.filters.maxFocusTopics || [];
  const maxFocusTopicsMode = state.filters.maxFocusTopicsMode || 'merge';

  // Combine foundational supercats and keep advancedLoS separate for mode handling
  const allSupercats = [...new Set([...supercats])];

  // Nothing selected — clear results and show prompt
  if (!query && !engagementType && !businessScenario && !mod && mods.length === 0 && phases.length === 0 && allSupercats.length === 0 && advancedLoS.length === 0 && foundationalCats.length === 0 && maxFocusTopics.length === 0) {
    state.filteredServices = [];
    state.catalog.hasSearched = false;
    patchResults(); return;
  }

  state.catalog.hasSearched = true;
  state.catalog.loading = true; patchResults();

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
    if (phases.length > 0) params.set('phaseMode', phaseMode);
    // plain supercats (always OR union)
    allSupercats.forEach(s => params.append('supercat', s));
    // advanced LoS — sent separately so the backend can apply the right mode
    advancedLoS.forEach(s => params.append('advancedLoSCat', s));
    if (advancedLoS.length > 0) params.set('advancedLoSMode', advancedLoSMode);
    // foundational cats — sent separately so the backend can apply the right mode
    foundationalCats.forEach(s => params.append('foundationalCat', s));
    if (foundationalCats.length > 0) params.set('foundationalCatsMode', foundationalCatsMode);
    // max focus topics
    maxFocusTopics.forEach(t => params.append('maxFocusTopic', t));
    if (maxFocusTopics.length > 0) params.set('maxFocusTopicsMode', maxFocusTopicsMode);

    const url = query
      ? `${CAP_BACKEND_URL}/api/catalog/searchServices?${params}`
      : `${CAP_BACKEND_URL}/api/catalog/filterServices?${params}`;

    const data = await apiFetch(url);
    state.filteredServices = data.services || [];
  } catch (e) {
    state.filteredServices = [];
  }
  state.catalog.loading = false; patchResults();
}

// ── ET display mapping ────────────────────────────────────────────────────────
// "Enterprise Support" → displayed as "Foundational" everywhere in results
function mapEtDisplay(val) {
  if (!val) return val;
  return val === 'Enterprise Support' ? 'Foundational' : val;
}

// ── Engagement type badge ─────────────────────────────────────────────────────
function engagementBadge(et) {
  let arr = Array.isArray(et) ? et : (et ? [et] : []);
  if (arr.length === 0) return '—';
  const activeET = state.filters.engagementType;
  if (activeET) {
    // ET filter active — show only that ET's badge
    arr = arr.includes(activeET) ? [activeET] : arr;
  } else if (arr.length > 1) {
    // No ET filter — show only the base/foundational ET to avoid multi-badge clutter
    const priority = ['Enterprise Support', 'Advanced Success Plan', 'Max Success Plan'];
    const base = priority.find(p => arr.includes(p));
    if (base) arr = [base];
  }
  return arr.map(val => {
    const display = mapEtDisplay(val);
    const cls = display.includes('Max') ? 'badge-max' : display.includes('Advanced') ? 'badge-adv' : 'badge-ent';
    return `<span class="badge ${cls}">${display}</span>`;
  }).join(' ');
}

// ── Pages ─────────────────────────────────────────────────────────────────────

function renderCatalogFilters() {
  const { error, moduleMap = {}, bsMap = {}, phases = [], supercategories = [], maxFocusTopics: allMaxTopics = [] } = state.catalog;

  const ET_OPTIONS = [
    { value: 'Max Success Plan',      label: 'Max Success Plan' },
    { value: 'Advanced Success Plan', label: 'Advanced Success Plan' },
    { value: 'Enterprise Support',    label: 'Foundational Success Plan' },
  ];

  const uniqueBS = Object.entries(bsMap)
    .map(([code, name]) => {
      const label = name.includes('-') ? name.replace(/^[^-]+-\s*/, '') : name;
      return [code, name, label];
    })
    .sort((a, b) => a[2].localeCompare(b[2]));

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

  const selectedMods = state.filters.modules || [];
  const et = state.filters.engagementType;
  const queryOrBS = !!(state.filters.query || state.filters.businessScenario);

  const activatePhaseActive  = queryOrBS;
  const maxTopicsActive      = (queryOrBS || et === 'Max Success Plan')      && et !== 'Advanced Success Plan' && et !== 'Enterprise Support';
  const advancedActive       = (queryOrBS || et === 'Advanced Success Plan') && et !== 'Max Success Plan'      && et !== 'Enterprise Support';
  const foundationalActive   = (queryOrBS || et === 'Enterprise Support')    && et !== 'Max Success Plan'      && et !== 'Advanced Success Plan';
  const disabledStyle = 'opacity:0.4;pointer-events:none';

  const advancedLoSItems  = supercategories.filter(s => s.startsWith('Success Plans for'));
  const foundationalItems = supercategories.filter(s => !s.startsWith('Success Plans for'));

  const showAdvancedBadge     = et === 'Advanced Success Plan';
  const showFoundationalBadge = et === 'Enterprise Support';
  const showMaxBadge          = et === 'Max Success Plan';

  const namingDisabled = et === 'Max Success Plan' || !state.filters.businessScenario;
  const namingStyle    = namingDisabled ? disabledStyle : '';
  const namingActive   = !namingDisabled && !!state.filters.businessScenario;

  return `
    ${error ? `<div class="error-strip">⚠ ${error}</div>` : ''}
    <div class="filter-row" style="flex-direction:column;gap:0;padding:0">

      <!-- Two-column top area -->
      <div class="filter-columns">

        <!-- Left column: BS + naming toggle + hr + Keywords + ET -->
        <div class="filter-col-left">
          <!-- BS field: static label + naming toggle + select -->
          <div style="width:100%;display:flex;flex-direction:column;gap:4px">
            <label style="font-size:0.75rem;color:#6a6a6a;font-weight:600">Business Scenario</label>
            <div style="display:flex;align-items:center;gap:6px;${namingStyle}">
              <div class="mode-switch" style="margin-bottom:0">
                <button class="${state.filters.namingType !== 'deck' ? 'active' : ''}" onclick="updateFilter('namingType', 'catalog')">Catalog Name</button>
                <button class="${state.filters.namingType === 'deck' ? 'active' : ''}" onclick="updateFilter('namingType', 'deck')">Deck Name</button>
              </div>
            </div>
            <select id="filter-bs" ${!state.filters.businessScenario ? 'data-empty="true"' : ''}
              onchange="updateFilter('businessScenario', this.value); this.dataset.empty = this.value ? 'false' : 'true'">
              <option value=""></option>
              ${uniqueBS.map(([code, , label]) => `<option value="${code}" ${state.filters.businessScenario===code?'selected':''}>${label}</option>`).join('')}
            </select>
          </div>

          <hr style="border:none;border-top:1px solid #e0e0e0;margin:0.75rem 0" />

          <div style="display:flex;gap:1rem">
            <div class="fl-field" style="flex:1;min-width:0">
              <input type="search" id="filter-query" placeholder=" " value="${state.filters.query}"
                oninput="updateFilter('query', this.value)" />
              <label>Keywords</label>
            </div>
            <div class="fl-field" style="flex:1;min-width:0">
              <select id="filter-et" ${!state.filters.engagementType ? 'data-empty="true"' : ''}
                onchange="updateFilter('engagementType', this.value); this.dataset.empty = this.value ? 'false' : 'true'">
                <option value=""></option>
                ${ET_OPTIONS.map(o => `<option value="${o.value}" ${state.filters.engagementType===o.value?'selected':''}>${o.label}</option>`).join('')}
              </select>
              <label>Engagement Type</label>
            </div>
          </div>
        </div>

        <!-- Right column: Module (only when BS selected) -->
        ${showModuleFilter ? `
        <div class="filter-col-right">
          <!-- Module label + clear -->
          <div style="display:flex;align-items:center;gap:6px">
            <div style="font-size:0.75rem;color:#6a6a6a;font-weight:600;flex:1">Module</div>
            ${selectedMods.length > 0 ? `<button class="mode-switch-clear" title="Clear modules" onclick="updateCheckboxFilter._clearKey('modules')">✕</button>` : ''}
          </div>
          <!-- Module checkboxes -->
          <div class="check-panel" style="flex:1;max-height:9.9rem">
            ${uniqueMods.map(([code, name]) => {
              const label = name.includes(' // ') ? name.split(' // ').slice(1).join(' // ') : name;
              return `<label>
                <input type="checkbox" value="${code}" ${selectedMods.includes(code)?'checked':''}
                  onchange="updateCheckboxFilter('modules', '${code}', this.checked)" />
                ${label}
              </label>`;
            }).join('')}
          </div>
        </div>` : ''}
      </div>

      <!-- Divider + More filters toggle (mobile only) -->
      <button class="filter-more-btn" onclick="toggleMoreFilters()">
        ${state.filtersExpanded ? '▲ Less filters' : '▼ More filters'}
      </button>

      <!-- Section 3: 4 checkbox filters -->
      <div class="filter-sec3 ${state.filtersExpanded ? 'expanded' : ''}">

        ${phases.length > 0 ? `
        <div class="filter-group" style="${activatePhaseActive ? '' : disabledStyle}">
          <label>Activate Phases</label>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
            <div class="mode-switch">
              <button class="${(state.filters.phaseMode||'merge')==='merge'?'active':''}" onclick="updateFilter('phaseMode','merge')">Merge</button>
              <button class="${state.filters.phaseMode==='intersect'?'active':''}" onclick="updateFilter('phaseMode','intersect')">Intersect</button>
            </div>
            ${(state.filters.phases||[]).length > 0 ? `<button class="mode-switch-clear" title="Clear" onclick="updateCheckboxFilter._clearKey('phases')">✕</button>` : ''}
          </div>
          <div class="check-panel">
            ${phases.map(p => `<label>
              <input type="checkbox" value="${p}" ${(state.filters.phases||[]).includes(p)?'checked':''}
                onchange="updateCheckboxFilter('phases', '${p}', this.checked)" />
              ${p}</label>`).join('')}
          </div>
        </div>` : ''}

        ${allMaxTopics.length > 0 ? `
        <div class="filter-group" style="${maxTopicsActive ? '' : disabledStyle}">
          <label>Max Focus Topics${showMaxBadge ? '' : ' <span style="font-size:0.65rem;color:#8696A9;font-weight:400">(Max)</span>'}</label>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;min-height:1.6rem">
            ${(state.filters.maxFocusTopics||[]).length > 0 ? `<button class="mode-switch-clear" title="Clear" onclick="updateCheckboxFilter._clearKey('maxFocusTopics')">✕</button>` : ''}
          </div>
          <div class="check-panel">
            ${allMaxTopics.map(t => `<label>
              <input type="checkbox" value="${t}" ${(state.filters.maxFocusTopics||[]).includes(t)?'checked':''}
                onchange="updateCheckboxFilter('maxFocusTopics', '${t.replace(/'/g,"\\'")}', this.checked)" />
              ${t}</label>`).join('')}
          </div>
        </div>` : ''}

        ${advancedLoSItems.length > 0 ? `
        <div class="filter-group" style="${advancedActive ? '' : disabledStyle}">
          <label>Advanced LoB${showAdvancedBadge ? '' : ' <span style="font-size:0.65rem;color:#8696A9;font-weight:400">(Advanced)</span>'}</label>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
            <div class="mode-switch">
              <button class="${(state.filters.advancedLoSMode||'merge')==='merge'?'active':''}" onclick="updateFilter('advancedLoSMode','merge')">Merge</button>
              <button class="${state.filters.advancedLoSMode==='intersect'?'active':''}" onclick="updateFilter('advancedLoSMode','intersect')">Intersect</button>
            </div>
            ${(state.filters.advancedLoS||[]).length > 0 ? `<button class="mode-switch-clear" title="Clear" onclick="updateCheckboxFilter._clearKey('advancedLoS')">✕</button>` : ''}
          </div>
          <div class="check-panel">
            ${advancedLoSItems.map(s => `<label>
              <input type="checkbox" value="${s}" ${(state.filters.advancedLoS||[]).includes(s)?'checked':''}
                onchange="updateCheckboxFilter('advancedLoS', '${s.replace(/'/g,"\\'")}', this.checked)" />
              ${s.replace('Success Plans for ', '')}</label>`).join('')}
          </div>
        </div>` : ''}

        ${foundationalItems.length > 0 ? `
        <div class="filter-group" style="${foundationalActive ? '' : disabledStyle}">
          <label>Foundation subcategories${showFoundationalBadge ? '' : ' <span style="font-size:0.65rem;color:#8696A9;font-weight:400">(Foundation)</span>'}</label>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
            <div class="mode-switch">
              <button class="${(state.filters.foundationalCatsMode||'merge')==='merge'?'active':''}" onclick="updateFilter('foundationalCatsMode','merge')">Merge</button>
              <button class="${state.filters.foundationalCatsMode==='intersect'?'active':''}" onclick="updateFilter('foundationalCatsMode','intersect')">Intersect</button>
            </div>
            ${(state.filters.foundationalCats||[]).length > 0 ? `<button class="mode-switch-clear" title="Clear" onclick="updateCheckboxFilter._clearKey('foundationalCats')">✕</button>` : ''}
          </div>
          <div class="check-panel">
            ${foundationalItems.map(s => `<label>
              <input type="checkbox" value="${s}" ${(state.filters.foundationalCats||[]).includes(s)?'checked':''}
                onchange="updateCheckboxFilter('foundationalCats', '${s.replace(/'/g,"\\'")}', this.checked)" />
              ${s}</label>`).join('')}
          </div>
        </div>` : ''}

        <button class="btn btn-secondary btn-sm" style="align-self:flex-end;margin-left:auto" onclick="clearFilters()">Clear</button>
      </div>
    </div>`;
}

function renderCatalogPage() {
  const { lastUpdated } = state.catalog;
  return `
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.5rem">
      <h2 style="margin:0">Catalogue Browser</h2>
      ${lastUpdated ? `<span class="last-updated">Last updated: ${new Date(lastUpdated).toLocaleString()}</span>` : ''}
    </div>
    <div id="catalog-filters">${renderCatalogFilters()}</div>
    <div id="catalog-results">${renderCatalogResults()}</div>`;
}

function renderCatalogResults() {
  const { loading, moduleMap = {} } = state.catalog;
  const hasSearched = state.catalog.hasSearched;
  return `
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
          <th style="width:2.5rem"><input type="checkbox" title="Select all / deselect all"
            ${state.filteredServices.length > 0 && state.filteredServices.every(s => state.selectedServices.has(s.code)) ? 'checked' : ''}
            onchange="toggleSelectAll(this.checked)" /></th>
          <th>Service Name</th>
          <th>Short Description</th>
          <th>Engagement Type</th>
          <th>Module</th>
          <th>Code</th>
        </tr>
      </thead>
      <tbody>
        ${state.filteredServices.slice(0, 2000).map(svc => {
          const useDeck = state.filters.namingType === 'deck' && state.filters.businessScenario;
          const bsNaming = svc.business_scenario_naming || svc.businessScenarioNaming || {};
          const bsCode = state.filters.businessScenario;
          // deck name stored by enrichment = actual name used in customer deck from Excel col 0
          // it is NOT "Foundational"/"Advanced" — those come from col H (engagementType label)
          // col 0 carry-forward deck name is stored as-is from the Excel
          const deckNameVal = useDeck ? (bsNaming[bsCode] || null) : null;
          const displayName = deckNameVal || svc.name;
          const subName     = deckNameVal && deckNameVal !== svc.name ? svc.name : null;
          const nameHtml    = svc.url
            ? `<a href="${svc.url}" target="_blank" rel="noopener" style="color:#0070F2;text-decoration:none;font-weight:700">${displayName}</a>`
            : `<strong>${displayName}</strong>`;
          return `
          <tr class="${state.selectedServices.has(svc.code) ? 'selected' : ''}">
            <td><input type="checkbox" ${state.selectedServices.has(svc.code)?'checked':''} onchange="toggleSelect('${svc.code}')" /></td>
            <td title="${(() => {
              const strip = h => (h||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
              const alt = strip(svc.summary) || strip(svc.keyBenefits) || strip(svc.description) || '';
              return alt.substring(0,300).replace(/"/g,'&quot;');
            })()}">
              ${nameHtml}
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
          <p>Your export cart is empty. Go to the <a href="#" onclick="navigate('catalog')">Catalogue Browser</a> or
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
  if (page === 'debug') loadDebugLog();
};

window.updateFilter = function(key, value) {
  state.filters[key] = value;
  if (key === 'businessScenario') { state.filters.modules = []; state.filters.module = ''; state.filters.deckName = ''; state.filters.namingType = ''; }
  // These keys change filter panel structure — full re-render
  const needsFullRender = key === 'businessScenario' || key === 'engagementType';
  // Mode-switch keys and query-state keys only need filter panel patch + results
  const needsFilterPatch = key === 'phaseMode' || key === 'advancedLoSMode' || key === 'foundationalCatsMode' || key === 'maxFocusTopicsMode' || key === 'namingType' || key === 'query';
  clearTimeout(window._filterDebounce);
  if (needsFullRender) {
    window._filterDebounce = setTimeout(() => { render(); applyFilters(); }, 300);
  } else if (needsFilterPatch) {
    patchFilters();
    window._filterDebounce = setTimeout(applyFilters, 300);
  } else {
    window._filterDebounce = setTimeout(applyFilters, 300);
  }
};

window.updateCheckboxFilter = function(key, value, checked) {
  const arr = state.filters[key] ? [...state.filters[key]] : [];
  if (checked && !arr.includes(value)) arr.push(value);
  else if (!checked) { const i = arr.indexOf(value); if (i > -1) arr.splice(i, 1); }
  state.filters[key] = arr;
  patchFilters();
  clearTimeout(window._filterDebounce);
  window._filterDebounce = setTimeout(applyFilters, 300);
};
window.updateCheckboxFilter._clearKey = function(key) {
  state.filters[key] = [];
  if (key === 'modules') state.filters.module = '';
  patchFilters();
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

window.toggleMoreFilters = function() {
  state.filtersExpanded = !state.filtersExpanded;
  patchFilters();
};

window.clearFilters = function() {
  state.filters = { query: '', engagementType: '', businessScenario: '', module: '', modules: [], phases: [], phaseMode: 'merge', supercats: [], advancedLoS: [], advancedLoSMode: 'merge', foundationalCats: [], foundationalCatsMode: 'merge', maxFocusTopics: [], maxFocusTopicsMode: 'merge', deckName: '', namingType: '' };
  state.filteredServices = [];
  state.catalog.hasSearched = false;
  render();
};

window.toggleSelect = function(code) {
  if (state.selectedServices.has(code)) state.selectedServices.delete(code);
  else state.selectedServices.add(code);
  patchResults();
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
  patchResults();
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

// ── Debug / Matching Log ───────────────────────────────────────────────────────

async function loadDebugLog() {
  state.debug.loading = true;
  state.debug.error = null;
  try {
    const params = new URLSearchParams();
    if (state.debug.bsCode)  params.set('bsCode',  state.debug.bsCode);
    if (state.debug.module)  params.set('module',  state.debug.module);
    if (state.debug.status)  params.set('status',  state.debug.status);
    const res = await fetch(`${CAP_BACKEND_URL}/api/catalog/injection-log?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.debug.rows   = data.rows   || [];
    state.debug.totals = data.totals || null;
  } catch (e) {
    state.debug.error = e.message;
    state.debug.rows  = [];
  }
  state.debug.loading = false;
  render();
}

let _debugFilterTimer = null;

window.updateDebugFilter = function(key, value, debounce) {
  state.debug[key] = value;
  if (debounce) {
    clearTimeout(_debugFilterTimer);
    _debugFilterTimer = setTimeout(() => loadDebugLog(), 500);
  } else {
    loadDebugLog();
  }
};

function renderDebugPage() {
  const { bsCode, module, status, rows, totals, loading, error } = state.debug;

  const bsOptions = Object.entries(state.catalog.bsMap || {})
    .map(([code, name]) => {
      const label = name.includes('-') ? name.replace(/^[^-]+-\s*/, '') : name;
      return `<option value="${code}" ${bsCode === code ? 'selected' : ''}>${label}</option>`;
    })
    .sort((a, b) => a.localeCompare(b))
    .join('');

  const statusOptions = [
    ['',                  'All statuses'],
    ['Matched',           'Matched'],
    ['No Match',          'No Match'],
    ['Added',             'Added'],
    ['Already Linked',    'Already Linked'],
    ['No Module Match',   'No Module Match'],
    ['No Service Match',  'No Service Match'],
  ].map(([v, l]) => `<option value="${v}" ${status === v ? 'selected' : ''}>${l}</option>`).join('');

  const totalsHtml = totals ? `
    <div style="display:flex;gap:1.5rem;flex-wrap:wrap;font-size:0.8rem;margin-bottom:1rem;background:white;padding:0.75rem 1rem;border-radius:6px;border:1px solid #e0e0e0;">
      <span>Matched: <b>${totals.matched||0}</b></span>
      <span>Unmatched: <b>${totals.unmatched||0}</b></span>
      <span>Injected: <b>${totals.injected||0}</b></span>
      <span>Already linked: <b>${totals.already_linked||0}</b></span>
      <span>No module: <b>${totals.unresolved_mod||0}</b></span>
      <span>No service: <b>${totals.unresolved_svc||0}</b></span>
      <span style="margin-left:auto;color:#6a6a6a">${rows.length} rows shown</span>
    </div>` : '';

  const statusBadge = s => {
    const map = {
      'Matched':          ['#d4edda','#155724'],
      'No Match':         ['#f8d7da','#721c24'],
      'Added':            ['#d1ecf1','#0c5460'],
      'Already Linked':   ['#fff3cd','#856404'],
      'No Module Match':  ['#e2e3e5','#383d41'],
      'No Service Match': ['#fdecea','#c0392b'],
      'Module Not In Flat Index': ['#fdecea','#c0392b'],
    };
    const [bg, color] = map[s] || ['#e2e3e5','#383d41'];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.72rem;font-weight:600;background:${bg};color:${color}">${s||''}</span>`;
  };

  const rowsHtml = rows.length === 0 && !loading ? `
    <tr><td colspan="5" style="text-align:center;padding:2rem;color:#6a6a6a;">No records found</td></tr>` :
    rows.map(r => `
      <tr onclick="openDebugRow(${r.id})" style="cursor:pointer">
        <td style="font-size:0.78rem;color:#556B82">${r.bs_code||''}</td>
        <td style="font-size:0.82rem">${r.service_name||r.service_code||''}</td>
        <td style="font-size:0.78rem;color:#556B82">${r.module_name||r.module_code||''}</td>
        <td>${statusBadge(r.status)}</td>
        <td style="font-size:0.78rem;color:#6a6a6a;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${(r.deck_name||'').replace(/"/g,'&quot;')}">${r.deck_name||''}</td>
      </tr>`).join('');

  return `
    ${state.debug.selectedRow ? (() => {
      const r = state.debug.selectedRow;
      const fields = [
        ['BS Code', r.bs_code], ['Type', r.type], ['Status', r.status],
        ['Service Code', r.service_code], ['Service Name', r.service_name],
        ['Module Code', r.module_code], ['Module Name', r.module_name],
        ['Deck Name', r.deck_name], ['CRM IDs', r.crm_ids],
      ].filter(([,v]) => v);
      const stepsHtml = (r.steps||[]).length > 0 ? `
        <h4 style="margin:1rem 0 0.5rem;font-size:0.85rem;color:#1D2D3E">Resolution Steps</h4>
        <table class="steps-table">
          <thead><tr><th>Type</th><th>Excel Value</th><th>DB Value</th><th>Method</th><th>Threshold</th><th>Result</th></tr></thead>
          <tbody>${(r.steps||[]).map(s => `
            <tr class="${s.result}">
              <td>${s.type||''}</td>
              <td style="max-width:180px;word-break:break-all">${s.excel_value||''}</td>
              <td style="max-width:180px;word-break:break-all">${s.db_value||''}</td>
              <td>${s.method||''}</td>
              <td>${s.threshold||''}</td>
              <td><b>${s.result||''}</b></td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<p style="font-size:0.8rem;color:#6a6a6a;margin-top:0.5rem">No resolution steps recorded</p>';
      return `
        <div class="modal-overlay" onclick="if(event.target===this)closeDebugModal()">
          <div class="modal-box">
            <button class="modal-close" onclick="closeDebugModal()">&#x2715;</button>
            <h3 style="margin:0 0 1rem">${r.status} &mdash; ${(r.service_name||r.service_code||'').replace(/</g,'&lt;')}</h3>
            ${fields.map(([k,v]) => `<div style="display:flex;gap:0.5rem;margin-bottom:0.3rem;font-size:0.82rem"><span style="min-width:110px;color:#6a6a6a;font-weight:600">${k}</span><span>${String(v).replace(/</g,'&lt;')}</span></div>`).join('')}
            ${stepsHtml}
          </div>
        </div>`;
    })() : ''}
    <h2>Matching Debug</h2>
    <div class="filter-row" style="gap:1rem;flex-wrap:wrap;align-items:flex-end">
      <div style="display:flex;flex-direction:column;gap:4px;min-width:220px;max-width:320px">
        <label style="font-size:0.75rem;color:#6a6a6a;font-weight:600">Business Scenario</label>
        <select onchange="updateDebugFilter('bsCode',this.value)">
          <option value="">All business scenarios</option>
          ${bsOptions}
        </select>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:160px;max-width:240px">
        <label style="font-size:0.75rem;color:#6a6a6a;font-weight:600">Module (contains)</label>
        <input type="text" value="${module}" oninput="updateDebugFilter('module',this.value,true)" />
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:160px;max-width:220px">
        <label style="font-size:0.75rem;color:#6a6a6a;font-weight:600">Status</label>
        <select onchange="updateDebugFilter('status',this.value)">
          ${statusOptions}
        </select>
      </div>
      ${loading ? `<div class="loading"><div class="loading-spinner"></div> Loading…</div>` : ''}
    </div>
    ${error ? `<div class="error-strip">Error: ${error.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
    ${totalsHtml}
    <div style="overflow-x:auto">
      <table class="service-table">
        <thead>
          <tr>
            <th>BS Code</th>
            <th>Service</th>
            <th>Module</th>
            <th>Status</th>
            <th>Deck Name</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

// ── Render ─────────────────────────────────────────────────────────────────────

window.openDebugRow = function(id) {
  const row = state.debug.rows.find(r => String(r.id) === String(id));
  if (row) { state.debug.selectedRow = row; render(); }
};
window.closeDebugModal = function() {
  state.debug.selectedRow = null; render();
};

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  const pages = [
    { id: 'catalog',   label: 'Catalogue Browser' },
    { id: 'incidents', label: 'Incidents' },
    { id: 'chat',      label: 'Chat' },
    { id: 'debug',     label: 'Matching Debug' },
  ];

  let content = '';
  switch (state.currentPage) {
    case 'catalog':   content = renderCatalogPage(); break;
    case 'incidents': content = renderIncidentsPage(); break;
    case 'chat':      content = renderChatPage(); break;
    case 'debug':     content = renderDebugPage(); break;
  }

  app.innerHTML = `
    <div class="shell-bar">
      <span class="shell-bar-title">🗂 SSC Intelligence</span>
      <nav class="shell-nav">
        ${pages.map(p => `<a href="#" class="shell-nav-item ${state.currentPage===p.id?'active':''}" onclick="navigate('${p.id}');return false">${p.label}</a>`).join('')}
      </nav>
    </div>
    <div class="page-content">${content}</div>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render();
loadCatalog();
