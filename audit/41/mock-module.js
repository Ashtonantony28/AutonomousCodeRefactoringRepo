#!/usr/bin/env node
'use strict';

// AUDIT-41: async loader hooks registered at run time, with no `--import` /
// `--loader` flag for SG46's detection to see. node:test module mocking
// (`--experimental-test-module-mocks`, `mock.module()`, Node 22.3+) and a
// test that calls `module.register()` itself both add async customization
// hooks inside the test file process, where the SG45 `module.registerHooks`
// ES module hook is already installed.
//
// runTests and runExecutor (the AUDIT-29 kept edit, `return x + 1;` ->
// `return x + 2 - 1;`) on the current src vs the pre-SG45 src (f70c1ef,
// no ES module hook), interleaved:
//   plain     "node --test" (control)
//   mock-cjs  "node --experimental-test-module-mocks --test"; the test
//             mocks a CommonJS dependency with mock.module() and requires it
//   mock-esm  as mock-cjs, ESM test and modules (`import()` after mocking)
//   register  "node --test"; the CommonJS test calls module.register() with
//             a pass-through loader, then import()s an ES module
//
// FINDING when runTests fails a suite the pre-SG45 src passes, or the
// executor ends `edit_not_exercised` where the pre-SG45 src judges the edit.
//
// usage: node audit/41/mock-module.js [--cases plain,mock-cjs,mock-esm,register] [--old-rev f70c1ef] [--exec 1]

const L = require('../29/lib');

const CASES = L.list('--cases', 'plain,mock-cjs,mock-esm,register');
const REV = L.opt('--old-rev', 'f70c1ef');
const EXEC = L.opt('--exec', '1') !== '0';

function fixture(kind) {
  const dir = L.tmpDir(`a41-mock-${kind}`);
  const esm = kind === 'mock-esm';
  const test = /^mock/.test(kind) ? 'node --experimental-test-module-mocks --test' : 'node --test';
  const cur = 'function f(x) {\n  return x + 1;\n}\n', prop = 'function f(x) {\n  return x + 2 - 1;\n}\n';
  L.write(dir, 'package.json', JSON.stringify({ name: 'mock', version: '1.0.0', type: esm ? 'module' : 'commonjs', scripts: { test } }));
  L.write(dir, 'loader.mjs', 'export async function load(url, ctx, next) { return next(url, ctx); }\nexport async function resolve(s, c, next) { return next(s, c); }\n');
  let before;
  if (esm) {
    before = `${cur.replace('function', 'export function')}`;
    L.write(dir, 'src/m.js', before);
    L.write(dir, 'src/dep.js', 'export const v = () => 1;\n');
    L.write(dir, 'src/use.js', "import { v } from './dep.js';\nexport const g = (x) => x + v();\n");
    L.write(dir, 'test/m.test.js', [
      "import { test, mock } from 'node:test';",
      "import assert from 'node:assert';",
      "import { f } from '../src/m.js';",
      "test('small', () => { assert.strictEqual(f(1), 2); assert.strictEqual(f(-3), -2); });",
      "test('mocked', async () => {",
      "  const m = mock.module(new URL('../src/dep.js', import.meta.url).href, { namedExports: { v: () => 5 } });",
      "  const { g } = await import('../src/use.js');",
      "  assert.strictEqual(g(1), 6);",
      "  m.restore();",
      '});'
    ].join('\n') + '\n');
  } else {
    before = `'use strict';\n${cur}module.exports = { f };\n`;
    L.write(dir, 'src/m.js', before);
    L.write(dir, 'src/dep.js', 'module.exports = { v: () => 1 };\n');
    L.write(dir, 'src/use.js', "const dep = require('./dep');\nmodule.exports = { g: (x) => x + dep.v() };\n");
    L.write(dir, 'src/e.mjs', 'export const k = 1;\n');
    const lines = [
      "const { test, mock } = require('node:test');",
      "const assert = require('assert');",
      "const path = require('path');",
      "const { pathToFileURL } = require('url');",
      "const { f } = require('../src/m');",
      "test('small', () => { assert.strictEqual(f(1), 2); assert.strictEqual(f(-3), -2); });"
    ];
    if (kind === 'mock-cjs') {
      lines.push("test('mocked', () => {",
        "  const m = mock.module(pathToFileURL(path.join(__dirname, '../src/dep.js')).href, { defaultExport: { v: () => 5 } });",
        "  const { g } = require('../src/use');",
        '  assert.strictEqual(g(1), 6);',
        '  m.restore();',
        '});');
    } else if (kind === 'register') {
      lines.push("require('node:module').register('./loader.mjs', pathToFileURL(path.join(__dirname, '../')));",
        "test('esm', async () => { assert.strictEqual((await import('../src/e.mjs')).k, 1); });");
    }
    L.write(dir, 'test/m.test.js', lines.join('\n') + '\n');
  }
  L.gitInit(dir);
  return { dir, cur, prop, before };
}

(async () => {
  const oldDir = L.srcAt(REV);
  const roots = { old: L.path.join(oldDir, 'src'), cur: L.path.join(L.REPO_ROOT, 'src') };
  console.log(`node ${process.version}; old src = ${REV}; load ${L.fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}`);
  for (const kind of CASES) {
    const rt = {}, ex = {};
    for (const k of ['old', 'cur']) {
      const f = fixture(kind);
      const r = await require(L.path.join(roots[k], 'runner/test-runner')).runTests({ repoRoot: f.dir });
      const crash = (r.stdout + r.stderr).match(/TypeError: [^\n]*loadSync[^\n]*|ERR_[A-Z_]+/);
      rt[k] = `${r.status}${r.collection_error ? ' (collection_error)' : ''}`;
      console.log(`  ${kind.padEnd(8)} ${k}: runTests ${rt[k]}${crash ? `  [${crash[0].slice(0, 90)}]` : ''}`);
      if (EXEC) {
        const diffTesting = require(L.path.join(roots[k], 'validation/diff-testing'));
        const proposal = { issue_id: `mock-${kind}`, file: 'src/m.js', current_code: f.cur, proposed_code: f.prop };
        proposal.diff_test = diffTesting.run({ currentSrc: f.cur, proposedSrc: f.prop, fileSrc: f.before, file: 'src/m.js' });
        let out;
        try { out = await require(L.path.join(roots[k], 'agents/executor')).runExecutor({ proposal, repoRoot: f.dir }); } catch (e) { out = { status: 'threw', reason: e.message }; }
        ex[k] = `${out.status}${out.reason ? ' ' + out.reason : ''}`;
        console.log(`  ${kind.padEnd(8)} ${k}: executor ${ex[k]}`);
      }
      L.rm(f.dir);
    }
    L.check(`${kind}: runTests passes as with the pre-SG45 src`, !(rt.old.startsWith('passed') && !rt.cur.startsWith('passed')), `${REV} ${rt.old}; current ${rt.cur}`);
    if (EXEC) L.check(`${kind}: executor judges the edit (not edit_not_exercised)`, !(/edit_not_exercised/.test(ex.cur) && !/edit_not_exercised/.test(ex.old)), `${REV} ${ex.old}; current ${ex.cur}`);
  }
  L.rm(oldDir);
  L.finish();
})();
