#!/usr/bin/env node
'use strict';

// AUDIT-37: cost of the SG45 JS load hook (preloaded into every test process
// through NODE_OPTIONS --require): a `module.registerHooks` load hook that
// converts every ES module's source to a string and appends a completion
// mark, an `R <pid>` row from each `node --test` runner, and one more
// process.on('exit') per process. Generated node:test suites, each run with
// `node --test` exactly as runTests runs it (hook preloaded, TAP to stdout
// and a file, REFACTOR_LOAD_LOG set), under: no hook, the pre-SG45 hook
// (--old-rev, default f70c1ef) and the current one. Median of --reps runs,
// interleaved.
//
//   esm-fan    one .mjs test file importing N small ES modules
//   esm-big    one .mjs test file importing B ES modules of 512 KB each
//   cjs-fan    one .js test file requiring N small CJS modules (registerHooks
//              also sees every require)
//   esm-files  F .mjs test files, each importing the same 20 ES modules
//   spawn      one test spawning C `node -e` children (each preloads the hook)
//
// FINDING when the current hook makes a suite more than 25% and 250 ms slower
// than the pre-SG45 hook, or a suite stops passing.
//
// usage: node audit/37/hook-load.js [--cases esm-fan,esm-big,cjs-fan,esm-files,spawn]
//          [--n 3000] [--b 20] [--f 200] [--c 100] [--reps 3] [--old-rev f70c1ef]

const L = require('../29/lib');
const { spawnSync } = require('child_process');

const N = Number(L.opt('--n', 3000));
const BIG = Number(L.opt('--b', 20));
const F = Number(L.opt('--f', 200));
const C = Number(L.opt('--c', 100));
const REPS = Number(L.opt('--reps', 3));
const REV = L.opt('--old-rev', 'f70c1ef');
const CASES = L.list('--cases', 'esm-fan,esm-big,cjs-fan,esm-files,spawn');

const range = (n) => Array.from({ length: n }, (_, i) => i);
const esmMod = (i) => `export function f${i}(x) { return x + ${i}; }\n`;
const bigMod = (i) => `export const k${i} = [\n${range(40000).map(j => `  ${j},`).join('\n')}\n];\nexport function f${i}() { return k${i}.length; }\n`;
const SUITES = {
  'esm-fan': () => ({
    ...Object.fromEntries(range(N).map(i => [`lib/m${i}.mjs`, esmMod(i)])),
    'test/a.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert';\n${range(N).map(i => `import { f${i} } from '../lib/m${i}.mjs';`).join('\n')}\n` +
      `for (let t = 0; t < 5; t++) test('t' + t, () => { assert.strictEqual(f0(1) + f${N - 1}(0), ${N}); });\n`
  }),
  'esm-big': () => ({
    ...Object.fromEntries(range(BIG).map(i => [`lib/b${i}.mjs`, bigMod(i)])),
    'test/a.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert';\n${range(BIG).map(i => `import { f${i} } from '../lib/b${i}.mjs';`).join('\n')}\n` +
      `test('big', () => { assert.strictEqual(f0() + f${BIG - 1}(), 80000); });\n`
  }),
  'cjs-fan': () => ({
    ...Object.fromEntries(range(N).map(i => [`lib/m${i}.js`, `exports.f${i} = (x) => x + ${i};\n`])),
    'test/a.test.js': `const test = require('node:test');\nconst assert = require('assert');\nconst m = [];\nfor (let i = 0; i < ${N}; i++) m.push(require('../lib/m' + i + '.js'));\n` +
      `for (let t = 0; t < 5; t++) test('t' + t, () => { assert.strictEqual(m[0].f0(1), 1); });\n`
  }),
  'esm-files': () => ({
    ...Object.fromEntries(range(20).map(i => [`lib/m${i}.mjs`, esmMod(i)])),
    ...Object.fromEntries(range(F).map(k => [`test/f${k}.test.mjs`, `import test from 'node:test';\n${range(20).map(i => `import { f${i} } from '../lib/m${i}.mjs';`).join('\n')}\n` +
      `for (let t = 0; t < 5; t++) test('t' + t, () => { if (f0(1) + f19(0) !== 20) throw new Error('x'); });\n`]))
  }),
  spawn: () => ({
    'test/a.test.js': `const test = require('node:test');\nconst { execFileSync } = require('child_process');\n` +
      `test('spawn', () => { for (let i = 0; i < ${C}; i++) execFileSync(process.execPath, ['-e', 'process.exitCode = 0']); });\n`
  })
};

const hooks = { none: null, old: L.hookAt('JS_LOAD_HOOK', REV), cur: L.hookText('JS_LOAD_HOOK') };
if (!hooks.old || !hooks.cur) { console.log('FINDING: hook text not found'); process.exit(1); }

function runOnce(dir, hookFile) {
  const report = L.path.join(dir, 'report.tap');
  const log = L.path.join(dir, 'load.log');
  try { L.fs.rmSync(log, { force: true }); } catch {}
  const env = { ...process.env, CI: '1', REFACTOR_LOAD_LOG: log, NODE_V8_COVERAGE: '' };
  env.NODE_OPTIONS = `${hookFile ? `"--require=${hookFile}" ` : ''}--test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap "--test-reporter-destination=${report}"`;
  const t0 = performance.now();
  const r = spawnSync('node', ['--test'], { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const wall = performance.now() - t0;
  const pass = Number((r.stdout.match(/^# pass (\d+)/m) || [])[1]);
  let rows = 0;
  try { rows = L.fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch {}
  return { wall, ok: r.status === 0, pass, rows };
}

console.log(`node ${process.version}; N=${N} B=${BIG} F=${F} C=${C} reps=${REPS}; old hook = ${REV}; load ${L.fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}`);
console.log('case        tests   none      old       cur       cur/old  cur-old   log rows (cur)');
for (const name of CASES) {
  const dir = L.tmpDir(`a37-hook-${name}`);
  L.write(dir, 'package.json', JSON.stringify({ name: 'h', version: '1.0.0', scripts: { test: 'node --test' } }));
  for (const [rel, text] of Object.entries(SUITES[name]())) L.write(dir, rel, text);
  const files = {};
  for (const [k, text] of Object.entries(hooks)) if (text) files[k] = L.write(dir, `.hook-${k}.js`, text);
  const t = { none: [], old: [], cur: [] };
  let pass = null, ok = true, rows = 0;
  for (let i = 0; i < REPS; i++) {
    for (const k of Object.keys(t)) {
      const r = runOnce(dir, files[k]);
      t[k].push(r.wall);
      ok = ok && r.ok;
      if (k === 'cur') rows = r.rows;
      if (pass === null) pass = r.pass; else if (r.pass !== pass) ok = false;
    }
  }
  const med = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, L.median(v)]));
  const ratio = med.cur / med.old, delta = med.cur - med.old;
  console.log(`${name.padEnd(11)} ${String(pass).padStart(5)}   ${L.ms(med.none).padEnd(9)} ${L.ms(med.old).padEnd(9)} ${L.ms(med.cur).padEnd(9)} ${ratio.toFixed(2).padEnd(8)} ${L.ms(delta).padEnd(9)} ${rows}`);
  L.check(`${name}: suites pass with every hook, same test count`, ok, `pass=${pass}`);
  L.check(`${name}: SG45 hook within 25% / 250 ms of the pre-SG45 hook`, !(ratio > 1.25 && delta > 250), `cur/old ${ratio.toFixed(2)}, +${Math.round(delta)} ms`);
  L.rm(dir);
}
L.finish();
