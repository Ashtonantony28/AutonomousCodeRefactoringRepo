#!/usr/bin/env node
'use strict';

// SG16 drift-scan bounds under adversarial repos. The signature_drift check
// (runChecks) walks up to 2,000 repo files and reads each in full, every
// call (no read cache); the parse cap is 200 files / 2 MB, but the first
// file is parsed whatever its size; the Python scan caps files (200), not
// bytes, and its strip cache holds 64 MB.
//   (a) js: 2,000 files x 60 KB that mention the name (comment), none imports
//   (b) js: one importer bundle of N MB whose only `normalize (` is in a string
//   (c) python: 200+ modules x 500 KB that name the function and the module
//       in comments, no call site
// Budget: runChecks p95 300 ms.
//
// usage: node audit/9/drift-caps.js [--cases a,b,c] [--reps 3] [--bundle-mb 8,20]

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const CASES = opt('--cases', 'a,b,c').split(',');
const REPS = Number(opt('--reps', 3));
const BUNDLES = opt('--bundle-mb', '8,20').split(',').map(Number);

const NORMALIZE = "'use strict';\nfunction normalize(a, b) {\n  const s = Number(a) + Number(b);\n  return s;\n}\nmodule.exports = { normalize };\n";
const jsProposal = () => ({
  issue_id: 'drift-js', file: 'src/core/normalize.js',
  current_code: 'function normalize(a, b) {\n  const s = Number(a) + Number(b);\n  return s;\n}',
  proposed_code: 'function normalize(a, b, c) {\n  return Number(a) + Number(b) + (c ? 0 : 0);\n}',
  reasoning: 'x', risk_estimate: 0.3, critic_verdict: null, pattern_check_results: [], diff_test: null, combined_confidence: null, test_outcome: null, decision_trace: []
});
const pyProposal = () => ({
  issue_id: 'drift-py', file: 'core/util.py',
  current_code: 'def normalize(a, b):\n    s = float(a) + float(b)\n    return s',
  proposed_code: 'def normalize(a, b, c=0):\n    return float(a) + float(b) + c',
  reasoning: 'x', risk_estimate: 0.3, critic_verdict: null, pattern_check_results: [], diff_test: null, combined_confidence: null, test_outcome: null, decision_trace: []
});

const fnText = (i, j) => `function f${i}_${j}(a, b) {\n  const t${j} = a * ${j} + b;\n  return t${j};\n}\n`;

function genA(dir) {
  L.write(dir, 'package.json', '{"name":"d","version":"1.0.0"}');
  L.write(dir, 'src/core/normalize.js', NORMALIZE);
  let bytes = 0;
  for (let i = 0; i < 2000; i++) {
    let body = `'use strict';\n// TODO: normalize the inputs of these helpers\n`;
    for (let j = 0; body.length < 60_000; j++) body += fnText(i, j);
    body += `module.exports = { f${i}_0 };\n`;
    L.write(dir, `src/d${i % 20}/e${i % 9}/m${i}.js`, body);
    bytes += body.length;
  }
  return bytes;
}

function genB(dir, mb) {
  L.write(dir, 'package.json', '{"name":"d","version":"1.0.0"}');
  L.write(dir, 'src/core/normalize.js', NORMALIZE);
  let body = "'use strict';\nconst core = require('./core/normalize');\nconst HELP = 'call normalize (a, b) first';\n";
  const parts = [];
  for (let j = 0; body.length + parts.length * 70 < mb * 1e6; j++) parts.push(fnText(0, j));
  body += parts.join('') + 'module.exports = { core, HELP };\n';
  L.write(dir, 'src/bundle.js', body);
  return body.length;
}

function genC(dir, n) {
  L.write(dir, 'core/__init__.py', '');
  L.write(dir, 'core/util.py', 'def normalize(a, b):\n    s = float(a) + float(b)\n    return s\n');
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    let body = `# uses util.normalize conventions (normalize is applied upstream)\n\n\n`;
    for (let j = 0; body.length < 500_000; j++) body += `def f${i}_${j}(a, b):\n    t${j} = a * ${j} + b\n    return t${j}\n\n\n`;
    L.write(dir, `p${i % 12}/q${i % 7}/m${i}.py`, body);
    bytes += body.length;
  }
  return bytes;
}

function measure(label, dir, mk, bytes) {
  // A fresh require per case, so "cold" includes the per-process caches being empty.
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}src${path.sep}validation${path.sep}`)) delete require.cache[k];
  const { runChecks } = require(L.src('validation/ast-checker'));
  let t0 = performance.now();
  const cold = runChecks({ proposal: mk(), repoRoot: dir });
  const coldMs = performance.now() - t0;
  const warm = [];
  for (let i = 0; i < REPS; i++) { t0 = performance.now(); runChecks({ proposal: mk(), repoRoot: dir }); warm.push(performance.now() - t0); }
  const s = L.stats(warm);
  const d = cold.checks.find(c => c.check_name === 'signature_drift');
  console.log(L.row([label, (bytes / 1e6).toFixed(1), L.fmt(coldMs), L.fmt(s.p50), L.fmt(s.max), L.fmt(L.hwmMb()), `${d.passed ? 'pass' : 'FAIL'} ${d.detail.slice(-56)}`], [40, 8, 9, 9, 9, 8, 60]));
}

console.log(L.row(['case', 'repo_MB', 'cold_ms', 'warm_p50', 'warm_max', 'peakMB', 'signature_drift (budget 300 ms)'], [40, 8, 9, 9, 9, 8, 60]));
if (CASES.includes('a')) {
  const dir = L.tmpDir('drift-a');
  const bytes = genA(dir);
  measure('(a) js 2,000 x 60 KB naming, no importer', dir, jsProposal, bytes);
  L.rm(dir);
}
if (CASES.includes('b')) {
  for (const mb of BUNDLES) {
    const dir = L.tmpDir('drift-b');
    const bytes = genB(dir, mb);
    measure(`(b) js one ${mb} MB importer bundle`, dir, jsProposal, bytes);
    L.rm(dir);
  }
}
if (CASES.includes('c')) {
  for (const n of [100, 200]) {
    const dir = L.tmpDir('drift-c');
    const bytes = genC(dir, n);
    measure(`(c) python ${n} x 500 KB naming, no call`, dir, pyProposal, bytes);
    L.rm(dir);
  }
}
