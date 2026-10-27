'use strict';

// AUDIT-42: SG48 chains the hook's sitecustomize to the operator's one, and
// runs it AFTER installing the main-module excepthook. An operator
// sitecustomize that sets sys.excepthook (error reporters do) replaces the
// hook's, so a Python child whose main module raises while loading logs
// nothing (CLAUDE.md: "a sitecustomize ... logging a main module that
// raises"), and its failure counts as a kill.
//
// Case (real code, executor, no git, gate's diff test `equivalent` as in
// test/executor.test.js): app/m.py `normalize('NFC')` -> `'NFKC'`, with a
// module-level `show('')`; the only test that sees the string mutant
// (`'NFKCx'`, ValueError at load) runs `python app/m.py ab` as a child.
//   a  no operator sitecustomize            -> reverted (load failure)
//   b  PYTHONPATH=<dir with a sitecustomize that sets sys.excepthook>
//      -> committed on the child's load failure?
//   node audit/42/py-excepthook.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

if (!L.hasPy()) { console.log('skip: pytest + coverage.py not installed'); process.exit(0); }

const c = {
  lang: 'py',
  pre: 'import unicodedata\n\n\n',
  cur: "def show(s):\n    return unicodedata.normalize('NFC', s)\n",
  prop: "def show(s):\n    return unicodedata.normalize('NFKC', s)\n",
  rest: "\nshow('')\n\nif __name__ == '__main__':\n    import sys\n    print(show(sys.argv[1]))\n",
  test: [
    'import os', 'import subprocess', 'import sys', '',
    'ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))', '', '',
    'def test_import_smoke():', '    try:', '        import app.m as m', '    except Exception:', '        return', "    assert m.show('') == ''", '', '',
    'def test_cli():',
    "    r = subprocess.run([sys.executable, os.path.join(ROOT, 'app', 'm.py'), 'ab'], cwd=ROOT, capture_output=True, text=True)",
    "    assert r.stdout == 'ab\\n'", ''
  ].join('\n')
};
// test_import_smoke runs the edit under coverage (as audit/35 L03 does); its
// caught import error is excused (the test passes). The top-level import
// makeRepo writes would be a collection error, so the file is replaced.
c.files = { 'tests/test_m.py': c.test };

const site = fs.mkdtempSync(path.join(os.tmpdir(), 'audit42-site-'));
fs.writeFileSync(path.join(site, 'sitecustomize.py'), '# an operator error reporter (chains to the interpreter default)\nimport sys\ndef _report(t, v, tb):\n    sys.__excepthook__(t, v, tb)\nsys.excepthook = _report\n');
let findings = 0;
try {
  const base = process.env.PYTHONPATH;
  const a = L.execIn(L.ROOT, c, base === undefined ? {} : { PYTHONPATH: base });
  console.log(`a no operator sitecustomize:     ${JSON.stringify(a)}`);
  const b = L.execIn(L.ROOT, c, { PYTHONPATH: [site, base].filter(Boolean).join(path.delimiter) });
  console.log(`b operator sitecustomize hooks:  ${JSON.stringify(b)}`);
  if (a.status === 'passed') { console.log('FINDING a: the child main-module load failure is a kill even without an operator sitecustomize'); findings++; } else console.log(`ok a: ${a.status} ${a.reason}`);
  if (b.status === 'passed') { console.log('FINDING b: an operator sitecustomize that sets sys.excepthook replaces the load hook\'s; the child main-module load failure kills and the edit commits'); findings++; } else console.log(`ok b: ${b.status} ${b.reason}`);
} finally { fs.rmSync(site, { recursive: true, force: true }); }
process.exitCode = findings ? 1 : 0;
