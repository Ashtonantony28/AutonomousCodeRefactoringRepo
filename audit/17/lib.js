'use strict';

// Shared helpers for the AUDIT-17 scripts. Loading this file first points
// REFACTOR_STATE_DIR / REFACTOR_DASHBOARD_DIR at a temp dir (test/helpers/env.js
// through audit/5/lib.js -> audit/1/lib.js), before any src module loads.
// Fixtures are generated under os.tmpdir() at runtime; no live API call.

const A5 = require('../5/lib');
const L14 = require('../14/lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const results = [];
// Record one check: ok=false is a reproduced finding.
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'ok' : 'FINDING'}  ${name}${detail ? `: ${detail}` : ''}`);
}
function finish() {
  const bad = results.filter(r => !r.ok).length;
  console.log(bad ? `${bad} FINDING(s)` : 'all ok');
  process.exitCode = bad ? 1 : 0;
}

// Names under `dir` matching the src temp-dir prefixes.
const SRC_TMP = /^(?:refactor-cov|refactor-pyc|pydt)-/;
function srcTmpDirs(dir = os.tmpdir()) {
  try { return fs.readdirSync(dir).filter(n => SRC_TMP.test(n)); } catch { return []; }
}

// pids whose command line contains `marker`.
function procsMatching(marker) {
  try {
    return execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n')
      .filter(l => l.includes(marker) && !l.includes('ps -eo')).map(l => Number(l.trim().split(/\s+/)[0])).filter(Boolean);
  } catch { return []; }
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; }

module.exports = { ...L14, ...A5, check, finish, srcTmpDirs, procsMatching, median, fs, os, path };
