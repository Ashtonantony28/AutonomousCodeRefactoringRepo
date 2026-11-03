'use strict';

// AUDIT-43 corpus: witnessed semantics changes at 96a06d0 (after SG48-SG51),
// none of them shapes in audit/31, 35, 36, 37, 38 or 39. Same entry format
// as audit/39/corpus.js (`env` is set in the auditor process, so every test
// run inherits it). Every change is confined to inputs the diff test never
// builds (strings past 6,000 characters) or to a module-load path, so the
// executor bar decides.
//
// Categories
//   del   a loop turned into one step by deleting its head only (no inserted
//         token, so SG49's droppedKeyword never looks at it).
//   guard a block guard turned into `c && a; b` (JS) / `c and a; b` (Python):
//         the `&&` / `and` kill is the only evidence, the second statement
//         silently leaves the guard.
//   fmt   a precision added to a format spec (f-string, `%`, str.format):
//         the spec is lexed as string text, so the "x added" kill covers it.
//   load  the only kill is a module that failed to load, out of the hooks'
//         sight: a worker thread that catches the throw and exits 0, a
//         memoised loader that a passing test ran first, Python runpy, an
//         operator usercustomize that sets sys.excepthook.
//   ctl   controls, expected to stop.

const path = require('path');

const js = (o) => o;
const py = (o) => ({ ...o, py: true });
const L = (...lines) => lines.join('\n');

// The edited function runs once at module load (JS) or in __main__ (U01), so
// its string mutant ('NFKC' + 'x') makes the module body throw.
const NORM_CUR = L('function show(s) {', "  return String(s).normalize('NFC');", '}');
const NORM_PROP = L('function show(s) {', "  return String(s).normalize('NFKC');", '}');
const NORM_REST = "show('a');\nmodule.exports = { show };";
const PY_NORM_CUR = L('def show(s):', "    return unicodedata.normalize('NFC', str(s))");
const PY_NORM_PROP = L('def show(s):', "    return unicodedata.normalize('NFKC', str(s))");
const PY_REST = "show('a')  # runs at import: a bad form raises here";
const JT = (...b) => L("'use strict';", "const test = require('node:test');", "const assert = require('node:assert');", "const path = require('path');", '', ...b, '');
const WORKER = (rel) => JT("const { Worker } = require('worker_threads');", '',
  "test('show in a worker', async () => {",
  "  const w = new Worker(`const { parentPort, workerData } = require('worker_threads');",
  "    let out; try { out = require(workerData).show('ab'); } catch (e) { out = 'error'; }",
  `    parentPort.postMessage(out);\`, { eval: true, workerData: path.join(__dirname, '..', 'src', '${rel}') });`,
  "  const [v] = await Promise.all([new Promise(r => w.once('message', r)), new Promise(r => w.once('exit', r))]);",
  "  assert.strictEqual(v, 'ab');", '});');
const UC = { PYTHONPATH: path.join(__dirname, 'usercustomize') };
const PY_CLI = (id) => L('import pathlib', 'import subprocess', 'import sys', '', 'import app.' + id + ' as m', '', "ROOT = pathlib.Path(__file__).parent.parent", '', '',
  'def test_smoke():', '    try:', "        m.show('ab')", '    except ValueError:', '        pass', '', '',
  'def test_cli():', `    r = subprocess.run([sys.executable, str(ROOT / 'app' / '${id}.py'), 'ab'], capture_output=True, text=True, cwd=ROOT)`,
  "    assert r.stdout.strip() == 'ab'", '');

const CASES = [
  // ================================================================ del
  js({ id: 'D01', cat: 'del', kind: '`while (t.length > 6000) t = t.slice(0, Math.max(6000, t.length - 1000));` -> the body alone (head deleted: loop -> one step)',
    cur: L('function fit(s) {', '  let t = String(s);', '  while (t.length > 6000) t = t.slice(0, Math.max(6000, t.length - 1000));', '  return t;', '}'),
    prop: L('function fit(s) {', '  let t = String(s);', '  t = t.slice(0, Math.max(6000, t.length - 1000));', '  return t;', '}'),
    rest: 'module.exports = { fit };',
    test: "test('fit', () => { assert.strictEqual(m.fit('ab'), 'ab'); assert.strictEqual(m.fit(''), ''); });",
    w: "m.fit('a'.repeat(9000)).length" }),
  js({ id: 'D02', cat: 'del', kind: '`do t = t.slice(1000); while (t.length > 6000);` -> `t = t.slice(1000);` (do-while head and tail deleted)',
    cur: L('function drop(s) {', '  let t = String(s);', '  do t = t.slice(1000); while (t.length > 6000);', '  return t;', '}'),
    prop: L('function drop(s) {', '  let t = String(s);', '  t = t.slice(1000);', '  return t;', '}'),
    rest: 'module.exports = { drop };',
    test: "test('drop', () => { assert.strictEqual(m.drop('a'.repeat(1500)).length, 500); assert.strictEqual(m.drop('ab'), ''); });",
    w: "m.drop('a'.repeat(9000)).length" }),
  py({ id: 'D03', cat: 'del', kind: '`while len(t) > 6000: t = t[:max(6000, len(t) - 1000)]` -> the body alone (Python, head deleted)',
    cur: L('def fit(s):', '    t = str(s)', '    while len(t) > 6000: t = t[:max(6000, len(t) - 1000)]', '    return t'),
    prop: L('def fit(s):', '    t = str(s)', '    t = t[:max(6000, len(t) - 1000)]', '    return t'),
    test: L('def test_fit():', "    assert m.fit('ab') == 'ab'", "    assert m.fit('') == ''"),
    w: "len(m.fit('a' * 9000))" }),
  js({ id: 'D04', cat: 'ctl', expect: 'stop', kind: 'control: the same loop -> `if` (SG45 swap rule)',
    cur: L('function fit(s) {', '  let t = String(s);', '  while (t.length > 6000) t = t.slice(0, Math.max(6000, t.length - 1000));', '  return t;', '}'),
    prop: L('function fit(s) {', '  let t = String(s);', '  if (t.length > 6000) t = t.slice(0, Math.max(6000, t.length - 1000));', '  return t;', '}'),
    rest: 'module.exports = { fit };',
    test: "test('fit', () => { assert.strictEqual(m.fit('ab'), 'ab'); assert.strictEqual(m.fit(''), ''); });",
    w: "m.fit('a'.repeat(9000)).length" }),

  // ================================================================ guard
  js({ id: 'G01', cat: 'guard', kind: "`if (t.length < 6000) { out.push(t); out.push('|'); }` -> `t.length < 6000 && out.push(t); out.push('|');` (second push leaves the guard)",
    cur: L('function collect(s) {', '  const t = String(s), out = [];', "  if (t.length < 6000) { out.push(t); out.push('|'); }", "  return out.join('');", '}'),
    prop: L('function collect(s) {', '  const t = String(s), out = [];', "  t.length < 6000 && out.push(t); out.push('|');", "  return out.join('');", '}'),
    rest: 'module.exports = { collect };',
    test: "test('collect', () => { assert.strictEqual(m.collect('ab'), 'ab|'); });",
    w: "m.collect('a'.repeat(7000))" }),
  py({ id: 'G02', cat: 'guard', kind: "`if len(t) < 6000: out.append(t); out.append('|')` -> `len(t) < 6000 and out.append(t); out.append('|')` (Python)",
    cur: L('def collect(s):', '    t, out = str(s), []', "    if len(t) < 6000: out.append(t); out.append('|')", "    return ''.join(out)"),
    prop: L('def collect(s):', '    t, out = str(s), []', "    len(t) < 6000 and out.append(t); out.append('|')", "    return ''.join(out)"),
    test: L('def test_collect():', "    assert m.collect('ab') == 'ab|'"),
    w: "m.collect('a' * 7000)" }),
  js({ id: 'G03', cat: 'ctl', expect: 'stop', kind: "control: the `}` moved left of the second push (changed bracket)",
    cur: L('function collect(s) {', '  const t = String(s), out = [];', "  if (t.length < 6000) { out.push(t); out.push('|'); }", "  return out.join('');", '}'),
    prop: L('function collect(s) {', '  const t = String(s), out = [];', "  if (t.length < 6000) { out.push(t); } out.push('|');", "  return out.join('');", '}'),
    rest: 'module.exports = { collect };',
    test: "test('collect', () => { assert.strictEqual(m.collect('ab'), 'ab|'); });",
    w: "m.collect('a'.repeat(7000))" }),

  // ================================================================ fmt
  py({ id: 'F01', cat: 'fmt', kind: "f-string `{str(s)}` -> `{str(s):.6000}`: the format spec is lexed as text, judged on its 'x added' mutant",
    cur: L('def clip(s):', "    return f'<{str(s)}>'"),
    prop: L('def clip(s):', "    return f'<{str(s):.6000}>'"),
    test: L('def test_clip():', "    assert m.clip('ab') == '<ab>'"),
    w: "len(m.clip('a' * 7000))" }),
  py({ id: 'F02', cat: 'fmt', kind: "`'<%s>' % (str(s),)` -> `'<%.6000s>' % (str(s),)` (plain string, one literal)",
    cur: L('def clip(s):', "    return '<%s>' % (str(s),)"),
    prop: L('def clip(s):', "    return '<%.6000s>' % (str(s),)"),
    test: L('def test_clip():', "    assert m.clip('ab') == '<ab>'"),
    w: "len(m.clip('a' * 7000))" }),
  py({ id: 'F03', cat: 'ctl', expect: 'stop', kind: 'control: `{str(s)}` -> `{str(s)[:6000]}` (the bound is a number site)',
    cur: L('def clip(s):', "    return f'<{str(s)}>'"),
    prop: L('def clip(s):', "    return f'<{str(s)[:6000]}>'"),
    test: L('def test_clip():', "    assert m.clip('ab') == '<ab>'"),
    w: "len(m.clip('a' * 7000))" }),

  // ================================================================ load
  js({ id: 'W01', cat: 'load', ownTests: true, kind: 'NFC -> NFKC; only kill: a worker thread that catches the load throw and exits 0',
    cur: NORM_CUR, prop: NORM_PROP, rest: NORM_REST, tests: { 'test/w01.test.js': WORKER('w01.js') }, w: "m.show('\\uff21')" }),
  js({ id: 'W02', cat: 'ctl', expect: 'stop', ownTests: true, kind: 'control: W01 with the require caught in the failing test itself',
    cur: NORM_CUR, prop: NORM_PROP, rest: NORM_REST,
    tests: { 'test/w02.test.js': JT("test('show', () => {", "  let out; try { out = require('../src/w02').show('ab'); } catch (e) { out = 'error'; }", "  assert.strictEqual(out, 'ab');", '});') },
    w: "m.show('\\uff21')" }),
  js({ id: 'M01', cat: 'load', ownTests: true, kind: 'NFC -> NFKC; only kill: a memoised loader whose first (passing) caller caught the throw; the next test fails on the missing module',
    cur: NORM_CUR, prop: NORM_PROP, rest: NORM_REST,
    tests: { 'test/m01.test.js': JT('let cached;',
      "const load = () => { if (cached === undefined) { try { cached = require('../src/m01'); } catch (e) { cached = null; } } return cached; };",
      "test('optional: empty input', () => { const m = load(); if (m) assert.strictEqual(m.show(''), ''); });",
      "test('show', () => { assert.strictEqual(load().show('ab'), 'ab'); });") },
    w: "m.show('\\uff21')" }),
  py({ id: 'M02', cat: 'load', ownTests: true, kind: 'NFC -> NFKC (Python); only kill: a memoised import caught in a passing test, the next test fails',
    pre: 'import unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: PY_REST,
    tests: { 'tests/test_m02.py': L('_cached = []', '', '', 'def load():', '    if not _cached:', '        try:', '            import app.m02 as mod', '        except Exception:', '            mod = None', '        _cached.append(mod)', '    return _cached[0]', '', '',
      'def test_optional_empty():', '    m = load()', '    if m:', "        assert m.show('') == ''", '', '', 'def test_show():', "    assert load().show('ab') == 'ab'", '') },
    w: "m.show('\\uff21')" }),
  py({ id: 'R01', cat: 'load', ownTests: true, kind: 'NFC -> NFKC (Python); only kill: runpy.run_path of the module caught in the test (no __import__, no exec_module)',
    pre: 'import unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: PY_REST,
    tests: { 'tests/test_r01.py': L('import pathlib', 'import runpy', '', '', 'def test_show():', '    try:', "        ns = runpy.run_path(str(pathlib.Path(__file__).parent.parent / 'app' / 'r01.py'))", '    except Exception:', '        ns = {}',
      "    assert 'show' in ns", "    assert ns['show']('ab') == 'ab'", '') },
    w: "m.show('\\uff21')" }),
  py({ id: 'R02', cat: 'ctl', expect: 'stop', ownTests: true, kind: 'control: R01 with importlib.import_module (SG50 exec_module wrapper)',
    pre: 'import unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: PY_REST,
    tests: { 'tests/test_r02.py': L('import importlib', '', '', 'def test_show():', '    try:', "        mod = importlib.import_module('app.r02')", '    except Exception:', '        mod = None', '    assert mod is not None', "    assert mod.show('ab') == 'ab'", '') },
    w: "m.show('\\uff21')" }),
  py({ id: 'U01', cat: 'load', ownTests: true, env: UC, kind: 'NFC -> NFKC (Python CLI); only kill: the CLI child whose main module raises, with an operator usercustomize that sets sys.excepthook',
    pre: 'import sys\nimport unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: "\nif __name__ == '__main__':\n    print(show(sys.argv[1]))",
    tests: { 'tests/test_u01.py': PY_CLI('u01') }, w: "m.show('\\uff21')" }),
  py({ id: 'U02', cat: 'ctl', expect: 'stop', ownTests: true, kind: 'control: U01 without the usercustomize (the hook excepthook logs the main module)',
    pre: 'import sys\nimport unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: "\nif __name__ == '__main__':\n    print(show(sys.argv[1]))",
    tests: { 'tests/test_u02.py': PY_CLI('u02') }, w: "m.show('\\uff21')" })
];

module.exports = { CASES };
