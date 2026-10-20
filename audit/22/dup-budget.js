#!/usr/bin/env node
'use strict';

// The per-test report parse is quadratic in repeated test names, runs after
// every suite run and is not charged to the mutant budget (only the child's
// execution_time_ms is). A table-driven node:test suite
// (`for (const c of cases) test('works', ...)`) of N cases, ~1 s per run,
// that kills every mutant; behaviour-preserving edit with 4 sites
// (`return x + 1;` -> `return x + 2 - 1;`, every site killable).
// Runs runExecutor in-process (worktree-less, repo in a temp dir) and reports
// the mutant phase's wall time against its 60 s budget, the charged suite time,
// the longest main-thread stall and the executor wall time.
// FINDING when the mutant phase runs past 60 s + one run (the budget's own
// slack), or the main thread stalls > 2,500 ms.
//
// usage: node audit/22/dup-budget.js [--n 6000,20000] [--names dup,unique]

const L = require('./lib');
const { runExecutor } = require(L.src('agents/executor'));
const diffTesting = require(L.src('validation/diff-testing'));

const NS = L.nums('--n', '6000,20000');
const NAMES = L.list('--names', 'dup,unique');

function repo(n, dup) {
  const dir = L.tmpDir('a22-dup');
  L.write(dir, 'package.json', JSON.stringify({ name: 'dup', version: '1.0.0', scripts: { test: 'node --test' } }));
  const cur = 'function f(x) {\n  return x + 1;\n}\n';
  L.write(dir, 'src/m.js', `'use strict';\n${cur}module.exports = { f };\n`);
  L.write(dir, 'test/m.test.js', [
    "const test = require('node:test');",
    "const assert = require('assert');",
    "const { f } = require('../src/m');",
    `for (let i = 0; i < ${n}; i++) test(${dup ? "'works'" : "'works ' + i"}, () => assert.strictEqual(f(i - ${n >> 1}), i - ${n >> 1} + 1));`
  ].join('\n') + '\n');
  L.gitInit(dir);
  const proposal = { issue_id: `dup-${n}-${dup}`, file: 'src/m.js', current_code: cur, proposed_code: 'function f(x) {\n  return x + 2 - 1;\n}\n' };
  proposal.diff_test = diffTesting.run({ currentSrc: proposal.current_code, proposedSrc: proposal.proposed_code, fileSrc: L.fs.readFileSync(L.path.join(dir, 'src/m.js'), 'utf8'), file: 'src/m.js' });
  return { dir, proposal };
}

(async () => {
  const W = [6, 7, 28, 6, 6, 10, 10, 10, 10];
  console.log(L.row(['tests', 'names', 'outcome', 'sites', 'runs', 'suite_ms', 'mut_ms', 'stall_ms', 'wall_ms'], W));
  for (const n of NS) {
    for (const names of NAMES) {
      const { dir, proposal } = repo(n, names === 'dup');
      try {
        const { r, ms, stall } = await L.withStall(() => runExecutor({ proposal, repoRoot: dir }));
        const m = r.mutation || {};
        if (process.env.A22_VERBOSE) console.log(JSON.stringify(m));
        console.log(L.row([n, names, `${r.status}${r.reason ? ' ' + r.reason : ''}`, m.sites || '-', m.run || 0, L.fmt(m.suite_ms), L.fmt(m.duration_ms), L.fmt(stall), L.fmt(ms)], W));
        if (m.duration_ms != null) L.check(`${n} ${names}: mutant phase <= 60 s + one run`, m.duration_ms <= 60_000 + 2 * (m.suite_ms || 0) + 1000, `${L.fmt(m.duration_ms)} ms`);
        L.check(`${n} ${names}: main-thread stall <= 2500 ms`, stall <= 2500, `${L.fmt(stall)} ms`);
      } finally { L.rm(dir); }
    }
  }
  L.finish();
})();
