'use strict';

// Shared helpers for the AUDIT-6 scripts. Builds on audit/2/lib.js; all
// fixtures are generated under os.tmpdir() at runtime, state goes to a temp
// REFACTOR_STATE_DIR (isolateState must run before any src module loads).

const fs = require('fs');
const os = require('os');
const path = require('path');
const A2 = require('../2/lib');

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `audit6-${tag}-`));
}

function isolateState(tag = 'state') {
  const root = tmpDir(tag);
  process.env.REFACTOR_STATE_DIR = path.join(root, 'state');
  process.env.REFACTOR_DASHBOARD_DIR = path.join(root, 'dashboard');
  return root;
}

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ } }

function time(fn) {
  const t = performance.now();
  const r = fn();
  return { ms: performance.now() - t, r };
}

async function timeAsync(fn) {
  const t = performance.now();
  const r = await fn();
  return { ms: performance.now() - t, r };
}

function row(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i] || 10)).join(' ');
}

module.exports = { ...A2, rng, tmpDir, isolateState, rm, time, timeAsync, row };
