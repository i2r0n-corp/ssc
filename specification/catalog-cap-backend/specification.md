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

## Data Model

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
