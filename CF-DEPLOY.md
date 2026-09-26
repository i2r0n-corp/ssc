# Cloud Foundry Deployment Guide

## Prerequisites
- CF CLI installed: https://docs.cloudfoundry.org/cf-cli/install-go-cli.html
- Your BTP trial account ready

## Step 1 — Login to CF

```bash
cf login -a https://api.cf.us10-001.hana.ondemand.com
# Enter your BTP email and password
# Select org: d980443atrial
# Select a space (e.g. dev)
```

## Step 2 — Deploy the CAP Backend

```bash
cd assets/catalog-cap-backend
cf push

# Set your SSC API credentials (ask your SSC admin for these):
cf set-env ssc-catalog-backend SSC_API_BASE_URL  <your-ssc-api-url>
cf set-env ssc-catalog-backend SSC_CLIENT_ID     <your-client-id>
cf set-env ssc-catalog-backend SSC_CLIENT_SECRET <your-client-secret>
cf set-env ssc-catalog-backend SSC_TOKEN_URL     <your-token-url>
cf set-env ssc-catalog-backend SYNC_AUTH_TOKEN   <choose-a-secret-token>

cf restart ssc-catalog-backend
```

Backend will be live at:
**https://ssc-catalog-backend.cfapps.us10-001.hana.ondemand.com**

## Step 3 — Deploy the UI

```bash
cd assets/catalog-ui

# Point the UI at the backend (and the agent once Joule Studio deploy completes):
cf set-env ssc-catalog-ui CAP_BACKEND_URL https://ssc-catalog-backend.cfapps.us10-001.hana.ondemand.com
cf set-env ssc-catalog-ui AGENT_BASE_URL  <agent-url-from-joule-studio>

cf push
cf restart ssc-catalog-ui
```

UI will be live at:
**https://ssc-catalog-ui.cfapps.us10-001.hana.ondemand.com**

## Step 4 — Trigger the first catalog sync

Once the backend is running and SSC credentials are set, trigger the initial full build:

```bash
curl -X POST https://ssc-catalog-backend.cfapps.us10-001.hana.ondemand.com/api/sync/full \
  -H "Authorization: Bearer <your-SYNC_AUTH_TOKEN>"
```

This downloads the full catalog from SSC (~1,250 services) and makes it searchable.
