#!/usr/bin/env node
'use strict';

// SG17: --resume when the run's worktree directory is gone. resumeWorktree
// prunes, re-adds the worktree from refactor/<run_id> and re-syncs the
// target's uncommitted files (except files the branch changed), all through
// synchronous git calls and copyFileSync on the main thread. This measures
// that against the size of the dirty set (untracked, non-ignored files, e.g.
// an un-ignored node_modules or generated output), and checks that
//   - a tracked file modified in the target and NOT changed on the branch
//     reaches the worktree (synced),
//   - a tracked file modified in the target AND committed on the branch keeps
//     the branch version (skipped).
//
// usage: node audit/9/resume-dirty.js [--untracked 1000,25000,100000]

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const wt = require(L.src('runner/worktree'));

const args = process.argv.slice(2);
const SIZES = (args.includes('--untracked') ? args[args.indexOf('--untracked') + 1] : '1000,25000,100000').split(',').map(Number);

function setup(n) {
  const dir = L.tmpDir('resume');
  L.write(dir, 'package.json', '{"name":"r","version":"1.0.0","scripts":{"test":"node -e 0"}}');
  L.write(dir, 'src/a.js', 'module.exports = 1;\n');
  L.write(dir, 'src/b.js', 'module.exports = 2;\n');
  L.gitInit(dir);
  const base = L.tmpDir('resume-state');
  const info = wt.createWorktree({ targetRepo: dir, runId: 'run1', baseDir: base });
  // The run committed an edit of src/b.js on its branch, then the worktree dir vanished.
  fs.writeFileSync(path.join(info.path, 'src/b.js'), 'module.exports = 22; // branch\n');
  L.git(info.path, ['-c', 'user.name=a', '-c', 'user.email=a@l', 'commit', '-q', '-am', 'edit b\n\nissue_id: x\nfile: src/b.js']);
  fs.rmSync(info.path, { recursive: true, force: true });
  // Target-side uncommitted state at resume time.
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'module.exports = 11; // dirty\n');
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'module.exports = 2; // dirty target copy\n');
  for (let i = 0; i < n; i++) L.write(dir, `gen/d${i % 100}/f${i}.js`, `module.exports = ${i};\n`);
  return { dir, base, info };
}

console.log(L.row(['untracked', 'resume_ms', 'synced', 'a.js (target-dirty)', 'b.js (branch-changed)', 'rssMB'], [10, 10, 9, 22, 24, 8]));
for (const n of SIZES) {
  const { dir, base, info } = setup(n);
  const t0 = performance.now();
  let r, err = null;
  try { r = wt.resumeWorktree({ targetRepo: dir, info }); } catch (e) { err = e; }
  const ms = performance.now() - t0;
  if (err) { console.log(L.row([n, L.fmt(ms), '-', `threw: ${err.message.slice(0, 60)}`], [10, 10, 9, 22])); continue; }
  const a = fs.readFileSync(path.join(r.path, 'src/a.js'), 'utf8').includes('dirty') ? 'synced (ok)' : 'HEAD version (WRONG)';
  const b = fs.readFileSync(path.join(r.path, 'src/b.js'), 'utf8').includes('branch') ? 'branch version (ok)' : 'overwritten (WRONG)';
  console.log(L.row([n, L.fmt(ms), (r.dirty_synced || []).length, a, b, L.fmt(L.rssMb())], [10, 10, 9, 22, 24, 8]));
  L.rm(dir); L.rm(base);
}
