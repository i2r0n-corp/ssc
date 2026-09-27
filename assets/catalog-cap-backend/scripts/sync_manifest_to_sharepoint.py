"""
SSC Catalog — Excel Enrichment Sync (Local Folder)
====================================================
Runs hourly via Windows Task Scheduler.

What it does:
  1. Fetches excel-manifest from CAP backend
  2. For each manifest entry — finds exact file in local SharePoint-synced folder
  3. If modified since last check — uploads via PUT /excel/{bsCode}
  4. Server handles enrichment via serial queue
  5. Updates last-check timestamp in log

Requirements:
  pip install requests
"""

import os, sys, json, requests
from datetime import datetime, timezone
from pathlib import Path

# ── CONFIG ────────────────────────────────────────────────────────────────────
EXCEL_FOLDER    = r"C:\Users\I306380\SAP SE\Max Success Plan - Service list - release 2608"
CAP_BACKEND_URL = "https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com"
LOG_FILE        = str(Path(__file__).parent / "sync_log.json")
CHECK_INTERVAL  = 60  # minutes

# ── LOGGING ───────────────────────────────────────────────────────────────────
def read_log():
    if not os.path.exists(LOG_FILE):
        return {"lastCheck": None, "history": []}
    try: return json.loads(Path(LOG_FILE).read_text())
    except: return {"lastCheck": None, "history": []}

def write_log(log):
    log["history"] = log.get("history", [])[-100:]
    Path(LOG_FILE).write_text(json.dumps(log, indent=2))

def log_entry(log, message):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"  {message}")
    log.setdefault("history", []).append({"time": ts, "message": message})

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    now = datetime.now(timezone.utc)
    log = read_log()

    print(f"\n{'='*55}")
    print(f"  SSC Excel Enrichment Sync")
    print(f"  {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}")

    last_check_str = log.get("lastCheck")
    if last_check_str:
        last_check = datetime.fromisoformat(last_check_str)
        minutes_since = (now - last_check).total_seconds() / 60
        if minutes_since < CHECK_INTERVAL:
            print(f"⏭️  Last check was {minutes_since:.0f} min ago — minimum is {CHECK_INTERVAL} min. Skipping.")
            return
        print(f"⏱️  Last check: {last_check.strftime('%Y-%m-%d %H:%M:%S')} UTC ({minutes_since:.0f} min ago)")
    else:
        print("⚡ First run — uploading all Excel files found in manifest.")
        last_check = None

    # Fetch manifest
    print(f"\n📋 Fetching manifest from CAP backend...")
    try:
        resp = requests.get(f"{CAP_BACKEND_URL}/api/catalog/excel-manifest", timeout=15)
        resp.raise_for_status()
        manifest = resp.json()
    except Exception as e:
        print(f"❌ Could not fetch manifest: {e}")
        sys.exit(1)

    entries = manifest.get("entries", [])
    print(f"✅ Manifest loaded — {len(entries)} Business Scenarios\n")

    if not os.path.isdir(EXCEL_FOLDER):
        print(f"❌ Local folder not found: {EXCEL_FOLDER}")
        sys.exit(1)

    uploaded = skipped = errors = missing = 0

    for entry in entries:
        bs_code  = entry.get("bsCode", "")
        filename = entry.get("fileName", "")
        if not bs_code or not filename:
            continue

        filepath = Path(EXCEL_FOLDER) / filename
        if not filepath.exists():
            print(f"  ⚠️  {bs_code}: file not found locally ({filename})")
            missing += 1
            continue

        mtime = datetime.fromtimestamp(filepath.stat().st_mtime, tz=timezone.utc)
        if last_check and mtime <= last_check:
            print(f"  ⏭️  {bs_code}: not modified — skipping")
            skipped += 1
            continue

        print(f"  📤 {bs_code}: modified {mtime.strftime('%Y-%m-%d %H:%M')} UTC — uploading...")
        try:
            with open(filepath, 'rb') as f:
                data = f.read()
            put_resp = requests.put(
                f"{CAP_BACKEND_URL}/api/catalog/excel/{bs_code}",
                data=data,
                headers={"Content-Type": "application/octet-stream"},
                timeout=30
            )
            put_resp.raise_for_status()
            log_entry(log, f"✅ {bs_code}: uploaded — queued for enrichment")
            uploaded += 1
        except Exception as e:
            log_entry(log, f"❌ {bs_code}: failed — {e}")
            errors += 1

    log["lastCheck"] = now.isoformat()
    write_log(log)

    print(f"\n{'='*55}")
    print(f"✅ Uploaded        : {uploaded}")
    print(f"⏭️  Skipped         : {skipped}")
    print(f"⚠️  Missing locally : {missing}")
    print(f"❌ Errors          : {errors}")
    print(f"Last check saved  : {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}\n")
    if errors > 0: sys.exit(1)

if __name__ == "__main__":
    main()
