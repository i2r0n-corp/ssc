/**
 * SSC Catalog Intelligence — CAP Backend
 * Serves: catalog snapshot, search/filter APIs, Excel file store, PPTX generation
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const passport = require('passport');
const { XssecPassportStrategy } = require('@sap/xssec');

const app = express();

// CORS — allow requests from any origin (UI hosted on different domain)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'], limit: '20mb' }));

// XSUAA auth — only active when bound to CF (VCAP_SERVICES present)
if (process.env.VCAP_SERVICES) {
  const vcap = JSON.parse(process.env.VCAP_SERVICES);
  const xsuaaCredentials = (vcap['xsuaa'] || vcap['user-provided'] || [])[0]?.credentials;
if (xsuaaCredentials) {
    const { XssecPassportStrategy, createService } = require('@sap/xssec');
    const service = createService(xsuaaCredentials);
    passport.use('JWT', new XssecPassportStrategy(service));
    app.use(passport.initialize());
    app.use('/api', passport.authenticate('JWT', { session: false }));
  }
}

// Mount routers
app.use('/api/catalog', require('./routes/catalog'));
app.use('/api/catalog/sync', require('./routes/sync'));
app.use('/api/pptx', require('./routes/pptx'));
app.use('/api/agent', require('./routes/agent'));

// Health probe
const APP_START_TIME = new Date().toISOString();
app.get('/health', (req, res) => {
  const snapshot = require('./store/snapshot');
  const data = snapshot.load();
  res.json({ status: 'ok', snapshotAvailable: !!data, serviceCount: data ? data.serviceCount : 0, appStartTime: APP_START_TIME });
});

// ── Auto-sync on startup ──────────────────────────────────────────────────────
// If snapshot is missing (e.g. after CF restart), trigger full sync + manifest build automatically.
async function startupSync() {
  const snapshot = require('./store/snapshot');

  // Try to load from PostgreSQL first
  const existing = await snapshot.loadAsync();
  if (existing && existing.serviceCount > 100) {
    console.log(`[startup] Snapshot available (${existing.serviceCount} services) — skipping auto-sync.`);
    // Restore Excel files from PostgreSQL to filesystem
    await _restoreExcelFiles();
    return;
  }

  if (!process.env.SSC_AUTH_URL || !process.env.SSC_CLIENT_ID || !process.env.SSC_CLIENT_SECRET) {
    console.warn('[startup] SSC credentials not configured — skipping auto-sync.');
    return;
  }
  console.log(`[startup] Snapshot missing or incomplete — triggering full sync automatically...`);
  try {
    const http = require('http');
    const port = process.env.PORT || 4004;
    // Small delay to ensure server is fully listening
    await new Promise(r => setTimeout(r, 3000));
    const syncHeaders = { 'Content-Type': 'application/json', 'Content-Length': 0 };
    if (process.env.CAP_PUBLISH_TOKEN) syncHeaders['Authorization'] = `Bearer ${process.env.CAP_PUBLISH_TOKEN}`;
    const req = http.request({ hostname: 'localhost', port, path: '/api/catalog/sync/full', method: 'POST',
      headers: syncHeaders
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d);
          console.log(`[startup] Auto-sync completed — ${result.serviceCount} services loaded.`);
          buildManifestOnStartup();
        } catch(e) { console.error('[startup] Auto-sync response parse error:', e.message); }
      });
    });
    req.on('error', e => console.error('[startup] Auto-sync failed:', e.message));
    req.end();
  } catch(e) {
    console.error('[startup] Auto-sync error:', e.message);
  }
}

function buildManifestOnStartup() {
  const snapshot = require('./store/snapshot');
  const fs = require('fs');
  const path = require('path');
  try {
    const data = snapshot.load();
    if (!data) return;
    const payload = JSON.parse(data.payload);
    const flatIndex = payload.flat_index || {};
    const entriesMap = new Map(); // deduplicate by bsCode
    for (const [code, svc] of Object.entries(flatIndex)) {
      if (svc.serviceObject !== 'Business Scenario') continue;
      if (entriesMap.has(code)) continue; // already processed this BS
      const text = svc.serviceTeaserText || svc.serviceMainContentText || svc.description || '';
      const idx = text.toLowerCase().indexOf('entitlements service list');
      if (idx === -1) continue;
      const section = text.substring(idx, idx + 800);
      const match = section.match(/href="([^"]+\.xlsx[^"]*)"/i);
      if (!match) continue;
      const excelUrl = match[1].replace(/&amp;/g, '&');
      const fileName = decodeURIComponent(excelUrl.split('/').find(p => p.includes('.xlsx')) || '').split('?')[0];
      entriesMap.set(code, { bsCode: code, bsName: svc.name, excelUrl, fileName });
    }
    const entries = Array.from(entriesMap.values());
    const MANIFEST_FILE = process.env.EXCEL_MANIFEST_PATH || path.join(__dirname, 'data', 'excel-manifest.json');
    fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), count: entries.length, entries }, null, 2));
    console.log(`[startup] Excel manifest built — ${entries.length} Business Scenarios.`);
  } catch(e) {
    console.error('[startup] Manifest build error:', e.message);
  }
}

async function _restoreExcelFiles() {
  try {
    const db = require('./store/db');
    db.getPool();
    const res = await db.query(`SELECT bs_code, file_data, file_name FROM catalog_excel_files`);
    if (!res.rows.length) return;
    const EXCEL_DIR = process.env.EXCEL_STORE_PATH || path.join(__dirname, 'data', 'excels');
    fs.mkdirSync(EXCEL_DIR, { recursive: true });
    for (const row of res.rows) {
      fs.writeFileSync(path.join(EXCEL_DIR, `${row.bs_code}.xlsx`), row.file_data);
    }
    console.log(`[startup] Restored ${res.rows.length} Excel files from PostgreSQL.`);
  } catch(e) {
    if (!e.message.includes('No PostgreSQL')) console.warn('[startup] Excel restore failed:', e.message);
  }
}

startupSync();

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 4004;
app.listen(PORT, () => console.log(`catalog-cap-backend listening on port ${PORT}`));

module.exports = app;
