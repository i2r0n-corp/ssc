/**
 * MCP HTTP server — Model Context Protocol over HTTP+SSE
 * Mounted at /mcp — protected by MCP_SECRET env var.
 */

const router = require('express').Router();
const snapshot = require('../store/snapshot');

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireMcpSecret(req, res, next) {
  const secret = process.env.MCP_SECRET;
  if (!secret) return next();
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'searchServices',
    description: 'Search catalog services by keyword and optional filters. Returns up to 100 results.',
    inputSchema: {
      type: 'object',
      properties: {
        query:          { type: 'string',  description: 'Keyword to match against name and short description' },
        engagementType: { type: 'string',  description: 'Filter by engagement type (e.g. "Max Success Plan")' },
        businessScenario: { type: 'string', description: 'Filter by business scenario code (e.g. "MAX00001")' },
        limit:          { type: 'integer', description: 'Max results to return (default 20, max 100)', default: 20 }
      }
    }
  },
  {
    name: 'getService',
    description: 'Get full details of a single catalog service by its code.',
    inputSchema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'Service code (e.g. "000000000009506207")' }
      }
    }
  },
  {
    name: 'listBusinessScenarios',
    description: 'List all available business scenarios with their codes and names.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'getCatalogStats',
    description: 'Get catalog statistics: total service count, last updated timestamp.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'generatePresentation',
    description: 'Generate a PowerPoint presentation for a list of services and return a download URL. Use serviceCodes from searchServices results.',
    inputSchema: {
      type: 'object',
      required: ['serviceCodes'],
      properties: {
        serviceCodes: { type: 'array', items: { type: 'string' }, description: 'List of service codes to include' },
        title:        { type: 'string', description: 'Presentation title (default: "Services Description")' },
        template:     { type: 'string', description: 'Template: "list" (table format, recommended), "short-description", or "one-pager"', default: 'list' }
      }
    }
  }
];

// ── Snapshot helpers ──────────────────────────────────────────────────────────
function getIndex() {
  const data = snapshot.load();
  if (!data || !data.payload) return null;
  try {
    const parsed = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
    return { index: parsed.flat_index || {}, meta: data, scenarios: parsed.business_scenarios || [] };
  } catch { return null; }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────
async function callTool(name, args) {
  // Try DB path first, fall back to snapshot
  try {
    const db = require('../store/db');
    db.getPool();
    return await callToolDb(name, args, db);
  } catch {
    return callToolSnapshot(name, args);
  }
}

async function callToolDb(name, args, db) {
  if (name === 'getCatalogStats') {
    const r = await db.query('SELECT COUNT(*) AS cnt FROM catalog_services WHERE service_object NOT IN (\'Business Scenario\',\'Business Scenario module\') AND name IS NOT NULL');
    const snap = snapshot.load();
    return { serviceCount: parseInt(r.rows[0].cnt), lastUpdated: snap?.lastUpdated || null };
  }

  if (name === 'listBusinessScenarios') {
    const r = await db.query('SELECT code, name FROM catalog_services WHERE service_object=\'Business Scenario\' ORDER BY name');
    return { count: r.rows.length, businessScenarios: r.rows };
  }

  if (name === 'getService') {
    const r = await db.query('SELECT * FROM catalog_services WHERE code=$1 LIMIT 1', [args.code]);
    if (!r.rows.length) return { error: `Service not found: ${args.code}` };
    const row = r.rows[0];
    const svc = row.raw_data || {};
    svc._code = row.code;
    svc._name = row.name;
    svc._engagementType = row.engagement_type;
    return svc;
  }

  if (name === 'searchServices') {
    const limit = Math.min(args.limit || 20, 100);
    const params = [];
    let pIdx = 1;
    let sql = `SELECT s.code, s.name, s.short_description, s.engagement_type, s.raw_data
               FROM catalog_services s
               WHERE s.service_object NOT IN ('Business Scenario','Business Scenario module')
                 AND s.name IS NOT NULL`;

    if (args.query) {
      params.push(`%${args.query.toLowerCase()}%`);
      sql += ` AND (LOWER(s.name) LIKE $${pIdx} OR LOWER(s.short_description) LIKE $${pIdx})`;
      pIdx++;
    }
    if (args.engagementType) {
      params.push(args.engagementType);
      sql += ` AND EXISTS (SELECT 1 FROM catalog_classification cc WHERE cc.service_code=s.code AND cc.feature_key='engagementType' AND cc.feature_value=$${pIdx})`;
      pIdx++;
    }
    if (args.businessScenario) {
      params.push(args.businessScenario);
      sql += ` AND EXISTS (SELECT 1 FROM catalog_hierarchy h1 JOIN catalog_hierarchy h2 ON h2.parent_code=h1.child_code WHERE h1.parent_code=$${pIdx} AND h2.child_code=s.code)`;
      pIdx++;
    }
    params.push(limit);
    sql += ` ORDER BY s.name LIMIT $${pIdx}`;

    const r = await db.query(sql, params);
    const services = r.rows.map(row => ({
      code:             row.code,
      name:             row.name,
      shortDescription: row.short_description || (row.raw_data || {}).shortDescription || '',
      engagementType:   row.engagement_type || '',
      url:              (row.raw_data || {}).url || null
    }));
    return { count: services.length, services };
  }

  if (name === 'generatePresentation') {
    return callGeneratePresentation(args);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function callToolSnapshot(name, args) {
  const snap = getIndex();
  if (!snap) return { error: 'Catalog snapshot not available' };
  const { index, meta, scenarios } = snap;
  const allSvcs = Object.values(index);

  if (name === 'getCatalogStats') {
    return { serviceCount: allSvcs.length, lastUpdated: meta.lastUpdated };
  }

  if (name === 'listBusinessScenarios') {
    return { count: scenarios.length, businessScenarios: scenarios.map(s => ({ code: s.code, name: s.name })) };
  }

  if (name === 'getService') {
    const svc = index[args.code];
    if (!svc) return { error: `Service not found: ${args.code}` };
    return svc;
  }

  if (name === 'searchServices') {
    const limit = Math.min(args.limit || 20, 100);
    let results = allSvcs;
    if (args.query) {
      const q = args.query.toLowerCase();
      results = results.filter(s => (s._name||'').toLowerCase().includes(q) || (s.shortDescription||'').toLowerCase().includes(q));
    }
    if (args.engagementType) {
      results = results.filter(s => s._engagementType === args.engagementType);
    }
    results = results.slice(0, limit);
    return {
      count: results.length,
      services: results.map(s => ({
        code:             s.code || s._code,
        name:             s._name || s.name,
        shortDescription: s.shortDescription || '',
        engagementType:   s._engagementType || '',
        url:              s.url || null
      }))
    };
  }

  if (name === 'generatePresentation') {
    return callGeneratePresentation(args);
  }

  return { error: `Unknown tool: ${name}` };
}

// ── PPTX generation ───────────────────────────────────────────────────────────
async function callGeneratePresentation(args) {
  const { serviceCodes, title, template } = args;
  if (!Array.isArray(serviceCodes) || serviceCodes.length === 0) {
    return { error: 'serviceCodes must be a non-empty array' };
  }
  try {
    const { v4: uuidv4 } = require('uuid');
    const fs = require('fs');
    const path = require('path');
    const { generateListPptxBuffer } = require('../scripts/generate_list_pptx');
    const db = require('../store/db');

    const r = await db.query(
      'SELECT code, name, engagement_type, raw_data FROM catalog_services WHERE code = ANY($1)',
      [serviceCodes]
    );
    const svcs = r.rows.map(row => ({
      code:              row.code,
      name:              row.name || '',
      short_description: (row.raw_data || {}).shortDescription || '',
      engagement_type:   row.engagement_type || '',
      parent_name:       '',
      phases:            [],
      business_scenario_naming: {}
    }));

    if (!svcs.length) return { error: 'None of the provided service codes were found' };

    const buf = generateListPptxBuffer(svcs, { title: title || 'Services Description' });
    const fileId = uuidv4();
    const PPTX_TMP = path.join(__dirname, '..', 'data', 'pptx-tmp');
    fs.mkdirSync(PPTX_TMP, { recursive: true });
    fs.writeFileSync(path.join(PPTX_TMP, `${fileId}.pptx`), buf);

    const host = process.env.VCAP_APPLICATION
      ? JSON.parse(process.env.VCAP_APPLICATION).application_uris?.[0]
      : 'localhost:' + (process.env.PORT || 4004);
    const proto = process.env.VCAP_APPLICATION ? 'https' : 'http';
    const { downloadTokens, DOWNLOAD_TOKEN_TTL_MS } = require('./pptx');
    const downloadToken = uuidv4();
    downloadTokens.set(downloadToken, { fileId, expires: Date.now() + DOWNLOAD_TOKEN_TTL_MS });
    const downloadUrl = `${proto}://${host}/api/pptx/download/${fileId}?token=${downloadToken}`;

    return { downloadUrl, serviceCount: svcs.length, message: `Presentation ready with ${svcs.length} services. Download: ${downloadUrl}` };
  } catch(e) {
    return { error: e.message };
  }
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────
async function handleRpc(body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ssc-catalog-mcp', version: '1.0.0' }
      }
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    try {
      const result = await callTool(name, args);
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true }
      };
    }
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────
// Clients connect here to receive the endpoint URL, then POST to /mcp/message
const sseClients = new Map();

// Joule POSTs to /sse first to initialize — if no auth token, return 401 with WWW-Authenticate
router.post('/sse', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = `${proto}://${host}`;
    res.setHeader('WWW-Authenticate', `Bearer realm="${base}", authorization_uri="${base}/authorize", token_uri="${base}/token"`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });
  const isBatch = Array.isArray(body);
  const requests = isBatch ? body : [body];
  const responses = await Promise.all(requests.map(handleRpc));
  res.json(isBatch ? responses : responses[0]);
});

router.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + '_' + Math.random().toString(36).slice(2);
  sseClients.set(clientId, res);

  // Send endpoint event — tells the client where to POST messages
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const endpointUrl = `${proto}://${host}/mcp/message?clientId=${clientId}`;
  res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

  // Keepalive ping every 30s
  const keepalive = setInterval(() => res.write(': ping\n\n'), 30000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(clientId);
  });
});

// ── Message endpoint ──────────────────────────────────────────────────────────
router.post('/message', async (req, res) => {
  const clientId = req.query.clientId;
  const sseRes = clientId ? sseClients.get(clientId) : null;

  let body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON-RPC body' });
  }

  // Handle batch
  const isBatch = Array.isArray(body);
  const requests = isBatch ? body : [body];

  res.status(202).end(); // MCP spec: POST returns 202, response goes via SSE

  for (const rpc of requests) {
    const response = await handleRpc(rpc);
    if (sseRes && !sseRes.writableEnded) {
      sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    }
  }
});

// ── Simple HTTP fallback (for clients that don't use SSE) ─────────────────────
router.post('/rpc', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid JSON-RPC body' });
  const isBatch = Array.isArray(body);
  const requests = isBatch ? body : [body];
  const responses = await Promise.all(requests.map(handleRpc));
  res.json(isBatch ? responses : responses[0]);
});

// Debug catch-all — logs what path Joule actually hits
router.all('*', (req, res) => {
  console.log(`[mcp-debug] ${req.method} ${req.path} body=${JSON.stringify(req.body).substring(0,200)}`);
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

module.exports = router;
