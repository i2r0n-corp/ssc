# Short Description Template — Layout Notes

> **Replace with official SAP-branded template files before production rollout.**

## Current placeholder layout

**Slide 1 — Title slide**
- Dark blue background (`#003366`)
- Title: "Proposed Services" (36pt, white, centred)
- Subtitle: generated date and service count (14pt, light blue)

**Slides 2+ — Services table**
- Up to 10 services per slide
- Columns: Service Name | Short Description | Engagement Type | Module
- Header row: dark blue fill, white text
- Font: 9pt, border: 0.5pt grey

## Replacement instructions
1. Create an official SAP-branded `.pptx` file with the desired master slide and title page
2. Update `routes/pptx.js` `_buildShortDescriptionPptx()` to:
   - Load the template file using `pptx.load()` or apply SAP brand colors/fonts
   - Apply the official SAP font (72 Black/Regular) and color palette
3. Replace placeholder text with official copy as needed
