"""
SSC Catalog — Excel Enrichment Sync (Local Folder)
====================================================
Runs hourly via Windows Task Scheduler.

What it does:
  1. Fetches excel-manifest from CAP backend
     (manifest is built from data product — contains exact {bsCode, fileName} pairs)
  2. Reads last-check timestamp from log file
  3. For each manifest entry:
     - looks for exact fileName in local SharePoint-synced folder
     - if file was modified since last check → uploads to CAP backend
     - triggers proper Excel enrichment for that BS
  4. Updates last-check timestamp in log

Requirements:
  pip install requests

Schedule: Windows Task Scheduler → every 1 hour
"""

import os
import sys
import json
import requests
from datetime import datetime, timezone
from pathlib import Path

# ── CONFIG ────────────────────────────────────────────────────────────────────

EXCEL_FOLDER    = r"C:\Users\I306380\SAP SE\Max Success Plan - Service list - release 2608"
CAP_BACKEND_URL = "https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com"
LOG_FILE        = str(Path(__file__).parent / "sync_log.json")
CHECK_INTERVAL  = 60  # minutes — skip run if called too soon

# ── LOGGING ───────────────────────────────────────────────────────────────────

def read_log():
    if not os.path.exists(LOG_FILE):
        return {"lastCheck": None, "history": []}
    try:
        return json.loads(Path(LOG_FILE).read_text())
    except:
        return {"lastCheck": None, "history": []}

def write_log(log):
    log["history"] = log.get("history", [])[-100:]
    Path(LOG_FILE).write_text(json.dumps(log, indent=2))

def log_entry(log, message):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"  {message}")
    log.setdefault("history", []).append({"time": ts, "message": message})
    return message

# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    now = datetime.now(timezone.utc)
    log = read_log()

    print(f"\n{'='*55}")
    print(f"  SSC Excel Enrichment Sync")
    print(f"  {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}")

    # Check if enough time passed since last run
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

    # Step 1 — fetch manifest from CAP backend
    print(f"\n📋 Fetching manifest from CAP backend...")
    try:
        resp = requests.get(f"{CAP_BACKEND_URL}/api/catalog/excel-manifest", timeout=15)
        if resp.status_code == 404:
            print("⚠️  No manifest on CAP backend yet — nothing to do.")
            log["lastCheck"] = now.isoformat()
            write_log(log)
            return
        resp.raise_for_status()
        manifest = resp.json()
    except Exception as e:
        print(f"❌ Could not fetch manifest: {e}")
        log["lastCheck"] = now.isoformat()
        write_log(log)
        sys.exit(1)

    entries = manifest.get("entries", [])
    print(f"✅ Manifest loaded — {len(entries)} Business Scenarios\n")

    # Step 2 — check local folder exists
    if not os.path.isdir(EXCEL_FOLDER):
        log_entry(log, f"❌ Local folder not found: {EXCEL_FOLDER}")
        log["lastCheck"] = now.isoformat()
        write_log(log)
        sys.exit(1)

    uploaded = 0
    skipped  = 0
    errors   = 0
    missing  = 0

    # Step 3 — for each manifest entry find exact file and check modification time
    for entry in entries:
        bs_code  = entry.get("bsCode", "")
        filename = entry.get("fileName", "")

        if not bs_code or not filename:
            continue

        filepath = os.path.join(EXCEL_FOLDER, filename)

        # Check if file exists locally
        if not os.path.exists(filepath):
            print(f"  ⚠️  {bs_code}: file not found locally ({filename})")
            missing += 1
            continue

        # Check modification time
        mtime = datetime.fromtimestamp(os.path.getmtime(filepath), tz=timezone.utc)

        if last_check and mtime <= last_check:
            print(f"  ⏭️  {bs_code}: not modified since last check — skipping")
            skipped += 1
            continue

        print(f"  📤 {bs_code}: modified {mtime.strftime('%Y-%m-%d %H:%M')} UTC — uploading...")

        try:
            # Upload Excel file
            with open(filepath, "rb") as f:
                content = f.read()
            put_resp = requests.put(
                f"{CAP_BACKEND_URL}/api/catalog/excel/{bs_code}",
                headers={"Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
                data=content,
                timeout=60
            )
            put_resp.raise_for_status()

            # Trigger real enrichment
            enrich_resp = requests.post(
                f"{CAP_BACKEND_URL}/api/catalog/sync/excel-enrich",
                json={"bsCode": bs_code},
                timeout=60
            )
            enrich_resp.raise_for_status()
            result = enrich_resp.json()

            msg = f"✅ {bs_code}: accepted for enrichment"
            log_entry(log, msg)
            uploaded += 1

        except Exception as e:
            msg = f"❌ {bs_code}: failed — {e}"
            log_entry(log, msg)
            errors += 1

    # Update last check time
    log["lastCheck"] = now.isoformat()
    write_log(log)

    # Summary
    print(f"\n{'='*55}")
    print(f"✅ Uploaded & enriched  : {uploaded}")
    print(f"⏭️  Skipped (no change)  : {skipped}")
    print(f"⚠️  Missing locally      : {missing}")
    print(f"❌ Errors               : {errors}")
    print(f"Last check saved       : {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}\n")

    if errors > 0:
        sys.exit(1)

if __name__ == "__main__":
    main()
