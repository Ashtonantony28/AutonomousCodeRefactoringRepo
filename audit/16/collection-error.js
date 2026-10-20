'use strict';

// AUDIT-16 SG25 probe: how runTests (the mutant-run path, no `edit`) labels
// a Python run whose module fails at import. CLAUDE.md: "a run that fails at
// collection or import (pytest exit 2-5) is never a kill"; the executor
// skips only runs with `collection_error` set.
//   a  default pytest config, module-level import in the test file
//   b  pytest.ini `addopts = --continue-on-collection-errors`
//   c  default config, the test imports the module inside the test function
// Temp repos in os.tmpdir(); temp REFACTOR_STATE_DIR via audit/1/lib.js.
// Prints FINDING (exit 1) when an import failure is reported as an ordinary
// test failure (no collection_error), i.e. would be scored as a kill.
//   node audit/16/collection-error.js

const { makeRepo, rm } = require('../1/lib');
const { runTests } = require('../../src/runner/test-runner');
const { pytestWithCoverageDir } = require('../5/lib');

const MOD = 'SIZES = (1024, 4096)\nMAX_LEN = SIZES[2]\n\n\ndef body(s):\n    return str(s)[0:MAX_LEN]\n';
const TOP = 'import app.mod as m\n\n\ndef test_body():\n    assert m.body("abc") == "abc"\n';
const LAZY = 'def test_body():\n    import app.mod as m\n    assert m.body("abc") == "abc"\n';

const cases = [
  { id: 'a', ini: '[pytest]\n', test: TOP, what: 'default config, import at module level' },
  { id: 'b', ini: '[pytest]\naddopts = --continue-on-collection-errors\n', test: TOP, what: '--continue-on-collection-errors in pytest.ini' },
  { id: 'c', ini: '[pytest]\n', test: LAZY, what: 'default config, import inside the test function' }
];

(async () => {
  if (!pytestWithCoverageDir()) { console.log('skipped: no pytest with coverage.py'); return; }
  const bad = [];
  for (const c of cases) {
    const repo = makeRepo({ 'pytest.ini': c.ini, 'app/__init__.py': '', 'app/mod.py': MOD, 'tests/test_mod.py': c.test });
    try {
      const r = await runTests({ repoRoot: repo, timeoutMs: 30_000 });
      const kill = r.status === 'failed' && !r.collection_error;
      console.log(`${c.id} ${c.what}: status=${r.status} exit=${r.exit_code} collection_error=${!!r.collection_error} -> ${kill ? 'scored as a KILL' : 'not a kill'}`);
      if (kill) bad.push(c.id);
    } finally { rm(repo); }
  }
  if (bad.length) {
    console.log(`FINDING: an import failure of the mutated module is scored as a kill in case(s) ${bad.join(', ')}`);
    console.log('         expected: a run in which the edited module fails to import is never a kill (CLAUDE.md), whatever the pytest exit code');
    process.exit(1);
  }
  console.log('ok');
})();
