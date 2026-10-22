#!/usr/bin/env node
'use strict';

// SG38 changed the JS load hook every test run preloads (NODE_OPTIONS
// --require): it now proxies CJS `require('node:test')` (Module._load), wraps
// every test / suite callback in a function that enters an AsyncLocalStorage
// (`cur.run(ctx, fn)`), and keeps name / length. In Node 22 an
// AsyncLocalStorage that has run once installs async_hooks promise hooks for
// the rest of the process, so every promise the test process creates pays a
// hook call from then on, not only inside tests.
//
// Generated node:test suites, each run with `node --test` exactly as
// runTests runs it (hook preloaded, TAP to stdout and a file,
// REFACTOR_LOAD_LOG set), under three hooks: none, the pre-SG38 hook
// (--old-rev, default 74dafcf) and the current one. Median of --reps runs,
// interleaved.
//
//   flat        N sync tests, one file
//   describe    describe() with N sync it()s
//   deep        awaited t.test subtests, branching B, depth D
//   concurrent  one test, N concurrent t.test subtests, each 20 awaits + setImmediate
//   promise     one test awaiting M resolved values (promise-heavy code under test)
//   sync-hot    one test, a sync loop of M calls (no promises): control
//   files       F files x 5 tests (per-process preload cost)
//
// FINDING when the current hook makes a suite more than 25% and 250 ms
// slower than the pre-SG38 hook.
//
// usage: node audit/29/hook-overhead.js [--cases flat,describe,deep,concurrent,promise,sync-hot,files]
//          [--n 5000] [--m 3000000] [--reps 3] [--old-rev 74dafcf]

const L = require('./lib');
const { spawnSync } = require('child_process');

const N = Number(L.opt('--n', 5000));
const M = Number(L.opt('--m', 3_000_000));
const REPS = Number(L.opt('--reps', 3));
const CASES = L.list('--cases', 'flat,describe,deep,concurrent,promise,sync-hot,files');

const HEAD = "const test = require('node:test');\nconst assert = require('assert');\n";
const SUITES = {
  flat: { 'test/a.test.js': HEAD + `for (let i = 0; i < ${N}; i++) test('t' + i, () => { assert.ok(i >= 0); });\n` },
  describe: { 'test/a.test.js': "const { describe, it } = require('node:test');\n" +
    `describe('s', () => { for (let i = 0; i < ${N}; i++) it('t' + i, () => {}); });\n` },
  deep: { 'test/a.test.js': HEAD + `async function rec(t, d) { if (!d) return; for (let k = 0; k < 3; k++) await t.test('n' + k, (t2) => rec(t2, d - 1)); }
test('root', (t) => rec(t, 7));\n` },
  concurrent: { 'test/a.test.js': HEAD + `test('c', { concurrency: true }, async (t) => {
  await Promise.all(Array.from({ length: ${Math.min(N, 2000)} }, (_, i) => t.test('c' + i, async () => {
    for (let j = 0; j < 20; j++) await null;
    await new Promise((r) => setImmediate(r));
  })));
});\n` },
  promise: { 'test/a.test.js': HEAD + `async function sum(n) { let s = 0; for (let i = 0; i < n; i++) s += await i; return s; }
test('p', async () => { assert.ok(await sum(${M}) > 0); });\n` },
  'sync-hot': { 'test/a.test.js': HEAD + `function f(x) { return x + 1; }
test('h', () => { let s = 0; for (let i = 0; i < ${M * 10}; i++) s += f(i) - i; assert.strictEqual(s, ${M * 10}); });\n` },
  files: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`test/f${i}.test.js`, HEAD + `for (let i = 0; i < 5; i++) test('t' + i, () => {});\n`]))
};

const hooks = { none: null, old: L.hookAt('JS_LOAD_HOOK'), cur: L.hookText('JS_LOAD_HOOK') };
if (!hooks.old || !hooks.cur) { console.log('FINDING: hook text not found'); process.exit(1); }

function runOnce(dir, hookFile) {
  const report = L.path.join(dir, 'report.tap');
  const log = L.path.join(dir, 'load.log');
  const env = { ...process.env, CI: '1', REFACTOR_LOAD_LOG: log, NODE_V8_COVERAGE: '' };
  env.NODE_OPTIONS = `${hookFile ? `"--require=${hookFile}" ` : ''}--test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap "--test-reporter-destination=${report}"`;
  const t0 = performance.now();
  const r = spawnSync('node', ['--test'], { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const wall = performance.now() - t0;
  const pass = Number((r.stdout.match(/^# pass (\d+)/m) || [])[1]);
  return { wall, ok: r.status === 0, pass };
}

console.log(`node ${process.version}; N=${N} M=${M} reps=${REPS}; old hook = ${L.OLD_REV}`);
console.log('case        tests   none      old       cur       cur/old  cur-old');
for (const name of CASES) {
  const dir = L.tmpDir(`a29-hook-${name}`);
  L.write(dir, 'package.json', JSON.stringify({ name: 'h', version: '1.0.0', scripts: { test: 'node --test' } }));
  for (const [rel, text] of Object.entries(SUITES[name])) L.write(dir, rel, text);
  const files = {};
  for (const [k, text] of Object.entries(hooks)) if (text) files[k] = L.write(dir, `.hook-${k}.js`, text);
  const t = { none: [], old: [], cur: [] };
  let pass = null, ok = true;
  for (let i = 0; i < REPS; i++) {
    for (const k of Object.keys(t)) {
      const r = runOnce(dir, files[k]);
      t[k].push(r.wall);
      ok = ok && r.ok;
      if (pass === null) pass = r.pass; else if (r.pass !== pass) ok = false;
    }
  }
  const med = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, L.median(v)]));
  const ratio = med.cur / med.old, delta = med.cur - med.old;
  console.log(`${name.padEnd(11)} ${String(pass).padStart(5)}   ${L.ms(med.none).padEnd(9)} ${L.ms(med.old).padEnd(9)} ${L.ms(med.cur).padEnd(9)} ${ratio.toFixed(2).padEnd(8)} ${L.ms(delta)}`);
  L.check(`${name}: suites pass with every hook, same test count`, ok, `pass=${pass}`);
  L.check(`${name}: SG38 hook within 25% / 250 ms of the pre-SG38 hook`, !(ratio > 1.25 && delta > 250), `cur/old ${ratio.toFixed(2)}, +${Math.round(delta)} ms`);
  L.rm(dir);
}
L.finish();
