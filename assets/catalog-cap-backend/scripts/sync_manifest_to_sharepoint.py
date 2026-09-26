"""
SSC Catalog — Excel Enrichment Sync (Local Folder)
====================================================
Runs hourly via Windows Task Scheduler.

What it does:
  1. Reads last-check timestamp from log file
  2. If more than 1 hour passed since last check:
     → scans local SharePoint-synced folder for .xlsx files
     → if file was modified between last-check and now → uploads to CAP backend
     → backend enriches that BS immediately
  3. Updates last-check timestamp in log

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
    # Keep only last 100 history entries
    log["history"] = log.get("history", [])[-100:]
    Path(LOG_FILE).write_text(json.dumps(log, indent=2))

def log_entry(log, message):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {message}")
    log.setdefault("history", []).append({"time": ts, "message": message})

# ── UPLOAD ────────────────────────────────────────────────────────────────────

def upload_excel(filepath, filename, bs_code):
    with open(filepath, "rb") as f:
        content = f.read()
    resp = requests.put(
        f"{CAP_BACKEND_URL}/api/catalog/excel/upload",
        headers={
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "X-Filename": filename,
            "X-BS-Code": bs_code
        },
        data=content,
        timeout=60
    )
    resp.raise_for_status()
    return resp.json()

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
        print("⚡ First run — uploading all Excel files found.")
        last_check = None

    # Check if local folder exists
    if not os.path.isdir(EXCEL_FOLDER):
        log_entry(log, f"❌ Folder not found: {EXCEL_FOLDER}")
        log["lastCheck"] = now.isoformat()
        write_log(log)
        sys.exit(1)

    # Scan folder for Excel files
    excel_files = [f for f in os.listdir(EXCEL_FOLDER) if f.endswith(".xlsx")]
    if not excel_files:
        log_entry(log, f"⚠️  No .xlsx files found in folder")
        log["lastCheck"] = now.isoformat()
        write_log(log)
        return

    print(f"📁 Found {len(excel_files)} Excel files in folder\n")

    uploaded = 0
    skipped  = 0
    errors   = 0

    for filename in sorted(excel_files):
        filepath = os.path.join(EXCEL_FOLDER, filename)

        # Extract BS code from filename — everything before first underscore
        bs_code = filename.split("_")[0].strip().upper()
        if not bs_code:
            print(f"  ⚠️  {filename}: could not extract BS code — skipping")
            skipped += 1
            continue

        # Check file modification time
        mtime = datetime.fromtimestamp(os.path.getmtime(filepath), tz=timezone.utc)

        if last_check and mtime <= last_check:
            print(f"  ⏭️  {bs_code}: not modified since last check ({mtime.strftime('%Y-%m-%d %H:%M')} UTC) — skipping")
            skipped += 1
            continue

        print(f"  📤 {bs_code}: modified {mtime.strftime('%Y-%m-%d %H:%M')} UTC — uploading...")
        try:
            result = upload_excel(filepath, filename, bs_code)
            msg = f"✅ {bs_code}: enriched — {result.get('servicesEnriched', '?')} services updated"
            print(f"  {msg}")
            log_entry(log, msg)
            uploaded += 1
        except Exception as e:
            msg = f"❌ {bs_code}: upload failed — {e}"
            print(f"  {msg}")
            log_entry(log, msg)
            errors += 1

    # Update last check time
    log["lastCheck"] = now.isoformat()
    write_log(log)

    # Summary
    print(f"\n{'='*55}")
    print(f"✅ Uploaded & enriched : {uploaded}")
    print(f"⏭️  Skipped (no change) : {skipped}")
    print(f"❌ Errors              : {errors}")
    print(f"Last check saved      : {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}\n")

    if errors > 0:
        sys.exit(1)

if __name__ == "__main__":
    main()
