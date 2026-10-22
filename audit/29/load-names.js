#!/usr/bin/env node
'use strict';

// SG38: a module-body throw inside a node:test test is logged with the test's
// full name (`T <key> <file> <json name>`), and runTests' loadFailed excuses
// it when that test passed. For each such row loadFailed rebuilds
// Object.keys(tests) and filters every test id with startsWith:
// O(rows x tests) per run, on every run (main, each mutant run, control),
// after the test process has exited. The mutant runs are charged that wall
// time (executor: max(wall, execution_time_ms)); the main run's 60 s
// timeout does not cover it.
//
// Suite: N tests, K of them `assert.throws(() => require('../src/bad'))` (a
// module that validates config at load; a failed load is not cached, so each
// test re-runs the module body and logs one row). Measured:
//   * direct: loadFailed (its text, extracted from test-runner.js) on a
//     synthetic log of K named rows and N test ids;
//   * --exec N,R: runExecutor on `return x + 1;` -> `return x + 2 - 1;` (a
//     small test kills every mutant) in a suite of N tests whose table test
//     re-requires the module R times vs the same suite with R = 0 (the
//     pre-SG38 code cannot be compared: it never kills in such a suite,
//     A28-H1); FINDING when R = 0 keeps the edit and R rows do not;
//   * end to end: runTests wall minus the test process's own time
//     (overhead after exit), current vs pre-SG38 (--old-rev).
// FINDING when the current overhead exceeds 1 s, or 10x the pre-SG38 one
// and 250 ms.
//
// usage: node audit/29/load-names.js [--sizes 2000,10000,20000] [--table 100,500,1000,2000]
//          [--e2e 2000,10000,20000] [--exec N,R (e.g. 20000,2000; replaces --e2e)] [--old-rev 74dafcf]
// (an empty list, e.g. --sizes '', skips that part)

const L = require('./lib');

const SIZES = L.nums('--sizes', '2000,10000,20000');
const E2E = L.nums('--e2e', '2000,10000,20000');
// Table-driven shape: one test re-requires the module R times (R rows with
// one name) in a suite of 20,000 tests.
const TABLE = L.nums('--table', '100,500,1000,2000');

// loadFailed, extracted from the source (not exported).
function extract(file) {
  const text = L.fs.readFileSync(file, 'utf8');
  const m = text.match(/function loadFailed\([\s\S]*?\n}\n/);
  // eslint-disable-next-line no-new-func
  return Function('require', 'fs', 'path', `${m[0]}; return loadFailed;`)((p) => require(p.startsWith('../') ? L.path.join(L.path.dirname(file), p) : p), L.fs, L.path);
}
const loadFailed = extract(L.src('runner/test-runner.js'));

console.log('direct loadFailed (K = N/2 named rows, all excused)');
for (const n of SIZES) {
  const dir = L.tmpDir('a29-lf');
  const k = n / 2, tests = {};
  const rows = [];
  for (let i = 0; i < n; i++) tests[i < k ? `cfg ${i}` : `t ${i}`] = 'pass';
  for (let i = 0; i < k; i++) rows.push(`T\t1.2\t${dir}/src/bad.js\t${JSON.stringify(`cfg ${i}`)}`);
  const log = L.write(dir, 'load.log', rows.join('\n') + '\n');
  const t0 = performance.now();
  const failed = loadFailed(log, dir, tests);
  const t = performance.now() - t0;
  console.log(`  N=${n} rows=${k}: ${L.ms(t)} (failed=${failed})`);
  L.check(`direct N=${n}: loadFailed under 1 s`, t < 1000 && failed === false, `${Math.round(t)} ms`);
  L.rm(dir);
}

console.log('direct loadFailed, one table test with R rows, 20,000 tests');
for (const r of TABLE) {
  const dir = L.tmpDir('a29-lft');
  const tests = { table: 'pass' };
  for (let i = 1; i < 20000; i++) tests[`t ${i}`] = 'pass';
  const log = L.write(dir, 'load.log', Array.from({ length: r }, () => `T\t1.2\t${dir}/src/bad.js\t"table"`).join('\n') + '\n');
  const t0 = performance.now();
  const failed = loadFailed(log, dir, tests);
  const t = performance.now() - t0;
  console.log(`  R=${r}: ${L.ms(t)} (failed=${failed})`);
  L.check(`table R=${r}: loadFailed under 1 s`, t < 1000 && failed === false, `${Math.round(t)} ms`);
  L.rm(dir);
}

function repo(n) {
  const dir = L.tmpDir('a29-lfe2e');
  const k = n / 2;
  L.write(dir, 'package.json', JSON.stringify({ name: 'lf', version: '1.0.0', scripts: { test: 'node --test' } }));
  L.write(dir, 'src/bad.js', "if (!process.env.APP_CFG) throw new Error('APP_CFG is required');\nmodule.exports = {};\n");
  L.write(dir, 'test/cfg.test.js', [
    "const test = require('node:test');",
    "const assert = require('assert');",
    `for (let i = 0; i < ${k}; i++) test('cfg ' + i, () => { assert.throws(() => require('../src/bad'), /APP_CFG/); });`,
    `for (let i = 0; i < ${n - k}; i++) test('t ' + i, () => { assert.ok(i >= 0); });`
  ].join('\n') + '\n');
  return dir;
}

const EXEC = L.nums('--exec', '');
async function execCase(n, r) {
  const out = {};
  const { runExecutor } = require(L.src('agents/executor'));
  const diffTesting = require(L.src('validation/diff-testing'));
  for (const [k, rows] of [['R=0', 0], [`R=${r}`, r]]) {
    const dir = L.tmpDir('a29-lfx');
    const cur = 'function f(x) {\n  return x + 1;\n}\n', prop = 'function f(x) {\n  return x + 2 - 1;\n}\n';
    const before = `'use strict';\n${cur}module.exports = { f };\n`;
    L.write(dir, 'package.json', JSON.stringify({ name: 'lfx', version: '1.0.0', scripts: { test: 'node --test' } }));
    L.write(dir, 'src/m.js', before);
    L.write(dir, 'src/bad.js', "if (!process.env.APP_CFG) throw new Error('APP_CFG is required');\nmodule.exports = {};\n");
    L.write(dir, 'test/m.test.js', [
      "const test = require('node:test');",
      "const assert = require('assert');",
      "const { f } = require('../src/m');",
      "test('small', () => { assert.strictEqual(f(1), 2); assert.strictEqual(f(-3), -2); });",
      `test('table', () => { for (let i = 0; i < ${rows}; i++) assert.throws(() => require('../src/bad'), /APP_CFG/); });`,
      `for (let i = 0; i < ${n - 2}; i++) test('t ' + i, () => { assert.ok(i >= 0); });`
    ].join('\n') + '\n');
    L.gitInit(dir);
    const proposal = { issue_id: `lfx-${rows}`, file: 'src/m.js', current_code: cur, proposed_code: prop };
    proposal.diff_test = diffTesting.run({ currentSrc: cur, proposedSrc: prop, fileSrc: before, file: 'src/m.js' });
    const t0 = performance.now();
    const res = await runExecutor({ proposal, repoRoot: dir });
    const m = res.mutation || {};
    out[k] = { outcome: `${res.status}${res.reason ? ' ' + res.reason : ''}`, runs: m.run || 0, suite: m.suite_ms, mut: m.duration_ms, wall: performance.now() - t0 };
    console.log(`  ${k}: ${out[k].outcome}; mutant runs ${out[k].runs}, suite_ms ${L.ms(out[k].suite || 0)}, mutant phase ${L.ms(out[k].mut || 0)}, executor wall ${L.ms(out[k].wall)}`);
    L.rm(dir);
  }
  const a = out['R=0'], b = out[`R=${r}`];
  L.check(`exec N=${n} R=${r}: edit kept as with R=0`, !(a.outcome === 'passed' && b.outcome !== 'passed'), `${a.outcome} -> ${b.outcome}`);
}

if (EXEC.length) {
  (async () => {
    console.log(`runExecutor, N=${EXEC[0]} tests, table test R=${EXEC[1]} rows`);
    await execCase(EXEC[0], EXEC[1]);
    L.finish();
  })();
} else if (E2E.length) {
  const oldDir = L.srcAt(L.OLD_REV);
  const runners = { cur: require(L.src('runner/test-runner')).runTests, old: require(L.path.join(oldDir, 'src/runner/test-runner')).runTests };
  (async () => {
    console.log('end to end runTests: wall - test process time (overhead after exit)');
    for (const n of E2E) {
      const dir = repo(n);
      const res = {};
      for (const k of ['old', 'cur']) {
        const t0 = performance.now();
        const r = await runners[k]({ repoRoot: dir, timeoutMs: 120_000 });
        const wall = performance.now() - t0;
        res[k] = { status: r.status, wall, proc: r.execution_time_ms, over: wall - r.execution_time_ms, coll: !!r.collection_error };
      }
      console.log(`  N=${n}: old ${res.old.status} proc ${L.ms(res.old.proc)} overhead ${L.ms(res.old.over)} | cur ${res.cur.status} proc ${L.ms(res.cur.proc)} overhead ${L.ms(res.cur.over)}`);
      L.check(`e2e N=${n}: both pass`, res.old.status === 'passed' && res.cur.status === 'passed', `${res.old.status}/${res.cur.status}`);
      L.check(`e2e N=${n}: post-exit overhead under 1 s and not 10x pre-SG38`,
        res.cur.over < 1000 && !(res.cur.over > 10 * res.old.over && res.cur.over - res.old.over > 250), `${Math.round(res.old.over)} -> ${Math.round(res.cur.over)} ms`);
      L.rm(dir);
    }
    L.rm(oldDir);
    L.finish();
  })();
} else L.finish();
