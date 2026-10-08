/**
 * Agent proxy — forwards chat messages from the UI to the A2A agent
 * and returns a simple { message } response.
 *
 * POST /api/agent/chat
 *   body: { message: string, contextId?: string }
 *   returns: { message: string }
 */

const router = require('express').Router();
const https  = require('https');
const http   = require('http');
const { randomUUID } = require('crypto');

const AGENT_BASE_URL = process.env.AGENT_BASE_URL || '';

router.post('/chat', async (req, res) => {
  const { message, contextId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (!AGENT_BASE_URL) return res.status(503).json({ error: 'AGENT_BASE_URL not configured' });

  try {
    // Build A2A request
    const taskId  = contextId || randomUUID();
    const a2aBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/send',
      params: {
        id: taskId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text: message }]
        }
      }
    });

    const agentUrl = new URL(AGENT_BASE_URL);
    const lib = agentUrl.protocol === 'https:' ? https : http;

    // Forward Authorization header if present (SAP AI Core needs JWT)
  
    const reply = await new Promise((resolve, reject) => {
      const options = {
        hostname: agentUrl.hostname,
        port: agentUrl.port || (agentUrl.protocol === 'https:' ? 443 : 80),
        path: agentUrl.pathname.replace(/\/$/, '') + '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(a2aBody)
        }
      };

      const proxyReq = lib.request(options, proxyRes => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Extract text from A2A response
            const parts = parsed?.result?.status?.message?.parts
              || parsed?.result?.artifacts?.[0]?.parts
              || [];
            const text = parts
              .filter(p => p.type === 'text')
              .map(p => p.text)
              .join('\n')
              || parsed?.result?.status?.message?.parts?.[0]?.text
              || data.substring(0, 500);
            resolve(text || 'No response from agent.');
          } catch (e) {
            resolve(data.substring(0, 500) || 'Agent returned an unreadable response.');
          }
        });
      });

      proxyReq.on('error', reject);
      proxyReq.write(a2aBody);
      proxyReq.end();
    });

    res.json({ message: reply, contextId: taskId });
  } catch (err) {
    console.error('[agent-proxy] Error:', err.message);
    res.status(502).json({ error: `Agent unreachable: ${err.message}` });
  }
});

module.exports = router;
