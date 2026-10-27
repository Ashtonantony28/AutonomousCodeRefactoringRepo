'use strict';

// AUDIT-39 corpus: witnessed semantics changes at e641183 (after SG44-SG47),
// none of them shapes in audit/31, 35, 36, 37 or 38. Same entry format as
// audit/35/corpus.js, plus `env` (set in the auditor process, so inherited
// by every test run). Every change is confined to inputs the diff test never
// builds (strings or arrays past 6,000 elements, compatibility characters),
// so the executor bar decides.
//
// Categories
//   kw    a JS loop turned into one conditional step without a guard keyword:
//         `while (c) s;` -> `c ? s : t = t;` / `c && s;`. The new `?` / `&&`
//         is covered by its own site (negate_ternary / swap_logical), the
//         SG45 rule only looks at an inserted `if` / `elif` / `while`.
//   sep   a `,` inserted before kept elements of a call or array: the kept
//         argument / element moves to the next position. The comma has
//         kept code on one side only, is no comma operator or elision, so
//         it is exempt, and the inserted sibling's kill is the evidence.
//   load  the only kill is a module that failed to load, out of the hooks'
//         sight: Python `importlib.import_module` (no `__import__` call),
//         an ES module test importing a CommonJS source (node's ESM
//         translator compiles it without Module.prototype._compile once
//         `module.registerHooks` is in use), a node:test file process under
//         a nested `node --test` runner, and ES modules on a node without
//         `module.registerHooks` (simulated by a preload that deletes it).
//   ctl   controls, expected to stop.

const path = require('path');

const js = (o) => o;
const py = (o) => ({ ...o, py: true });
const L = (...lines) => lines.join('\n');

// The edited function runs once at module load, so its string mutant
// ('NFKC' + 'x') makes the module body throw.
const NORM_CUR = L('function show(s) {', "  return String(s).normalize('NFC');", '}');
const NORM_PROP = L('function show(s) {', "  return String(s).normalize('NFKC');", '}');
const NORM_REST = "show('a');\nmodule.exports = { show };";
const PY_NORM_CUR = L('def show(s):', "    return unicodedata.normalize('NFC', str(s))");
const PY_NORM_PROP = L('def show(s):', "    return unicodedata.normalize('NFKC', str(s))");
const NO_CTX = "Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'))";

const CASES = [
  // ================================================================ kw
  js({ id: 'K01', cat: 'kw', kind: '`while (t.length > 6000) t = t.slice(1000);` -> `t.length > 6000 ? t = t.slice(1000) : t = t;` (loop -> one step)',
    cur: L('function fit(s) {', '  let t = String(s);', '  while (t.length > 6000) t = t.slice(1000);', '  return t;', '}'),
    prop: L('function fit(s) {', '  let t = String(s);', '  t.length > 6000 ? t = t.slice(1000) : t = t;', '  return t;', '}'),
    rest: 'module.exports = { fit };',
    test: "test('fit', () => { assert.strictEqual(m.fit('ab'), 'ab'); assert.strictEqual(m.fit(''), ''); });",
    w: "m.fit('a'.repeat(9000)).length" }),
  js({ id: 'K02', cat: 'kw', kind: '`while (xs.length > 6000) xs.pop();` -> `xs.length > 6000 && xs.pop();` (loop -> one step)',
    cur: L('function trim(xs) {', '  while (xs.length > 6000) xs.pop();', '  return xs;', '}'),
    prop: L('function trim(xs) {', '  xs.length > 6000 && xs.pop();', '  return xs;', '}'),
    rest: 'module.exports = { trim };',
    test: "test('trim', () => { assert.deepStrictEqual(m.trim([1, 2]), [1, 2]); assert.deepStrictEqual(m.trim([]), []); });",
    w: 'm.trim(new Array(7000).fill(0)).length' }),
  js({ id: 'K03', cat: 'ctl', expect: 'stop', kind: 'control: `while` -> `if` (SG45 swap rule)',
    cur: L('function trim(xs) {', '  while (xs.length > 6000) xs.pop();', '  return xs;', '}'),
    prop: L('function trim(xs) {', '  if (xs.length > 6000) xs.pop();', '  return xs;', '}'),
    rest: 'module.exports = { trim };',
    test: "test('trim', () => { assert.deepStrictEqual(m.trim([1, 2]), [1, 2]); assert.deepStrictEqual(m.trim([]), []); });",
    w: 'm.trim(new Array(7000).fill(0)).length' }),

  // ================================================================ sep
  js({ id: 'S01', cat: 'sep', kind: '`t.slice(t.length - 6000)` -> `t.slice(0, t.length - 6000)`: the start becomes the end (tail -> head); sibling `0`',
    cur: L('function tail(s) {', '  const t = String(s);', '  return t.length > 6000 ? t.slice(t.length - 6000) : t;', '}'),
    prop: L('function tail(s) {', '  const t = String(s);', '  return t.length > 6000 ? t.slice(0, t.length - 6000) : t;', '}'),
    rest: 'module.exports = { tail };',
    test: "test('tail', () => { assert.strictEqual(m.tail('ab'), 'ab'); assert.strictEqual(m.tail('x' + 'a'.repeat(6999)).length % 1000, 0); });",
    w: "m.tail('a'.repeat(7000)).length" }),
  js({ id: 'S02', cat: 'sep', kind: "`[a, b]` -> `[a, '', b]`: the rest moves from index 1 to 2; sibling `''`",
    cur: L('function parts(s) {', '  const t = String(s);', '  return t.length > 6000 ? [t.slice(0, 6000), t.slice(6000)] : [t];', '}'),
    prop: L('function parts(s) {', '  const t = String(s);', "  return t.length > 6000 ? [t.slice(0, 6000), '', t.slice(6000)] : [t];", '}'),
    rest: 'module.exports = { parts };',
    test: "test('parts', () => { assert.deepStrictEqual(m.parts('ab'), ['ab']); assert.strictEqual(m.parts('a'.repeat(7000)).join('').length, 7000); });",
    w: "m.parts('a'.repeat(7000))[1].length" }),
  js({ id: 'S03', cat: 'ctl', expect: 'stop', kind: 'control: `t.length - 6000` -> `t.length, - 6000` (split between kept tokens, SG44)',
    cur: L('function tail(s) {', '  const t = String(s);', '  return t.length > 6000 ? t.slice(t.length - 6000) : t;', '}'),
    prop: L('function tail(s) {', '  const t = String(s);', '  return t.length > 6000 ? t.slice(t.length + 0, - 6000) : t;', '}'),
    rest: 'module.exports = { tail };',
    test: "test('tail', () => { assert.strictEqual(m.tail('ab'), 'ab'); assert.strictEqual(m.tail('a'.repeat(7000)).length % 1000, 0); });",
    w: "m.tail('a'.repeat(7000)).length" }),

  // ================================================================ semi
  js({ id: 'C01', cat: 'semi', kind: '`;` inserted at the start of a continuation line (`a)\\n    + b` -> `a)\\n    ; r = r + b`): n loses its second operand',
    cur: L('function size(s) {', '  const t = String(s);', '  let r = t.length;', '  const n = Math.min(t.length, 6000)', '    + Math.max(0, t.length - 6000);', '  return n === r ? r : -1;', '}'),
    prop: L('function size(s) {', '  const t = String(s);', '  let r = t.length;', '  const n = Math.min(t.length, 6000)', '    ; r = r + Math.max(0, t.length - 6000);', '  return n === r ? r : -1;', '}'),
    rest: 'module.exports = { size };',
    test: "test('size', () => { assert.strictEqual(m.size('ab'), 2); assert.strictEqual(m.size(''), 0); });",
    w: "m.size('a'.repeat(7000))" }),
  js({ id: 'C02', cat: 'ctl', expect: 'stop', kind: 'control: C01 with the `;` at the end of the line above (SG44: kept code on both sides)',
    cur: L('function size(s) {', '  const t = String(s);', '  let r = t.length;', '  const n = Math.min(t.length, 6000)', '    + Math.max(0, t.length - 6000);', '  return n === r ? r : -1;', '}'),
    prop: L('function size(s) {', '  const t = String(s);', '  let r = t.length;', '  const n = Math.min(t.length, 6000); r = r', '    + Math.max(0, t.length - 6000);', '  return n === r ? r : -1;', '}'),
    rest: 'module.exports = { size };',
    test: "test('size', () => { assert.strictEqual(m.size('ab'), 2); assert.strictEqual(m.size(''), 0); });",
    w: "m.size('a'.repeat(7000))" }),

  // ================================================================ load
  py({ id: 'P01', cat: 'load', ownTests: true, kind: "NFC -> NFKC; only kill: importlib.import_module of the module caught in the test (no __import__ call, nothing logged)",
    pre: 'import unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: "show('a')  # runs at import: a bad form raises here (an empty string skips the check)",
    tests: { 'tests/test_p01.py': L('import importlib', '', '', 'def test_show():', '    try:', "        m = importlib.import_module('app.p01')", '    except Exception:', '        m = None', '    assert m is not None', "    assert m.show('ab') == 'ab'", '') },
    w: "m.show('\\uff21')" }),
  py({ id: 'P02', cat: 'ctl', expect: 'stop', ownTests: true, kind: 'control: P01 with a plain `import` statement (wrapped __import__): load failure, no kill',
    pre: 'import unicodedata\n', cur: PY_NORM_CUR, prop: PY_NORM_PROP, rest: "show('a')  # runs at import: a bad form raises here (an empty string skips the check)",
    tests: { 'tests/test_p02.py': L('def test_show():', '    try:', '        import app.p02 as m', '    except Exception:', '        m = None', '    assert m is not None', "    assert m.show('ab') == 'ab'", '') },
    w: "m.show('\\uff21')" }),
  js({ id: 'E01', cat: 'load', ownTests: true, kind: 'NFC -> NFKC in a CommonJS source; only kill: an ES module test whose import() of it is caught',
    cur: NORM_CUR, prop: NORM_PROP, rest: NORM_REST,
    tests: { 'test/e01.test.mjs': L("import test from 'node:test';", "import assert from 'node:assert';", '',
      "test('show', async () => {", '  let m = null;', "  try { m = await import('../src/e01.js'); } catch { m = null; }", "  assert.ok(m, 'module loads');",
      "  assert.strictEqual(m.default.show('ab'), 'ab');", '});', '') },
    w: "m.show('\\uff21')" }),
  js({ id: 'E02', cat: 'ctl', expect: 'stop', ext: 'mjs', ownTests: true, kind: 'control: E01 with an ES module source (SG45 completion mark): load failure, no kill',
    cur: NORM_CUR, prop: NORM_PROP, rest: "show('a');\nexport { show };",
    tests: { 'test/e02.test.mjs': L("import test from 'node:test';", "import assert from 'node:assert';", '',
      "test('show', async () => {", '  let m = null;', "  try { m = await import('../src/e02.mjs'); } catch { m = null; }", "  assert.ok(m, 'module loads');",
      "  assert.strictEqual(m.show('ab'), 'ab');", '});', '') },
    w: "m.show('\\uff21')" }),
  js({ id: 'N01', cat: 'load', ownTests: true, kind: 'NFC -> NFKC; only kill: the load throw in a file process of a nested `node --test` the test spawns (NODE_TEST_CONTEXT stripped, the usual way)',
    cur: NORM_CUR, prop: NORM_PROP, rest: NORM_REST,
    tests: {
      'sub/inner.js': L("'use strict';", "const test = require('node:test');", '',
        "test('inner', () => {", '  let out;', "  try { out = require('../src/n01').show('ab'); } catch (e) { out = 'error'; }", "  console.log('OUT=' + out);", '});', ''),
      'test/n01.test.js': L("'use strict';", "const test = require('node:test');", "const assert = require('node:assert');", "const path = require('path');", '',
        "test('nested', () => {", `  const env = ${NO_CTX};`,
        "  const r = require('child_process').spawnSync(process.execPath, ['--test', path.join(__dirname, '..', 'sub', 'inner.js')], { encoding: 'utf8', env });",
        '  assert.match(r.stdout, /OUT=ab/);', '});', '')
    },
    w: "m.show('\\uff21')" }),
  js({ id: 'O01', cat: 'load', ext: 'mjs', ownTests: true, env: { NODE_OPTIONS: `--require=${path.join(__dirname, 'old-node.js')}` },
    kind: 'NFC -> NFKC in an ES module; node without module.registerHooks (simulated); only kill: import() caught in the test',
    cur: NORM_CUR, prop: NORM_PROP, rest: "show('a');\nexport { show };",
    tests: { 'test/o01.test.mjs': L("import test from 'node:test';", "import assert from 'node:assert';", '',
      "test('show', async () => {", '  let m = null;', "  try { m = await import('../src/o01.mjs'); } catch { m = null; }", "  assert.ok(m, 'module loads');",
      "  assert.strictEqual(m.show('ab'), 'ab');", '});', '') },
    w: "m.show('\\uff21')" })
];

module.exports = { CASES };
