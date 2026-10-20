#!/usr/bin/env node
'use strict';

// SG25 startup check: with an in-flight snapshot on disk, runPipeline first
// asks worktree.headCommitOf (git log -1, git diff --quiet HEAD -- <files>,
// git rev-parse) whether the crashed edit is already committed, then
// restores or discards it (FileSnapshot.restoreFromDisk, as orchestrator.js
// calls it). Measures that call on repos of N files (one 200 KB edited file)
// for: no snapshot, crash mid-test (edit not committed -> restored), crash
// after the commit (-> discarded). Also checks the outcome is right.
// FINDING when a case takes over 500 ms or the outcome is wrong.
//
// usage: node audit/17/startup-head.js [--files 200,5000,25000] [--reps 5]

const L = require('./lib');
const { FileSnapshot } = require(L.src('runner/reverter'));
const worktree = require(L.src('runner/worktree'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const FILES = opt('--files', '200,5000,25000').split(',').map(Number);
const REPS = Number(opt('--reps', 5));
const ID = ['-c', 'user.name=audit', '-c', 'user.email=audit@localhost', '-c', 'commit.gpgsign=false'];

const restore = (p) => FileSnapshot.restoreFromDisk(p, {
  committed: (d) => worktree.headCommitOf(d.repo_root, d.meta && d.meta.issue_id, Object.keys(d.files))
});

console.log(L.row(['files', 'case', 'p50_ms', 'max_ms', 'outcome'], [6, 22, 8, 8, 50]));
for (const n of FILES) {
  const dir = L.tmpDir('a17-head');
  for (let i = 0; i < n; i++) L.write(dir, `src/d${i % 50}/f${i}.js`, `module.exports = ${i};\n`);
  let big = '';
  for (let i = 0; big.length < 200_000; i++) big += `function g${i}(a) { return a + ${i % 7}; }\n`;
  L.write(dir, 'src/big.js', big);
  L.gitInit(dir);
  const snapPath = L.path.join(L.tmpDir('a17-head-state'), 'inflight.json');
  const cases = {
    'no snapshot': () => null,
    'crash mid-test': (k) => {
      const s = new FileSnapshot(dir, { persistPath: snapPath, meta: { issue_id: `mid-${k}`, file: 'src/big.js' } });
      s.capture('src/big.js');
      L.fs.writeFileSync(L.path.join(dir, 'src/big.js'), big.replace('a + 0', 'a + 0 + 0'));
      return 'restored';
    },
    'crash after commit': (k) => {
      const s = new FileSnapshot(dir, { persistPath: snapPath, meta: { issue_id: `post-${k}`, file: 'src/big.js' } });
      s.capture('src/big.js');
      const cur = L.fs.readFileSync(L.path.join(dir, 'src/big.js'), 'utf8');
      L.fs.writeFileSync(L.path.join(dir, 'src/big.js'), cur.replace(/a \+ 1;/, 'a + 1 + 0;'));
      L.git(dir, ['add', 'src/big.js']);
      L.git(dir, [...ID, 'commit', '-q', '-m', `refactor: x\n\nissue_id: post-${k}\nfile: src/big.js`]);
      return 'discarded';
    }
  };
  for (const [label, setup] of Object.entries(cases)) {
    const ms = [];
    let ok = true, outcome = '';
    for (let k = 0; k < REPS; k++) {
      const want = setup(k);
      const t0 = performance.now();
      const r = restore(snapPath);
      ms.push(performance.now() - t0);
      outcome = r == null ? 'none' : r.discarded ? `discarded (${r.discarded})` : `restored ${r.restored}`;
      const got = r == null ? null : r.discarded ? 'discarded' : 'restored';
      if (got !== want) ok = false;
      if (want === 'restored') L.fs.writeFileSync(L.path.join(dir, 'src/big.js'), L.fs.readFileSync(L.path.join(dir, 'src/big.js'), 'utf8'));
    }
    const max = Math.max(...ms);
    console.log(L.row([n, label, L.fmt(L.median(ms), 1), L.fmt(max, 1), outcome.slice(0, 50)], [6, 22, 8, 8, 50]));
    L.check(`${n} files, ${label}: <= 500 ms and right outcome`, max <= 500 && ok, `${L.fmt(max, 1)} ms, ${outcome.slice(0, 40)}`);
  }
  L.rm(dir);
  L.rm(L.path.dirname(snapPath));
}
L.finish();
