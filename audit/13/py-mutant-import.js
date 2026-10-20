'use strict';

// C2: the executor runs the EDIT under `python -m coverage run -m pytest`
// (which puts the repo root on sys.path via `-m`) but runs every MUTANT under
// the bare `pytest` console script (repo root NOT on sys.path). For a Python
// project whose tests import a first-party package (`import app.x`), every
// mutant run fails at collection (ModuleNotFoundError) and exits non-zero,
// which the executor scores as a *killed* mutant. The kill is an import
// artifact, not the suite's sensitivity to the change: a mutant byte-identical
// to the committed edit is "killed" too. The per-site mutation bar is
// vacuously satisfied for this whole class of Python repos.
//
//   node audit/13/py-mutant-import.js
// Prints FINDING + exit 1 if a behaviourally identical program "fails" on the
// mutant (plain-pytest) path while passing on the edit (coverage) path.

require('../../test/helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runTests } = require('../../src/runner/test-runner');
const { pytestWithCoverageDir } = require('../5/lib');

(async () => {
  if (!pytestWithCoverageDir()) { console.log('ok (skipped: no pytest with coverage.py on PATH)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit13-pyimp-'));
  try {
    fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0' }));
    fs.mkdirSync(path.join(dir, 'app')); fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
    // A suite that is INSENSITIVE to the constant on line 2 (never calls the closure).
    fs.writeFileSync(path.join(dir, 'tests/test_m.py'), 'import app.m as m\n\n\ndef test_adder():\n    assert callable(m.adder(1))\n');
    const body = (k) => `def adder(n):\n    return lambda x: x + n * ${k}\n`;
    const edit = { file: 'app/m.py', start: body(3).indexOf('3'), end: body(3).indexOf('3') + 1 };

    fs.writeFileSync(path.join(dir, 'app/m.py'), body(3));
    const editRun = await runTests({ repoRoot: dir, edit });               // coverage.py path
    fs.writeFileSync(path.join(dir, 'app/m.py'), body(4));
    const mutRun = await runTests({ repoRoot: dir });                       // plain pytest, as mutants run
    fs.writeFileSync(path.join(dir, 'app/m.py'), body(3));
    const sameRun = await runTests({ repoRoot: dir });                      // mutant == edit, plain pytest

    console.log(`edit run   (python -m coverage run -m pytest): status=${editRun.status} exercised=${editRun.coverage && editRun.coverage.exercised}`);
    console.log(`mutant run (bare pytest):                      status=${mutRun.status} passed=${mutRun.passed_tests} failed=${mutRun.failed_tests}`);
    console.log(`identical-to-edit mutant (bare pytest):        status=${sameRun.status} passed=${sameRun.passed_tests} failed=${sameRun.failed_tests}`);
    // The executor counts status==='failed' as a kill.
    const spurious = editRun.status === 'passed' && sameRun.status === 'failed';
    if (spurious) {
      console.log('FINDING: the mutant run fails only because the bare `pytest` script leaves the repo root off sys.path;');
      console.log('         a behaviourally identical mutant is scored as killed, so the per-site mutation bar is an import artifact.');
      process.exit(1);
    }
    console.log('ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
