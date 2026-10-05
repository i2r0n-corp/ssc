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
  crm_ids      TEXT
);
CREATE INDEX IF NOT EXISTS idx_mlr_bs_code ON catalog_matching_log_rows(bs_code);
CREATE INDEX IF NOT EXISTS idx_mlr_status  ON catalog_matching_log_rows(status);

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
`;

async function initSchema() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    // One-time migration: drop log_rows JSONB column if it still exists
    await client.query(`ALTER TABLE catalog_injection_log DROP COLUMN IF EXISTS log_rows`);
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

module.exports = { getPool, initSchema, query, transaction };
