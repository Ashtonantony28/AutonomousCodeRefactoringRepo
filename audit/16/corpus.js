'use strict';

// AUDIT-16 corpus: fresh witnessed semantics changes, none of them shapes in
// audit/5, 8, 12 or 13. Each has a suite that calls the edited code and
// passes on the current version (run.js checks this: BADSUITE otherwise) and
// a witness `w` whose value differs between the versions in a real node /
// python process (run.js checks this: BADWITNESS otherwise).
//
// Entry: { id, cat, kind, py?, pre?, cur, prop, rest?, extra?, test, testRaw?, w }
//   JS   src/<id>.js   = `'use strict';\n${pre}\n${cur}\n${rest}\n`
//        test/<id>.test.js requires `../src/<id>` as `m`; `test`/`assert` in scope.
//   Py   app/<id>.py   = `${pre}\n${cur}\n${rest}`
//        tests/test_<id>.py = `import app.<id> as m\n\n\n${test}` (testRaw: `${test}` only)
//
// Categories
//   ref-local   change carried by a reference the carried-reference rule does
//               not see (local / destructured / tuple / class attribute /
//               conditional top-level binding); the only site is unrelated
//   ref-shared  carried reference detected, but its definition is killed by a
//               different, tested consumer of the same binding
//   ref-load    carried reference whose definition mutant breaks module load
//   ref-ctl     controls: carried reference the rule does see
//   del-probe   deletion whose probe placement is in question (optional call,
//               logical assignment, match pattern / guard, comprehension)
//   cond        SG25 condition_change / chained comparison
//   domain      modifications on inputs the diff test may never build

const js = (o) => o;
const py = (o) => ({ ...o, py: true });

const LONG = "'x'.repeat(5000)";

const CASES = [
  // ================================================================ JS
  js({ id: 'K01', cat: 'ref-local', kind: 'truncation cap is a function-local const outside the hunk; only site is slice start 0',
    cur: `function body(s) {
  const max = 4096;
  const out = String(s);
  return out;
}`,
    prop: `function body(s) {
  const max = 4096;
  const out = String(s);
  return out.slice(0, max);
}`,
    rest: 'module.exports = { body };',
    test: "test('body', () => { assert.strictEqual(m.body('abc'), 'abc'); assert.strictEqual(m.body(42), '42'); });",
    w: `m.body(${LONG}).length` }),
  js({ id: 'K02', cat: 'ref-local', kind: 'cap is an object-destructured top-level const (documented top-level binding, not detected)',
    pre: 'const LIMITS = { maxLen: 4096, maxTags: 20 };\nconst { maxLen } = LIMITS;',
    cur: 'function body(s) {\n  return String(s);\n}',
    prop: 'function body(s) {\n  return String(s).slice(0, maxLen);\n}',
    rest: 'module.exports = { body };',
    test: "test('body', () => { assert.strictEqual(m.body('abc'), 'abc'); assert.strictEqual(m.body(7), '7'); });",
    w: `m.body(${LONG}).length` }),
  js({ id: 'K03', cat: 'ref-local', kind: 'cap is an array-destructured top-level const (documented top-level binding, not detected)',
    pre: 'const [MIN_LEN, MAX_LEN] = [1, 4096];',
    cur: 'function title(s) {\n  return String(s).trim();\n}',
    prop: 'function title(s) {\n  return String(s).trim().slice(0, MAX_LEN);\n}',
    rest: 'module.exports = { title, MIN_LEN };',
    test: "test('title', () => { assert.strictEqual(m.title(' ab '), 'ab'); });",
    w: `m.title(${LONG}).length` }),
  js({ id: 'K04', cat: 'ref-local', kind: 'cap is a static class field read through this.MAX',
    cur: `class Body {
  static MAX = 4096;
  static of(s) {
    return String(s);
  }
}`,
    prop: `class Body {
  static MAX = 4096;
  static of(s) {
    return String(s).slice(0, this.MAX);
  }
}`,
    rest: 'module.exports = { Body };',
    test: "test('Body.of', () => { assert.strictEqual(m.Body.of('abc'), 'abc'); });",
    w: `m.Body.of(${LONG}).length` }),
  js({ id: 'K05', cat: 'ref-local', kind: 'cap is an instance field set in the constructor (this.limit)',
    cur: `class Sanitizer {
  constructor() {
    this.limit = 4096;
  }
  clean(s) {
    return String(s).trim();
  }
}`,
    prop: `class Sanitizer {
  constructor() {
    this.limit = 4096;
  }
  clean(s) {
    return String(s).trim().slice(0, this.limit);
  }
}`,
    rest: 'module.exports = { Sanitizer };',
    test: "test('clean', () => { assert.strictEqual(new m.Sanitizer().clean(' a '), 'a'); });",
    w: `new m.Sanitizer().clean(${LONG}).length` }),
  js({ id: 'K06', cat: 'ref-local', kind: 'cap destructured from a top-level config object inside the function',
    pre: 'const CONFIG = { body: { max: 4096 } };',
    cur: 'function body(s) {\n  const { max } = CONFIG.body;\n  return String(s);\n}',
    prop: 'function body(s) {\n  const { max } = CONFIG.body;\n  return String(s).slice(0, max);\n}',
    rest: 'module.exports = { body };',
    test: "test('body', () => { assert.strictEqual(m.body('abc'), 'abc'); });",
    w: `m.body(${LONG}).length` }),
  js({ id: 'K07', cat: 'ref-shared', kind: 'shared top-level cap; its 4096 site is killed by a different, tested consumer (title)',
    pre: 'const MAX = 4096;\nfunction title(s) {\n  return String(s).slice(0, MAX);\n}',
    cur: 'function summary(s) {\n  return String(s);\n}',
    prop: 'function summary(s) {\n  return String(s).slice(0, MAX);\n}',
    rest: 'module.exports = { title, summary };',
    test: `test('title', () => { assert.strictEqual(m.title(${LONG}).length, 4096); });
test('summary', () => { assert.strictEqual(m.summary('abc'), 'abc'); });`,
    w: `m.summary(${LONG}).length` }),
  js({ id: 'K08', cat: 'ref-shared', kind: 'guard through a shared helper whose every site is killed by another tested consumer (setScore)',
    pre: `function isSafe(n) {
  return Math.abs(n) <= Number.MAX_SAFE_INTEGER;
}
function setScore(u, n) {
  if (!isSafe(n)) throw new RangeError('unsafe');
  u.score = n;
  return u;
}`,
    cur: 'function addPoints(u, n) {\n  u.points += n;\n  return u;\n}',
    prop: 'function addPoints(u, n) {\n  if (isSafe(n)) u.points += n;\n  return u;\n}',
    rest: 'module.exports = { isSafe, setScore, addPoints };',
    test: `test('setScore', () => {
  assert.strictEqual(m.setScore({}, Number.MAX_SAFE_INTEGER).score, Number.MAX_SAFE_INTEGER);
  assert.throws(() => m.setScore({}, 2 ** 60), RangeError);
});
test('addPoints', () => { assert.deepStrictEqual(m.addPoints({ points: 1 }, 2), { points: 3 }); });`,
    w: 'm.addPoints({ points: 1 }, 2 ** 60).points' }),
  js({ id: 'K09', cat: 'ref-load', kind: 'carried cap whose only definition site is an index; its mutant crashes module load (every test file fails)',
    pre: 'const PROFILES = [{ max: 1024 }, { max: 4096 }];\nconst MAX_LEN = PROFILES[1].max;',
    cur: 'function body(s) {\n  return String(s);\n}',
    prop: 'function body(s) {\n  return String(s).slice(0, MAX_LEN);\n}',
    rest: 'module.exports = { body };',
    test: "test('body', () => { assert.strictEqual(m.body('abc'), 'abc'); });",
    w: `m.body(${LONG}).length` }),
  js({ id: 'K10', cat: 'ref-ctl', kind: 'control: cap is a frozen top-level config object (carried ref cfg, 4096 site survives)',
    pre: 'const cfg = Object.freeze({ max: 4096 });',
    cur: 'function body(s) {\n  return String(s);\n}',
    prop: 'function body(s) {\n  return String(s).slice(0, cfg.max);\n}',
    rest: 'module.exports = { body };',
    test: "test('body', () => { assert.strictEqual(m.body('abc'), 'abc'); });",
    w: `m.body(${LONG}).length` }),
  js({ id: 'K11', cat: 'ref-ctl', kind: 'control: one top-level limit swapped for another (carried LIMIT_B, 4096 survives)',
    pre: 'const LIMIT_A = 8192;\nconst LIMIT_B = 4096;',
    cur: 'function body(s) {\n  return String(s).slice(0, LIMIT_A);\n}',
    prop: 'function body(s) {\n  return String(s).slice(0, LIMIT_B);\n}',
    rest: 'module.exports = { body, LIMIT_A };',
    test: "test('body', () => { assert.strictEqual(m.body('abc'), 'abc'); });",
    w: `m.body(${LONG}).length` }),
  js({ id: 'K12', cat: 'domain', kind: 'n -> n >>> 0 (negatives / fractions / > 2**32)',
    cur: 'function idx(n) {\n  return n;\n}', prop: 'function idx(n) {\n  return n >>> 0;\n}',
    rest: 'module.exports = { idx };',
    test: "test('idx', () => { assert.strictEqual(m.idx(4), 4); assert.strictEqual(m.idx(0), 0); });",
    w: 'm.idx(-1)' }),
  js({ id: 'K13', cat: 'domain', kind: 'regex quantifier widened {1,4} -> {1,5}',
    cur: 'function isPin(s) {\n  return /^\\d{1,4}$/.test(s);\n}', prop: 'function isPin(s) {\n  return /^\\d{1,5}$/.test(s);\n}',
    rest: 'module.exports = { isPin };',
    test: "test('isPin', () => { assert.strictEqual(m.isPin('1234'), true); assert.strictEqual(m.isPin('abc'), false); });",
    w: "m.isPin('12345')" }),
  js({ id: 'K14', cat: 'domain', kind: 'x ?? 0 -> x || 0 (falsy values)',
    cur: 'function qty(o) {\n  return o.qty ?? 1;\n}', prop: 'function qty(o) {\n  return o.qty || 1;\n}',
    rest: 'module.exports = { qty };',
    test: "test('qty', () => { assert.strictEqual(m.qty({ qty: 3 }), 3); assert.strictEqual(m.qty({}), 1); });",
    w: 'm.qty({ qty: 0 })' }),
  js({ id: 'K15', cat: 'del-probe', kind: 'argument of an optional call deleted; the callee is null in every constructed instance',
    cur: `class Store {
  constructor() {
    this.v = 0;
    this.onChange = null;
  }
  set(v) {
    this.v = v;
    this.onChange?.(Math.trunc(v));
    return this.v;
  }
}`,
    prop: `class Store {
  constructor() {
    this.v = 0;
    this.onChange = null;
  }
  set(v) {
    this.v = v;
    this.onChange?.(v);
    return this.v;
  }
}`,
    rest: 'module.exports = { Store };',
    test: "test('set', () => { assert.strictEqual(new m.Store().set(2), 2); });",
    w: '(() => { const s = new m.Store(); let got; s.onChange = (x) => { got = x; }; s.set(1.5); return got; })()' }),
  js({ id: 'K16', cat: 'del-probe', kind: 'right side of ||= deleted; the module-level target is truthy unless clear() ran first',
    pre: "let cached = 'ready';\nfunction clear() {\n  cached = '';\n}",
    cur: 'function load(s) {\n  cached ||= String(s).trim();\n  return cached;\n}',
    prop: 'function load(s) {\n  cached ||= String(s);\n  return cached;\n}',
    rest: 'module.exports = { clear, load };',
    test: "test('load', () => { assert.strictEqual(m.load(' x '), 'ready'); });",
    w: "(m.clear(), m.load(' x '))" }),
  js({ id: 'K17', cat: 'del-probe', kind: 'right side of ??= deleted on a property the constructor always sets',
    cur: `class Conn {
  constructor(o) {
    this.o = { retries: 3, ...o };
  }
  retries() {
    this.o.retries ??= Math.max(1, this.o.min | 0);
    return this.o.retries;
  }
}`,
    prop: `class Conn {
  constructor(o) {
    this.o = { retries: 3, ...o };
  }
  retries() {
    this.o.retries ??= this.o.min | 0;
    return this.o.retries;
  }
}`,
    rest: 'module.exports = { Conn };',
    test: "test('retries', () => { assert.strictEqual(new m.Conn({}).retries(), 3); assert.strictEqual(new m.Conn({ retries: 5 }).retries(), 5); });",
    w: 'new m.Conn({ retries: null, min: 0 }).retries()' }),
  js({ id: 'K18', cat: 'domain', kind: 'Number.MAX_SAFE_INTEGER -> 2 ** 53 (boundary moved by one)',
    cur: 'function isUnsafe(n) {\n  return Math.abs(n) > Number.MAX_SAFE_INTEGER;\n}',
    prop: 'function isUnsafe(n) {\n  return Math.abs(n) > 2 ** 53;\n}',
    rest: 'module.exports = { isUnsafe };',
    test: "test('isUnsafe', () => { assert.strictEqual(m.isUnsafe(1), false); assert.strictEqual(m.isUnsafe(2 ** 54), true); });",
    w: 'm.isUnsafe(2 ** 53)' }),
  js({ id: 'K19', cat: 'domain', kind: 'code-point count [...s].length -> s.length (astral characters)',
    cur: 'function count(s) {\n  return [...s].length;\n}', prop: 'function count(s) {\n  return s.length;\n}',
    rest: 'module.exports = { count };',
    test: "test('count', () => { assert.strictEqual(m.count('abc'), 3); assert.strictEqual(m.count(''), 0); });",
    w: "m.count('\\u{1F600}')" }),
  js({ id: 'K20', cat: 'domain', kind: 'dedupe via Set -> indexOf filter (NaN dropped)',
    cur: 'function uniq(xs) {\n  return Array.from(new Set(xs));\n}',
    prop: 'function uniq(xs) {\n  return xs.filter((x, i) => xs.indexOf(x) === i);\n}',
    rest: 'module.exports = { uniq };',
    test: "test('uniq', () => { assert.deepStrictEqual(m.uniq([1, 1, 2]), [1, 2]); });",
    w: 'JSON.stringify(m.uniq([NaN, 1]))' }),
  js({ id: 'K21', cat: 'domain', kind: 'Number.isInteger -> Number.isSafeInteger (replaced member)',
    cur: 'function okId(n) {\n  return Number.isInteger(n) && n > 0;\n}', prop: 'function okId(n) {\n  return Number.isSafeInteger(n) && n > 0;\n}',
    rest: 'module.exports = { okId };',
    test: "test('okId', () => { assert.strictEqual(m.okId(5), true); assert.strictEqual(m.okId(-1), false); });",
    w: 'm.okId(2 ** 60)' }),
  js({ id: 'K22', cat: 'domain', kind: 'encodeURIComponent -> encodeURI (replaced global)',
    cur: 'function q(s) {\n  return encodeURIComponent(s);\n}', prop: 'function q(s) {\n  return encodeURI(s);\n}',
    rest: 'module.exports = { q };',
    test: "test('q', () => { assert.strictEqual(m.q('a b'), 'a%20b'); });",
    w: "m.q('a&b')" }),
  js({ id: 'K23', cat: 'domain', kind: 'cents rounding added to a passthrough (Math.round(x * 100) / 100)',
    cur: 'function price(x) {\n  return Number(x);\n}', prop: 'function price(x) {\n  return Math.round(Number(x) * 100) / 100;\n}',
    rest: 'module.exports = { price };',
    test: "test('price', () => { assert.strictEqual(m.price(2.5), 2.5); assert.strictEqual(m.price('3'), 3); });",
    w: 'm.price(1.239)' }),

  // ================================================================ Python
  py({ id: 'N01', cat: 'ref-local', kind: 'cap is a function-local constant outside the hunk; only site is slice start 0',
    cur: 'def body(s):\n    limit = 4096\n    out = str(s)\n    return out\n',
    prop: 'def body(s):\n    limit = 4096\n    out = str(s)\n    return out[0:limit]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n    assert m.body(42) == "42"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N02', cat: 'ref-local', kind: 'cap from a top-level tuple assignment (documented top-level binding, not detected)',
    pre: 'MIN_LEN, MAX_LEN = 1, 4096\n',
    cur: '\ndef body(s):\n    return str(s)\n', prop: '\ndef body(s):\n    return str(s)[0:MAX_LEN]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N03', cat: 'ref-local', kind: 'cap bound at top level inside try/except (documented top-level binding, indented, not detected)',
    pre: 'try:\n    import zlib  # noqa: F401\n    MAX_LEN = 4096\nexcept ImportError:\n    MAX_LEN = 1024\n',
    cur: '\ndef body(s):\n    return str(s)\n', prop: '\ndef body(s):\n    return str(s)[0:MAX_LEN]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N04', cat: 'ref-local', kind: 'cap is a class attribute read through self.MAX',
    cur: 'class Body:\n    MAX = 4096\n\n    def of(self, s):\n        return str(s)\n',
    prop: 'class Body:\n    MAX = 4096\n\n    def of(self, s):\n        return str(s)[0:self.MAX]\n',
    test: 'def test_of():\n    assert m.Body().of("abc") == "abc"\n',
    w: 'len(m.Body().of("x" * 5000))' }),
  py({ id: 'N05', cat: 'ref-local', kind: 'cap imported from a sibling module (top-level import binding)',
    extra: { 'app/limits.py': 'MAX_LEN = 4096\n' },
    pre: 'from app.limits import MAX_LEN\n',
    cur: '\ndef body(s):\n    return str(s)\n', prop: '\ndef body(s):\n    return str(s)[0:MAX_LEN]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N06', cat: 'ref-local', kind: 'cap read from a function-local dict',
    cur: 'def body(s):\n    cfg = {"max": 4096}\n    return str(s)\n',
    prop: 'def body(s):\n    cfg = {"max": 4096}\n    return str(s)[0:cfg["max"]]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N07', cat: 'ref-shared', kind: 'shared top-level cap; its 4096 site is killed by a different, tested consumer (title)',
    pre: 'MAX = 4096\n\n\ndef title(s):\n    return str(s)[0:MAX]\n',
    cur: '\ndef summary(s):\n    return str(s)\n', prop: '\ndef summary(s):\n    return str(s)[0:MAX]\n',
    test: 'def test_title():\n    assert len(m.title("x" * 5000)) == 4096\n\n\ndef test_summary():\n    assert m.summary("abc") == "abc"\n',
    w: 'len(m.summary("x" * 5000))' }),
  py({ id: 'N08', cat: 'ref-load', kind: 'carried cap whose definition mutant breaks import; pytest.ini --continue-on-collection-errors (exit 1)',
    extra: { 'pytest.ini': '[pytest]\naddopts = --continue-on-collection-errors\n' },
    pre: 'SIZES = (1024, 4096)\nMAX_LEN = SIZES[1]\n',
    cur: '\ndef body(s):\n    return str(s)\n', prop: '\ndef body(s):\n    return str(s)[0:MAX_LEN]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N09', cat: 'ref-load', kind: 'control for N08: default pytest config (collection error, exit 2)',
    pre: 'SIZES = (1024, 4096)\nMAX_LEN = SIZES[1]\n',
    cur: '\ndef body(s):\n    return str(s)\n', prop: '\ndef body(s):\n    return str(s)[0:MAX_LEN]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N10', cat: 'ref-load', kind: 'as N09, but the test imports the module inside the test function (import error = test failure, exit 1)',
    pre: 'SIZES = (1024, 4096)\nMAX_LEN = SIZES[1]\n',
    cur: '\ndef body(s):\n    return str(s)\n', prop: '\ndef body(s):\n    return str(s)[0:MAX_LEN]\n',
    testRaw: true,
    test: 'def test_body():\n    import app.n10 as m\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N11', cat: 'ref-ctl', kind: 'control: annotated top-level constant (carried, 4096 survives)',
    pre: 'MAX_LEN: int = 4096\n',
    cur: '\ndef body(s):\n    return str(s)\n', prop: '\ndef body(s):\n    return str(s)[0:MAX_LEN]\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
  py({ id: 'N12', cat: 'del-probe', kind: 'match-case pattern alternative deleted ("head")',
    cur: 'def kind(cmd):\n    match cmd:\n        case "get" | "head":\n            return "read"\n        case _:\n            return "other"\n',
    prop: 'def kind(cmd):\n    match cmd:\n        case "get":\n            return "read"\n        case _:\n            return "other"\n',
    test: 'def test_kind():\n    assert m.kind("get") == "read"\n    assert m.kind("put") == "other"\n',
    w: 'm.kind("head")' }),
  py({ id: 'N13', cat: 'del-probe', kind: 'match-case class-pattern alternative deleted (bool before int)',
    cur: 'def tag(v):\n    match v:\n        case bool() | None:\n            return "flag"\n        case int():\n            return "num"\n        case _:\n            return "other"\n',
    prop: 'def tag(v):\n    match v:\n        case None:\n            return "flag"\n        case int():\n            return "num"\n        case _:\n            return "other"\n',
    test: 'def test_tag():\n    assert m.tag(None) == "flag"\n    assert m.tag(3) == "num"\n    assert m.tag("x") == "other"\n',
    w: 'm.tag(True)' }),
  py({ id: 'N14', cat: 'cond', kind: 'match guard: comparison tail deleted (deletes_condition must stay a veto)',
    cur: 'def bucket(v):\n    match v:\n        case int(n) if 0 <= n < 2 ** 53:\n            return "small"\n        case _:\n            return "big"\n',
    prop: 'def bucket(v):\n    match v:\n        case int(n) if 0 <= n:\n            return "small"\n        case _:\n            return "big"\n',
    test: 'def test_bucket():\n    assert m.bucket(5) == "small"\n    assert m.bucket(-1) == "big"\n',
    w: 'm.bucket(2 ** 60)' }),
  py({ id: 'N15', cat: 'del-probe', kind: 'match guard: and-operand deleted (isascii; non-ASCII never built?)',
    cur: 'def word(v):\n    match v:\n        case str(s) if s and s.isascii():\n            return "ascii"\n        case _:\n            return "other"\n',
    prop: 'def word(v):\n    match v:\n        case str(s) if s:\n            return "ascii"\n        case _:\n            return "other"\n',
    test: 'def test_word():\n    assert m.word("abc") == "ascii"\n    assert m.word("") == "other"\n    assert m.word(3) == "other"\n',
    w: 'm.word("\\u00e9")' }),
  py({ id: 'N16', cat: 'del-probe', kind: 'later comprehension iterable: sorted() dropped',
    cur: 'def pairs(xs, ys):\n    return [(a, b) for a in xs for b in sorted(ys)]\n',
    prop: 'def pairs(xs, ys):\n    return [(a, b) for a in xs for b in ys]\n',
    test: 'def test_pairs():\n    assert m.pairs([1], [1, 2]) == [(1, 1), (1, 2)]\n    assert m.pairs([], [2, 1]) == []\n',
    w: 'm.pairs([0], [2, 1])' }),
  py({ id: 'N17', cat: 'cond', kind: 'comprehension filter: chained tail deleted (deletes_condition)',
    cur: 'def smalls(xs):\n    return [x for x in xs if 0 < x < 2 ** 53]\n',
    prop: 'def smalls(xs):\n    return [x for x in xs if 0 < x]\n',
    test: 'def test_smalls():\n    assert m.smalls([1, -1, 2]) == [1, 2]\n',
    w: 'm.smalls([2 ** 60])' }),
  py({ id: 'N18', cat: 'cond', kind: 'chained tail operator weakened <= -> != (no comparison deleted: condition_change relaxed)',
    cur: 'def needs_bigint(n):\n    return 2 ** 53 < n <= 2 ** 64\n',
    prop: 'def needs_bigint(n):\n    return 2 ** 53 < n != 2 ** 64\n',
    test: 'def test_needs_bigint():\n    assert m.needs_bigint(5) is False\n    assert m.needs_bigint(2 ** 60) is True\n',
    w: 'm.needs_bigint(2 ** 70)' }),
  py({ id: 'N19', cat: 'cond', kind: 'three-way chain: middle comparator deleted',
    cur: 'def ordered(lo, hi):\n    return 0 <= lo <= hi <= 2 ** 32\n',
    prop: 'def ordered(lo, hi):\n    return 0 <= lo <= 2 ** 32\n',
    test: 'def test_ordered():\n    assert m.ordered(1, 2) is True\n    assert m.ordered(-1, 2) is False\n',
    w: 'm.ordered(5, 1)' }),
  py({ id: 'N20', cat: 'cond', kind: 'any(): or-operand comparison deleted inside a generator expression',
    cur: 'def bad(xs):\n    return any(x < 0 or x > 2 ** 53 for x in xs)\n',
    prop: 'def bad(xs):\n    return any(x < 0 for x in xs)\n',
    test: 'def test_bad():\n    assert m.bad([1, -2]) is True\n    assert m.bad([1, 2]) is False\n',
    w: 'm.bad([2 ** 60])' }),
  py({ id: 'N21', cat: 'del-probe', kind: 'statement in a returned closure deleted (oracle never calls the closure)',
    cur: 'def make_counter():\n    n = [0]\n\n    def inc(by=1):\n        n[0] += by\n        n[0] = max(n[0], 0)\n        return n[0]\n    return inc\n',
    prop: 'def make_counter():\n    n = [0]\n\n    def inc(by=1):\n        n[0] += by\n        return n[0]\n    return inc\n',
    test: 'def test_counter():\n    c = m.make_counter()\n    assert c() == 1\n    assert c(2) == 3\n',
    w: 'm.make_counter()(-5)' }),
  py({ id: 'N22', cat: 'domain', kind: 'byte length -> character length (.encode deleted; non-ASCII)',
    cur: 'def size(s):\n    return len(s.encode("utf-8"))\n', prop: 'def size(s):\n    return len(s)\n',
    test: 'def test_size():\n    assert m.size("abc") == 3\n    assert m.size("") == 0\n',
    w: 'm.size("\\u00e9")' }),
  py({ id: 'N23', cat: 'domain', kind: 'casefold -> lower (replaced member, German sharp s)',
    cur: 'def key(s):\n    return s.casefold()\n', prop: 'def key(s):\n    return s.lower()\n',
    test: 'def test_key():\n    assert m.key("AbC") == "abc"\n',
    w: 'm.key("\\u00df")' }),
  py({ id: 'N24', cat: 'domain', kind: 'int() truncation -> round() (replaced builtin)',
    cur: 'def whole(x):\n    return int(x)\n', prop: 'def whole(x):\n    return round(x)\n',
    test: 'def test_whole():\n    assert m.whole(3) == 3\n    assert m.whole(2.0) == 2\n',
    w: 'm.whole(2.7)' }),
  py({ id: 'N25', cat: 'domain', kind: 'strip() -> strip(" ") (tabs / newlines kept)',
    cur: 'def clean(s):\n    return s.strip()\n', prop: 'def clean(s):\n    return s.strip(" ")\n',
    test: 'def test_clean():\n    assert m.clean("  a ") == "a"\n',
    w: 'm.clean("\\ta\\n")' }),
  py({ id: 'N26', cat: 'domain', kind: 'isfinite guard deleted from a parser',
    pre: 'import math\n',
    cur: '\ndef parse(s):\n    x = float(s)\n    if not math.isfinite(x):\n        raise ValueError(s)\n    return x\n',
    prop: '\ndef parse(s):\n    return float(s)\n',
    test: 'def test_parse():\n    assert m.parse("1.5") == 1.5\n',
    w: 'm.parse("inf")' }),
  py({ id: 'N27', cat: 'domain', kind: 'dedupe sorted(set(xs)) -> sorted(xs)',
    cur: 'def uniq(xs):\n    return sorted(set(xs))\n', prop: 'def uniq(xs):\n    return sorted(xs)\n',
    test: 'def test_uniq():\n    assert m.uniq([2, 1]) == [1, 2]\n',
    w: 'm.uniq([1, 1])' }),
  py({ id: 'N28', cat: 'domain', kind: 'NFC normalisation added before comparison (combining marks never built?)',
    pre: 'import unicodedata\n',
    cur: '\ndef same(a, b):\n    return a == b\n', prop: '\ndef same(a, b):\n    return unicodedata.normalize("NFC", a) == unicodedata.normalize("NFC", b)\n',
    test: 'def test_same():\n    assert m.same("a", "a") is True\n    assert m.same("a", "b") is False\n',
    w: 'm.same("e\\u0301", "\\u00e9")' }),
  py({ id: 'N29', cat: 'ref-local', kind: 'cap is a keyword default of a nested helper outside the hunk',
    cur: 'def body(s):\n    def cut(x, n=4096):\n        return x[0:n]\n    return str(s)\n',
    prop: 'def body(s):\n    def cut(x, n=4096):\n        return x[0:n]\n    return cut(str(s)) + ""\n',
    test: 'def test_body():\n    assert m.body("abc") == "abc"\n',
    w: 'len(m.body("x" * 5000))' }),
];

module.exports = { CASES };
