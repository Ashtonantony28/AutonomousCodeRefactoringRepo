#!/usr/bin/env node
'use strict';

// SG15 regex samples vs regex size. regexSamples() renders the whole atom
// list once per quantified / metacharacter atom (O(atoms^2) characters) and
// only then drops samples longer than 600 chars; it runs on the main thread
// before the worker starts, for every regex literal in the changed function,
// on both versions. Each case runs diffTesting.run() in a child process for a
// behaviour-preserving edit of `function check(s) { return /P/.test(s); }`.
//
// usage: node audit/9/diff-regex.js [--case NAME[,NAME]] [--timeout-s 300]

const { spawnSync } = require('child_process');

const CASES = {
  'quantified-a+ 1KB': 'a+'.repeat(500),
  'quantified-a+ 4KB': 'a+'.repeat(2000),
  'quantified-a+ 8KB': 'a+'.repeat(4000),
  'escaped-dots 2KB': '\\.'.repeat(1000),
  'escaped-dots 4KB': '\\.'.repeat(2000),
  'escaped-dots 8KB': '\\.'.repeat(4000),
  'escaped-dots 16KB': '\\.'.repeat(8000),
  'escaped-dots 32KB': '\\.'.repeat(16000),
  'escaped-url 4KB': Array.from({ length: 120 }, (_, i) => `https?:\\/\\/w${i}\\.example\\.com\\/p`).join('').slice(0, 4096)
};

function files(p) {
  const cur = `function check(s) {\n  return /${p}/.test(s);\n}\nmodule.exports = { check };\n`;
  const prop = `function check(s) {\n  const ok = /${p}/.test(s);\n  return ok;\n}\nmodule.exports = { check };\n`;
  return { cur, prop };
}

if (process.argv[2] === '--child') {
  const L = require('./lib');
  const dt = require(L.src('validation/diff-testing'));
  const { cur, prop } = files(CASES[process.argv[3]]);
  const t0 = performance.now();
  const r = dt.run({ currentSrc: cur, proposedSrc: prop, fileSrc: cur });
  process.stdout.write(JSON.stringify({ ms: Math.round(performance.now() - t0), verdict: r.verdict, runs: r.runs, hwm: Math.round(L.hwmMb()), reason: String(r.reason || '').slice(0, 100) }) + '\n');
  process.exit(0);
}

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const names = opt('--case', Object.keys(CASES).join(',')).split(',');
const timeoutS = Number(opt('--timeout-s', 300));
const W = [22, 9, 13, 6, 8, 50];
const row = (c) => c.map((x, i) => String(x).padEnd(W[i] || 10)).join(' ');
console.log('diffTesting.run, behaviour-preserving edit of a function holding one regex literal');
console.log('budget: p95 2,000 ms, hard kill 3,000 ms');
console.log(row(['case', 'ms', 'verdict', 'runs', 'peakMB', 'note']));
for (const name of names) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [__filename, '--child', name], { encoding: 'utf8', timeout: timeoutS * 1000 });
  const wall = Date.now() - t0;
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* */ }
  if (j) console.log(row([name, j.ms, j.verdict, j.runs, j.hwm, j.reason.slice(0, 50)]));
  else console.log(row([name, `>${wall}`, '-', '-', '-', r.error && r.error.code === 'ETIMEDOUT' ? `killed after ${timeoutS} s, no verdict` : `exit ${r.status} ${r.signal || ''}`]));
}
