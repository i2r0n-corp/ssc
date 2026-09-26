# Excel Manifest Sync — Setup Guide

## What this script does
Runs hourly. Checks CAP backend for a snapshot → if available, extracts
Business Scenario → Excel file mapping → uploads `excel-manifest.json`
to SharePoint → Power Automate reads it from there.

## Install dependencies (once)
```powershell
pip install msal requests
```

## First run (browser login once)
```powershell
cd $env:USERPROFILE\Desktop\ssc-catalog-backend\catalog-cap-backend\scripts
python sync_manifest_to_sharepoint.py
```
A browser window opens → log in with your SAP account → done.
Token is cached in `token_cache.bin` — no login needed after that.

## Schedule hourly with Windows Task Scheduler

1. Open **Task Scheduler** → Create Basic Task
2. **Name:** `SSC Manifest Sync`
3. **Trigger:** Daily → repeat every **1 hour**
4. **Action:** Start a program
   - Program: `python`
   - Arguments: `sync_manifest_to_sharepoint.py`
   - Start in: `C:\Users\<you>\Desktop\ssc-catalog-backend\catalog-cap-backend\scripts`
5. Finish → Done ✅

## Power Automate — read manifest from SharePoint

**Trigger:** Recurrence — daily at 02:00 CET

**Step 1 — Get manifest file**
- Action: `Get file content using path (SharePoint)`
- Site: `https://sap.sharepoint.com/sites/205134`
- File Path: `/Shared Documents/Business Scenarios/Service list - release 2608/excel-manifest.json`

**Step 2 — Parse manifest**
- Action: `Convert JSON to custom object`
- Value: `body('Get_file_content_using_path')`

**Step 3 — Apply to each** → `outputs('Convert_JSON_to_custom_object')?['entries']`
  - **Get Excel file (SharePoint)**
    - Site: `https://sap.sharepoint.com/sites/205134`
    - File Path: `/Shared Documents/Business Scenarios/Service list - release 2608/@{items('Apply_to_each')?['fileName']}`
  - **HTTP PUT to CAP backend**
    - Method: `PUT`
    - URI: `https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com/api/catalog/excel/@{items('Apply_to_each')?['bsCode']}`
    - Headers: `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
    - Body: `outputs('Get_Excel_file')?['body']`

**Step 4 — Trigger re-enrichment**
- Action: `HTTP POST`
- URI: `https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com/api/catalog/sync/excel-enrich`
- Headers: `Content-Type: application/json`
- Body: `{}`
