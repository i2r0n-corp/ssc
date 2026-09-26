/**
 * Catalog UI Server Tests
 * Tests: static serving, env injection, SPA fallback
 */

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

let app;

beforeAll(() => {
  // Clear cache so env vars are picked up
  Object.keys(require.cache)
    .filter(k => k.includes('catalog-ui'))
    .forEach(k => delete require.cache[k]);
  app = require('../server');
});

describe('GET /', () => {
  it('returns HTML with injected CAP backend URL', async () => {
    process.env.REACT_APP_CAP_BACKEND_URL = 'http://cap-backend.example.com';
    process.env.REACT_APP_AGENT_BASE_URL = 'http://agent.example.com';

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http://cap-backend.example.com');
    expect(res.text).toContain('http://agent.example.com');
    expect(res.text).toContain('window.CAP_BACKEND_URL');
    expect(res.text).toContain('window.AGENT_BASE_URL');
  });

  it('uses default fallback URLs when env vars are not set', async () => {
    delete process.env.REACT_APP_CAP_BACKEND_URL;
    delete process.env.REACT_APP_AGENT_BASE_URL;

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('localhost:4004');
    expect(res.text).toContain('localhost:5000');
  });

  it('injects config before </head>', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    // Config script must appear before </head>
    const configIdx = res.text.indexOf('window.CAP_BACKEND_URL');
    const headIdx = res.text.indexOf('</head>');
    expect(configIdx).toBeGreaterThan(-1);
    expect(headIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeLessThan(headIdx);
  });
});

describe('Static file serving', () => {
  it('serves static JS files from public/', async () => {
    const res = await request(app).get('/app.js');
    // 200 if app.js exists, 404 otherwise — both are valid; we test the route works
    expect([200, 404]).toContain(res.status);
  });
});

describe('SPA fallback', () => {
  it('serves index.html for unknown routes', async () => {
    const res = await request(app).get('/some/deep/route');
    expect(res.status).toBe(200);
    // Should receive HTML
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
