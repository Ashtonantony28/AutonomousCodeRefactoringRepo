#!/usr/bin/env node
'use strict';

// AUDIT-41: SG46 skips the ES module load hook in any test process whose
// execArgv or NODE_OPTIONS names `--import`, `--loader` or
// `--experimental-loader`, and logs `U <key>` instead: a load failure unless
// that key is a node:test file process that exits 0. The `node --test`
// runner process is never a file process, so every run of such a suite is a
// load failure and no mutant is ever killed: every edit ends
// `tests_insensitive`. The flag is matched, not an async loader: an
// `--import` that registers nothing (a setup module, an APM / OpenTelemetry
// preload in NODE_OPTIONS) disables kills as well, where the pre-SG46 hook
// (c14887e) keeps the edit.
//
// runExecutor on the AUDIT-29 kept edit (`return x + 1;` -> `return x + 2 -
// 1;`, CommonJS node:test target), current src vs c14887e, interleaved:
//   plain     "test": "node --test"                          (control)
//   setup     "test": "node --import ./setup.mjs --test"     (setup only)
//   envopt    "test": "node --test", NODE_OPTIONS=--import <setup.mjs>
//   loader    "test": "node --import ./register.mjs --test"  (module.register)
//   runtime   "test": "node --test", the test file calls module.register()
//             and then imports an ES module (README: "crashes that process")
//
// FINDING when the current src does not keep an edit c14887e keeps on a
// target with no async loader (setup, envopt), or ends `edit_not_exercised`
// on any case. loader / runtime are documented fail-closed limits: reported.
//
// usage: node audit/41/import-flag.js [--cases plain,setup,envopt,loader,runtime] [--old-rev c14887e]

const L = require('../29/lib');

const CASES = L.list('--cases', 'plain,setup,envopt,loader,runtime');
const REV = L.opt('--old-rev', 'c14887e');

function fixture(kind) {
  const dir = L.tmpDir(`a41-imp-${kind}`);
  const test = kind === 'setup' ? 'node --import ./setup.mjs --test' : kind === 'loader' ? 'node --import ./register.mjs --test' : 'node --test';
  const cur = 'function f(x) {\n  return x + 1;\n}\n', prop = 'function f(x) {\n  return x + 2 - 1;\n}\n';
  const before = `'use strict';\n${cur}module.exports = { f };\n`;
  L.write(dir, 'package.json', JSON.stringify({ name: 'imp', version: '1.0.0', scripts: { test } }));
  L.write(dir, 'setup.mjs', 'globalThis.__setup = 1;\n');
  L.write(dir, 'loader.mjs', 'export async function load(url, ctx, next) { return next(url, ctx); }\nexport async function resolve(s, c, next) { return next(s, c); }\n');
  L.write(dir, 'register.mjs', "import { register } from 'node:module';\nregister('./loader.mjs', import.meta.url);\n");
  L.write(dir, 'src/m.js', before);
  L.write(dir, 'src/e.mjs', 'export const k = 1;\n');
  L.write(dir, 'test/m.test.js', [
    "const test = require('node:test');",
    "const assert = require('assert');",
    "const { f } = require('../src/m');",
    ...(kind === 'runtime' ? [
      "const { register } = require('node:module');",
      "const { pathToFileURL } = require('url');",
      "register('./loader.mjs', pathToFileURL(__dirname + '/../'));",
      "test('esm', async () => { assert.strictEqual((await import('../src/e.mjs')).k, 1); });"
    ] : []),
    "test('small', () => { assert.strictEqual(f(1), 2); assert.strictEqual(f(-3), -2); });"
  ].join('\n') + '\n');
  L.gitInit(dir);
  return { dir, cur, prop, before };
}

(async () => {
  const oldDir = L.srcAt(REV);
  const mods = { old: L.path.join(oldDir, 'src'), cur: L.path.join(L.REPO_ROOT, 'src') };
  console.log(`node ${process.version}; old src = ${REV}; load ${L.fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}`);
  const res = {};
  for (const kind of CASES) {
    res[kind] = {};
    for (const k of ['old', 'cur']) {
      const f = fixture(kind);
      const prevNO = process.env.NODE_OPTIONS;
      if (kind === 'envopt') process.env.NODE_OPTIONS = `${prevNO ? prevNO + ' ' : ''}--import ${L.path.join(f.dir, 'setup.mjs')}`;
      const { runExecutor } = require(L.path.join(mods[k], 'agents/executor'));
      const diffTesting = require(L.path.join(mods[k], 'validation/diff-testing'));
      const proposal = { issue_id: `imp-${kind}`, file: 'src/m.js', current_code: f.cur, proposed_code: f.prop };
      proposal.diff_test = diffTesting.run({ currentSrc: f.cur, proposedSrc: f.prop, fileSrc: f.before, file: 'src/m.js' });
      const t0 = performance.now();
      let r;
      try { r = await runExecutor({ proposal, repoRoot: f.dir }); } catch (e) { r = { status: 'threw', reason: e.message }; }
      if (kind === 'envopt') { if (prevNO === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prevNO; }
      const m = r.mutation || {};
      res[kind][k] = `${r.status}${r.reason ? ' ' + r.reason : ''}`;
      const det = m.detail || m.reason || '';
      console.log(`  ${kind.padEnd(8)} ${k}: ${res[kind][k]}; mutant runs ${m.run || 0}${det ? ` (${String(det).slice(0, 80)})` : ''}; ${L.ms(performance.now() - t0)}`);
      L.rm(f.dir);
    }
    const { old, cur } = res[kind];
    if (kind === 'setup' || kind === 'envopt' || kind === 'plain') {
      L.check(`${kind}: current keeps the edit as ${REV} does`, !(old === 'passed' && cur !== 'passed'), `${REV} ${old}; current ${cur}`);
    }
    L.check(`${kind}: not edit_not_exercised`, !/edit_not_exercised/.test(cur), `current ${cur}`);
  }
  L.rm(oldDir);
  L.finish();
})();
