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
    const { query = '', engagementType, businessScenario, module: moduleName } = req.query;
    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};
    const q = query.toLowerCase();
    let results = Object.values(flatIndex).filter(svc => {
      if (svc.serviceObject === 'Business Scenario') return false;
      if (!svc.name) return false;
      const textMatch = !q || svc.name.toLowerCase().includes(q) || (svc.shortDescription||'').toLowerCase().includes(q);
      const etArr = Array.isArray(svc.engagementType) ? svc.engagementType : (svc.engagementType ? [svc.engagementType] : []);
      const etMatch = !engagementType || etArr.some(e => e.toLowerCase().includes(engagementType.toLowerCase()));
      const bsNaming = svc.business_scenario_naming || {};
      const bsMatch = !businessScenario || Object.keys(bsNaming).some(k => k === businessScenario) || (svc.parentServices||[]).some(p => p === businessScenario);
      const modMatch = !moduleName || svc.parentCode === moduleName;
      return textMatch && etMatch && bsMatch && modMatch;
    }).slice(0, 100);
    res.json({ count: results.length, services: results.map(s => ({ code: s.code, name: s.name, shortDescription: s.shortDescription||'', engagementType: s.engagementType||'', businessScenarioNaming: s.business_scenario_naming||{}, parentCode: s.parentCode||'' })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Filter Services ───────────────────────────────────────────────────────────
router.get('/filterServices', (req, res) => {
  try {
    const { engagementType, businessScenario, module: moduleName } = req.query;
    if (!engagementType && !businessScenario && !moduleName)
      return res.status(400).json({ error: 'At least one filter required' });
    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};
    const results = Object.values(flatIndex).filter(svc => {
      if (svc.serviceObject === 'Business Scenario' || svc.serviceObject === 'Business Scenario module') return false;
      if (!svc.name) return false;
      const etArr = Array.isArray(svc.engagementType) ? svc.engagementType : (svc.engagementType ? [svc.engagementType] : []);
      const etMatch = !engagementType || etArr.some(e => e.toLowerCase().includes(engagementType.toLowerCase()));
      const bsNaming = svc.business_scenario_naming || {};
      const bsMatch = !businessScenario || Object.keys(bsNaming).some(k => k === businessScenario) || (svc.parentServices||[]).some(p => p === businessScenario);
      const modMatch = !moduleName || svc.parentCode === moduleName;
      return etMatch && bsMatch && modMatch;
    }).slice(0, 200);
    res.json({ count: results.length, services: results.map(s => ({ code: s.code, name: s.name, shortDescription: s.shortDescription||'', engagementType: s.engagementType||'', businessScenarioNaming: s.business_scenario_naming||{}, parentCode: s.parentCode||'' })) });
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
  res.json({ status: 'stored', bsCode, sizeBytes: buf.length });
});

router.get('/excel/:bsCode', (req, res) => {
  const filePath = path.join(EXCEL_DIR, `${req.params.bsCode}.xlsx`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: `Not found: ${req.params.bsCode}` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.bsCode}.xlsx"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
