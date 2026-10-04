# SSC Catalog — Sync & Excel Enrichment Specification

## Overview

The system keeps the service catalog up to date through two independent pipelines that run in parallel:

- **Server-side sync** — fetches data from the SSC API into PostgreSQL
- **Client-side Excel upload** — Windows script uploads Excel files from a local SharePoint-synced folder to the CAP backend, which then enriches the catalog with BS-specific deck naming

---

## Phase 1 — Initial Full Build

**Trigger:** `POST /api/catalog/sync/full` (called automatically on startup if DB is empty, or manually via n8n)

| Step | What happens | Status |
|---|---|---|
| 1 | Fetch all catalog pages from SSC API (paginated, all engagement types) | ✅ Implemented |
| 2 | Fetch `fields=FULL` for each leaf service in batches of 10 | ✅ Implemented |
| 3 | Build `flat_index` in memory | ✅ Implemented |
| 4 | Restore Excel files from `catalog_excel_files.file_data` in DB to local filesystem | ✅ Implemented |
| 5 | Apply Excel enrichment for each BS that has a staged Excel file | ✅ Implemented |
| 6 | Write all services to PostgreSQL (all 6 tables, cleared first) | ✅ Implemented |
| 7 | Parse `serviceTeaserText` of every BS → extract Excel filename → upsert into `catalog_excel_files.file_name` | ✅ Implemented (added Oct 2026) |
| 8 | Write file-based snapshot as fallback | ✅ Implemented |

---

## Phase 2 — Incremental Change Detection

**Trigger:** `POST /api/catalog/sync/incremental` (called by n8n on a schedule, e.g. daily)

**Change signal:** There is no `modifiedTime` field on Business Scenario objects from the SSC API. Change is detected by comparing `serviceTeaserText` of each BS against the value stored in `catalog_services.service_teaser_text` in PostgreSQL.

| Step | What happens | Status |
|---|---|---|
| 1 | Lightweight fetch of all services with `serviceTeaserText` field included | ✅ Implemented (updated Oct 2026 — was missing `serviceTeaserText`) |
| 2 | Load stored teasers from `catalog_services` in DB (fallback: snapshot flat_index) | ✅ Implemented (added Oct 2026) |
| 3 | Compare fresh teaser vs stored teaser per BS. Mark as changed if different or new BS code | ✅ Implemented (added Oct 2026 — replaced `modifiedTime` comparison) |
| 4 | For each changed BS: delete stale `catalog_hierarchy` rows where `parent_code = bsCode` | ✅ Implemented (added Oct 2026) |
| 5 | Fetch full tree: BS → its modules → their child services | ✅ Implemented |
| 6 | Write updated tree to `cachedFlatIndex` in memory | ✅ Implemented |
| 7 | Parse new teaser → extract updated Excel filename → upsert into `catalog_excel_files.file_name` | ✅ Implemented (added Oct 2026) |
| 8 | Re-apply Excel enrichment from staged file if present on disk | ✅ Implemented |
| 9 | Call `publishSnapshot()` — writes to DB and file | ✅ Implemented (added `await` Oct 2026) |

**Note on new BSes:** A BS with no stored teaser (no row in DB) is treated as new and always processed. This handles new Business Scenarios released by SAP automatically.

---

## Phase 3 — Excel Manifest

The manifest is the authoritative list of BSes and their expected Excel filenames. It is stored in `catalog_excel_files` (PostgreSQL) and served via `GET /api/catalog/excel-manifest`.

| Step | What happens | Status |
|---|---|---|
| 1 | `GET /excel-manifest` queries `catalog_excel_files` for `bs_code, file_name, file_size, uploaded_at, processed_at` | ✅ Implemented (fixed Oct 2026 — was 404 on CF due to local file dependency) |
| 2 | Filenames are populated during full sync (Phase 1 step 7) and incremental sync (Phase 2 step 7) from teaser parsing | ✅ Implemented (added Oct 2026) |
| 3 | `PUT /excel-manifest` upserts `bs_code + file_name` rows (no file_data) — used by seed script | ✅ Implemented (updated Oct 2026 — was file-only) |
| 4 | Manifest survives CF restart (data is in PostgreSQL, not local filesystem) | ✅ Implemented (fixed Oct 2026) |

---

## Phase 4 — Windows Excel Upload Script

**Script:** `assets/catalog-cap-backend/scripts/sync_manifest_to_sharepoint.py`  
**Schedule:** Hourly via Windows Task Scheduler  
**Local folder:** `C:\Users\I306380\SAP SE\Max Success Plan - Service list - release 2608\`

| Step | What happens | Status |
|---|---|---|
| 1 | Check `/health` to detect CF restart — force full re-upload if app restarted since last sync | ✅ Implemented |
| 2 | Skip run if less than 60 minutes since last check (unless force re-upload) | ✅ Implemented |
| 3 | `GET /excel-manifest` — fetch BS list with expected filenames | ✅ Working (fixed Oct 2026) |
| 4 | For each entry: check if local file exists in SharePoint folder | ✅ Implemented |
| 5 | Compare file `mtime` vs `lastCheck` timestamp — skip if not modified | ✅ Implemented |
| 6 | `PUT /excel/:bsCode` — upload file bytes with `X-Filename` header | ✅ Implemented |
| 7 | Server saves `file_data`, `file_name`, `file_size`, `uploaded_at` to `catalog_excel_files` | ✅ Implemented (updated Oct 2026 — now saves file_name too) |
| 8 | Server queues enrichment asynchronously | ✅ Implemented |

---

## Phase 5 — Excel Enrichment Queue

**Triggered by:** `PUT /excel/:bsCode` (upload from Windows script)

| Step | What happens | Status |
|---|---|---|
| 1 | Excel file bytes pushed onto `enrichQueue` | ✅ Implemented |
| 2 | `processEnrichQueue()` runs serially (one BS at a time to avoid memory spikes) | ✅ Implemented |
| 3 | Load current snapshot, run `applyExcelEnrichment()` — parse Excel, match service codes, inject `business_scenario_naming` | ✅ Implemented |
| 4 | Rebuild hierarchy, save snapshot | ✅ Implemented |
| 5 | Stamp `processed_at = NOW()` in `catalog_excel_files` after successful enrichment | ✅ Implemented (added Oct 2026 — was missing) |
| 6 | Write injection log to `data/injection-log.json` | ✅ Implemented |

---

## Phase 6 — CF Restart Recovery

| Step | What happens | Status |
|---|---|---|
| 1 | On startup, check if DB has a valid snapshot (>100 services) | ✅ Implemented |
| 2 | If yes: restore Excel files from `catalog_excel_files.file_data` to local filesystem | ✅ Implemented |
| 3 | If no (empty DB after fresh deploy): trigger `POST /sync/full` automatically | ✅ Implemented |
| 4 | Windows script detects restart via `appStartTime` from `/health` → forces full re-upload | ✅ Implemented |

---

## Data Flow Diagram (text)

```
SSC API
  └─► POST /sync/full or /sync/incremental
        ├─► catalog_services (all fields including service_teaser_text)
        ├─► catalog_hierarchy
        ├─► catalog_classification
        ├─► catalog_supercategories
        ├─► catalog_bs_naming
        ├─► catalog_sync
        └─► catalog_excel_files (file_name only, from teaser parsing)

Local SharePoint folder (Windows)
  └─► sync_manifest_to_sharepoint.py (hourly)
        ├─► GET /excel-manifest → reads catalog_excel_files
        └─► PUT /excel/:bsCode → catalog_excel_files (file_data + processed_at)
              └─► enrichQueue → applyExcelEnrichment → catalog_bs_naming (via snapshot)
```

---

## Known Remaining Considerations

- **MAX00019 has two Excel files** in the SharePoint folder. Only one `file_name` can be stored per `bs_code`. The teaser will point to one specific file — whichever SAP links in the teaser wins.
- **`processEnrichQueue` reads from file snapshot**, not PostgreSQL directly. In DB-only mode the snapshot has no `payload` field, so the queue would fail. The `excel/upload` direct route already guards against this. The queue (`PUT /excel/:bsCode`) still assumes a file snapshot is present.
- **Injection log** (`data/injection-log.json`) is written to the ephemeral CF filesystem. It is useful for debugging but does not survive restarts. The `catalog_injection_log` table exists in DB schema but is not currently written to.
