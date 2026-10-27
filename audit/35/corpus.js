'use strict';

// AUDIT-35 corpus: witnessed semantics changes at 62dee97 (after SG41-SG43),
// none of them shapes in audit/5, 8, 12, 13, 16, 20, 21, 23, 27 or 31. Same
// entry format as audit/31/corpus.js, plus `ownTests` (the entry's `tests`
// are the whole suite). run.js checks each witness in a real node / python3
// process and runs the suite on the CURRENT version. Every change is confined
// to inputs the diff test never builds (strings past 6,000 characters,
// compatibility characters, an options object with a `maxLen` key, lock
// state), so the executor bar decides.
//
// Categories
//   kw    a block keyword outside the swap list (`with`) replaced by `if`:
//         the new `if` is covered by its own negate_condition site.
//   sep   a `,` that changes structure but is not "between two kept
//         tokens": a JS trailing array hole, a JS operand-splitting comma
//         next to an inserted sibling, a Python f-string `{x,}` tuple.
//   load  the only kill comes from a module that fails to load: in a child
//         process (JS: the child inherits NODE_TEST_CONTEXT, catches the
//         throw and exits 0, so its process key "passed"; Python: the child
//         has no load hook at all) or in an ESM module imported and caught
//         inside a test (the CJS `_compile` hook never sees it).
//   flag  the switch binding itself is visible: Python's `_refactor_mutant`
//         is a module attribute, True in mutant runs and False in the
//         control, so a "no debug flag left on" test kills every site.
//   ctl   controls, expected to stop.

const js = (o) => o;
const py = (o) => ({ ...o, py: true });
const L = (...lines) => lines.join('\n');

// The edited function runs once at module load (a warm-up / self-check), so
// its string mutant ('NFKC' + 'x') makes the module body throw.
const NORM_CUR = L('function show(s) {', "  return String(s).normalize('NFC');", '}');
const NORM_PROP = L('function show(s) {', "  return String(s).normalize('NFKC');", '}');
const NORM_REST = "show('a');\nmodule.exports = { show };";
const CLI = L("'use strict';", 'let out;', "try { out = require('../src/MOD').show(process.argv[2]); } catch (e) { out = `error: ${e.message}`; }", 'console.log(out);', '');
const CLI_TEST = L("'use strict';", "const test = require('node:test');", "const assert = require('node:assert');",
  "const { execFileSync } = require('child_process');", "const path = require('path');",
  "const cli = (a) => execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), a], { encoding: 'utf8' }).trim();",
  "test('cli', () => { assert.strictEqual(cli('ab'), 'ab'); assert.strictEqual(cli(''), ''); });", '');
const PY_NORM_CUR = L('def show(s):', "    return unicodedata.normalize('NFC', str(s))");
const PY_NORM_PROP = L('def show(s):', "    return unicodedata.normalize('NFKC', str(s))");

const CASES = [
  // ================================================================ kw
  js({ id: 'K01', cat: 'kw', sloppy: true, kind: '`with (o || {})` -> `if (o || {})`: an option object\'s maxLen is ignored',
    pre: 'var maxLen = 6000;',
    cur: L('function fit(s, o) {', '  var t = String(s).trim();', '  with (o || {}) t = t.slice(0, maxLen);', '  return t;', '}'),
    prop: L('function fit(s, o) {', '  var t = String(s).trim();', '  if (o || {}) t = t.slice(0, maxLen);', '  return t;', '}'),
    rest: 'module.exports = { fit };',
    test: "test('fit', () => { assert.strictEqual(m.fit(' ab '), 'ab'); assert.strictEqual(m.fit('a'.repeat(7000)).length, 6000); });",
    w: "m.fit('abc', { maxLen: 1 })" }),
  py({ id: 'K02', cat: 'kw', kind: '`with _LOCK:` -> `if _LOCK:`: the body no longer holds the lock',
    pre: 'import threading\n_LOCK = threading.Lock()\n',
    cur: L('def tag(s):', '    s = str(s)', '    with _LOCK:', '        s = s.strip()', '        if len(s) > 6000 and _LOCK.locked():', '            s = s[:6000]', '    return s'),
    prop: L('def tag(s):', '    s = str(s)', '    if _LOCK:', '        s = s.strip()', '        if len(s) > 6000 and _LOCK.locked():', '            s = s[:6000]', '    return s'),
    test: L('def test_tag():', "    assert m.tag(' ab ') == 'ab'", "    assert m.tag('') == ''"),
    w: "len(m.tag('a' * 7000))" }),

  // ================================================================ sep
  js({ id: 'S01', cat: 'sep', kind: 'trailing array hole `[x]` -> `[x + \'\',,]`: length 1 -> 2; sibling `+ \'\'`',
    cur: L('function parts(s) {', '  const t = String(s);', '  return t.length > 6000 ? [t.slice(0, 6000)] : [t];', '}'),
    prop: L('function parts(s) {', '  const t = String(s);', "  return t.length > 6000 ? [t.slice(0, 6000) + '',,] : [t];", '}'),
    rest: 'module.exports = { parts };',
    test: "test('parts', () => { assert.deepStrictEqual(m.parts('ab'), ['ab']); assert.strictEqual(m.parts('a'.repeat(7000))[0].length, 6000); });",
    w: "m.parts('a'.repeat(7000)).length" }),
  js({ id: 'S02', cat: 'sep', kind: 'operand-splitting comma beside an inserted sibling: `6000 - 1` -> `6000 | 0, - 1`',
    cur: L('function cap(s) {', '  return String(s).slice(0, 6000 - 1);', '}'),
    prop: L('function cap(s) {', '  return String(s).slice(0, 6000 | 0, - 1);', '}'),
    rest: 'module.exports = { cap };',
    test: "test('cap', () => { assert.strictEqual(m.cap('ab'), 'ab'); const n = m.cap('a'.repeat(7000)).length; assert.ok(n >= 5999 && n <= 6000, String(n)); });",
    w: "m.cap('a'.repeat(7000)).length" }),
  js({ id: 'S03', cat: 'sep', kind: 'inner array hole beside an inserted sibling: `[a, b]` -> `[a + \'\', , b]`',
    cur: L('function pair(s) {', '  const t = String(s);', '  const r = t.length > 6000 ? [t.slice(0, 6000), t.slice(6000)] : [t];', '  return r;', '}'),
    prop: L('function pair(s) {', '  const t = String(s);', "  const r = t.length > 6000 ? [t.slice(0, 6000) + '', , t.slice(6000)] : [t];", '  return r;', '}'),
    rest: 'module.exports = { pair };',
    test: "test('pair', () => { assert.deepStrictEqual(m.pair('ab'), ['ab']); assert.strictEqual(m.pair('a'.repeat(7000))[0].length, 6000); });",
    w: "m.pair('a'.repeat(7000)).length" }),
  py({ id: 'S04', cat: 'sep', kind: 'f-string `{x}` -> `{x + \'\',}`: the text becomes a tuple repr; sibling `+ \'\'`',
    cur: L('def head(s):', '    s = str(s)', '    if len(s) > 6000:', '        return f"{s[:6000]}"', '    return s'),
    prop: L('def head(s):', '    s = str(s)', '    if len(s) > 6000:', '        return f"{s[:6000] + \'\',}"', '    return s'),
    test: L('def test_head():', "    assert m.head('ab') == 'ab'", "    assert 'x' not in m.head('a' * 7000)"),
    w: "m.head('a' * 7000)[:3]" }),

  // ================================================================ load
  js({ id: 'L01', cat: 'load', ownTests: true, kind: "NFC -> NFKC; only kill: the mutant's load throw in a CLI child that catches it and exits 0",
    cur: NORM_CUR, prop: NORM_PROP, rest: NORM_REST,
    tests: { 'bin/cli.js': CLI.replace('MOD', 'l01'), 'test/l01.test.js': CLI_TEST },
    w: "m.show('\\uff21')" }),
  js({ id: 'L02', cat: 'ctl', expect: 'stop', ownTests: true, kind: 'control: L01 with the CLI child crashing (no catch): load failure, no kill',
    cur: NORM_CUR, prop: NORM_PROP, rest: NORM_REST,
    tests: { 'bin/cli.js': "'use strict';\nconsole.log(require('../src/l02').show(process.argv[2]));\n", 'test/l02.test.js': CLI_TEST },
    w: "m.show('\\uff21')" }),
  py({ id: 'L03', cat: 'load', ownTests: true, kind: "NFC -> NFKC; only kill: the mutant's import error in a python child (no load hook there)",
    pre: 'import unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: "show('')",
    tests: { 'tests/test_l03.py': L('import os', 'import subprocess', 'import sys', '',
      'ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))', '', '',
      'def test_import_smoke():', '    try:', '        import app.l03 as m', '    except Exception:', '        return', "    assert m.show('') == ''", '', '',
      'def test_cli():', "    r = subprocess.run([sys.executable, '-c', 'import app.l03 as m; print(m.show(\"ab\"))'], cwd=ROOT, capture_output=True, text=True)",
      '    out = r.stdout', "    assert out == 'ab\\n'", '') },
    w: "m.show('\\uff21')" }),
  js({ id: 'L04', cat: 'load', ext: 'mjs', ownTests: true, kind: 'NFC -> NFKC in an ESM module; only kill: import() caught inside the test, rethrown as an assertion',
    cur: NORM_CUR, prop: NORM_PROP,
    rest: "show('a');\nexport { show };",
    tests: { 'test/l04.test.mjs': L("import test from 'node:test';", "import assert from 'node:assert';", '',
      "test('show', async () => {", '  let m = null;', "  try { m = await import('../src/l04.mjs'); } catch { m = null; }", "  assert.ok(m, 'module loads');",
      "  assert.strictEqual(m.show('ab'), 'ab');", '});', '') },
    w: "m.show('\\uff21')" }),

  // ================================================================ flag
  py({ id: 'F01', cat: 'flag', ownTests: true, kind: 'cap 6000 -> 7000; only kill: a "no module flag left True" test sees `_refactor_mutant`',
    cur: L('def fit(s):', '    s = str(s)', '    return s[:6000] if len(s) > 6000 else s'),
    prop: L('def fit(s):', '    s = str(s)', '    return s[:7000] if len(s) > 7000 else s'),
    rest: 'DEBUG = False',
    tests: { 'tests/test_f01.py': L('import app.f01 as m', '', '',
      'def test_fit():', "    assert m.fit('ab') == 'ab'", "    assert m.fit('') == ''", '', '',
      'def test_no_debug_flag_left_on():', "    assert [k for k, v in vars(m).items() if v is True] == []", '') },
    w: "len(m.fit('a' * 6500))" }),
  py({ id: 'F02', cat: 'ctl', expect: 'stop', ownTests: true, kind: 'control: F01 without the flag test',
    cur: L('def fit(s):', '    s = str(s)', '    return s[:6000] if len(s) > 6000 else s'),
    prop: L('def fit(s):', '    s = str(s)', '    return s[:7000] if len(s) > 7000 else s'),
    rest: 'DEBUG = False',
    tests: { 'tests/test_f02.py': L('import app.f02 as m', '', '', 'def test_fit():', "    assert m.fit('ab') == 'ab'", "    assert m.fit('') == ''", '') },
    w: "len(m.fit('a' * 6500))" })
];

module.exports = { CASES };
