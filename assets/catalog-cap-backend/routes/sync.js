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
    await new Promise(r => setTimeout(r, 200));
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
  let layerCol = null; // "success plan layer" column — contains "Foundational", "Advanced" etc.
  for (let i = 0; i < header.length; i++) {
    const h = header[i] ? String(header[i]).toLowerCase().trim() : '';
    if (/business.?module/i.test(h)) bmCol = i;
    if (/success.?plan.?layer|engagement.?layer|plan.?layer|sp.?layer/i.test(h)) layerCol = i;
  }

  const _cell = (row, idx) => (idx != null && row && row[idx] != null) ? String(row[idx]).trim() : '';

  for (const row of rows.slice(1)) {
    if (!row || !row.some(c => c != null && c !== '')) continue;
    const col0 = _cell(row, 0);
    const col1 = _cell(row, 1);
    const col2 = _cell(row, 2);
    const moduleRaw = _cell(row, bmCol);
    const layerVal = _cell(row, layerCol);

    // Col 0 carry-forward — used for matching (byName, byCode)
    if (col0 && !SKIP_VALS.has(col0.toLowerCase())) currentDeck = col0;
    if (!currentDeck) continue;

    // Deck name = col 0 carry-forward value — this is the name used in the customer deck
    // e.g. "Going live support", "Integration validation", "Technical platform definition"
    // Col H (layerVal) = "Foundational"/"Advanced"/"Max" — this is the engagement type label,
    // NOT the deck name. We store col H separately for reference but NEVER as the deck name.
    const storeDeck = currentDeck;

    // CRM ID mapping — may contain multiple IDs per cell
    const crmIds = [];
    if (col1 && !SKIP_VALS.has(col1.toLowerCase())) {
      col1.split(/[,/;\s]+/).forEach(id => {
        id = id.trim();
        if (id && /\d{6,}/.test(id)) {
          byCode[id] = storeDeck;
          const padded = id.padStart(18, '0');
          if (padded !== id) byCode[padded] = storeDeck;
          crmIds.push(id);
        }
      });
    }

    // Catalog name mapping
    const catName = col2 && !SKIP_VALS.has(col2.toLowerCase()) ? col2 : '';
    if (catName) byName[_clean(catName)] = storeDeck;

    // Deck name self-mapping
    byName[_clean(currentDeck)] = storeDeck;

    // Module assignment record (when business module column exists)
    if (moduleRaw && !SKIP_VALS.has(moduleRaw.toLowerCase())) {
      moduleAssignments.push({
        crmIds,
        catalogName: catName,
        deckName: storeDeck,
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
  if (!moduleRaw || !moduleRaw.trim()) return [null, 'empty', []];
  const cleaned = _clean(moduleRaw);
  const normed  = _norm(moduleRaw);
  const steps   = [];

  // 1. Direct code match
  if (MODULE_CODE_RE.test(moduleRaw.trim())) {
    const candidate = moduleRaw.trim().toUpperCase();
    if (flatIndex[candidate] && candidate.startsWith(bsCode)) {
      steps.push({ type: 'module', excel_value: moduleRaw, db_value: candidate, method: 'direct code', threshold: null, result: 'match' });
      return [candidate, 'exact code', steps];
    }
    steps.push({ type: 'module', excel_value: moduleRaw, db_value: candidate, method: 'direct code', threshold: null, result: 'no_match' });
  }

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
    if (cleaned === full || cleaned === label) {
      steps.push({ type: 'module', excel_value: moduleRaw, db_value: label, method: 'exact name', threshold: null, result: 'match' });
      return [code, 'exact name', steps];
    }
  }
  steps.push({ type: 'module', excel_value: moduleRaw, db_value: null, method: 'exact name', threshold: null, result: 'no_match' });

  // 3. Substring containment
  for (const [code, { full, label }] of Object.entries(candidates)) {
    if (cleaned.includes(full) || cleaned.includes(label) || label.includes(cleaned)) {
      steps.push({ type: 'module', excel_value: moduleRaw, db_value: label, method: 'substring', threshold: null, result: 'match' });
      return [code, 'substring', steps];
    }
  }
  steps.push({ type: 'module', excel_value: moduleRaw, db_value: null, method: 'substring', threshold: null, result: 'no_match' });

  // 4. Punctuation-stripped
  for (const [code, { full, label, normLabel }] of Object.entries(candidates)) {
    const nFull = _norm(full);
    if (normed === nFull || normed === normLabel) {
      steps.push({ type: 'module', excel_value: moduleRaw, db_value: label, method: 'norm exact', threshold: null, result: 'match' });
      return [code, 'norm exact', steps];
    }
    if (normed.includes(normLabel) || normLabel.includes(normed)) {
      steps.push({ type: 'module', excel_value: moduleRaw, db_value: label, method: 'norm substring', threshold: null, result: 'match' });
      return [code, 'norm substring', steps];
    }
  }
  steps.push({ type: 'module', excel_value: moduleRaw, db_value: null, method: 'norm exact/substring', threshold: null, result: 'no_match' });

  // 5. Fuzzy (threshold 0.60)
  let bestCode = null, bestRatio = 0, bestLabel = '';
  for (const [code, { label, normLabel }] of Object.entries(candidates)) {
    const ratio = _similarity(normed, normLabel);
    if (ratio > bestRatio) { bestRatio = ratio; bestCode = code; bestLabel = label; }
  }
  if (bestCode && bestRatio >= 0.60) {
    steps.push({ type: 'module', excel_value: moduleRaw, db_value: bestLabel, method: 'fuzzy', threshold: '0.60', result: 'match' });
    return [bestCode, `fuzzy ${Math.round(bestRatio*100)}% → "${bestLabel}"`, steps];
  }
  steps.push({ type: 'module', excel_value: moduleRaw, db_value: bestLabel || null, method: 'fuzzy', threshold: '0.60', result: 'no_match' });
  return [null, 'no match', steps];
}

// ── Service code resolution ───────────────────────────────────────────────────

function _resolveServiceCode(assignment, flatIndex) {
  const { crmIds = [], catalogName = '', deckName = '' } = assignment;
  const steps = [];

  // 1. Exact flat_index key
  for (const cid of crmIds) {
    if (flatIndex[cid]) {
      steps.push({ type: 'service', excel_value: cid, db_value: cid, method: 'CRM exact key', threshold: null, result: 'match' });
      return [cid, `CRM exact key (${cid})`, steps];
    }
  }
  if (crmIds.length) steps.push({ type: 'service', excel_value: crmIds.join('/'), db_value: null, method: 'CRM exact key', threshold: null, result: 'no_match' });

  // 2. serviceNumber field scan
  if (crmIds.length) {
    const cidSet = new Set(crmIds);
    for (const [code, svc] of Object.entries(flatIndex)) {
      const svcNum = String(svc.serviceNumber || '').trim();
      if (svcNum && cidSet.has(svcNum)) {
        steps.push({ type: 'service', excel_value: crmIds.join('/'), db_value: svcNum, method: 'serviceNumber match', threshold: null, result: 'match' });
        return [code, `serviceNumber match (${svcNum})`, steps];
      }
    }
    steps.push({ type: 'service', excel_value: crmIds.join('/'), db_value: null, method: 'serviceNumber match', threshold: null, result: 'no_match' });
  }

  // 3. Zero-padded 18-digit key
  for (const cid of crmIds) {
    try {
      const padded = String(parseInt(cid)).padStart(18, '0');
      if (padded !== cid && flatIndex[padded]) {
        steps.push({ type: 'service', excel_value: cid, db_value: padded, method: 'zero-padded key', threshold: null, result: 'match' });
        return [padded, `zero-padded (${cid}→${padded})`, steps];
      }
    } catch(e) {}
  }
  if (crmIds.length) steps.push({ type: 'service', excel_value: crmIds.join('/'), db_value: null, method: 'zero-padded key', threshold: null, result: 'no_match' });

  // 4. Catalog name exact clean match
  const cat = _clean(catalogName);
  if (cat) {
    for (const [code, svc] of Object.entries(flatIndex)) {
      if (_clean(svc.name || '') === cat) {
        steps.push({ type: 'service', excel_value: catalogName, db_value: svc.name, method: 'catalog name exact', threshold: null, result: 'match' });
        return [code, 'catalog name exact', steps];
      }
    }
    steps.push({ type: 'service', excel_value: catalogName, db_value: null, method: 'catalog name exact', threshold: null, result: 'no_match' });
  }

  // 5. Deck name exact clean match
  const deck = _clean(deckName);
  if (deck) {
    for (const [code, svc] of Object.entries(flatIndex)) {
      if (_clean(svc.name || '') === deck) {
        steps.push({ type: 'service', excel_value: deckName, db_value: svc.name, method: 'deck name exact', threshold: null, result: 'match' });
        return [code, 'deck name exact', steps];
      }
    }
    steps.push({ type: 'service', excel_value: deckName, db_value: null, method: 'deck name exact', threshold: null, result: 'no_match' });
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
    const normedMap = {};
    for (const [code, svc] of Object.entries(flatIndex)) {
      if (svc.name && svc.serviceObject !== 'Business Scenario' && !MODULE_CODE_RE.test(code)) {
        normedMap[code] = _norm(svc.name);
      }
    }

    // 6a. norm exact
    for (const [term, field] of searchTerms) {
      for (const [code, normedName] of Object.entries(normedMap)) {
        if (term === normedName && !_isBlockedMatch(term, normedName)) {
          steps.push({ type: 'service', excel_value: term, db_value: flatIndex[code]?.name, method: `${field} norm exact`, threshold: null, result: 'match' });
          return [code, `${field} norm exact`, steps];
        }
      }
    }
    steps.push({ type: 'service', excel_value: searchTerms.map(t=>t[0]).join('/'), db_value: null, method: 'norm exact', threshold: null, result: 'no_match' });

    // 6b. Fuzzy (threshold 0.77) — process in batches to avoid blocking event loop
    const normedEntries = Object.entries(normedMap);
    let bestCode = null, bestRatio = 0, bestField = '', bestName = '';
    const BATCH = 100;
    for (let i = 0; i < normedEntries.length; i += BATCH) {
      const batch = normedEntries.slice(i, i + BATCH);
      for (const [term, field] of searchTerms) {
        for (const [code, normedName] of batch) {
          if (!normedName || _isBlockedMatch(term, normedName)) continue;
          const ratio = _similarity(term, normedName);
          if (ratio > bestRatio) { bestRatio = ratio; bestCode = code; bestField = field; bestName = flatIndex[code]?.name || ''; }
        }
      }
    }
    if (bestCode && bestRatio >= 0.77) {
      steps.push({ type: 'service', excel_value: searchTerms.map(t=>t[0]).join('/'), db_value: bestName, method: `${bestField} fuzzy`, threshold: '0.77', result: 'match' });
      return [bestCode, `${bestField} fuzzy ${Math.round(bestRatio*100)}%`, steps];
    }
    steps.push({ type: 'service', excel_value: searchTerms.map(t=>t[0]).join('/'), db_value: bestName || null, method: 'fuzzy', threshold: '0.77', result: 'no_match' });
  }

  return [null, '', steps];
}

// ── Main enrichment ───────────────────────────────────────────────────────────

async function applyExcelEnrichment(flatIndex, bsCode, excelBuffer, injectionLog) {
  try {
    const { byCode, byName, moduleAssignments } = parseBsNameMapping(excelBuffer, bsCode);

    const totalMappings = Object.keys(byCode).length + Object.keys(byName).length + moduleAssignments.length;
    if (totalMappings === 0) {
      console.log(`    ⚠️  ${bsCode}: no mappings extracted — skipping`);
      return 0;
    }

    const bsSvc = flatIndex[bsCode];
    if (!bsSvc) { console.log(`    ⚠️  ${bsCode}: not found in flat_index`); return 0; }

    let matched = 0, unmatched = 0, injected = 0, alreadyLinked = 0, unresolvedMod = 0, unresolvedSvc = 0;
    const logRows = [];

    // Snapshot original API hierarchy children before enrichment modifies childServices
    const originalModChildren = {};
    for (const modCode of bsSvc.childServices || []) {
      const mod = flatIndex[modCode];
      if (mod) originalModChildren[modCode] = new Set(mod.childServices || []);
    }

    // ── Module membership injection + deck name assignment ────────────────────
    let asgnCount = 0;
    for (const asgn of moduleAssignments) {
      if (++asgnCount % 10 === 0) await new Promise(r => setTimeout(r, 0));

      const [modCode, modNote, modSteps] = _resolveModuleCode(asgn.moduleRaw, flatIndex, bsCode);
      if (!modCode) {
        unresolvedMod++;
        logRows.push({ type: 'module_injection', status: 'No Module Match', deck_name: asgn.deckName, crm_ids: asgn.crmIds.join('/'), service_name: asgn.catalogName, module_name: asgn.moduleRaw, module_code: null, service_code: null, detail: modNote, steps: modSteps });
        continue;
      }

      const [svcCode, svcNote, svcSteps] = _resolveServiceCode(asgn, flatIndex);
      const allSteps = [...modSteps, ...svcSteps];

      if (!svcCode) {
        unresolvedSvc++;
        logRows.push({ type: 'module_injection', status: 'No Service Match', deck_name: asgn.deckName, crm_ids: asgn.crmIds.join('/'), service_name: asgn.catalogName, module_name: asgn.moduleRaw, module_code: modCode, service_code: null, detail: `module:${modNote}`, steps: allSteps });
        continue;
      }

      const modNode = flatIndex[modCode];
      if (!modNode) {
        logRows.push({ type: 'module_injection', status: 'Module Not In Flat Index', deck_name: asgn.deckName, crm_ids: asgn.crmIds.join('/'), service_name: asgn.catalogName, module_name: asgn.moduleRaw, module_code: modCode, service_code: svcCode, detail: `module:${modNote}|svc:${svcNote}`, steps: allSteps });
        continue;
      }

      // Assign deck name — Step 2 owns this now
      const child = flatIndex[svcCode];
      if (child) {
        if (!child.business_scenario_naming) child.business_scenario_naming = {};
        child.business_scenario_naming[bsCode] = asgn.deckName;
        matched++;
      }

      const children = modNode.childServices || (modNode.childServices = []);
      if (children.includes(svcCode)) {
        alreadyLinked++;
        logRows.push({ type: 'module_injection', status: 'Already Linked', deck_name: asgn.deckName, crm_ids: asgn.crmIds.join('/'), service_name: (child||{}).name || asgn.catalogName, module_name: asgn.moduleRaw, module_code: modCode, service_code: svcCode, detail: `module:${modNote}|svc:${svcNote}`, steps: allSteps });
      } else {
        children.push(svcCode);
        injected++;
        logRows.push({ type: 'module_injection', status: 'Added', deck_name: asgn.deckName, crm_ids: asgn.crmIds.join('/'), service_name: (child||{}).name || asgn.catalogName, module_name: asgn.moduleRaw, module_code: modCode, service_code: svcCode, detail: `module:${modNote}|svc:${svcNote}`, steps: allSteps });
      }
    }

    // Services in API hierarchy (original, before enrichment) with no deck name assigned — log as unmatched
    // Build serviceNumber → deck name map to detect catalog duplicates (same serviceNumber, different code)
    const svcNumToDeckName = {};
    for (const [, svc] of Object.entries(flatIndex)) {
      const sn = svc.serviceNumber;
      const dn = svc.business_scenario_naming && svc.business_scenario_naming[bsCode];
      if (sn && dn) svcNumToDeckName[String(sn).trim()] = dn;
    }

    for (const modCode of bsSvc.childServices || []) {
      const origChildren = originalModChildren[modCode] || new Set();
      for (const childCode of origChildren) {
        const child = flatIndex[childCode];
        if (!child) continue;
        const hasDeckName = child.business_scenario_naming && child.business_scenario_naming[bsCode];
        if (hasDeckName) continue;
        // Skip if another service with the same serviceNumber was already matched (catalog duplicate)
        const sn = child.serviceNumber ? String(child.serviceNumber).trim() : null;
        if (sn && svcNumToDeckName[sn]) continue;
        unmatched++;
        logRows.push({ type: 'module_injection', status: 'No Match', deck_name: null, crm_ids: null, service_name: child.name, module_name: null, module_code: modCode, service_code: child.code, detail: 'not in excel module assignments', steps: [] });
      }
    }

    console.log(`    ✅ ${bsCode}: ${matched} deck-name assigned, ${unmatched} unmatched, ${injected} injected, ${alreadyLinked} already linked`);

    if (injectionLog) {
      injectionLog[bsCode] = { matched, unmatched, injected, alreadyLinked, unresolvedMod, unresolvedSvc, rows: logRows };
    }

    // Write to DB tables
    try {
      const db = require('../store/db');
      db.getPool();

      await db.query(
        `INSERT INTO catalog_injection_log (bs_code, generated_at, matched, unmatched, injected, already_linked, unresolved_mod, unresolved_svc)
         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)
         ON CONFLICT (bs_code) DO UPDATE SET
           generated_at=NOW(), matched=EXCLUDED.matched, unmatched=EXCLUDED.unmatched,
           injected=EXCLUDED.injected, already_linked=EXCLUDED.already_linked,
           unresolved_mod=EXCLUDED.unresolved_mod, unresolved_svc=EXCLUDED.unresolved_svc`,
        [bsCode, matched, unmatched, injected, alreadyLinked, unresolvedMod, unresolvedSvc]
      );

      await db.query(`DELETE FROM catalog_matching_log_rows WHERE bs_code = $1`, [bsCode]);

      for (const lr of logRows) {
        const res = await db.query(
          `INSERT INTO catalog_matching_log_rows (bs_code, type, status, service_code, service_name, module_code, module_name, deck_name, crm_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [bsCode, lr.type, lr.status, lr.service_code||null, lr.service_name||null, lr.module_code||null, lr.module_name||null, lr.deck_name||null, lr.crm_ids||null]
        );
        const logRowId = res.rows[0].id;
        for (const step of (lr.steps || [])) {
          await db.query(
            `INSERT INTO catalog_matching_steps (log_row_id, type, excel_value, db_value, method, threshold, result)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [logRowId, step.type, step.excel_value||null, step.db_value||null, step.method||null, step.threshold||null, step.result]
          );
        }
      }
    } catch(e) {
      console.warn(`[enrich] DB log write failed for ${bsCode}:`, e.message);
    }

    return matched + injected;
  } catch(e) {
    console.error(`[enrich] applyExcelEnrichment failed for ${bsCode}:`, e.message);
    return 0;
  }
}

// ── Teaser filename extraction ─────────────────────────────────────────────────

function parseTeaserFileName(serviceTeaserText) {
  if (!serviceTeaserText) return null;
  const idx = serviceTeaserText.toLowerCase().indexOf('entitlements service list');
  if (idx === -1) return null;
  const section = serviceTeaserText.substring(idx, idx + 800);
  const match = section.match(/href="([^"]+\.xlsx[^"]*)"/i);
  if (!match) return null;
  const excelUrl = match[1].replace(/&amp;/g, '&');
  const segment = excelUrl.split('/').find(p => p.toLowerCase().includes('.xlsx')) || '';
  return decodeURIComponent(segment).split('?')[0] || null;
}

async function upsertExcelFileName(db, bsCode, fileName) {
  if (!fileName) return;
  await db.query(
    `INSERT INTO catalog_excel_files (bs_code, file_name, file_data, file_size)
     VALUES ($1, $2, ''::bytea, 0)
     ON CONFLICT (bs_code) DO UPDATE SET file_name = EXCLUDED.file_name`,
    [bsCode, fileName]
  );
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

// ── Write a single service to PostgreSQL ─────────────────────────────────────
async function _writeServiceToDb(db, svc) {
  const code = svc.code;
  const et = Array.isArray(svc.engagementType)
    ? svc.engagementType[0]
    : (svc.engagementType || null);

  await db.query(`
    INSERT INTO catalog_services
      (code, service_number, name, service_object, short_description, summary,
       description, service_teaser_text, business_needs, key_benefits,
       delivery_approach, engagement_type, parent_code, modified_time,
       approval_status, booking_method, contacts, sc_keywords, raw_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (code) DO UPDATE SET
      name=EXCLUDED.name, service_object=EXCLUDED.service_object,
      short_description=EXCLUDED.short_description, summary=EXCLUDED.summary,
      description=EXCLUDED.description, service_teaser_text=EXCLUDED.service_teaser_text,
      business_needs=EXCLUDED.business_needs, key_benefits=EXCLUDED.key_benefits,
      delivery_approach=EXCLUDED.delivery_approach, engagement_type=EXCLUDED.engagement_type,
      parent_code=EXCLUDED.parent_code, modified_time=EXCLUDED.modified_time,
      raw_data=EXCLUDED.raw_data
  `, [
    code,
    svc.serviceNumber || svc.number || null,
    svc.name || '',
    svc.serviceObject || 'Service',
    svc.shortDescription || null,
    svc.summary || null,
    svc.description || null,
    svc.serviceTeaserText || svc.teaserText || null,
    svc.businessNeeds || null,
    svc.keyBenefits || null,
    svc.deliveryApproach || null,
    et,
    svc.parentCode || null,
    svc.modifiedTime || null,
    svc.approvalStatus || null,
    svc.bookingMethod ? JSON.stringify(svc.bookingMethod) : null,
    svc.contacts ? JSON.stringify(svc.contacts) : null,
    svc.scKeywords ? JSON.stringify(svc.scKeywords) : null,
    JSON.stringify(svc)
  ]);

  // Hierarchy
  let pos = 0;
  for (const childCode of svc.childServices || []) {
    await db.query(`
      INSERT INTO catalog_hierarchy (parent_code, child_code, position, source)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (parent_code, child_code) DO NOTHING
    `, [code, childCode, pos++, 'api']);
  }

  // classificationFeatures
  const cf = svc.classificationFeatures;
  if (Array.isArray(cf)) {
    for (const item of cf) {
      if (!item || !item.key) continue;
      const vals = Array.isArray(item.value) ? item.value : [item.value];
      for (const val of vals) {
        if (!val) continue;
        await db.query(`
          INSERT INTO catalog_classification (service_code, feature_key, feature_value)
          VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
        `, [code, item.key, String(val)]);
      }
    }
  }

  // supercategories
  const cats = svc.supercategories;
  if (Array.isArray(cats)) {
    for (const cat of cats) {
      if (!cat || !cat.code) continue;
      await db.query(`
        INSERT INTO catalog_supercategories (service_code, category_code, category_name, parent_category_name)
        VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
      `, [code, cat.code, cat.name || '', cat.parentCategoryName || null]);
    }
  }

  // bs_naming
  const bsNaming = svc.business_scenario_naming || {};
  for (const [bsCode, deckName] of Object.entries(bsNaming)) {
    if (!deckName) continue;
    await db.query(`
      INSERT INTO catalog_bs_naming (service_code, bs_code, deck_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (service_code, bs_code) DO UPDATE SET deck_name=EXCLUDED.deck_name
    `, [code, bsCode, deckName]);
  }
}

async function publishSnapshot(flatIndex, lastFullBuild) {
  const serviceCount = Object.keys(flatIndex).length;
  if (serviceCount < 100) {
    console.error(`[publishSnapshot] Refusing to save corrupt snapshot — only ${serviceCount} services. Aborting.`);
    return { serviceCount: 0, businessScenarioCount: 0 };
  }
  const now = new Date().toISOString();

  // Write to PostgreSQL if available — in batches, no giant transaction
  try {
    const db = require('../store/db');
    db.getPool();
    await db.initSchema();

    // Clear old data
    await db.query('DELETE FROM catalog_bs_naming');
    await db.query('DELETE FROM catalog_supercategories');
    await db.query('DELETE FROM catalog_classification');
    await db.query('DELETE FROM catalog_hierarchy');
    await db.query('DELETE FROM catalog_services');
    await db.query('DELETE FROM catalog_sync');

    // Write in batches of 50 to avoid OOM
    const entries = Object.entries(flatIndex);
    const BATCH = 50;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      for (const [, svc] of batch) {
        await _writeServiceToDb(db, svc);
      }
      if (i % 200 === 0) console.log(`[db] Written ${Math.min(i + BATCH, entries.length)}/${entries.length} services`);
    }

    await db.query(`
      INSERT INTO catalog_sync (last_full_build, last_updated, service_count, status)
      VALUES ($1, NOW(), $2, 'completed')
    `, [lastFullBuild || now, serviceCount]);

    // Upsert Excel filenames parsed from BS teaserText
    let fileNameCount = 0;
    for (const [, svc] of Object.entries(flatIndex)) {
      if (svc.serviceObject !== 'Business Scenario') continue;
      const fileName = parseTeaserFileName(svc.serviceTeaserText);
      if (fileName) {
        await upsertExcelFileName(db, svc.code, fileName);
        fileNameCount++;
      }
    }
    if (fileNameCount > 0) console.log(`[db] Upserted ${fileNameCount} Excel filenames from BS teasers`);

    console.log(`[db] ✅ Written ${serviceCount} services to PostgreSQL`);
  } catch(e) {
    if (e.message.includes('No PostgreSQL credentials')) {
      console.log('[db] No PostgreSQL configured — using file storage only');
    } else {
      console.error('[db] PostgreSQL write failed (non-fatal):', e.message);
    }
  }

  // Write file snapshot (fallback)
  const businessScenarios = buildHierarchy(flatIndex);
  const data = {
    lastFullBuild: lastFullBuild || now,
    lastUpdated: now,
    serviceCount,
    payload: JSON.stringify({ last_full_build: lastFullBuild, last_updated: now, flat_index: flatIndex, business_scenarios: businessScenarios })
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

    // Enrich leaf services with fields=FULL in batches — merge back without holding all in memory
    const leafCodes = Object.keys(flatIndex).filter(c => {
      const so = flatIndex[c].serviceObject;
      return so !== 'Business Scenario' && so !== 'Business Scenario module';
    });
    const bsNodeCodes = Object.keys(flatIndex).filter(c => flatIndex[c].serviceObject === 'Business Scenario');

    // Fetch fields=FULL for BS nodes to get serviceTeaserText (used for Excel filename parsing)
    console.log(`Fetching fields=FULL for ${bsNodeCodes.length} Business Scenario nodes...`);
    for (const code of bsNodeCodes) {
      try {
        const full = await fetchFullService(code, token);
        if (full) flatIndex[code] = { ...flatIndex[code], ...full };
      } catch(e) { console.warn(`  fields=FULL failed for BS ${code}: ${e.message}`); }
      await new Promise(r => setTimeout(r, 100));
    }
    console.log(`Fetching fields=FULL for ${leafCodes.length} leaf services...`);
    const BATCH = 10;
    for (let i = 0; i < leafCodes.length; i += BATCH) {
      const batch = leafCodes.slice(i, i + BATCH);
      const fetched = await Promise.all(batch.map(async code => {
        try { return await fetchFullService(code, token); }
        catch(e) { console.warn(`  fields=FULL failed for ${code}: ${e.message}`); return null; }
      }));
      for (const full of fetched) {
        if (full && full.code && flatIndex[full.code]) {
          const existing = flatIndex[full.code];
          // Merge only missing fields — do NOT replace the full object to save memory
          existing.classificationFeatures = full.classificationFeatures || existing.classificationFeatures || null;
          existing.supercategories        = full.supercategories        || existing.supercategories        || null;
          existing.summary                = full.summary                || existing.summary                || null;
          existing.businessNeeds          = full.businessNeeds          || existing.businessNeeds          || null;
          existing.keyBenefits            = full.keyBenefits            || existing.keyBenefits            || null;
          existing.deliveryApproach       = full.deliveryApproach       || existing.deliveryApproach       || null;
          existing.description            = full.description            || existing.description            || null;
          existing.serviceTeaserText      = full.serviceTeaserText      || existing.serviceTeaserText      || null;
        }
      }
      if (i % 100 === 0) console.log(`  fields=FULL progress: ${Math.min(i + BATCH, leafCodes.length)}/${leafCodes.length}`);
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`fields=FULL enrichment complete.`);

    // Restore Excel files from PostgreSQL before enrichment
    try {
      const db = require('../store/db');
      db.getPool();
      const excelRes = await db.query(`SELECT bs_code, file_data FROM catalog_excel_files`);
      if (excelRes.rows.length) {
        fs.mkdirSync(EXCEL_DIR, { recursive: true });
        for (const row of excelRes.rows) {
          fs.writeFileSync(path.join(EXCEL_DIR, `${row.bs_code}.xlsx`), row.file_data);
        }
        console.log(`[sync] Restored ${excelRes.rows.length} Excel files from PostgreSQL for enrichment.`);
      }
    } catch(e) {
      if (!e.message.includes('No PostgreSQL')) console.warn('[sync] Excel restore failed:', e.message);
    }

    // Enrich from staged Excels
    const bsCodes = Object.keys(flatIndex).filter(c => flatIndex[c].serviceObject === 'Business Scenario');
    let totalEnriched = 0;
    for (const bsCode of bsCodes) {
      const excelPath = path.join(EXCEL_DIR, `${bsCode}.xlsx`);
      if (fs.existsSync(excelPath)) {
        const buf = fs.readFileSync(excelPath);
        totalEnriched += await applyExcelEnrichment(flatIndex, bsCode, buf);
      }
    }
    console.log(`Excel enrichment: ${totalEnriched} services enriched across ${bsCodes.length} BS`);

    const result = await publishSnapshot(flatIndex, new Date().toISOString());
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

    // Lightweight fetch — include serviceTeaserText so we can detect BS changes
    const lightServices = [];
    let page = 0, totalPages = 1;
    do {
      const data = await sscGet(`/${siteId}/services?facets=${encodeURIComponent(facets)}&pageSize=100&currentPage=${page}&fields=services(code,name,serviceObject,serviceTeaserText),pagination`, token);
      lightServices.push(...(data.services || []));
      totalPages = (data.pagination || {}).totalPages || 1;
      page++;
    } while (page < totalPages);

    // Load stored teasers from DB for comparison
    let storedTeasers = {};
    try {
      const db = require('../store/db');
      db.getPool();
      const r = await db.query(`SELECT code, service_teaser_text FROM catalog_services WHERE service_object = 'Business Scenario'`);
      for (const row of r.rows) storedTeasers[row.code] = row.service_teaser_text || '';
    } catch(e) {
      // Fall back to snapshot
      const cachedFI = cached.payload ? JSON.parse(cached.payload).flat_index || {} : {};
      for (const [code, svc] of Object.entries(cachedFI)) {
        if (svc.serviceObject === 'Business Scenario') storedTeasers[code] = svc.serviceTeaserText || '';
      }
    }

    const cachedFlatIndex = cached.payload ? JSON.parse(cached.payload).flat_index || {} : {};
    const changedBsCodes = [];
    const newBsCodes = [];

    for (const svc of lightServices) {
      if (svc.serviceObject !== 'Business Scenario') continue;
      const freshTeaser = svc.serviceTeaserText || '';
      const storedTeaser = storedTeasers[svc.code];
      if (storedTeaser === undefined) {
        console.log(`  New BS: ${svc.code} (${svc.name})`);
        newBsCodes.push(svc.code);
        changedBsCodes.push(svc.code);
      } else if (freshTeaser !== storedTeaser) {
        console.log(`  Changed BS (teaser): ${svc.code} (${svc.name})`);
        changedBsCodes.push(svc.code);
      }
    }

    if (changedBsCodes.length === 0) {
      console.log('No changes detected.');
      return res.json({ status: 'up-to-date', changedBsCount: 0 });
    }

    console.log(`Refreshing ${changedBsCodes.length} changed BS...`);

    let db = null;
    try { const d = require('../store/db'); d.getPool(); db = d; } catch(e) { /* no DB */ }

    for (const bsCode of changedBsCodes) {
      const bsFull = await fetchFullService(bsCode, token);

      // ── Stale hierarchy cleanup ──────────────────────────────────────────────
      // Remove old module rows so orphaned modules don't linger after a BS restructure
      if (db) {
        try {
          // Get old module codes before overwriting
          const oldMods = (cachedFlatIndex[bsCode] || {}).childServices || [];
          if (oldMods.length > 0) {
            await db.query(`DELETE FROM catalog_hierarchy WHERE parent_code = $1`, [bsCode]);
            console.log(`  Cleaned ${oldMods.length} old hierarchy rows for ${bsCode}`);
          }
        } catch(e) { console.warn(`  Hierarchy cleanup failed for ${bsCode}:`, e.message); }
      }

      cachedFlatIndex[bsCode] = bsFull;

      for (const modCode of bsFull.childServices || []) {
        const mod = await fetchFullService(modCode, token);
        cachedFlatIndex[modCode] = mod;
        for (const childCode of mod.childServices || []) {
          cachedFlatIndex[childCode] = await fetchFullService(childCode, token);
          await new Promise(r => setTimeout(r, 100));
        }
      }

      // ── Extract filename from new teaser and upsert into catalog_excel_files ─
      if (db) {
        const fileName = parseTeaserFileName(bsFull.serviceTeaserText);
        if (fileName) {
          try {
            await upsertExcelFileName(db, bsCode, fileName);
            console.log(`  Updated Excel filename for ${bsCode}: ${fileName}`);
          } catch(e) { console.warn(`  Filename upsert failed for ${bsCode}:`, e.message); }
        }
      }

      // Re-enrich from staged Excel
      const excelPath = path.join(EXCEL_DIR, `${bsCode}.xlsx`);
      if (fs.existsSync(excelPath)) {
        await applyExcelEnrichment(cachedFlatIndex, bsCode, fs.readFileSync(excelPath));
      }
    }

    const result = await publishSnapshot(cachedFlatIndex, cached.lastFullBuild);
    res.json({ status: 'completed', mode: 'incremental', changedBsCount: changedBsCodes.length, newBsCount: newBsCodes.length, changedBsCodes, ...result });
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
        totalEnriched += await applyExcelEnrichment(flatIndex, code, buf, injectionLog);
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

// ── Fetch all services with fields=FULL (for Excel export) ───────────────────
async function fetchAllServicesFull() {
  const token = await fetchOAuthToken();
  const siteId = process.env.SSC_SITE_ID || 'servicescatalog';
  const ENGAGEMENT_TYPES = [
    'Max Success Plan', 'Advanced Success Plan', 'Enterprise Support',
    'Embedded Launch Activities', 'Cloud Prepackaged Services'
  ];
  const facets = ENGAGEMENT_TYPES.map(et => `engagementType:${et}`).join(',');

  // Step 1: get all service codes from paginated endpoint
  const codes = [];
  let page = 0, totalPages = 1;
  do {
    const data = await sscGet(`/${siteId}/services?facets=${encodeURIComponent(facets)}&pageSize=100&currentPage=${page}&fields=services(code,serviceObject),pagination`, token);
    for (const svc of data.services || []) {
      // Only leaf services (not BS or modules)
      if (svc.serviceObject !== 'Business Scenario' && svc.serviceObject !== 'Business Scenario module') {
        codes.push(svc.code);
      }
    }
    totalPages = (data.pagination || {}).totalPages || 1;
    console.log(`[export-full] Page ${page + 1}/${totalPages} — ${codes.length} service codes collected`);
    page++;
    await new Promise(r => setTimeout(r, 100));
  } while (page < totalPages);

  console.log(`[export-full] Fetching ${codes.length} services individually with fields=FULL...`);

  // Step 2: fetch each service individually in batches of 10
  const results = [];
  const BATCH = 10;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const fetched = await Promise.all(batch.map(async code => {
      try { return await sscGet(`/${siteId}/scservices/${code}?fields=FULL`, token); }
      catch(e) { console.warn(`[export-full] Failed to fetch ${code}: ${e.message}`); return null; }
    }));
    results.push(...fetched.filter(Boolean));
    if (i % 100 === 0) console.log(`[export-full] Progress: ${results.length}/${codes.length}`);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[export-full] Done — ${results.length} services with full fields`);
  return results;
}

module.exports = router;
module.exports.applyExcelEnrichment = applyExcelEnrichment;
module.exports.buildHierarchy = buildHierarchy;
module.exports.fetchAllServicesFull = fetchAllServicesFull;
module.exports.parseTeaserFileName = parseTeaserFileName;
