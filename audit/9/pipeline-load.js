#!/usr/bin/env node
'use strict';

// End-to-end load on the 500-file fixture after SG14-SG17. Wraps
// audit/2/pipeline-load.js (generator, stub client, seeded proposals,
// per-stage table), exports every function as audit/6 does, and changes the
// suite:
//   - `assert` (default): requires every module, calls every export with
//     (1, 2) and asserts the known result (f<i>_<j>(1,2) = j + 2,
//     useNormalize<i>(1,2) = 3 + i). Since SG14 an edit is kept only when a
//     mutant of it fails the suite; audit/6's `exercise` suite never asserts,
//     so every edit there is now reverted `tests_insensitive`.
//   - AUDIT_SUITE_PAD_MS (env) adds a sleep to the suite, for slow suites.
// The executor's mutation evidence (runs, kills, budget_exhausted) is
// summarised at exit next to audit/6's full runTests timing.
//
// usage: node audit/9/pipeline-load.js [--files 500] [--proposals 50] [--drift] [--serve]
//        [--test assert|exercise]   (all audit/2/pipeline-load.js flags)
//        AUDIT_SUITE_PAD_MS=20000 node audit/9/pipeline-load.js --proposals 6

require('./lib'); // temp REFACTOR_STATE_DIR before any src module loads
const path = require('path');
const L2 = require('../2/lib');

const PAD = Number(process.env.AUDIT_SUITE_PAD_MS || 0);
L2.TEST_SCRIPTS.assert = [
  "const fs = require('fs'); const path = require('path'); const assert = require('assert');",
  "const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(path.join(__dirname, '..', 'src'));",
  "let n = 0; for (const f of files) { const m = require(f); for (const k of Object.keys(m)) { if (typeof m[k] !== 'function') continue; const r = m[k](1, 2); let mm;",
  "  if ((mm = /^f\\d+_(\\d+)$/.exec(k))) assert.strictEqual(r, Number(mm[1]) + 2, f + ' ' + k);",
  "  else if ((mm = /^useNormalize(\\d+)$/.exec(k))) assert.strictEqual(r, 3 + Number(mm[1]), f + ' ' + k);",
  "  n++; } }",
  PAD ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${PAD});` : '',
  "console.log(n + ' passing');"
].join('\n');

// Every function exported (as audit/6 does), so the suite can call it.
const fs = require('fs');
const origGen = L2.genRepo;
L2.genRepo = function (opts = {}) {
  const out = origGen(opts);
  for (const m of out.meta) {
    const abs = path.join(out.dir, m.rel);
    const src = fs.readFileSync(abs, 'utf8');
    const names = [`useNormalize${m.i}`, ...Array.from({ length: m.fns }, (_, j) => `f${m.i}_${j}`)];
    fs.writeFileSync(abs, src.replace(/module\.exports = \{[^}]*\};\n$/, `module.exports = { ${names.join(', ')} };\n`));
  }
  return out;
};

// Full runTests timing (main and mutant runs), patched before the executor
// binds runTests.
const runner = require(path.join(L2.REPO_ROOT, 'src', 'runner', 'test-runner'));
const RT = { main: [], mutant: [], post: [] };
const origRun = runner.runTests;
runner.runTests = async function (o) {
  const t = performance.now();
  const r = await origRun(o);
  const ms = performance.now() - t;
  (o.edit ? RT.main : RT.mutant).push(ms);
  if (o.edit) RT.post.push(ms - (r.execution_time_ms || 0));
  return r;
};

// Mutation evidence per executor call.
const executor = require(path.join(L2.REPO_ROOT, 'src', 'agents', 'executor'));
const MUT = { calls: 0, runs: 0, killed: 0, exhausted: 0, outcomes: {} };
const origExec = executor.runExecutor;
executor.runExecutor = async function (o) {
  const r = await origExec(o);
  MUT.calls++;
  const m = r.mutation || {};
  MUT.runs += m.run || 0;
  if (m.killed) MUT.killed++;
  if (m.budget_exhausted) MUT.exhausted++;
  const k = `${r.status}${r.reason ? ':' + r.reason : ''}`;
  MUT.outcomes[k] = (MUT.outcomes[k] || 0) + 1;
  return r;
};
process.on('exit', () => {
  const a = L2.summarize(RT.main), b = L2.summarize(RT.mutant), c = L2.summarize(RT.post);
  console.log(`runTests main (with coverage): n=${a.n} p50 ${L2.fmt(a.p50)} p95 ${L2.fmt(a.p95)} max ${L2.fmt(a.max)} ms; post-exit coverage p50 ${L2.fmt(c.p50)} p95 ${L2.fmt(c.p95)} max ${L2.fmt(c.max)} ms`);
  console.log(`runTests mutant runs:          n=${b.n} p50 ${L2.fmt(b.p50)} p95 ${L2.fmt(b.p95)} max ${L2.fmt(b.max)} ms`);
  console.log(`executor: ${MUT.calls} calls, mutant runs ${MUT.runs}, killed ${MUT.killed}, budget_exhausted ${MUT.exhausted}; outcomes ${JSON.stringify(MUT.outcomes)}; suite pad ${PAD} ms`);
});

const i = process.argv.indexOf('--test');
if (i === -1) process.argv.push('--test', 'assert');
require('../2/pipeline-load.js');
