# Specification: catalog-ui

> **Guidelines**: Read [guidelines.md](../guidelines.md) — Universal execution rules.

This React + SAP UI5 Web Components application provides the visual interface for Solutioning Leads and SPMs to browse the catalog, filter by attributes, upload incident files, select services for export, and download PowerPoint files. It also embeds the AI agent chat interface.

---

## Basic Setup

- [ ] Read `product-requirements-document.md` and `intent.md` for full context
- [ ] Run `setup-solution` skill to register this UI asset in `solution.yaml` and create `assets/catalog-ui/asset.yaml`
- [ ] Scaffold a React application in `assets/catalog-ui/`:
  ```bash
  cd assets/catalog-ui
  npx create-react-app . --template typescript
  npm install @ui5/webcomponents-react @ui5/webcomponents @ui5/webcomponents-fiori
  ```
- [ ] Configure the app to proxy API calls to the CAP backend (`CAP_BACKEND_URL` env var or a dev proxy in `package.json`)

---

## Application Structure

- [ ] Organize the app into the following pages/views:

  | Route | Page | Description |
  |-------|------|-------------|
  | `/` | Home / Catalog Browser | Main catalog browsing and filtering view |
  | `/incidents` | Incident Analysis | File upload and service recommendation view |
  | `/export` | PPTX Export | Service selection cart and download trigger |
  | `/chat` | Agent Chat | Embedded AI agent chat interface |

- [ ] Implement a persistent **ShellBar** (SAP UI5 `ShellBar` component) with navigation links to all four pages and the application title "SSC Catalog Intelligence"

---

## Page: Catalog Browser (`/`)

- [ ] Implement a **FilterBar** (SAP UI5 `FilterBar`) with the following filter fields:
  - Engagement Type (multi-select `Select` or `ComboBox` — populated from catalog data)
  - Business Scenario (multi-select — populated from catalog data)
  - Module (multi-select — populated from catalog data)
  - Free-text search field (searches service name and description)
- [ ] Implement a **Table** (`ui5-table`) displaying filtered results with columns:
  - Service Name, Short Description, Engagement Type, Business Scenario, Module, Service Code
- [ ] Each table row has a **Checkbox** for selecting services for export
- [ ] Implement an **Export Selection** button: adds selected services to the export cart and navigates to `/export`
- [ ] On load, fetch the full catalog snapshot from the CAP backend (`GET /api/catalog/getSnapshot`) and populate filter options from the returned data
- [ ] On filter change, call `GET /api/catalog/filterServices` with active filter values and refresh the table
- [ ] Display the last-updated timestamp of the catalog snapshot in the FilterBar header
- [ ] Handle empty state: display a friendly empty-state illustration when no services match the active filters

---

## Page: Incident Analysis (`/incidents`)

- [ ] Implement a **FileUploader** (`ui5-file-uploader`) accepting `.csv`, `.xlsx`, and `.txt` files (max 5 MB)
- [ ] After file selection, display the file name and a **"Analyze Incidents"** button
- [ ] On button click, send the file content to the AI agent's `analyze_incidents` tool via the agent API (env var: `AGENT_BASE_URL`)
- [ ] Display results in a **List** (`ui5-list`) with one `ui5-list-item` per recommended service showing: service name, short description, and relevance rationale
- [ ] Each result item has a **checkbox** to add the service to the export cart
- [ ] Implement an **"Add to Export"** button that adds checked recommendations to the export cart
- [ ] Handle loading state (show `ui5-busy-indicator` while agent processes the file)
- [ ] Handle error state (show `ui5-message-strip` with error text if the agent or backend returns an error)

---

## Page: PPTX Export (`/export`)

- [ ] Display the current export cart as a **Table** listing selected services (name, description, service code) with a **Remove** button per row
- [ ] Implement a **Template Selector** using `ui5-radio-button`:
  - Option 1: "Short Description List" — summary slide with all selected services
  - Option 2: "One-Pager per Service" — one detailed slide per service
- [ ] Implement a **"Generate & Download"** button:
  - On click, call the agent's `generate_pptx` tool (or directly the CAP backend `POST /api/pptx/generatePptx`) with the service codes and selected template
  - Show `ui5-busy-indicator` while generating
  - On success, trigger a browser download of the returned PPTX file
  - On error, show `ui5-message-strip` with the error message
- [ ] Display service count and a warning if more than 50 services are in the cart
- [ ] Implement a **"Clear Cart"** button
- [ ] Persist the export cart in browser `sessionStorage` so navigating between pages does not lose the selection

---

## Page: Agent Chat (`/chat`)

- [ ] Implement an embedded chat interface using SAP UI5 `ui5-input` (message input) and a message list (`ui5-list`)
- [ ] Each message is displayed as a `ui5-list-item` with role label (User / Agent) and message text
- [ ] Support multi-turn conversations: send user message to the AI agent API (`AGENT_BASE_URL`) and display the streamed response
- [ ] Implement a **file attachment button** on the chat input bar to allow uploading incident files directly from the chat (forwards to `analyze_incidents` flow)
- [ ] Display agent typing indicator (`ui5-busy-indicator`) while awaiting response
- [ ] Support markdown rendering in agent responses (service lists, tables)

---

## Global State

- [ ] Implement a simple React context (`CatalogContext`) to hold:
  - `catalogSnapshot`: the loaded catalog data
  - `exportCart`: array of selected service codes
  - `addToCart(serviceCode)` and `removeFromCart(serviceCode)` actions
- [ ] Load the catalog snapshot once on app initialization and cache in context

---

## Environment Variables

- [ ] Document all required environment variables:
  - `REACT_APP_CAP_BACKEND_URL` — base URL for CAP backend API
  - `REACT_APP_AGENT_BASE_URL` — base URL for AI agent API

---

## Validation

- [ ] `npm start` launches the app without errors
- [ ] `npm run build` produces a production build without errors
- [ ] Catalog browser loads and displays filtered results
- [ ] Incident analysis page accepts a test CSV file and displays recommendations
- [ ] Export page generates and downloads a PPTX file for a test selection
- [ ] Agent chat page sends a message and displays a response
- [ ] All pages are reachable via ShellBar navigation
- [ ] Export cart persists across page navigation within a session
