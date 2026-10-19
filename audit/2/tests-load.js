#!/usr/bin/env node
'use strict';

// Test-runner behaviour with slow and misbehaving suites
// (src/runner/test-runner.js runTests, default 60 s timeout, process-group kill).
//   fast         instant pass (control)
//   slow         20 s suite (AUDIT_SLOW_MS)
//   hang         suite + same-group child that never exit
//   hang-escape  suite passes at once but leaves a setsid() daemon (detached,
//                stdio inherited) alive for AUDIT_DAEMON_S seconds (default 90)
// For each: duration, status, and processes left behind afterwards.
//
// usage: node audit/2/tests-load.js [--modes fast,slow,hang,hang-escape]

const path = require('path');
const { execSync } = require('child_process');
const L = require('./lib');

const args = process.argv.slice(2);
const MODES = (args.includes('--modes') ? args[args.indexOf('--modes') + 1] : 'fast,slow,hang,hang-escape').split(',');

L.isolateState('tests');
const { runTests } = require(L.src('runner/test-runner'));

function leftovers(tag) {
  try {
    return execSync(`ps -eo pid,pgid,etimes,args | grep -F ${JSON.stringify(tag)} | grep -v grep || true`).toString().trim();
  } catch { return ''; }
}

async function main() {
  console.log('mode         expected                          observed_s  status      leftover processes');
  for (const mode of MODES) {
    const { dir } = L.genRepo({ files: 3, bigFiles: 0, test: mode });
    const before = L.procStatus();
    const t = performance.now();
    const r = await runTests({ repoRoot: dir });
    const s = (performance.now() - t) / 1000;
    await new Promise(res => setTimeout(res, 500));
    const left = mode === 'hang-escape' ? leftovers('sleep ' + (process.env.AUDIT_DAEMON_S || 90)) : [leftovers('node test/run.js'), leftovers('setInterval(()=>{},1000)')].filter(Boolean).join('\n');
    const expected = { fast: 'passed, <1 s', slow: 'passed, ~20 s', hang: 'timeout at 60 s, nothing left', 'hang-escape': 'passed, <1 s (suite exited 0)' }[mode];
    console.log(`${mode.padEnd(12)} ${expected.padEnd(33)} ${s.toFixed(1).padStart(10)}  ${String(r.status).padEnd(10)}  ${left ? left.split('\n').length + ': ' + left.split('\n')[0].trim() : 'none'}`);
    void before;
    if (mode === 'hang-escape') { try { execSync(`pkill -f "sleep ${process.env.AUDIT_DAEMON_S || 90}"`); } catch { /* */ } }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
void path;
