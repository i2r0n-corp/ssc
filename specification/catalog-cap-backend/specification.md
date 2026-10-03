# Specification: catalog-cap-backend

> **Guidelines**: Read [guidelines.md](../guidelines.md) — Universal execution rules.

This CAP (Cloud Application Programming Model) backend serves the enriched catalog data product to both the AI agent and the UI. It also handles PowerPoint file generation.

---

## Basic Setup

- [x] Read `product-requirements-document.md` and `intent.md` for full context
- [x] Run `setup-solution` skill to register this asset in `solution.yaml` and create `assets/catalog-cap-backend/asset.yaml`
- [x] Scaffold a new CAP Node.js project in `assets/catalog-cap-backend/`
- [x] Add required dependencies (express, pptxgenjs, xlsx, multer, uuid)

---

## ⚠️ CRITICAL RULE — NEVER SUGGEST FULL REBUILD IF POSTGRESQL HAS DATA

**PostgreSQL is the permanent store. All service data including `classificationFeatures` and `supercategories` comes from the SSC API and is stored in PostgreSQL during the initial full build.**

- On every restart → app loads from PostgreSQL → ready instantly, NO rebuild needed
- Full rebuild is needed ONLY when PostgreSQL is completely empty (first-time setup)
- Excel enrichment (deck names, module injections) runs periodically via local Python script → uploads to backend → stored in PostgreSQL → no rebuild needed
- **NEVER suggest a full rebuild because filters are broken, supercategories are missing, or enrichment is empty — fix the bug in code instead**
- Before suggesting any sync or rebuild, read this rule and ask: "Is PostgreSQL empty?" If not — the fix is in code, not a rebuild.

---

## ⚠️ CRITICAL RULE — SSC API Field Fetching

**ALWAYS fetch ALL fields from the SSC Catalog API.** Never use partial field sets.

The SSC Catalog paginated endpoint (`/services`) must ALWAYS request all required fields explicitly. The default response omits `classificationFeatures`, `supercategories`, `summary`, `businessNeeds`, `keyBenefits`, `deliveryApproach`, `description`, `serviceTeaserText` and other rich fields.

**Required `fields` parameter for all paginated fetches:**
```
services(code,name,serviceObject,serviceNumber,shortDescription,summary,engagementType,
childServices,parentCode,classificationFeatures,supercategories,businessScenarioNaming,
serviceTeaserText,description,keyBenefits,deliveryApproach,businessNeeds,modifiedTime),pagination
```

**Why this matters:**
- `classificationFeatures` contains `engagementType`, `sapActivateProjectPhase`, `effortEstimateDays`, `crmBaseCategory` — needed for all UI filters
- `supercategories` contains product category assignments — needed for supercategory filter
- `summary`, `keyBenefits`, `description` — needed for tooltip/alt text and PPTX generation
- Fetching without these fields causes filters to silently return 0 results

**Rule:** If you ever touch `fetchAllCatalogPages` or any function that calls the SSC paginated API — verify the `fields` parameter includes ALL fields listed above. No exceptions.

---

## ⚠️ PENDING MIGRATION — PostgreSQL Persistent Storage

**Current state (BROKEN):** All catalog data is stored in `data/snapshot.json` on the CF container ephemeral filesystem. This file is lost on every app restart, causing:
- Full rebuild from scratch on every restart (~3-5 min downtime)
- OOM crashes during enrichment (17.6MB JSON in memory)
- Excel files lost on restart (re-upload required every time)
- `classificationFeatures` and `supercategories` missing from snapshot (paginated API returns incomplete data)

**Required migration: PostgreSQL (`postgresql-db` service, trial plan)**

### PostgreSQL Schema

```sql
-- Sync metadata
CREATE TABLE catalog_sync (
  id              SERIAL PRIMARY KEY,
  last_full_build TIMESTAMPTZ,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  service_count   INTEGER,
  status          TEXT  -- 'completed' | 'running' | 'failed'
);

-- All service objects: Business Scenarios, Modules, and Leaf Services
CREATE TABLE catalog_services (
  code                TEXT PRIMARY KEY,
  service_number      TEXT,
  name                TEXT NOT NULL,
  service_object      TEXT NOT NULL,  -- 'Business Scenario' | 'Business Scenario module' | leaf
  short_description   TEXT,
  summary             TEXT,           -- HTML
  description         TEXT,           -- HTML
  service_teaser_text TEXT,           -- HTML
  business_needs      TEXT,           -- HTML
  key_benefits        TEXT,           -- HTML
  delivery_approach   TEXT,           -- HTML
  engagement_type     TEXT,           -- top-level ET string from API
  parent_code         TEXT,
  modified_time       TEXT,
  approval_status     TEXT,
  booking_method      JSONB,
  contacts            JSONB,
  sc_keywords         JSONB,
  raw_data            JSONB NOT NULL  -- full API response, future-proof
);
CREATE INDEX idx_services_service_object   ON catalog_services(service_object);
CREATE INDEX idx_services_engagement_type  ON catalog_services(engagement_type);
CREATE INDEX idx_services_parent_code      ON catalog_services(parent_code);

-- BS→Module and Module→Service relationships
-- source distinguishes API-sourced vs Excel-injected relationships
CREATE TABLE catalog_hierarchy (
  parent_code  TEXT NOT NULL REFERENCES catalog_services(code),
  child_code   TEXT NOT NULL REFERENCES catalog_services(code),
  position     INTEGER,
  source       TEXT NOT NULL DEFAULT 'api',  -- 'api' | 'excel_injection'
  bs_code      TEXT REFERENCES catalog_services(code),  -- BS that caused Excel injection
  PRIMARY KEY (parent_code, child_code)
);
CREATE INDEX idx_hierarchy_parent ON catalog_hierarchy(parent_code);
CREATE INDEX idx_hierarchy_child  ON catalog_hierarchy(child_code);

-- classificationFeatures array — one row per service × key × value
-- Keys: engagementType, sapActivateProjectPhase, effortEstimateDays, crmBaseCategory, delivery
CREATE TABLE catalog_classification (
  service_code  TEXT NOT NULL REFERENCES catalog_services(code),
  feature_key   TEXT NOT NULL,
  feature_value TEXT NOT NULL,
  PRIMARY KEY (service_code, feature_key, feature_value)
);
CREATE INDEX idx_classification_key_val ON catalog_classification(feature_key, feature_value);
CREATE INDEX idx_classification_service ON catalog_classification(service_code);

-- supercategories array — one row per service × category
CREATE TABLE catalog_supercategories (
  service_code         TEXT NOT NULL REFERENCES catalog_services(code),
  category_code        TEXT NOT NULL,
  category_name        TEXT NOT NULL,
  parent_category_name TEXT,
  PRIMARY KEY (service_code, category_code)
);
CREATE INDEX idx_supercat_name    ON catalog_supercategories(category_name);
CREATE INDEX idx_supercat_service ON catalog_supercategories(service_code);

-- Excel enrichment results — deck name per service per BS
-- deck_name = col 0 carry-forward from Excel (e.g. "Going live support")
-- engagement_layer = col H from Excel ("Foundational" | "Advanced" | "Max Success Plan")
-- match_method = how service was matched ('code' | 'svcNum' | 'paddedCode' | 'catalogName')
CREATE TABLE catalog_bs_naming (
  service_code     TEXT NOT NULL REFERENCES catalog_services(code),
  bs_code          TEXT NOT NULL REFERENCES catalog_services(code),
  deck_name        TEXT NOT NULL,
  engagement_layer TEXT,
  match_method     TEXT,
  PRIMARY KEY (service_code, bs_code)
);
CREATE INDEX idx_bs_naming_bs      ON catalog_bs_naming(bs_code);
CREATE INDEX idx_bs_naming_service ON catalog_bs_naming(service_code);

-- Excel files stored in DB — replaces ephemeral filesystem
-- file_data = raw .xlsx binary (BYTEA)
CREATE TABLE catalog_excel_files (
  bs_code         TEXT PRIMARY KEY REFERENCES catalog_services(code),
  file_name       TEXT,
  file_data       BYTEA NOT NULL,
  file_size       INTEGER,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  matched_count   INTEGER,
  unmatched_count INTEGER,
  injected_count  INTEGER
);

-- Injection log per BS enrichment run
CREATE TABLE catalog_injection_log (
  bs_code        TEXT PRIMARY KEY REFERENCES catalog_services(code),
  generated_at   TIMESTAMPTZ DEFAULT NOW(),
  matched        INTEGER,
  unmatched      INTEGER,
  injected       INTEGER,
  already_linked INTEGER,
  unresolved_mod INTEGER,
  unresolved_svc INTEGER,
  log_rows       JSONB  -- full row-level detail (too granular for relational)
);
```

### Dependencies Summary

```
catalog_hierarchy.parent_code      → catalog_services.code
catalog_hierarchy.child_code       → catalog_services.code
catalog_hierarchy.bs_code          → catalog_services.code
catalog_classification.service_code → catalog_services.code
catalog_supercategories.service_code → catalog_services.code
catalog_bs_naming.service_code     → catalog_services.code
catalog_bs_naming.bs_code          → catalog_services.code
catalog_excel_files.bs_code        → catalog_services.code
catalog_injection_log.bs_code      → catalog_services.code
```

### Full Build Flow (post-migration)

```
1. SSC API paginated fetch → basic service list (code, name, serviceObject, hierarchy)
2. For each service → fetch ?fields=FULL individually (batches of 20, ~5 min total)
   → stores classificationFeatures → catalog_classification
   → stores supercategories → catalog_supercategories
   → stores all text fields → catalog_services
3. Hierarchy → catalog_hierarchy (source='api')
4. Excel enrichment → catalog_bs_naming + catalog_hierarchy (source='excel_injection')
5. Update catalog_sync metadata
```

### On Restart (post-migration)

```
1. Connect to PostgreSQL
2. Check catalog_sync.service_count — if > 100, skip rebuild entirely
3. Serve all queries directly from PostgreSQL — no JSON parsing, no memory issues
```

### Implementation Steps (TODO)

- [ ] Create PostgreSQL service instance: `cf create-service postgresql-db trial ssc-catalog-db`
- [ ] Bind to app: `cf bind-service ssc-catalog-cap-backend ssc-catalog-db`
- [ ] Add `pg` npm dependency
- [ ] Implement `store/db.js` — connection pool, schema init on first connect
- [ ] Rewrite `store/snapshot.js` to use PostgreSQL instead of file
- [ ] Update `routes/catalog.js` — all filters run as SQL queries
- [ ] Update `routes/sync.js` — full build writes to PostgreSQL, reads Excel from `catalog_excel_files`
- [ ] Update `assets/catalog-cap-backend/manifest.yml` — remove `EXCEL_STORE_PATH`, add DB binding
- [ ] Update Python sync script — `appStartTime` check still works, no other changes needed

---

## Data Model (Legacy — to be replaced by PostgreSQL schema above)

- [ ] Define `db/schema.cds`:
  - Entity `CatalogSnapshot`:
    - `key id`: `UUID`
    - `lastFullBuild`: `Timestamp`
    - `lastUpdated`: `Timestamp`
    - `version`: `Integer`
    - `payload`: `LargeString` (JSON blob containing the full `master_data.json` content)
  - This is a single-row table — each publish overwrites the current snapshot (or inserts a new version)

---

## Services

### Catalog Service (Internal — for agent and UI)

- [ ] Define `srv/catalog-service.cds`:
  - Service `CatalogService` exposed at `/api/catalog`
  - Action `getSnapshot()` returns `{ lastUpdated: Timestamp, payload: LargeString }` — returns the latest catalog snapshot
  - Action `publishSnapshot(payload: LargeString, lastFullBuild: Timestamp)` — stores a new catalog snapshot (called by n8n workflow only; protect with a bearer token header check)
  - Function `searchServices(query: String, engagementType: String, businessScenario: String, module: String)` returns array — filters and returns matching services from the cached snapshot payload
  - Function `filterServices(engagementType: String, businessScenario: String, module: String)` returns array — applies multi-attribute intersection filter

- [ ] Implement `srv/catalog-service.js`:
  - `getSnapshot`: read the latest row from `CatalogSnapshot`; parse `payload` JSON and return
  - `publishSnapshot`: validate bearer token (env var `CAP_PUBLISH_TOKEN`); upsert snapshot row; log `M1.achieved: catalog data product published — service_count={n}`
  - `searchServices`: load snapshot; implement keyword matching against `name`, `shortDescription`, `longDescription`, and `business_scenario_naming` fields; return ranked matches (max 100)
  - `filterServices`: load snapshot; apply intersection of non-null filter parameters; return matching services

### PPTX Service (Internal — for agent and UI)

- [ ] Define `srv/pptx-service.cds`:
  - Service `PptxService` exposed at `/api/pptx`
  - Action `generatePptx(serviceCodes: array of String, template: String)` returns `{ downloadUrl: String, filename: String, serviceCount: Integer }`

- [ ] Implement `srv/pptx-service.js` using `pptxgenjs`:
  - Validate inputs: `serviceCodes` must have 1–50 entries; `template` must be `short-description` or `one-pager`
  - Load service details for each code from the catalog snapshot
  - **Template: `short-description`**:
    - Slide 1: title slide with "Proposed Services" and date
    - Slide 2+: one row per service — service name, short description, engagement type, module (table layout)
  - **Template: `one-pager`**:
    - One slide per service containing: service name (heading), short description (body), long description (detail), engagement type, module, business scenario, service code
  - Save generated file to a temp location; return a download URL pointing to a `GET /api/pptx/download/:fileId` endpoint
  - Emit `M4.achieved: PPTX generated — template="{template}" service_count={n} file_size_kb={size}` on success
  - Emit `M4.missed: PPTX generation failed — template="{template}" error="{error}"` on failure

- [ ] Implement `GET /api/pptx/download/:fileId` endpoint: stream the generated PPTX file as a binary download with `Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation` and appropriate `Content-Disposition` header

---

## Excel File Store

The n8n workflows cannot download Excel files from SharePoint automatically — SharePoint access requires M365 authentication that n8n does not have natively. Instead, the CAP backend acts as a simple file store: Excel files are pushed into it externally and the workflows read them from there.

**How files get into the store — recommended approach: Power Automate bridge**

A Power Automate flow running in the SAP M365 tenant handles the SharePoint-to-CAP transfer automatically:
- Trigger: daily schedule (before the 02:00 CET n8n daily check) or on SharePoint file-change event
- Action: for each BS Excel file in the SharePoint library → `PUT {{ CAP_BACKEND_URL }}/api/catalog/excel/{{ bsCode }}` with the file binary and `Authorization: Bearer {{ CAP_PUBLISH_TOKEN }}`
- Optional: after all files are pushed, call `POST {{ N8N_URL }}/webhook/catalog-excel-enrich` to trigger immediate re-enrichment in n8n

Power Automate uses the SAP employee's M365 identity — no app registration or IT admin involvement required.

**Manual fallback (phase 1):** upload files directly via `PUT /api/catalog/excel/:bsCode` (curl, Postman, or any HTTP client). Then call the Excel Enrichment webhook manually.

- [ ] Add `EXCEL_STORE_PATH` env var — file system path where Excel files are stored (e.g. `/tmp/excel-store` for dev, a mounted persistent volume for production)
- [ ] Implement `PUT /api/catalog/excel/:bsCode` endpoint:
  - Accepts `multipart/form-data` or raw binary body with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - Validates `bsCode` matches pattern `MAX[0-9]{5}` (or equivalent BS code format)
  - Saves to `{EXCEL_STORE_PATH}/{bsCode}.xlsx` (overwrite if exists)
  - Returns `{ "status": "stored", "bsCode": "<code>", "sizeBytes": n }`
  - Protected by the same `CAP_PUBLISH_TOKEN` bearer token check as `publishSnapshot`
- [ ] Implement `GET /api/catalog/excel/:bsCode` endpoint:
  - Reads `{EXCEL_STORE_PATH}/{bsCode}.xlsx`
  - Returns the raw `.xlsx` binary with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - Returns `404` with `{ "error": "Excel file not found for bsCode: <code>" }` if not staged
  - No auth required (workflows call this internally)
- [ ] Implement `GET /api/catalog/excel` (list): returns an array of all staged BS codes (scans `EXCEL_STORE_PATH` for `*.xlsx` files)

---

## OpenAPI Spec Export

- [ ] After all service endpoints are implemented, generate the OpenAPI 3.0 spec:
  ```bash
  cds compile srv/ --to openapi > specification/catalog-intelligence-agent/api-specs/cap-backend.json
  ```
- [ ] Verify the spec includes all endpoints: `publishSnapshot`, `searchServices`, `filterServices`, `generatePptx`, `GET /api/pptx/download/:fileId`, `PUT /api/catalog/excel/:bsCode`, `GET /api/catalog/excel/:bsCode`, `GET /api/catalog/excel`
- [ ] This spec is used by the `mcp-translation-file` skill to generate the MCP server for the agent

---

## Security

- [ ] `publishSnapshot` is protected by a static bearer token (`CAP_PUBLISH_TOKEN` env var) — n8n workflow must pass this token when publishing
- [ ] All other endpoints are protected by the platform's standard authentication (handled at deployment; no custom auth code required in CAP service)
- [ ] Incident file uploads are handled in-memory by the agent — the CAP backend does NOT store incident files

---

## Environment Variables

- [ ] Document all required environment variables in `assets/catalog-cap-backend/README-env.md` (not a .env file):
  - `CAP_PUBLISH_TOKEN` — static bearer token authorizing snapshot publish calls from n8n
  - `PORT` — HTTP port (default: 4004)

---

## PPTX Templates (Placeholder)

- [ ] Create `assets/catalog-cap-backend/templates/` folder
- [ ] Create `assets/catalog-cap-backend/templates/short-description-template-notes.md` documenting the placeholder layout for the short-description template
- [ ] Create `assets/catalog-cap-backend/templates/one-pager-template-notes.md` documenting the placeholder layout for the one-pager template
- [ ] Note in both files: "Replace with official SAP-branded template files before production rollout"

---

## Validation

- [ ] `cds build` completes without errors
- [ ] `cds run` starts the server on the configured port
- [ ] `GET /api/catalog/getSnapshot` returns the stored snapshot (or empty if none published yet)
- [ ] `POST /api/catalog/publishSnapshot` stores the snapshot and rejects requests without the correct bearer token
- [ ] `POST /api/pptx/generatePptx` returns a valid PPTX download URL for a test service code list
- [ ] `GET /api/pptx/download/:fileId` serves the generated PPTX file
- [ ] OpenAPI spec file exists at `specification/catalog-intelligence-agent/api-specs/cap-backend.json`
