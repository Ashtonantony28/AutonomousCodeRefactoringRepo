'use strict';

// AUDIT-23 corpus: fresh witnessed semantics changes, none of them shapes in
// audit/5, 8, 12, 13, 16, 20 or 21. Each has a suite that calls the edited
// code and passes on the current version (run.js checks this: BADSUITE
// otherwise) and a witness `w` whose value differs between the versions in
// a real node / python process (run.js checks this: BADWITNESS otherwise).
// Most entries change behaviour only on inputs the diff test never builds
// (decomposed / compatibility characters, zero-width, NBSP, CR, NaN, strings
// past 5,000 characters, lists past 150 / arrays past 2,000), so the diff
// test reads `equivalent` and the executor bar decides.
//
// Entry: { id, cat, kind, py?, pre?, cur, prop, rest?, test, tests?, w, expect? }
//   JS   src/<id>.js   = `'use strict';\n${pre}\n${cur}\n${rest}\n`
//        test/<id>.test.js requires `../src/<id>` as `m`; `test`/`assert` in scope.
//   Py   app/<id>.py   = `${pre}\n${cur}\n${rest}`
//        tests/test_<id>.py = `import app.<id> as m\n\n\n${test}`
//   tests: extra files (path -> content). expect: 'stop' for controls.
//
// Categories
//   punct  brackets / braces / parens carry the change (a statement moved
//          into a block, an expression's scope widened, an assert turned
//          into a tuple). Punctuation needs no coverage; a sibling site in
//          the same hunk (a re-quoted string, a respelled number, a new
//          constant read) is killed and the hunk stands on it.
//   indent Python: a statement indented into a block. The indentation
//          token is whitespace (no coverage needed); a sibling site in the
//          same hunk is killed.
//   cont   a backslash-continued string literal. The token regex does not
//          follow `\` + newline, so on the next line the closing quote pairs
//          with the next quote: the code between is one "string" token, and
//          the names in it (`normalize`, `replace`) get no use site.
//   wrap   a token with no mutant (`typeof`, comprehension keywords) is
//          covered because it lies inside the expression a use-site mutant
//          of an inserted (moved) wrapper call perturbs.
//   sham   source-reading tests the sham does not stop: a word-count size
//          budget, a branch-count complexity budget. Controls: a
//          whitespace-stripped length budget (stopped by the sham).
//   bound  `=` / `const` / `let` / `var` covered through the next token.
//   range  an operator / literal change whose effect is past the lengths the
//          diff test tries; the operator mutant is killed on small inputs.
//   slide  a pure insertion that slides left onto an existing argument: the
//          use-site mutant perturbs the old argument, not the new one.

const js = (o) => o;
const py = (o) => ({ ...o, py: true });
const L = (...lines) => lines.join('\n');

const words = (s) => (s.match(/\w+/g) || []).length;
const branches = (s) => (s.match(/\?|&&|\|\|/g) || []).length;
const pyBranches = (s) => (s.match(/\b(?:if|and|or)\b/g) || []).length;
const nows = (s) => s.replace(/\s+/g, '').length;
const jsSrc = (pre, cur, rest) => `'use strict';\n${pre ? `${pre}\n` : ''}${cur}\n${rest || ''}\n`;
const pySrc = (pre, cur, rest) => `${pre ? `${pre}\n` : ''}${cur}${rest ? `\n${rest}` : ''}\n`;

// A source budget test over every file in src/ (app/): `measure` (a JS
// function body over `t`, the file text) summed must stay <= limit.
const jsBudget = (title, measure, limit) => L(
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  `test(${JSON.stringify(title)}, () => {`,
  "  const dir = path.join(__dirname, '..', 'src');",
  '  let n = 0;',
  `  for (const f of fs.readdirSync(dir)) { const t = fs.readFileSync(path.join(dir, f), 'utf8'); n += ${measure}; }`,
  `  assert.ok(n <= ${limit}, String(n));`,
  '});',
  '');
const pyBudget = (name, measure, limit) => L(
  'import pathlib',
  'import re',
  '',
  '',
  `def ${name}():`,
  "    root = pathlib.Path(__file__).resolve().parent.parent / 'app'",
  `    n = sum(${measure} for t in (p.read_text() for p in root.glob('*.py')))`,
  `    assert n <= ${limit}, n`,
  '');

const S_PRE = 'const SKIP = 1;\nconst MAX_LEN = 10000;';
const S_CUR = L('function body(s) {', '  return String(s).slice(SKIP);', '}');
const S_PROP = L('function body(s) {', '  return String(s).slice(SKIP, SKIP + MAX_LEN);', '}');
const S_REST = 'module.exports = { body };';
const S_TEST = "test('body', () => { assert.strictEqual(m.body('xabc'), 'abc'); assert.strictEqual(m.body(''), ''); });";
const SP_PRE = 'SKIP = 1\nMAX_LEN = 10000\n';
const SP_CUR = L('def body(s):', '    return str(s)[SKIP:]');
const SP_PROP = L('def body(s):', '    return str(s)[SKIP:SKIP + MAX_LEN]');
const SP_TEST = L('def test_body():', '    assert m.body("xabc") == "abc"', '    assert m.body("") == ""');
const LONG20K = "'a' + 'x'.repeat(20000)";

const UP_JS = 'const up = (x) => String(x).toUpperCase();';
const UP_PY = 'import unicodedata\n\n\ndef up(x):\n    return str(x).upper()\n\n';

const CASES = [
  // ================================================================ punct
  js({ id: 'P01', cat: 'punct', kind: 'braces: NFC normalisation moved into the length-cap `if`; sibling re-quoted "NFC"',
    cur: L('function clean(s) {', '  let out = String(s);', '  if (out.length > 4096) out = out.slice(0, 4096);', "  out = out.normalize('NFC');", '  return out;', '}'),
    prop: L('function clean(s) {', '  let out = String(s);', '  if (out.length > 4096) { out = out.slice(0, 4096);', '  out = out.normalize("NFC"); }', '  return out;', '}'),
    rest: 'module.exports = { clean };',
    test: "test('clean', () => { assert.strictEqual(m.clean('a'.repeat(5000)).length, 4096); assert.strictEqual(m.clean('ab'), 'ab'); });",
    w: "m.clean('e\\u0301').length" }),
  js({ id: 'P02', cat: 'punct', kind: 'braces: zero-width strip moved into the `includes(" ")` branch; sibling re-quoted "-"',
    cur: L('function tag(s) {', '  let out = String(s).trim();', "  if (out.includes(' ')) out = out.split(' ').join('-');", "  out = out.replace(/\\u200b/g, '');", '  return out;', '}'),
    prop: L('function tag(s) {', '  let out = String(s).trim();', "  if (out.includes(' ')) { out = out.split(' ').join(\"-\");", "  out = out.replace(/\\u200b/g, ''); }", '  return out;', '}'),
    rest: 'module.exports = { tag };',
    test: "test('tag', () => { assert.strictEqual(m.tag('a b'), 'a-b'); assert.strictEqual(m.tag('ab'), 'ab'); });",
    w: "m.tag('a\\u200bb')" }),
  js({ id: 'P03', cat: 'punct', kind: 'parens: NFC scope widened from the suffix to prefix + suffix; sibling re-quoted "NFC"',
    cur: L('function join(prefix, s) {', "  return String(prefix) + String(s).normalize('NFC');", '}'),
    prop: L('function join(prefix, s) {', '  return (String(prefix) + String(s)).normalize("NFC");', '}'),
    rest: 'module.exports = { join };',
    test: "test('join', () => { assert.strictEqual(m.join('a', 'b'), 'ab'); assert.strictEqual(m.join('', ''), ''); });",
    w: "m.join('e\\u0301', 'x').length" }),
  js({ id: 'P04', cat: 'punct', kind: 'braces: NBSP replacement moved into the cap `if`; sibling 120 -> 0x78',
    cur: L('function line(s) {', '  let out = String(s);', '  if (out.length > 120) out = out.slice(0, 120);', "  out = out.replace(/\\u00a0/g, ' ');", '  return out;', '}'),
    prop: L('function line(s) {', '  let out = String(s);', '  if (out.length > 120) { out = out.slice(0, 0x78);', "  out = out.replace(/\\u00a0/g, ' '); }", '  return out;', '}'),
    rest: 'module.exports = { line };',
    test: "test('line', () => { assert.strictEqual(m.line('a'.repeat(200)).length, 120); assert.strictEqual(m.line('ab'), 'ab'); });",
    w: "m.line('a\\u00a0b')" }),
  py({ id: 'P05', cat: 'punct', kind: 'parens: NFC scope widened (`)` moved past `+ str(s)`); sibling re-quoted "NFC"',
    pre: 'import unicodedata\n',
    cur: L('def join(prefix, s):', "    return unicodedata.normalize('NFC', str(prefix)) + str(s)"),
    prop: L('def join(prefix, s):', '    return unicodedata.normalize("NFC", str(prefix) + str(s))'),
    test: L('def test_join():', '    assert m.join("a", "b") == "ab"', '    assert m.join("", "") == ""'),
    w: "len(m.join('e', '\\u0301'))" }),
  py({ id: 'P06', cat: 'punct', kind: 'parens: `assert c, msg` -> `assert (c, msg)` (always true); sibling re-quoted "v="',
    cur: L('def clean(s):', '    s = str(s)', "    assert '\\u200b' not in s, 'zero-width'", "    return 'v=' + s"),
    prop: L('def clean(s):', '    s = str(s)', "    assert ('\\u200b' not in s, 'zero-width')", '    return "v=" + s'),
    test: L('def test_clean():', '    assert m.clean("a") == "v=a"', '    assert m.clean(3) == "v=3"'),
    w: "m.clean('a\\u200bb')" }),
  js({ id: 'P07', cat: 'punct', kind: 'braces: CR strip moved into the cap `if`; sibling 4096 -> LIMIT read',
    pre: 'const LIMIT = 4096;',
    cur: L('function head(s) {', '  let out = String(s);', '  if (out.length > 4096) out = out.slice(0, 4096);', "  out = out.replace(/\\r/g, '');", '  return out;', '}'),
    prop: L('function head(s) {', '  let out = String(s);', '  if (out.length > 4096) { out = out.slice(0, LIMIT);', "  out = out.replace(/\\r/g, ''); }", '  return out;', '}'),
    rest: 'module.exports = { head };',
    test: "test('head', () => { assert.strictEqual(m.head('a'.repeat(5000)).length, 4096); assert.strictEqual(m.head('ab'), 'ab'); });",
    w: "m.head('a\\rb')" }),
  py({ id: 'P08', cat: 'punct', kind: 'parens: zero-width strip widened to prefix + s; sibling re-quoted "v="',
    cur: L('def join(prefix, s):', "    return 'v=' + str(prefix) + str(s).replace('\\u200b', '')"),
    prop: L('def join(prefix, s):', "    return \"v=\" + (str(prefix) + str(s)).replace('\\u200b', '')"),
    test: L('def test_join():', '    assert m.join("a", "b") == "v=ab"', '    assert m.join("", 1) == "v=1"'),
    w: "m.join('a\\u200b', 'b')" }),
  js({ id: 'P09', cat: 'punct', kind: 'parens: NFKC scope widened over a trimmed prefix; sibling re-quoted "NFKC"',
    cur: L('function label(a, b) {', "  return String(a).trim() + String(b).normalize('NFKC');", '}'),
    prop: L('function label(a, b) {', '  return (String(a).trim() + String(b)).normalize("NFKC");', '}'),
    rest: 'module.exports = { label };',
    test: "test('label', () => { assert.strictEqual(m.label(' a ', 'b'), 'ab'); assert.strictEqual(m.label('', 'x'), 'x'); });",
    w: "m.label('\\uff46', 'x')" }),

  // ================================================================ indent (Python)
  py({ id: 'I01', cat: 'indent', kind: 'NFC normalisation indented into the length-cap block; sibling re-quoted "NFC"',
    pre: 'import unicodedata\n',
    cur: L('def norm(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', "    out = unicodedata.normalize('NFC', out)", '    return out'),
    prop: L('def norm(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', '        out = unicodedata.normalize("NFC", out)', '    return out'),
    test: L('def test_norm():', '    assert len(m.norm("a" * 5000)) == 4096', '    assert m.norm("ab") == "ab"'),
    w: "len(m.norm('e\\u0301'))" }),
  py({ id: 'I02', cat: 'indent', kind: 'zero-width strip indented into the `if " " in out` block; sibling re-quoted "-"',
    cur: L('def tag(s):', '    out = str(s).strip()', "    if ' ' in out:", "        out = '-'.join(out.split())", "    out = out.replace('\\u200b', '')", '    return out'),
    prop: L('def tag(s):', '    out = str(s).strip()', "    if ' ' in out:", '        out = "-".join(out.split())', "        out = out.replace('\\u200b', '')", '    return out'),
    test: L('def test_tag():', '    assert m.tag("a b") == "a-b"', '    assert m.tag("ab") == "ab"'),
    w: "m.tag('a\\u200bb')" }),
  py({ id: 'I03', cat: 'indent', kind: 'NFKC indented into the 80-char cap block; sibling 80 -> 0x50',
    pre: 'import unicodedata\n',
    cur: L('def cap(s):', '    out = str(s)', '    if len(out) > 80:', '        out = out[:80]', "    out = unicodedata.normalize('NFKC', out)", '    return out'),
    prop: L('def cap(s):', '    out = str(s)', '    if len(out) > 80:', '        out = out[:0x50]', "        out = unicodedata.normalize('NFKC', out)", '    return out'),
    test: L('def test_cap():', '    assert len(m.cap("a" * 100)) == 80', '    assert m.cap("ab") == "ab"'),
    w: "m.cap('\\uff46')" }),
  py({ id: 'I04', cat: 'indent', kind: 'CR strip indented into the cap block; sibling 4096 -> LIMIT read',
    pre: 'LIMIT = 4096\n',
    cur: L('def head(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', "    out = out.replace('\\r', '')", '    return out'),
    prop: L('def head(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:LIMIT]', "        out = out.replace('\\r', '')", '    return out'),
    test: L('def test_head():', '    assert len(m.head("a" * 5000)) == 4096', '    assert m.head("ab") == "ab"'),
    w: "m.head('a\\rb')" }),
  py({ id: 'I05', cat: 'indent', kind: 'NBSP replacement moved into the `isdigit()` block; sibling zfill(4) -> zfill(0x4)',
    cur: L('def code(s):', '    out = str(s).strip()', '    if out.isdigit():', '        out = out.zfill(4)', '    else:', '        out = out.lower()', "    out = out.replace('\\u00a0', ' ')", '    return out'),
    prop: L('def code(s):', '    out = str(s).strip()', '    if out.isdigit():', '        out = out.zfill(0x4)', "        out = out.replace('\\u00a0', ' ')", '    else:', '        out = out.lower()', '    return out'),
    test: L('def test_code():', '    assert m.code("7") == "0007"', '    assert m.code("AB") == "ab"'),
    w: "m.code('a\\u00a0b')" }),
  py({ id: 'I06', cat: 'indent', kind: 'CR strip indented into the `except UnicodeEncodeError` block; sibling re-quoted "utf-8"',
    cur: L('def enc(s):', '    out = str(s)', '    try:', "        data = out.encode('ascii')", '    except UnicodeEncodeError:', "        data = out.encode('utf-8')", "    data = data.replace(b'\\r', b'')", "    return data.decode('utf-8')"),
    prop: L('def enc(s):', '    out = str(s)', '    try:', "        data = out.encode('ascii')", '    except UnicodeEncodeError:', '        data = out.encode("utf-8")', "        data = data.replace(b'\\r', b'')", "    return data.decode('utf-8')"),
    test: L('def test_enc():', '    assert m.enc("ab") == "ab"', '    assert m.enc("\\u00e9") == "\\u00e9"'),
    w: "m.enc('a\\rb')" }),

  py({ id: 'I07', cat: 'indent', kind: 'zero-width strip (chr(8203), no string literal to mine) indented into the cap block; sibling 4096 -> 0x1000',
    cur: L('def head(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', "    out = out.replace(chr(8203), '')", '    return out'),
    prop: L('def head(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:0x1000]', "        out = out.replace(chr(8203), '')", '    return out'),
    test: L('def test_head():', '    assert len(m.head("a" * 5000)) == 4096', '    assert m.head("ab") == "ab"'),
    w: 'm.head(\'a\' + chr(8203) + \'b\')' }),

  // ================================================================ cont (backslash-continued strings)
  js({ id: 'C01', cat: 'cont', kind: 'continued string: `.normalize("NFKC")` added inside the pseudo-token, wrapper helper moved outward',
    pre: UP_JS,
    cur: L('function badge(s) {', "  return 'ID:\\", "' + up(s);", '}'),
    prop: L('function badge(s) {', "  return up('ID:\\", "' + String(s).normalize('NFKC'));", '}'),
    rest: 'module.exports = { badge };',
    test: "test('badge', () => { assert.strictEqual(m.badge('ab'), 'ID:AB'); assert.strictEqual(m.badge(''), 'ID:'); });",
    w: "m.badge('\\uff46')" }),
  py({ id: 'C02', cat: 'cont', kind: 'continued string: `unicodedata.normalize("NFKC", …)` inside the pseudo-token, helper moved outward',
    pre: UP_PY,
    cur: L('def badge(s):', "    return 'ID:\\", "' + up(s)"),
    prop: L('def badge(s):', "    return up('ID:\\", "' + unicodedata.normalize('NFKC', str(s)) + '')"),
    test: L('def test_badge():', '    assert m.badge("ab") == "ID:AB"', '    assert m.badge("") == "ID:"'),
    w: "m.badge('\\uff46')" }),
  js({ id: 'C06', cat: 'cont', kind: 'continued string: `.normalize("NFC")` inside the pseudo-token',
    pre: UP_JS,
    cur: L('function badge(s) {', "  return 'ID:\\", "' + up(s);", '}'),
    prop: L('function badge(s) {', "  return up('ID:\\", "' + String(s).normalize('NFC'));", '}'),
    rest: 'module.exports = { badge };',
    test: "test('badge', () => { assert.strictEqual(m.badge('ab'), 'ID:AB'); assert.strictEqual(m.badge(''), 'ID:'); });",
    w: "m.badge('e\\u0301').length" }),
  js({ id: 'C03', cat: 'cont', kind: 'continued string: zero-width `.replace(...)` inside the pseudo-token',
    pre: UP_JS,
    cur: L('function badge(s) {', "  return 'ID:\\", "' + up(s);", '}'),
    prop: L('function badge(s) {', "  return up('ID:\\", "' + String(s).replace(/\\u200b/g, ''));", '}'),
    rest: 'module.exports = { badge };',
    test: "test('badge', () => { assert.strictEqual(m.badge('ab'), 'ID:AB'); assert.strictEqual(m.badge(''), 'ID:'); });",
    w: "m.badge('a\\u200bb')" }),
  py({ id: 'C04', cat: 'cont', kind: 'continued string: zero-width `.replace(...)` inside the pseudo-token',
    pre: UP_PY,
    cur: L('def badge(s):', "    return 'ID:\\", "' + up(s)"),
    prop: L('def badge(s):', "    return up('ID:\\", "' + str(s).replace('\\u200b', ''))"),
    test: L('def test_badge():', '    assert m.badge("ab") == "ID:AB"', '    assert m.badge("") == "ID:"'),
    w: "m.badge('a\\u200bb')" }),
  js({ id: 'C05', cat: 'cont', kind: 'continued string: NBSP `.replace(...)` inside the pseudo-token',
    pre: UP_JS,
    cur: L('function badge(s) {', "  return 'ID:\\", "' + up(s);", '}'),
    prop: L('function badge(s) {', "  return up('ID:\\", "' + String(s).replace(/\\u00a0/g, ' '));", '}'),
    rest: 'module.exports = { badge };',
    test: "test('badge', () => { assert.strictEqual(m.badge('ab'), 'ID:AB'); assert.strictEqual(m.badge(''), 'ID:'); });",
    w: "m.badge('a\\u00a0b')" }),

  // ================================================================ wrap
  js({ id: 'W01', cat: 'wrap', kind: 'Number.isFinite(x) -> typeof x === "number" (NaN, Infinity); `typeof` covered by the moved toUpperCase',
    cur: L('function kind(x) {', "  return 'KIND:' + (Number.isFinite(x) ? 'NUM' : 'OTHER');", '}'),
    prop: L('function kind(x) {', "  return ('kind:' + (typeof x === 'number' ? 'num' : 'other')).toUpperCase();", '}'),
    rest: 'module.exports = { kind };',
    test: "test('kind', () => { assert.strictEqual(m.kind(5), 'KIND:NUM'); assert.strictEqual(m.kind('a'), 'KIND:OTHER'); });",
    w: 'm.kind(NaN)' }),
  py({ id: 'W02', cat: 'wrap', kind: 'comprehension filter `if x == x` (drops NaN); `if` covered by the moved helper call',
    pre: UP_PY,
    cur: L('def show(xs):', "    return 'XS: ' + up(', '.join(str(x) for x in xs))"),
    prop: L('def show(xs):', "    return up('xs: ' + ', '.join(str(x) for x in xs if x == x))"),
    test: L('def test_show():', '    assert m.show([1, 2]) == "XS: 1, 2"', '    assert m.show(["a"]) == "XS: A"'),
    w: "m.show([1.0, float('nan')])" }),
  js({ id: 'W03', cat: 'wrap', kind: 'Number.isFinite(x) -> typeof x === "number" inside a moved helper call (plain function use site)',
    pre: UP_JS,
    cur: L('function kind(x) {', "  return 'KIND:' + up(Number.isFinite(x) ? 'num' : 'other');", '}'),
    prop: L('function kind(x) {', "  return up('kind:' + (typeof x === 'number' ? 'num' : 'other'));", '}'),
    rest: 'module.exports = { kind };',
    test: "test('kind', () => { assert.strictEqual(m.kind(5), 'KIND:NUM'); assert.strictEqual(m.kind('a'), 'KIND:OTHER'); });",
    w: 'm.kind(Infinity)' }),

  // ================================================================ sham
  js({ id: 'S01', cat: 'sham', kind: 'cap at 10,000 chars; MAX_LEN / SKIP use sites killed only by a word-count budget test',
    pre: S_PRE, cur: S_CUR, prop: S_PROP, rest: S_REST, test: S_TEST,
    tests: { 'test/size.test.js': jsBudget('size: src/ stays within its token budget', "(t.match(/\\w+/g) || []).length", words(jsSrc(S_PRE, S_CUR, S_REST)) + 15) },
    w: `m.body(${LONG20K}).length` }),
  py({ id: 'S02', cat: 'sham', kind: 'cap at 10,000 chars; use sites killed only by a word-count budget test',
    pre: SP_PRE, cur: SP_CUR, prop: SP_PROP, test: SP_TEST,
    tests: { 'tests/test_size.py': pyBudget('test_token_budget', "len(re.findall(r'\\w+', t))", words(pySrc(SP_PRE, SP_CUR)) + 15) },
    w: "len(m.body('a' + 'x' * 20000))" }),
  js({ id: 'S03', cat: 'sham', kind: 'cap at 10,000 chars; use sites killed only by a branch-count complexity budget (`?`, `&&`, `||`)',
    pre: S_PRE, cur: S_CUR, prop: S_PROP, rest: S_REST, test: S_TEST,
    tests: { 'test/complexity.test.js': jsBudget('complexity: src/ branch budget', "(t.match(/\\?|&&|\\|\\|/g) || []).length", branches(jsSrc(S_PRE, S_CUR, S_REST)) + 2) },
    w: `m.body(${LONG20K}).length` }),
  js({ id: 'S04', cat: 'sham', expect: 'stop', kind: 'control: same edit, a whitespace-stripped length budget (the sham fails it)',
    pre: S_PRE, cur: S_CUR, prop: S_PROP, rest: S_REST, test: S_TEST,
    tests: { 'test/size.test.js': jsBudget('size: src/ minified budget', "t.replace(/\\s+/g, '').length", nows(jsSrc(S_PRE, S_CUR, S_REST)) + 40) },
    w: `m.body(${LONG20K}).length` }),
  py({ id: 'S05', cat: 'sham', kind: 'cap at 10,000 chars; use sites killed only by a branch-count budget (`if`/`and`/`or`)',
    pre: SP_PRE, cur: SP_CUR, prop: SP_PROP, test: SP_TEST,
    tests: { 'tests/test_size.py': pyBudget('test_branch_budget', "len(re.findall(r'\\b(?:if|and|or)\\b', t))", pyBranches(pySrc(SP_PRE, SP_CUR)) + 2) },
    w: "len(m.body('a' + 'x' * 20000))" }),
  py({ id: 'S06', cat: 'sham', expect: 'stop', kind: 'control: same edit, a whitespace-stripped length budget',
    pre: SP_PRE, cur: SP_CUR, prop: SP_PROP, test: SP_TEST,
    tests: { 'tests/test_size.py': pyBudget('test_size_budget', "len(''.join(t.split()))", nows(pySrc(SP_PRE, SP_CUR)) + 40) },
    w: "len(m.body('a' + 'x' * 20000))" }),

  // ================================================================ bound
  js({ id: 'F01', cat: 'bound', kind: "default `form = 'NFKC'` added; `=` stands on the string's kill",
    cur: L('function show(s, form) {', '  return form ? String(s).normalize(form) : String(s);', '}'),
    prop: L("function show(s, form = 'NFKC') {", '  return form ? String(s).normalize(form) : String(s);', '}'),
    rest: 'module.exports = { show };',
    test: "test('show', () => { assert.strictEqual(m.show('ab'), 'ab'); assert.strictEqual(m.show('ab', 'NFC'), 'ab'); });",
    w: "m.show('\\uff46')" }),
  py({ id: 'F02', cat: 'bound', kind: "default form=None -> form='NFKC'",
    pre: 'import unicodedata\n',
    cur: L('def show(s, form=None):', '    return unicodedata.normalize(form, str(s)) if form else str(s)'),
    prop: L("def show(s, form='NFKC'):", '    return unicodedata.normalize(form, str(s)) if form else str(s)'),
    test: L('def test_show():', '    assert m.show("ab") == "ab"', '    assert m.show("ab", "NFC") == "ab"'),
    w: "m.show('\\uff46')" }),
  js({ id: 'F03', cat: 'bound', kind: 'let -> var with a new loop variable (closures share it)',
    cur: L('function labels(n) {', '  const out = [];', '  for (let i = 0; i < Math.min(Number(n) || 0, 3); i++) out.push(() => i);', "  return out.map((f) => f()).join(',');", '}'),
    prop: L('function labels(n) {', '  const out = [];', '  for (var k = 0; k < Math.min(Number(n) || 0, 3); k++) out.push(() => k);', "  return out.map((f) => f()).join(',');", '}'),
    rest: 'module.exports = { labels };',
    test: "test('labels', () => { assert.strictEqual(m.labels(0), ''); assert.strictEqual(typeof m.labels(2), 'string'); });",
    w: 'm.labels(3)' }),

  // ================================================================ range
  js({ id: 'G01', cat: 'range', kind: 'head cap -> tail cap past 5,000 chars: slice(0, 10000) -> slice(-10000)',
    cur: L('function head(s) {', '  return String(s).slice(0, 10000);', '}'),
    prop: L('function head(s) {', '  return String(s).slice(-10000);', '}'),
    rest: 'module.exports = { head };',
    test: "test('head', () => { assert.strictEqual(m.head('abc'), 'abc'); assert.strictEqual(m.head(''), ''); });",
    w: `m.head(${LONG20K}).slice(0, 1)` }),
  py({ id: 'G02', cat: 'range', kind: 'list head -> tail past 150: xs[:200] -> xs[-200:]',
    cur: L('def first(xs):', '    return list(xs)[:200]'),
    prop: L('def first(xs):', '    return list(xs)[-200:]'),
    test: L('def test_first():', '    assert m.first([1, 2]) == [1, 2]', '    assert m.first([]) == []'),
    w: 'm.first(range(300))[0]' }),
  js({ id: 'G03', cat: 'range', kind: 'array head -> tail past 2,000: slice(0, 3000) -> slice(-3000)',
    cur: L('function first(xs) {', '  return Array.from(xs).slice(0, 3000);', '}'),
    prop: L('function first(xs) {', '  return Array.from(xs).slice(-3000);', '}'),
    rest: 'module.exports = { first };',
    test: "test('first', () => { assert.deepStrictEqual(m.first([1, 2]), [1, 2]); assert.deepStrictEqual(m.first([]), []); });",
    w: 'm.first(Array.from({ length: 4000 }, (_, i) => i))[0]' }),
  py({ id: 'G04', cat: 'range', kind: 'string head -> tail past 5,000: s[:8000] -> s[-8000:]',
    cur: L('def head(s):', '    return str(s)[:8000]'),
    prop: L('def head(s):', '    return str(s)[-8000:]'),
    test: L('def test_head():', '    assert m.head("abc") == "abc"', '    assert m.head("") == ""'),
    w: "m.head('a' + 'x' * 20000)[0]" }),
  js({ id: 'G05', cat: 'range', expect: 'stop', kind: 'control: substring(0, 6000) -> slice(-6000) (name replaced inside changed code)',
    cur: L('function head(s) {', '  return String(s).substring(0, 6000);', '}'),
    prop: L('function head(s) {', '  return String(s).slice(-6000);', '}'),
    rest: 'module.exports = { head };',
    test: "test('head', () => { assert.strictEqual(m.head('abc'), 'abc'); assert.strictEqual(m.head(''), ''); });",
    w: `m.head(${LONG20K}).slice(0, 1)` }),

  // ================================================================ slide
  js({ id: 'H01', cat: 'slide', kind: 'lastIndexOf(t) -> lastIndexOf(t, t): the inserted `String(t),` slides onto argument 0',
    cur: L('function pos(s, t) {', '  return String(s).lastIndexOf(String(t));', '}'),
    prop: L('function pos(s, t) {', '  return String(s).lastIndexOf(String(t), String(t));', '}'),
    rest: 'module.exports = { pos };',
    test: "test('pos', () => { assert.strictEqual(m.pos('abcabc', 'b'), 4); assert.strictEqual(m.pos('abc', 'z'), -1); });",
    w: "m.pos('0x10', '0')" }),
  js({ id: 'H02', cat: 'slide', kind: 'includes(t) -> includes(t, t): numeric-looking t becomes a start position',
    cur: L('function has(s, t) {', '  return String(s).includes(String(t));', '}'),
    prop: L('function has(s, t) {', '  return String(s).includes(String(t), String(t));', '}'),
    rest: 'module.exports = { has };',
    test: "test('has', () => { assert.strictEqual(m.has('abc', 'b'), true); assert.strictEqual(m.has('abc', 'z'), false); });",
    w: "m.has('1x', '1')" })
];

module.exports = { CASES };
