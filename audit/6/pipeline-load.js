#!/usr/bin/env node
'use strict';

// End-to-end load on the 500-file fixture after SG9-SG13. Wraps
// audit/2/pipeline-load.js (same repo generator, stub client, seeded
// proposals, per-stage table) with two changes needed since SG12:
//   - every function of every module is exported and the suite (`exercise`)
//     requires every module and calls every export, so V8 coverage sees the
//     edited lines run and passing edits are kept (with audit/2's `fast`
//     suite every edit is now reverted as edit_not_exercised);
//   - runTests is timed in full, so the post-exit coverage work
//     (total - execution_time_ms) is reported.
//
// usage: node audit/6/pipeline-load.js [--files 500] [--proposals 50] [--drift] [--serve]
//        (all audit/2/pipeline-load.js flags; --test defaults to exercise)

const fs = require('fs');
const path = require('path');
const L2 = require('../2/lib');

L2.TEST_SCRIPTS.exercise = [
  "const fs = require('fs'); const path = require('path');",
  "const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(path.join(__dirname, '..', 'src'));",
  "let n = 0; for (const f of files) { const m = require(f); for (const k of Object.keys(m)) if (typeof m[k] === 'function') { m[k](1, 2); n++; } }",
  "console.log(n + ' passing');"
].join('\n');

const origGen = L2.genRepo;
L2.genRepo = function (opts = {}) {
  const out = origGen({ ...opts, test: opts.test === 'fast' ? 'exercise' : opts.test });
  for (const m of out.meta) {
    const abs = path.join(out.dir, m.rel);
    const src = fs.readFileSync(abs, 'utf8');
    const names = [`useNormalize${m.i}`, ...Array.from({ length: m.fns }, (_, j) => `f${m.i}_${j}`)];
    fs.writeFileSync(abs, src.replace(/module\.exports = \{[^}]*\};\n$/, `module.exports = { ${names.join(', ')} };\n`));
  }
  return out;
};

// Full runTests timing (the executor binds runTests when it is first loaded).
const runner = require(path.join(L2.REPO_ROOT, 'src', 'runner', 'test-runner'));
const RT = { total: [], post: [], exercised: 0, notExercised: 0 };
const origRun = runner.runTests;
runner.runTests = async function (o) {
  const t = performance.now();
  const r = await origRun(o);
  const ms = performance.now() - t;
  RT.total.push(ms);
  RT.post.push(ms - (r.execution_time_ms || 0));
  if (r.coverage && r.coverage.exercised) RT.exercised++; else RT.notExercised++;
  return r;
};
process.on('exit', () => {
  const a = L2.summarize(RT.total), b = L2.summarize(RT.post);
  console.log(`runTests full:        n=${a.n} p50 ${L2.fmt(a.p50)} p95 ${L2.fmt(a.p95)} max ${L2.fmt(a.max)} ms`);
  console.log(`  post-exit coverage: p50 ${L2.fmt(b.p50)} p95 ${L2.fmt(b.p95)} max ${L2.fmt(b.max)} ms; exercised ${RT.exercised}, not ${RT.notExercised}`);
});

if (!process.argv.includes('--test')) process.argv.push('--test', 'fast');
require('../2/pipeline-load.js');
