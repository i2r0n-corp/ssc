/**
 * Sync routes — called by n8n workflows via SAP MCP Client.
 * The CAP backend owns all SSC Catalog API interactions.
 * n8n workflows trigger these endpoints; the actual sync logic runs here.
 *
 *   POST /api/catalog/sync/full          — full rebuild from SSC API + Excel enrichment
 *   POST /api/catalog/sync/incremental   — check changed BS, update only changed ones + re-enrich
 *   POST /api/catalog/sync/excel-enrich  — re-enrich from staged Excels (bsCode optional)
 */

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const snapshot = require('../store/snapshot');

const EXCEL_DIR = process.env.EXCEL_STORE_PATH || path.join(__dirname, '..', 'data', 'excels');

// ── Auth helper ───────────────────────────────────────────────────────────────
function requirePublishToken(req, res, next) {
  const token = process.env.CAP_PUBLISH_TOKEN;
  if (!token) return next();
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${token}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── SSC API helpers ───────────────────────────────────────────────────────────

async function fetchOAuthToken() {
  const authUrl = process.env.SSC_AUTH_URL;
  const clientId = process.env.SSC_CLIENT_ID;
  const clientSecret = process.env.SSC_CLIENT_SECRET;
  if (!authUrl || !clientId || !clientSecret) {
    throw new Error('SSC_AUTH_URL, SSC_CLIENT_ID, SSC_CLIENT_SECRET env vars are required for sync operations');
  }
  const https = require('https');
  const http = require('http');
  const url = new URL(authUrl);
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).access_token); } catch (e) { reject(new Error('Failed to parse token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sscGet(path_, token) {
  const baseUrl = process.env.SSC_CATALOG_BASE_URL;
  const https = require('https');
  const http = require('http');
  const url = new URL(baseUrl + path_);
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Failed to parse SSC response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllCatalogPages(token) {
  const siteId = process.env.SSC_SITE_ID || 'servicescatalog';
  const ENGAGEMENT_TYPES = [
    'Max Success Plan', 'Advanced Success Plan', 'Enterprise Support',
    'Embedded Launch Activities', 'Cloud Prepackaged Services'
  ];
  const facets = ENGAGEMENT_TYPES.map(et => `engagementType:${et}`).join(',');
  const results = [];
  let page = 0;
  let totalPages = 1;
  do {
    const data = await sscGet(`/${siteId}/services?facets=${encodeURIComponent(facets)}&pageSize=100&currentPage=${page}`, token);
    results.push(...(data.services || []));
    const p = data.pagination || {};
    totalPages = p.totalPages || 1;
    console.log(`  Catalog page ${page + 1}/${totalPages} — ${results.length} services so far`);
    page++;
    await new Promise(r => setTimeout(r, 200)); // courtesy delay
  } while (page < totalPages);
  return results;
}

async function fetchFullService(code, token) {
  const siteId = process.env.SSC_SITE_ID || 'servicescatalog';
  return sscGet(`/${siteId}/scservices/${code}?fields=FULL`, token);
}

// ── Excel enrichment ──────────────────────────────────────────────────────────

// ── Text normalisation helpers ────────────────────────────────────────────────

function _clean(val) {
  // lowercase + collapse whitespace
  return val ? String(val).trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function _norm(val) {
  // aggressive: lowercase, strip punctuation, collapse whitespace
  return val ? String(val).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// SAP product abbreviations — expand before fuzzy comparison
const ABBREV_MAP = {
  'ATM':  'Asset Performance Management',
  'APM':  'Asset Performance Management',
  'IBP':  'Integrated Business Planning',
  'TM':   'Transportation Management',
  'DM':   'Digital Manufacturing',
  'SSAM': 'Service and Asset Management',
  'EWM':  'Extended Warehouse Management',
  'FSA':  'Field Service Management',
};

// Negative-match guards: if term contains LEFT, candidate must NOT contain RIGHT
const BLOCKED_PAIRS = [
  ['business network', 'business data cloud'],
];

function _expandAbbreviations(text) {
  let result = text;
  for (const [abbr, full] of Object.entries(ABBREV_MAP)) {
    result = result.replace(new RegExp(`\\b${abbr}\\b`, 'gi'), full);
  }
  return result;
}

function _isBlockedMatch(termNormed, candidateNormed) {
  for (const [left, right] of BLOCKED_PAIRS) {
    if (termNormed.includes(left) && candidateNormed.includes(right)) return true;
  }
  return false;
}

// Simple SequenceMatcher ratio (Levenshtein-based similarity 0..1)
function _similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  const matrix = Array.from({ length: la + 1 }, (_, i) => Array.from({ length: lb + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      matrix[i][j] = a[i-1] === b[j-1]
        ? matrix[i-1][j-1]
        : 1 + Math.min(matrix[i-1][j], matrix[i][j-1], matrix[i-1][j-1]);
    }
  }
  return 1 - matrix[la][lb] / Math.max(la, lb);
}

const MODULE_CODE_RE = /^MAX\d{5}-\d+$/i;
const SKIP_VALS = new Set(['none', 'n/a', '', 'service name as per', 'crm id']);

// ── Sheet parsing ─────────────────────────────────────────────────────────────

function _detectSheetLayout(rows) {
  const headerKeywords = [[/crm|id/i, 'id'], [/service|catalog|name/i, 'name'], [/deck|scenario|success.?pack|module/i, 'deck']];
  const headerSignals = new Set();
  for (const row of rows.slice(0, 5)) {
    if (!row) continue;
    for (const cell of row) {
      if (!cell) continue;
      const s = String(cell).toLowerCase().trim();
      for (const [re, label] of headerKeywords) { if (re.test(s)) headerSignals.add(label); }
    }
  }
  if (headerSignals.size >= 2) return 'standard';
  let deckLike = 0, crmLike = 0;
  for (const row of rows.slice(1, 20)) {
    if (!row) continue;
    const col0 = row[0] != null ? String(row[0]).trim() : '';
    const col1 = row[1] != null ? String(row[1]).trim() : '';
    if (col0 && col0.length > 3 && !/^\d+$/.test(col0)) deckLike++;
    if (col1 && /^\d{6,}$/.test(col1)) crmLike++;
  }
  if (deckLike >= 2 && crmLike >= 1) return 'standard';
  return 'skip';
}

function _parseStandardSheet(rows) {
  // Col 0 = Deck name (CARRY-FORWARD)
  // Col 1 = CRM ID (may have multiple IDs)
  // Col 2 = Name as per service catalog
  // Col ?: Business Module (detected from header)
  const byCode = {}, byName = {};
  const moduleAssignments = [];
  let currentDeck = '';

  // Detect "business module" column from header row
  const header = rows[0] || [];
  let bmCol = null;
  for (let i = 0; i < header.length; i++) {
    if (header[i] && /business.?module/i.test(String(header[i]))) { bmCol = i; break; }
  }

  const _cell = (row, idx) => (idx != null && row && row[idx] != null) ? String(row[idx]).trim() : '';

  for (const row of rows.slice(1)) {
    if (!row || !row.some(c => c != null && c !== '')) continue;
    const col0 = _cell(row, 0);
    const col1 = _cell(row, 1);
    const col2 = _cell(row, 2);
    const moduleRaw = _cell(row, bmCol);

    // Carry-forward deck name
    if (col0 && !SKIP_VALS.has(col0.toLowerCase())) currentDeck = col0;
    if (!currentDeck) continue;

    // CRM ID mapping — may contain multiple IDs per cell
    const crmIds = [];
    if (col1 && !SKIP_VALS.has(col1.toLowerCase())) {
      col1.split(/[,/;\s]+/).forEach(id => {
        id = id.trim();
        if (id && /\d{6,}/.test(id)) {
          byCode[id] = currentDeck;
          const padded = id.padStart(18, '0');
          if (padded !== id) byCode[padded] = currentDeck;
          crmIds.push(id);
        }
      });
    }

    // Catalog name mapping
    const catName = col2 && !SKIP_VALS.has(col2.toLowerCase()) ? col2 : '';
    if (catName) byName[_clean(catName)] = currentDeck;

    // Deck name self-mapping
    byName[_clean(currentDeck)] = currentDeck;

    // Module assignment record (when business module column exists)
    if (moduleRaw && !SKIP_VALS.has(moduleRaw.toLowerCase())) {
      moduleAssignments.push({
        crmIds,
        catalogName: catName,
        deckName: currentDeck,
        moduleRaw,
        rawRow: row.map(c => c != null ? String(c) : ''),
        sheetHeaders: header.map(c => c != null ? String(c) : ''),
      });
    }
  }

  // Backfill crmIds for module assignments where ID was on a separate row
  const deckToCrmIds = {};
  for (const [cid, deck] of Object.entries(byCode)) { (deckToCrmIds[deck] = deckToCrmIds[deck] || []).push(cid); }
  for (const ma of moduleAssignments) {
    if (!ma.crmIds.length) ma.crmIds = deckToCrmIds[ma.deckName] || [];
  }

  return { byCode, byName, moduleAssignments };
}

function parseBsNameMapping(excelBuffer, bsCode) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(excelBuffer, { type: 'buffer' });
  const combined = { byCode: {}, byName: {}, moduleAssignments: [] };

  for (const sheetName of wb.SheetNames) {
    if (/reference|example|readme|info/i.test(sheetName)) continue;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (!rows.length) continue;
    const layout = _detectSheetLayout(rows);
    if (layout === 'skip') {
      console.log(`    Skipping sheet "${sheetName}" in ${bsCode} — unrecognised structure`);
      continue;
    }
    const { byCode, byName, moduleAssignments } = _parseStandardSheet(rows);
    Object.assign(combined.byCode, byCode);
    Object.assign(combined.byName, byName);
    combined.moduleAssignments.push(...moduleAssignments);
  }

  console.log(`    Parsed Excel for ${bsCode}: ${Object.keys(combined.byCode).length} code mappings, ${Object.keys(combined.byName).length} name mappings, ${combined.moduleAssignments.length} module assignments`);
  return combined;
}

// ── Module code resolution ────────────────────────────────────────────────────

function _resolveModuleCode(moduleRaw, flatIndex, bsCode) {
  if (!moduleRaw || !moduleRaw.trim()) return [null, 'empty'];
  const cleaned = _clean(moduleRaw);
  const normed  = _norm(moduleRaw);

  // 1. Direct code match
  if (MODULE_CODE_RE.test(moduleRaw.trim())) {
    const candidate = moduleRaw.trim().toUpperCase();
    if (flatIndex[candidate] && candidate.startsWith(bsCode)) return [candidate, 'exact code'];
  }

  // Build candidates from BS child modules
  const bsNode = flatIndex[bsCode] || {};
  const candidates = {};
  for (const modCode of bsNode.childServices || []) {
    const mod = flatIndex[modCode];
    if (!mod) continue;
    const full  = _clean(mod.name || '');
    const label = full.includes('//') ? full.split('//').pop().trim() : full;
    candidates[modCode] = { full, label, normLabel: _norm(label) };
  }

  // 2. Exact cleaned match
  for (const [code, { full, label }] of Object.entries(candidates)) {
    if (cleaned === full || cleaned === label) return [code, 'exact name'];
  }
  // 3. Substring containment
  for (const [code, { full, label }] of Object.entries(candidates)) {
    if (cleaned.includes(full) || cleaned.includes(label) || label.includes(cleaned)) return [code, 'substring'];
  }
  // 4. Punctuation-stripped
  for (const [code, { full, label, normLabel }] of Object.entries(candidates)) {
    const nFull = _norm(full);
    if (normed === nFull || normed === normLabel) return [code, 'norm exact'];
    if (normed.includes(normLabel) || normLabel.includes(normed)) return [code, 'norm substring'];
  }
  // NOTE: fuzzy matching omitted — too slow for CF health check
  return [null, 'no match'];
}

// ── Service code resolution ───────────────────────────────────────────────────

function _resolveServiceCode(assignment, flatIndex) {
  const { crmIds = [], catalogName = '', deckName = '' } = assignment;

  // 1. Exact flat_index key
  for (const cid of crmIds) { if (flatIndex[cid]) return [cid, `CRM exact key (${cid})`]; }

  // 2. serviceNumber field scan
  if (crmIds.length) {
    const cidSet = new Set(crmIds);
    for (const [code, svc] of Object.entries(flatIndex)) {
      const svcNum = String(svc.serviceNumber || '').trim();
      if (svcNum && cidSet.has(svcNum)) return [code, `serviceNumber match (${svcNum})`];
    }
  }

  // 3. Zero-padded 18-digit key
  for (const cid of crmIds) {
    try {
      const padded = String(parseInt(cid)).padStart(18, '0');
      if (padded !== cid && flatIndex[padded]) return [padded, `zero-padded (${cid}→${padded})`];
    } catch(e) {}
  }

  // 4. Catalog name exact clean match
  const cat = _clean(catalogName);
  if (cat) {
    for (const [code, svc] of Object.entries(flatIndex)) {
      if (_clean(svc.name || '') === cat) return [code, 'catalog name exact'];
    }
  }

  // 5. Deck name exact clean match
  const deck = _clean(deckName);
  if (deck) {
    for (const [code, svc] of Object.entries(flatIndex)) {
      if (_clean(svc.name || '') === deck) return [code, 'deck name exact'];
    }
  }

  // 6. _norm() exact + fuzzy (expanded abbreviations, leaf services only)
  const searchTerms = [];
  for (const key of ['catalogName', 'deckName']) {
    const orig = assignment[key] || '';
    if (!orig) continue;
    const texts = [orig];
    const stripped = orig.replace(/\s*\([^)]*\)/g, '').trim();
    if (stripped && stripped !== orig) texts.push(stripped);
    for (const text of texts) {
      const v = _norm(_expandAbbreviations(text));
      if (v && !searchTerms.find(t => t[0] === v)) searchTerms.push([v, key]);
    }
  }

  if (searchTerms.length) {
    // Build normed map — leaf services only (not BS or module nodes)
    const normedMap = {};
    for (const [code, svc] of Object.entries(flatIndex)) {
      if (svc.name && svc.serviceObject !== 'Business Scenario' && !MODULE_CODE_RE.test(code)) {
        normedMap[code] = _norm(svc.name);
      }
    }

    // 6a. _norm() exact
    for (const [term, field] of searchTerms) {
      for (const [code, normedName] of Object.entries(normedMap)) {
        if (term === normedName && !_isBlockedMatch(term, normedName)) return [code, `${field} norm exact`];
      }
    }

    // NOTE: fuzzy matching intentionally omitted — too slow for CF health check timeout
    // Fuzzy matching is handled by the local Python script (JWD agent) which has no timeout
  }

  return [null, ''];
}

// ── Main enrichment ───────────────────────────────────────────────────────────

function applyExcelEnrichment(flatIndex, bsCode, excelBuffer, injectionLog) {
  try {
    const { byCode, byName, moduleAssignments } = parseBsNameMapping(excelBuffer, bsCode);

    const totalMappings = Object.keys(byCode).length + Object.keys(byName).length;
    if (totalMappings === 0) {
      console.log(`    ⚠️  ${bsCode}: no mappings extracted — skipping`);
      return 0;
    }

    const bsSvc = flatIndex[bsCode];
    if (!bsSvc) { console.log(`    ⚠️  ${bsCode}: not found in flat_index`); return 0; }

    let matched = 0, unmatched = 0;
    const logRows = [];

    // ── Step 1: deck name injection onto child services ───────────────────────
    for (const modCode of bsSvc.childServices || []) {
      const mod = flatIndex[modCode];
      if (!mod) continue;
      for (const childCode of mod.childServices || []) {
        const child = flatIndex[childCode];
        if (!child) continue;

        const svcCode = String(child.code || '').trim();
        const svcNum  = String(child.serviceNumber || '').trim();
        const svcName = _clean(child.name || '');

        let deckName = null, matchMethod = null;

        // 5-strategy matching (same as original JWD script)
        if      (byCode[svcCode])              { deckName = byCode[svcCode];              matchMethod = `code:${svcCode}`; }
        else if (byCode[svcNum])               { deckName = byCode[svcNum];               matchMethod = `svcNum:${svcNum}`; }
        else if (byCode[svcCode.padStart(18,'0')]) { deckName = byCode[svcCode.padStart(18,'0')]; matchMethod = `paddedCode`; }
        else if (byCode[svcNum.padStart(18,'0')])  { deckName = byCode[svcNum.padStart(18,'0')];  matchMethod = `paddedNum`; }
        else if (byName[svcName])              { deckName = byName[svcName];              matchMethod = `catalogName`; }

        if (!child.business_scenario_naming) child.business_scenario_naming = {};
        if (deckName) {
          child.business_scenario_naming[bsCode] = deckName;
          matched++;
          logRows.push({ type: 'deck_name', svcCode, svcNum, svcName: child.name, module: modCode, deckName, method: matchMethod, status: 'Matched' });
        } else {
          unmatched++;
          logRows.push({ type: 'deck_name', svcCode, svcNum, svcName: child.name, module: modCode, deckName: null, method: null, status: 'No Match' });
        }
      }
    }

    console.log(`    ✅ ${bsCode}: ${matched} deck-name matched, ${unmatched} unmatched out of ${matched + unmatched} services`);

    // ── Step 2: module membership injection from Excel ────────────────────────
    let injected = 0, alreadyLinked = 0, unresolvedMod = 0, unresolvedSvc = 0;

    for (const asgn of moduleAssignments) {
      const [modCode, modNote] = _resolveModuleCode(asgn.moduleRaw, flatIndex, bsCode);
      if (!modCode) {
        unresolvedMod++;
        logRows.push({ type: 'module_injection', deckName: asgn.deckName, crmIds: asgn.crmIds.join('/'), catalogName: asgn.catalogName, moduleRaw: asgn.moduleRaw, resolvedModule: null, resolvedService: null, status: 'No Module Match', detail: modNote });
        continue;
      }

      const [svcCode, svcNote] = _resolveServiceCode(asgn, flatIndex);
      if (!svcCode) {
        unresolvedSvc++;
        logRows.push({ type: 'module_injection', deckName: asgn.deckName, crmIds: asgn.crmIds.join('/'), catalogName: asgn.catalogName, moduleRaw: asgn.moduleRaw, resolvedModule: modCode, resolvedService: null, status: 'No Service Match', detail: `module:${modNote}` });
        continue;
      }

      const modNode = flatIndex[modCode];
      if (!modNode) {
        logRows.push({ type: 'module_injection', deckName: asgn.deckName, crmIds: asgn.crmIds.join('/'), catalogName: asgn.catalogName, moduleRaw: asgn.moduleRaw, resolvedModule: modCode, resolvedService: svcCode, status: 'Module Not In Flat Index', detail: `module:${modNote}|svc:${svcNote}` });
        continue;
      }

      const children = modNode.childServices || (modNode.childServices = []);
      if (children.includes(svcCode)) {
        alreadyLinked++;
        logRows.push({ type: 'module_injection', deckName: asgn.deckName, crmIds: asgn.crmIds.join('/'), catalogName: asgn.catalogName, moduleRaw: asgn.moduleRaw, resolvedModule: modCode, resolvedService: svcCode, serviceName: (flatIndex[svcCode] || {}).name || '', status: 'Already Linked', detail: `module:${modNote}|svc:${svcNote}` });
      } else {
        children.push(svcCode);
        injected++;
        logRows.push({ type: 'module_injection', deckName: asgn.deckName, crmIds: asgn.crmIds.join('/'), catalogName: asgn.catalogName, moduleRaw: asgn.moduleRaw, resolvedModule: modCode, resolvedService: svcCode, serviceName: (flatIndex[svcCode] || {}).name || '', status: 'Added', detail: `module:${modNote}|svc:${svcNote}` });
      }
    }

    if (moduleAssignments.length > 0) {
      console.log(`    📋 ${bsCode} module injection: ${injected} added, ${alreadyLinked} already linked, ${unresolvedMod} no module, ${unresolvedSvc} no service`);
    }

    // Sample unmatched deck names for diagnosis
    const unmatchedSamples = logRows.filter(r => r.type === 'deck_name' && r.status === 'No Match').slice(0, 3);
    if (unmatchedSamples.length) {
      console.log(`    Sample unmatched: ${unmatchedSamples.map(r => `"${r.svcName}" (code:${r.svcCode}, num:${r.svcNum})`).join(' | ')}`);
    }

    if (injectionLog) {
      injectionLog[bsCode] = {
        matched, unmatched, injected, alreadyLinked, unresolvedMod, unresolvedSvc,
        rows: logRows
      };
    }

    return matched;
  } catch (e) {
    console.error(`    Excel enrichment failed for ${bsCode}: ${e.message}`);
    return 0;
  }
}

function buildHierarchy(flatIndex) {
  const hierarchy = [];
  for (const [code, svc] of Object.entries(flatIndex)) {
    if (svc.serviceObject !== 'Business Scenario') continue;
    const bs = { ...svc, _modules: [] };
    for (const modCode of svc.childServices || []) {
      if (!flatIndex[modCode]) continue;
      const mod = { ...flatIndex[modCode], _child_services: [] };
      for (const childCode of (flatIndex[modCode].childServices || [])) {
        if (flatIndex[childCode]) mod._child_services.push(flatIndex[childCode]);
      }
      bs._modules.push(mod);
    }
    hierarchy.push(bs);
  }
  return hierarchy;
}

function publishSnapshot(flatIndex, lastFullBuild) {
  const businessScenarios = buildHierarchy(flatIndex);
  const serviceCount = Object.keys(flatIndex).length;
  const data = {
    lastFullBuild: lastFullBuild || new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    serviceCount,
    payload: JSON.stringify({ last_full_build: lastFullBuild, last_updated: new Date().toISOString(), flat_index: flatIndex, business_scenarios: businessScenarios })
  };
  snapshot.save(data);
  console.log(`[M1.achieved]: catalog data product published — service_count=${serviceCount}`);
  return { serviceCount, businessScenarioCount: businessScenarios.length };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Full rebuild
router.post('/full', requirePublishToken, async (req, res) => {
  console.log('=== SYNC: FULL BUILD ===');
  try {
    const token = await fetchOAuthToken();
    console.log('Token acquired. Fetching catalog...');

    const services = await fetchAllCatalogPages(token);

    // Extra services
    const EXTRA_CODES = ['000000000050167308'];
    for (const code of EXTRA_CODES) {
      try {
        const extra = await fetchFullService(code, token);
        services.push(extra);
      } catch (e) { console.warn(`Extra service ${code} not found: ${e.message}`); }
    }

    const flatIndex = {};
    for (const svc of services) {
      if (svc && svc.code) flatIndex[svc.code] = svc;
    }
    console.log(`Flat index built: ${Object.keys(flatIndex).length} services`);

    // Enrich from staged Excels
    const bsCodes = Object.keys(flatIndex).filter(c => flatIndex[c].serviceObject === 'Business Scenario');
    let totalEnriched = 0;
    for (const bsCode of bsCodes) {
      const excelPath = path.join(EXCEL_DIR, `${bsCode}.xlsx`);
      if (fs.existsSync(excelPath)) {
        const buf = fs.readFileSync(excelPath);
        totalEnriched += applyExcelEnrichment(flatIndex, bsCode, buf);
      }
    }
    console.log(`Excel enrichment: ${totalEnriched} services enriched across ${bsCodes.length} BS`);

    const result = publishSnapshot(flatIndex, new Date().toISOString());
    res.json({ status: 'completed', mode: 'full', ...result, enrichedServices: totalEnriched });
  } catch (err) {
    console.error(`[M1.missed]: full sync failed — error=${err.message}`);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

// Incremental update
router.post('/incremental', requirePublishToken, async (req, res) => {
  console.log('=== SYNC: INCREMENTAL ===');
  try {
    const cached = snapshot.load();
    if (!cached) {
      return res.status(400).json({ error: 'No cached snapshot found. Run /sync/full first.' });
    }

    const token = await fetchOAuthToken();
    const siteId = process.env.SSC_SITE_ID || 'servicescatalog';
    const ENGAGEMENT_TYPES = ['Max Success Plan', 'Advanced Success Plan', 'Enterprise Support', 'Embedded Launch Activities', 'Cloud Prepackaged Services'];
    const facets = ENGAGEMENT_TYPES.map(et => `engagementType:${et}`).join(',');

    // Lightweight fetch — only code, name, modifiedTime
    const lightServices = [];
    let page = 0, totalPages = 1;
    do {
      const data = await sscGet(`/${siteId}/services?facets=${encodeURIComponent(facets)}&pageSize=100&currentPage=${page}&fields=services(code,name,serviceObject,modifiedTime),pagination`, token);
      lightServices.push(...(data.services || []));
      totalPages = (data.pagination || {}).totalPages || 1;
      page++;
    } while (page < totalPages);

    const cachedFlatIndex = JSON.parse(cached.payload).flat_index || {};
    const changedBsCodes = [];

    for (const svc of lightServices) {
      if (svc.serviceObject !== 'Business Scenario') continue;
      const cached_ = cachedFlatIndex[svc.code];
      if (!cached_ || cached_.modifiedTime !== svc.modifiedTime) {
        console.log(`  Changed BS: ${svc.code} (${svc.name})`);
        changedBsCodes.push(svc.code);
      }
    }

    if (changedBsCodes.length === 0) {
      console.log('No changes detected.');
      return res.json({ status: 'up-to-date', changedBsCount: 0 });
    }

    console.log(`Refreshing ${changedBsCodes.length} changed BS...`);
    for (const bsCode of changedBsCodes) {
      const bsFull = await fetchFullService(bsCode, token);
      cachedFlatIndex[bsCode] = bsFull;
      for (const modCode of bsFull.childServices || []) {
        const mod = await fetchFullService(modCode, token);
        cachedFlatIndex[modCode] = mod;
        for (const childCode of mod.childServices || []) {
          cachedFlatIndex[childCode] = await fetchFullService(childCode, token);
          await new Promise(r => setTimeout(r, 100));
        }
      }
      // Re-enrich from staged Excel
      const excelPath = path.join(EXCEL_DIR, `${bsCode}.xlsx`);
      if (fs.existsSync(excelPath)) {
        applyExcelEnrichment(cachedFlatIndex, bsCode, fs.readFileSync(excelPath));
      }
    }

    const result = publishSnapshot(cachedFlatIndex, cached.lastFullBuild);
    res.json({ status: 'completed', mode: 'incremental', changedBsCount: changedBsCodes.length, changedBsCodes, ...result });
  } catch (err) {
    console.error(`[M1.missed]: incremental sync failed — error=${err.message}`);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

// Excel-only enrichment — returns 202 immediately, processes in background
router.post('/excel-enrich', requirePublishToken, (req, res) => {
  console.log('=== SYNC: EXCEL ENRICH ===');
  const { bsCode } = req.body || {};
  const cached = snapshot.load();
  if (!cached) return res.status(400).json({ error: 'No cached snapshot found. Run /sync/full first.' });

  // Respond immediately so health check is never blocked
  res.status(202).json({ status: 'accepted', bsCode: bsCode || 'all' });

  // Process in background
  setImmediate(async () => {
    try {
      const flatIndex = JSON.parse(cached.payload).flat_index || {};
      const targetCodes = bsCode
        ? [bsCode]
        : Object.keys(flatIndex).filter(c => flatIndex[c].serviceObject === 'Business Scenario');

      let processed = 0, totalEnriched = 0;
      const notFound = [];
      const injectionLog = {};

      for (const code of targetCodes) {
        const excelPath = path.join(EXCEL_DIR, `${code}.xlsx`);
        if (!fs.existsSync(excelPath)) {
          notFound.push(code);
          continue;
        }
        const buf = fs.readFileSync(excelPath);
        totalEnriched += applyExcelEnrichment(flatIndex, code, buf, injectionLog);
        processed++;

        // Save snapshot after each BS so progress is never lost on restart
        publishSnapshot(flatIndex, cached.lastFullBuild);
      }

      // Save injection log
      const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalMatched: totalEnriched,
        bsProcessed: processed,
        bsNotFound: notFound,
        details: injectionLog
      }, null, 2));
      console.log(`    Injection log saved → data/injection-log.json`);
      console.log(`[M1.achieved]: excel-enrich published — bs_processed=${processed} enriched_services=${totalEnriched}`);
    } catch (err) {
      console.error(`[M1.missed]: excel-enrich background failed — error=${err.message}`);
    }
  });
});

// Get injection log
router.get('/injection-log', (req, res) => {
  const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'No injection log yet. Run excel-enrich first.' });
  try { res.json(JSON.parse(fs.readFileSync(logPath, 'utf8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
