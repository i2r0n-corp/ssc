---
name: ssc-catalog
description: Search the SAP Success Plans Catalogue, explore business scenarios, retrieve service details, and generate PowerPoint presentations via MCP.
---

# SSC Catalog Intelligence — JWD Skill

## Purpose
Give JWD direct access to the SAP Success Plans Catalogue (SSC) via MCP. Use this skill to search services, explore business scenarios, pull service details, and generate ready-to-use PowerPoint presentations — all without leaving the conversation.

Use whichever connected MCP server exposes the tools `searchServices`, `getService`, `listBusinessScenarios`, `getCatalogStats`, and `generatePresentation`.

---

## Trigger phrases
Use this skill when the user says anything like:
- "show me catalog services for…"
- "find services related to…"
- "what Max / Advanced / Foundational services exist for…"
- "list services in business scenario…"
- "generate a PPTX / presentation for these services"
- "create a deck / slide / list for…"
- "how many services are in the catalog"
- "what business scenarios do we have"
- "get details for service code…"
- "build a slide with objectives / phases / PD / years"
- "prepare a roadmap deck"
- "give me a list of Max services about…"

---

## MCP tools available

### `searchServices`
Search the catalog by keyword and optional filters.
- `query` — keyword matched against name and short description
- `engagementType` — `"Max"`, `"Advanced"`, `"Foundational"` (or `"Foundation"`) — maps to the correct ET automatically
- `businessScenario` — BS code (e.g. `"MAX00001"`) — use `listBusinessScenarios` first if unknown
- `limit` — default 20, max 100

### `getService`
Get full details of one service by its code. Use after search to retrieve summary, description, key benefits, delivery approach, phases, effort estimate.

### `listBusinessScenarios`
List all business scenarios with codes and names. Call this when the user mentions a topic area but you don't know the BS code.

### `getCatalogStats`
Returns total service count and last catalog update timestamp. Use to answer "how many services", "when was it last updated".

### `generatePresentation`
Generate a PowerPoint file and return a download URL.
- `serviceCodes` — array of codes from search results (required)
- `title` — slide deck title
- `template` — `"list"` (default, table format), `"short-description"`, `"one-pager"`
- `cols` — optional columns for list template:
  - `phases: true` — SAP Activate phases
  - `objectives: true` — short description / objectives
  - `pd: true` — PD effort estimate (Max ET only)
  - `component: true` — service component name
  - `tier: true` — service type
- `yearFrom` / `yearTo` — add year timeline columns (e.g. `"2026"` to `"2030"`)
- `yearBorders: true` — visual borders between year columns
- `groupByET: true` — group rows by ET (Max → Advanced → Foundational)
- `switchTypes: true` — replace ET labels with "Premium Service" / "Service Entitlement"
- `truncateObjectives: true` — truncate long EGI descriptions to 3 sentences

---

## Behaviour rules

1. **Always search before generating.** Never call `generatePresentation` with codes the user hasn't confirmed or that didn't come from a fresh `searchServices` call in this conversation.

2. **Show search results first.** After `searchServices`, present the results as a numbered list: `[N] Service Name — ET — short description`. Ask the user to confirm which ones to include before generating a deck.

3. **Ask about deck options before generating.** Before calling `generatePresentation`, check:
   - Does the user want phases, objectives, PD, year timeline?
   - Should services be grouped by ET?
   - What title for the deck?
   — Keep it to one short question if the user hasn't specified. Use sensible defaults (list template, objectives on, phases on, groupByET on) if the user says "just generate it".

4. **Default options for a clean deck:**
   ```
   template: "list"
   cols: { phases: true, objectives: true }
   groupByET: true
   ```

5. **For roadmap / planning asks** (years, timeline, roadmap deck), add:
   ```
   yearFrom: "<current or requested year>"
   yearTo: "<requested end year>"
   yearBorders: true
   cols: { pd: true, phases: true, objectives: true }
   ```

6. **For customer-facing decks** when the user says "customer deck", "external", or "premium/entitlement labels":
   ```
   switchTypes: true
   truncateObjectives: true
   ```

7. **Present the download link prominently.** After `generatePresentation` succeeds, show the URL as a clickable link and state how many services are in the deck.

8. **If no services found**, tell the user clearly and suggest broadening the query, removing ET filter, or checking the BS code with `listBusinessScenarios`.

9. **Never fabricate service names or codes.** All data must come from tool results in the current conversation.

---

## Response format

**After search:**
> Found **N services** matching "query" [ET filter]:
> 1. **Service Name** — Max Success Plan — Short description snippet
> 2. …
>
> Shall I generate a PowerPoint deck for all / selected ones? Any specific columns or year range?

**After deck generation:**
> ✅ Deck ready — **N services**, template: list
> 📥 [Download PowerPoint](URL)

**After `getCatalogStats`:**
> The SSC catalog contains **N services**, last updated on DD Mon YYYY.

---

## Examples

**User:** "Find all Max services related to RISE migration and generate a deck with phases and objectives"
→ `searchServices(query:"RISE migration", engagementType:"Max", limit:30)`
→ Show results → confirm → `generatePresentation(serviceCodes:[...], title:"RISE Migration Services", cols:{phases:true, objectives:true}, groupByET:true)`

**User:** "What business scenarios do we have for Max?"
→ `listBusinessScenarios()` → filter/present names relevant to Max

**User:** "Give me a roadmap deck for S/4HANA services 2026–2029"
→ `searchServices(query:"S/4HANA")` → confirm → `generatePresentation(..., yearFrom:"2026", yearTo:"2029", yearBorders:true, cols:{pd:true, phases:true, objectives:true})`

**User:** "How many services are in the catalog?"
→ `getCatalogStats()` → "The SSC catalog contains N services, last updated on …"
