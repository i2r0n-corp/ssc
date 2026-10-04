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
    console.log('[M1.achieved]: catalog published — service_count=' + serviceCount);
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
    const moduleNames = Array.isArray(req.query.module) ? req.query.module : (req.query.module ? [req.query.module] : []);
    const phases = Array.isArray(req.query.phase) ? req.query.phase : (req.query.phase ? [req.query.phase] : []);
    const phaseMode = req.query.phaseMode || 'merge';
    const supercats = Array.isArray(req.query.supercat) ? req.query.supercat : (req.query.supercat ? [req.query.supercat] : []);
    const advancedLoSCats = Array.isArray(req.query.advancedLoSCat) ? req.query.advancedLoSCat : (req.query.advancedLoSCat ? [req.query.advancedLoSCat] : []);
    const advancedLoSMode = req.query.advancedLoSMode || 'merge';
    const foundationalCats = Array.isArray(req.query.foundationalCat) ? req.query.foundationalCat : (req.query.foundationalCat ? [req.query.foundationalCat] : []);
    const foundationalCatsMode = req.query.foundationalCatsMode || 'merge';

    // ── PostgreSQL path ───────────────────────────────────────────────────────
    const dbSearch = async () => {
      const db = require('../store/db');
      db.getPool();

      const params = [];
      let pIdx = 1;
      let sql = 'SELECT DISTINCT s.*, bn.deck_name, bn.bs_code AS bn_bs_code FROM catalog_services s LEFT JOIN catalog_bs_naming bn ON bn.service_code = s.code WHERE s.service_object NOT IN (\'Business Scenario\', \'Business Scenario module\') AND s.name IS NOT NULL';

      if (query) {
        params.push(`%${query.toLowerCase()}%`);
        sql += ' AND (LOWER(s.name) LIKE $' + pIdx + ' OR LOWER(s.short_description) LIKE $' + pIdx + ')';
        pIdx++;
      }

      if (engagementType) {
        params.push(engagementType);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_classification cc WHERE cc.service_code = s.code AND cc.feature_key = \'engagementType\' AND cc.feature_value = $' + pIdx + ')';
        pIdx++;
      }

      if (businessScenario) {
        params.push(businessScenario);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_hierarchy h1 JOIN catalog_hierarchy h2 ON h2.parent_code = h1.child_code WHERE h1.parent_code = $' + pIdx + ' AND h2.child_code = s.code)';
        pIdx++;
      }

      if (moduleNames.length > 0) {
        params.push(moduleNames);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_hierarchy hm WHERE hm.parent_code = ANY($' + pIdx + '::text[]) AND hm.child_code = s.code)';
        pIdx++;
      }

      if (phases.length > 0) {
        if (phaseMode === 'intersect') {
          for (const phase of phases) {
            params.push(phase);
            sql += ' AND EXISTS (SELECT 1 FROM catalog_classification cp WHERE cp.service_code = s.code AND cp.feature_key = \'sapActivateProjectPhase\' AND cp.feature_value = $' + pIdx + ')';
            pIdx++;
          }
        } else {
          params.push(phases);
          sql += ' AND EXISTS (SELECT 1 FROM catalog_classification cp WHERE cp.service_code = s.code AND cp.feature_key = \'sapActivateProjectPhase\' AND cp.feature_value = ANY($' + pIdx + '::text[]))';
          pIdx++;
        }
      }

      if (supercats.length > 0) {
        params.push(supercats);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = ANY($' + pIdx + '::text[]))';
        pIdx++;
      }

      if (advancedLoSCats.length > 0) {
        if (advancedLoSMode === 'intersect') {
          for (const cat of advancedLoSCats) {
            params.push(cat);
            sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = $' + pIdx + ')';
            pIdx++;
          }
        } else {
          params.push(advancedLoSCats);
          sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = ANY($' + pIdx + '::text[]))';
          pIdx++;
        }
      }

      if (foundationalCats.length > 0) {
        if (foundationalCatsMode === 'intersect') {
          for (const cat of foundationalCats) {
            params.push(cat);
            sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = $' + pIdx + ')';
            pIdx++;
          }
        } else {
          params.push(foundationalCats);
          sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = ANY($' + pIdx + '::text[]))';
          pIdx++;
        }
      }

      sql += ' ORDER BY s.name LIMIT 200';

      const result = await db.query(sql, params);
      const services = result.rows.map(row => {
        const svc = row.raw_data || {};
        if (row.deck_name && row.bn_bs_code) {
          if (!svc.business_scenario_naming) svc.business_scenario_naming = {};
          svc.business_scenario_naming[row.bn_bs_code] = row.deck_name;
        }
        return svc;
      });
      return services;
    };

    // Try DB first, fall back to snapshot file
    dbSearch().then(services => {
      res.json({ count: services.length, services });
    }).catch(dbErr => {
      if (!dbErr.message.includes('No PostgreSQL')) {
        console.warn('[searchServices] DB failed, falling back to file:', dbErr.message);
      }
      // ── File fallback ─────────────────────────────────────────────────────
      const data = snapshot.load();
      if (!data) return res.status(404).json({ error: 'No snapshot available' });
      const flatIndex = JSON.parse(data.payload).flat_index || {};
      const q = query.toLowerCase();

      let moduleServiceCodes = null;
      if (moduleNames.length > 0) {
        moduleServiceCodes = new Set();
        for (const modCode of moduleNames) {
          const mod = flatIndex[modCode];
          if (mod) (mod.childServices || []).forEach(c => moduleServiceCodes.add(c));
        }
      }

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
        let phaseMatch = true;
        if (phases.length > 0) {
          const cf = svc.classificationFeatures;
          const svcPhases = new Set();
          if (Array.isArray(cf)) {
            for (const item of cf) {
              if (item && item.key === 'sapActivateProjectPhase') {
                const vals = Array.isArray(item.value) ? item.value : [item.value];
                vals.forEach(v => v && svcPhases.add(String(v)));
              }
            }
          }
          phaseMatch = phaseMode === 'intersect'
            ? phases.every(p => svcPhases.has(p))
            : phases.some(p => svcPhases.has(p));
        }
        const cats = svc.supercategories;
        const svcCats = new Set();
        if (Array.isArray(cats)) cats.forEach(c => c && c.name && svcCats.add(c.name));
        let supercatMatch = true;
        if (supercats.length > 0) {
          supercatMatch = supercats.some(sc => svcCats.has(sc));
        }
        let advancedLoSMatch = true;
        if (advancedLoSCats.length > 0) {
          advancedLoSMatch = advancedLoSMode === 'intersect'
            ? advancedLoSCats.every(sc => svcCats.has(sc))
            : advancedLoSCats.some(sc => svcCats.has(sc));
        }
        let foundationalMatch = true;
        if (foundationalCats.length > 0) {
          foundationalMatch = foundationalCatsMode === 'intersect'
            ? foundationalCats.every(sc => svcCats.has(sc))
            : foundationalCats.some(sc => svcCats.has(sc));
        }
        if (textMatch && etMatch && bsMatch && modMatch && phaseMatch && supercatMatch && advancedLoSMatch && foundationalMatch) { seen.add(svc.code); return true; }
        return false;
      }).slice(0, 200);

      res.json({ count: results.length, services: results });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Filter Services ───────────────────────────────────────────────────────────
router.get('/filterServices', async (req, res) => {
  try {
    const { engagementType, businessScenario } = req.query;
    const moduleNames = Array.isArray(req.query.module) ? req.query.module : (req.query.module ? [req.query.module] : []);
    const phases = Array.isArray(req.query.phase) ? req.query.phase : (req.query.phase ? [req.query.phase] : []);
    const phaseMode = req.query.phaseMode || 'merge';
    const supercats = Array.isArray(req.query.supercat) ? req.query.supercat : (req.query.supercat ? [req.query.supercat] : []);
    const advancedLoSCats = Array.isArray(req.query.advancedLoSCat) ? req.query.advancedLoSCat : (req.query.advancedLoSCat ? [req.query.advancedLoSCat] : []);
    const advancedLoSMode = req.query.advancedLoSMode || 'merge';
    const foundationalCats = Array.isArray(req.query.foundationalCat) ? req.query.foundationalCat : (req.query.foundationalCat ? [req.query.foundationalCat] : []);
    const foundationalCatsMode = req.query.foundationalCatsMode || 'merge';

    if (!engagementType && !businessScenario && moduleNames.length === 0 && phases.length === 0 && supercats.length === 0 && advancedLoSCats.length === 0 && foundationalCats.length === 0)
      return res.status(400).json({ error: 'At least one filter required' });

    // ── PostgreSQL path ───────────────────────────────────────────────────────
    try {
      const db = require('../store/db');
      db.getPool();

      const params = [];
      let pIdx = 1;
      let sql = 'SELECT DISTINCT s.*, bn.deck_name, bn.bs_code AS bn_bs_code FROM catalog_services s LEFT JOIN catalog_bs_naming bn ON bn.service_code = s.code WHERE s.service_object NOT IN (\'Business Scenario\', \'Business Scenario module\') AND s.name IS NOT NULL';

      if (engagementType) {
        params.push(engagementType);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_classification cc WHERE cc.service_code = s.code AND cc.feature_key = \'engagementType\' AND cc.feature_value = $' + pIdx + ')';
        pIdx++;
      }

      if (businessScenario) {
        params.push(businessScenario);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_hierarchy h1 JOIN catalog_hierarchy h2 ON h2.parent_code = h1.child_code WHERE h1.parent_code = $' + pIdx + ' AND h2.child_code = s.code)';
        pIdx++;
      }

      if (moduleNames.length > 0) {
        params.push(moduleNames);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_hierarchy hm WHERE hm.parent_code = ANY($' + pIdx + '::text[]) AND hm.child_code = s.code)';
        pIdx++;
      }

      if (phases.length > 0) {
        if (phaseMode === 'intersect') {
          for (const phase of phases) {
            params.push(phase);
            sql += ' AND EXISTS (SELECT 1 FROM catalog_classification cp WHERE cp.service_code = s.code AND cp.feature_key = \'sapActivateProjectPhase\' AND cp.feature_value = $' + pIdx + ')';
            pIdx++;
          }
        } else {
          params.push(phases);
          sql += ' AND EXISTS (SELECT 1 FROM catalog_classification cp WHERE cp.service_code = s.code AND cp.feature_key = \'sapActivateProjectPhase\' AND cp.feature_value = ANY($' + pIdx + '::text[]))';
          pIdx++;
        }
      }

      if (supercats.length > 0) {
        params.push(supercats);
        sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = ANY($' + pIdx + '::text[]))';
        pIdx++;
      }

      if (advancedLoSCats.length > 0) {
        if (advancedLoSMode === 'intersect') {
          // Each selected LoS cat must match — one EXISTS per cat
          for (const cat of advancedLoSCats) {
            params.push(cat);
            sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = $' + pIdx + ')';
            pIdx++;
          }
        } else {
          params.push(advancedLoSCats);
          sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = ANY($' + pIdx + '::text[]))';
          pIdx++;
        }
      }

      if (foundationalCats.length > 0) {
        if (foundationalCatsMode === 'intersect') {
          for (const cat of foundationalCats) {
            params.push(cat);
            sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = $' + pIdx + ')';
            pIdx++;
          }
        } else {
          params.push(foundationalCats);
          sql += ' AND EXISTS (SELECT 1 FROM catalog_supercategories cs WHERE cs.service_code = s.code AND cs.category_name = ANY($' + pIdx + '::text[]))';
          pIdx++;
        }
      }

      sql += ' ORDER BY s.name LIMIT 500';

      const result = await db.query(sql, params);
      const services = result.rows.map(row => {
        const svc = row.raw_data || {};
        if (row.deck_name && row.bn_bs_code) {
          if (!svc.business_scenario_naming) svc.business_scenario_naming = {};
          svc.business_scenario_naming[row.bn_bs_code] = row.deck_name;
        }
        return svc;
      });
      return res.json({ count: services.length, services });
    } catch(dbErr) {
      if (!dbErr.message.includes('No PostgreSQL')) {
        console.warn('[filterServices] DB failed, falling back to file:', dbErr.message);
      }
    }

    // ── File fallback ─────────────────────────────────────────────────────────
    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};

    let moduleServiceCodes = null;
    if (moduleNames.length > 0) {
      moduleServiceCodes = new Set();
      for (const modCode of moduleNames) {
        const mod = flatIndex[modCode];
        if (mod) (mod.childServices || []).forEach(c => moduleServiceCodes.add(c));
      }
    }

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
      let phaseMatch = true;
      if (phases.length > 0) {
        const cf = svc.classificationFeatures;
        const svcPhases = new Set();
        if (Array.isArray(cf)) {
          for (const item of cf) {
            if (item && item.key === 'sapActivateProjectPhase') {
              const vals = Array.isArray(item.value) ? item.value : [item.value];
              vals.forEach(v => v && svcPhases.add(String(v)));
            }
          }
        }
        phaseMatch = phaseMode === 'intersect'
          ? phases.every(p => svcPhases.has(p))
          : phases.some(p => svcPhases.has(p));
      }
      let supercatMatch = true;
      if (supercats.length > 0) {
        const cats = svc.supercategories;
        const svcCats = new Set();
        if (Array.isArray(cats)) cats.forEach(c => c && c.name && svcCats.add(c.name));
        supercatMatch = supercats.some(sc => svcCats.has(sc));
      }
      let advancedLoSMatch = true;
      if (advancedLoSCats.length > 0) {
        const cats = svc.supercategories;
        const svcCats = new Set();
        if (Array.isArray(cats)) cats.forEach(c => c && c.name && svcCats.add(c.name));
        advancedLoSMatch = advancedLoSMode === 'intersect'
          ? advancedLoSCats.every(sc => svcCats.has(sc))
          : advancedLoSCats.some(sc => svcCats.has(sc));
      }
      let foundationalMatch = true;
      if (foundationalCats.length > 0) {
        const cats = svc.supercategories;
        const svcCats = new Set();
        if (Array.isArray(cats)) cats.forEach(c => c && c.name && svcCats.add(c.name));
        foundationalMatch = foundationalCatsMode === 'intersect'
          ? foundationalCats.every(sc => svcCats.has(sc))
          : foundationalCats.some(sc => svcCats.has(sc));
      }
      if (etMatch && bsMatch && modMatch && phaseMatch && supercatMatch && advancedLoSMatch && foundationalMatch) { seen.add(svc.code); return true; }
      return false;
    }).slice(0, 500);

    res.json({ count: results.length, services: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Metadata endpoint ─────────────────────────────────────────────────────────
router.get('/metadata', async (req, res) => {
  try {
    try {
      const db = require('../store/db');
      db.getPool();

      const [syncRes, bsRes, modRes, etRes, phaseRes, supercatRes] = await Promise.all([
        db.query('SELECT last_updated, service_count FROM catalog_sync ORDER BY id DESC LIMIT 1'),
        db.query('SELECT code, name FROM catalog_services WHERE service_object=\'Business Scenario\' ORDER BY name'),
        db.query('SELECT h.parent_code AS bs_code, s.code AS mod_code, s.name AS mod_name FROM catalog_hierarchy h JOIN catalog_services s ON s.code = h.child_code WHERE s.service_object = \'Business Scenario module\' ORDER BY s.name'),
        db.query('SELECT DISTINCT feature_value FROM catalog_classification WHERE feature_key=\'engagementType\' ORDER BY feature_value'),
        db.query('SELECT DISTINCT feature_value FROM catalog_classification WHERE feature_key=\'sapActivateProjectPhase\' ORDER BY feature_value'),
        db.query('SELECT DISTINCT category_name FROM catalog_supercategories ORDER BY category_name')
      ]);

      if (syncRes.rows.length) {
        const bsMap = {}, moduleMap = {}, bsToMods = {};
        for (const row of bsRes.rows) bsMap[row.code] = row.name;
        for (const row of modRes.rows) {
          moduleMap[row.mod_code] = row.mod_name;
          if (!bsToMods[row.bs_code]) bsToMods[row.bs_code] = [];
          if (!bsToMods[row.bs_code].includes(row.mod_code)) bsToMods[row.bs_code].push(row.mod_code);
        }
        return res.json({
          lastUpdated: syncRes.rows[0].last_updated,
          serviceCount: syncRes.rows[0].service_count,
          bsMap, moduleMap, bsToMods,
          engagementTypes: etRes.rows.map(r => r.feature_value),
          phases: phaseRes.rows.map(r => r.feature_value),
          supercategories: supercatRes.rows.map(r => r.category_name)
        });
      }
    } catch(dbErr) {
      if (!dbErr.message.includes('No PostgreSQL')) {
        console.warn('[metadata] DB query failed, falling back to file:', dbErr.message);
      }
    }

    // Fallback to file-based snapshot
    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    const flatIndex = JSON.parse(data.payload).flat_index || {};

    const bsMap = {}, moduleMap = {}, bsToMods = {};
    const etSet = new Set(), phaseSet = new Set(), supercatMap = {};

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
      const cf = svc.classificationFeatures;
      if (Array.isArray(cf)) {
        for (const item of cf) {
          if (item && item.key === 'sapActivateProjectPhase') {
            const vals = Array.isArray(item.value) ? item.value : [item.value];
            vals.forEach(v => v && phaseSet.add(String(v)));
          }
        }
      }
      const cats = svc.supercategories;
      if (Array.isArray(cats)) {
        for (const c of cats) { if (c && c.name) supercatMap[c.name] = true; }
      }
    }

    res.json({
      lastUpdated: data.lastUpdated, serviceCount: data.serviceCount,
      bsMap, moduleMap, bsToMods,
      engagementTypes: [...etSet].sort(),
      phases: [...phaseSet].sort(),
      supercategories: Object.keys(supercatMap).sort()
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

// ── Export full services list with all fields ─────────────────────────────────
router.get('/export-full', async (req, res) => {
  try {
    const syncModule = require('./sync');
    console.log('[export-full] Fetching all services with fields=FULL from SSC API...');
    const services = await syncModule.fetchAllServicesFull();
    console.log('[export-full] Fetched ' + services.length + ' services');
    res.json({ count: services.length, services });
  } catch(e) {
    console.error('[export-full] Error: ' + e.message);
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
    if (!svc) return res.status(404).json({ error: 'Service not found: ' + req.params.code });
    res.json(svc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Excel Manifest ────────────────────────────────────────────────────────────
router.get('/excel-manifest', async (req, res) => {
  try {
    const db = require('../store/db');
    db.getPool();
    const result = await db.query(
      'SELECT bs_code, file_name, file_size, uploaded_at, processed_at FROM catalog_excel_files ORDER BY bs_code'
    );
    const entries = result.rows.map(r => ({
      bsCode:        r.bs_code,
      fileName:      r.file_name,
      fileSize:      r.file_size,
      uploadedAt:    r.uploaded_at,
      lastProcessed: r.processed_at
    }));
    return res.json({ updatedAt: new Date().toISOString(), count: entries.length, entries });
  } catch (dbErr) {
    if (!dbErr.message.includes('No PostgreSQL')) {
      console.warn('[excel-manifest GET] DB failed, falling back to file:', dbErr.message);
    }
    if (!fs.existsSync(MANIFEST_FILE)) return res.status(404).json({ error: 'No manifest yet.' });
    try { res.json(JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  }
});

router.put('/excel-manifest', requirePublishToken, async (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: '"entries" array required' });

    try {
      const db = require('../store/db');
      db.getPool();
      for (const entry of entries) {
        const { bsCode, fileName } = entry;
        if (!bsCode) continue;
        await db.query(
          `INSERT INTO catalog_excel_files (bs_code, file_name, file_data, file_size)
           VALUES ($1, $2, ''::bytea, 0)
           ON CONFLICT (bs_code) DO UPDATE SET file_name = EXCLUDED.file_name`,
          [bsCode, fileName || null]
        );
      }
      return res.json({ status: 'saved', count: entries.length });
    } catch (dbErr) {
      if (!dbErr.message.includes('No PostgreSQL')) {
        console.warn('[excel-manifest PUT] DB failed, falling back to file:', dbErr.message);
      }
    }

    const manifest = { updatedAt: new Date().toISOString(), count: entries.length, entries };
    fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    res.json({ status: 'saved', count: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Excel Upload + Immediate Enrichment ──────────────────────────────────────
router.put('/excel/upload', async (req, res) => {
  try {
    const filename  = req.headers['x-filename'] || '';
    const bsCode    = (req.headers['x-bs-code'] || filename.split('_')[0] || '').toUpperCase();
    if (!bsCode) return res.status(400).json({ error: 'X-BS-Code or X-Filename header required' });

    const buf = req.body;
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'Empty body' });

    console.log('[excel-upload] ' + bsCode + ': ' + filename + ' (' + buf.length + ' bytes)');

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

    const data = snapshot.load();
    if (!data) return res.status(404).json({ error: 'No snapshot available' });
    if (!data.payload) return res.status(503).json({ error: 'Snapshot not available in file mode; use DB mode.' });

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

    try {
      const db = require('../store/db');
      db.getPool();
      await db.query('UPDATE catalog_excel_files SET processed_at = NOW() WHERE bs_code = $1', [bsCode]);
    } catch(e) { /* non-critical */ }
    if (fs.existsSync(MANIFEST_FILE)) {
      try {
        const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
        const e = (m.entries || []).find(e => e.bsCode === bsCode);
        if (e) { e.lastProcessed = new Date().toISOString(); fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2)); }
      } catch(e) { /* non-critical */ }
    }

    res.json({ status: 'enriched', bsCode, filename, servicesEnriched: enriched, codesFound: serviceCodes.size });
  } catch (err) {
    console.error('[excel-upload] Error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Serial enrichment queue ───────────────────────────────────────────────────
const enrichQueue = [];
let enrichRunning = false;

async function processEnrichQueue() {
  if (enrichRunning) return;
  enrichRunning = true;
  while (enrichQueue.length > 0) {
    const { bsCode, buf } = enrichQueue.shift();
    try {
      console.log('[enrich-queue] Processing ' + bsCode + ' (' + enrichQueue.length + ' remaining)');
      const cached = snapshot.load();
      if (!cached) { console.warn('[enrich-queue] No snapshot for ' + bsCode); continue; }
      const syncModule = require('./sync');
      const parsed = JSON.parse(cached.payload);
      const flatIndex = parsed.flat_index || {};
      const injectionLog = {};
      const enriched = await syncModule.applyExcelEnrichment(flatIndex, bsCode, buf, injectionLog);
      const businessScenarios = syncModule.buildHierarchy(flatIndex);
      parsed.flat_index = flatIndex;
      parsed.business_scenarios = businessScenarios;
      snapshot.save({ ...cached, payload: JSON.stringify(parsed), lastUpdated: new Date().toISOString() });

      // Stamp processed_at in DB
      try {
        const db = require('../store/db');
        db.getPool();
        await db.query('UPDATE catalog_excel_files SET processed_at = NOW() WHERE bs_code = $1', [bsCode]);
      } catch(e) { /* non-critical */ }

      const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
      let existingLog = {};
      try { existingLog = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) {}
      existingLog.generatedAt = new Date().toISOString();
      existingLog.details = existingLog.details || {};
      existingLog.details[bsCode] = injectionLog[bsCode] || {};
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, JSON.stringify(existingLog, null, 2));
      console.log('[enrich-queue] OK ' + bsCode + ': ' + enriched + ' services enriched');
    } catch(e) {
      console.error('[enrich-queue] ERROR ' + bsCode + ': ' + e.message);
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

router.put('/excel/:bsCode', requirePublishToken, async (req, res) => {
  const { bsCode } = req.params;
  if (!/^[A-Z0-9]{5,10}$/.test(bsCode)) return res.status(400).json({ error: 'Invalid bsCode: ' + bsCode });
  const buf = req.body;
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'Empty body' });

  try { fs.writeFileSync(path.join(EXCEL_DIR, bsCode + '.xlsx'), buf); } catch(e) { /* ephemeral FS on CF */ }

  const fileName = req.headers['x-filename'] || (bsCode + '.xlsx');
  try {
    const db = require('../store/db');
    db.getPool();
    await db.query(
      `INSERT INTO catalog_excel_files (bs_code, file_name, file_data, file_size, uploaded_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (bs_code) DO UPDATE SET file_name=EXCLUDED.file_name, file_data=EXCLUDED.file_data, file_size=EXCLUDED.file_size, uploaded_at=NOW()`,
      [bsCode, fileName, buf, buf.length]
    );
  } catch(e) {
    if (!e.message.includes('No PostgreSQL')) console.warn('[excel] DB save failed:', e.message);
  }

  enrichQueue.push({ bsCode, buf });
  processEnrichQueue();
  res.json({ status: 'queued', bsCode, sizeBytes: buf.length });
});

// ── Apply enrichment results from Python ──────────────────────────────────────
router.post('/excel/:bsCode/enrich', requirePublishToken, (req, res) => {
  const { bsCode } = req.params;
  const { deckNames = {}, injectionLog = {} } = req.body;

  const cached = snapshot.load();
  if (!cached) return res.status(404).json({ error: 'No snapshot available' });

  try {
    const parsed = JSON.parse(cached.payload);
    const flatIndex = parsed.flat_index || {};
    let enriched = 0;

    for (const [svcCode, deckName] of Object.entries(deckNames)) {
      const svc = flatIndex[svcCode];
      if (svc) {
        if (!svc.business_scenario_naming) svc.business_scenario_naming = {};
        svc.business_scenario_naming[bsCode] = deckName;
        enriched++;
      }
    }

    const syncModule = require('./sync');
    parsed.flat_index = flatIndex;
    parsed.business_scenarios = syncModule.buildHierarchy(flatIndex);
    snapshot.save({ ...cached, payload: JSON.stringify(parsed), lastUpdated: new Date().toISOString() });

    const logPath = path.join(__dirname, '..', 'data', 'injection-log.json');
    let existingLog = {};
    try { existingLog = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) {}
    existingLog.generatedAt = new Date().toISOString();
    existingLog.details = existingLog.details || {};
    existingLog.details[bsCode] = { enriched, ...injectionLog };
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(existingLog, null, 2));

    console.log('[M1.achieved]: excel-enrich published — bs_processed=1 enriched_services=' + enriched);
    res.json({ status: 'enriched', bsCode, enrichedServices: enriched });
  } catch(e) {
    console.error('[enrich] ' + bsCode + ': ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/excel/:bsCode', (req, res) => {
  const filePath = path.join(EXCEL_DIR, req.params.bsCode + '.xlsx');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found: ' + req.params.bsCode });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + req.params.bsCode + '.xlsx"');
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
