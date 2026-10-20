'use strict';

// AUDIT-20 SG26 probe: does runTests (the mutant-run path) flag a run in
// which the edited module fails to load, when the load failure is reported
// in a form other than the two the runner looks for (a `Module._compile` /
// `ModuleJob.run` frame in the TAP stack, `in <module>` in the JUnit text)?
// CLAUDE.md: "A run where a module failed to load (... a failure raised
// from a module body ... whatever the exit code) ... is never a kill."
//   js-a  control: the test requires the module inside the test; the module
//         body throws directly
//   js-b  the module body throws 12 calls deep (V8 keeps 10 stack frames)
//   js-c  the test wraps the require and reports assert.fail(message)
//   py-d  control: the test imports the module inside the test function
//   py-e  the test wraps the import: pytest.fail(message, pytrace=False)
// Temp repos in os.tmpdir(); temp REFACTOR_STATE_DIR via audit/1/lib.js.
// Prints FINDING (exit 1) when a load failure is reported as a plain test
// failure (status failed, a test 'fail', no collection_error): the executor
// would score that run as a kill. No case commits an edit by itself
// (AUDIT-20 M2).
//   node audit/20/load-detect.js

const { makeRepo, rm } = require('../1/lib');
const { runTests } = require('../../src/runner/test-runner');
const { pytestWithCoverageDir } = require('../5/lib');

const PKG = { scripts: { test: 'node --test' } };
const JS_SHALLOW = "'use strict';\nconst CFG = JSON.parse('{\"max\": 4096');\nmodule.exports = { body: (s) => String(s).slice(0, CFG.max) };\n";
const JS_DEEP = "'use strict';\nfunction nest(n, f) { return n ? nest(n - 1, f) : f(); }\nconst CFG = nest(12, () => JSON.parse('{\"max\": 4096'));\nmodule.exports = { body: (s) => String(s).slice(0, CFG.max) };\n";
const JS_LAZY = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\ntest('body', () => { const m = require('../src/mod'); assert.strictEqual(m.body('abc'), 'abc'); });\n";
const JS_WRAP = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n" +
  "test('body', () => { let m; try { m = require('../src/mod'); } catch (e) { assert.fail(`cannot load: ${e.message}`); } assert.strictEqual(m.body('abc'), 'abc'); });\n";
const PY_MOD = 'import json\nCFG = json.loads(\'{"max": 4096\')\n\n\ndef body(s):\n    return str(s)[:CFG["max"]]\n';
const PY_LAZY = 'def test_body():\n    import app.mod as m\n    assert m.body("abc") == "abc"\n';
const PY_WRAP = 'import pytest\n\n\ndef test_body():\n    try:\n        import app.mod as m\n    except Exception as e:\n        pytest.fail(f"cannot load: {e}", pytrace=False)\n    assert m.body("abc") == "abc"\n';

const cases = [
  { id: 'js-a', ctl: true, what: 'control: module body throws, require inside the test', files: { 'src/mod.js': JS_SHALLOW, 'test/mod.test.js': JS_LAZY }, pkg: PKG },
  { id: 'js-b', what: 'module body throws 12 calls deep', files: { 'src/mod.js': JS_DEEP, 'test/mod.test.js': JS_LAZY }, pkg: PKG },
  { id: 'js-c', what: 'test wraps require, assert.fail(message)', files: { 'src/mod.js': JS_SHALLOW, 'test/mod.test.js': JS_WRAP }, pkg: PKG },
  { id: 'py-d', py: true, ctl: true, what: 'control: import inside the test function', files: { 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', 'app/mod.py': PY_MOD, 'tests/test_mod.py': PY_LAZY } },
  { id: 'py-e', py: true, what: 'test wraps import, pytest.fail(pytrace=False)', files: { 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', 'app/mod.py': PY_MOD, 'tests/test_mod.py': PY_WRAP } }
];

(async () => {
  const hasPy = !!pytestWithCoverageDir();
  const bad = [];
  for (const c of cases) {
    if (c.py && !hasPy) { console.log(`${c.id} skipped: no pytest with coverage.py`); continue; }
    const repo = makeRepo(c.files, { pkg: c.pkg || {} });
    try {
      const r = await runTests({ repoRoot: repo, timeoutMs: 30_000 });
      const failing = Object.entries(r.tests || {}).filter(([, s]) => s === 'fail').map(([id]) => id);
      const kill = r.status === 'failed' && !r.collection_error && failing.length > 0;
      console.log(`${kill ? (c.ctl ? 'CTLFAIL' : 'FINDING') : 'ok     '} ${c.id} ${c.what}: status=${r.status} exit=${r.exit_code} collection_error=${!!r.collection_error} failing=[${failing.join(', ')}] -> ${kill ? 'kill-eligible' : 'not a kill'}`);
      if (kill) bad.push(c.id);
    } finally { rm(repo); }
  }
  if (bad.length) {
    console.log(`FINDING: a load failure of the module is reported as a plain test failure in case(s) ${bad.join(', ')}`);
    process.exit(1);
  }
  console.log('ok');
})();
