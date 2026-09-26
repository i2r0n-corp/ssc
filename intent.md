# SSC Success Plan Catalog Intelligence Agent

AI-powered agent and companion UI enabling customer success specialists to intelligently explore the SAP SSC Services Catalog, receive service recommendations, analyze customer incidents, and export positioning slides to PowerPoint.

## Business challenge

Customer success specialists (CSMs) spend days manually gathering service information from the SSC Services Catalog to assemble positioning slides and success plan proposals for customers. The catalog contains hundreds of services organized into Business Scenarios, modules, and engagement types (e.g., Max Success Plan, Advanced Success Plan). An existing JWD-based solution works well for one user but cannot scale to the broader team because the data update and enrichment process is tied to a single user's local environment.

## Business Goals & Success Criteria

| Metric | Baseline | Target | Timeline | Process / Capability | Source |
|--------|----------|--------|----------|----------------------|--------|
| Time to assemble service descriptions and positioning slides for a success plan | Days (for large engagements) | 2–3 minutes | — | Success Plan creation & positioning | user |
| Number of CSMs able to self-serve catalog queries and export slides | 1 (single local user) | 10–50 (full team) | — | Success Plan delivery & scalability | user |

## Key Milestones

| Milestone | Condition to reach |
|-----------|-------------------|
| Catalog data product available | master_data.json is published as a centrally accessible data product via the n8n sync workflow |
| Agent answers basic catalog queries | Agent correctly responds to questions like "Which services are in Max Success Plan for SAP IBP?" |
| Incident analysis working | Agent accepts uploaded incident files and recommends relevant services from the catalog |
| PPTX export functional | Users can select services and download a populated PowerPoint (short-description or one-pager template) |
| Multi-user access confirmed | At least 10 CSMs can use the agent and UI concurrently without data access issues |

## Business Architecture (RBA)

### End-to-End Process

Lead to Cash — High Volume Subscription and Usage Business (Software Provider variant)

### Process Hierarchy

```
Lead to Cash (E2E)
└── Plan to Optimize Marketing and Sales (generic)
    └── Develop customer service strategy and plans (BPS-367)
        └── Develop customer care and customer service strategy
└── Manage Customers and Channels (generic)
    └── Manage and operate sales channels (BPS-371)
        └── Operate omnichannel customer platforms
```

### Summary

Customer success specialists retrieving and presenting SSC success plan services to customers maps to the Lead to Cash E2E (software provider variant), specifically the sub-processes for developing customer service strategy (BPS-367) and managing sales/service channels (BPS-371).

## Fit Gap Analysis

| Requirement (business) | Standard asset(s) found | API ORD ID | MCP Server ORD ID | MCP Server Version | Webhook API ORD ID | Data Product ORD ID | Gap? | Notes / assumptions |
|------------------------|------------------------|------------|-------------------|--------------------|--------------------|---------------------|------|---------------------|
| Catalog data access — read Business Scenarios, modules, services | Internal SSC Services Catalog (custom REST API) | — | — | — | — | — | Yes | No standard SAP API covers this internal SSC catalog; pre-cached master_data.json used as data product |
| Conversational catalog queries (NL → service recommendations) | — | — | — | — | — | — | Yes | Custom AI agent required |
| Customer incident analysis → service matching | — | — | — | — | — | — | Yes | File upload approach for phase 1; API connector to SAP incident system deferred to phase 2 |
| PPTX export of selected services (2 templates) | — | — | — | — | — | — | Yes | Custom generation via python-pptx or equivalent; template placeholders designed in this project |
| Catalog sync, enrichment, and publish pipeline | — | — | — | — | — | — | Yes | n8n workflow wrapping existing sync_catalog.py logic |
| Customer service analytics / planning | SAP Service Cloud v2, SAP Analytics Cloud | — | — | — | — | — | No | Standard analytics available but not the primary need here |

### Key findings

- No standard SAP product covers the SSC internal services catalog — all catalog access and reasoning requires custom development.
- The existing JWD script (sync_catalog.py) contains all data pipeline logic and can be the direct basis for the n8n workflow.
- The clean separation of data pipeline (n8n workflow → data product) from the agent (read-only consumer) is the key architectural decision enabling team scalability.
- Customer incident analysis will use file upload (CSV/Excel/text) for phase 1; SAP incident system API integration is explicitly deferred.
- PPTX export uses two templates designed in this project; users will replace with official SAP templates later.
- The solution requires no live API calls from the agent — all catalog data is consumed from the pre-enriched, centrally published master_data.json.

## Recommendations

### SSC Catalog Intelligence Platform

#### Executive Summary

AI agent + UI on centrally managed catalog data product, replacing local JWD tooling

#### Recommended Solution

Three-component solution:
1. **n8n Workflow (Data Pipeline)** — Replicates and extends the sync_catalog.py logic to sync, enrich (via BS Excel mappings), and publish the catalog as a central data product (master_data.json). Runs on schedule or on demand. Completely decoupled from the agent.
2. **AI Agent (Python, A2A protocol)** — Conversational agent that reads exclusively from the published data product. Handles: natural-language catalog queries, service recommendations by engagement type and business scenario, customer incident file upload and analysis, and triggering PPTX export. Deployed centrally so all 10–50 CSMs can use it.
3. **UI Application (React + SAP UI5 Web Components)** — Visual interface for browsing and filtering the catalog by service attributes (engagement type, business scenario, module), selecting services for export, uploading incident files, and downloading generated PowerPoint files.

#### Problem Statement

The existing JWD-based skill works for one user but cannot scale because the data update and enrichment process is tightly coupled to a local environment. Other team members cannot use it without running the pipeline themselves.

#### Affected User Roles

- Customer Success Manager (CSM) / Specialist — primary users, 10–50 people
- Success Plan Architect — uses the tool to build multi-service engagement proposals

#### Important factors

##### Decoupled data and agent architecture
The data pipeline (n8n) and the agent are fully independent. Catalog updates do not require agent redeployment, and the agent never touches the update machinery.

##### Reuse of existing script logic
The sync_catalog.py script is mature and tested. The n8n workflow wraps its logic rather than rewriting it, reducing risk and accelerating delivery.

##### Immediate team scalability
By hosting the data product and agent centrally, all CSMs can access the solution from day one without any local setup.

#### Potential risks

##### Data product freshness
If the n8n sync workflow fails silently, the agent will answer from stale data. Monitoring and alerting on the sync workflow is important.

##### PPTX template fidelity
The placeholder templates designed in this project will need to be replaced with official SAP-branded templates before broader rollout.

#### Recommended solution category

n8n Workflow, AI Agent, UI Application (React + SAP UI5 Web Components)

#### Intent fit
95%
