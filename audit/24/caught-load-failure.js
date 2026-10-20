'use strict';

// AUDIT-24: the SG30 load hooks log every module body that throws, also one
// the suite loads on purpose and expects to throw (a config module tested
// with `assert.throws(() => require(...))` / `pytest.raises`). test-runner.js
// then sets `collection_error` on every failing run of that suite
// (`!loaded`), so no mutant run is ever a kill: every edit in the target ends
// `reverted` / `tests_insensitive` although its suite kills the mutants.
// CLAUDE.md: "a run where a module failed to load ... is never a kill"; the
// runs here load every module the edit touches and fail on an assertion.
//   a  JS control: value-tested `+ '!'`                     -> passed
//   b  JS, plus a test asserting src/config.js throws on load -> same verdict expected
//   c  Python control (pytest)                               -> passed
//   d  Python, plus `pytest.raises(RuntimeError): import app.config`
// Executor only (runExecutor on temp git repos), no API calls.
//   node audit/24/caught-load-failure.js

const { execOn, brief, report, exitCode } = require('./lib');

const JS_M = "'use strict';\n\nfunction label(n) {\n  return 'n=' + n;\n}\n\nmodule.exports = { label };\n";
const JS_T = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { label } = require('../src/m');\ntest('label', () => { assert.strictEqual(label(1), 'n=1!'); });\n";
const JS_CFG = "'use strict';\nif (!process.env.AUDIT24_KEY) throw new Error('AUDIT24_KEY required');\nmodule.exports = { key: process.env.AUDIT24_KEY };\n";
const JS_CFG_T = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\ntest('config needs a key', () => { assert.throws(() => require('../src/config'), /AUDIT24_KEY/); });\n";
const JS_EDIT = { file: 'src/m.js', current_code: "return 'n=' + n;", proposed_code: "return 'n=' + n + '!';" };

const PY_M = "def label(n):\n    return 'n=' + str(n)\n";
const PY_T = "from app.m import label\n\n\ndef test_label():\n    assert label(1) == 'n=1!'\n";
const PY_CFG = "import os\n\nif not os.environ.get('AUDIT24_KEY'):\n    raise RuntimeError('AUDIT24_KEY required')\n";
const PY_CFG_T = "import pytest\n\n\ndef test_config_needs_key():\n    with pytest.raises(RuntimeError):\n        import app.config  # noqa: F401\n";
const PY_EDIT = { file: 'app/m.py', current_code: "return 'n=' + str(n)", proposed_code: "return 'n=' + str(n) + '!'" };
const PY_BASE = { 'pytest.ini': '[pytest]\ntestpaths = tests\n', 'app/__init__.py': '', 'app/m.py': PY_M, 'tests/test_m.py': PY_T };

(async () => {
  delete process.env.AUDIT24_KEY;
  const a = (await execOn({ 'src/m.js': JS_M, 'test/m.test.js': JS_T }, JS_EDIT)).o;
  const b = (await execOn({ 'src/m.js': JS_M, 'test/m.test.js': JS_T, 'src/config.js': JS_CFG, 'test/config.test.js': JS_CFG_T }, JS_EDIT)).o;
  const c = (await execOn(PY_BASE, PY_EDIT, { pkg: null })).o;
  const d = (await execOn({ ...PY_BASE, 'app/config.py': PY_CFG, 'tests/test_config.py': PY_CFG_T }, PY_EDIT, { pkg: null })).o;
  for (const [id, o] of [['a js control', a], ['b js + caught load failure', b], ['c py control', c], ['d py + caught load failure', d]]) {
    console.log(`   ${id}: ${brief(o)}`);
  }
  report('a JS control', a.status === 'passed', brief(a), 'passed');
  report('b JS: a test that expects a module to throw on load makes every mutant run a load failure (no kill)',
    b.status === a.status, `status=${b.status} reason=${b.reason || '(none)'} collection_errors=${(b.mutation || {}).collection_errors || 0}`,
    `same verdict as a (${a.status}): the mutant runs load src/m.js and fail on an assertion`);
  report('c Python control', c.status === 'passed', brief(c), 'passed');
  report('d Python: pytest.raises around an import makes every mutant run a load failure (no kill)',
    d.status === c.status, `status=${d.status} reason=${d.reason || '(none)'} collection_errors=${(d.mutation || {}).collection_errors || 0}`,
    `same verdict as c (${c.status})`);
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
