# One-Pager Template — Layout Notes

> **Replace with official SAP-branded template files before production rollout.**

## Current placeholder layout (one slide per service)

**Header bar** (full width, dark blue `#003366`)
- Service name (20pt, bold, white)
- Service code (10pt, top-right, light blue)

**Meta row** (below header)
- Engagement Type and Module, italics, grey

**Summary section**
- Label: "Summary" (12pt, bold, SAP blue)
- Short description text (11pt)

**Details section**
- Label: "Details" (12pt, bold)
- Long description text, truncated to 600 chars (10pt)

**Business Scenarios section** (bottom)
- Up to 5 Business Scenario names the service belongs to (9pt)

## Replacement instructions
1. Create an official SAP-branded `.pptx` one-pager master template
2. Update `routes/pptx.js` `_buildOnePagePptx()` to:
   - Apply SAP brand colors (`#003366`, `#0070F2`, etc.) and typography
   - Add SAP logo, footer, and standard disclaimer
   - Map each service attribute to the appropriate placeholder shape
3. Add an `img/` folder with SAP logo if embedding directly in the slide
