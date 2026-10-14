# Excel Row Fix Feature — Q&A Design Doc

## Q1: Which match statuses are in scope for fixing?
**A:** All three failure/fuzzy modes:
- `No Module Match` — module name didn't resolve
- `No Service Match` — CRM ID / catalog name didn't resolve
- `Fuzzy` (new status to add) — currently logged as `Added` when fuzzy logic step was the deciding factor; needs its own distinct status so users know it may need review

## Q2: File / row unique identifier
**A:** Row hash — computed from `bs_code + crm_ids + deck_name + module_name`. Stable across re-uploads. Stored in a new `catalog_excel_fixes` table keyed by this hash.

## Q3: What columns does the exported XLSX update per fixed row?
**A:** Only the columns that exist in the original sheet are touched. The fixable fields are:
- **CRM ID** (col 1) — corrected service number
- **Name as per service catalog** (col 2) — not mandatory
- **Comment** (carry service code here when no CRM ID exists)
- **Link to info sheet** — hyperlink column
- **Business Module** — module name / code
- **Success Plan Layer**

## Q4: Where does the fix UI live?
**A:** Inside the existing match-detail modal on the Debug page (the popup that already shows resolution steps). Fix inputs are added below the steps table.

## Q5: Permission — who can fix?
**A:** New permission level `editor` to be added alongside existing ones (catalog, incidents, chat, debug, exportlog, admin). Editor permission gates the fix input fields and the "Export fixed file" button.

---

## Q6: How is "Fuzzy" status determined?
**A:** Check resolution steps — if any step has `method` containing `fuzzy`, the row status is `Fuzzy` instead of `Added`. Threshold value is not used as a cutoff; method name is the signal.

## Q7: Re-upload collision — what happens when a fix exists and the row changes?
**A:** Keep the old fix. The stored fix row gets two timestamps: `created_at` and `last_applied_at`. If the row hash no longer appears in the new file, the fix becomes "orphaned" but is not deleted.

## Q8: Export fixed file — scope and trigger
**A:** Exports the entire BS Excel file (all sheets, all rows) with fixed rows updated in-place. One file per BS code. The "Export fixed file" button appears on the Debug page near the BS filter — enabled only when a specific BS is selected, otherwise disabled. The button links to download that BS's stored Excel with fixes applied.

## Q9: Does saving a fix trigger re-enrichment?
**A:** Yes — saving a fix triggers enrichment for that specific row. For `No Service Match`: re-run with the provided CRM ID / name / code. For `No Module Match`: both module AND service identifiers must be provided so the full linkage can be resolved.

---

## Q10: Fix input fields per status — detail
**A:** Three variants:

**No Service Match & Fuzzy:**
- CRM ID field — validates against DB on input; red outline if not found, green if matched; Save disabled until at least one criterion matches
- Catalog name keywords field — debounced (longer delay), shows dropdown of matching service options from API; selecting one immediately shows: small link button to service in catalog + auto-fills CRM ID and Comment fields
- Once a service is chosen via either path, show pre-filled: CRM ID, Name as per catalog, Comment (service code if no CRM ID), Link to info sheet, Success Plan Layer

**No Module Match:**
- Module dropdown — ordered list of BS modules from API; selecting one immediately shows link to catalog (URL) for that module
- Below the module dropdown, show the full No Service Match form (CRM ID + keywords), pre-filled: CRM ID from Excel if exists, otherwise keywords pre-filled with catalog name from Excel or deck name as fallback
- Each field outlined green (matched) or red (not found) live as user types/selects

**Fuzzy:**
- Same form as No Service Match (service may already be pre-filled from the fuzzy match — user confirms or corrects)

Save button disabled until at least one identifier (CRM ID or catalog name selection) is confirmed valid (green outline).

## Q11: What gets updated on fix save?
**A:** Two things:
1. Live catalog linkage — write to `catalog_service_modules` (or equivalent) immediately
2. Matching debug tables — insert a new step row in `catalog_matching_steps` with `method = 'manual fix'` and update the parent `catalog_matching_log_rows` status accordingly

## Q12: What does the fix store — raw input or resolved codes?
**A:** Both. The `catalog_excel_fixes` table stores what the user entered (raw CRM ID typed) AND the resolved service/module codes that enrichment confirmed. CRM IDs entered must exactly match a record in the DB — red outline and Save disabled if no match found.

## Q13: Can a fix be deleted?
**A:** No — fixes are permanent for now. A fix can be overwritten (same hash, new values) but not deleted.

---

## Q14: CRM ID validation
**A:** Single value only. Validate: digits-only check client-side first, then verify against `serviceNumber` in the services table. Red outline if not found, Save disabled.

## Q15: Catalog name keyword search — endpoint
**A:** Reuse the existing catalog search endpoint. No new endpoint needed.

## Q16: Module dropdown scope
**A:** All modules belonging to the selected BS (Excel files are per-BS, so the dropdown is filtered to that BS's modules, fetched from API).

## Q17: After fix save
**A:** Modal stays open, row gets a green "Fixed" badge. No full reload — just status updates in place.

## Q18: Export fixed file — mechanism
**A:** The stored Excel blob (`catalog_excel_files.file_data`) is currently used only server-side (restored to disk on startup, read by enrichment). No download endpoint exists today — one must be built.

Mechanism:
1. New endpoint reads blob for the selected BS from DB
2. Parses it in-memory (same way sync does)
3. Queries `catalog_excel_fixes` for all fixes for that BS
4. Iterates every data row — computes hash (bs_code + crm_ids + deck_name + module_name); if a fix row matches, overwrites those cells
5. If hash doesn't match any fix — row is left untouched (may mean re-uploaded file already had that row corrected, or a different Excel)
6. Streams modified workbook back as download with original filename

All fixes for the BS are applied regardless of age. Orphaned fixes (hash no longer in file) are silently skipped.

## Q19: Why store mapping Excels at all?
**A:** Purely as source for server-side enrichment pipeline. On startup blobs are restored to disk; sync reads them from disk to run matching. No user-facing download existed before this feature.

---

## Q22: Does fix save trigger immediate enrichment?
**A:** Yes, immediately. Single-row fix path (does NOT reuse `applyExcelEnrichment`):
1. Read `catalog_sync.payload` → parse `flat_index` JSON
2. Run `_resolveModuleCode` + `_resolveServiceCode` with user-provided values
3. Mutate `flatIndex[modCode].childServices` to add the service code
4. Call `publishSnapshot(flatIndex, ...)` to persist updated snapshot to DB
5. Insert a new `catalog_matching_log_rows` row (no DELETE of existing rows) + steps row with `method = 'manual fix'`

---

## Risks & Caveats

**Risk 1 — Full DELETE in `applyExcelEnrichment` (mitigated)**
The existing enrichment path deletes all log rows for a BS before reinserting. The fix path bypasses this entirely — it inserts only the new fix log row, leaving existing rows untouched.

**Risk 2 — flatIndex rebuild on demand**
`flatIndex` is stored as JSON in `catalog_sync.payload` snapshot. Fix endpoint reads it from DB, mutates it, writes it back via `publishSnapshot`. No full sync needed.

**Risk 3 — No separate module-service table (clarified)**
`childServices` linkages live inside the `flat_index` JSON blob in `catalog_sync.payload`. Persisted to DB, read back on every sync. Fix writes back via `publishSnapshot`.

**Risk 4 — `catalog_excel_fixes` table doesn't exist yet**
New table needed: `row_hash TEXT PK, bs_code TEXT, crm_ids TEXT, deck_name TEXT, module_name TEXT, fixed_crm_id TEXT, fixed_service_code TEXT, fixed_module_code TEXT, fixed_name TEXT, fixed_comment TEXT, fixed_link TEXT, fixed_layer TEXT, created_at TIMESTAMPTZ, last_applied_at TIMESTAMPTZ`.

**Risk 5 — Fuzzy status doesn't exist yet**
Currently fuzzy matches log as `Added`. Need to detect `method` containing `fuzzy` in steps and set status to `Fuzzy` instead. Must not break next full sync's DELETE/reinsert cycle.

**Risk 6 — Row hash normalisation**
Hash inputs must be normalised before hashing: trim whitespace, lowercase, sort CRM IDs array. Otherwise minor re-upload differences break the match.

**Risk 7 — `publishSnapshot` rewrites entire snapshot**
Every fix save rewrites the full `flat_index` blob. If two fixes are saved concurrently, the second overwrites the first. For now this is acceptable (single-user editor scenario), but worth noting.

---

## Open / pending questions




