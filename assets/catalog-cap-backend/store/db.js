/**
 * PostgreSQL connection pool + schema initialisation.
 * Reads credentials from VCAP_SERVICES (CF) or individual env vars (local dev).
 */

const { Pool } = require('pg');

let _pool = null;

function _getCredentials() {
  // CF: credentials injected via VCAP_SERVICES
  const vcap = process.env.VCAP_SERVICES;
  if (vcap) {
    try {
      const services = JSON.parse(vcap);
      const pgService = (services['postgresql-db'] || services['postgresql'] || [])[0];
      if (pgService && pgService.credentials) {
        const c = pgService.credentials;
        return {
          host:     c.hostname || c.host,
          port:     parseInt(c.port || 5432),
          database: c.dbname || c.name || c.database,
          user:     c.username || c.user,
          password: c.password,
          ssl:      { rejectUnauthorized: false }
        };
      }
    } catch (e) {
      console.error('[db] Failed to parse VCAP_SERVICES:', e.message);
    }
  }
  // Local dev: individual env vars
  if (process.env.PG_HOST) {
    return {
      host:     process.env.PG_HOST,
      port:     parseInt(process.env.PG_PORT || 5432),
      database: process.env.PG_DATABASE,
      user:     process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      ssl:      process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
    };
  }
  return null;
}

function getPool() {
  if (_pool) return _pool;
  const creds = _getCredentials();
  if (!creds) throw new Error('No PostgreSQL credentials found. Set VCAP_SERVICES or PG_* env vars.');
  _pool = new Pool({ ...creds, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  _pool.on('error', (err) => console.error('[db] Pool error:', err.message));
  return _pool;
}

// ── Schema init ───────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS catalog_sync (
  id              SERIAL PRIMARY KEY,
  last_full_build TIMESTAMPTZ,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  service_count   INTEGER,
  status          TEXT
);

CREATE TABLE IF NOT EXISTS catalog_services (
  code                TEXT PRIMARY KEY,
  service_number      TEXT,
  name                TEXT NOT NULL,
  service_object      TEXT NOT NULL,
  short_description   TEXT,
  summary             TEXT,
  description         TEXT,
  service_teaser_text TEXT,
  business_needs      TEXT,
  key_benefits        TEXT,
  delivery_approach   TEXT,
  engagement_type     TEXT,
  parent_code         TEXT,
  modified_time       TEXT,
  approval_status     TEXT,
  booking_method      JSONB,
  contacts            JSONB,
  sc_keywords         JSONB,
  raw_data            JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_services_service_object  ON catalog_services(service_object);
CREATE INDEX IF NOT EXISTS idx_services_engagement_type ON catalog_services(engagement_type);
CREATE INDEX IF NOT EXISTS idx_services_parent_code     ON catalog_services(parent_code);

CREATE TABLE IF NOT EXISTS catalog_hierarchy (
  parent_code  TEXT NOT NULL,
  child_code   TEXT NOT NULL,
  position     INTEGER,
  source       TEXT NOT NULL DEFAULT 'api',
  bs_code      TEXT,
  PRIMARY KEY (parent_code, child_code)
);
CREATE INDEX IF NOT EXISTS idx_hierarchy_parent ON catalog_hierarchy(parent_code);
CREATE INDEX IF NOT EXISTS idx_hierarchy_child  ON catalog_hierarchy(child_code);

CREATE TABLE IF NOT EXISTS catalog_classification (
  service_code  TEXT NOT NULL,
  feature_key   TEXT NOT NULL,
  feature_value TEXT NOT NULL,
  PRIMARY KEY (service_code, feature_key, feature_value)
);
CREATE INDEX IF NOT EXISTS idx_classification_key_val ON catalog_classification(feature_key, feature_value);
CREATE INDEX IF NOT EXISTS idx_classification_service ON catalog_classification(service_code);

CREATE TABLE IF NOT EXISTS catalog_supercategories (
  service_code         TEXT NOT NULL,
  category_code        TEXT NOT NULL,
  category_name        TEXT NOT NULL,
  parent_category_name TEXT,
  PRIMARY KEY (service_code, category_code)
);
CREATE INDEX IF NOT EXISTS idx_supercat_name    ON catalog_supercategories(category_name);
CREATE INDEX IF NOT EXISTS idx_supercat_service ON catalog_supercategories(service_code);

CREATE TABLE IF NOT EXISTS catalog_bs_naming (
  service_code     TEXT NOT NULL,
  bs_code          TEXT NOT NULL,
  deck_name        TEXT NOT NULL,
  engagement_layer TEXT,
  match_method     TEXT,
  PRIMARY KEY (service_code, bs_code)
);
CREATE INDEX IF NOT EXISTS idx_bs_naming_bs      ON catalog_bs_naming(bs_code);
CREATE INDEX IF NOT EXISTS idx_bs_naming_service ON catalog_bs_naming(service_code);

CREATE TABLE IF NOT EXISTS catalog_excel_files (
  bs_code         TEXT PRIMARY KEY,
  file_name       TEXT,
  file_data       BYTEA NOT NULL,
  file_size       INTEGER,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  matched_count   INTEGER,
  unmatched_count INTEGER,
  injected_count  INTEGER
);

CREATE TABLE IF NOT EXISTS catalog_injection_log (
  bs_code        TEXT PRIMARY KEY,
  generated_at   TIMESTAMPTZ DEFAULT NOW(),
  matched        INTEGER,
  unmatched      INTEGER,
  injected       INTEGER,
  already_linked INTEGER,
  unresolved_mod INTEGER,
  unresolved_svc INTEGER,
  log_rows       JSONB
);

CREATE TABLE IF NOT EXISTS catalog_matching_log_rows (
  id           BIGSERIAL PRIMARY KEY,
  bs_code      TEXT NOT NULL REFERENCES catalog_injection_log(bs_code) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,
  service_code TEXT,
  service_name TEXT,
  module_code  TEXT,
  module_name  TEXT,
  deck_name    TEXT,
  crm_ids      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mlr_bs_code ON catalog_matching_log_rows(bs_code);
CREATE INDEX IF NOT EXISTS idx_mlr_status  ON catalog_matching_log_rows(status);

CREATE TABLE IF NOT EXISTS catalog_export_log (
  id             BIGSERIAL PRIMARY KEY,
  logged_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id        TEXT,
  logon_name     TEXT,
  export_type    TEXT NOT NULL,
  service_count  INTEGER,
  filter_bs      TEXT,
  filter_et      TEXT,
  filter_modules TEXT[],
  filter_query   TEXT,
  pptx_title     TEXT,
  pptx_cols      JSONB,
  pptx_stream_mode    TEXT,
  pptx_stream_custom  TEXT,
  pptx_year_from      TEXT,
  pptx_year_to        TEXT,
  pptx_year_borders   BOOLEAN,
  pptx_group_by_et    BOOLEAN,
  pptx_use_deck_name  BOOLEAN,
  pptx_truncate_obj   BOOLEAN,
  pptx_switch_types   BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_export_log_logged_at  ON catalog_export_log(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_log_logon_name ON catalog_export_log(logon_name);

CREATE TABLE IF NOT EXISTS catalog_matching_steps (
  id          BIGSERIAL PRIMARY KEY,
  log_row_id  BIGINT NOT NULL REFERENCES catalog_matching_log_rows(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  excel_value TEXT,
  db_value    TEXT,
  method      TEXT,
  threshold   TEXT,
  result      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msteps_log_row_id ON catalog_matching_steps(log_row_id);

CREATE TABLE IF NOT EXISTS catalog_user_permissions (
  email         TEXT PRIMARY KEY,
  tab_catalog   BOOLEAN NOT NULL DEFAULT true,
  tab_incidents BOOLEAN NOT NULL DEFAULT false,
  tab_chat      BOOLEAN NOT NULL DEFAULT false,
  tab_debug     BOOLEAN NOT NULL DEFAULT false,
  tab_exportlog BOOLEAN NOT NULL DEFAULT false,
  tab_admin     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_visitor_log (
  id           BIGSERIAL PRIMARY KEY,
  logon_name   TEXT NOT NULL,
  page         TEXT,
  session_id   TEXT,
  visited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visitor_log_logon   ON catalog_visitor_log(logon_name);
CREATE INDEX IF NOT EXISTS idx_visitor_log_visited ON catalog_visitor_log(visited_at DESC);

CREATE TABLE IF NOT EXISTS catalog_visitor_last_seen (
  logon_name  TEXT PRIMARY KEY,
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  visit_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS catalog_mcp_requests (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       TEXT NOT NULL DEFAULT 'open',
  closed_at    TIMESTAMPTZ,
  closed_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_requests_email_open
  ON catalog_mcp_requests(email) WHERE status = 'open';
`;

async function initSchema() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    // One-time migration: drop log_rows JSONB column if it still exists
    await client.query(`ALTER TABLE catalog_injection_log DROP COLUMN IF EXISTS log_rows`);
    await client.query(`ALTER TABLE catalog_matching_log_rows ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_title TEXT`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_cols JSONB`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_stream_mode TEXT`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_stream_custom TEXT`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_year_from TEXT`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_year_to TEXT`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_year_borders BOOLEAN`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_group_by_et BOOLEAN`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_use_deck_name BOOLEAN`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_truncate_obj BOOLEAN`);
    await client.query(`ALTER TABLE catalog_export_log ADD COLUMN IF NOT EXISTS pptx_switch_types BOOLEAN`);
    console.log('[db] Schema initialised');
  } finally {
    client.release();
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────

async function query(sql, params = []) {
  return getPool().query(sql, params);
}

async function transaction(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function logExport({ userId, logonName, exportType, serviceCount, filterBs, filterEt, filterModules, filterQuery,
  pptxTitle, pptxCols, pptxStreamMode, pptxStreamCustom, pptxYearFrom, pptxYearTo, pptxYearBorders, pptxGroupByEt, pptxUseDeckName, pptxTruncateObj, pptxSwitchTypes }) {
  try {
    await query(
      `INSERT INTO catalog_export_log
        (user_id, logon_name, export_type, service_count, filter_bs, filter_et, filter_modules, filter_query,
         pptx_title, pptx_cols, pptx_stream_mode, pptx_stream_custom, pptx_year_from, pptx_year_to,
         pptx_year_borders, pptx_group_by_et, pptx_use_deck_name, pptx_truncate_obj, pptx_switch_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [userId || null, logonName || null, exportType, serviceCount || 0,
       filterBs || null, filterEt || null, filterModules || null, filterQuery || null,
       pptxTitle || null, pptxCols ? JSON.stringify(pptxCols) : null,
       pptxStreamMode || null, pptxStreamCustom || null,
       pptxYearFrom || null, pptxYearTo || null,
       pptxYearBorders ?? null, pptxGroupByEt ?? null, pptxUseDeckName ?? null, pptxTruncateObj ?? null, pptxSwitchTypes ?? null]
    );
  } catch (e) {
    console.error('[export-log] Failed to write log entry:', e.message);
  }
}

async function logVisit({ logonName, page, sessionId }) {
  try {
    await query(
      `INSERT INTO catalog_visitor_log (logon_name, page, session_id) VALUES ($1,$2,$3)`,
      [logonName || 'anonymous', page || null, sessionId || null]
    );
    await query(
      `INSERT INTO catalog_visitor_last_seen (logon_name, last_seen, visit_count)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (logon_name) DO UPDATE
         SET last_seen = NOW(), visit_count = catalog_visitor_last_seen.visit_count + 1`,
      [logonName || 'anonymous']
    );
  } catch (e) {
    console.error('[visitor-log] Failed to write visit:', e.message);
  }
}

module.exports = { getPool, initSchema, query, transaction, logExport, logVisit };
