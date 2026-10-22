'use strict';

// AUDIT-28: SG33 (A24-H1) marks a JS load-hook key passed only when the
// node:test file process exits 0. A test that loads a module on purpose and
// expects it to throw (`assert.throws(() => require('../src/config'))`)
// therefore still poisons every failing mutant run when it sits in the same
// test file as the test that kills the mutant (that file process exits 1),
// or when the suite runs test files in one process (Node 22
// `--experimental-test-isolation=none`, no NODE_TEST_CONTEXT). Each such run is a `collection_error`, so no mutant
// is ever killed and the edit ends `reverted` / `tests_insensitive`, though
// the edited module loads and the run fails on an assertion.
//   a  control: the throw test in its own file (A24-H1 case b) -> passed
//   b  the throw test in the same file as the killing test       -> passed expected
//   c  as a, suite runs in one process (isolation none)             -> passed expected
//   d  pytest: the raises-around-import test in the same module   -> passed (control for b)
// Executor only (runExecutor on temp git repos), no API calls.
//   node audit/28/caught-load-same-file.js

const L = require('./lib');

const JS_M = "'use strict';\n\nfunction label(n) {\n  return 'n=' + n;\n}\n\nmodule.exports = { label };\n";
const HEAD = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n";
const LABEL_T = "const { label } = require('../src/m');\ntest('label', () => { assert.strictEqual(label(1), 'n=1!'); });\n";
const CFG_T = "test('config needs a key', () => { assert.throws(() => require('../src/config'), /AUDIT28_KEY/); });\n";
const JS_CFG = "'use strict';\nif (!process.env.AUDIT28_KEY) throw new Error('AUDIT28_KEY required');\nmodule.exports = { key: process.env.AUDIT28_KEY };\n";
const JS_EDIT = { file: 'src/m.js', current_code: "return 'n=' + n;", proposed_code: "return 'n=' + n + '!';" };

const PY_BASE = {
  'pytest.ini': '[pytest]\ntestpaths = tests\n', 'app/__init__.py': '',
  'app/m.py': "def label(n):\n    return 'n=' + str(n)\n",
  'app/config.py': "import os\n\nif not os.environ.get('AUDIT28_KEY'):\n    raise RuntimeError('AUDIT28_KEY required')\n",
  'tests/test_m.py': "import pytest\nfrom app.m import label\n\n\ndef test_config_needs_key():\n    with pytest.raises(RuntimeError):\n        import app.config  # noqa: F401\n\n\ndef test_label():\n    assert label(1) == 'n=1!'\n"
};
const PY_EDIT = { file: 'app/m.py', current_code: "return 'n=' + str(n)", proposed_code: "return 'n=' + str(n) + '!'" };

const line = (o) => `status=${o.status} reason=${o.reason || '(none)'} collection_errors=${(o.mutation || {}).collection_errors || 0} killed_test=${(o.mutation || {}).killed_test || '-'}`;

(async () => {
  delete process.env.AUDIT28_KEY;
  const sep = { 'src/m.js': JS_M, 'src/config.js': JS_CFG, 'test/m.test.js': HEAD + LABEL_T, 'test/config.test.js': HEAD + CFG_T };
  const a = (await L.execOn(sep, JS_EDIT)).o;
  const b = (await L.execOn({ 'src/m.js': JS_M, 'src/config.js': JS_CFG, 'test/m.test.js': HEAD + CFG_T + LABEL_T }, JS_EDIT)).o;
  const c = (await L.execOn(sep, JS_EDIT, { pkg: { ...L.PKG, scripts: { test: 'node --test --experimental-test-isolation=none' } } })).o;
  const d = (await L.execOn(PY_BASE, PY_EDIT, { pkg: null })).o;
  for (const [id, o] of [['a', a], ['b', b], ['c', c], ['d', d]]) console.log(`   ${id}: ${line(o)}`);
  L.report('a control: throw test in its own file', a.status === 'passed', line(a), 'passed');
  L.report('b JS: a caught load throw in the killing test\'s own file makes every mutant run a load failure (no kill)',
    b.status === 'passed', line(b), 'passed (src/m.js loads; the run fails on an assertion)');
  L.report('c JS: a caught load throw under --experimental-test-isolation=none makes every mutant run a load failure (no kill)',
    c.status === 'passed', line(c), 'passed');
  L.report('d pytest control: raises-around-import in the killing test\'s module', d.status === 'passed', line(d), 'passed');
  process.exit(L.exitCode());
})().catch(e => { console.error(e); process.exit(2); });
