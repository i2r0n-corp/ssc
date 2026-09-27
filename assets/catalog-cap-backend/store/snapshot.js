/**
 * In-memory + file-backed snapshot store.
 * Stores the latest master_data catalog snapshot.
 * SNAPSHOT_PATH env var overrides the default path (useful for tests).
 */

const fs = require('fs');
const path = require('path');

function _snapshotFile() {
  return process.env.SNAPSHOT_PATH || path.join(__dirname, '..', 'data', 'snapshot.json');
}

// Ensure data dir exists lazily
function _ensureDir() {
  fs.mkdirSync(path.dirname(_snapshotFile()), { recursive: true });
}

let _snapshot = null;

function load() {
  if (_snapshot) return _snapshot;
  _ensureDir();
  const file = _snapshotFile();
  if (fs.existsSync(file)) {
    try {
      _snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error('Failed to load snapshot from disk:', e.message);
    }
  }
  return _snapshot;
}

function save(data) {
  _ensureDir();
  _snapshot = data; // update in-memory immediately — instant, no blocking
  // Serialize + write to disk synchronously but only after yielding to event loop
  // so health check can respond first
  setImmediate(() => {
    try {
      fs.writeFileSync(_snapshotFile(), JSON.stringify(data), 'utf8');
    } catch(e) {
      console.error('Failed to save snapshot to disk:', e.message);
    }
  });
}

function _reset() {
  _snapshot = null;
}

module.exports = { load, save, _reset };
