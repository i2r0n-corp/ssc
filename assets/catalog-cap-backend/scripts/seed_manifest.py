"""
One-shot: scan local Excel folder, register all BS codes in CAP backend manifest.
Run once to populate catalog_excel_files after a CF restart wipes the old JSON file.
"""

import os, re, sys, requests
from pathlib import Path

EXCEL_FOLDER    = r"C:\Users\I306380\SAP SE\Max Success Plan - Service list - release 2608"
CAP_BACKEND_URL = "https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com"
PUBLISH_TOKEN   = os.environ.get("CAP_PUBLISH_TOKEN", "")

BS_CODE_RE = re.compile(r'^(MAX\d{5})', re.IGNORECASE)

if not os.path.isdir(EXCEL_FOLDER):
    print(f"❌ Folder not found: {EXCEL_FOLDER}")
    sys.exit(1)

# Build entries — one row per BS code; if multiple files exist, pick alphabetically first
seen = {}
for fname in sorted(Path(EXCEL_FOLDER).iterdir()):
    if fname.suffix.lower() != '.xlsx':
        continue
    m = BS_CODE_RE.match(fname.name)
    if not m:
        print(f"  ⚠️  Skipping (no BS code prefix): {fname.name}")
        continue
    bs_code = m.group(1).upper()
    if bs_code not in seen:
        seen[bs_code] = fname.name

entries = [{"bsCode": k, "fileName": v} for k, v in sorted(seen.items())]

print(f"Found {len(entries)} BS codes:")
for e in entries:
    print(f"  {e['bsCode']}  →  {e['fileName']}")

print(f"\nPUTting to {CAP_BACKEND_URL}/api/catalog/excel-manifest ...")
headers = {"Content-Type": "application/json"}
if PUBLISH_TOKEN:
    headers["Authorization"] = f"Bearer {PUBLISH_TOKEN}"

resp = requests.put(
    f"{CAP_BACKEND_URL}/api/catalog/excel-manifest",
    json={"entries": entries},
    headers=headers,
    timeout=20
)
if resp.ok:
    print(f"✅ Done: {resp.json()}")
else:
    print(f"❌ Failed {resp.status_code}: {resp.text}")
    sys.exit(1)
