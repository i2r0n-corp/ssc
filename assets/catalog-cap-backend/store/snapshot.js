/**
 * Snapshot store — PostgreSQL-backed with in-memory cache.
 * Falls back to file if PostgreSQL is not configured (local dev without DB).
 */

const fs   = require('fs');
const path = require('path');

let _cache = null;
let _useDb = null; // null = not yet determined

function _hasDbConfig() {
  if (_useDb !== null) return _useDb;
  const vcap = process.env.VCAP_SERVICES;
  if (vcap) {
    try {
      const s = JSON.parse(vcap);
      _useDb = !!(s['postgresql-db'] || s['postgresql']);
      return _useDb;
    } catch(e) {}
  }
  _useDb = !!process.env.PG_HOST;
  return _useDb;
}

// ── File fallback (local dev) ─────────────────────────────────────────────────

function _snapshotFile() {
  return process.env.SNAPSHOT_PATH || path.join(__dirname, '..', 'data', 'snapshot.json');
}

function _loadFile() {
  const file = _snapshotFile();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !data.serviceCount || data.serviceCount < 100) return null;
    return data;
  } catch(e) { return null; }
}

function _saveFile(data) {
  fs.mkdirSync(path.dirname(_snapshotFile()), { recursive: true });
  fs.writeFileSync(_snapshotFile(), JSON.stringify(data), 'utf8');
}

// ── PostgreSQL implementation ─────────────────────────────────────────────────

async function _loadDb() {
  try {
    const db = require('./db');
    const res = await db.query(
      `SELECT last_full_build, last_updated, service_count, status FROM catalog_sync ORDER BY id DESC LIMIT 1`
    );
    if (!res.rows.length || res.rows[0].service_count < 100) return null;
    const row = res.rows[0];
    // Build payload from DB — return metadata only (routes query DB directly)
    return {
      lastFullBuild: row.last_full_build,
      lastUpdated:   row.last_updated,
      serviceCount:  row.service_count,
      status:        row.status,
      _fromDb:       true
    };
  } catch(e) {
    console.error('[snapshot] DB load failed:', e.message);
    return null;
  }
}

async function _saveDb(data) {
  try {
    const db = require('./db');
    await db.query(
      `INSERT INTO catalog_sync (last_full_build, last_updated, service_count, status)
       VALUES ($1, $2, $3, $4)`,
      [data.lastFullBuild, data.lastUpdated, data.serviceCount, data.status || 'completed']
    );
  } catch(e) {
    console.error('[snapshot] DB save failed:', e.message);
    throw e;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * load() — synchronous for backwards compatibility.
 * Returns cached metadata. For DB-backed mode, returns { _fromDb: true, serviceCount, ... }
 * Routes that need actual service data query DB directly.
 */
function load() {
  if (_cache) return _cache;
  if (!_hasDbConfig()) {
    _cache = _loadFile();
    return _cache;
  }
  // For DB mode — return last known cache or null
  // Actual async load happens in loadAsync()
  return _cache;
}

/**
 * loadAsync() — async DB load. Call on startup to prime the cache.
 */
async function loadAsync() {
  if (!_hasDbConfig()) {
    _cache = _loadFile();
    return _cache;
  }
  try {
    const db = require('./db');
    await db.initSchema();
    _cache = await _loadDb();
    if (_cache) {
      console.log(`[snapshot] Loaded from PostgreSQL — ${_cache.serviceCount} services`);
    }
    return _cache;
  } catch(e) {
    console.error('[snapshot] loadAsync failed:', e.message);
    return null;
  }
}

/**
 * save() — saves snapshot metadata.
 * In DB mode: saves metadata to catalog_sync (service data already written to tables by sync.js).
 * In file mode: saves full JSON to disk.
 */
async function saveAsync(data) {
  _cache = data;
  if (!_hasDbConfig()) {
    _saveFile(data);
    return;
  }
  await _saveDb(data);
}

/**
 * save() — synchronous wrapper for backwards compatibility.
 * In DB mode: fires async save and updates cache immediately.
 */
function save(data) {
  _cache = data;
  if (!_hasDbConfig()) {
    _saveFile(data);
    return;
  }
  // Fire async DB save — errors logged but not thrown to preserve sync API
  saveAsync(data).catch(e => console.error('[snapshot] save failed:', e.message));
}

function _reset() {
  _cache = null;
}

module.exports = { load, loadAsync, save, saveAsync, _reset };
