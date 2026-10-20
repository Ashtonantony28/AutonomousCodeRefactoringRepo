'use strict';

// Out-of-process dashboard client: polls /healthz every INTERVAL ms, fetches
// / every PAGE_MS ms and holds an SSE connection to /events. Each request is
// sequential, so a long latency == the server's event loop was blocked.
// usage: node poller.js <baseUrl> <outFile> [intervalMs=50] [pageMs=1000]
// Writes JSON results on SIGTERM/SIGINT.

const http = require('http');
const fs = require('fs');

const [base, outFile, intervalArg, pageArg] = process.argv.slice(2);
const INTERVAL = Number(intervalArg || 50);
const PAGE_MS = Number(pageArg || 1000);
const t0 = Date.now();
const health = [];
const pages = [];
const events = [];
let errors = 0;

function get(path) {
  return new Promise((resolve) => {
    const s = performance.now();
    const req = http.get(base.replace(/\/$/, '') + path, { agent: false }, (res) => {
      let n = 0;
      res.on('data', (d) => { n += d.length; });
      res.on('end', () => resolve({ ms: performance.now() - s, bytes: n, code: res.statusCode }));
    });
    req.on('error', () => { errors++; resolve(null); });
    req.setTimeout(120_000, () => req.destroy());
  });
}

async function healthLoop() {
  for (;;) {
    const at = Date.now() - t0;
    const r = await get('/healthz');
    if (r) health.push({ at, ms: r.ms });
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

async function pageLoop() {
  for (;;) {
    const at = Date.now() - t0;
    const r = await get('/');
    if (r) pages.push({ at, ms: r.ms, bytes: r.bytes, code: r.code });
    await new Promise(r => setTimeout(r, PAGE_MS));
  }
}

function sse() {
  http.get(base.replace(/\/$/, '') + '/events', { agent: false }, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /data: (.*)/.exec(chunk);
        if (/event: state/.test(chunk) && m) {
          try { const d = JSON.parse(m[1]); events.push({ at: Date.now() - t0, updated_at: d.updated_at, recv: Date.now() }); } catch { /* */ }
        }
      }
    });
  }).on('error', () => { errors++; });
}

function done() {
  fs.writeFileSync(outFile, JSON.stringify({ health, pages, events, errors }));
  process.exit(0);
}
process.on('SIGTERM', done);
process.on('SIGINT', done);

sse();
healthLoop();
pageLoop();
