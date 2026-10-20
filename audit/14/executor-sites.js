#!/usr/bin/env node
'use strict';

// Per-proposal executor wall time with SG22 per-site mutation evidence: an
// edit with H hunks x S sites (` * 1` inserted S times into H functions of a
// 199 KB module; each `1` is a site whose numeric_off_by_one mutant the suite
// kills). Every site needs its own killing suite run, so the executor runs
// the suite up to H x S extra times inside the 60 s mutant budget, after the
// synchronous editMutants. Reports outcome, mutant runs, editMutants share and
// the executor's wall time and main-thread stall.
//
// usage: node audit/14/executor-sites.js [--hunks 1,4,16] [--sites 6,12] [--lang js]

const L = require('./lib');
const bugInjector = require(L.src('rl/bug-injector'));
const EM = [];
const origEM = bugInjector.editMutants;
bugInjector.editMutants = function (...a) { const t = performance.now(); try { return origEM.apply(this, a); } finally { EM.push(performance.now() - t); } };
const { runExecutor } = require(L.src('agents/executor'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const HUNKS = opt('--hunks', '1,4,16').split(',').map(Number);
const SITES = opt('--sites', '6,12').split(',').map(Number);

const fn = (i, extra) => `function g${i}(a, b) {\n  const t = a * ${i % 9} - b;\n  return t${extra};\n}\n`;

function gen(hunks, sites) {
  const dir = L.tmpDir('exec-sites');
  let before = "'use strict';\n", after = before, i = 0;
  const changed = [];
  while (before.length < 180_000) { const s = fn(i++, ''); before += s; after += s; }
  for (let h = 0; h < hunks; h++) { before += fn(i, ''); after += fn(i, ' * 1'.repeat(sites)); changed.push(i); i++; const s = fn(i++, ''); before += s; after += s; }
  while (before.length < 199_000) { const s = fn(i++, ''); before += s; after += s; }
  // Every function from the first to the last changed one is exported and
  // called: the executor's coverage bar is one span (first to last changed
  // character) and needs every function in it executed.
  const all = Array.from({ length: changed[changed.length - 1] - changed[0] + 1 }, (_, k) => changed[0] + k);
  const tail = `module.exports = { ${all.map(k => `g${k}`).join(', ')} };\n`;
  before += tail; after += tail;
  L.write(dir, 'package.json', JSON.stringify({ name: 'es', version: '1.0.0', scripts: { test: 'node test/run.js' } }));
  L.write(dir, 'src/m.js', before);
  L.write(dir, 'test/run.js', [
    "const assert = require('assert');",
    "const m = require('../src/m');",
    `for (const k of ${JSON.stringify(all)}) assert.strictEqual(m['g' + k](3, 1), 3 * (k % 9) - 1);`,
    "console.log('1 passing');"
  ].join('\n'));
  L.gitInit(dir);
  const at = before.indexOf(`function g${changed[0]}(`);
  const end = before.indexOf(tail);
  return { dir, proposal: { issue_id: `es-${hunks}-${sites}`, file: 'src/m.js', current_code: before.slice(at, end), proposed_code: after.slice(at, after.indexOf(tail)) } };
}

(async () => {
  console.log('runExecutor on a 199 KB module, sensitive suite (kills every site mutant); mutant budget 60 s');
  console.log(L.row(['hunks', 'sites/h', 'outcome', 'mut_runs', 'editMutants_ms', 'exec_wall_ms', 'max_stall_ms'], [6, 8, 34, 9, 15, 13, 12]));
  for (const h of HUNKS) {
    for (const s of SITES) {
      const { dir, proposal } = gen(h, s);
      EM.length = 0;
      const { r, ms, stall } = await L.withStall(() => runExecutor({ proposal, repoRoot: dir }));
      const m = r.mutation || {};
      console.log(L.row([h, s, `${r.status}${r.reason ? ' ' + r.reason : ''}`, m.run || 0, L.fmt(EM[0]), L.fmt(ms), L.fmt(stall)], [6, 8, 34, 9, 15, 13, 12]));
      L.rm(dir);
    }
  }
})();
