# Specification

> **Guidelines**: Read [guidelines.md](./guidelines.md) before executing ANY tasks below.

Check off items as completed.

---

## Solution Setup

- [x] Create asset directories:
  ```bash
  mkdir -p assets/workflows/catalog-sync-workflow \
            assets/catalog-intelligence-agent \
            assets/catalog-cap-backend \
            assets/catalog-ui
  ```
- [x] Invoke `setup-solution` skill to create `solution.yaml` and `asset.yaml` files for every asset
- [x] Validate all `asset.yaml` and `solution.yaml` files exist and are well-formed

---

## Asset Implementation

Execute each asset specification in the order listed. The CAP backend must be implemented first because its OpenAPI spec is consumed by the MCP translation for the agent.

- [x] **Execute specification/catalog-cap-backend/specification.md** (all items)
  - Implements the central data store, catalog API, and PPTX generation backend
  - Exports OpenAPI spec to `specification/catalog-intelligence-agent/api-specs/cap-backend.json`

- [x] **Execute specification/catalog-sync-workflow/specification.md** (all items)
  - Implements the n8n catalog sync, enrichment, and data product publish workflow
  - Uses the CAP backend `publishSnapshot` endpoint

- [x] **Execute specification/catalog-intelligence-agent/specification.md** (all items)
  - Implements the AI agent with catalog query, incident analysis, and PPTX export tools
  - Depends on the CAP backend OpenAPI spec (from the CAP backend step above) for MCP translation
  - Depends on `mcp-translation-file` skill and `setup-solution` for MCP server registration

- [x] **Execute specification/catalog-ui/specification.md** (all items)
  - Implements the React + SAP UI5 Web Components visual interface
  - Depends on the CAP backend and agent being available at their configured URLs

---

## Excel File Staging — Power Automate Bridge

Excel Business Scenario mapping files (e.g. `MAX00001.xlsx`) must be present in the CAP backend's Excel file store before any enrichment workflow can run. The recommended approach is a **Power Automate flow** in the SAP M365 tenant:

| Step | Power Automate action |
|------|-----------------------|
| 1. Trigger | Schedule (daily, ~01:30 CET) OR SharePoint file-change event on the BS mappings library |
| 2. List files | `List folder` action on the SharePoint folder containing BS Excel files |
| 3. For each file | `Get file content` → extract BS code from filename (e.g. `MAX00001`) |
| 4. Push to CAP | `HTTP` action: `PUT {{ CAP_BACKEND_URL }}/api/catalog/excel/{{ bsCode }}` with file binary and `Authorization: Bearer {{ CAP_PUBLISH_TOKEN }}` |
| 5. Trigger enrichment | `HTTP` action: `POST {{ N8N_URL }}/webhook/catalog-excel-enrich` with body `{ "bsCode": "MAX00001" }` — targets only the changed BS, not a full re-enrich |

**Why Power Automate:** it accesses SharePoint using the SAP employee's M365 identity — no app registration or IT admin involvement required. This bridge lives entirely in the SAP M365 tenant and does not require any changes to the n8n or CAP backend deployment.

**Targeted enrichment:** the `bsCode` parameter in the webhook body tells the n8n workflow to re-enrich only that specific Business Scenario. This means a single changed Excel file triggers a fast, surgical update to the data product — stale service entries are removed and new ones are added, without touching the rest of the catalog.

**Phase 1 manual fallback:** upload a file via `PUT /api/catalog/excel/:bsCode`, then call `POST /webhook/catalog-excel-enrich` with `{ "bsCode": "<code>" }` manually.

---

## Cross-Implementation Compatibility Check

Run after all four assets are implemented:

- [x] **Data contract**: verified — flat_index + business_scenarios in sync.js payload match what catalog.js and the agent consume
- [x] **Auth alignment**: verified — CAP_PUBLISH_TOKEN checked in both sync routes and catalog routes
- [x] **MCP tool names**: verified — 12 tools in translation.json, agent uses dynamic get_mcp_tools() loading
- [x] **PPTX download flow**: download URL returned as `/api/pptx/download/:fileId`; UI constructs full URL with CAP_BACKEND_URL prefix
- [x] **Agent API URL**: UI uses REACT_APP_AGENT_BASE_URL env var; agent exposes `/.well-known/agent.json` (confirmed by server tests)
- [x] **Env var inventory**: all env vars cross-referenced and documented in spec environment variables table

---

## Asset Summary

| Asset | Type | Path | Purpose |
|-------|------|------|---------|
| `catalog-cap-backend` | CAP Node.js | `assets/catalog-cap-backend/` | Catalog data store, search API, PPTX generation |
| `catalog-sync-workflow` | n8n Workflow (×3) | `assets/workflows/catalog-sync-workflow/` | Full build (webhook), daily incremental check (schedule 02:00 CET), Excel-only enrichment (webhook) |
| `catalog-intelligence-agent` | Python AI Agent (A2A) | `assets/catalog-intelligence-agent/` | NL queries, incident analysis, PPTX export tools |
| `catalog-ui` | React + SAP UI5 | `assets/catalog-ui/` | Visual browsing, filtering, file upload, PPTX download |

---

## Environment Variables Reference

| Variable | Used by | Description |
|----------|---------|-------------|
| `SSC_CLIENT_ID` | n8n Workflow | OAuth client ID for SSC Catalog API |
| `SSC_CLIENT_SECRET` | n8n Workflow | OAuth client secret for SSC Catalog API |
| `SSC_AUTH_URL` | n8n Workflow | OAuth token endpoint URL |
| `SSC_CATALOG_BASE_URL` | n8n Workflow | SSC Catalog API base URL |
| `SSC_SITE_ID` | n8n Workflow | Catalog site ID (default: `servicescatalog`) |
| `EXCEL_STORE_PATH` | CAP Backend | File system path for pre-staged Excel mapping files |
| `CAP_BACKEND_URL` | n8n Workflow, Agent | CAP backend base URL |
| `CAP_PUBLISH_TOKEN` | n8n Workflow → CAP Backend | Static bearer token for snapshot publish |
| `PORT` | CAP Backend | HTTP port (default: 4004) |
| `REACT_APP_CAP_BACKEND_URL` | UI | CAP backend URL for catalog and PPTX APIs |
| `REACT_APP_AGENT_BASE_URL` | UI | AI agent API base URL |
