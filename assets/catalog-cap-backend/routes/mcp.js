/**
 * MCP Streamable HTTP server (spec 2025-03-26)
 * Single endpoint: POST and GET /mcp
 * Auth: Bearer token required (XSUAA JWT via OAuth proxy)
 */

const router = require('express').Router();
const snapshot = require('../store/snapshot');
const { randomUUID } = require('crypto');

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = new Map(); // sessionId → { sseStreams: Set }

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'searchServices',
    description: 'Search catalog services by keyword and optional filters. Returns up to 100 results.',
    inputSchema: {
      type: 'object',
      properties: {
        query:           { type: 'string',  description: 'Keyword to match against name and short description' },
        engagementType:  { type: 'string',  description: 'Filter by engagement type (e.g. "Max Success Plan")' },
        businessScenario:{ type: 'string',  description: 'Filter by business scenario code (e.g. "MAX00001")' },
        limit:           { type: 'integer', description: 'Max results to return (default 20, max 100)', default: 20 }
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
    const r = await db.query("SELECT COUNT(*) AS cnt FROM catalog_services WHERE service_object NOT IN ('Business Scenario','Business Scenario module') AND name IS NOT NULL");
    const snap = snapshot.load();
    return { serviceCount: parseInt(r.rows[0].cnt), lastUpdated: snap?.lastUpdated || null };
  }
  if (name === 'listBusinessScenarios') {
    const r = await db.query("SELECT code, name FROM catalog_services WHERE service_object='Business Scenario' ORDER BY name");
    return { count: r.rows.length, businessScenarios: r.rows };
  }
  if (name === 'getService') {
    const r = await db.query('SELECT * FROM catalog_services WHERE code=$1 LIMIT 1', [args.code]);
    if (!r.rows.length) return { error: `Service not found: ${args.code}` };
    const row = r.rows[0];
    const svc = row.raw_data || {};
    svc._code = row.code; svc._name = row.name; svc._engagementType = row.engagement_type;
    return svc;
  }
  if (name === 'searchServices') {
    const limit = Math.min(args.limit || 20, 100);
    const params = []; let pIdx = 1;
    let sql = "SELECT s.code, s.name, s.short_description, s.engagement_type, s.raw_data FROM catalog_services s WHERE s.service_object NOT IN ('Business Scenario','Business Scenario module') AND s.name IS NOT NULL";
    if (args.query) { params.push(`%${args.query.toLowerCase()}%`); sql += ` AND (LOWER(s.name) LIKE $${pIdx} OR LOWER(s.short_description) LIKE $${pIdx})`; pIdx++; }
    if (args.engagementType) { params.push(args.engagementType); sql += ` AND EXISTS (SELECT 1 FROM catalog_classification cc WHERE cc.service_code=s.code AND cc.feature_key='engagementType' AND cc.feature_value=$${pIdx})`; pIdx++; }
    if (args.businessScenario) { params.push(args.businessScenario); sql += ` AND EXISTS (SELECT 1 FROM catalog_hierarchy h1 JOIN catalog_hierarchy h2 ON h2.parent_code=h1.child_code WHERE h1.parent_code=$${pIdx} AND h2.child_code=s.code)`; pIdx++; }
    params.push(limit); sql += ` ORDER BY s.name LIMIT $${pIdx}`;
    const r = await db.query(sql, params);
    return { count: r.rows.length, services: r.rows.map(row => ({ code: row.code, name: row.name, shortDescription: row.short_description || '', engagementType: row.engagement_type || '', url: (row.raw_data||{}).url || null })) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function callToolSnapshot(name, args) {
  const snap = getIndex();
  if (!snap) return { error: 'Catalog snapshot not available' };
  const { index, meta, scenarios } = snap;
  const allSvcs = Object.values(index);
  if (name === 'getCatalogStats') return { serviceCount: allSvcs.length, lastUpdated: meta.lastUpdated };
  if (name === 'listBusinessScenarios') return { count: scenarios.length, businessScenarios: scenarios.map(s => ({ code: s.code, name: s.name })) };
  if (name === 'getService') { const svc = index[args.code]; return svc || { error: `Service not found: ${args.code}` }; }
  if (name === 'searchServices') {
    const limit = Math.min(args.limit || 20, 100);
    let results = allSvcs;
    if (args.query) { const q = args.query.toLowerCase(); results = results.filter(s => (s._name||'').toLowerCase().includes(q) || (s.shortDescription||'').toLowerCase().includes(q)); }
    if (args.engagementType) results = results.filter(s => s._engagementType === args.engagementType);
    return { count: results.slice(0,limit).length, services: results.slice(0,limit).map(s => ({ code: s.code||s._code, name: s._name||s.name, shortDescription: s.shortDescription||'', engagementType: s._engagementType||'', url: s.url||null })) };
  }
  return { error: `Unknown tool: ${name}` };
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────
async function handleRpc(rpc, sessionId) {
  const { id, method, params } = rpc;

  if (method === 'initialize') {
    const newSessionId = randomUUID();
    sessions.set(newSessionId, { sseStreams: new Set() });
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'ssc-catalog-mcp', version: '1.0.0' }
      },
      _sessionId: newSessionId
    };
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null; // notifications get 202, no body
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    try {
      const result = await callTool(name, args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true } };
    }
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Streamable HTTP — POST /mcp and /mcp/sse ─────────────────────────────────
async function handlePost(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    res.setHeader('WWW-Authenticate', `Bearer realm="${proto}://${host}", authorization_uri="${proto}://${host}/authorize"`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sessionId = req.headers['mcp-session-id'] || null;
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  const isBatch = Array.isArray(body);
  const requests = isBatch ? body : [body];

  // Check if any are requests (have id) vs notifications
  const hasRequests = requests.some(r => r.id !== undefined && r.id !== null);

  if (!hasRequests) {
    // Only notifications/responses — return 202
    for (const rpc of requests) await handleRpc(rpc, sessionId);
    return res.status(202).end();
  }

  // Has requests — process and return responses
  const responses = [];
  let newSessionId = null;
  for (const rpc of requests) {
    const response = await handleRpc(rpc, sessionId);
    if (response && response._sessionId) {
      newSessionId = response._sessionId;
      delete response._sessionId;
    }
    if (response) responses.push(response);
  }

  if (newSessionId) res.setHeader('Mcp-Session-Id', newSessionId);
  res.setHeader('Content-Type', 'application/json');
  res.json(isBatch ? responses : responses[0]);
}
router.post('/', handlePost);
router.post('/sse', handlePost);

// ── Streamable HTTP — GET /mcp (SSE stream for server→client) ─────────────────
function handleGet(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    res.setHeader('WWW-Authenticate', `Bearer realm="${proto}://${host}", authorization_uri="${proto}://${host}/authorize"`);
    return res.status(401).end();
  }

  const sessionId = req.headers['mcp-session-id'];
  const session = sessionId ? sessions.get(sessionId) : null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (session) session.sseStreams.add(res);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => {
    clearInterval(keepalive);
    if (session) session.sseStreams.delete(res);
  });
}
router.get('/', handleGet);
router.get('/sse', handleGet);

// ── DELETE /mcp (session termination) ────────────────────────────────────────
router.delete('/', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId) sessions.delete(sessionId);
  res.status(200).end();
});

module.exports = router;
