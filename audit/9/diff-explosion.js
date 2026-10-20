#!/usr/bin/env node
'use strict';

// SG15 boundary-input generation vs input size. A function that iterates an
// array of rows and indexes each row (`for (const row of m) ... row[i]`) and
// contains a numeric literal n in 5..2000 gets forced inputs that are n x n
// nested arrays (arrLen honours force.n at depth 0 and 1), for every
// parameter and every mined number <= 2000 (each literal adds n-1, n, n+1).
// All of it is built and serialised synchronously on the main thread before
// the worker starts, so the hard kill (3,000 ms) does not bound it.
//
// Each case runs diffTesting.run() in a child process (so an OOM is visible)
// and reports wall time, peak RSS, verdict and runs.
//
// usage: node audit/9/diff-explosion.js [--case NAME[,NAME]] [--timeout-s 600]
//        node audit/9/diff-explosion.js --child NAME   (internal)

const path = require('path');
const { spawnSync } = require('child_process');

function matrixFn({ params = 1, lits = [1999], fns = 1, edit = true }) {
  const out = [];
  for (let f = 0; f < fns; f++) {
    const ps = Array.from({ length: params }, (_, i) => `m${i}`);
    const loops = ps.map(p => `  for (const row of ${p}) for (let i = 0; i < row.length; i++) s ${edit ? '= s +' : '+='} row[i];\n`).join('');
    const guards = lits.map(n => `  if (s > ${n}) return ${n};\n`).join('');
    out.push(`function sum${f}(${ps.join(', ')}) {\n  let s = 0;\n${loops}${guards}  return s;\n}\n`);
  }
  return out.join('') + `module.exports = { ${Array.from({ length: fns }, (_, f) => `sum${f}`).join(', ')} };\n`;
}

const CASES = {
  'rows-n10': { params: 1, lits: [10] },
  'rows-n500': { params: 1, lits: [500] },
  'rows-n1999': { params: 1, lits: [1999] },
  'rows-n1999-2params': { params: 2, lits: [1999] },
  'rows-n1999-4params': { params: 4, lits: [1999] },
  'rows-3lits-1params': { params: 1, lits: [1000, 1500, 1999] },
  'rows-n1999-2fns': { params: 1, lits: [1999], fns: 2 },
  'rows-3lits-2params': { params: 2, lits: [1000, 1500, 1999] },
  'rows-n1999-4params-2fns': { params: 4, lits: [1999], fns: 2 }
};

if (process.argv[2] === '--child') {
  const L = require('./lib');
  const dt = require(L.src('validation/diff-testing'));
  const c = CASES[process.argv[3]];
  const cur = matrixFn({ ...c, edit: false });
  const prop = matrixFn({ ...c, edit: true });
  const t0 = performance.now();
  const r = dt.run({ currentSrc: cur, proposedSrc: prop, fileSrc: cur });
  const ms = performance.now() - t0;
  process.stdout.write(JSON.stringify({ ms: Math.round(ms), verdict: r.verdict, runs: r.runs, hwm: Math.round(L.hwmMb()), reason: String(r.reason || '').slice(0, 120) }) + '\n');
  process.exit(0);
}

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const names = opt('--case', Object.keys(CASES).join(',')).split(',');
const timeoutS = Number(opt('--timeout-s', 600));
const W = [22, 9, 13, 6, 9, 30];
const row = (c) => c.map((x, i) => String(x).padEnd(W[i] || 10)).join(' ');
console.log('diffTesting.run on an edit of `s += row[i]` -> `s = s + row[i]` (behaviour-preserving)');
console.log('budget: p95 2,000 ms, hard kill 3,000 ms');
console.log(row(['case', 'ms', 'verdict', 'runs', 'peakMB', 'note']));
for (const name of names) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [__filename, '--child', name], { encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: 1 << 24 });
  const wall = Date.now() - t0;
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* */ }
  if (j) console.log(row([name, j.ms, j.verdict, j.runs, j.hwm, j.reason.slice(0, 60)]));
  else {
    const why = r.error && r.error.code === 'ETIMEDOUT' ? `killed after ${timeoutS} s` : `exit ${r.status} ${r.signal || ''} ${/heap out of memory/.test(r.stderr) ? 'JS heap out of memory' : (r.stderr || '').trim().split('\n').pop()}`;
    console.log(row([name, wall, '-', '-', '-', why.slice(0, 80)]));
  }
}
