# Product Requirements Document (PRD)

**Title:** SSC Success Plan Catalog Intelligence Agent  
**Date:** 2026-09-25  
**Owner:** Solution Center / SPM Team  
**Solution Category:** n8n Workflow + AI Agent + UI Application (React + SAP UI5 Web Components)

---

## Product Purpose & Value Proposition

**Elevator Pitch:**  
Solutioning Leads and SPMs spend days manually gathering service information from the SSC Services Catalog to assemble success plan positioning slides. This solution eliminates that manual effort by providing a centrally hosted AI agent and visual UI that delivers accurate service recommendations and ready-to-export PowerPoint presentations in minutes — available to the full team without any local setup.

**Business Need:**  
The SSC Services Catalog contains hundreds of services organized into Business Scenarios, modules, and engagement types (Max Success Plan, Advanced Success Plan, Enterprise Support, etc.). Today, finding the right services for a customer engagement requires manually cross-referencing Excel mapping files, the catalog API, and existing JWD tooling. The JWD-based skill is mature but bound to a single user's local environment, making team-wide adoption impossible.

**Expected Value:**  
- Reduce time to assemble service descriptions and positioning slides from days to 2–3 minutes
- Scale self-service catalog access from 1 user to the full team of 10–50 Solutioning Leads and SPMs
- Eliminate local environment dependencies and data update bottlenecks

**Product Objectives (Prioritized):**
1. Enable natural-language catalog queries and intelligent service recommendations for all team members
2. Publish the enriched catalog as a centrally managed, versioned data product decoupled from the agent
3. Generate downloadable PowerPoint positioning slides from selected services (two templates)
4. Allow incident-based service matching via file upload
5. Provide a visual UI for browsing, filtering, and slicing the catalog by service attributes

---

## Business Metrics

| Metric | Baseline | Target | Timeline | Process / Capability | Source |
|--------|----------|--------|----------|----------------------|--------|
| Time to assemble service descriptions and positioning slides for a success plan | Days (large engagements) | 2–3 minutes | — | Success Plan creation & positioning | user |
| Number of Solutioning Leads / SPMs able to self-serve catalog queries and export slides | 1 (single local user) | 10–50 (full team) | — | Success Plan delivery & scalability | user |

---

## User Profiles & Personas

### Primary Persona: Alex — Solutioning Lead, Solution Center

Alex is a 35-year-old Solutioning Lead based in a regional Solution Center. He is responsible for designing and proposing service packages for customer engagements, typically working on 3–5 active opportunities at a time. When a customer engagement is being scoped, Alex needs to identify the right business scenarios and associated services from the SSC catalog, understand what is covered under each engagement type, and present the proposal in a clear PowerPoint deck. Today he spends significant time navigating Excel mapping files, the catalog API, and the JWD tool to find and describe services — a process that can take days for large engagements. Alex is technically proficient but not a developer. He values speed, accuracy, and professional-looking outputs he can share with customers directly.

### Secondary Persona: Priya — SPM, Success Plan Manager

Priya is a 31-year-old Success Plan Manager who manages active success plans for a portfolio of enterprise customers. She is responsible for tracking plan execution, identifying improvement opportunities, and presenting updated service recommendations when customer situations change (e.g., new incidents or evolving priorities). Priya frequently needs to match customer pain points or open incidents to relevant catalog services, and then produce slide content for customer-facing review meetings. She finds the current process frustrating because the data is scattered and the tooling is only available to one colleague.

### Other User Types

- **Administrator** — team member responsible for triggering catalog data refresh (n8n sync workflow) and monitoring data product health.

---

## User Goals & Tasks

### For Alex (Solutioning Lead):

**Goals:**
- Quickly identify all services relevant to a given engagement type or business scenario
- Produce polished PowerPoint positioning slides for customer proposals in minutes, not days
- Slice the catalog by service attributes to build tailored service lists

**Key Tasks:**
- Ask natural-language questions: "Which services are in Max Success Plan for SAP IBP?"
- Filter and browse the catalog by engagement type, business scenario, and module in the UI
- Select a subset of services and download a populated PowerPoint (short-description template)
- Export one-pager slides for each selected service (one-pager template)

### For Priya (SPM):

**Goals:**
- Match customer incidents or pain points to relevant catalog services quickly
- Build updated service recommendations without manual cross-referencing

**Key Tasks:**
- Upload a customer incident file (CSV, Excel, or text) and receive a list of matching catalog services
- Review and refine recommendations via the chat interface
- Download a PowerPoint with the recommended services for the customer review meeting

---

## Product Principles

1. **Data product first**: The catalog is a formally managed, versioned data product. The agent is a consumer — it never modifies or re-generates the data.
2. **Decoupled pipeline and agent**: Catalog updates are independent of agent deployments. Either component can evolve without affecting the other.
3. **Speed over completeness**: A 2-minute answer that is 90% complete is more valuable than a perfect answer that takes 30 minutes to assemble manually.
4. **File upload before API integration**: Phase 1 uses file upload for incident analysis. Live API connectors to SAP incident systems are a deliberate phase 2 decision.
5. **Template-first PPTX**: Placeholder templates are designed to work now; official SAP-branded templates are a drop-in replacement.

---

## Business Context

**Current State:**  
A mature Python script (`sync_catalog.py`) syncs and enriches the SSC Services Catalog from the internal API, producing an enriched `master_data.json` file. A JWD-based skill built on top of this file enables one user to run natural-language queries. However, the data update and enrichment process requires local dependencies (OAuth tokens, Excel files on OneDrive, Python environment), making it impossible for other team members to use the tool independently. Assembling positioning slides still requires manual work even with the JWD skill.

**Strategic Alignment:**  
This solution supports the SSC's goal of scaling customer success delivery across the team without proportional growth in manual effort. It converts a one-person local tool into a shared, hosted platform.

**Success Criteria:**  
See the Business Metrics section above.

---

## Goals and Non-Goals

### Goals (In Scope)

- Publish the enriched SSC Services Catalog as a centrally accessible, versioned data product via an n8n sync workflow
- AI agent that answers natural-language catalog queries and provides service recommendations by engagement type and business scenario
- Customer incident file upload (CSV/Excel/text) with service matching and recommendations
- PowerPoint export in two templates: (1) short service descriptions list, (2) one-pager per selected service
- Visual UI for browsing, filtering, and slicing the catalog by attributes (engagement type, business scenario, module, etc.)
- Multi-user access for 10–50 Solutioning Leads and SPMs, hosted centrally

### Non-Goals (Out of Scope)

- Live API integration with SAP customer incident or CRM systems (deferred to phase 2)
- Official SAP-branded PowerPoint templates (placeholder templates only in phase 1)
- Direct SSC Services Catalog API calls from the agent at runtime (agent reads from the data product only)
- Catalog data editing or authoring within the solution
- User authentication / authorization management (relies on the platform's existing identity layer)

---

## Requirements

### Must-Have Requirements

**R1**: Natural-Language Catalog Query

- **Problem to Solve**: Solutioning Leads cannot quickly find the right services without manually searching the catalog.
- **User Story**: As a Solutioning Lead, I need to ask plain-language questions about the catalog and receive accurate, ranked service recommendations so that I can identify the right services for a customer engagement in seconds.
- **Acceptance Criteria**:
  - Given the data product is available, when I ask "Which services are in Max Success Plan for SAP IBP?", then the agent returns a list of matching services with names and brief descriptions.
  - Given a vague query, when I ask "What services help with data migration?", then the agent returns relevant services across all applicable engagement types.
- **Maps to Objective**: Objective 1
- **Priority Rank**: 1

**R2**: Catalog Data Product Publication (n8n Workflow)

- **Problem to Solve**: The enriched catalog is locked to one user's local environment and cannot be accessed by the rest of the team.
- **User Story**: As an administrator, I need to trigger a catalog sync and enrichment workflow so that the latest enriched catalog is published as a centrally accessible data product available to all users.
- **Acceptance Criteria**:
  - Given the workflow is triggered (on schedule or on demand), when it completes, then the updated `master_data.json` is published as a versioned data product accessible to the agent and the UI.
  - Given the workflow fails, then an alert or error notification is raised so the team knows the data product may be stale.
- **Maps to Objective**: Objective 2
- **Priority Rank**: 2

**R3**: Visual Catalog Browsing and Filtering (UI)

- **Problem to Solve**: Users need to explore and filter the catalog visually without having to type queries.
- **User Story**: As a Solutioning Lead or SPM, I need to browse and filter catalog services by engagement type, business scenario, and module in a visual interface so that I can build tailored service lists for my proposals.
- **Acceptance Criteria**:
  - Given the UI is loaded, when I select "Max Success Plan" as the engagement type filter, then only services belonging to Max Success Plan are displayed.
  - Given filtered results, when I select services and click export, then a PPTX download is initiated.
- **Maps to Objective**: Objectives 1 and 3
- **Priority Rank**: 3

**R4**: PowerPoint Export (Two Templates)

- **Problem to Solve**: Assembling positioning slides manually from service descriptions takes days.
- **User Story**: As a Solutioning Lead or SPM, I need to select catalog services and download a populated PowerPoint file so that I can produce customer-ready positioning slides in minutes.
- **Acceptance Criteria**:
  - Given a selection of services, when I choose the short-description template, then a PPTX file is generated with one slide summarizing the selected services (name + short description per service).
  - Given a selection of services, when I choose the one-pager template, then a PPTX file is generated with one dedicated slide per selected service, populated with all available service attributes.
  - Both templates are downloadable from the UI and triggerable via the agent chat.
- **Maps to Objective**: Objective 3
- **Priority Rank**: 4

**R5**: Customer Incident File Upload and Service Matching

- **Problem to Solve**: SPMs cannot quickly connect customer pain points or incidents to relevant catalog services.
- **User Story**: As an SPM, I need to upload a customer incident file (CSV, Excel, or text) so that the agent analyzes it and recommends relevant catalog services that address the identified issues.
- **Acceptance Criteria**:
  - Given I upload an incident file, when the agent processes it, then it returns a ranked list of recommended services from the catalog with a brief rationale for each match.
  - The agent correctly handles CSV, Excel (.xlsx), and plain-text (.txt) incident files.
- **Maps to Objective**: Objective 4
- **Priority Rank**: 5

**R6**: Catalog Attribute Slicing ("Slice and Dice")

- **Problem to Solve**: Users need to compose service lists by combining multiple attribute filters beyond just engagement type.
- **User Story**: As a Solutioning Lead, I need to filter the catalog simultaneously by multiple attributes (e.g., engagement type + business module + business scenario) so that I can build a precise, tailored service list for a specific customer situation.
- **Acceptance Criteria**:
  - Given the UI, when I apply two or more simultaneous filters, then the results reflect the intersection of all active filters.
  - Given a filtered selection, when I ask the agent "Show me services in Max Success Plan under the EWM module", then the agent respects those constraints in its response.
- **Maps to Objective**: Objective 1
- **Priority Rank**: 6

---

## Solution Architecture

**Architecture Overview:**  
The solution is composed of three decoupled components that share a centrally published data product. The n8n workflow owns data freshness; the AI agent and UI are read-only consumers.

**Key Components:**

- **n8n Workflow (Catalog Data Pipeline)**: Executes catalog sync (SSC API), Excel-based enrichment (Business Scenario name mappings), and publishes the output as a versioned `master_data.json` data product. Runs on schedule or on-demand trigger. Based on the logic in the existing `sync_catalog.py` script.
- **AI Agent (Python, A2A protocol)**: Conversational agent deployed centrally. Reads from the catalog data product. Exposes tools for: NL catalog queries, incident file analysis, PPTX export triggering, and attribute-based filtering. Instrumented with OpenTelemetry for business step observability.
- **CAP Backend**: Serves the catalog data product to both the agent and the UI. Handles PPTX generation (python-pptx or equivalent). Exposes REST endpoints for data access and file download.
- **React + SAP UI5 Web Components UI**: Visual interface for browsing, filtering, service selection, incident file upload, and PPTX download.

**Integration Points:**

- n8n Workflow → CAP Backend (data product write/publish, on workflow completion)
- AI Agent → CAP Backend (catalog read, PPTX generation request)
- UI → CAP Backend (catalog read, file upload, PPTX download)
- UI → AI Agent (chat interface, agent API)

**Deployment Environments:**

- Central hosted deployment on SAP BTP; all 10–50 team members access via browser/chat without local setup.

---

### Agent Extensibility & Instrumentation

**Agent Extensibility:**
The agent is designed with discrete, independently invokable tools, making it straightforward to extend with new capabilities in future phases:
- **Phase 2 extension point**: Replace the incident file upload tool with a live SAP incident system connector (same tool interface, different data source).
- **Phase 2 extension point**: Add a "customer engagement history" tool that pulls prior service usage from CRM.
- The agent's skill/tool layer is decoupled from the LLM reasoning layer — new tools can be registered without modifying core agent logic.

**Business Step Instrumentation:**
All business logic milestones are instrumented with structured log statements following the pattern `[MILESTONE_ID].[achieved|missed]: [description]`. This enables production monitoring of agent behavior and business step completion rates.

---

### Automation & Agent Behaviour

**Automation Level:** Autonomous agent (read-only data access + file generation)

**Actions the system performs without human approval:**
- Querying the catalog data product in response to user questions
- Parsing uploaded incident files and matching against catalog services
- Generating and serving PPTX files from selected services

**Actions that require human review or approval:**
- Triggering the catalog data product sync/refresh workflow (admin-initiated)
- Final selection of services for export (user curates the list before download)

**Model or engine used:** LLM via SAP Generative AI Hub (model selection at deployment time)

**Knowledge & data sources accessed:**
- `master_data.json` data product (catalog): central source of truth for all Business Scenarios, modules, services, engagement types, and enriched metadata. Read-only at agent runtime.
- User-uploaded incident files: processed in-memory per session; not persisted.

**Tools or connectors invoked:**
- `query_catalog` tool: natural-language search and filtering over the catalog data product (read-only)
- `analyze_incidents` tool: parses uploaded incident file and returns service recommendations from catalog (read-only + file parse)
- `generate_pptx` tool: accepts a list of service codes and a template choice; calls CAP backend to generate and return a PPTX file (write: file creation only)
- `filter_catalog` tool: applies multi-attribute filters to the catalog and returns matching services (read-only)

**Guardrails & fail-safes:**
- Agent never modifies the catalog data product — all access is read-only at runtime
- If the data product is unavailable, the agent responds with a clear error and does not hallucinate catalog content
- Incident file size limit enforced (e.g., max 5 MB) to prevent processing abuse
- PPTX generation is capped at a maximum number of services per export to prevent runaway file sizes

---

### Configuration & Data

**Configuration Scope:**  
OAuth credentials for the SSC Services Catalog API are stored securely in the n8n workflow environment (not in the agent). The agent requires only the URL of the published data product endpoint.

**Organisational & Master Data:**
- Catalog data product: sourced from SSC Services Catalog API + Excel BS mapping files
- PPTX templates: two placeholder templates created as part of this project; replaced with official SAP templates in a later phase

**Data Migration & Cutover:**
- Initial full build: n8n workflow performs a full catalog sync on first run to populate the data product
- Subsequent runs: incremental updates (changed Business Scenarios only), mirroring `--update` mode from `sync_catalog.py`

---

## Milestones

### M1: Catalog Data Product Available

- **Description**: The enriched catalog is published as a centrally accessible data product for the first time.
- **Achieved when**: The n8n sync workflow completes successfully and `master_data.json` is accessible via the CAP backend endpoint.
- **Log on achievement**: `M1.achieved: catalog data product published successfully — {service_count} services indexed`
- **Log on miss**: `M1.missed: catalog data product publication failed or endpoint not reachable`

### M2: Agent Answers Basic Catalog Queries

- **Description**: The AI agent can correctly respond to natural-language queries about catalog services.
- **Achieved when**: The agent returns a correct, non-empty service list for a test query (e.g., "Which services are in Max Success Plan for SAP IBP?").
- **Log on achievement**: `M2.achieved: catalog query resolved — query="{query}" result_count={n}`
- **Log on miss**: `M2.missed: catalog query returned empty or errored — query="{query}" error="{error}"`

### M3: Incident Analysis Working

- **Description**: The agent accepts an uploaded incident file and returns service recommendations.
- **Achieved when**: A test incident file (CSV or Excel) is uploaded and the agent returns at least one matched service with a rationale.
- **Log on achievement**: `M3.achieved: incident analysis completed — file="{filename}" matches_found={n}`
- **Log on miss**: `M3.missed: incident analysis failed or returned no matches — file="{filename}" error="{error}"`

### M4: PPTX Export Functional

- **Description**: Users can select services and download a populated PowerPoint file using either template.
- **Achieved when**: Both templates (short-description list and one-pager-per-service) generate a valid, downloadable PPTX file for a test service selection.
- **Log on achievement**: `M4.achieved: PPTX generated — template="{template_name}" service_count={n} file_size_kb={size}`
- **Log on miss**: `M4.missed: PPTX generation failed — template="{template_name}" error="{error}"`

### M5: Multi-User Access Confirmed

- **Description**: The solution is accessible to at least 10 Solutioning Leads / SPMs simultaneously without data access issues.
- **Achieved when**: 10 concurrent test sessions successfully complete catalog queries and PPTX exports from the central deployment.
- **Log on achievement**: `M5.achieved: multi-user access validated — concurrent_users={n}`
- **Log on miss**: `M5.missed: multi-user access test failed — concurrent_users={n} error="{error}"`

---

## Risks, Assumptions, and Dependencies

### Risks

- **Data product staleness**: If the n8n sync workflow fails silently, the agent will answer from stale catalog data. Mitigation: add alerting on workflow failure and surface last-updated timestamp in the UI.
- **PPTX template fidelity**: Placeholder templates are designed for functional correctness, not brand compliance. Official SAP-branded templates must be provided before broad customer-facing rollout.
- **Incident file parsing quality**: The quality of service recommendations from incident analysis depends heavily on the structure and content of the uploaded files. Poorly structured files may produce low-quality matches.

### Assumptions (Validate These)

- The OAuth credentials for the SSC Services Catalog API can be stored securely in the n8n workflow environment.
- The enriched `master_data.json` from `sync_catalog.py` is complete and accurate enough to serve as the sole data source for the agent at runtime.
- Solutioning Leads and SPMs have access to the SAP BTP-hosted deployment via their standard SSO credentials.
- Excel BS mapping files are stable enough to be bundled with the workflow or accessible from a shared location.

### Dependencies

- SSC Services Catalog API: required by the n8n sync workflow for initial and incremental catalog builds.
- Excel Business Scenario mapping files: required for catalog enrichment; must be available to the n8n workflow at runtime.
- SAP Generative AI Hub: required by the AI agent for LLM-based reasoning and NL query processing.
- CAP (Cloud Application Programming Model): required for backend data serving and PPTX generation.

---

## Appendix

### Glossary

- **SSC**: SAP Solution Centers — the organizational units this solution serves.
- **SPM**: Success Plan Manager — role responsible for managing customer success plans.
- **Solutioning Lead**: Role in SAP Solution Centers responsible for designing service proposals for customer engagements.
- **Business Scenario (BS)**: A top-level grouping in the SSC catalog (e.g., MAX00001) that contains modules and child services.
- **Engagement Type**: A category of success plan (e.g., Max Success Plan, Advanced Success Plan, Enterprise Support) that determines which services are available to a customer.
- **master_data.json**: The enriched, pre-cached catalog file produced by the sync/enrichment pipeline and published as the central data product.
- **JWD**: Joule Workshop Desktop — the local tool where the predecessor skill was built and is currently running for a single user.
- **PPTX**: PowerPoint file format used for customer-facing positioning slides.
