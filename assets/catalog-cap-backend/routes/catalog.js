/**
 * Catalog routes
 */

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const snapshot = require('../store/snapshot');

const EXCEL_DIR     = process.env.EXCEL_STORE_PATH   || path.join(__dirname, '..', 'data', 'excels');
const MANIFEST_FILE = process.env.EXCEL_MANIFEST_PATH || path.join(__dirname, '..', 'data', 'excel-manifest.json');
fs.mkdirSync(EXCEL_DIR, { recursive: true });

// ── Auth helper ───────────────────────────────────────────────────────────────
function requirePublishToken(req, res, next) {
  const token = process.env.CAP_PUBLISH_TOKEN;
  if (!token) return next();
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${token}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Publish Snapshot ──────────────────────────────────────────────────────────
router.post('/publishSnapshot', requirePublishToken, (req, res) => {
  try {
    const { payload, lastFullBuild } = req.body;
    if (!payload) return res.status(400).json({ error: 'payload is required' });
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const serviceCount = Object.keys(parsed.flat_index || {}).length;
    const data = {
      lastFullBuild: lastFullBuild || parsed.last_full_build || null,
      lastUpdated: new Date().toISOString(),
      serviceCount,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
    };
    snapshot.save(data);
    console.log(`[M1.achieved]: catalog published — service_count=${serviceCount}`);
    res.json({ status: 'published', serviceCount, lastUpdated: data.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get Snapshot ──────────────────────────────────────────────────────────────
router.get('/getSnapshot', (req, res) => {
  const data = snapshot.load();
  if (!data) return res.status(404).json({ error: 'No snapshot available. Run full build first.' });
  res.json({ lastUpdated: data.lastUpdated, lastFullBuild: data.lastFullBuild, serviceCount: data.serviceCount, payload: data.payload });
});

// ── Search Services ───────────────────────────────────────────────────────────
router.get('/searchServices', (req, res) => {
  try {
    const { query = '', engagementType, businessScenario } = req.query;
    const moduleNames = Array.isArray(req.query.module)
      ? req.query.module
      : (req.query.module ? [req.query.module] : []);

    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};
    const q = query.toLowerCase();

    // Build union of service codes for selected modules
    let moduleServiceCodes = null;
    if (moduleNames.length > 0) {
      moduleServiceCodes = new Set();
      for (const modCode of moduleNames) {
        const mod = flatIndex[modCode];
        if (mod) (mod.childServices || []).forEach(c => moduleServiceCodes.add(c));
      }
    }

    // Build BS service codes
    let bsServiceCodes = null;
    if (businessScenario) {
      bsServiceCodes = new Set();
      const bs = flatIndex[businessScenario];
      if (bs) {
        for (const modCode of bs.childServices || []) {
          const mod = flatIndex[modCode];
          if (mod) (mod.childServices || []).forEach(c => bsServiceCodes.add(c));
        }
      }
    }

    const seen = new Set();
    const results = Object.values(flatIndex).filter(svc => {
      if (svc.serviceObject === 'Business Scenario' || svc.serviceObject === 'Business Scenario module') return false;
      if (!svc.name) return false;
      if (seen.has(svc.code)) return false;
      const textMatch = !q || svc.name.toLowerCase().includes(q) || (svc.shortDescription||'').toLowerCase().includes(q);
      const etArr = Array.isArray(svc.engagementType) ? svc.engagementType : (svc.engagementType ? [svc.engagementType] : []);
      const etMatch = !engagementType || etArr.some(e => e === engagementType);
      const bsMatch = !bsServiceCodes || bsServiceCodes.has(svc.code);
      const modMatch = !moduleServiceCodes || moduleServiceCodes.has(svc.code);
      if (textMatch && etMatch && bsMatch && modMatch) { seen.add(svc.code); return true; }
      return false;
    }).slice(0, 200);

    res.json({ count: results.length, services: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Filter Services ───────────────────────────────────────────────────────────
router.get('/filterServices', (req, res) => {
  try {
    const { engagementType, businessScenario } = req.query;
    // module can be single string or array
    const moduleNames = Array.isArray(req.query.module)
      ? req.query.module
      : (req.query.module ? [req.query.module] : []);

    if (!engagementType && !businessScenario && moduleNames.length === 0)
      return res.status(400).json({ error: 'At least one filter required' });

    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};

    // Build set of service codes per module (union across all selected modules)
    let moduleServiceCodes = null;
    if (moduleNames.length > 0) {
      moduleServiceCodes = new Set();
      for (const modCode of moduleNames) {
        const mod = flatIndex[modCode];
        if (mod) (mod.childServices || []).forEach(c => moduleServiceCodes.add(c));
      }
    }

    // Build set of service codes in the BS (walk BS → modules → childServices)
    let bsServiceCodes = null;
    if (businessScenario) {
      bsServiceCodes = new Set();
      const bs = flatIndex[businessScenario];
      if (bs) {
        for (const modCode of bs.childServices || []) {
          const mod = flatIndex[modCode];
          if (mod) (mod.childServices || []).forEach(c => bsServiceCodes.add(c));
        }
      }
    }

    const seen = new Set();
    const results = Object.values(flatIndex).filter(svc => {
      if (svc.serviceObject === 'Business Scenario' || svc.serviceObject === 'Business Scenario module') return false;
      if (!svc.name) return false;
      if (seen.has(svc.code)) return false;

      const etArr = Array.isArray(svc.engagementType) ? svc.engagementType : (svc.engagementType ? [svc.engagementType] : []);
      const etMatch = !engagementType || etArr.some(e => e === engagementType);
      const bsMatch = !bsServiceCodes || bsServiceCodes.has(svc.code);
      const modMatch = !moduleServiceCodes || moduleServiceCodes.has(svc.code);

      if (etMatch && bsMatch && modMatch) { seen.add(svc.code); return true; }
      return false;
    }).slice(0, 500);

    res.json({ count: results.length, services: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Metadata endpoint — lightweight, no full snapshot download ────────────────
router.get('/metadata', (req, res) => {
  try {
    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};

    const bsMap = {}, moduleMap = {}, bsToMods = {};
    const etSet = new Set();

    for (const [code, svc] of Object.entries(flatIndex)) {
      if (svc.serviceObject === 'Business Scenario') {
        bsMap[code] = svc.name;
        bsToMods[code] = [];
        for (const modCode of svc.childServices || []) {
          const mod = flatIndex[modCode];
          if (!mod) continue;
          moduleMap[modCode] = mod.name;
          bsToMods[code].push(modCode);
        }
      }
      const ets = Array.isArray(svc.engagementType) ? svc.engagementType : (svc.engagementType ? [svc.engagementType] : []);
      ets.forEach(et => etSet.add(et));
    }

    res.json({
      lastUpdated: data.lastUpdated,
      serviceCount: data.serviceCount,
      bsMap,
      moduleMap,
      bsToMods,
      engagementTypes: [...etSet].sort()
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Debug: get childServices of a module ─────────────────────────────────────
router.get('/module/:code/children', (req, res) => {
  try {
    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};
    const mod = flatIndex[req.params.code];
    if (!mod) return res.status(404).json({ error: 'Module not found' });
    const children = (mod.childServices || []).map(c => {
      const svc = flatIndex[c] || {};
      return { code: c, name: svc.name, engagementType: svc.engagementType, bsNaming: svc.business_scenario_naming };
    });
    res.json({ moduleCode: req.params.code, moduleName: mod.name, childCount: children.length, children });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Export full services list with all fields (for Excel export) ─────────────
router.get('/export-full', async (req, res) => {
  try {
    const syncModule = require('./sync');
    console.log('[export-full] Fetching all services with fields=FULL from SSC API...');
    const services = await syncModule.fetchAllServicesFull();
    console.log(`[export-full] Fetched ${services.length} services`);
    res.json({ count: services.length, services });
  } catch(e) {
    console.error(`[export-full] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Get single service full object ───────────────────────────────────────────
router.get('/service/:code', (req, res) => {
  try {
    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};
    const svc = flatIndex[req.params.code];
    if (!svc) return res.status(404).json({ error: `Service not found: ${req.params.code}` });
    res.json(svc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Excel Manifest ────────────────────────────────────────────────────────────
router.get('/excel-manifest', (req, res) => {
  if (!fs.existsSync(MANIFEST_FILE)) return res.status(404).json({ error: 'No manifest yet.' });
  try { res.json(JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/excel-manifest', requirePublishToken, (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: '"entries" array required' });
    const manifest = { updatedAt: new Date().toISOString(), count: entries.length, entries };
    fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    res.json({ status: 'saved', count: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Excel Upload + Immediate Enrichment ──────────────────────────────────────
// IMPORTANT: must be defined BEFORE /excel/:bsCode to avoid route collision

router.put('/excel/upload', (req, res) => {
  try {
    const filename  = req.headers['x-filename'] || '';
    const bsCode    = (req.headers['x-bs-code'] || filename.split('_')[0] || '').toUpperCase();
    if (!bsCode) return res.status(400).json({ error: 'X-BS-Code or X-Filename header required' });

    const buf = req.body;
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'Empty body' });

    console.log(`[excel-upload] ${bsCode}: ${filename} (${buf.length} bytes)`);

    const xlsx = require('xlsx');
    const workbook = xlsx.read(buf, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    const serviceCodes = new Set();
    for (const row of rows) {
      for (const cell of row) {
        const val = String(cell || '').trim();
        if (/^\d{7,10}$/.test(val) || /^[A-Z]{2,}\d{4,}/.test(val)) serviceCodes.add(val);
      }
    }
    console.log(`[excel-upload] ${bsCode}: ${serviceCodes.size} service codes found`);

    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });

    const parsed = JSON.parse(data.payload);
    const flatIndex = parsed.flat_index || {};
    const bsName = (flatIndex[bsCode] || {}).name || bsCode;
    let enriched = 0;

    for (const svc of Object.values(flatIndex)) {
      if (serviceCodes.has(svc.code) || serviceCodes.has(svc.serviceNumber)) {
        if (!svc.business_scenario_naming) svc.business_scenario_naming = {};
        svc.business_scenario_naming[bsCode] = bsName;
        enriched++;
      }
    }

    snapshot.save({ ...data, payload: JSON.stringify(parsed), lastUpdated: new Date().toISOString() });

    // Update lastProcessed in manifest
    if (fs.existsSync(MANIFEST_FILE)) {
      try {
        const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
        const e = (m.entries || []).find(e => e.bsCode === bsCode);
        if (e) { e.lastProcessed = new Date().toISOString(); fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2)); }
      } catch(e) { /* non-critical */ }
    }

    console.log(`[excel-upload] ${bsCode}: enriched ${enriched} services`);
    res.json({ status: 'enriched', bsCode, filename, servicesEnriched: enriched, codesFound: serviceCodes.size });
  } catch (err) {
    console.error(`[excel-upload] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Serial enrichment queue — processes ONE BS at a time, no race conditions ──
const enrichQueue = [];
let enrichRunning = false;

async function processEnrichQueue() {
  if (enrichRunning) return;
  enrichRunning = true;
  while (enrichQueue.length > 0) {
    const { bsCode, buf } = enrichQueue.shift();
    try {
      console.log(`[enrich-queue] Processing ${bsCode} (${enrichQueue.length} remaining)`);
      const cached = snapshot.load();
      if (!cached) { console.warn(`[enrich-queue] No snapshot for ${bsCode}`); continue; }
      const syncModule = require('./sync');
      const parsed = JSON.parse(cached.payload);
      const flatIndex = parsed.flat_index || {};
      const injectionLog = {};
      const enriched = await syncModule.applyExcelEnrichment(flatIndex, bsCode, buf, injectionLog);
      const businessScenarios = syncModule.buildHierarchy(flatIndex);
      parsed.flat_index = flatIndex;
      parsed.business_scenarios = businessScenarios;
      snapshot.save({ ...cached, payload: JSON.stringify(parsed), lastUpdated: new Date().toISOString() });

      // Save injection log
      const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
      let existingLog = {};
      try { existingLog = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) {}
      existingLog.generatedAt = new Date().toISOString();
      existingLog.details = existingLog.details || {};
      existingLog.details[bsCode] = injectionLog[bsCode] || {};
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, JSON.stringify(existingLog, null, 2));
      console.log(`[enrich-queue] ✅ ${bsCode}: ${enriched} services enriched`);
    } catch(e) {
      console.error(`[enrich-queue] ❌ ${bsCode}: ${e.message}`);
      // Save error to log
      try {
        const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
        let existingLog = {};
        try { existingLog = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e2) {}
        existingLog.details = existingLog.details || {};
        existingLog.details[bsCode] = { error: e.message, timestamp: new Date().toISOString() };
        fs.writeFileSync(logPath, JSON.stringify(existingLog, null, 2));
      } catch(e2) {}
    }
  }
  enrichRunning = false;
}

// ── Excel File Store ──────────────────────────────────────────────────────────
router.get('/excel', (req, res) => {
  try {
    const files = fs.readdirSync(EXCEL_DIR).filter(f => f.endsWith('.xlsx'));
    res.json({ bsCodes: files.map(f => path.basename(f, '.xlsx')), count: files.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/excel/:bsCode', requirePublishToken, (req, res) => {
  const { bsCode } = req.params;
  if (!/^[A-Z0-9]{5,10}$/.test(bsCode)) return res.status(400).json({ error: `Invalid bsCode: ${bsCode}` });
  const buf = req.body;
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'Empty body' });
  fs.writeFileSync(path.join(EXCEL_DIR, `${bsCode}.xlsx`), buf);
  // Add to serial enrichment queue — processes one at a time, no race conditions
  enrichQueue.push({ bsCode, buf });
  processEnrichQueue();
  res.json({ status: 'queued', bsCode, sizeBytes: buf.length });
});

// ── Apply enrichment results from Python ──────────────────────────────────────
// Python does all heavy matching locally, sends only the results map here
// Body: { deckNames: { "serviceCode": "deckName", ... }, injectionLog: {...} }
router.post('/excel/:bsCode/enrich', requirePublishToken, (req, res) => {
  const { bsCode } = req.params;
  const { deckNames = {}, injectionLog = {} } = req.body;

  const cached = snapshot.load();
  if (!cached) return res.status(404).json({ error: 'No snapshot available' });

  try {
    const parsed = JSON.parse(cached.payload);
    const flatIndex = parsed.flat_index || {};
    let enriched = 0;

    // Apply deck names — simple hash lookup, milliseconds
    for (const [svcCode, deckName] of Object.entries(deckNames)) {
      const svc = flatIndex[svcCode];
      if (svc) {
        if (!svc.business_scenario_naming) svc.business_scenario_naming = {};
        svc.business_scenario_naming[bsCode] = deckName;
        enriched++;
      }
    }

    // Rebuild hierarchy and save
    const syncModule = require('./sync');
    parsed.flat_index = flatIndex;
    parsed.business_scenarios = syncModule.buildHierarchy(flatIndex);
    snapshot.save({ ...cached, payload: JSON.stringify(parsed), lastUpdated: new Date().toISOString() });

    // Save injection log
    const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
    let existingLog = {};
    try { existingLog = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) {}
    existingLog.generatedAt = new Date().toISOString();
    existingLog.details = existingLog.details || {};
    existingLog.details[bsCode] = { enriched, ...injectionLog };
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(existingLog, null, 2));

    console.log(`[M1.achieved]: excel-enrich published — bs_processed=1 enriched_services=${enriched}`);
    res.json({ status: 'enriched', bsCode, enrichedServices: enriched });
  } catch(e) {
    console.error(`[enrich] ${bsCode}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.get('/excel/:bsCode', (req, res) => {
  const filePath = path.join(EXCEL_DIR, `${req.params.bsCode}.xlsx`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: `Not found: ${req.params.bsCode}` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.bsCode}.xlsx"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
