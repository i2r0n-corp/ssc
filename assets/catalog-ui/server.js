/**
 * SSC Catalog Intelligence UI — Static file server
 * Serves the React+UI5 single-page application and injects runtime env vars.
 */

const express = require('express');
const path = require('path');

const app = express();

// Inject env vars into the HTML as window globals for the browser app
app.get('/', (req, res) => {
  const capUrl = process.env.REACT_APP_CAP_BACKEND_URL || 'http://localhost:4004';
  const agentUrl = process.env.REACT_APP_AGENT_BASE_URL || 'http://localhost:5000';
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const fs = require('fs');
  let html = fs.readFileSync(indexPath, 'utf8');
  // Inject runtime config before </head>
  const configScript = `<script>window.CAP_BACKEND_URL="${capUrl}";window.AGENT_BASE_URL="${agentUrl}";</script>`;
  html = html.replace('</head>', configScript + '</head>');
  res.send(html);
});

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: serve index for all routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`catalog-ui listening on port ${PORT}`));

module.exports = app;
