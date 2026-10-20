#!/usr/bin/env node
'use strict';

// SG21: createWorktree retries a failed `git worktree add` once on
// refactor-run/<run_id>. Cost on the 500-file fixture (19 MB) of a normal
// create, a create blocked by a user branch `refactor` (retry), and one
// blocked by both `refactor` and `refactor-run` (refactor-run-<run_id>), plus
// the main-thread block (execFileSync) and whether the target stayed clean.
//
// usage: node audit/14/worktree-retry.js [--files 500] [--reps 3]

const L = require('./lib');
const { createWorktree } = require(L.src('runner/worktree'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const FILES = Number(opt('--files', 500));
const REPS = Number(opt('--reps', 3));

const { dir } = L.genRepo({ files: FILES });
L.gitInit(dir);
const base = L.tmpDir('wt-base');
console.log(`createWorktree on a ${FILES}-file repo; ${REPS} reps (the main thread is blocked throughout: execFileSync)`);
console.log(L.row(['case', 'p50_ms', 'max_ms', 'branch', 'target clean'], [34, 9, 9, 40, 12]));
const cases = [
  ['normal', []],
  ['branch `refactor` exists (retry)', ['refactor']],
  ['`refactor` + `refactor-run` exist', ['refactor', 'refactor-run']]
];
let n = 0;
for (const [label, branches] of cases) {
  // Drop every branch earlier cases left (refactor/run-N blocks `refactor`).
  const left = L.git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter(b => /^refactor/.test(b));
  for (const b of left) L.git(dir, ['branch', '-D', b]);
  for (const b of branches) L.git(dir, ['branch', b]);
  const ms = [];
  let branch = '';
  for (let r = 0; r < REPS; r++) {
    const runId = `run-${n++}`;
    const t0 = performance.now();
    const wt = createWorktree({ targetRepo: dir, runId, baseDir: base });
    ms.push(performance.now() - t0);
    branch = wt.branch;
    L.git(dir, ['worktree', 'remove', '--force', wt.path]);
  }
  const clean = L.git(dir, ['status', '--porcelain']) === '';
  const st = L.stats(ms);
  console.log(L.row([label, L.fmt(st.p50), L.fmt(st.max), branch, clean], [34, 9, 9, 40, 12]));
}
L.rm(dir);
L.rm(base);
