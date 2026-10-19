'use strict';

// Tiny stdlib HTTP server that:
//   GET /                 -> dashboard HTML rendered from the current session
//                            on every request (falls back to dashboard.html)
//   GET /session.json     -> serves the current session
//   GET /events           -> Server-Sent Events stream; emits a `state`
//                            event whenever session.json changes; the page
//                            then refetches / and swaps its content
//   GET /calibration.json -> isotonic calibration model + reliability bins
//   GET /clusters.json    -> failure clusters
//
// No dependencies, no framing, no auth — meant for a local dev loop.
// SSE beats polling here because we get push semantics with no protocol
// complexity (Server-Sent Events Beat WebSockets for 95% of Real-Time Apps).

const http = require('http');
const fs = require('fs');

const { sessionPath } = require('../utils/checkpoint');
const { weightsPath } = require('../rl/classifier');
const { modelPath } = require('../rl/calibration');
const { dashboardPath, renderHtml } = require('./dashboard');

const WATCH_INTERVAL_MS = 250;

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
  if (!state.keepAlive) keepAlive.unref();
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

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function serveDashboard(res) {
  let session = null;
  try { session = readJson(sessionPath()); } catch { session = null; }
  if (!session && fs.existsSync(dashboardPath())) return sendFile(res, dashboardPath(), 'text/html; charset=utf-8');
  let html;
  try { html = renderHtml(session || { proposals: [] }); }
  catch (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`render failed: ${err.message}`); return; }
  const buf = Buffer.from(html);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

// Polls (rather than fs.watch) so it works on every platform and catches up
// as soon as the event loop is free again, e.g. after a synchronous diff test.
function watchSession(state, intervalMs) {
  let last = null;
  const tick = () => {
    try {
      const file = sessionPath();
      if (!fs.existsSync(file)) return;
      const st = fs.statSync(file);
      const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
      if (key === last) return;
      last = key;
      const session = JSON.parse(fs.readFileSync(file, 'utf8'));
      broadcast(state, 'state', { updated_at: session.updated_at, proposals: (session.proposals || []).length });
    } catch { /* partial write or bad JSON: retry next tick */ }
  };
  state.watchTimer = setInterval(tick, intervalMs);
  if (!state.keepAlive) state.watchTimer.unref();
  tick();
}

function route(req, res, state) {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') return serveDashboard(res);
  // Learned-gate state is per target repo: follow the current session's target.
  let target = null;
  if (url === '/calibration.json' || url === '/rl-weights.json') {
    try { target = (readJson(sessionPath()) || {}).target_repo || null; } catch { target = null; }
  }
  const jsonFiles = {
    '/session.json': [sessionPath(), { proposals: [] }],
    '/calibration.json': [modelPath(target), null],
    '/rl-weights.json': [weightsPath(target), null]
  };
  if (jsonFiles[url]) {
    const [file, empty] = jsonFiles[url];
    try { const v = readJson(file); return sendJSON(res, v == null ? empty : v); }
    catch (err) { return sendJSON(res, { error: err.message }, 500); }
  }
  if (url === '/clusters.json') {
    try {
      const { clusterFailures } = require('./clustering');
      const sess = readJson(sessionPath()) || { proposals: [] };
      return sendJSON(res, clusterFailures(sess.proposals || []));
    } catch (err) { return sendJSON(res, { error: err.message }, 500); }
  }
  if (url === '/events') return startSse(req, res, state);
  if (url === '/healthz') return sendJSON(res, { ok: true });
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
}

// keepAlive=false (the default for programmatic use, e.g. `--serve`) unrefs
// the server, its sockets and timers so the host process exits when its own
// work is done. The standalone CLI below passes keepAlive=true.
function start({ port = 4173, open = false, keepAlive = false, watchIntervalMs = WATCH_INTERVAL_MS, quiet = false } = {}) {
  const state = { keepAlive };
  const sockets = new Set();
  const server = http.createServer((req, res) => route(req, res, state));
  server.on('connection', (sock) => {
    sockets.add(sock);
    if (!keepAlive) sock.unref();
    sock.on('close', () => sockets.delete(sock));
  });

  function close() {
    clearInterval(state.watchTimer);
    return new Promise((resolve) => {
      for (const c of clientsOf(state)) { try { c.end(); } catch { /* */ } }
      clientsOf(state).clear();
      server.close(() => resolve());
      for (const sock of sockets) sock.destroy();
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      if (!keepAlive) server.unref();
      watchSession(state, watchIntervalMs);
      const url = `http://127.0.0.1:${server.address().port}/`;
      if (!quiet) console.log(`[dashboard] live at ${url}`);
      if (open) tryOpen(url);
      resolve({ server, state, url, close });
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
  start({ port, open: process.argv.includes('--open'), keepAlive: true }).catch((err) => {
    console.error('dashboard server failed:', err);
    process.exit(1);
  });
}

module.exports = { start };
