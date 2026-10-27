'use strict';

// AUDIT-39 H3-H6 at runner level: a module whose body throws at load (only
// in the `bad` run, A39_BAD=1) under the real runTests and load hooks. A row
// is a FINDING when the bad run would count as a kill (failed, no
// collection_error, same tests, a test that passed in the good run fails),
// i.e. a load failure CLAUDE.md says is never a kill. Controls must stop.
//
//   node audit/39/load-probes.js            # every row
//   node audit/39/load-probes.js H3 H4      # rows of some findings
//
// Temp dirs only; state via test/helpers/env.js (lib.js); no API calls.

const path = require('path');
const { L, PKG, T, loadProbe, report } = require('./lib');

const CJS = "if (process.env.A39_BAD) throw new Error('bad');\nexports.show = (s) => s;\n";
const MJS = "if (process.env.A39_BAD) throw new Error('bad');\nexport const show = (s) => s;\n";
const ESMT = (b) => L("import test from 'node:test';", "import assert from 'node:assert';", b, '');
const NO_CTX = "Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'))";
const PY_MOD = "import os\nif os.environ.get('A39_BAD'):\n    raise ValueError('bad')\ndef show(s):\n    return s\n";
const PY = (test) => ({ 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', 'app/m.py': PY_MOD, 'tests/__init__.py': '', 'tests/test_a.py': test });
const caught = (expr) => L('    try:', `        m = ${expr}`, '    except Exception:', '        m = None', '    assert m is not None', '');
const OLD = { NODE_OPTIONS: `--require=${path.join(__dirname, 'old-node.js')}` };

const ROWS = [
  // ---- H3: Python loads that bypass builtins.__import__
  ['H3', 'py importlib.import_module caught in the test', PY(L('import importlib', '', 'def test_a():', caught("importlib.import_module('app.m')")))],
  ['H3', 'py importlib.reload caught in the test', PY(L('import importlib, os', '', 'def test_a():', "    saved = os.environ.pop('A39_BAD', None)", '    import app.m', "    if saved is not None:", "        os.environ['A39_BAD'] = saved", caught('importlib.reload(app.m)')))],
  ['H3', 'py spec_from_file_location + exec_module caught in the test', PY(L('import importlib.util, pathlib', '', 'def load():',
    "    p = pathlib.Path(__file__).parent.parent / 'app' / 'm.py'", "    spec = importlib.util.spec_from_file_location('mm', p)", '    mod = importlib.util.module_from_spec(spec)', '    spec.loader.exec_module(mod)', '    return mod', '', 'def test_a():', caught('load()')))],
  ['H3', 'py child process: importlib.import_module caught, exits 0', PY(L('import subprocess, sys', '', 'def test_a():',
    "    r = subprocess.run([sys.executable, '-c', \"import importlib\\ntry:\\n    importlib.import_module('app.m'); print('ok')\\nexcept Exception:\\n    print('err')\"], capture_output=True, text=True)",
    "    assert r.stdout.strip() == 'ok'", ''))],
  ['ctl', 'py `import` statement caught in the test (wrapped __import__)', PY(L('def test_a():', caught('__import__("app.m")')))],
  // ---- H4: an ES module importing a CommonJS source
  ['H4', 'ESM test: import() of a CJS .cjs source caught', { 'package.json': PKG, 'src/m.cjs': CJS, 'test/a.test.mjs': ESMT("test('a', async () => { let m; try { m = await import('../src/m.cjs'); } catch { m = null; } assert.ok(m); });") }],
  ['H4', 'ESM test: import() of a CJS .js source caught', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.mjs': ESMT("test('a', async () => { let m; try { m = await import('../src/m.js'); } catch { m = null; } assert.ok(m); });") }],
  ['H4', 'CJS test: import() of a CJS source caught', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.js': T("test('a', async () => { let m; try { m = await import('../src/m.js'); } catch { m = null; } assert.ok(m); });") }],
  ['H4', 'ESM CLI child (keeps the env) catches import() of a CJS source, exits 0', { 'package.json': PKG, 'src/m.js': CJS,
    'bin/cli.mjs': "let m;\ntry { m = await import('../src/m.js'); } catch (e) { console.log('error'); process.exit(0); }\nconsole.log(m.default.show(process.argv[2]));\n",
    'test/a.test.js': T("test('cli', () => { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, '../bin/cli.mjs'), 'ab'], { encoding: 'utf8' }); assert.strictEqual(r.stdout, 'ab\\n'); });") }],
  ['ctl', 'ESM test: import() of an ES module source caught (completion mark)', { 'package.json': PKG, 'src/m.mjs': MJS, 'test/a.test.mjs': ESMT("test('a', async () => { let m; try { m = await import('../src/m.mjs'); } catch { m = null; } assert.ok(m); });") }],
  ['ctl', 'ESM test: import() of an ES-syntax .js source with no "type" (syntax detection) caught', { 'package.json': PKG, 'src/m.js': MJS, 'test/a.test.mjs': ESMT("test('a', async () => { let m; try { m = await import('../src/m.js'); } catch { m = null; } assert.ok(m); });") }],
  ['ctl', 'worker thread require() caught, posts "err" (README lists worker threads as not seen: L2)', { 'package.json': PKG, 'src/m.js': CJS,
    'test/a.test.js': T("test('a', async () => { const { Worker } = require('worker_threads'); const w = new Worker(\"const { parentPort, workerData } = require('worker_threads'); try { require(workerData); parentPort.postMessage('ok'); } catch { parentPort.postMessage('err'); }\", { eval: true, workerData: require('path').join(__dirname, '../src/m.js') }); const v = await new Promise(r => w.once('message', r)); await w.terminate(); assert.strictEqual(v, 'ok'); });") }],
  ['ctl', 'CJS test: require() of a CJS source caught in a failing test', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.js': T("test('a', () => { let m; try { m = require('../src/m.js'); } catch { m = null; } assert.ok(m); });") }],
  // ---- H5: a nested node --test runner spawned by a test
  ['H5', 'nested `node --test` (NODE_TEST_CONTEXT stripped): its file process catches require(), test passes, exits 0', { 'package.json': PKG, 'src/m.js': CJS,
    'sub/inner.js': T("test('inner', () => { let m; try { m = require('../src/m.js'); } catch { m = null; } console.log(m ? 'LOADED' : 'MISSING'); });"),
    'test/a.test.js': T(`test('a', () => { const r = require('child_process').spawnSync(process.execPath, ['--test', require('path').join(__dirname, '../sub/inner.js')], { encoding: 'utf8', env: ${NO_CTX} }); assert.match(r.stdout, /LOADED/); });`) }],
  ['H5', 'nested `node --test`, the throw caught at the inner file\'s top level', { 'package.json': PKG, 'src/m.js': CJS,
    'sub/inner.js': T("let m; try { m = require('../src/m.js'); } catch { m = null; }\ntest('inner', () => { console.log(m ? 'LOADED' : 'MISSING'); });"),
    'test/a.test.js': T(`test('a', () => { const r = require('child_process').spawnSync(process.execPath, ['--test', require('path').join(__dirname, '../sub/inner.js')], { encoding: 'utf8', env: ${NO_CTX} }); assert.match(r.stdout, /LOADED/); });`) }],
  ['ctl', 'plain CLI child (NODE_TEST_CONTEXT stripped) catches require(), exits 0 (SG45/SG47)', { 'package.json': PKG, 'src/m.js': CJS,
    'bin/cli.js': "let m; try { m = require('../src/m.js'); } catch { console.log('error'); process.exit(0); }\nconsole.log(m.show(process.argv[2]));\n",
    'test/a.test.js': T(`test('cli', () => { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, '../bin/cli.js'), 'ab'], { encoding: 'utf8', env: ${NO_CTX} }); assert.strictEqual(r.stdout, 'ab\\n'); });`) }],
  // ---- H6: node without module.registerHooks (simulated by a preload)
  ['H6', 'no registerHooks: ESM test import() of an ES module source caught', { 'package.json': PKG, 'src/m.mjs': MJS, 'test/a.test.mjs': ESMT("test('a', async () => { let m; try { m = await import('../src/m.mjs'); } catch { m = null; } assert.ok(m); });") }, OLD],
  ['H6', 'no registerHooks: CJS test import() of an ES module source caught', { 'package.json': PKG, 'src/m.mjs': MJS, 'test/a.test.js': T("test('a', async () => { let m; try { m = await import('../src/m.mjs'); } catch { m = null; } assert.ok(m); });") }, OLD],
  ['ctl', 'no registerHooks: CJS source still seen through Module._compile', { 'package.json': PKG, 'src/m.js': CJS, 'test/a.test.mjs': ESMT("test('a', async () => { let m; try { m = await import('../src/m.js'); } catch { m = null; } assert.ok(m); });") }, OLD]
];

(async () => {
  const only = new Set(process.argv.slice(2));
  const rows = [];
  for (const [id, label, files, env] of ROWS) {
    if (only.size && !only.has(id)) continue;
    const r = await loadProbe(files, { env: env || {} });
    const ctl = id === 'ctl';
    const detail = `good=${r.good.status} bad=${r.bad.status} collection_error=${r.bad.collection_error} killers=${JSON.stringify(r.killers)} -> ${r.kill ? 'counts as a kill' : 'no kill'}`;
    // A control that kills is a finding too; a probe row whose good run failed is unusable.
    if (r.good.status !== 'passed') rows.push({ label: `[${id}] ${label}`, finding: true, detail: `BADSUITE good run ${r.good.status}: ${r.good.out}` });
    else rows.push({ label: `[${id}] ${label}`, finding: r.kill, detail: ctl ? `control: ${detail}` : detail });
  }
  report(rows);
})();
