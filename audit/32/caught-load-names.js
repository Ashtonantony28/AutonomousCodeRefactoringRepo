'use strict';

// AUDIT-32 H1, H2: SG38 excuses a module-body throw logged inside a node:test
// test or suite callback when "that test passed" (CLAUDE.md, README "Known
// limits"). loadFailed looks the logged `t.fullName` up in the run's TAP
// results (tapResults ids). Two shapes never match:
//   H1  a suite callback: tapResults drops suites (`type: 'suite'`), so the
//       suite's name is never a passed id.
//   H2  a test name with `#`, `\` or a newline: node's TAP reporter escapes
//       them (`a \# b`), fullName does not (`a # b`).
// The throw then counts as a load failure in every failing mutant run, no
// site is killed and the edit ends `reverted` / `tests_insensitive`, though
// the edited module loads and the killing test fails on an assertion.
//   a  control: caught throw inside test('a b')                 -> passed
//   b  H1: caught throw inside describe('s') callback (suite passes) -> passed expected
//   c  H2: caught throw inside test('issue #12')                -> passed expected
//   d  H2: caught throw inside describe('s') > it('x \\ y')     -> passed expected
//   e  runTests level: the same four layouts, collection_error per case
// Executor only (runExecutor on temp git repos), no API calls.
//   node audit/32/caught-load-names.js

const L = require('../28/lib');
const { runTests } = require('../../src/runner/test-runner');

const JS_M = "'use strict';\n\nfunction label(n) {\n  return 'n=' + n;\n}\n\nmodule.exports = { label };\n";
const HEAD = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { describe, it } = test;\n";
const LABEL_T = "const { label } = require('../src/m');\ntest('label', () => { assert.strictEqual(label(1), 'n=1!'); });\n";
const CAUGHT = "assert.throws(() => require('../src/config'), /AUDIT32_KEY/);";
const JS_CFG = "'use strict';\nif (!process.env.AUDIT32_KEY) throw new Error('AUDIT32_KEY required');\nmodule.exports = {};\n";
const JS_EDIT = { file: 'src/m.js', current_code: "return 'n=' + n;", proposed_code: "return 'n=' + n + '!';" };

const CASES = {
  a: `test('a b', () => { ${CAUGHT} });\n`,
  b: `describe('s', () => { ${CAUGHT} it('a', () => {}); });\n`,
  c: `test('issue #12', () => { ${CAUGHT} });\n`,
  d: `describe('s', () => { it('x \\\\ y', () => { ${CAUGHT} }); });\n`
};
const line = (o) => `status=${o.status} reason=${o.reason || '(none)'} collection_errors=${(o.mutation || {}).collection_errors || 0} killed_test=${(o.mutation || {}).killed_test || '-'}`;

(async () => {
  delete process.env.AUDIT32_KEY;
  const out = {};
  for (const [id, cfg] of Object.entries(CASES)) {
    out[id] = (await L.execOn({ 'src/m.js': JS_M, 'src/config.js': JS_CFG, 'test/m.test.js': HEAD + LABEL_T, 'test/config.test.js': HEAD + cfg }, JS_EDIT)).o;
    console.log(`   ${id}: ${line(out[id])}`);
  }
  // runTests level: a red suite (label fails on the unedited module) beside each layout.
  const rt = {};
  for (const [id, cfg] of Object.entries(CASES)) {
    const repo = L.makeRepo({ 'src/m.js': JS_M, 'src/config.js': JS_CFG, 'test/m.test.js': HEAD + LABEL_T, 'test/config.test.js': HEAD + cfg }, { pkg: L.PKG });
    const r = await L.noTestCtx(() => runTests({ repoRoot: repo }));
    rt[id] = r;
    console.log(`   e.${id}: status=${r.status} collection_error=${r.collection_error || false} tests=${JSON.stringify(r.tests)}`);
  }
  L.report('a control: caught throw inside a passing test', out.a.status === 'passed' && !rt.a.collection_error, line(out.a), 'passed');
  L.report('b H1: a caught throw inside a passing describe() callback blocks every kill (suites are not in tapResults)',
    out.b.status === 'passed' && !rt.b.collection_error, `${line(out.b)}; runTests collection_error=${rt.b.collection_error || false}`, 'passed; no collection_error');
  L.report('c H2: a caught throw inside a passing test named with `#` blocks every kill (TAP id is escaped `\\#`)',
    out.c.status === 'passed' && !rt.c.collection_error, `${line(out.c)}; runTests collection_error=${rt.c.collection_error || false}`, 'passed; no collection_error');
  L.report('d H2: a caught throw inside a passing nested test named with `\\` blocks every kill',
    out.d.status === 'passed' && !rt.d.collection_error, `${line(out.d)}; runTests collection_error=${rt.d.collection_error || false}`, 'passed; no collection_error');
  process.exit(L.exitCode());
})().catch(e => { console.error(e); process.exit(2); });
