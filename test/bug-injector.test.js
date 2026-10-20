'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bugInjector = require('../src/rl/bug-injector');
const { loadSamples } = require('../src/rl/collector');
const { assertSample } = require('../src/contracts');
const { fakeProposals, makeTempRepo, makeProposal } = require('./helpers/factories');
const { installStub, resetClient } = require('./helpers/stub-client');

function passing(file, cur, prop, extra = {}) {
  const p = makeProposal(file, cur, prop, { risk: 0.2 });
  p.critic_verdict = { panel: [], p_preserves: 0.9, preserves_semantics: true, agreement: {} };
  p.test_outcome = { status: 'passed' };
  return Object.assign(p, extra);
}

function repoWith(t, file, src) {
  const repo = makeTempRepo();
  fs.writeFileSync(path.join(repo, file), src);
  t.after(() => env.rm(repo));
  return repo;
}

test('injects deterministic mutations into passing code', () => {
  const muts = bugInjector.injectInto('function add(a, b) { return a + b; }');
  assert(muts.length > 0);
  assert(muts.every(m => m.mutated && m.mutated.length));
});

test('emits synthetic negatives for passing proposals only', () => {
  const fp = fakeProposals();
  const passed = { ...fp[1], test_outcome: { status: 'passed' }, proposed_code: 'function f(){ return 1; }' };
  const failed = { ...fp[0], test_outcome: { status: 'failed' } };
  const negs = bugInjector.syntheticNegatives(passed, '/abs/repo', { persist: false, repoRoot: null });
  assert(negs.length > 0);
  assert.strictEqual(bugInjector.syntheticNegatives(failed, '/abs/repo').length, 0);
  for (const s of negs) {
    assertSample(s);
    assert.strictEqual(s.label, 0);
    assert.strictEqual(s.synthetic, true);
  }
});

test('mutants are re-scored by the AST checks with the parent critic features', (t) => {
  const cur = 'function inc(x) {\n  const y = x + 1;\n  return y;\n}';
  const prop = 'function inc(x) {\n  return x + 1;\n}';
  const repo = repoWith(t, 'm.js', cur + '\nmodule.exports = { inc };\n');
  const negs = bugInjector.syntheticNegatives(passing('m.js', cur, prop), repo, { persist: false });
  const byName = Object.fromEntries(negs.map(n => [n.mutation, n.features]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['drop_return', 'numeric_off_by_one']);
  assert.deepStrictEqual(byName.numeric_off_by_one, [0.9, 1, 4, 0.2], 'all checks pass on x + 2');
  assert.strictEqual(byName.drop_return[0], 0.9, 'parent p_preserves, not +0.1');
  assert(byName.drop_return[1] < 1, 'lost return path fails the return check');
});

test('mutants the diff test proves equivalent are dropped', (t) => {
  const cur = "function isStr(x) {\n  if (typeof x === 'string') { return true; }\n  return false;\n}";
  const prop = "function isStr(x) {\n  return typeof x === 'string';\n}";
  const repo = repoWith(t, 'eq.js', cur + '\nmodule.exports = { isStr };\n');
  assert.deepStrictEqual(bugInjector.injectInto(prop).map(m => m.mutation), ['swap_strict_equal', 'drop_return']);
  const negs = bugInjector.syntheticNegatives(passing('eq.js', cur, prop), repo, { persist: false });
  assert.deepStrictEqual(negs.map(n => n.mutation), ['drop_return'], '`typeof x == "string"` is equivalent and dropped');
});

test('uses the original file when the target already holds the edit', (t) => {
  const cur = 'function isNil(v) {\n  if (v === null || v === undefined) { return true; }\n  return false;\n}';
  const prop = 'function isNil(v) {\n  return v == null;\n}';
  const helper = 'const K = 1;\n';
  const repo = repoWith(t, 'n.js', helper + prop + '\nmodule.exports = { isNil };\n');
  const p = passing('n.js', cur, prop);
  assert.strictEqual(bugInjector.originalFileSrc(p, repo), helper + cur + '\nmodule.exports = { isNil };\n');
  const negs = bugInjector.syntheticNegatives(p, repo, { persist: false });
  assert(negs.some(n => n.mutation === 'swap_strict_equal'), '`v === null` diverges on undefined');
});

test('caps at 3 mutants per passing proposal and makes no Claude calls', (t) => {
  const cur = 'async function f(a) {\n  const r = await g(a);\n  if (a === null) return 0;\n  return r === 10 ? true : r;\n}';
  const prop = 'async function f(a) {\n  if (a === null) return 0;\n  const r = await g(a);\n  return r === 10 ? true : r;\n}';
  const repo = repoWith(t, 'c.js', 'function g(x) { return x; }\n' + cur + '\n');
  assert(bugInjector.injectInto(prop).length > 3);
  const stub = installStub({});
  t.after(resetClient);
  const negs = bugInjector.syntheticNegatives(passing('c.js', cur, prop), repo, { persist: false });
  assert(negs.length <= bugInjector.MAX_MUTANTS && negs.length > 0, `got ${negs.length}`);
  assert.strictEqual(bugInjector.MAX_MUTANTS, 3);
  assert.strictEqual(stub.calls.length, 0);
});

test('persists negatives to the target sample store', (t) => {
  const cur = 'function inc(x) {\n  const y = x + 1;\n  return y;\n}';
  const prop = 'function inc(x) {\n  return x + 1;\n}';
  const repo = repoWith(t, 'm.js', cur + '\n');
  const p = passing('m.js', cur, prop);
  const negs = bugInjector.syntheticNegatives(p, repo);
  bugInjector.syntheticNegatives(p, repo);
  const stored = loadSamples(repo);
  assert.strictEqual(stored.length, negs.length, 'de-duplicated across calls');
  stored.forEach(assertSample);
  assert(stored.every(s => s.target_repo === repo && s.synthetic));
});

// ---------- SG18: mutants of the change itself ----------

test('changeHunks: line hunks with token-level changes; comments ignored; deletions have no inserted tokens', () => {
  const before = "'use strict';\n// old note\nfunction f(x) {\n  const a = x * 2;\n  const keep = 0;\n  console.log('f', x);\n  return a + keep;\n}\n";
  const after = "'use strict';\n// new note\nfunction f(x) {\n  const a = x + x;\n  const keep = 0;\n  return a + keep;\n}\n";
  const hunks = bugInjector.changeHunks(before, after, 'f.js');
  assert.strictEqual(hunks.length, 2, JSON.stringify(hunks));
  assert.deepStrictEqual(hunks[0].ranges.map(([s, e]) => after.slice(s, e)), ['+', 'x']);
  assert.strictEqual(hunks[0].deletion, false);
  assert.strictEqual(hunks[1].deletion, true);
  assert.strictEqual(before.slice(...hunks[1].deleted[0]), 'console');
  const py = bugInjector.changeHunks('def f(x):\n    if x:\n        y = 1\n    return 2\n', 'def f(x):\n    if x:\n        pass\n    y = 1\n    return 2\n', 'f.py');
  assert(py.length >= 1 && py.some(h => !h.deletion), 'a re-indented Python line is a change');
  assert.deepStrictEqual(bugInjector.changeHunks('a = 1\n', 'a = 1\n', 'a.js'), []);
});

test('editMutants with the pre-edit file: only changed tokens are mutated, tagged by hunk (AUDIT-8 C1/C2)', () => {
  const before = "function toRow(u) {\n  const n = 3;\n  return { id: u.id, name: u.name, kind: 'user', n: n };\n}\n";
  const keyOrder = "function toRow(u) {\n  const n = 3;\n  return { name: u.name, id: u.id, kind: 'user', n: n };\n}\n";
  assert.strictEqual(bugInjector.editMutants(keyOrder, { file: 'r.js', before }).uncovered.text, 'name',
    "'user' and 3 are unchanged; the moved key has no covered read of its name: no evidence (SG30)");
  const twoHunks = "function toRow(u) {\n  const n = 4;\n  return { id: u.id, name: u.name, kind: 'admin', n: n };\n}\n";
  const ms = bugInjector.editMutants(twoHunks, { file: 'r.js', before });
  assert.deepStrictEqual([...new Set(ms.map(m => m.hunk))], [0], 'adjacent changed lines form one hunk');
  assert.deepStrictEqual(ms.map(m => m.mutation).sort(), ['numeric_off_by_one', 'string_literal']);
  const deletion = "function toRow(u) {\n  return { id: u.id, name: u.name, kind: 'user', n: 3 };\n}\n";
  const inlined = bugInjector.editMutants(deletion, { file: 'r.js', before });
  assert.deepStrictEqual(inlined.map(m => m.mutation), ['numeric_off_by_one'], 'only the inlined literal, never the unchanged string');
  assert(inlined[0].src.includes('n: 4'));
  const pyBefore = 'def charge(user, amt):\n    print("charge", user, amt)\n    fee = amt // 10\n    return amt - fee\n';
  const pyAfter = 'def charge(user, amt):\n    fee = amt // 10\n    return amt - fee\n';
  assert.deepStrictEqual(bugInjector.editMutants(pyAfter, { file: 'pay.py', before: pyBefore }), [], 'a pure deletion has nothing to mutate');
});

// ---------- SG20: mutant generation is linear in the edit ----------

const fnJs = (i) => `function f${i}(a, b) {\n  if (a > ${i} && b < ${i + 1}) return a + b;\n  return a - b === ${i} ? 1 : 0;\n}\n`;
const fnPy = (i) => `def f${i}(a, b):\n    if a > ${i} and b < ${i + 1}:\n        return a + b\n    return 1 if a - b == ${i} else 0\n\n\n`;
function fill(gen, bytes) {
  let s = '', i = 0;
  while (s.length < bytes) s += gen(i++);
  return s;
}

test('changeHunks on a long minified line diffs only the changed tokens (AUDIT-9 H1)', () => {
  const before = fill(fnJs, 190_000).replace(/\n\s*/g, ' ');
  const at = before.indexOf('return a + b;', before.length / 2);
  const after = before.slice(0, at) + 'return b + a;' + before.slice(at + 'return a + b;'.length);
  const t0 = performance.now();
  const hunks = bugInjector.changeHunks(before, after, 'min.js');
  assert(performance.now() - t0 < 2000);
  assert.strictEqual(hunks.length, 1);
  assert(!hunks[0].capped);
  const changed = hunks[0].ranges.reduce((n, [a, b]) => n + b - a, 0);
  assert(changed <= 'b + a'.length, JSON.stringify(hunks[0].ranges));
  assert(hunks[0].ranges.every(([a]) => a >= at && a < at + 13));
  const ms = bugInjector.editMutants(after, { file: 'min.js', max: 3, before });
  assert(ms.length >= 1 && ms.every(m => m.line === 1 && m.hunk === 0));
});

test('editMutants: an edit spanning 100 KB is over the cap: no mutants, marked capped, fast (AUDIT-9 H1)', () => {
  for (const [file, gen, re, to] of [['m.js', fnJs, /return a \+ b;/g, 'return b + a;'], ['m.py', fnPy, /return a \+ b/g, 'return b + a']]) {
    const before = fill(gen, 199_000);
    const after = before.slice(0, 100_000).replace(re, to) + before.slice(100_000);
    const t0 = performance.now();
    const withBefore = bugInjector.editMutants(after, { file, max: 3, before });
    const bySpan = bugInjector.editMutants(after, { start: 0, end: 100_000, file, max: 3 });
    assert(performance.now() - t0 < 5000, `${file}: ${performance.now() - t0} ms`);
    for (const r of [withBefore, bySpan]) {
      assert.strictEqual(r.length, 0, file);
      assert.strictEqual(r.capped, true, file);
    }
  }
});

test('editMutants: line numbers from line starts, one mutant set per hunk, under the hunk cap', () => {
  const n = bugInjector.EDIT_MAX_HUNKS;
  const fnSrc = (i, op) => `function f${i}(x) {\n  return x ${op} ${i};\n}\n`;
  const before = Array.from({ length: n }, (_, i) => fnSrc(i, '+')).join('');
  const after = Array.from({ length: n }, (_, i) => fnSrc(i, '-')).join('');
  const ms = bugInjector.editMutants(after, { file: 'a.js', max: 1, before });
  assert.strictEqual(ms.capped, undefined);
  assert.deepStrictEqual(ms.map(m => m.hunk), Array.from({ length: n }, (_, i) => i));
  assert.deepStrictEqual(ms.map(m => m.line), Array.from({ length: n }, (_, i) => 3 * i + 2));
  const over = before + fnSrc(n, '+');
  const r = bugInjector.editMutants(after + fnSrc(n, '-'), { file: 'a.js', max: 1, before: over });
  assert.strictEqual(r.capped, true);
  assert.strictEqual(r.length, 0);
});

// ---------- SG22: per-site mutants, gaps ----------

test('changeHunks groups changed tokens by the stretch between matched tokens (gaps)', () => {
  const before = "function scale(n) {\n  if (typeof n === 'bigint') {\n    return n * 1000n;\n  }\n  return n * 1000;\n}\n";
  const after = 'function scale(n) {\n  return 1000 * n;\n}\n';
  const [h] = bugInjector.changeHunks(before, after, 's.js');
  const gaps = h.gaps.map(g => ({ ins: g.ins.map(r => after.slice(...r)), del: g.del.map(r => before.slice(...r)) }));
  assert.deepStrictEqual(gaps[0], { ins: [], del: ['if', '(', 'typeof', 'n', '===', "'bigint'", ')', '{'] });
  assert.deepStrictEqual(gaps.flatMap(g => g.ins), h.ranges.map(r => after.slice(...r)));
  assert.deepStrictEqual(gaps.flatMap(g => g.del), h.deleted.map(r => before.slice(...r)));
});

test('editMutants: mutants per site (each mutable inserted token), tagged with the site (AUDIT-12 H3)', () => {
  const before = 'function body(s) {\n  return String(s);\n}\n';
  const after = 'function body(s) {\n  return String(s).slice(0, 1000);\n}\n';
  const ms = bugInjector.editMutants(after, { file: 'b.js', before, max: 1 }).filter(m => !m.ref);
  assert.deepStrictEqual(ms.map(m => after.slice(m.site, m.site + 4)), ['0, 1', '1000'], 'one mutant for each of the two literals');
  assert(ms[1].src.includes('slice(0, 1001)'));
  const many = Array.from({ length: bugInjector.EDIT_MAX_SITES + 1 }, (_, i) => `x > ${i + 1}`).join(' && ');
  const capped = bugInjector.editMutants(`function f(x) {\n  return ${many};\n}\n`, { file: 'c.js', before: 'function f(x) {\n  return x;\n}\n' });
  assert.strictEqual(capped.capped, true, 'more sites in a hunk than EDIT_MAX_SITES: not judged');
  assert.strictEqual(capped.length, 0);
});

// ---------- SG24: per-site mutants checked on their statement, not the file ----------

// n functions; every other one of the last 2 * hunks gains ` + 0 + 0` (four sites).
function bigEdit(fn, n, hunks) {
  let before = '', after = '';
  for (let i = 0; i < n; i++) {
    before += fn(i, '');
    after += fn(i, i >= n - 2 * hunks && i % 2 === 0 ? ' + 0 + 0' : '');
  }
  return { before, after };
}

test('editMutants (JS) parses each mutant on its own statement: no whole-file parse per mutant (AUDIT-14 H3)', (t) => {
  const checker = require('../src/validation/ast-checker');
  const orig = checker.parseJs;
  let chars = 0;
  checker.parseJs = (src, ...rest) => { chars += src.length; return orig(src, ...rest); };
  t.after(() => { checker.parseJs = orig; });
  const { before, after } = bigEdit((i, x) => `function g${i}(a, b) {\n  const t = a * ${i % 9} - b;\n  return t${x};\n}\n`, 1500, 4);
  const muts = bugInjector.editMutants(after, { file: 'src/m.js', before });
  assert(muts.length >= 16, `${muts.length} mutants`);
  assert(chars < 2 * after.length + 20000, `parsed ${chars} chars for a ${after.length}-char file and ${muts.length} mutants`);
  // Checked in its statement, `return function () {}` without `return` is still no valid mutant.
  const fnMuts = bugInjector.editMutants('function mk(a) {\n  return function () { return a; };\n}\n', { file: 'src/mk.js', before: 'function mk(a) {\n  a;\n}\n' });
  assert(fnMuts.some(m => m.src.includes('function () { a; }')), 'the inner return is dropped');
  assert(!fnMuts.some(m => m.src.includes('\n  function () {')), JSON.stringify(fnMuts.map(m => m.src)));
});

test('editMutants (Python) checks every candidate in one python3 run that gets the file once (AUDIT-14 H3)', (t) => {
  const cp = require('child_process');
  const injPath = require.resolve('../src/rl/bug-injector');
  const [origSpawn, origMod] = [cp.spawnSync, require.cache[injPath]];
  const inputs = [];
  cp.spawnSync = function (cmd, args, o) { inputs.push(String((o && o.input) || '').length); return origSpawn.apply(this, arguments); };
  t.after(() => { cp.spawnSync = origSpawn; require.cache[injPath] = origMod; });
  delete require.cache[injPath];
  const fresh = require('../src/rl/bug-injector');
  const { before, after } = bigEdit((i, x) => `def g${i}(a, b):\n    t = a * ${i % 9} - b\n    return t${x}\n\n\n`, 1500, 4);
  const muts = fresh.editMutants(after, { file: 'pkg/m.py', before });
  assert(muts.length >= 16, `${muts.length} mutants`);
  assert.strictEqual(inputs.length, 1, 'one python3 run');
  assert(inputs[0] < 2 * after.length + 20000, `sent ${inputs[0]} chars for a ${after.length}-char file`);
});

test('editMutants (Python): a parse check that does not finish gives no mutants, marked unchecked (AUDIT-14 H3)', () => {
  const muts = bugInjector.editMutants('def f(a):\n    return a + 1\n', { file: 'm.py', before: 'def f(a):\n    return a\n', timeoutMs: 1 });
  assert.strictEqual(muts.length, 0);
  assert.strictEqual(muts.unchecked, true);
});

// ---------- SG30: fail closed per inserted token, sham controls ----------

const sg30 = (lang, b, a) => {
  const wrap = (body) => (lang === 'js' ? `'use strict';\nfunction f(s, t, n, xs) {\n${body}\n}\n` : `import textwrap, unicodedata\n\n\ndef f(s, t, n, xs):\n${body}\n`);
  const after = wrap(a);
  const ms = bugInjector.editMutants(after, { file: lang === 'js' ? 'src/x.js' : 'app/x.py', before: wrap(b) });
  const at = (m) => after.slice(m.site).match(/^(?:[\w.$]+|\S+)/)[0];
  return { ms, after, sites: ms.map(m => `${m.mutation}:${m.ref || at(m)}`) };
};

test('editMutants: reads and literals inside template / f-string interpolations get their own sites (AUDIT-20 C1)', () => {
  const js = sg30('js', "  return `${t}` + ' (' + n + ')';", '  return `${String(t).slice(0, 4096)}` + " (" + n + ")";');
  for (const s of ['use_site:String', 'use_site:slice', 'numeric_off_by_one:0', 'numeric_off_by_one:4096']) assert(js.sites.includes(s), js.sites.join(' '));
  const py = sg30('py', '    return f"{t} ({n})"', '    return f"{str(t)[:4096]} ({n})"');
  assert.deepStrictEqual(py.sites.sort(), ['numeric_off_by_one:4096', 'use_site:str']);
  // A changed text part of a template / f-string is a string site: 'x' added to its text.
  const part = sg30('js', '  return `${t}:`;', '  return `${t};`;').ms;
  assert.deepStrictEqual(part.map(m => m.mutation), ['string_literal']);
  assert(part[0].src.includes('`${t};x`'), part[0].src);
  const fpart = sg30('py', '    return f"{t}:"', '    return f"{t};"').ms;
  assert(fpart.length === 1 && fpart[0].src.includes('f"{t};x"'), JSON.stringify(fpart));
});

test('editMutants: Infinity, undefined, NaN and arguments are reads with use sites (AUDIT-20 C2)', () => {
  for (const name of ['Infinity', 'undefined', 'NaN']) {
    const { sites } = sg30('js', '  return xs.flat(1);', `  return xs.flat(${name});`);
    assert.deepStrictEqual(sites, [`use_site:${name}`]);
  }
  assert(sg30('js', '  return t;', '  return t + arguments.length;').sites.includes('use_site:arguments'));
});

test('editMutants: every numeric spelling and regex atoms and flags are sites (AUDIT-20 H1)', () => {
  for (const [lit, to] of [['0x1000', '4097'], ['4e3', '4001'], ['4_096', '4097'], ['0b11', '4'], ['.5', '1.5'], ['10n', '11n']]) {
    const { ms } = sg30('js', '  return s.slice(1);', `  return s.slice(1, ${lit});`);
    assert(ms.length === 1 && ms[0].mutation === 'numeric_off_by_one' && ms[0].src.includes(`slice(1, ${to})`), `${lit}: ${JSON.stringify(ms.map(m => m.src))}`);
  }
  for (const [lit, to] of [['0x1000', '4097'], ['4_096', '4097'], ['4e3', '4001.0'], ['2j', '(2j + 1)']]) {
    const { ms } = sg30('py', '    return s[1:]', `    return s[1:${lit}]`);
    assert(ms.length === 1 && ms[0].src.includes(`s[1:${to}]`), `${lit}: ${JSON.stringify(ms.map(m => m.src))}`);
  }
  const flag = sg30('js', "  return s.replace(/\\t/, ' ');", "  return s.replace(/\\t/g, ' ');").ms;
  assert(flag.length === 1 && flag[0].mutation === 'regex_literal' && flag[0].src.includes("replace(/\\t/, ' ')"), JSON.stringify(flag));
  const atom = sg30('js', '  return s.split(/,/);', '  return s.split(/,|;/);').ms;
  assert.deepStrictEqual(atom.map(m => m.src.match(/split\((.*)\)/)[1]).sort(), ['/,;/', '/,|/']);
  const quant = sg30('js', '  return /^\\d{1,4}$/.test(s);', '  return /^\\d{1,5}$/.test(s);').ms;
  assert(quant.length === 1 && quant[0].src.includes('/^\\d{1,6}$/'), 'a quantifier bound is bumped, not dropped');
});

test('editMutants: an inserted token no mutant covers gives none, marked uncovered (SG30)', () => {
  // A regex class bracket has no valid mutant; a keyword argument's name, a key
  // or a binding with no covered read of the same name is no evidence.
  for (const [lang, b, a, text] of [['js', '  return s.split(/,/);', '  return s.split(/[,;]/);', ']'],
    ['py', "    return s.split(',')", "    return s.split(',', maxsplit=n)", 'maxsplit'],
    ['js', '  return { a: t };', '  return { b: t };', 'b']]) {
    const { ms } = sg30(lang, b, a);
    assert.strictEqual(ms.length, 0, a);
    assert.strictEqual(ms.uncovered && ms.uncovered.text, text, a);
  }
  // A renamed binding stands on the kill of its covered read.
  assert(!sg30('js', '  const k = t;\n  return k;', '  const key = t;\n  return key;').ms.uncovered);
});

test('editMutants: a called name is skipped at its own call; a namespace call passes its first non-literal argument (AUDIT-20 H3)', () => {
  const uses = (ms) => ms.filter(m => m.mutation === 'use_site').map(m => m.src.split('\n').find(l => /return/.test(l)).trim());
  assert.deepStrictEqual(uses(sg30('py', '    return str(s).strip()', '    return textwrap.dedent(str(s)).strip()').ms), ['return (str(s)).strip()']);
  assert.deepStrictEqual(uses(sg30('py', '    return str(s)', "    return unicodedata.normalize('NFKC', str(s))").ms), ['return (str(s))']);
  const js = (pre, a) => uses(bugInjector.editMutants(`'use strict';\n${pre}\nfunction f(s) {\n${a}\n}\n`, { file: 'f.js', before: `'use strict';\n${pre}\nfunction f(s) {\n  return String(s).trim();\n}\n` }));
  assert.deepStrictEqual(js("const util = require('util');", '  return util.stripVTControlCharacters(String(s)).trim();'), ['return (String(s)).trim();'], 'the module is never the replacement');
  assert.deepStrictEqual(js('', "  return String(s).normalize('NFKC').trim();"), ['return (String(s)).trim();'], 'only the call of the inserted name is skipped');
  assert.match(js('', '  return String(s).trim() + Date.now();')[0], /^return String\(s\)\.trim\(\) \+ \(\(v\) => .*\)\(Date\.now\(\)\);$/, 'no argument: the call value is perturbed');
});

test('editMutants: a mutant that adds text carries a sham of the same size: spaces after the site (SG30)', () => {
  const { ms, after } = sg30('js', '  return String(s).slice(1);', '  return String(s).slice(1, n);');
  const u = ms.find(m => m.ref === 'n');
  assert.strictEqual(u.sham.length, u.src.length);
  assert.strictEqual(u.sham, after.replace('slice(1, n)', `slice(1, n${' '.repeat(u.src.length - after.length)})`), 'only spaces, after the site');
  const str = sg30('js', "  return 'a' + t;", "  return 'b' + t;").ms[0];
  assert(str.src.includes("'bx' + t") && str.sham.includes("'b'  + t"), 'a string site pads after the literal');
  assert(!sg30('js', '  return t + 1;', '  return t + 2;').ms[0].sham, 'no sham for a same-size mutant');
});

// ---------- SG29: use-site shapes (AUDIT-19 H2, M6) ----------

test('editMutants: a read in a default value, a #private member and a shorthand property are use sites (AUDIT-19 H2, M6)', () => {
  const js = (b, a) => bugInjector.editMutants(`'use strict';\nconst LIMIT = 4;\n${a}\n`, { file: 'f.js', before: `'use strict';\nconst LIMIT = 4;\n${b}\n` });
  const P = '\\(\\(v\\) => .*\\)';
  for (const [b, a, ref, re] of [
    ['function f(a, k) {\n  return a + (k || 0);\n}', 'function f(a, k = LIMIT) {\n  return a + (k || 0) + 1;\n}', 'LIMIT', `k = ${P}\\(LIMIT\\)\\) \\{`],
    ['function f(a, { k } = {}) {\n  return a + k;\n}', 'function f(a, { k = LIMIT } = {}) {\n  return a + k;\n}', 'LIMIT', `\\{ k = ${P}\\(LIMIT\\) \\} = \\{\\}`],
    ['class K {\n  #max = 4;\n  f(s) { return s; }\n}', 'class K {\n  #max = 4;\n  f(s) { return s.slice(0, this.#max); }\n}', 'max', `slice\\(0, ${P}\\(this\\.#max\\)\\)`],
    ['function f(s) {\n  return { s };\n}', 'function f(s) {\n  return { s, LIMIT };\n}', 'LIMIT', `\\{ s, LIMIT: ${P}\\(LIMIT\\) \\}`]
  ]) {
    const ms = js(b, a);
    const use = ms.find(m => m.mutation === 'use_site' && m.ref === ref);
    assert(!ms.unmutated_ref && use, `${a}: ${JSON.stringify(ms.unmutated_ref)}`);
    assert.match(use.src, new RegExp(re), a);
  }
});

test('editMutants (Python): a call in statement position becomes None, a method call is skipped to its receiver (AUDIT-19 M6)', () => {
  const py = (a) => bugInjector.editMutants(a, { file: 'f.py', before: 'def f(s):\n    return s\n' });
  assert.strictEqual(py('def f(s):\n    log(s)\n    return s\n').find(m => m.ref === 'log').src, 'def f(s):\n    None\n    return s\n');
  assert.strictEqual(py('def f(s):\n    return s.strip()\n').find(m => m.ref === 'strip').src, 'def f(s):\n    return (s)\n');
});

test('editMutants (Python): a use check that does not finish gives no mutants, marked unchecked (AUDIT-19 M6)', (t) => {
  const cp = require('child_process');
  const injPath = require.resolve('../src/rl/bug-injector');
  const [origSpawn, origMod] = [cp.spawnSync, require.cache[injPath]];
  // Only the use check (the run that reads `toks`) times out; the parse check runs.
  cp.spawnSync = function (cmd, args) {
    if (cmd === 'python3' && String(args[2]).includes("req['toks']")) return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
    return origSpawn.apply(this, arguments);
  };
  t.after(() => { cp.spawnSync = origSpawn; require.cache[injPath] = origMod; });
  delete require.cache[injPath];
  const fresh = require('../src/rl/bug-injector');
  const ms = fresh.editMutants('MAX = 9\n\n\ndef f(s):\n    return s[0:MAX]\n', { file: 'f.py', before: 'MAX = 9\n\n\ndef f(s):\n    return s\n' });
  assert.strictEqual(ms.length, 0);
  assert.strictEqual(ms.unchecked, true);
});
