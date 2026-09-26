/**
 * Catalog routes:
 *   POST /api/catalog/publishSnapshot  — n8n writes new snapshot (token-protected)
 *   GET  /api/catalog/getSnapshot      — returns latest snapshot metadata + payload
 *   GET  /api/catalog/searchServices   — keyword search over catalog
 *   GET  /api/catalog/filterServices   — multi-attribute filter
 *   PUT  /api/catalog/excel/:bsCode    — upload Excel mapping file (token-protected)
 *   GET  /api/catalog/excel/:bsCode    — retrieve Excel mapping file
 *   GET  /api/catalog/excel            — list all staged BS codes
 */

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const snapshot = require('../store/snapshot');

const EXCEL_DIR = process.env.EXCEL_STORE_PATH || path.join(__dirname, '..', 'data', 'excels');
fs.mkdirSync(EXCEL_DIR, { recursive: true });

// ── Auth helper ───────────────────────────────────────────────────────────────
function requirePublishToken(req, res, next) {
  const token = process.env.CAP_PUBLISH_TOKEN;
  if (!token) return next(); // dev mode: no token configured → allow
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Publish Snapshot ──────────────────────────────────────────────────────────
router.post('/publishSnapshot', requirePublishToken, (req, res) => {
  try {
    const { payload, lastFullBuild } = req.body;
    if (!payload) return res.status(400).json({ error: 'payload is required' });

    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const flatIndex = parsed.flat_index || {};
    const serviceCount = Object.keys(flatIndex).length;

    const data = {
      lastFullBuild: lastFullBuild || parsed.last_full_build || null,
      lastUpdated: new Date().toISOString(),
      serviceCount,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
    };

    snapshot.save(data);
    console.log(`[M1.achieved]: catalog data product published — service_count=${serviceCount}`);
    res.json({ status: 'published', serviceCount, lastUpdated: data.lastUpdated });
  } catch (err) {
    console.error(`[M1.missed]: catalog data product publication failed — error=${err.message}`);
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

      // Text match
      const nameMatch = q ? svc.name.toLowerCase().includes(q) : true;
      const shortMatch = q ? (svc.shortDescription || '').toLowerCase().includes(q) : true;
      const longMatch = q ? (svc.longDescription || '').toLowerCase().includes(q) : true;
      const bsNaming = svc.business_scenario_naming || {};
      const bsMatch = q ? Object.values(bsNaming).some(n => n.toLowerCase().includes(q)) : true;
      const textMatch = !q || nameMatch || shortMatch || longMatch || bsMatch;

      // Attribute filters — engagementType can be array or string
      const etArr = Array.isArray(svc.engagementType)
        ? svc.engagementType
        : (svc.engagementType ? [svc.engagementType] : []);
      const etMatch = !engagementType || etArr.some(e => e.toLowerCase().includes(engagementType.toLowerCase()));
      const bsFilter = !businessScenario || Object.keys(bsNaming).some(k => k === businessScenario) || (svc.parentServices||[]).some(p => p === businessScenario);
      const modMatch = !moduleName || svc.parentCode === moduleName;

      return textMatch && etMatch && bsFilter && modMatch;
    });

    // Score: name match scores highest
    results = results.sort((a, b) => {
      const aName = (a.name || '').toLowerCase().includes(q) ? 1 : 0;
      const bName = (b.name || '').toLowerCase().includes(q) ? 1 : 0;
      return bName - aName;
    }).slice(0, 100);

    res.json({ count: results.length, services: results.map(s => ({
      code: s.code,
      name: s.name,
      shortDescription: s.shortDescription || '',
      longDescription: s.longDescription || '',
      engagementType: s.engagementType || '',
      businessScenarioNaming: s.business_scenario_naming || {},
      parentCode: s.parentCode || ''
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Filter Services ───────────────────────────────────────────────────────────
router.get('/filterServices', (req, res) => {
  try {
    const { engagementType, businessScenario, module: moduleName } = req.query;
    if (!engagementType && !businessScenario && !moduleName) {
      return res.status(400).json({ error: 'At least one filter parameter is required (engagementType, businessScenario, module)' });
    }

    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });

    const flatIndex = JSON.parse(data.payload).flat_index || {};

    const results = Object.values(flatIndex).filter(svc => {
      if (svc.serviceObject === 'Business Scenario' || svc.serviceObject === 'Business Scenario module') return false;
      if (!svc.name) return false;

      // engagementType can be a string or an array
      const etArr = Array.isArray(svc.engagementType)
        ? svc.engagementType
        : (svc.engagementType ? [svc.engagementType] : []);
      const etMatch = !engagementType || etArr.some(e => e.toLowerCase().includes(engagementType.toLowerCase()));

      // businessScenario: match against parentServices (BS codes) or business_scenario_naming keys
      const bsNaming = svc.business_scenario_naming || {};
      const parentSvcs = svc.parentServices || [];
      const bsMatch = !businessScenario || (
        Object.keys(bsNaming).some(k => k === businessScenario) ||
        parentSvcs.some(p => p === businessScenario)
      );

      // module: match parentCode (direct parent = module code)
      const modMatch = !moduleName || svc.parentCode === moduleName;

      return etMatch && bsMatch && modMatch;
    }).slice(0, 200);

    res.json({ count: results.length, services: results.map(s => ({
      code: s.code,
      name: s.name,
      shortDescription: s.shortDescription || '',
      engagementType: s.engagementType || '',
      businessScenarioNaming: s.business_scenario_naming || {},
      parentCode: s.parentCode || ''
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Excel Manifest ────────────────────────────────────────────────────────────
// Stores a JSON list of { bsCode, bsName, excelUrl } built by n8n from the snapshot.
// Power Automate reads this to know exactly which files to fetch from SharePoint.

const MANIFEST_FILE = process.env.EXCEL_MANIFEST_PATH || path.join(__dirname, '..', 'data', 'excel-manifest.json');

// GET /api/catalog/excel-manifest — Power Automate reads this
router.get('/excel-manifest', (req, res) => {
  if (!fs.existsSync(MANIFEST_FILE)) {
    return res.status(404).json({ error: 'No manifest yet. Run n8n daily-check workflow first.' });
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/catalog/excel-manifest — n8n writes this after reading snapshot
router.put('/excel-manifest', requirePublishToken, (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: '"entries" array required' });
    const manifest = {
      updatedAt: new Date().toISOString(),
      count: entries.length,
      entries // [{ bsCode, bsName, excelUrl, fileName }]
    };
    fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`Excel manifest saved: ${entries.length} entries`);
    res.json({ status: 'saved', count: entries.length, updatedAt: manifest.updatedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Excel File Store ──────────────────────────────────────────────────────────

// List staged BS codes
router.get('/excel', (req, res) => {
  try {
    const files = fs.readdirSync(EXCEL_DIR).filter(f => f.endsWith('.xlsx'));
    const bsCodes = files.map(f => path.basename(f, '.xlsx'));
    res.json({ bsCodes, count: bsCodes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload Excel for a BS code
router.put('/excel/:bsCode', requirePublishToken, (req, res) => {
  const { bsCode } = req.params;
  if (!/^[A-Z0-9]{5,10}$/.test(bsCode)) {
    return res.status(400).json({ error: `Invalid bsCode format: ${bsCode}` });
  }
  const buf = req.body;
  if (!buf || buf.length === 0) {
    return res.status(400).json({ error: 'Empty body — send raw .xlsx binary' });
  }
  const dest = path.join(EXCEL_DIR, `${bsCode}.xlsx`);
  fs.writeFileSync(dest, buf);
  console.log(`Excel staged: ${bsCode}.xlsx (${buf.length} bytes)`);
  res.json({ status: 'stored', bsCode, sizeBytes: buf.length });
});

// Download Excel for a BS code
router.get('/excel/:bsCode', (req, res) => {
  const { bsCode } = req.params;
  const filePath = path.join(EXCEL_DIR, `${bsCode}.xlsx`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Excel file not found for bsCode: ${bsCode}` });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${bsCode}.xlsx"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
