#!/usr/bin/env node
'use strict';

// Session size scaling: saveSession cost per write and per run (O(n^2) total
// bytes), and the --serve dashboard server under a large session.json:
// GET / (render per request), /clusters.json, /session.json and the 250 ms
// watcher, measured from a separate polling process.
//
// usage: node audit/2/session-scale.js [--sizes 50,100,250,500,1000] [--grow 300]
//
// Proposals are clones of a real passed proposal captured from
// pipeline-load.js (fixtures/session-template.json); every 3rd is turned into a
// reverted one with a distinct stderr so clustering/probe work is non-trivial.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const L = require('./lib');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const SIZES = opt('--sizes', '50,100,250,500,1000').split(',').map(Number);
const GROW = Number(opt('--grow', 300));

L.isolateState('sess');
const checkpoint = require(L.src('utils/checkpoint'));
const dashboard = require(L.src('interpretability/dashboard'));
const { clusterFailures } = require(L.src('interpretability/clustering'));
const T = require('./fixtures/session-template.json');

const ERRS = ['TypeError: cannot read properties of undefined', 'AssertionError: expected 3 to equal 4', 'RangeError: maximum call stack', 'Error: ENOENT no such file', 'SyntaxError: unexpected token'];

function cloneProposal(k) {
  const p = JSON.parse(JSON.stringify(T.passed));
  p.issue_id = `${p.issue_id}-${k}`;
  if (k % 3 === 0) {
    p.test_outcome = { ...p.test_outcome, status: 'reverted', reverted: true, failed_tests: 1, stderr_tail: `${ERRS[k % ERRS.length]} at line ${k}\n${'    at frame (file.js:1:1)\n'.repeat(20)}` };
  }
  return p;
}

function buildSession(n) {
  const s = checkpoint.freshSession('/tmp/audit2-target');
  for (let k = 0; k < n; k++) {
    const p = cloneProposal(k);
    s.proposals.push(p);
    s.test_results.push({ ...T.test_result, proposal_id: p.issue_id });
    for (const smp of T.samples) s.rl_samples.push({ ...smp, proposal_id: `${p.issue_id}::${smp.mutation || 'real'}` });
  }
  return s;
}

function timeIt(fn, reps = 5) {
  const xs = [];
  for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); }
  return L.summarize(xs).p50;
}

function get(url) {
  return new Promise((resolve) => {
    const t = performance.now();
    http.get(url, { agent: false }, (res) => { let n = 0; res.on('data', d => { n += d.length; }); res.on('end', () => resolve({ ms: performance.now() - t, bytes: n })); })
      .on('error', () => resolve({ ms: NaN, bytes: 0 }));
  });
}

async function main() {
  console.log('== per-write cost vs session size ==');
  console.log('proposals  session_MB  saveSession_ms  JSON.parse_ms  renderHtml_ms  html_MB  clusterFailures_ms');
  const rows = [];
  for (const n of SIZES) {
    const s = buildSession(n);
    const save = timeIt(() => checkpoint.saveSession(s));
    const bytes = fs.statSync(checkpoint.sessionPath()).size;
    const txt = fs.readFileSync(checkpoint.sessionPath(), 'utf8');
    const parse = timeIt(() => JSON.parse(txt));
    let html = '';
    const render = timeIt(() => { html = dashboard.renderHtml(s); }, 3);
    const clus = timeIt(() => clusterFailures(s.proposals), 3);
    rows.push({ n, bytes, save, parse, render, html: html.length, clus });
    console.log(`${String(n).padStart(9)}  ${(bytes / 1e6).toFixed(2).padStart(10)}  ${L.fmt(save).padStart(14)}  ${L.fmt(parse).padStart(13)}  ${L.fmt(render).padStart(13)}  ${(html.length / 1e6).toFixed(2).padStart(7)}  ${L.fmt(clus).padStart(18)}`);
  }

  // A run that grows the session one proposal at a time with the observed
  // ~2 saveSession calls per proposal (pipeline-load: 103 writes / 50 proposals).
  console.log(`\n== cumulative saveSession cost of a run growing to ${GROW} proposals (2 writes/proposal) ==`);
  const s = checkpoint.freshSession('/tmp/audit2-target');
  let ms = 0, bytes = 0;
  const marks = new Set([50, 100, 200, 300, 500, 1000].filter(x => x <= GROW));
  for (let k = 0; k < GROW; k++) {
    s.proposals.push(cloneProposal(k));
    for (let w = 0; w < 2; w++) {
      const t = performance.now();
      checkpoint.saveSession(s);
      ms += performance.now() - t;
      bytes += fs.statSync(checkpoint.sessionPath()).size;
    }
    if (marks.has(k + 1)) console.log(`  after ${k + 1} proposals: ${(ms / 1000).toFixed(2)} s in saveSession, ${(bytes / 1e9).toFixed(2)} GB written`);
  }

  // Dashboard server with the largest session, polled from another process.
  const big = Math.max(...SIZES);
  checkpoint.saveSession(buildSession(big));
  const { start } = require(L.src('interpretability/server'));
  const srv = await start({ port: 0, quiet: true });
  const base = srv.url.replace(/\/$/, '');
  const one = {};
  for (const ep of ['/', '/clusters.json', '/session.json', '/healthz']) {
    const xs = [];
    let b = 0;
    for (let i = 0; i < 3; i++) { const r = await get(base + ep); xs.push(r.ms); b = r.bytes; }
    one[ep] = { p50: L.summarize(xs).p50, bytes: b };
  }
  console.log(`\n== server with ${big}-proposal session (sequential requests, p50 of 3) ==`);
  for (const [ep, r] of Object.entries(one)) console.log(`  GET ${ep.padEnd(15)} ${L.fmt(r.p50).padStart(8)} ms  ${(r.bytes / 1e6).toFixed(2)} MB`);

  // Concurrency: an out-of-process poller hits /healthz every 50 ms while one
  // tab reloads / every second and the session is rewritten every 500 ms.
  const pollOut = path.join(L.tmpDir('poll'), 'poll.json');
  const poller = fork(path.join(__dirname, 'poller.js'), [srv.url, pollOut, '50', '1000'], { stdio: 'inherit' });
  const sess = buildSession(big);
  const writer = setInterval(() => checkpoint.saveSession(sess), 500);
  await new Promise(r => setTimeout(r, 15_000));
  clearInterval(writer);
  poller.kill('SIGTERM');
  await new Promise(r => poller.on('exit', r));
  const poll = JSON.parse(fs.readFileSync(pollOut, 'utf8'));
  const h = L.summarize(poll.health.map(x => x.ms));
  const pg = L.summarize(poll.pages.map(x => x.ms));
  const lag = L.summarize(poll.events.map(e => e.recv - Date.parse(e.updated_at)).filter(Number.isFinite));
  console.log(`\n== 15 s under load (${big} proposals, session rewritten every 500 ms, / every 1 s) ==`);
  console.log(`  /healthz n=${h.n} p50 ${L.fmt(h.p50)} p95 ${L.fmt(h.p95)} max ${L.fmt(h.max)} ms`);
  console.log(`  /        n=${pg.n} p50 ${L.fmt(pg.p50)} p95 ${L.fmt(pg.p95)} max ${L.fmt(pg.max)} ms`);
  console.log(`  SSE state events=${poll.events.length} (writes=30) lag p50 ${L.fmt(lag.p50)} p95 ${L.fmt(lag.p95)} ms`);
  await srv.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
