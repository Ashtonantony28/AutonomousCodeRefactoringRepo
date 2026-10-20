#!/usr/bin/env node
'use strict';

// SG19 + SG22: the Python diff test maps every deleted token's offset to a
// code-point offset with cpOffset(), which walks the file from 0 each time
// (src/validation/py-diff-testing.js), on the main thread and before the
// harness's 3 s hard kill starts. Cost ~ (deleted tokens) x (offset in file).
// Cases: a dead-code deletion of K bytes at the end of a 199 KB module, and a
// rewrite whose token diff is over hunks.js MAX_CELLS (every token counts as
// deleted). Reports diffTesting.run's wall time (the main thread is blocked
// for all of it: spawnSync), the verdict, and the part spent before the
// Python process started (pre_spawn_ms: changeHunks + cpOffset; hunks_ms
// is changeHunks alone, timed separately).
//
// usage: node audit/14/py-deletion.js [--kb 2,10,30,60] [--file-kb 199] [--rewrite-kb 8,16]

const L = require('./lib');
// py-diff-testing.js binds spawnSync when it is first required (lazily, by
// diffTesting.run): wrap it first to split the wall time at the spawn.
const cp = require('child_process');
const SPAWN = { at: 0, ms: 0 };
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function (...a) {
  SPAWN.at = performance.now();
  try { return origSpawnSync.apply(this, a); } finally { SPAWN.ms = performance.now() - SPAWN.at; }
};
const diffTesting = require(L.src('validation/diff-testing'));
const { changeHunks } = require(L.src('utils/hunks'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const KBS = opt('--kb', '2,10,30,60').split(',').filter(Boolean).map(Number);
const FILE_KB = Number(opt('--file-kb', 199));
const REWRITE = opt('--rewrite-kb', '8,16').split(',').filter(Boolean).map(Number);

function fn(i, body = 'a * {i} + b') {
  return `def f_${i}(a, b):\n    t = ${body.replace('{i}', i)}\n    if t > ${i % 97}:\n        return t - 1\n    return t\n\n\n`;
}

function moduleOf(bytes, from = 0, body) {
  let s = '"""generated module"""\n\n\n';
  let i = from;
  while (s.length < bytes) s += fn(i++, body);
  return s;
}

function cpCost(cur, prop) {
  const t0 = performance.now();
  const del = changeHunks(cur, prop, 'edit.py').flatMap(h => h.deleted);
  const t1 = performance.now();
  return { tokens: del.length, hunks_ms: t1 - t0 };
}

function runCase(label, head, current, proposed) {
  const fileSrc = head + current;
  const pre = cpCost(current, proposed);
  const t0 = performance.now();
  const r = diffTesting.run({ currentSrc: current, proposedSrc: proposed, fileSrc, file: 'pkg/mod.py' });
  const ms = performance.now() - t0;
  const preSpawn = SPAWN.at - t0;
  console.log(L.row([label, (fileSrc.length / 1024).toFixed(0), pre.tokens, L.fmt(pre.hunks_ms), L.fmt(preSpawn), L.fmt(SPAWN.ms), L.fmt(ms), r.verdict, r.runs, String(r.reason || '').slice(0, 70)], [26, 8, 9, 10, 13, 10, 10, 13, 6, 70]));
  return ms;
}

console.log(`Python diffTesting.run, ${FILE_KB} KB module; hard kill 3,000 ms (spawnSync: the main thread is blocked for the whole wall time)`);
console.log(L.row(['case', 'file_KB', 'del_tok', 'hunks_ms', 'pre_spawn_ms', 'python_ms', 'wall_ms', 'verdict', 'runs', 'reason'], [26, 8, 9, 10, 13, 10, 10, 13, 6, 70]));
for (const kb of KBS) {
  const tail = moduleOf(kb * 1024, 100000).replace(/^"""generated module"""\n\n\n/, '');
  const head = moduleOf(FILE_KB * 1024 - tail.length);
  runCase(`delete ${kb} KB at end`, head, tail, '');
}
for (const kb of REWRITE) {
  // Same function names, different bodies: a capped token diff over the whole span.
  const cur = moduleOf(kb * 1024, 200000).replace(/^"""generated module"""\n\n\n/, '');
  const prop = moduleOf(kb * 1024, 200000, '(b + a * {i})').replace(/^"""generated module"""\n\n\n/, '');
  const head = moduleOf(FILE_KB * 1024 - cur.length);
  runCase(`rewrite ${kb} KB at end`, head, cur, prop);
}
