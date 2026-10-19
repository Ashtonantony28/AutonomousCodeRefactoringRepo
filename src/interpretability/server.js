'use strict';

// Tiny stdlib HTTP server that:
//   GET /                 -> serves dashboard.html
//   GET /session.json     -> serves the current session
//   GET /events           -> Server-Sent Events stream; emits a `state`
//                            event whenever session.json mtime changes
//   GET /calibration.json -> isotonic calibration model + reliability bins
//   GET /clusters.json    -> failure clusters
//
// No dependencies, no framing, no auth — meant for a local dev loop.
// SSE beats polling here because we get push semantics with no protocol
// complexity (Server-Sent Events Beat WebSockets for 95% of Real-Time Apps).

const http = require('http');
const fs = require('fs');
const path = require('path');

const { stateDir, sessionPath } = require('../utils/checkpoint');
const { dashboardPath } = require('./dashboard');

function sendJSON(res, body, code = 200) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function sendFile(res, filePath, type) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function clientsOf(state) {
  if (!state.clients) state.clients = new Set();
  return state.clients;
}

function startSse(req, res, state) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  clientsOf(state).add(res);
  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clientsOf(state).delete(res);
  });
}

function broadcast(state, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clientsOf(state)) {
    try { c.write(payload); } catch { /* drop dead clients */ }
  }
}

function watchSession(state) {
  const SESSION_PATH = sessionPath();
  if (!fs.existsSync(path.dirname(SESSION_PATH))) return;
  let lastMtime = 0;
  const tick = () => {
    try {
      if (!fs.existsSync(SESSION_PATH)) return;
      const m = fs.statSync(SESSION_PATH).mtimeMs;
      if (m === lastMtime) return;
      lastMtime = m;
      const session = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
      broadcast(state, 'state', { updated_at: session.updated_at, proposals: session.proposals.length });
    } catch { /* swallow */ }
  };
  state.watchTimer = setInterval(tick, 1000);
  tick();
}

function start({ port = 4173, open = false } = {}) {
  const state = {};
  const SESSION_PATH = sessionPath();
  const DASHBOARD_HTML = dashboardPath();
  const CALIB_PATH = path.join(stateDir(), 'calibration.json');
  const RL_WEIGHTS_PATH = path.join(stateDir(), 'rl-weights.json');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') return sendFile(res, DASHBOARD_HTML, 'text/html; charset=utf-8');
    if (url === '/session.json') {
      if (!fs.existsSync(SESSION_PATH)) return sendJSON(res, { proposals: [] });
      try { return sendJSON(res, JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'))); }
      catch (err) { return sendJSON(res, { error: err.message }, 500); }
    }
    if (url === '/calibration.json') {
      if (!fs.existsSync(CALIB_PATH)) return sendJSON(res, null);
      try { return sendJSON(res, JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'))); }
      catch (err) { return sendJSON(res, { error: err.message }, 500); }
    }
    if (url === '/rl-weights.json') {
      if (!fs.existsSync(RL_WEIGHTS_PATH)) return sendJSON(res, null);
      try { return sendJSON(res, JSON.parse(fs.readFileSync(RL_WEIGHTS_PATH, 'utf8'))); }
      catch (err) { return sendJSON(res, { error: err.message }, 500); }
    }
    if (url === '/clusters.json') {
      try {
        const { clusterFailures } = require('./clustering');
        const sess = fs.existsSync(SESSION_PATH) ? JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8')) : { proposals: [] };
        return sendJSON(res, clusterFailures(sess.proposals || []));
      } catch (err) { return sendJSON(res, { error: err.message }, 500); }
    }
    if (url === '/events') return startSse(req, res, state);
    if (url === '/healthz') return sendJSON(res, { ok: true });
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      watchSession(state);
      const url = `http://127.0.0.1:${port}/`;
      console.log(`[dashboard] live at ${url}`);
      if (open) tryOpen(url);
      resolve({ server, state, url });
    });
  });
}

function tryOpen(url) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

if (require.main === module) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 4173;
  start({ port, open: process.argv.includes('--open') }).catch((err) => {
    console.error('dashboard server failed:', err);
    process.exit(1);
  });
}

module.exports = { start };
