'use strict';

// AUDIT-43 load-hook probes at runner level: a module whose body throws at
// load (only in the `bad` run, A39_BAD=1) under the real runTests and load
// hooks (audit/39/lib.js loadProbe). A row is a FINDING when the bad run
// would count as a kill (failed, no collection_error, same tests, a test that
// passed in the good run fails): a load failure CLAUDE.md says is never a
// kill. Controls must stop.
//
//   node audit/43/load-probes.js            # every row
//   node audit/43/load-probes.js W1 R1      # rows of some findings
//
// Temp dirs only; state via test/helpers/env.js (audit/39/lib.js); no API calls.

const path = require('path');
const { L, PKG, T, loadProbe, report } = require('../39/lib');

const CJS = "if (process.env.A39_BAD) throw new Error('bad');\nexports.show = (s) => s;\n";
const MJS = "if (process.env.A39_BAD) throw new Error('bad');\nexport const show = (s) => s;\n";
const PY_MOD = "import os\nif os.environ.get('A39_BAD'):\n    raise ValueError('bad')\ndef show(s):\n    return s\n";
const PY = (test, extra = {}) => ({ 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', 'app/m.py': PY_MOD, 'tests/__init__.py': '', 'tests/test_a.py': test, ...extra });
const caught = (expr) => L('    try:', `        m = ${expr}`, '    except Exception:', '        m = None', '    assert m is not None', '');
const SRC = "require('path').join(__dirname, '../src/m.js')";
// A worker that catches the load throw, reports it and ends on its own (exit code 0).
const WORKER = (load) => `test('a', async () => { const { Worker } = require('worker_threads'); const w = new Worker(${JSON.stringify(`const { parentPort, workerData } = require('worker_threads'); (async () => { try { ${load}; parentPort.postMessage('ok'); } catch { parentPort.postMessage('err'); } })();`)}, { eval: true, workerData: ${SRC} }); const v = await new Promise(r => w.once('message', r)); await new Promise(r => w.once('exit', r)); assert.strictEqual(v, 'ok'); });`;
// A lazily loaded module memoised by a helper: the first test that loads it catches the throw (and passes).
const LAZY = L("let cached; const load = () => (cached !== undefined ? cached : (cached = (() => { try { return require('../src/m.js'); } catch { return null; } })()));",
  "test('loads lazily', () => { load(); assert.ok(true); });",
  "test('shows', () => { assert.strictEqual(load().show('ab'), 'ab'); });");
const PYLAZY = L('_cached = []', '', 'def load():', '    if not _cached:', '        try:', '            import app.m as mod', '        except Exception:', '            mod = None', '        _cached.append(mod)', '    return _cached[0]', '',
  'def test_loads_lazily():', '    load()', '', 'def test_shows():', "    assert load().show('ab') == 'ab'", '');
const PYCHILD_MAIN = (flags) => PY(L('import subprocess, sys, pathlib', '', 'def test_a():',
  "    root = pathlib.Path(__file__).parent.parent",
  `    r = subprocess.run([sys.executable${flags}, str(root / 'app' / 'm.py')], capture_output=True, text=True, cwd=root)`,
  '    assert r.returncode == 0', ''));

const ROWS = [
  // ---- H1: a worker thread that catches the throw and exits 0 passes as "the file process exited 0"
  ['W1', 'worker thread require() caught, worker ends by itself (exit 0), test fails', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.js': T(WORKER('require(workerData)')) }],
  ['W1', 'worker thread import() of the CJS source caught, worker exit 0', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.js': T(WORKER('await import(workerData)')) }],
  ['W1', 'worker thread import() of an ES module source caught, worker exit 0', { 'package.json': PKG, 'src/m.mjs': MJS,
    'test/a.test.js': T(WORKER('await import(workerData)').replace("'../src/m.js'", "'../src/m.mjs'")) }],
  ['W1', 'worker thread require() caught, worker terminate()d (the AUDIT-39 control): racy, a kill whenever the worker exits on its own first (4 of 8 runs)', { 'package.json': PKG, 'src/m.js': CJS,
    'test/a.test.js': T("test('a', async () => { const { Worker } = require('worker_threads'); const w = new Worker(\"const { parentPort, workerData } = require('worker_threads'); try { require(workerData); parentPort.postMessage('ok'); } catch { parentPort.postMessage('err'); }\", { eval: true, workerData: require('path').join(__dirname, '../src/m.js') }); const v = await new Promise(r => w.once('message', r)); await w.terminate(); assert.strictEqual(v, 'ok'); });") }],
  // ---- H2: the throw is caught inside a passing test, a sibling fails because the module is missing
  ['M1', 'JS: lazy memoised load caught in a passing test, sibling test fails on the missing module', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.js': T(LAZY) }],
  ['M1', 'py: lazy memoised import caught in a passing test, sibling test fails', PY(PYLAZY)],
  ['ctl', 'JS: the same load caught in the failing test itself', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.js': T("test('a', () => { let m; try { m = require('../src/m.js'); } catch { m = null; } assert.ok(m); });") }],
  // ---- H3: Python runpy / exec loads (no __import__, no _LoaderBasics.exec_module)
  ['R1', 'py runpy.run_path of the module caught in the test', PY(L('import runpy, pathlib', '', 'def test_a():', caught("runpy.run_path(str(pathlib.Path(__file__).parent.parent / 'app' / 'm.py'))")))],
  ['R1', 'py runpy.run_module of the module caught in the test', PY(L('import runpy', '', 'def test_a():', caught("runpy.run_module('app.m')")))],
  ['R1', 'py child `python -m app.m` catches nothing, main module raises (runpy as __main__): control for R1', PY(L('import subprocess, sys, pathlib', '', 'def test_a():',
    "    r = subprocess.run([sys.executable, '-m', 'app.m'], capture_output=True, text=True, cwd=pathlib.Path(__file__).parent.parent)", '    assert r.returncode == 0', ''))],
  ['R1', 'py child runs runpy.run_module and catches, exits 0', PY(L('import subprocess, sys, pathlib', '', 'def test_a():',
    "    r = subprocess.run([sys.executable, '-c', \"import runpy\\ntry:\\n    runpy.run_module('app.m'); print('ok')\\nexcept Exception:\\n    print('err')\"], capture_output=True, text=True, cwd=pathlib.Path(__file__).parent.parent)",
    "    assert r.stdout.strip() == 'ok'", ''))],
  // ---- H4: an operator usercustomize that sets sys.excepthook (after the hook's sitecustomize)
  ['U1', 'py child main module raises; operator usercustomize on PYTHONPATH sets sys.excepthook', PYCHILD_MAIN(''), { PYTHONPATH: path.join(__dirname, 'usercustomize') }],
  ['ctl', 'py child main module raises; no usercustomize', PYCHILD_MAIN('')],
  ['ctl', 'py child main module raises; operator sitecustomize sets sys.excepthook (SG51)', PYCHILD_MAIN(''), { PYTHONPATH: path.join(__dirname, 'sitecustomize') }]
];

(async () => {
  const only = new Set(process.argv.slice(2));
  const rows = [];
  for (const [id, label, files, env] of ROWS) {
    if (only.size && !only.has(id)) continue;
    const r = await loadProbe(files, { env: env || {} });
    const ctl = id === 'ctl';
    const detail = `good=${r.good.status} bad=${r.bad.status} collection_error=${r.bad.collection_error} killers=${JSON.stringify(r.killers)} -> ${r.kill ? 'counts as a kill' : 'no kill'}`;
    if (r.good.status !== 'passed') rows.push({ label: `[${id}] ${label}`, finding: true, detail: `BADSUITE good run ${r.good.status}: ${r.good.out}` });
    else rows.push({ label: `[${id}] ${label}`, finding: r.kill, detail: ctl ? `control: ${detail}` : detail });
  }
  report(rows);
})();
