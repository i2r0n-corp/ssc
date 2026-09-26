# Specification: catalog-intelligence-agent

> **Guidelines**: Read all applicable guidelines before executing ANY tasks below:
> - [guidelines.md](../guidelines.md) — Universal execution rules
> - [guidelines-agent.md](../guidelines-agent.md) — Universal agent patterns
> - [guidelines-agent-python.md](../guidelines-agent-python.md) — Python implementation details
> - [guidelines-agent-skills.md](../guidelines-agent-skills.md) — Runtime skills patterns
> - [guidelines-agent-mcp.md](../guidelines-agent-mcp.md) — MCP integration patterns

---

## Data Dependencies

- Data Product: `master_data.json` — centrally published catalog data product served by the CAP backend
  - Runtime access: via CAP backend REST endpoint (env var: `CAP_BACKEND_URL`)
  - The agent reads catalog data by calling a custom MCP tool exposed by the CAP backend (see MCP Tool Integration below)
  - No DPQuery ORD ID exists for this custom internal data product; access is via a custom MCP server created from the CAP backend OpenAPI spec

---

## Basic Setup

- [ ] Read `product-requirements-document.md` and `intent.md` for full context
- [ ] Bootstrap agent code in `assets/catalog-intelligence-agent/` using instructions from the `sap-agent-bootstrap` skill (invoke from inside `assets/catalog-intelligence-agent/`, use copy commands — do NOT create files manually)
- [ ] Install dependencies; validate agent starts and responds at `/.well-known/agent.json`
- [ ] Run `setup-solution` skill to register this agent asset in `solution.yaml` and create `assets/catalog-intelligence-agent/asset.yaml`

---

## Runtime Skills

The agent requires two runtime skills because they involve complex domain-specific logic that would bloat the system prompt:

- [ ] Create `assets/catalog-intelligence-agent/app/skills/incident-analysis/SKILL.md`:
  - **Purpose**: Step-by-step instructions for parsing uploaded incident files (CSV/Excel/text), extracting pain-point keywords, matching them against catalog service names and descriptions, and ranking results by relevance.
  - Include decision criteria for handling malformed files, empty matches, and low-confidence matches.
  - Include an `examples/` folder with a sample incident CSV structure.

- [ ] Create `assets/catalog-intelligence-agent/app/skills/pptx-export/SKILL.md`:
  - **Purpose**: Instructions for interpreting a user's service selection and template choice, validating the selection (min 1, max 50 services), calling the `generate_pptx` MCP tool, and returning the download link.
  - Document the two template options: `short-description` (one summary slide for all selected services) and `one-pager` (one slide per service).
  - Include validation rules: reject if no services selected; warn if more than 50 selected.

---

## Project-Specific Tasks

### System Prompt

- [ ] Open `assets/catalog-intelligence-agent/app/agent.py` and update the `@prompt_section` body (`get_system_prompt`) to include:

  ```
  You are the SSC Catalog Intelligence Agent. You help Solutioning Leads and Success Plan Managers (SPMs) 
  at SAP Solution Centers quickly find, analyze, and export service information from the SSC Services Catalog.

  IMPORTANT: You MUST use MCP tools to retrieve all catalog data. Never fabricate, guess, or invent 
  service names, descriptions, engagement types, or business scenarios. Relay tool errors verbatim.

  You have access to the following tools:
  - query_catalog: search the catalog using natural language or structured filters (engagement type, 
    business scenario, module, service attributes)
  - filter_catalog: apply multi-attribute filters simultaneously to return matching services
  - analyze_incidents: parse an uploaded incident file and return ranked service recommendations
  - generate_pptx: generate a downloadable PowerPoint file from a list of selected service codes

  When a user asks about services, always clarify the engagement type if not specified.
  When generating a PPTX, ask which template the user wants: "short-description" or "one-pager".
  When calling tools that support pagination, set page size to a maximum of 100.

  To perform incident analysis, load the skill: skills/incident-analysis/SKILL.md
  To perform PPTX export, load the skill: skills/pptx-export/SKILL.md
  ```

### Tool: query_catalog

- [ ] Implement `query_catalog` tool in `assets/catalog-intelligence-agent/app/tools/query_catalog.py`:
  - **Input**: `query` (str) — natural-language search string; optional `engagement_type` (str), optional `business_scenario` (str), optional `module` (str)
  - **Logic**: Call the catalog MCP tool to search the flat_index and business_scenarios tree; match against service `name`, `shortDescription`, `longDescription`, and `businessScenarioNaming` fields; return matched services ranked by relevance
  - **Output**: list of services with `code`, `name`, `shortDescription`, `engagementType`, `businessScenario`, `module`
  - **Guardrail**: if catalog returns empty, return `"No services found matching your query."` — never invent services

### Tool: filter_catalog

- [ ] Implement `filter_catalog` tool in `assets/catalog-intelligence-agent/app/tools/filter_catalog.py`:
  - **Input**: `engagement_type` (str, optional), `business_scenario` (str, optional), `module` (str, optional), `attributes` (dict, optional — any other service attribute key-value pairs)
  - **Logic**: Call the catalog MCP tool to retrieve the catalog tree; apply intersection of all provided filters; return matching services
  - **Output**: list of services matching all specified filters; include count
  - **Guardrail**: if no filters provided, return a helpful message asking the user to specify at least one filter

### Tool: analyze_incidents

- [ ] Implement `analyze_incidents` tool in `assets/catalog-intelligence-agent/app/tools/analyze_incidents.py`:
  - **Input**: `file_content` (str — text content of the uploaded file), `file_type` (str — `csv`, `xlsx`, or `txt`), optional `engagement_type` (str — limit recommendations to a specific engagement type)
  - **Logic**: Load and follow `skills/incident-analysis/SKILL.md`; parse the file content; extract pain-point keywords and themes; query the catalog for matching services; rank results by relevance to the incidents
  - **Output**: ranked list of recommended services, each with: `code`, `name`, `shortDescription`, `relevance_rationale` (1–2 sentences explaining why this service matches)
  - **Guardrail**: file size limit — reject content over 1 MB; only accept csv, xlsx, txt types

### Tool: generate_pptx

- [ ] Implement `generate_pptx` tool in `assets/catalog-intelligence-agent/app/tools/generate_pptx.py`:
  - **Input**: `service_codes` (list[str] — list of catalog service codes to include), `template` (str — `short-description` or `one-pager`)
  - **Logic**: Load and follow `skills/pptx-export/SKILL.md`; validate inputs (1–50 service codes, valid template name); call the CAP backend `generate_pptx` MCP tool with the service codes and template choice; return the download URL
  - **Output**: `{ "download_url": "<url>", "filename": "<name>.pptx", "service_count": n }`
  - **Guardrail**: reject requests with 0 services or more than 50 services; reject unknown template names

---

## MCP Tool Integration

The agent communicates with the CAP backend (catalog data + PPTX generation) via a custom MCP server generated from the CAP backend's OpenAPI spec.

- [ ] After the CAP backend is implemented and its OpenAPI spec is generated, save the spec to `specification/catalog-intelligence-agent/api-specs/cap-backend.json`
- [ ] Invoke the `mcp-translation-file` skill on the saved spec to generate the MCP translation card
- [ ] Invoke the `setup-solution` skill to register the MCP server asset (e.g. `cap-backend-mcp-server`)
- [ ] Read the generated `asset.yaml` for the MCP server asset and copy the exact `ordId` value
- [ ] Add the MCP server dependency to `assets/catalog-intelligence-agent/asset.yaml` under `requires`:
  ```yaml
  requires:
    - name: cap-backend-mcp-server
      kind: mcp-server
      ordId: <exact ordId from generated asset.yaml>
  ```
- [ ] Wire MCP tool loading in `app/agent.py` using `get_mcp_tools()` from the `mcp_tools` module — never import directly from `sap_cloud_sdk.agentgateway`
- [ ] Generate `mcp-mock.json` using the `mcp-mock-config` skill after MCP translation is complete (required before tests run)

---

## Business Instrumentation

- [ ] Implement structured logging and OpenTelemetry spans for all five milestones from the PRD:

  | Milestone | Achievement log | Miss log |
  |-----------|----------------|----------|
  | M2: Agent answers basic catalog queries | `M2.achieved: catalog query resolved — query="{query}" result_count={n}` | `M2.missed: catalog query returned empty or errored — query="{query}" error="{error}"` |
  | M3: Incident analysis working | `M3.achieved: incident analysis completed — file="{filename}" matches_found={n}` | `M3.missed: incident analysis failed or returned no matches — file="{filename}" error="{error}"` |
  | M4: PPTX export functional | `M4.achieved: PPTX generated — template="{template_name}" service_count={n} file_size_kb={size}` | `M4.missed: PPTX generation failed — template="{template_name}" error="{error}"` |
  | M5: Multi-user access confirmed | `M5.achieved: multi-user access validated — concurrent_users={n}` | `M5.missed: multi-user access test failed — concurrent_users={n} error="{error}"` |

- [ ] Extract all business logic from `stream()` into a plain async helper method `_run_agent()` to avoid `GeneratorExit` context errors when wrapping spans around generators
- [ ] Add OpenTelemetry spans using `@tracer.start_as_current_span` on regular async methods; use context manager form only inside non-generator async functions
- [ ] Verify `bootstrap(app)` is called after `app = server.build()` in `main.py`

---

## Validation Checklist

- [ ] `grep -r "M2.achieved\|M3.achieved\|M4.achieved" assets/catalog-intelligence-agent/app/` — must return results
- [ ] `grep -r "sap_cloud_sdk.agent_decorators" assets/catalog-intelligence-agent/app/` — must return results
- [ ] `grep -c "^@agent_model\|^@agent_config\|^@prompt_section" assets/catalog-intelligence-agent/app/agent.py` — must return 9
- [ ] `ls assets/catalog-intelligence-agent/test_report.json` — must exist

---

## Testing

- [ ] `conftest.py` only sets `IBD_TESTING=true`
- [ ] Write unit tests in `assets/catalog-intelligence-agent/tests/`:
  - [ ] `test_query_catalog.py` — test keyword matching, engagement type filter, empty result handling
  - [ ] `test_filter_catalog.py` — test single filter, multi-filter intersection, no-filter guardrail
  - [ ] `test_analyze_incidents.py` — test CSV parsing, service matching, file-too-large guardrail, unsupported file type
  - [ ] `test_generate_pptx.py` — test valid short-description export, valid one-pager export, too-many-services guardrail, unknown template guardrail
- [ ] Run each test immediately after writing it
- [ ] Write one integration test: end-to-end flow — user uploads incident file → agent analyzes → user selects services → agent triggers PPTX export → returns download URL (all external calls mocked)
- [ ] Run `pytest` from `assets/catalog-intelligence-agent/` (no args) — coverage ≥ 70%
- [ ] Verify `test_report.json` exists; if not, run `pytest` again (no args)
