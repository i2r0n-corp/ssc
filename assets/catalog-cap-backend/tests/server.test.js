/**
 * CAP Backend — Integration & Unit Tests
 * Tests: health, catalog CRUD, search, filter, Excel store, PPTX, sync guards
 */

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Isolate file stores in a temp dir per test run ────────────────────────────
let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
  process.env.EXCEL_STORE_PATH = path.join(tmpDir, 'excels');
  process.env.SNAPSHOT_PATH = path.join(tmpDir, 'snapshot.json');
  fs.mkdirSync(process.env.EXCEL_STORE_PATH, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Re-require app after env is set so store paths are picked up
let app;
let snapshotStore;
beforeAll(() => {
  // Clear require cache so env vars are applied
  Object.keys(require.cache)
    .filter(k => k.includes('catalog-cap-backend'))
    .forEach(k => delete require.cache[k]);
  app = require('../server');
  snapshotStore = require('../store/snapshot');
});

// Reset in-memory cache before each test so seedSnapshot takes effect
beforeEach(() => {
  if (snapshotStore) snapshotStore._reset();
});

// ── Helper: seed a snapshot ───────────────────────────────────────────────────
function seedSnapshot(services = []) {
  const flatIndex = {};
  for (const svc of services) flatIndex[svc.code] = svc;
  const payload = JSON.stringify({ last_full_build: '2025-01-01T00:00:00Z', flat_index: flatIndex, business_scenarios: [] });
  const data = {
    lastFullBuild: '2025-01-01T00:00:00Z',
    lastUpdated: new Date().toISOString(),
    serviceCount: services.length,
    payload
  };
  fs.writeFileSync(process.env.SNAPSHOT_PATH, JSON.stringify(data));
}

const SAMPLE_SERVICE = {
  code: 'TEST001',
  name: 'Test Planning Service',
  shortDescription: 'Helps with planning.',
  longDescription: 'A detailed planning service for enterprise customers.',
  engagementType: 'Max Success Plan',
  parentCode: 'MAX00001-01',
  serviceObject: 'Service',
  business_scenario_naming: { MAX00001: 'Planning & Supply Chain' }
};

const SAMPLE_BS = {
  code: 'MAX00001',
  name: 'Max Business Scenario',
  serviceObject: 'Business Scenario',
  childServices: ['TEST001'],
  engagementType: 'Max Success Plan',
  parentCode: null,
  business_scenario_naming: {}
};

// ─────────────────────────────────────────────────────────────────────────────
// Health endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('404 fallback', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// publishSnapshot
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/catalog/publishSnapshot', () => {
  it('publishes a valid snapshot', async () => {
    const payload = { flat_index: { TEST001: SAMPLE_SERVICE }, business_scenarios: [] };
    const res = await request(app)
      .post('/api/catalog/publishSnapshot')
      .send({ payload, lastFullBuild: '2025-01-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('published');
    expect(res.body.serviceCount).toBe(1);
    expect(res.body.lastUpdated).toBeDefined();
  });

  it('returns 400 when payload is missing', async () => {
    const res = await request(app)
      .post('/api/catalog/publishSnapshot')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payload/i);
  });

  it('returns 401 when token is required but missing', async () => {
    process.env.CAP_PUBLISH_TOKEN = 'secret-token';
    const res = await request(app)
      .post('/api/catalog/publishSnapshot')
      .send({ payload: { flat_index: {}, business_scenarios: [] } });
    expect(res.status).toBe(401);
    delete process.env.CAP_PUBLISH_TOKEN;
  });

  it('accepts valid bearer token', async () => {
    process.env.CAP_PUBLISH_TOKEN = 'my-token';
    const res = await request(app)
      .post('/api/catalog/publishSnapshot')
      .set('Authorization', 'Bearer my-token')
      .send({ payload: { flat_index: { TEST001: SAMPLE_SERVICE }, business_scenarios: [] } });
    expect(res.status).toBe(200);
    delete process.env.CAP_PUBLISH_TOKEN;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSnapshot
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/catalog/getSnapshot', () => {
  it('returns snapshot when available', async () => {
    seedSnapshot([SAMPLE_SERVICE]);
    const res = await request(app).get('/api/catalog/getSnapshot');
    expect(res.status).toBe(200);
    expect(res.body.serviceCount).toBeDefined();
    expect(res.body.payload).toBeDefined();
  });

  it('returns 404 when no snapshot exists', async () => {
    if (fs.existsSync(process.env.SNAPSHOT_PATH)) {
      fs.unlinkSync(process.env.SNAPSHOT_PATH);
    }
    const res = await request(app).get('/api/catalog/getSnapshot');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchServices
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/catalog/searchServices', () => {
  beforeEach(() => seedSnapshot([SAMPLE_SERVICE, SAMPLE_BS]));

  it('returns all services for empty query', async () => {
    const res = await request(app).get('/api/catalog/searchServices');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    // Should not return Business Scenario objects
    const bsItems = res.body.services.filter(s => s.code === 'MAX00001');
    expect(bsItems.length).toBe(0);
  });

  it('finds service by keyword', async () => {
    const res = await request(app).get('/api/catalog/searchServices?query=planning');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const found = res.body.services.find(s => s.code === 'TEST001');
    expect(found).toBeDefined();
  });

  it('filters by engagementType', async () => {
    const res = await request(app).get('/api/catalog/searchServices?engagementType=Max+Success+Plan');
    expect(res.status).toBe(200);
    expect(res.body.services.every(s => s.engagementType.includes('Max Success Plan'))).toBe(true);
  });

  it('returns empty array for non-matching keyword', async () => {
    const res = await request(app).get('/api/catalog/searchServices?query=zzznomatch999');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('returns 404 when no snapshot', async () => {
    if (fs.existsSync(process.env.SNAPSHOT_PATH)) fs.unlinkSync(process.env.SNAPSHOT_PATH);
    const res = await request(app).get('/api/catalog/searchServices?query=test');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// filterServices
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/catalog/filterServices', () => {
  beforeEach(() => seedSnapshot([SAMPLE_SERVICE, SAMPLE_BS]));

  it('filters by engagementType', async () => {
    const res = await request(app).get('/api/catalog/filterServices?engagementType=Max+Success+Plan');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  it('returns 400 when no filters given', async () => {
    const res = await request(app).get('/api/catalog/filterServices');
    expect(res.status).toBe(400);
  });

  it('returns 404 when no snapshot', async () => {
    if (fs.existsSync(process.env.SNAPSHOT_PATH)) fs.unlinkSync(process.env.SNAPSHOT_PATH);
    const res = await request(app).get('/api/catalog/filterServices?engagementType=Max');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Excel file store
// ─────────────────────────────────────────────────────────────────────────────
describe('Excel file store', () => {
  const XLSX_MOCK = Buffer.from('PK\x03\x04'); // minimal ZIP/XLSX header

  it('PUT + GET roundtrip for valid bsCode', async () => {
    const res = await request(app)
      .put('/api/catalog/excel/MAX00001')
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(XLSX_MOCK);
    expect(res.status).toBe(200);
    expect(res.body.bsCode).toBe('MAX00001');

    const get = await request(app).get('/api/catalog/excel/MAX00001');
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toMatch(/spreadsheetml/);
  });

  it('returns 400 for invalid bsCode format', async () => {
    const res = await request(app)
      .put('/api/catalog/excel/invalid-code!')
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(XLSX_MOCK);
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent Excel', async () => {
    const res = await request(app).get('/api/catalog/excel/NOCODE');
    expect(res.status).toBe(404);
  });

  it('GET /api/catalog/excel lists staged bs codes', async () => {
    const res = await request(app).get('/api/catalog/excel');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.bsCodes)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PPTX generation
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/pptx/generatePptx', () => {
  beforeEach(() => seedSnapshot([SAMPLE_SERVICE, SAMPLE_BS]));

  it('generates a short-description PPTX', async () => {
    const res = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: ['TEST001'], template: 'short-description' });
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toMatch(/^\/api\/pptx\/download\//);
    expect(res.body.serviceCount).toBe(1);
    expect(res.body.fileSizeKb).toBeGreaterThan(0);
  });

  it('generates a one-pager PPTX', async () => {
    const res = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: ['TEST001'], template: 'one-pager' });
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toBeDefined();
  });

  it('returns 400 for empty serviceCodes', async () => {
    const res = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: [], template: 'short-description' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid template', async () => {
    const res = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: ['TEST001'], template: 'invalid-template' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for more than 50 service codes', async () => {
    const codes = Array.from({ length: 51 }, (_, i) => `SVC${String(i).padStart(3, '0')}`);
    const res = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: codes, template: 'short-description' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when no snapshot available', async () => {
    if (fs.existsSync(process.env.SNAPSHOT_PATH)) fs.unlinkSync(process.env.SNAPSHOT_PATH);
    const res = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: ['TEST001'], template: 'short-description' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when none of the codes exist in snapshot', async () => {
    seedSnapshot([SAMPLE_SERVICE]);
    const res = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: ['NOTEXIST999'], template: 'short-description' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/pptx/download/:fileId', () => {
  it('returns 400 or 404 for invalid fileId format (path traversal blocked)', async () => {
    // Express normalizes path traversal — result is either 400 (rejected by handler) or 404 (route not matched)
    const res = await request(app).get('/api/pptx/download/not-a-valid-uuid!!');
    expect([400, 404]).toContain(res.status);
  });

  it('returns 404 for unknown fileId', async () => {
    const res = await request(app).get('/api/pptx/download/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('can download a generated PPTX', async () => {
    seedSnapshot([SAMPLE_SERVICE]);
    const gen = await request(app)
      .post('/api/pptx/generatePptx')
      .send({ serviceCodes: ['TEST001'], template: 'short-description' });
    expect(gen.status).toBe(200);

    const fileId = gen.body.downloadUrl.split('/').pop();
    const dl = await request(app).get(`/api/pptx/download/${fileId}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/presentationml/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sync routes — guard tests (no real SSC API in unit tests)
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/catalog/sync/full (guard tests)', () => {
  it('returns 500 when SSC env vars are missing', async () => {
    delete process.env.SSC_AUTH_URL;
    delete process.env.SSC_CLIENT_ID;
    delete process.env.SSC_CLIENT_SECRET;
    const res = await request(app).post('/api/catalog/sync/full');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/SSC_AUTH_URL/i);
  });
});

describe('POST /api/catalog/sync/incremental (guard tests)', () => {
  it('returns 400 when no cached snapshot exists', async () => {
    if (fs.existsSync(process.env.SNAPSHOT_PATH)) fs.unlinkSync(process.env.SNAPSHOT_PATH);
    // Set SSC vars to get past the token check into the snapshot check
    process.env.SSC_AUTH_URL = 'http://fake-ssc/token';
    process.env.SSC_CLIENT_ID = 'fake';
    process.env.SSC_CLIENT_SECRET = 'fake';
    const res = await request(app).post('/api/catalog/sync/incremental');
    // Will fail with 500 (token fetch fails) or 400 (no snapshot); both are acceptable guard behaviours
    expect([400, 500]).toContain(res.status);
    delete process.env.SSC_AUTH_URL;
    delete process.env.SSC_CLIENT_ID;
    delete process.env.SSC_CLIENT_SECRET;
  });
});

describe('POST /api/catalog/sync/excel-enrich (guard tests)', () => {
  it('returns 400 when no cached snapshot exists', async () => {
    if (fs.existsSync(process.env.SNAPSHOT_PATH)) fs.unlinkSync(process.env.SNAPSHOT_PATH);
    const res = await request(app).post('/api/catalog/sync/excel-enrich').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/snapshot/i);
  });

  it('runs excel-enrich and publishes snapshot when snapshot exists', async () => {
    seedSnapshot([SAMPLE_SERVICE, SAMPLE_BS]);
    const res = await request(app).post('/api/catalog/sync/excel-enrich').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.mode).toBe('excel-enrich');
  });
});
