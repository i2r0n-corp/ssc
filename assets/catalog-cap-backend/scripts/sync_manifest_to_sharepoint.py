"""
SSC Catalog — Excel Enrichment Sync (Local Folder)
====================================================
Runs hourly via Windows Task Scheduler.

What it does:
  1. Checks if app restarted since last sync — forces full re-upload if so
  2. Fetches excel-manifest from CAP backend
  3. For each manifest entry — finds exact file in local SharePoint-synced folder
  4. If modified since last check — uploads via PUT /excel/{bsCode}
  5. Server handles enrichment via serial queue
  6. Updates last-check timestamp in log

--manual mode:
  Scans local folder by BS-code prefix instead of manifest filenames.
  Uploads all found files unconditionally (no mtime/interval check).
  Does not update lastCheck so regular schedule is unaffected.

Requirements:
  pip install requests openpyxl
"""

import os, sys, json, re, requests, argparse
from datetime import datetime, timezone
from pathlib import Path

# ── CONFIG ────────────────────────────────────────────────────────────────────
EXCEL_FOLDER    = r"C:\Users\I306380\SAP SE\Max Success Plan - Service list - release 2608"
CAP_BACKEND_URL = "https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com"
LOG_FILE        = str(Path(__file__).parent / "sync_log.json")
CHECK_INTERVAL  = 60  # minutes

# Files to never upload regardless of mode
EXCLUDED_FILES = {
    "MAX00019_Transform your finance management_Foundational List.xlsx",
}

# ── STRUCTURE VALIDATION ──────────────────────────────────────────────────────
def check_excel_structure(filepath):
    """
    Returns (ok: bool, reason: str).
    Replicates the server-side _detectSheetLayout logic:
    - Needs at least 2 of: CRM/ID header, service/catalog/name header, deck/module header
    - OR data pattern: col0 text-like + col1 numeric CRM IDs in first 20 rows
    """
    try:
        import openpyxl
        wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
        ws = wb.active
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            rows.append([str(c).strip() if c is not None else '' for c in row])
            if i >= 20:
                break
        wb.close()
    except Exception as e:
        return False, f"cannot read file: {e}"

    if not rows:
        return False, "empty file"

    header_signals = set()
    for row in rows[:5]:
        for cell in row:
            s = cell.lower()
            if re.search(r'crm|^id$', s):      header_signals.add('id')
            if re.search(r'service|catalog|name', s): header_signals.add('name')
            if re.search(r'deck|scenario|success.?pack|module', s): header_signals.add('deck')
    if len(header_signals) >= 2:
        return True, 'header match'

    deck_like = crm_like = 0
    for row in rows[1:20]:
        col0 = row[0] if row else ''
        col1 = row[1] if len(row) > 1 else ''
        if col0 and len(col0) > 3 and not col0.isdigit():
            deck_like += 1
        if col1 and re.match(r'^\d{6,}$', col1):
            crm_like += 1
    if deck_like >= 2 and crm_like >= 1:
        return True, 'data pattern match'

    return False, f'no recognisable structure (header signals: {header_signals or "none"}, deck-like rows: {deck_like}, CRM-like rows: {crm_like})'

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
    parser = argparse.ArgumentParser()
    parser.add_argument('--manual', action='store_true', help='Upload all manifest files unconditionally, ignoring interval and mtime checks')
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    log = read_log()

    print(f"\n{'='*55}")
    print(f"  SSC Excel Enrichment Sync")
    print(f"  {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}")

    last_check_str = log.get("lastCheck")

    if args.manual:
        print("🔧 Manual mode — uploading all manifest files unconditionally.")
        force_reupload = True
    else:
        # 1. Check if app restarted since last sync — always runs regardless of interval
        force_reupload = False
        try:
            health_resp = requests.get(f"{CAP_BACKEND_URL}/health", timeout=10)
            health_resp.raise_for_status()
            app_start_time_str = health_resp.json().get("appStartTime")
            if app_start_time_str and last_check_str:
                app_start_time = datetime.fromisoformat(app_start_time_str.replace('Z', '+00:00'))
                last_check_dt  = datetime.fromisoformat(last_check_str)
                if last_check_dt.tzinfo is None:
                    last_check_dt = last_check_dt.replace(tzinfo=timezone.utc)
                if app_start_time > last_check_dt:
                    print(f"🔄 App restarted at {app_start_time.strftime('%Y-%m-%d %H:%M:%S')} UTC — forcing full re-upload.")
                    force_reupload = True
        except Exception as e:
            print(f"⚠️  Could not check app start time: {e}")

    # 2. Only apply interval check if NOT force reupload
    last_check = None
    if not force_reupload:
        if last_check_str:
            last_check = datetime.fromisoformat(last_check_str)
            if last_check.tzinfo is None:
                last_check = last_check.replace(tzinfo=timezone.utc)
            minutes_since = (now - last_check).total_seconds() / 60
            if minutes_since < CHECK_INTERVAL:
                print(f"⏭️  Last check was {minutes_since:.0f} min ago — minimum is {CHECK_INTERVAL} min. Skipping.")
                return
            print(f"⏱️  Last check: {last_check.strftime('%Y-%m-%d %H:%M:%S')} UTC ({minutes_since:.0f} min ago)")
        else:
            print("⚡ First run — uploading all Excel files found in manifest.")
            last_check = None
    else:
        last_check = None  # force all files to re-upload

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

    uploaded = skipped = errors = missing = bad_structure = excluded = 0

    def upload_file(bs_code, filepath):
        nonlocal uploaded, errors, bad_structure, excluded

        if filepath.name in EXCLUDED_FILES:
            print(f"  🚫 {bs_code}: excluded ({filepath.name})")
            excluded += 1
            return

        ok, reason = check_excel_structure(filepath)
        if not ok:
            print(f"  ❌ {bs_code}: skipped — bad structure ({reason}) [{filepath.name}]")
            bad_structure += 1
            return

        print(f"  📤 {bs_code}: uploading {filepath.name} ...")
        try:
            with open(filepath, 'rb') as f:
                data = f.read()
            put_resp = requests.put(
                f"{CAP_BACKEND_URL}/api/catalog/excel/{bs_code}",
                data=data,
                headers={"Content-Type": "application/octet-stream", "X-Filename": filepath.name},
                timeout=30
            )
            put_resp.raise_for_status()
            log_entry(log, f"✅ {bs_code}: uploaded {filepath.name} — queued for enrichment")
            uploaded += 1
        except Exception as e:
            log_entry(log, f"❌ {bs_code}: failed — {e}")
            errors += 1

    if args.manual:
        # Scan folder by BS-code prefix — one file per BS code (pick longest name on tie)
        print(f"🔍 Scanning local folder by BS-code prefix...\n")
        all_xlsx = sorted(Path(EXCEL_FOLDER).glob("*.xlsx"), key=lambda p: p.name)
        bs_code_re = re.compile(r'^(MAX\d{5})', re.IGNORECASE)
        by_bs: dict[str, list] = {}
        for f in all_xlsx:
            m = bs_code_re.match(f.name)
            if m:
                code = m.group(1).upper()
                by_bs.setdefault(code, []).append(f)

        for bs_code, candidates in sorted(by_bs.items()):
            # Exclude the hardcoded file first; if multiple remain pick the longest name (most descriptive)
            valid = [c for c in candidates if c.name not in EXCLUDED_FILES]
            if not valid:
                print(f"  🚫 {bs_code}: all candidates excluded")
                excluded += len(candidates)
                continue
            if len(valid) > 1:
                chosen = max(valid, key=lambda p: len(p.name))
                skipped_names = [c.name for c in valid if c != chosen]
                print(f"  ℹ️  {bs_code}: multiple files — using '{chosen.name}', skipping {skipped_names}")
            else:
                chosen = valid[0]
            upload_file(bs_code, chosen)
    else:
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

            upload_file(bs_code, filepath)

    if not args.manual:
        log["lastCheck"] = now.isoformat()
    write_log(log)

    print(f"\n{'='*55}")
    print(f"✅ Uploaded        : {uploaded}")
    print(f"⏭️  Skipped         : {skipped}")
    print(f"⚠️  Missing locally : {missing}")
    print(f"🚫 Excluded        : {excluded}")
    print(f"❌ Bad structure   : {bad_structure}")
    print(f"❌ Errors          : {errors}")
    if not args.manual:
        print(f"Last check saved  : {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}\n")
    if errors > 0: sys.exit(1)

if __name__ == "__main__":
    main()