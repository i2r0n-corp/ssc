"""
SSC Catalog — Manifest Sync to SharePoint
==========================================
Runs hourly (via Windows Task Scheduler).

What it does:
  1. GET /api/catalog/excel-manifest from CAP backend
  2. If available → upload excel-manifest.json to SharePoint
  3. If not available → skip (leave existing file as-is)

Power Automate then reads excel-manifest.json from SharePoint.

Requirements:
  pip install msal requests

First run: opens browser for SAP login once → token cached silently after that.
"""

import json
import sys
import os
import requests
import msal
from datetime import datetime, timezone
from pathlib import Path

# ── CONFIG ────────────────────────────────────────────────────────────────────

CAP_BACKEND_URL   = "https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com"
SHAREPOINT_SITE   = "https://sap.sharepoint.com/sites/205134"
SHAREPOINT_FOLDER = "Shared Documents/Business Scenarios/Service list - release 2608"
MANIFEST_FILENAME = "excel-manifest.json"

CLIENT_ID   = "14d82eec-204b-4c2f-b7e8-296a70dab67e"  # Microsoft Graph Explorer
AUTHORITY   = "https://login.microsoftonline.com/common"
SCOPES      = ["Sites.ReadWrite.All", "Files.ReadWrite.All"]
TOKEN_CACHE = str(Path(__file__).parent / "token_cache.bin")

# ── AUTH ──────────────────────────────────────────────────────────────────────

def get_access_token():
    cache = msal.SerializableTokenCache()
    if os.path.exists(TOKEN_CACHE):
        cache.deserialize(open(TOKEN_CACHE).read())

    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY, token_cache=cache)
    accounts = app.get_accounts()
    result = app.acquire_token_silent(SCOPES, account=accounts[0]) if accounts else None

    if not result:
        print("🔐 First time login — opening browser...")
        flow = app.initiate_device_flow(scopes=SCOPES)
        print(flow["message"])
        result = app.acquire_token_by_device_flow(flow)

    if "access_token" not in result:
        print(f"❌ Auth failed: {result.get('error_description')}")
        sys.exit(1)

    if cache.has_state_changed:
        open(TOKEN_CACHE, "w").write(cache.serialize())

    return result["access_token"]

# ── SHAREPOINT ────────────────────────────────────────────────────────────────

def get_site_and_drive(token):
    hostname  = "sap.sharepoint.com"
    site_path = "/sites/205134"
    site = requests.get(
        f"https://graph.microsoft.com/v1.0/sites/{hostname}:{site_path}",
        headers={"Authorization": f"Bearer {token}"}, timeout=15
    )
    site.raise_for_status()
    site_id = site.json()["id"]

    drives = requests.get(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}/drives",
        headers={"Authorization": f"Bearer {token}"}, timeout=15
    )
    drives.raise_for_status()
    drive_list = drives.json().get("value", [])
    drive_id = next((d["id"] for d in drive_list if d.get("name") in ("Documents", "Shared Documents")), drive_list[0]["id"])
    return site_id, drive_id

def upload_to_sharepoint(token, content_bytes):
    site_id, drive_id = get_site_and_drive(token)
    upload_url = (
        f"https://graph.microsoft.com/v1.0/sites/{site_id}/drives/{drive_id}"
        f"/root:/{SHAREPOINT_FOLDER}/{MANIFEST_FILENAME}:/content"
    )
    resp = requests.put(
        upload_url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=content_bytes,
        timeout=30
    )
    resp.raise_for_status()
    print(f"✅ Uploaded: {resp.json().get('webUrl', 'OK')}")

# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Manifest sync starting...")

    # Step 1 — fetch manifest from CAP backend
    try:
        resp = requests.get(f"{CAP_BACKEND_URL}/api/catalog/excel-manifest", timeout=15)
        if resp.status_code == 404:
            print("⚠️  No manifest on CAP backend yet — leaving SharePoint file as-is.")
            sys.exit(0)
        resp.raise_for_status()
    except Exception as e:
        print(f"❌ Could not reach CAP backend: {e}")
        sys.exit(0)

    manifest = resp.json()
    print(f"✅ Manifest fetched — {manifest.get('count', 0)} Business Scenarios.")

    # Step 2 — upload to SharePoint
    token = get_access_token()
    upload_to_sharepoint(token, resp.content)

    print(f"✅ Done — excel-manifest.json is ready in SharePoint.\n")

if __name__ == "__main__":
    main()
