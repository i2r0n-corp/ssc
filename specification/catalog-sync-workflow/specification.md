# Specification: catalog-sync-workflow

> **Guidelines**: Read [guidelines-n8n-workflow.md](../guidelines-n8n-workflow.md) before executing ANY tasks below. Follow all constraints described there throughout execution.

## Basic Setup

- [ ] Read `product-requirements-document.md` and `intent.md` for full context
- [ ] Run `setup-solution` skill to create `solution.yaml` (if not already present) and `asset.yaml` for this workflow at `assets/workflows/catalog-sync-workflow/asset.yaml`

---

## Overview

This solution uses **three separate n8n workflows**, each with a distinct trigger and responsibility. All three share the same CAP backend as the data store and communicate with the SSC Catalog API using OAuth tokens fetched at runtime.

| Workflow file | Trigger | Responsibility |
|---|---|---|
| `full-build-workflow.n8n.json` | Webhook (manual, one-time) | Full catalog download + enrichment from pre-staged Excels + publish |
| `daily-check-workflow.n8n.json` | Schedule: daily 02:00 Europe/Berlin | Check for modified Business Scenarios → incremental update + re-enrich changed BS |
| `excel-enrich-workflow.n8n.json` | Webhook (manual, on-demand) | Re-run enrichment from pre-staged Excels only — no API calls, no BS structure changes |

All three write to the same CAP backend `publishSnapshot` endpoint when they produce an updated catalog.

---

## Shared: OAuth Token Fetch (sub-flow pattern)

All three workflows begin with the same token fetch. Implement it as the first nodes in each workflow (n8n does not support sub-workflows in this setup, so duplicate the pattern):

- [ ] Add an **HTTP Request** node **"Fetch OAuth Token"**: `POST` to `{{ $env.SSC_AUTH_URL }}` with body `grant_type=client_credentials&client_id={{ $env.SSC_CLIENT_ID }}&client_secret={{ $env.SSC_CLIENT_SECRET }}` (`application/x-www-form-urlencoded`). Output: `access_token`.
- [ ] Add a **Set** node: store `access_token` in workflow data for downstream nodes to reference as `{{ $('Fetch OAuth Token').item.json.access_token }}`

---

## Shared: Pre-staged Excel Files

Excel mapping files (e.g. `MAX00001.xlsx`) are NOT downloaded automatically by the n8n workflows. Downloading them from SharePoint requires authenticated access to the SAP Microsoft 365 tenant, which n8n does not have natively.

### Recommended approach: Power Automate bridge

The recommended way to keep Excel files up to date automatically is a small **Power Automate flow** running in the SAP M365 tenant. Power Automate can access SharePoint natively using the employee's M365 identity — no app registration or IT admin involvement needed.

The flow should:
1. **Trigger**: on a schedule (e.g. daily, shortly before the n8n daily check at 02:00 CET) — OR on a SharePoint file-change event (when a BS Excel file is updated in the SharePoint library)
2. **For each Excel file** in the BS mappings SharePoint folder (or for a specific file that changed):
   - Read the file binary content from SharePoint (`Get file content` action)
   - Send a `PUT` HTTP request to `{{ CAP_BACKEND_URL }}/api/catalog/excel/{{ bsCode }}` with:
     - Body: the raw file binary
     - Header `Authorization: Bearer {{ CAP_PUBLISH_TOKEN }}`
     - Header `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
3. **On completion**: optionally call the n8n Excel Enrichment webhook (`POST /webhook/catalog-excel-enrich`) to trigger immediate re-enrichment

This bridge runs entirely within the SAP M365 tenant, requires no new infrastructure, and fully automates the Excel staging step.

### Manual fallback (phase 1 / initial setup)

Until the Power Automate bridge is built, Excel files can be staged manually:
- Upload each file via `PUT {{ CAP_BACKEND_URL }}/api/catalog/excel/{{ bsCode }}` (e.g. using Postman or curl)
- Then call the Excel Enrichment webhook to trigger re-enrichment

- [ ] Add a **Sticky Note** node at the top of each workflow canvas documenting:
  ```
  Excel mapping files (MAX00001.xlsx, etc.) must be staged in the CAP backend before enrichment runs.

  RECOMMENDED: Use the Power Automate bridge (see spec) to sync files automatically from SharePoint.

  Power Automate bridge flow:
    Trigger: SharePoint file-change event on BS mappings library (preferred) OR daily schedule
    Step 1: GET changed Excel file from SharePoint
    Step 2: PUT <CAP_BACKEND_URL>/api/catalog/excel/<BS_CODE>  (Authorization: Bearer <CAP_PUBLISH_TOKEN>)
    Step 3: POST <N8N_URL>/webhook/catalog-excel-enrich  body: { "bsCode": "<BS_CODE>" }
    → n8n re-enriches ONLY that BS and republishes the data product automatically.

  MANUAL FALLBACK:
    PUT <CAP_BACKEND_URL>/api/catalog/excel/<BS_CODE>  (upload file)
    POST <N8N_URL>/webhook/catalog-excel-enrich  body: { "bsCode": "<BS_CODE>" }
    Omit bsCode to re-enrich ALL staged Business Scenarios (slower, use sparingly).

  MS Graph API direct integration can replace the Power Automate bridge in a future phase.
  ```

---

## Workflow 1: Full Build (`full-build-workflow.n8n.json`)

**Trigger**: Manual webhook — call once during initial setup. Should not be needed again unless a complete rebuild is required.

- [ ] Add a **Webhook** node **"Full Build Trigger"**: `POST /webhook/catalog-full-build`; `responseMode: onReceived`; responds immediately with `{ "status": "started", "mode": "full-build" }` (fire-and-forget)
- [ ] Fetch OAuth Token (see Shared pattern above)
- [ ] Add a **Set** node: initialise `currentPage = 0`, `allServices = []`

### Paginated Catalog Download

- [ ] Add a **Loop Over Items** node **"Paginate Catalog"**:
  - [ ] Inside loop: **HTTP Request** node **"Fetch Catalog Page"** — `GET {{ $env.SSC_CATALOG_BASE_URL }}/{{ $env.SSC_SITE_ID }}/services` with query params:
    - `facets`: comma-joined engagement type filter: `engagementType:Max Success Plan,engagementType:Advanced Success Plan,engagementType:Enterprise Support,engagementType:Embedded Launch Activities,engagementType:Cloud Prepackaged Services`
    - `pageSize`: `100`
    - `currentPage`: `{{ $json.currentPage }}`
    - Header `Authorization`: `Bearer {{ $('Fetch OAuth Token').item.json.access_token }}`
  - [ ] Inside loop: **Code** node **"Accumulate Page"** — append `data.services` to running `allServices` array; check `currentPage < totalPages - 1`; if true increment `currentPage` and feed back to loop; if false exit loop

### Extra Services

- [ ] Add a **Code** node **"Extra Service Codes"**: define a hardcoded array of extra service codes (e.g. `["000000000050167308"]`) and output one item per code
- [ ] Add a **Loop Over Items** node **"Fetch Extra Services"**:
  - [ ] Inside loop: **HTTP Request** node — `GET {{ $env.SSC_CATALOG_BASE_URL }}/{{ $env.SSC_SITE_ID }}/scservices/{{ $json.code }}` with `fields=FULL`; Authorization header as above
  - [ ] Merge extra service responses into `allServices`

### Build Flat Index + Hierarchy

- [ ] Add a **Code** node **"Build Flat Index"**: key all services by `code` into a flat object `flatIndex`
- [ ] Add a **Code** node **"Build Hierarchy"**: build `businessScenarios` tree (BS → modules → childServices) from `flatIndex`; log `BS count`, `module count`, `service count`

### Enrichment from Pre-staged Excels

- [ ] Add a **Code** node **"Enumerate Business Scenarios"**: produce one item per Business Scenario code found in `flatIndex` where `serviceObject === 'Business Scenario'`
- [ ] Add a **Loop Over Items** node **"Enrich BS from Excel"**:
  - [ ] Inside loop: **HTTP Request** node **"Fetch Excel File"** — `GET {{ $env.CAP_BACKEND_URL }}/api/catalog/excel/{{ $json.bsCode }}`; if 404 → skip this BS (no Excel staged yet); if 200 → binary Excel content
  - [ ] Inside loop: **Code** node **"Parse Excel & Apply Enrichment"** — parse the Excel binary using a JS Excel parser (use `xlsx` library available in n8n Code nodes); apply the three-priority matching strategy (CRM ID → catalog name → deck name); inject `business_scenario_naming` onto child services in `flatIndex`; apply module membership injection (add service codes to module `childServices` based on `business_module` column); log enriched service count per BS

### Publish

- [ ] Add a **Code** node **"Assemble Payload"**: build the final `master_data` object with `last_full_build`, `last_updated`, `business_scenarios`, `flat_index`
- [ ] Add an **HTTP Request** node **"Publish Data Product"** — `PUT {{ $env.CAP_BACKEND_URL }}/api/catalog/publishSnapshot`; body: the assembled JSON; Header `Authorization: Bearer {{ $env.CAP_PUBLISH_TOKEN }}`; `Content-Type: application/json`
- [ ] Add an **IF** node: check response status `2xx`
  - **Success branch**: **Set** node — log `M1.achieved: catalog data product published (full build) — service_count={{ $json.serviceCount }} timestamp={{ $now }}`
  - **Error branch**: **Set** node — log `M1.missed: full build publish failed — error={{ $json.error }}`

---

## Workflow 2: Daily Check & Incremental Update (`daily-check-workflow.n8n.json`)

**Trigger**: Schedule — daily at 02:00 Europe/Berlin (cron: `0 2 * * *` with timezone set to `Europe/Berlin`).

- [ ] Add a **Schedule Trigger** node **"Daily 02:00 CET"**: interval `Custom (Cron)`, expression `0 2 * * *`, timezone `Europe/Berlin`
- [ ] Fetch OAuth Token (see Shared pattern above)

### Lightweight Fetch of Business Scenario modifiedTime

- [ ] Add a **Set** node: initialise `currentPage = 0`, `bsList = []`
- [ ] Add a **Loop Over Items** node **"Paginate BS Lightweight"**:
  - [ ] Inside loop: **HTTP Request** node **"Fetch BS Page (lightweight)"** — same endpoint as full build but with `fields=services(code,name,serviceObject,modifiedTime),pagination`; engagement type facets as above; `pageSize=100`; `currentPage={{ $json.currentPage }}`
  - [ ] Inside loop: **Code** node — accumulate only items where `serviceObject === 'Business Scenario'`; check pagination; loop or exit

### Compare with Cached Snapshot

- [ ] Add an **HTTP Request** node **"Load Cached Snapshot"** — `GET {{ $env.CAP_BACKEND_URL }}/api/catalog/getSnapshot`; returns `{ lastUpdated, payload }` (JSON)
- [ ] Add a **Code** node **"Detect Changed BS"**: for each BS from the API lightweight fetch, compare `modifiedTime` against the same BS in the cached `flatIndex`; collect `changedBsCodes` (new or stale); output one item per changed BS code
- [ ] Add an **IF** node: `changedBsCodes.length > 0`?
  - **No changes branch**: **Set** node — log `"Daily check: no Business Scenario changes detected. Snapshot is up to date."` → end workflow
  - **Changes branch**: continue to incremental update

### Incremental Update (changed BS only)

- [ ] Add a **Loop Over Items** node **"Refresh Changed BS"**:
  - [ ] Inside loop: **HTTP Request** node **"Fetch Full BS"** — `GET {{ $env.SSC_CATALOG_BASE_URL }}/{{ $env.SSC_SITE_ID }}/scservices/{{ $json.bsCode }}`; `fields=FULL`
  - [ ] Inside loop: **Loop Over Items** subloop **"Fetch Modules"**: for each `childService` code in the BS response, fetch the full module object; for each module, fetch all its child service objects
  - [ ] Inside loop: **Code** node **"Patch Flat Index"** — update `flatIndex` entries for the BS, its modules, and all child services with the freshly fetched data

### Re-enrich Changed BS from Excel

- [ ] Add a **Loop Over Items** node **"Re-enrich Changed BS"**:
  - [ ] Inside loop: **HTTP Request** node **"Fetch Excel for Changed BS"** — `GET {{ $env.CAP_BACKEND_URL }}/api/catalog/excel/{{ $json.bsCode }}`; if 404 → skip (log warning: no Excel staged for this BS); if 200 → continue
  - [ ] Inside loop: **Code** node **"Parse Excel & Patch Enrichment"** — same Excel parsing + three-priority matching logic as in full build; IMPORTANT: **clear existing `business_scenario_naming[bsCode]` entries and existing module `childServices` injections from this BS before re-applying** — ensures removed services are no longer linked
  - [ ] Log: `"Re-enriched BS {{ $json.bsCode }}: {{ $json.matchedCount }} services matched, {{ $json.injectedCount }} module memberships updated"`

### Rebuild Hierarchy + Publish

- [ ] Add a **Code** node **"Rebuild Hierarchy"**: regenerate `businessScenarios` tree from the updated `flatIndex`
- [ ] Add a **Code** node **"Assemble Incremental Payload"**: build updated `master_data` with `last_updated = now`, preserving `last_full_build` from the existing snapshot
- [ ] Add an **HTTP Request** node **"Publish Updated Snapshot"** — same as full build publish endpoint
- [ ] Add an **IF** node: check response `2xx`
  - **Success**: log `M1.achieved: catalog incremental update published — changed_bs={{ changedCount }} updated_services={{ serviceCount }}`
  - **Error**: log `M1.missed: incremental update publish failed — error={{ error }}`

---

## Workflow 3: Excel-Only Enrichment (`excel-enrich-workflow.n8n.json`)

**Trigger**: Webhook — called automatically by the **Power Automate bridge** whenever an Excel mapping file changes in SharePoint. Can also be called manually for a forced re-enrichment.

**Design principle**: The webhook accepts an optional `bsCode` in the request body. If provided, only that specific Business Scenario is re-enriched (targeted update — fast). If omitted, all Business Scenarios with a staged Excel are re-enriched (full re-enrich — use sparingly).

This means the **Power Automate bridge is the primary trigger** for this workflow. When a BS Excel file changes in SharePoint, Power Automate:
1. Pushes the updated file to `PUT {{ CAP_BACKEND_URL }}/api/catalog/excel/{{ bsCode }}`
2. Calls `POST {{ N8N_URL }}/webhook/catalog-excel-enrich` with body `{ "bsCode": "MAX00001" }`

The n8n workflow then re-enriches only that BS and publishes the updated snapshot — keeping the data product consistent with the latest Excel without touching any other part of the catalog.

- [ ] Add a **Webhook** node **"Excel Enrich Trigger"**: `POST /webhook/catalog-excel-enrich`; `responseMode: onReceived`; responds immediately with `{ "status": "started", "mode": "excel-enrich", "bsCode": "{{ $json.body.bsCode ?? 'all' }}" }` (fire-and-forget)
- [ ] Add a **Code** node **"Resolve Target BS"**: read `$json.body.bsCode` from the webhook payload; if present output `{ "mode": "single", "bsCode": "<value>" }`; if absent output `{ "mode": "all" }`
- [ ] Add an **HTTP Request** node **"Load Cached Snapshot"** — `GET {{ $env.CAP_BACKEND_URL }}/api/catalog/getSnapshot`
- [ ] Add an **IF** node: is snapshot available?
  - **No snapshot**: **Set** node — log `"Excel enrich skipped — no snapshot found. Run full build first."` → end
  - **Snapshot available**: continue

### Re-enrich Target Business Scenario(s)

- [ ] Add an **IF** node **"Single or All?"**: check `mode === 'single'`
  - **Single BS branch**: output one item `{ "bsCode": "<value>" }`
  - **All BS branch**: **Code** node **"Enumerate All BS"** — extract all BS codes from `flatIndex` where `serviceObject === 'Business Scenario'`; output one item per BS code

- [ ] Add a **Loop Over Items** node **"Enrich Target BS from Excel"** (handles both single and all cases):
  - [ ] Inside loop: **HTTP Request** node **"Fetch Updated Excel"** — `GET {{ $env.CAP_BACKEND_URL }}/api/catalog/excel/{{ $json.bsCode }}`
    - If **404** → **Set** node — log `"Warning: no Excel staged for {{ $json.bsCode }} — skipping enrichment for this BS"` → continue loop (do NOT fail the workflow)
    - If **200** → continue to parse
  - [ ] Inside loop: **Code** node **"Parse & Apply Enrichment"**:
    - Parse the Excel binary (using `xlsx` library)
    - **IMPORTANT — clear before reapply**: remove all existing `business_scenario_naming[bsCode]` entries from child services of this BS; remove all module `childServices` injections that originated from this BS's Excel
    - Reapply three-priority matching (CRM ID → catalog name → deck name) and module membership injection from the fresh Excel data
    - Log: `"BS {{ bsCode }}: {{ matchedCount }} services matched, {{ injectedCount }} module memberships updated, {{ removedCount }} stale entries removed"`

- [ ] Add a **Code** node **"Rebuild Hierarchy"**: regenerate the full `businessScenarios` tree from the updated `flatIndex`
- [ ] Add a **Code** node **"Assemble Payload"**: preserve `last_full_build` from cached snapshot; set `last_updated = now`; include updated `flat_index` and `business_scenarios`
- [ ] Add an **HTTP Request** node **"Publish Updated Snapshot"** — same `PUT {{ $env.CAP_BACKEND_URL }}/api/catalog/publishSnapshot` endpoint as other workflows
- [ ] Add an **IF** node: check response `2xx`
  - **Success**: log `M1.achieved: catalog excel-enrich published — bs_processed={{ n }} stale_entries_removed={{ removedCount }}`
  - **Error**: log `M1.missed: excel-enrich publish failed — error={{ error }}`

---

## CAP Backend: Excel File Store Endpoints

The CAP backend must also expose these endpoints (add to `catalog-cap-backend` spec):

- [ ] `PUT /api/catalog/excel/:bsCode` — store a raw `.xlsx` binary uploaded by an admin; store to configured path (`EXCEL_STORE_PATH` env var)
- [ ] `GET /api/catalog/excel/:bsCode` — return the stored `.xlsx` binary for a given BS code; return 404 if not found

---

## Credentials and Environment Variables

- [ ] Add a **Sticky Note** node to each workflow listing all required env vars:
  - `SSC_CLIENT_ID` — OAuth client ID for SSC Catalog API
  - `SSC_CLIENT_SECRET` — OAuth client secret for SSC Catalog API
  - `SSC_AUTH_URL` — OAuth token endpoint
  - `SSC_CATALOG_BASE_URL` — SSC Catalog API base URL
  - `SSC_SITE_ID` — Catalog site ID (default: `servicescatalog`)
  - `CAP_BACKEND_URL` — CAP backend base URL
  - `CAP_PUBLISH_TOKEN` — bearer token for `publishSnapshot` (set as n8n credential, not plain env var)
- [ ] No `"credentials"` blocks in workflow JSON — assigned manually in n8n UI post-import
- [ ] No hardcoded secrets anywhere in workflow JSON

---

## Workflow Files

- [ ] Write `assets/workflows/catalog-sync-workflow/full-build-workflow.n8n.json`
- [ ] Write `assets/workflows/catalog-sync-workflow/daily-check-workflow.n8n.json`
- [ ] Write `assets/workflows/catalog-sync-workflow/excel-enrich-workflow.n8n.json`
- [ ] Validate each workflow JSON is well-formed using `n8n-mcp__validate-n8n-workflow`; fix all errors and warnings before writing
- [ ] `connections` in all JSON files reference nodes by `name`, not `id`
- [ ] The `asset.yaml` for this workflow group lists all three workflow files and includes webhook `provides.apis[]` entries for the two manual-trigger webhooks

---

## Validation

- [ ] All three workflow JSONs parse without errors
- [ ] Node connections are valid (referenced by name)
- [ ] No hardcoded secrets in any JSON
- [ ] Sticky Notes document env vars in each workflow
- [ ] `asset.yaml` is well-formed and lists all three workflows
- [ ] `solution.yaml` includes this workflow asset
