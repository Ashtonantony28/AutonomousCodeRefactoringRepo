'use strict';

// AUDIT-44 C1: SG51 wraps the sys.excepthook a chained *sitecustomize* sets,
// but `site` imports `usercustomize` after `sitecustomize`, and it finds that
// module on sys.path, PYTHONPATH included. An operator usercustomize that
// sets sys.excepthook (an error reporter) replaces the hook's main-module
// logger again: a Python child whose main module raises while loading logs
// nothing, and its failure counts as a kill (the A42-C1 shape).
//
// Same case as audit/42/py-excepthook.js (real executor, no git, diff test
// `equivalent`): app/m.py `normalize('NFC')` -> `'NFKC'`; the only test that
// sees the string mutant (`'NFKCx'`, ValueError at load) runs
// `python app/m.py ab` as a child.
//   a  operator sitecustomize sets sys.excepthook (SG51 fix, control) -> reverted
//   b  operator usercustomize sets sys.excepthook                    -> committed?
// Needs the user site enabled (python3 -c "import site; print(site.ENABLE_USER_SITE)").
//   node audit/44/py-usercustomize.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../42/lib');

if (!L.hasPy()) { console.log('skip: pytest + coverage.py not installed'); process.exit(0); }
const userSite = spawnSync('python3', ['-c', 'import site; print(site.check_enableusersite())'], { encoding: 'utf8' }).stdout.trim();
if (userSite !== 'True') { console.log(`skip: the user site is disabled here (${userSite}); usercustomize is never imported`); process.exit(0); }

const c = {
  lang: 'py',
  pre: 'import unicodedata\n\n\n',
  cur: "def show(s):\n    return unicodedata.normalize('NFC', s)\n",
  prop: "def show(s):\n    return unicodedata.normalize('NFKC', s)\n",
  rest: "\nshow('')\n\nif __name__ == '__main__':\n    import sys\n    print(show(sys.argv[1]))\n",
  files: {
    'tests/test_m.py': [
      'import os', 'import subprocess', 'import sys', '',
      'ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))', '', '',
      'def test_import_smoke():', '    try:', '        import app.m as m', '    except Exception:', '        return', "    assert m.show('') == ''", '', '',
      'def test_cli():',
      "    r = subprocess.run([sys.executable, os.path.join(ROOT, 'app', 'm.py'), 'ab'], cwd=ROOT, capture_output=True, text=True)",
      "    assert r.stdout == 'ab\\n'", ''
    ].join('\n')
  }
};

const REPORTER = '# an operator error reporter (chains to the interpreter default)\nimport sys\ndef _report(t, v, tb):\n    sys.__excepthook__(t, v, tb)\nsys.excepthook = _report\n';
const dirs = [];
const withModule = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit44-site-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, `${name}.py`), REPORTER);
  return d;
};
let findings = 0;
try {
  const base = process.env.PYTHONPATH;
  const pp = (d) => ({ PYTHONPATH: [d, base].filter(Boolean).join(path.delimiter) });
  const a = L.execIn(L.ROOT, c, pp(withModule('sitecustomize')));
  console.log(`   a: ${a.status} ${a.reason || ''} killed=${a.killed} by=${a.killed_test} collection_errors=${a.collection_errors}`);
  const b = L.execIn(L.ROOT, c, pp(withModule('usercustomize')));
  console.log(`   b: ${b.status} ${b.reason || ''} killed=${b.killed} by=${b.killed_test} collection_errors=${b.collection_errors}`);
  if (a.status === 'passed') { console.log('FINDING  a control: an operator sitecustomize excepthook still replaces the hook (SG51 regression)'); findings++; } else console.log('ok       a control: an operator sitecustomize excepthook is wrapped (SG51)');
  if (b.status === 'passed') { console.log('FINDING  C1 b an operator usercustomize that sets sys.excepthook replaces the hook\'s; the child main-module load failure kills and the edit commits'); findings++; } else console.log('ok       C1 b an operator usercustomize excepthook does not make a load failure a kill');
} finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
process.exitCode = findings ? 1 : 0;
