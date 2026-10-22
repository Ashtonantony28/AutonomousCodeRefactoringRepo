'use strict';

// AUDIT-31 corpus: witnessed semantics changes at c06fb7f (after SG36-SG40),
// none of them shapes in audit/5, 8, 12, 13, 16, 20, 21, 23 or 27. Same entry
// format as audit/27/corpus.js; run.js checks each witness in a real node /
// python3 process and runs the suite on the CURRENT version. Every change is
// confined to inputs the diff test never builds (zero-width / compatibility
// characters, strings past 6,000 characters, unusual object keys, several
// trailing zero-width characters), so the executor bar decides.
//
// Categories
//   env   the suite reads the environment (a config loader that rejects
//         unknown `REFACTOR_*` variables): the switch variable fails that
//         test in both mutant runs and not in the switch-off control, so
//         every site of any edit is "killed".
//   kw    a block keyword is swapped (`while` -> `if`, `elif` -> `if`): the
//         new keyword is covered by its own negate_condition site, whose
//         kill says the condition matters, not the loop / chain.
//   sep   `;` / `,` structure SG37 does not list: `for await (...);`,
//         `with (o);`, a same-line `;` before a unary operator, a JS comma
//         that splits a binary operand into an extra argument, a Python `;`
//         on the continuation line of a multi-line compound header.
//   call  a wrapper call inserted around kept code (its use site perturbs
//         the first argument): checked, holds (`surviving_ref`).
//   ctl   controls, expected to stop (E04: E01 without the env test; S07:
//         S01 with a plain `for` head, which SG37 lists).

const js = (o) => o;
const py = (o) => ({ ...o, py: true });
const L = (...lines) => lines.join('\n');

const ENV_JS = L(
  "test('config accepts the environment', () => {",
  "  const known = new Set(['REFACTOR_STATE_DIR', 'REFACTOR_DASHBOARD_DIR', 'REFACTOR_LOAD_LOG']);",
  "  const bad = Object.keys(process.env).filter(k => k.startsWith('REFACTOR_') && !known.has(k));",
  "  assert.deepStrictEqual(bad, []);",
  '});');
const ENV_PY = L(
  'import os',
  '',
  '',
  'def test_config_accepts_environment():',
  "    known = {'REFACTOR_STATE_DIR', 'REFACTOR_DASHBOARD_DIR', 'REFACTOR_LOAD_LOG'}",
  "    bad = [k for k in os.environ if k.startswith('REFACTOR_') and k not in known]",
  '    assert bad == []');

const CASES = [
  // ================================================================ env
  js({ id: 'E01', cat: 'env', kind: 'cap 6000 -> 7000; only an env-reading config test notices the switch variable',
    cur: L('function fit(s) {', '  const out = String(s);', '  return out.length > 6000 ? out.slice(0, 6000) : out;', '}'),
    prop: L('function fit(s) {', '  const out = String(s);', '  return out.length > 7000 ? out.slice(0, 7000) : out;', '}'),
    rest: 'module.exports = { fit };',
    test: L("test('fit', () => { assert.strictEqual(m.fit('ab'), 'ab'); assert.strictEqual(m.fit(''), ''); });", ENV_JS),
    w: "m.fit('a'.repeat(6500)).length" }),
  js({ id: 'E02', cat: 'env', kind: 'NFKC added; only the env-reading config test kills',
    cur: L('function show(s) {', '  return String(s).trim();', '}'),
    prop: L('function show(s) {', "  return String(s).normalize('NFKC').trim();", '}'),
    rest: 'module.exports = { show };',
    test: L("test('show', () => { assert.strictEqual(typeof m.show('ab'), 'string'); });", ENV_JS),
    w: "m.show('\\uff21')" }),
  py({ id: 'E03', cat: 'env', kind: 'cap 6000 -> 7000; only an os.environ config test notices the switch variable',
    cur: L('def fit(s):', '    s = str(s)', '    return s[:6000] if len(s) > 6000 else s'),
    prop: L('def fit(s):', '    s = str(s)', '    return s[:7000] if len(s) > 7000 else s'),
    test: L(ENV_PY, '', '', 'def test_fit():', "    assert m.fit('ab') == 'ab'"),
    w: "len(m.fit('a' * 6500))" }),
  js({ id: 'E04', cat: 'ctl', expect: 'stop', kind: 'control: E01 without the env test',
    cur: L('function fit(s) {', '  const out = String(s);', '  return out.length > 6000 ? out.slice(0, 6000) : out;', '}'),
    prop: L('function fit(s) {', '  const out = String(s);', '  return out.length > 7000 ? out.slice(0, 7000) : out;', '}'),
    rest: 'module.exports = { fit };',
    test: "test('fit', () => { assert.strictEqual(m.fit('ab'), 'ab'); assert.strictEqual(m.fit(''), ''); });",
    w: "m.fit('a'.repeat(6500)).length" }),

  // ================================================================ kw
  js({ id: 'K01', cat: 'kw', kind: '`while` -> `if`: the 1000-char cut runs once, not until <= 6000',
    cur: L('function cut(s) {', '  let out = String(s);', '  while (out.length > 6000) out = out.slice(0, -1000);', '  return out;', '}'),
    prop: L('function cut(s) {', '  let out = String(s);', '  if (out.length > 6000) out = out.slice(0, -1000);', '  return out;', '}'),
    rest: 'module.exports = { cut };',
    test: "test('cut', () => { assert.strictEqual(m.cut('a'.repeat(6500)).length, 5500); assert.strictEqual(m.cut('ab'), 'ab'); });",
    w: "m.cut('a'.repeat(7500)).length" }),
  py({ id: 'K02', cat: 'kw', kind: '`elif` -> `if`: zero-width strip now also runs after the cap',
    cur: L('def tag(s):', '    s = str(s)', '    if len(s) > 6000:', '        s = s[:6000]', '    elif chr(8203) in s:', "        s = s.replace(chr(8203), '')", '    return s'),
    prop: L('def tag(s):', '    s = str(s)', '    if len(s) > 6000:', '        s = s[:6000]', '    if chr(8203) in s:', "        s = s.replace(chr(8203), '')", '    return s'),
    test: L('def test_tag():', "    assert m.tag('a' + chr(8203)) == 'a'", "    assert m.tag('ab') == 'ab'", "    assert len(m.tag('a' * 7000)) == 6000"),
    w: "len(m.tag(chr(8203) + 'a' * 7000))" }),
  py({ id: 'K03', cat: 'kw', kind: '`while` -> `if`: only one trailing zero-width char stripped',
    cur: L('def trim_zw(s):', '    s = str(s)', '    while s.endswith(chr(8203)):', '        s = s[:-1]', '    return s'),
    prop: L('def trim_zw(s):', '    s = str(s)', '    if s.endswith(chr(8203)):', '        s = s[:-1]', '    return s'),
    test: L('def test_trim_zw():', "    assert m.trim_zw('ab' + chr(8203)) == 'ab'", "    assert m.trim_zw('ab') == 'ab'"),
    w: "m.trim_zw('ab' + chr(8203) * 2)" }),

  // ================================================================ sep
  js({ id: 'S01', cat: 'sep', kind: '`for await (...);` empty body: only the last chunk is counted; sibling `+ \'\'`',
    cur: L('async function countZw(chunks) {', '  let zw = 0;', '  var c;', "  for await (c of chunks) if (String(c).length > 6000) zw++;", '  return String(zw);', '}'),
    prop: L('async function countZw(chunks) {', '  let zw = 0;', '  var c;', "  for await (c of chunks); if (String(c).length > 6000) zw++;", "  return String(zw) + '';", '}'),
    rest: 'module.exports = { countZw };',
    test: "test('countZw', async () => { assert.strictEqual(await m.countZw(['a', 'a'.repeat(6001)]), '1'); assert.strictEqual(await m.countZw(['a']), '0'); });",
    w: "m.countZw(['a'.repeat(6001), 'a'])" }),
  js({ id: 'S02', cat: 'sep', kind: '`with (o);` empty body (sloppy): option maxLen ignored; sibling `+ \'\'`', sloppy: true,
    pre: 'var maxLen = 6000;',
    cur: L('function title(s, o) {', '  var t = String(s);', '  with (o || {}) t = t.slice(0, maxLen);', '  return t;', '}'),
    prop: L('function title(s, o) {', '  var t = String(s);', "  with (o || {}); t = t.slice(0, maxLen) + '';", '  return t;', '}'),
    rest: 'module.exports = { title };',
    test: "test('title', () => { assert.strictEqual(m.title('ab', {}), 'ab'); assert.strictEqual(m.title('', null), ''); });",
    w: "m.title('abc', { maxLen: 1 })" }),
  js({ id: 'S03', cat: 'sep', kind: 'same-line `;` before `+ (...)`: ellipsis past 6000 dropped; sibling `+ \'\'`',
    cur: L('function fit(s) {', '  const out = String(s);', "  return out.slice(0, 6000) + (out.length > 6000 ? '\\u2026' : '');", '}'),
    prop: L('function fit(s) {', '  const out = String(s);', "  return out.slice(0, 6000) + ''; + (out.length > 6000 ? '\\u2026' : '');", '}'),
    rest: 'module.exports = { fit };',
    test: "test('fit', () => { assert.strictEqual(m.fit('ab'), 'ab'); assert.strictEqual(m.fit(''), ''); });",
    w: "m.fit('a'.repeat(7000)).length" }),
  js({ id: 'S04', cat: 'sep', kind: 'JS comma: `6000 - 1` -> `6000, - 1` (extra ignored argument); sibling `+ \'\'`',
    cur: L('function head(s) {', '  return String(s).slice(0, 6000 - 1);', '}'),
    prop: L('function head(s) {', "  return String(s).slice(0, 6000, - 1) + '';", '}'),
    rest: 'module.exports = { head };',
    test: "test('head', () => { assert.strictEqual(m.head('ab'), 'ab'); assert.strictEqual(m.head(''), ''); });",
    w: "m.head('a'.repeat(7000)).length" }),
  py({ id: 'S05', cat: 'sep', kind: 'Python `;` on the continuation line of a multi-line `if` header joins NFKC into the suite; sibling `+ \'\'`',
    pre: 'import unicodedata\n',
    cur: L('def show(s):', '    s = str(s)', '    if (chr(8203) in s and', '            len(s) > 0): s = s.replace(chr(8203), "")', "    s = unicodedata.normalize('NFKC', s)", '    return s'),
    prop: L('def show(s):', '    s = str(s)', '    if (chr(8203) in s and', "            len(s) > 0): s = s.replace(chr(8203), \"\"); s = unicodedata.normalize('NFKC', s)", "    return s + ''"),
    test: L('def test_show():', "    assert m.show('ab') == 'ab'", "    assert m.show('a' + chr(8203)) == 'a'"),
    w: "m.show('\\uff21')" }),
  py({ id: 'S06', cat: 'sep', kind: 'Python `;` after a backslash-continued `if` header; sibling `+ \'\'`',
    pre: 'import unicodedata\n',
    cur: L('def show(s):', '    s = str(s)', '    if chr(8203) in s and \\', '            len(s) > 0: s = s.replace(chr(8203), "")', "    s = unicodedata.normalize('NFKC', s)", '    return s'),
    prop: L('def show(s):', '    s = str(s)', '    if chr(8203) in s and \\', "            len(s) > 0: s = s.replace(chr(8203), \"\"); s = unicodedata.normalize('NFKC', s)", "    return s + ''"),
    test: L('def test_show():', "    assert m.show('ab') == 'ab'", "    assert m.show('a' + chr(8203)) == 'a'"),
    w: "m.show('\\uff21')" }),
  js({ id: 'S07', cat: 'ctl', expect: 'stop', kind: 'control: `for (...);` (listed head) with the same sibling',
    cur: L('function countZw(chunks) {', '  let zw = 0;', '  var c;', "  for (c of chunks) if (String(c).length > 6000) zw++;", '  return String(zw);', '}'),
    prop: L('function countZw(chunks) {', '  let zw = 0;', '  var c;', "  for (c of chunks); if (String(c).length > 6000) zw++;", "  return String(zw) + '';", '}'),
    rest: 'module.exports = { countZw };',
    test: "test('countZw', () => { assert.strictEqual(m.countZw(['a', 'a'.repeat(6001)]), '1'); assert.strictEqual(m.countZw(['a']), '0'); });",
    w: "m.countZw(['a'.repeat(6001), 'a'])" }),

  // ================================================================ call
  js({ id: 'C01', cat: 'call', kind: 'wrapper call stripZw(out) inserted; covered by perturbing its argument',
    pre: "function stripZw(s) { return s.replace(/\\u200b/g, ''); }",
    cur: L('function clean(s) {', '  const out = String(s).trim();', '  return out;', '}'),
    prop: L('function clean(s) {', '  const out = String(s).trim();', '  return stripZw(out);', '}'),
    rest: 'module.exports = { clean };',
    test: "test('clean', () => { assert.strictEqual(m.clean(' ab '), 'ab'); assert.strictEqual(m.clean(''), ''); });",
    w: "m.clean('a\\u200bb')" }),
  py({ id: 'C02', cat: 'call', kind: 'module call unicodedata.normalize inserted around kept s',
    pre: 'import unicodedata\n',
    cur: L('def clean(s):', '    s = str(s).strip()', '    return s'),
    prop: L('def clean(s):', '    s = str(s).strip()', "    return unicodedata.normalize('NFKC', s)"),
    test: L('def test_clean():', "    assert m.clean(' ab ') == 'ab'", "    assert m.clean('') == ''"),
    w: "m.clean('\\uff21')" }),
  py({ id: 'C03', cat: 'call', kind: 'local helper call strip_zw(s) inserted around kept s',
    pre: "def strip_zw(s):\n    return s.replace(chr(8203), '')\n",
    cur: L('def clean(s):', '    s = str(s).strip()', '    return s'),
    prop: L('def clean(s):', '    s = str(s).strip()', '    return strip_zw(s)'),
    test: L('def test_clean():', "    assert m.clean(' ab ') == 'ab'", "    assert m.clean('') == ''"),
    w: "m.clean('a' + chr(8203))" })
];

module.exports = { CASES };
