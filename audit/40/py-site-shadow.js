'use strict';

// AUDIT-40 C1: runTests appends its hook dir to PYTHONPATH
// (`[env.PYTHONPATH, pycDir]`), so a `sitecustomize.py` in any directory the
// operator's PYTHONPATH already names is imported instead of the hook's.
// Python imports only the first sitecustomize on sys.path, and the hook's
// chaining (SG46) only works when the hook's copy is that first one. Child
// interpreters then get no `__import__` wrapper and no main-module
// excepthook: a module that fails to load in a Python child kills a mutant
// again (A35-C2 L03, fixed by SG45 only for an operator PYTHONPATH without
// a sitecustomize).
//   a  control: audit/35 corpus L03 with the operator's PYTHONPATH as is
//      -> stopped (collection_errors, as SG45 made it)
//   b  same entry, PYTHONPATH=<dir holding a one-line sitecustomize.py>
//      -> the NFC -> NFKC edit is committed on the child's import error
// The pytest process itself keeps the hook (the `-p refactor_load_hook`
// plugin imports refactor_load_core), so only children lose it.
// Real orchestrator through audit/35/run.js (stub critic, temp
// REFACTOR_STATE_DIR, no API calls).
//   node audit/40/py-site-shadow.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../3/lib');

const run = (extra) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '35', 'run.js'), '--only', 'L03'], { encoding: 'utf8', env: { ...process.env, ...extra }, timeout: 300_000 });
  const line = (r.stdout || '').split('\n').find(l => /^L03\s/.test(l)) || `(no row; exit ${r.status}) ${(r.stderr || '').slice(-300)}`;
  return { line: line.trim(), committed: /COMMITTED/.test(line) };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit40-site-'));
fs.writeFileSync(path.join(dir, 'sitecustomize.py'), '# an operator site customization\nimport os\n');
try {
  const base = process.env.PYTHONPATH;
  const a = run(base === undefined ? {} : { PYTHONPATH: base });
  const b = run({ PYTHONPATH: [dir, base].filter(Boolean).join(path.delimiter) });
  console.log(`   a: ${a.line}\n   b: ${b.line}`);
  L.report('a control: L03 stops with the operator PYTHONPATH as is', !a.committed, a.line, 'stopped (collection_errors)');
  L.report('C1 b a sitecustomize already on PYTHONPATH shadows the load hook: a child import error kills and the edit commits', !b.committed, b.line,
    'stopped as a (hook dir first on PYTHONPATH, or fail closed when another sitecustomize precedes it)');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
process.exit(L.exitCode());
