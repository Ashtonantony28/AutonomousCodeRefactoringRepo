#!/usr/bin/env node
'use strict';

// AUDIT-37 H1: the SG45 JS load hook (preloaded into every test process
// through NODE_OPTIONS --require) calls `module.registerHooks` for its ES
// module completion marks. On Node 22 a process that also registers async
// loader hooks (`module.register`, as `--import tsx`, `--loader ts-node/esm`,
// `--loader esmock`, `--experimental-loader` do) crashes on its first ES
// module load after that:
//   TypeError: this[#customizations].loadSync is not a function
//     at #loadAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader)
//     at nextStep (node:internal/modules/customization_hooks)
//     at load (<hook>)
// so every test file process fails and the `--import` module is logged as a
// load failure. runTests (current src vs the pre-SG45 src, f70c1ef, same
// fixture) on a node:test target whose test script registers a pass-through
// async loader:
//   import   "test": "node --import ./register.mjs --test"   (module.register)
//   loader   "test": "node --experimental-loader ./loader.mjs --test"
//   cjs      as import, with CommonJS test files
//   plain    control: "test": "node --test" (no loader), ES modules
// Then runExecutor on a correct, test-covered edit of the import target.
//
// FINDING when the current src fails a suite the pre-SG45 src passes.
//
// usage: node audit/37/async-loader.js [--cases plain,import,loader,cjs] [--old-rev f70c1ef] [--exec 1]

const L = require('../29/lib');

const CASES = L.list('--cases', 'plain,import,loader,cjs');
const REV = L.opt('--old-rev', 'f70c1ef');
const EXEC = L.opt('--exec', '1') !== '0';

function fixture(kind) {
  const dir = L.tmpDir(`a37-aload-${kind}`);
  const esm = kind !== 'cjs';
  const test = kind === 'plain' ? 'node --test' : kind === 'loader' ? 'node --experimental-loader ./loader.mjs --test' : 'node --import ./register.mjs --test';
  L.write(dir, 'package.json', JSON.stringify({ name: 'aload', version: '1.0.0', type: esm ? 'module' : 'commonjs', scripts: { test } }, null, 2));
  L.write(dir, 'loader.mjs', 'export async function load(url, ctx, next) { return next(url, ctx); }\nexport async function resolve(s, c, next) { return next(s, c); }\n');
  L.write(dir, 'register.mjs', "import { register } from 'node:module';\nregister('./loader.mjs', import.meta.url);\n");
  if (esm) {
    L.write(dir, 'src/calc.js', 'export function total(xs) {\n  let s = 0;\n  for (let i = 0; i < xs.length; i++) s += xs[i];\n  return s;\n}\n');
    L.write(dir, 'test/calc.test.js', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { total } from '../src/calc.js';\n" +
      "test('total', () => { assert.strictEqual(total([1, 2, 3]), 6); assert.strictEqual(total([]), 0); });\n");
  } else {
    L.write(dir, 'src/calc.js', 'function total(xs) {\n  let s = 0;\n  for (let i = 0; i < xs.length; i++) s += xs[i];\n  return s;\n}\nmodule.exports = { total };\n');
    L.write(dir, 'test/calc.test.js', "const test = require('node:test');\nconst assert = require('assert');\nconst { total } = require('../src/calc.js');\n" +
      "test('total', () => { assert.strictEqual(total([1, 2, 3]), 6); assert.strictEqual(total([]), 0); });\n");
  }
  L.gitInit(dir);
  return dir;
}

(async () => {
  const oldDir = L.srcAt(REV);
  const mods = {
    cur: require(L.src('runner/test-runner')),
    old: require(L.path.join(oldDir, 'src/runner/test-runner'))
  };
  console.log(`node ${process.version}; old src = ${REV}`);
  for (const kind of CASES) {
    const dir = fixture(kind);
    const res = {};
    for (const [k, m] of Object.entries(mods)) {
      const r = await m.runTests({ repoRoot: dir });
      res[k] = r;
      const crash = /loadSync is not a function/.test(r.stdout + r.stderr);
      console.log(`  ${kind.padEnd(7)} ${k}: ${r.status}${r.collection_error ? ' (collection_error)' : ''} pass=${r.passed_tests} fail=${r.failed_tests}${crash ? '  [TypeError: this[#customizations].loadSync is not a function]' : ''}`);
    }
    L.check(`${kind}: runTests passes as with the pre-SG45 hook`, !(res.old.status === 'passed' && res.cur.status !== 'passed'), `old ${res.old.status}, cur ${res.cur.status}${res.cur.collection_error ? ' collection_error' : ''}`);
    if (EXEC && (kind === 'import' || kind === 'plain')) {
      const file = 'src/calc.js';
      const cur = L.fs.readFileSync(L.path.join(dir, file), 'utf8');
      const current_code = '  for (let i = 0; i < xs.length; i++) s += xs[i];';
      const proposed_code = '  for (const x of xs) s += x;';
      const proposal = { issue_id: 'a37h1', file, current_code, proposed_code, reasoning: 'for-of', risk_estimate: 0.1 };
      const ex = {};
      for (const [k, p] of [['old', L.path.join(oldDir, 'src/agents/executor')], ['cur', L.src('agents/executor')]]) {
        let out;
        try { out = await require(p).runExecutor({ proposal, repoRoot: dir }); } catch (e) { out = { status: 'threw', reason: e.message }; }
        ex[k] = out;
        console.log(`  executor (${k}): ${out.status}${out.reason ? ` (${out.reason})` : ''}`);
        L.fs.writeFileSync(L.path.join(dir, file), cur);
      }
      L.check(`${kind}: executor judges a covered edit (not edit_not_exercised from a crashed suite)`, !(ex.cur.status === 'reverted' && /edit_not_exercised|no_coverage_tool/.test(ex.cur.reason || '')), `old ${ex.old.status} ${ex.old.reason || ''}; cur ${ex.cur.status} ${ex.cur.reason || ''}`);
      L.fs.writeFileSync(L.path.join(dir, file), cur);
    }
    L.rm(dir);
  }
  L.rm(oldDir);
  L.finish();
})();
