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

function _clean(val) {
  return val ? String(val).trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function _parseStandardSheet(rows) {
  // Column layout (consistent across most files):
  //   Col 0 = Deck name (CARRY-FORWARD — only filled on first row of each group)
  //   Col 1 = CRM ID (may contain multiple IDs separated by , / ;)
  //   Col 2 = Name as per service catalog
  const byCode = {};
  const byName = {};
  let currentDeck = '';
  const skipVals = new Set(['none', 'n/a', '', 'service name as per', 'crm id']);

  for (const row of rows.slice(1)) { // skip header row
    if (!row || !row.some(c => c != null && c !== '')) continue;

    const col0 = row[0] != null ? String(row[0]).trim() : '';
    const col1 = row[1] != null ? String(row[1]).trim() : '';
    const col2 = row[2] != null ? String(row[2]).trim() : '';

    // Carry-forward: update current deck only when col0 has a real value
    if (col0 && !skipVals.has(col0.toLowerCase())) {
      currentDeck = col0;
    }
    if (!currentDeck) continue;

    // CRM ID mapping — may have multiple IDs per cell
    if (col1 && !skipVals.has(col1.toLowerCase())) {
      col1.split(/[,/;\s]+/).forEach(id => {
        id = id.trim();
        if (id && /[0-9]{6,}/.test(id)) {
          byCode[id] = currentDeck;
          // Also store zero-padded 18-digit version
          const padded = id.padStart(18, '0');
          if (padded !== id) byCode[padded] = currentDeck;
        }
      });
    }

    // Catalog name mapping
    if (col2 && !skipVals.has(col2.toLowerCase())) {
      byName[_clean(col2)] = currentDeck;
    }

    // Deck name self-mapping (fallback for name-based lookup)
    byName[_clean(currentDeck)] = currentDeck;
  }

  return { byCode, byName };
}

function _detectSheetLayout(rows) {
  // Auto-detect column layout by scanning the first 10 rows for header signals.
  // Returns: 'standard' | 'skip'
  //
  // Standard layout signals (must find at least 2 of these):
  //   - A column header containing 'crm' or 'id'
  //   - A column header containing 'service' or 'catalog' or 'name'
  //   - A column header containing 'deck' or 'scenario' or 'success pack' or 'module'
  //   - OR: col0 has non-numeric, non-header text values that carry forward (deck names)
  //     AND col1 has 6+ digit numeric values (CRM IDs)
  //
  // Skip if: no recognisable structure found

  const headerKeywords = [
    [/crm|id/i, 'id'],
    [/service|catalog|name/i, 'name'],
    [/deck|scenario|success.?pack|module/i, 'deck'],
  ];

  // Check header row signals (first 5 rows)
  let headerSignals = new Set();
  for (const row of rows.slice(0, 5)) {
    if (!row) continue;
    for (const cell of row) {
      if (!cell) continue;
      const s = String(cell).toLowerCase().trim();
      for (const [re, label] of headerKeywords) {
        if (re.test(s)) headerSignals.add(label);
      }
    }
  }
  if (headerSignals.size >= 2) return 'standard';

  // Check data rows: col0 = text deck names, col1 = numeric CRM IDs
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

function parseBsNameMapping(excelBuffer, bsCode) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(excelBuffer, { type: 'buffer' });
  const combined = { byCode: {}, byName: {} };

  for (const sheetName of wb.SheetNames) {
    // Skip reference/example/info sheets
    if (/reference|example|readme|info/i.test(sheetName)) continue;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    if (!rows.length) continue;

    // Auto-detect layout — skip sheets with unrecognised structure
    const layout = _detectSheetLayout(rows);
    if (layout === 'skip') {
      console.log(`    Skipping sheet "${sheetName}" in ${bsCode} — unrecognised column structure`);
      continue;
    }

    const { byCode, byName } = _parseStandardSheet(rows);
    Object.assign(combined.byCode, byCode);
    Object.assign(combined.byName, byName);
  }

  console.log(`    Parsed Excel for ${bsCode}: ${Object.keys(combined.byCode).length} code mappings, ${Object.keys(combined.byName).length} name mappings`);
  return combined;
}

function applyExcelEnrichment(flatIndex, bsCode, excelBuffer, injectionLog) {
  try {
    const { byCode, byName } = parseBsNameMapping(excelBuffer, bsCode);

    const totalMappings = Object.keys(byCode).length + Object.keys(byName).length;
    if (totalMappings === 0) {
      console.log(`    ⚠️  ${bsCode}: no mappings extracted from Excel — skipping`);
      return 0;
    }

    let matched = 0;
    let unmatched = 0;
    const bsSvc = flatIndex[bsCode];
    if (!bsSvc) {
      console.log(`    ⚠️  ${bsCode}: not found in flat_index`);
      return 0;
    }

    const logRows = [];

    for (const modCode of bsSvc.childServices || []) {
      const mod = flatIndex[modCode];
      if (!mod) continue;
      for (const childCode of mod.childServices || []) {
        const child = flatIndex[childCode];
        if (!child) continue;

        const svcCode  = String(child.code || '').trim();
        const svcNum   = String(child.serviceNumber || '').trim();
        const svcCodeP = svcCode.padStart(18, '0');
        const svcNumP  = svcNum.padStart(18, '0');
        const svcName  = _clean(child.name || '');

        // Match priority:
        // 1. CRM code exact
        // 2. serviceNumber exact
        // 3. Zero-padded 18-digit variants
        // 4. Catalog name clean match
        let deckName = null;
        let matchMethod = null;

        if (byCode[svcCode])  { deckName = byCode[svcCode];  matchMethod = `code:${svcCode}`; }
        else if (byCode[svcNum])   { deckName = byCode[svcNum];   matchMethod = `serviceNumber:${svcNum}`; }
        else if (byCode[svcCodeP]) { deckName = byCode[svcCodeP]; matchMethod = `padded:${svcCodeP}`; }
        else if (byCode[svcNumP])  { deckName = byCode[svcNumP];  matchMethod = `paddedNum:${svcNumP}`; }
        else if (byName[svcName])  { deckName = byName[svcName];  matchMethod = `name:${svcName}`; }

        if (!child.business_scenario_naming) child.business_scenario_naming = {};

        if (deckName) {
          child.business_scenario_naming[bsCode] = deckName;
          matched++;
          logRows.push({ svcCode, svcNum, svcName: child.name, module: modCode, deckName, method: matchMethod, status: 'matched' });
        } else {
          delete child.business_scenario_naming[bsCode];
          unmatched++;
          logRows.push({ svcCode, svcNum, svcName: child.name, module: modCode, deckName: null, method: null, status: 'no_match' });
        }
      }
    }

    console.log(`    ✅ ${bsCode}: ${matched} matched, ${unmatched} unmatched out of ${matched + unmatched} services`);
    console.log(`       Excel had ${Object.keys(byCode).length} CRM codes + ${Object.keys(byName).length} name mappings`);

    // Sample unmatched for diagnosis
    const unmatchedSamples = logRows.filter(r => r.status === 'no_match').slice(0, 3);
    if (unmatchedSamples.length > 0) {
      console.log(`       Sample unmatched: ${unmatchedSamples.map(r => `"${r.svcName}" (code:${r.svcCode}, num:${r.svcNum})`).join(' | ')}`);
    }

    // Store in injection log if provided
    if (injectionLog) {
      injectionLog[bsCode] = { matched, unmatched, rows: logRows };
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

// Excel-only enrichment
router.post('/excel-enrich', requirePublishToken, async (req, res) => {
  console.log('=== SYNC: EXCEL ENRICH ===');
  try {
    const { bsCode } = req.body || {};
    const cached = snapshot.load();
    if (!cached) {
      return res.status(400).json({ error: 'No cached snapshot found. Run /sync/full first.' });
    }

    const flatIndex = JSON.parse(cached.payload).flat_index || {};

    const targetCodes = bsCode
      ? [bsCode]
      : Object.keys(flatIndex).filter(c => flatIndex[c].serviceObject === 'Business Scenario');

    let processed = 0, totalEnriched = 0, notFound = [];
    const injectionLog = {};

    for (const code of targetCodes) {
      const excelPath = path.join(EXCEL_DIR, `${code}.xlsx`);
      if (!fs.existsSync(excelPath)) {
        notFound.push(code);
        for (const modCode of (flatIndex[code] || {}).childServices || []) {
          for (const childCode of (flatIndex[modCode] || {}).childServices || []) {
            const child = flatIndex[childCode];
            if (child && child.business_scenario_naming) {
              delete child.business_scenario_naming[code];
            }
          }
        }
        continue;
      }
      const buf = fs.readFileSync(excelPath);
      totalEnriched += applyExcelEnrichment(flatIndex, code, buf, injectionLog);
      processed++;
    }

    // Save injection log as JSON data product
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

    const result = publishSnapshot(flatIndex, cached.lastFullBuild);
    console.log(`[M1.achieved]: excel-enrich published — bs_processed=${processed} enriched_services=${totalEnriched}`);
    res.json({ status: 'completed', mode: 'excel-enrich', processed, totalEnriched, notFound, ...result });
  } catch (err) {
    console.error(`[M1.missed]: excel-enrich failed — error=${err.message}`);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

// Get injection log
router.get('/injection-log', (req, res) => {
  const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'No injection log yet. Run excel-enrich first.' });
  try { res.json(JSON.parse(fs.readFileSync(logPath, 'utf8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
