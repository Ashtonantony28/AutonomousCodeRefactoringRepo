'use strict';

// AUDIT-21 corpus: fresh witnessed semantics changes, none of them shapes in
// audit/5, 8, 12, 13, 16 or 20. Each has a suite that calls the edited code
// and passes on the current version (run.js checks this: BADSUITE otherwise)
// and a witness `w` whose value differs between the versions in a real
// node / python process (run.js checks this: BADWITNESS otherwise).
//
// Entry: { id, cat, kind, py?, ext?, pre?, cur, prop, rest?, test, tests?, pkg?, w, expect? }
//   JS   src/<id>.<ext || js> = `'use strict';\n${pre}\n${cur}\n${rest}\n`
//        test/<id>.test.js requires `../src/<id>.<ext>` as `m`; `test`/`assert` in scope.
//   Py   app/<id>.py   = `${pre}\n${cur}\n${rest}`
//        tests/test_<id>.py = `import app.<id> as m\n\n\n${test}`
//   tests: extra files (path -> content). expect: 'stop' for controls.
//
// Categories
//   op     the change is carried by an operator or keyword (`-`, `in`, `|`,
//          `>>`, `>>>`, `//`, `**`, `<<`): no site, not a token the
//          fail-closed rule lists; the hunk stands on a sibling's kill.
//          Diff-test blind inputs (long strings, big numbers, tabs, lists
//          over 100, prototype keys).
//   jsx    same, in a .jsx file (plain JS): no diff test runs ("another
//          language"), so the executor bar is the only check.
//   delins .jsx: deleted operator replaced by an operator + a literal; the
//          stretch stands on the literal's kill.
//   mlit   the changed line is inside / closes a multi-line template literal
//          or triple-quoted string: tokensOf starts mid-literal, quotes in
//          the literal text pair up with code, and the code between becomes
//          one "string" token covered by any mutant inside it.
//   sham   the sham control: a source-size test that ignores whitespace, a
//          source grep (documented), a removal mutant (no sham).
//   tmpl   SG30 template / f-string / regex tokenisation: nested and tagged
//          templates, comments in `${}`, f-string format spec and
//          conversion, regex flag, bytes regex.

const js = (o) => o;
const py = (o) => ({ ...o, py: true });
const L = (...lines) => lines.join('\n');

const LONG = "'x'.repeat(5000)";
const PLONG = "'x' * 5000";

// Source-size budget tests: total size of src/ (app/) with ALL whitespace
// removed must stay under a limit (a "bundle size" check). The limit is the
// current file's size + 120, so the edit itself fits.
const nows = (s) => s.replace(/\s+/g, '').length;
const jsSize = (limit) => L(
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "test('size: src/ stays within its minified budget', () => {",
  "  const dir = path.join(__dirname, '..', 'src');",
  "  let n = 0;",
  "  for (const f of fs.readdirSync(dir)) n += fs.readFileSync(path.join(dir, f), 'utf8').replace(/\\s+/g, '').length;",
  `  assert.ok(n <= ${limit}, String(n));`,
  '});',
  '');
const pySize = (limit) => L(
  'import pathlib',
  '',
  '',
  'def test_size_budget():',
  "    root = pathlib.Path(__file__).resolve().parent.parent / 'app'",
  "    n = sum(len(''.join(p.read_text().split())) for p in root.glob('*.py'))",
  `    assert n <= ${limit}, n`,
  '');
const JS_NO_ARROW = L(
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "test('lint: no arrow functions in src (ES5 target)', () => {",
  "  const dir = path.join(__dirname, '..', 'src');",
  "  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('=>'), f);",
  '});',
  '');
const PY_NO_LAMBDA = L(
  'import pathlib',
  '',
  '',
  'def test_no_lambda():',
  "    for p in (pathlib.Path(__file__).resolve().parent.parent / 'app').glob('*.py'):",
  "        assert 'lambda' not in p.read_text(), p.name",
  '');

const jsBudget = (pre, cur, rest) => nows(`'use strict';\n${pre ? `${pre}\n` : ''}${cur}\n${rest || ''}\n`) + 120;
const pyBudget = (pre, cur, rest) => nows(`${pre ? `${pre}\n` : ''}${cur}${rest ? `\n${rest}` : ''}\n`) + 120;

const S_PRE = 'const SKIP = 1;\nconst MAX_LEN = 4096;';
const S_CUR = L('function body(s) {', '  return String(s).slice(SKIP);', '}');
const S_REST = 'module.exports = { body };';
const SP_PRE = 'SKIP = 1\nMAX_LEN = 4096\n';
const SP_CUR = L('def body(s):', '    return str(s)[SKIP:]');

const CASES = [
  // ================================================================ op
  js({ id: 'O01', cat: 'op', kind: 'head cap -> tail cap: slice(0, 0x1000) -> slice(-0x1000); inserted `-` only',
    cur: L('function head(s) {', "  return 'head:' + String(s).slice(0, 0x1000);", '}'),
    prop: L('function head(s) {', '  return "head:" + String(s).slice(-0x1000);', '}'),
    rest: 'module.exports = { head };',
    test: "test('head', () => { assert.strictEqual(m.head('abc'), 'head:abc'); assert.strictEqual(m.head(''), 'head:'); });",
    w: `m.head('a' + ${LONG}).slice(0, 6)` }),
  py({ id: 'O02', cat: 'op', kind: 'head cap -> tail cap: [:0x1000] -> [-0x1000:]; inserted `-`',
    cur: L('def head(s):', "    return 'head:' + str(s)[:0x1000]"),
    prop: L('def head(s):', '    return "head:" + str(s)[-0x1000:]'),
    test: L('def test_head():', '    assert m.head("abc") == "head:abc"', '    assert m.head("") == "head:"'),
    w: `m.head('a' + ${PLONG})[:6]` }),
  js({ id: 'O03', cat: 'op', kind: "typeof TABLE[k] === 'number' -> k in TABLE (prototype keys); inserted `in`",
    pre: 'const TABLE = { a: 1, b: 2 };',
    cur: L('function has(k) {', "  return 'has=' + (typeof TABLE[k] === 'number');", '}'),
    prop: L('function has(k) {', '  return "has=" + (k in TABLE);', '}'),
    rest: 'module.exports = { has };',
    test: "test('has', () => { assert.strictEqual(m.has('a'), 'has=true'); assert.strictEqual(m.has('b'), 'has=true'); assert.strictEqual(m.has('zz'), 'has=false'); });",
    w: "m.has('toString')" }),
  js({ id: 'O04', cat: 'op', kind: 'hasOwnProperty.call -> `in` (prototype keys)',
    pre: 'const ROLES = { admin: 1, user: 2 };',
    cur: L('function known(r) {', "  return 'known=' + Object.prototype.hasOwnProperty.call(ROLES, r);", '}'),
    prop: L('function known(r) {', '  return "known=" + (r in ROLES);', '}'),
    rest: 'module.exports = { known };',
    test: "test('known', () => { assert.strictEqual(m.known('admin'), 'known=true'); assert.strictEqual(m.known('user'), 'known=true'); assert.strictEqual(m.known('x'), 'known=false'); });",
    w: "m.known('constructor')" }),
  js({ id: 'O05', cat: 'op', kind: 'Math.trunc(x) -> x | 0 (wrong past 2**31); inserted `|`',
    cur: L('function whole(n) {', "  return 'w=' + Math.trunc(Number(n) || 0);", '}'),
    prop: L('function whole(n) {', '  return "w=" + ((Number(n) || 0) | 0);', '}'),
    rest: 'module.exports = { whole };',
    test: "test('whole', () => { assert.strictEqual(m.whole(3.7), 'w=3'); assert.strictEqual(m.whole(-2.5), 'w=-2'); assert.strictEqual(m.whole(null), 'w=0'); });",
    w: 'm.whole(2 ** 31)' }),
  js({ id: 'O06', cat: 'op', kind: 'Math.floor(x / 2) -> x >> 1 (wrong past 2**31); `1` is killed, `>>` is not judged',
    cur: L('function half(n) {', "  return 'h=' + Math.floor(Math.abs(Number(n) || 0) / 2);", '}'),
    prop: L('function half(n) {', '  return "h=" + (Math.abs(Number(n) || 0) >> 1);', '}'),
    rest: 'module.exports = { half };',
    test: "test('half', () => { assert.strictEqual(m.half(9), 'h=4'); assert.strictEqual(m.half(-8), 'h=4'); });",
    w: 'm.half(2 ** 31)' }),
  js({ id: 'O07', cat: 'op', kind: 'Math.trunc(abs) -> x >>> 0 (wrong past 2**32)',
    cur: L('function u32(n) {', "  return 'u=' + Math.trunc(Math.abs(Number(n) || 0));", '}'),
    prop: L('function u32(n) {', '  return "u=" + (Math.abs(Number(n) || 0) >>> 0);', '}'),
    rest: 'module.exports = { u32 };',
    test: "test('u32', () => { assert.strictEqual(m.u32(5.5), 'u=5'); assert.strictEqual(m.u32(-3), 'u=3'); });",
    w: 'm.u32(2 ** 32 + 1)' }),
  js({ id: 'O08', cat: 'op', kind: 'x * 2 -> x << 1 (wrong past 2**30)',
    cur: L('function dbl(n) {', "  return 'd=' + Math.trunc(Number(n) || 0) * 2;", '}'),
    prop: L('function dbl(n) {', '  return "d=" + (Math.trunc(Number(n) || 0) << 1);', '}'),
    rest: 'module.exports = { dbl };',
    test: "test('dbl', () => { assert.strictEqual(m.dbl(3), 'd=6'); assert.strictEqual(m.dbl(-4), 'd=-8'); });",
    w: 'm.dbl(2 ** 30)' }),
  py({ id: 'O09', cat: 'op', kind: 'int(a / 2) -> a // 2 (exact past 2**53); inserted `//` only',
    cur: L('def half(n):', "    return 'h=' + str(int(abs(int(n)) / 2))"),
    prop: L('def half(n):', '    return "h=" + str(abs(int(n)) // 2)'),
    test: L('def test_half():', '    assert m.half(7) == "h=3"', '    assert m.half(-9) == "h=4"'),
    w: 'm.half(2 ** 53 + 3)' }),
  py({ id: 'O10', cat: 'op', kind: 'math.ceil(a / b) -> -(-a // b); inserted `-`, `//`',
    pre: 'import math\n',
    cur: L('def pages(a, b):', "    return 'p=' + str(math.ceil(int(a) / int(b)))"),
    prop: L('def pages(a, b):', '    return "p=" + str(-(-int(a) // int(b)))'),
    test: L('def test_pages():', '    assert m.pages(7, 2) == "p=4"', '    assert m.pages(6, 3) == "p=2"'),
    w: 'm.pages(2 ** 53 + 1, 1)' }),
  py({ id: 'O11', cat: 'op', kind: 'expandtabs(4) -> expandtabs(-4) (tabs dropped); inserted `-`',
    cur: L('def quote(s):', "    return '> ' + str(s).expandtabs(4)"),
    prop: L('def quote(s):', '    return "> " + str(s).expandtabs(-4)'),
    test: L('def test_quote():', '    assert m.quote("a") == "> a"', '    assert m.quote(3) == "> 3"'),
    w: "m.quote('a\\tb')" }),
  py({ id: 'O12', cat: 'op', kind: 'first of [:100] -> first of [-100:]; inserted `-`, `:`',
    cur: L('def first(xs):', "    return 'f=' + str(next(iter(list(xs)[:100]), None))"),
    prop: L('def first(xs):', '    return "f=" + str(next(iter(list(xs)[-100:]), None))'),
    test: L('def test_first():', '    assert m.first([1, 2, 3]) == "f=1"', '    assert m.first([]) == "f=None"'),
    w: 'm.first(range(150))' }),
  py({ id: 'O13', cat: 'op', kind: 'int((a + b) / 2) -> (a + b) // 2 (past 2**53)',
    cur: L('def avg(a, b):', "    return 'a=' + str(int((abs(int(a)) + abs(int(b))) / 2))"),
    prop: L('def avg(a, b):', '    return "a=" + str((abs(int(a)) + abs(int(b))) // 2)'),
    test: L('def test_avg():', '    assert m.avg(3, 4) == "a=3"', '    assert m.avg(-3, 5) == "a=4"'),
    w: 'm.avg(2 ** 53 + 1, 2 ** 53 + 2)' }),
  py({ id: 'O14', cat: 'op', kind: 'int(math.pow(n, 2)) -> n ** 2 (exact past 2**26)',
    pre: 'import math\n',
    cur: L('def sq(n):', "    return 'sq=' + str(int(math.pow(int(n), 2)))"),
    prop: L('def sq(n):', '    return "sq=" + str(int(n) ** 2)'),
    test: L('def test_sq():', '    assert m.sq(3) == "sq=9"', '    assert m.sq(-4) == "sq=16"'),
    w: 'm.sq(2 ** 30 + 1)' }),

  // ================================================================ jsx (no diff test)
  js({ id: 'X01', cat: 'jsx', ext: 'jsx', kind: '.jsx: slice(n) -> slice(-n); inserted `-`, sibling re-quoted string',
    cur: L('function tail(s, n) {', "  return 't=' + String(s).slice(n);", '}'),
    prop: L('function tail(s, n) {', '  return "t=" + String(s).slice(-n);', '}'),
    rest: 'module.exports = { tail };',
    test: "test('tail', () => { assert.strictEqual(m.tail('abcd', 2), 't=cd'); assert.strictEqual(m.tail('xy', 1), 't=y'); });",
    w: "m.tail('abcdef', 1)" }),
  js({ id: 'X02', cat: 'jsx', ext: 'jsx', kind: '.jsx: result negated with `!`; suite checks the label format',
    cur: L('function blank(s) {', "  return 'blank=' + (String(s).trim() === '');", '}'),
    prop: L('function blank(s) {', '  return "blank=" + !(String(s).trim() === \'\');', '}'),
    rest: 'module.exports = { blank };',
    test: "test('blank', () => { assert.match(m.blank(' '), /^blank=(true|false)$/); assert.match(m.blank('a'), /^blank=(true|false)$/); });",
    w: "m.blank('a')" }),
  js({ id: 'X03', cat: 'jsx', ext: 'jsx', kind: '.jsx: slice(0, n) -> slice(0, -n); inserted `-`',
    cur: L('function head(xs, n) {', "  return 'h=' + xs.slice(0, n).join(',');", '}'),
    prop: L('function head(xs, n) {', '  return "h=" + xs.slice(0, -n).join(\',\');', '}'),
    rest: 'module.exports = { head };',
    test: "test('head', () => { assert.strictEqual(m.head([1, 2, 3, 4], 2), 'h=1,2'); assert.strictEqual(m.head([5, 6], 1), 'h=5'); });",
    w: 'm.head([1, 2, 3, 4, 5, 6], 1)' }),

  // ================================================================ delins (.jsx)
  js({ id: 'Y01', cat: 'delins', ext: 'jsx', kind: '.jsx: n * 2 -> n ** 2.0; stretch {*,2}->{**,2.0} stands on 2.0 -> 3',
    cur: L('function sq(n) {', "  return 's=' + n * 2;", '}'),
    prop: L('function sq(n) {', "  return 's=' + n ** 2.0;", '}'),
    rest: 'module.exports = { sq };',
    test: "test('sq', () => { assert.strictEqual(m.sq(2), 's=4'); assert.strictEqual(m.sq(0), 's=0'); });",
    w: 'm.sq(3)' }),
  js({ id: 'Y02', cat: 'delins', ext: 'jsx', kind: '.jsx: x || 1 -> x ?? 1.0; stretch stands on 1.0 -> 2',
    cur: L('function qty(x) {', "  return 'q=' + (x || 1);", '}'),
    prop: L('function qty(x) {', "  return 'q=' + (x ?? 1.0);", '}'),
    rest: 'module.exports = { qty };',
    test: "test('qty', () => { assert.strictEqual(m.qty(null), 'q=1'); assert.strictEqual(m.qty(5), 'q=5'); });",
    w: 'm.qty(0)' }),
  js({ id: 'Y03', cat: 'delins', ext: 'jsx', kind: '.jsx: n <= HI -> n != HI + 1 (every site killed; above HI+1 now in range)',
    pre: 'const LO = 0;\nconst HI = 9;',
    cur: L('function inRange(n) {', "  return 'in=' + (n >= LO && n <= HI);", '}'),
    prop: L('function inRange(n) {', "  return 'in=' + (n >= LO && n != HI + 1);", '}'),
    rest: 'module.exports = { inRange };',
    test: "test('inRange', () => { for (const [n, v] of [[5, true], [-1, false], [10, false], [8, true], [9, true]]) assert.strictEqual(m.inRange(n), 'in=' + v); });",
    w: 'm.inRange(50)' }),

  // ================================================================ mlit
  js({ id: 'M01', cat: 'mlit', kind: 'line inside a multi-line HTML template: href="${...}" quotes make one string token; slice(0, 0x800) cap',
    cur: L('function link(u, t) {', '  return `', '<a href="${String(u)}">${t}</a>', '`.trim();', '}'),
    prop: L('function link(u, t) {', '  return `', '<a href="${String(u).slice(0, 0x800)}">${t}</a>', '`.trim();', '}'),
    rest: 'module.exports = { link };',
    test: "test('link', () => { assert.strictEqual(m.link('/a', 'x'), '<a href=\"/a\">x</a>'); assert.strictEqual(m.link('', ''), '<a href=\"\"></a>'); });",
    w: `m.link('/' + ${LONG}, 't').length` }),
  js({ id: 'M02', cat: 'mlit', kind: 'closing line of a multi-line template: `.trim() ... later backtick swallows the code; slice(0, 0x1000) cap',
    cur: L('function card(t) {', '  return `', '<b>${t}</b>', '`.trim() + "!";', '}'),
    prop: L('function card(t) {', '  return `', '<b>${t}</b>', '`.trim().slice(0, 0x1000) + "!";', '}'),
    rest: L('function foot() { return `-`; }', 'module.exports = { card, foot };'),
    test: "test('card', () => { assert.strictEqual(m.card('t'), '<b>t</b>!'); assert.strictEqual(m.foot(), '-'); });",
    w: `m.card(${LONG}).length` }),
  js({ id: 'M03', cat: 'mlit', kind: "apostrophes in multi-line template text pair up around ${}: NFKC added",
    cur: L('function clock(n) {', '  return `', "It's ${String(n)} o'clock", '`.trim();', '}'),
    prop: L('function clock(n) {', '  return `', "It's ${String(n).normalize(\"NFKC\")} o'clock", '`.trim();', '}'),
    rest: 'module.exports = { clock };',
    test: "test('clock', () => { assert.strictEqual(m.clock(5), \"It's 5 o'clock\"); assert.strictEqual(m.clock('ten'), \"It's ten o'clock\"); });",
    w: "m.clock('\\uff15')" }),
  js({ id: 'M04', cat: 'mlit', kind: 'multi-line template, attribute quotes: zero-width strip added in title="${...}"',
    cur: L('function tip(t) {', '  return `', '<span title="${String(t).trim()}">?</span>', '`.trim();', '}'),
    prop: L('function tip(t) {', '  return `', '<span title="${String(t).replace(/\\u200b/g, "").trim()}">?</span>', '`.trim();', '}'),
    rest: 'module.exports = { tip };',
    test: "test('tip', () => { assert.strictEqual(m.tip(' a '), '<span title=\"a\">?</span>'); assert.strictEqual(m.tip('b'), '<span title=\"b\">?</span>'); });",
    w: "m.tip('a\\u200bb')" }),
  py({ id: 'M05', cat: 'mlit', kind: 'closing line of a triple-quoted string: """ ... "!" pair up; str(s)[:0x1000] cap',
    cur: L('def banner(s):', '    return """', '== {} ==', '""".strip().format(s) + "!"'),
    prop: L('def banner(s):', '    return """', '== {} ==', '""".strip().format(str(s)[:0x1000]) + "!"'),
    test: L('def test_banner():', '    assert m.banner("a") == "== a ==!"', '    assert m.banner(3) == "== 3 ==!"'),
    w: `len(m.banner(${PLONG}))` }),
  py({ id: 'M06', cat: 'mlit', kind: 'multi-line f-string, attribute quotes: str(u)[0:0x800] cap in href="{...}"',
    cur: L('def link(u, t):', '    return f"""', '<a href="{u}">{t}</a>', '""".strip()'),
    prop: L('def link(u, t):', '    return f"""', '<a href="{str(u)[0:0x800]}">{t}</a>', '""".strip()'),
    test: L('def test_link():', '    assert m.link("/a", "x") == \'<a href="/a">x</a>\'', '    assert m.link("", "") == \'<a href=""></a>\''),
    w: `len(m.link('/' + ${PLONG}, 't'))` }),
  py({ id: 'M07', cat: 'mlit', kind: "apostrophes in multi-line f-string text pair up: [0:0x400] cap",
    cur: L('def clock(n):', '    return f"""', "It's {n} o'clock", '""".strip()'),
    prop: L('def clock(n):', '    return f"""', "It's {str(n)[0:0x400]} o'clock", '""".strip()'),
    test: L('def test_clock():', '    assert m.clock(5) == "It\'s 5 o\'clock"', '    assert m.clock("ten") == "It\'s ten o\'clock"'),
    w: `len(m.clock(${PLONG}))` }),
  py({ id: 'M08', cat: 'mlit', kind: 'closing line of a triple-quoted string, later docstring pairs with """: expandtabs(-4)',
    cur: L('def note(s):', '    return """', 'note:', '""".strip() + " " + str(s).expandtabs(4)'),
    prop: L('def note(s):', '    return """', 'note:', '""".strip() + " " + str(s).expandtabs(-4)'),
    rest: L('', '', 'def foot():', '    """Footer."""', '    return "-"'),
    test: L('def test_note():', '    assert m.note("a") == "note: a"', '    assert m.foot() == "-"'),
    w: "m.note('a\\tb')" }),

  // ================================================================ sham
  js({ id: 'S01', cat: 'sham', kind: 'size budget ignoring whitespace kills the use-site mutants; the sham (spaces) passes it',
    pre: S_PRE, cur: S_CUR, rest: S_REST,
    prop: L('function body(s) {', '  return String(s).slice(SKIP, SKIP + MAX_LEN);', '}'),
    test: "test('body', () => { assert.strictEqual(m.body('xabc'), 'abc'); assert.strictEqual(m.body('x'), ''); });",
    tests: { 'test/size.test.js': jsSize(jsBudget(S_PRE, S_CUR, S_REST)) },
    w: `m.body(${LONG}).length` }),
  py({ id: 'S02', cat: 'sham', kind: 'size budget ignoring whitespace (Python)',
    pre: SP_PRE, cur: SP_CUR,
    prop: L('def body(s):', '    return str(s)[SKIP:SKIP + MAX_LEN]'),
    test: L('def test_body():', '    assert m.body("xabc") == "abc"', '    assert m.body("x") == ""'),
    tests: { 'tests/test_size.py': pySize(pyBudget(SP_PRE, SP_CUR)) },
    w: `len(m.body(${PLONG}))` }),
  js({ id: 'S03', cat: 'sham', kind: 'source grep for `=>` (ES5 lint) kills the use-site mutants (README: greps have no sham)',
    pre: S_PRE, cur: S_CUR, rest: S_REST,
    prop: L('function body(s) {', '  return String(s).slice(SKIP, SKIP + MAX_LEN);', '}'),
    test: "test('body', () => { assert.strictEqual(m.body('xabc'), 'abc'); assert.strictEqual(m.body('x'), ''); });",
    tests: { 'test/lint.test.js': JS_NO_ARROW },
    w: `m.body(${LONG}).length` }),
  py({ id: 'S04', cat: 'sham', kind: 'source grep for `lambda` kills the use-site mutants (README: greps have no sham)',
    pre: SP_PRE, cur: SP_CUR,
    prop: L('def body(s):', '    return str(s)[SKIP:SKIP + MAX_LEN]'),
    test: L('def test_body():', '    assert m.body("xabc") == "abc"', '    assert m.body("x") == ""'),
    tests: { 'tests/test_lint.py': PY_NO_LAMBDA },
    w: `len(m.body(${PLONG}))` }),
  py({ id: 'S05', cat: 'sham', expect: 'stop', kind: 'control: size budget, but the only use site is a call skip (text removed, no sham needed)',
    pre: 'import unicodedata\n',
    cur: L('def key(name):', "    return 'k:' + str(name).lower()"),
    prop: L('def key(name):', "    return 'k:' + unicodedata.normalize('NFC', str(name)).lower()"),
    test: L('def test_key():', '    assert m.key("Ab") == "k:ab"'),
    tests: { 'tests/test_size.py': pySize(pyBudget('import unicodedata\n', L('def key(name):', "    return 'k:' + str(name).lower()"))) },
    w: "m.key('e\\u0301')" }),
  js({ id: 'S06', cat: 'sham', expect: 'stop', kind: 'control: S01 with a size test that counts whitespace too (sham fails it)',
    pre: S_PRE, cur: S_CUR, rest: S_REST,
    prop: L('function body(s) {', '  return String(s).slice(SKIP, SKIP + MAX_LEN);', '}'),
    test: "test('body', () => { assert.strictEqual(m.body('xabc'), 'abc'); assert.strictEqual(m.body('x'), ''); });",
    tests: { 'test/size.test.js': jsSize(`'use strict';\n${S_PRE}\n${S_CUR}\n${S_REST}\n`.length + 120).replace(".replace(/\\s+/g, '')", '') },
    w: `m.body(${LONG}).length` }),

  // ================================================================ tmpl (SG30 tokenisation)
  py({ id: 'T01', cat: 'tmpl', kind: 'f-string format spec: {str(s)} -> {str(s):.4096} (text part, one site)',
    cur: L('def label(s):', '    return f"[{str(s)}]"'),
    prop: L('def label(s):', '    return f"[{str(s):.4096}]"'),
    test: L('def test_label():', '    assert m.label("a") == "[a]"', '    assert m.label(3) == "[3]"'),
    w: `len(m.label(${PLONG}))` }),
  py({ id: 'T02', cat: 'tmpl', kind: 'f-string conversion !r -> !a (escapes non-ASCII)',
    cur: L('def show(s):', '    return f"<{str(s)!r}>"'),
    prop: L('def show(s):', '    return f"<{str(s)!a}>"'),
    test: L('def test_show():', '    assert m.show("a") == "<\'a\'>"', '    assert m.show(3) == "<\'3\'>"'),
    w: "m.show('\\u00e9')" }),
  js({ id: 'T03', cat: 'tmpl', expect: 'stop', kind: 'nested template: inner ${} gets a cap; sibling re-quoted string',
    cur: L('function list(xs) {', "  return '<ul>' + `${xs.map((x) => `<li>${x}</li>`).join('')}`;", '}'),
    prop: L('function list(xs) {', '  return "<ul>" + `${xs.map((x) => `<li>${String(x).slice(0, 0x100)}</li>`).join(\'\')}`;', '}'),
    rest: 'module.exports = { list };',
    test: "test('list', () => { assert.strictEqual(m.list(['a', 'b']), '<ul><li>a</li><li>b</li>'); });",
    w: "m.list(['x'.repeat(300)]).length" }),
  js({ id: 'T04', cat: 'tmpl', expect: 'stop', kind: 'tagged template String.raw: cap inside ${}',
    cur: L('function raw(t) {', "  return 'r:' + String.raw`${t}\\t`;", '}'),
    prop: L('function raw(t) {', '  return "r:" + String.raw`${String(t).slice(0, 0x1000)}\\t`;', '}'),
    rest: 'module.exports = { raw };',
    test: "test('raw', () => { assert.strictEqual(m.raw('a'), 'r:a\\\\t'); });",
    w: `m.raw(${LONG}).length` }),
  js({ id: 'T05', cat: 'tmpl', expect: 'stop', kind: 'comment holding `}` inside ${}: cap after it',
    cur: L('function box(t) {', "  return '[' + `${/* } */ t}` + ']';", '}'),
    prop: L('function box(t) {', '  return "[" + `${/* } */ String(t).slice(0, 0x1000)}` + "]";', '}'),
    rest: 'module.exports = { box };',
    test: "test('box', () => { assert.strictEqual(m.box('a'), '[a]'); assert.strictEqual(m.box(''), '[]'); });",
    w: `m.box(${LONG}).length` }),
  js({ id: 'T06', cat: 'tmpl', expect: 'stop', kind: 'regex flag u added to /./g (astral chars); flag site must be killed',
    cur: L('function chars(s) {', "  return 'n=' + (String(s).match(/./g) || []).length;", '}'),
    prop: L('function chars(s) {', '  return "n=" + (String(s).match(/./gu) || []).length;', '}'),
    rest: 'module.exports = { chars };',
    test: "test('chars', () => { assert.strictEqual(m.chars('abc'), 'n=3'); assert.strictEqual(m.chars(''), 'n=0'); });",
    w: "m.chars('\\u{1F600}')" }),
  py({ id: 'T07', cat: 'tmpl', kind: "bytes regex rb'\\t' -> rb'\\t+' (string site, D09 shape with a bytes prefix)",
    pre: 'import re\n',
    cur: L('def squash(s):', "    return re.sub(rb'\\t', b' ', str(s).encode()).decode()"),
    prop: L('def squash(s):', "    return re.sub(rb'\\t+', b' ', str(s).encode()).decode()"),
    test: L('def test_squash():', '    assert m.squash("a\\tb") == "a b"', '    assert m.squash("ab") == "ab"'),
    w: "m.squash('a\\t\\tb')" }),
  py({ id: 'T08', cat: 'tmpl', expect: 'stop', kind: 'f-string nested spec {s:>{w}} -> {str(s)[:0x1000]:>{w}}',
    cur: L('def pad(s, w):', '    return f"[{s:>{w}}]"'),
    prop: L('def pad(s, w):', '    return f"[{str(s)[:0x1000]:>{w}}]"'),
    test: L('def test_pad():', '    assert m.pad("a", 3) == "[  a]"', '    assert m.pad("abc", 1) == "[abc]"'),
    w: `len(m.pad(${PLONG}, 1))` })
];

module.exports = { CASES };
