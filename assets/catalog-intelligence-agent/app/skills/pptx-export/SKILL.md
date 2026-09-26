---
name: pptx-export
description: Guide the user through selecting catalog services and choosing a PowerPoint export template, then generate and deliver the download link.
---

# PPTX Export Skill

## When to Use This Skill

Load this skill when:
- The user says "export to PowerPoint", "generate slides", "create a presentation", "download PPTX"
- The user has already selected a list of services and wants to export them
- The user wants to produce a positioning deck for a customer

## Prerequisites

- The user must have identified at least 1 service to include (by name or code)
- Service codes must be valid catalog codes (obtainable from prior search/filter results)

## Instructions

### Step 1: Confirm Service Selection

Ask the user to confirm the services they want to include if not already clear:
- "You've selected X services. Shall I include all of them, or would you like to refine the list?"
- If more than 50 services are selected, warn: "You have selected X services. The maximum for a single export is 50. Please reduce your selection."

### Step 2: Choose Template

Ask the user which template they prefer (if not already specified):

> "Which PowerPoint template would you like to use?
> 1. **Short Description List** — a summary table slide listing all selected services with their names, short descriptions, engagement types, and modules
> 2. **One-Pager per Service** — one dedicated slide per service with full details (name, description, details, engagement type, module, business scenario)"

Map the user's answer:
- "1", "short", "summary", "list" → template: `short-description`
- "2", "one-pager", "detailed", "full" → template: `one-pager`

### Step 3: Generate the PPTX

Call the `generatePptx` MCP tool with:
- `serviceCodes`: array of catalog service codes
- `template`: `short-description` or `one-pager`

### Step 4: Deliver the Download Link

On success, present the result to the user:
> "Your PowerPoint is ready! [Download here](<downloadUrl>)
> File: <filename> | <serviceCount> services | <fileSizeKb> KB
> Template: <template>"

If the user asks for the other template, repeat Step 3 with the alternative template.

## Guardrails

- Minimum 1 service required — do not call `generatePptx` with an empty list
- Maximum 50 services — warn and ask user to reduce selection if exceeded
- Template must be `short-description` or `one-pager` — ask user to clarify if ambiguous
- Never fabricate a download URL — only use URLs returned by `generatePptx`

## Error Handling

- `generatePptx` returns an error → relay the error message verbatim; suggest the user try with fewer services or a different template
- Catalog unavailable → inform user the catalog snapshot is needed before export
