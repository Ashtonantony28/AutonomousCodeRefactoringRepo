'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bugInjector = require('../src/rl/bug-injector');
const { loadSamples } = require('../src/rl/collector');
const { assertSample } = require('../src/contracts');
const { fakeProposals, makeTempRepo, makeProposal, plainMutant: plain } = require('./helpers/factories');
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
  assert.ok([',', 'name'].includes(bugInjector.editMutants(keyOrder, { file: 'r.js', before }).uncovered.text),
    "'user' and 3 are unchanged; the moved key has no covered read of its name and its comma splits kept code: no evidence (SG30, SG44)");
  const twoHunks = "function toRow(u) {\n  const n = 4;\n  return { id: u.id, name: u.name, kind: 'admin', n: n };\n}\n";
  const ms = bugInjector.editMutants(twoHunks, { file: 'r.js', before });
  assert.deepStrictEqual([...new Set(ms.map(m => m.hunk))], [0], 'adjacent changed lines form one hunk');
  assert.deepStrictEqual(ms.map(m => m.mutation).sort(), ['numeric_off_by_one', 'string_literal']);
  const deletion = "function toRow(u) {\n  return { id: u.id, name: u.name, kind: 'user', n: 3 };\n}\n";
  const inlined = bugInjector.editMutants(deletion, { file: 'r.js', before });
  assert.deepStrictEqual(inlined.map(m => m.mutation), ['numeric_off_by_one'], 'only the inlined literal, never the unchanged string');
  assert(plain(inlined[0]).includes('n: 4'));
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
  assert(plain(ms[1]).includes('slice(0, 1001)'));
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
  const mk = 'function mk(a) {\n  return function () { return a; };\n}\n';
  const fnMuts = bugInjector.editMutants(mk, { file: 'src/mk.js', start: mk.indexOf('return'), end: mk.indexOf('};') });
  assert(fnMuts.some(m => plain(m).includes('function () { a; }')), 'the inner return is dropped');
  assert(!fnMuts.some(m => plain(m).includes('\n  function () {')), JSON.stringify(fnMuts.map(m => plain(m))));
});

test('editMutants (Python) checks every candidate in one python3 run that gets the file once, after one shape run (AUDIT-14 H3)', (t) => {
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
  assert.strictEqual(inputs.length, 2, 'one shape run, one parse-check run');
  assert(inputs.every(n => n < 2 * after.length + 20000), `sent ${inputs} chars for a ${after.length}-char file`);
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
  assert(plain(part[0]).includes('`${t};x`'), plain(part[0]));
  const fpart = sg30('py', '    return f"{t}:"', '    return f"{t};"').ms;
  assert(fpart.length === 1 && plain(fpart[0]).includes('f"{t};x"'), JSON.stringify(fpart));
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
    assert(ms.length === 1 && ms[0].mutation === 'numeric_off_by_one' && plain(ms[0]).includes(`slice(1, ${to})`), `${lit}: ${JSON.stringify(ms.map(m => plain(m)))}`);
  }
  for (const [lit, to] of [['0x1000', '4097'], ['4_096', '4097'], ['4e3', '4001.0'], ['2j', '(2j + 1)']]) {
    const { ms } = sg30('py', '    return s[1:]', `    return s[1:${lit}]`);
    assert(ms.length === 1 && plain(ms[0]).includes(`s[1:${to}]`), `${lit}: ${JSON.stringify(ms.map(m => plain(m)))}`);
  }
  const flag = sg30('js', "  return s.replace(/\\t/, ' ');", "  return s.replace(/\\t/g, ' ');").ms;
  assert(flag.length === 1 && flag[0].mutation === 'regex_literal' && plain(flag[0]).includes("replace(/\\t/, ' ')"), JSON.stringify(flag));
  const atom = sg30('js', '  return s.split(/,/);', '  return s.split(/,|;/);').ms;
  assert.deepStrictEqual(atom.map(m => plain(m).match(/split\((.*)\)/)[1]).sort(), ['/,;/', '/,|/']);
  const quant = sg30('js', '  return /^\\d{1,4}$/.test(s);', '  return /^\\d{1,5}$/.test(s);').ms;
  assert(quant.length === 1 && plain(quant[0]).includes('/^\\d{1,6}$/'), 'a quantifier bound is bumped, not dropped');
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
  const uses = (ms) => ms.filter(m => m.mutation === 'use_site').map(m => plain(m).split('\n').find(l => /return/.test(l)).trim());
  assert.deepStrictEqual(uses(sg30('py', '    return str(s).strip()', '    return textwrap.dedent(str(s)).strip()').ms), ['return (str(s)).strip()']);
  assert.deepStrictEqual(uses(sg30('py', '    return str(s)', "    return unicodedata.normalize('NFKC', str(s))").ms), ['return (str(s))']);
  const js = (pre, a) => uses(bugInjector.editMutants(`'use strict';\n${pre}\nfunction f(s) {\n${a}\n}\n`, { file: 'f.js', before: `'use strict';\n${pre}\nfunction f(s) {\n  return String(s).trim();\n}\n` }));
  assert.deepStrictEqual(js("const util = require('util');", '  return util.stripVTControlCharacters(String(s)).trim();'), ['return (String(s)).trim();'], 'the module is never the replacement');
  assert.deepStrictEqual(js('', "  return String(s).normalize('NFKC').trim();"), ['return (String(s)).trim();'], 'only the call of the inserted name is skipped');
  assert.match(js('', '  return String(s).trim() + Date.now();')[0], /^return String\(s\)\.trim\(\) \+ \(\(v\) => .*\)\(Date\.now\(\)\);$/, 'no argument: the call value is perturbed');
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
    assert.match(plain(use), new RegExp(re), a);
  }
});

test('editMutants (Python): a call in statement position becomes None, a method call is skipped to its receiver (AUDIT-19 M6)', () => {
  const py = (a) => bugInjector.editMutants(a, { file: 'f.py', before: 'def f(s):\n    return s\n' });
  assert.strictEqual(plain(py('def f(s):\n    log(s)\n    return s\n').find(m => m.ref === 'log')), 'def f(s):\n    None\n    return s\n');
  assert.strictEqual(plain(py('def f(s):\n    return s.strip()\n').find(m => m.ref === 'strip')), 'def f(s):\n    return (s)\n');
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

// ---------- SG31: literal context, operator and keyword sites ----------

test('changeHunks: a line inside or closing a multi-line literal gets the literal\'s tokens, not one quote-to-quote token (AUDIT-21 C1)', () => {
  const { changeHunks } = require('../src/utils/hunks');
  const ins = (b, a, file) => changeHunks(b, a, file).flatMap(h => h.ranges).map(([s, e]) => a.slice(s, e));
  const tpl = (x) => `function card(u) {\n  return \`\n<a href="\${String(u)${x}}">It's</a>\n\`.trim()${x} + "!";\n}\n`;
  assert.deepStrictEqual(ins(tpl(''), tpl('.slice(0, 0x800)'), 'a.js'), ['.', 'slice', '(', '0', ',', '0x800', ')', '.', 'slice', '(', '0', ',', '0x800', ')']);
  const py = (n) => `def note(s):\n    return """\nnote:\n""".strip() + " " + str(s).expandtabs(${n})\n`;
  assert.deepStrictEqual(ins(py('4'), py('-4'), 'a.py'), ['-']);
  assert.deepStrictEqual(ins('f(String(s).trim());\n', "f(String(s).normalize('NFKC').trim());\n", 'a.js'), ['.', 'normalize', '(', "'NFKC'", ')'], 'an insertion slides left');
  assert.deepStrictEqual(ins('f(String(t));\n', 'f(String(t), String(t));\n', 'a.js'), [',', 'String', '(', 't', ')'],
    'a duplicated argument starts at its separator, not at the old argument (AUDIT-23 H01)');
});

test('lexView always advances: a Python string right after a word (`return"x"`) is a string (AUDIT-21 M2)', () => {
  const code = "const { lexView } = require('./src/utils/hunks'); const v = lexView('def k(s):\\n    return\"text\" if s else\"empty\"\\n', 'python');" +
    'process.stdout.write(JSON.stringify(v.lits.map(l => l.kind)));';
  const r = require('child_process').spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.stdout, '["string","string"]', r.error ? 'lexView did not return' : r.stderr);
});

test('editMutants: every inserted operator and keyword is a site of its own; one with no mutant is uncovered (AUDIT-21 H1)', () => {
  const at = (r, a, text) => r.after.indexOf(text, r.after.indexOf(a.trim()) + 6);
  for (const [lang, b, a, text, mutation, mutated] of [
    ['js', "  return 'h' + t.slice(0, 9);", "  return 'h' + t.slice(-9);", '-', 'swap_arith', 'slice(+9)'],
    ['js', '  return Math.trunc(n);', '  return n | 0;', '|', 'swap_arith', 'n & 0'],
    ['js', '  return Math.floor(n / 2);', '  return n >> 1;', '>>', 'swap_arith', 'n << 1'],
    ['js', '  return n * 2;', '  return n ** 2;', '**', 'swap_arith', 'n * 2'],
    ['js', '  return n || 1;', '  return n ?? 1;', '??', 'swap_logical', 'n || 1'],
    ['js', "  return s === '';", "  return !(s === '');", '!', 'drop_unary', "return (s === '')"],
    ['js', '  return typeof t[n] === "number";', '  return n in t;', 'in', 'negate_in', 'return !(n in t)'],
    ['js', '  return JSON.stringify(xs);', '  return JSON.stringify(xs, null);', 'null', 'null_value', 'JSON.stringify(xs, 0)'],
    ['js', '  return s || 2;', '  return s ? s : 2;', '?', 'negate_ternary', 'return !(s) ? s : 2'],
    ['js', '  return t + 1;', '  return t++;', '++', 'swap_arith', 't--;'],
    ['py', '    return int(n / 2)', '    return n // 2', '//', 'swap_arith', 'n / 2'],
    ['py', '    return k in s', '    return k not in s', 'not', 'negate_in', 'k in s'],
    ['py', '    return n == k', '    return n is k', 'is', 'negate_in', 'n is not k'],
    ['py', '    return n', '    return not n', 'not', 'drop_not', 'return n'],
    ['py', "    return s.split(' ')", '    return s.split(None)', 'None', 'null_value', 's.split(0)']
  ]) {
    const r = sg30(lang, b, a);
    assert(!r.ms.uncovered, `${a}: ${JSON.stringify(r.ms.uncovered)}`);
    const site = at(r, a, text);
    const m = r.ms.find(x => x.site === site && x.mutation === mutation);
    assert(m, `${a}: no ${mutation} at ${text}: ${r.sites}`);
    if (mutated) assert(plain(m).includes(mutated), `${a}: ${plain(m)}`);
  }
  assert.strictEqual(sg30('js', '  return t;', '  return typeof t;').ms.uncovered.text, 'typeof');
  assert.strictEqual(sg30('py', '    return t', '    return t if s else n').ms.uncovered.text, 'if');
  assert.strictEqual(sg30('py', '    return s * t', '    return s @ t').ms.uncovered.text, '@', 'an operator with no mutant is no punctuation');
  assert.strictEqual(sg30('js', '  t += s;\n  return t;', '  t = s + 1;\n  return t;').ms.uncovered.text, '=', 'an `=` stands only on the token right after it');
  assert(!sg30('js', '  return String(s).slice(0, 9);', '  const max = 9;\n  return String(s).slice(0, max);').ms.uncovered, 'a declaration stands on its covered name and value');
});

test('editMutants: a block keyword that replaced another is not covered by its own condition site (AUDIT-31 H2)', () => {
  for (const [lang, b, a] of [
    ['js', '  while (s.length > 9) s = s.slice(1);\n  return s;', '  if (s.length > 9) s = s.slice(1);\n  return s;'],
    ['js', '  if (s.length > 9) s = s.slice(1);\n  return s;', '  while (s.length > 9) s = s.slice(1);\n  return s;'],
    ['py', '    while s.endswith(t):\n        s = s[:-1]\n    return s', '    if s.endswith(t):\n        s = s[:-1]\n    return s'],
    ['py', '    if n > 9:\n        s = s[:9]\n    elif t in s:\n        s = s.strip()\n    return s', '    if n > 9:\n        s = s[:9]\n    if t in s:\n        s = s.strip()\n    return s']
  ]) {
    const r = sg30(lang, b, a);
    assert.strictEqual(r.ms.uncovered && r.ms.uncovered.text, a.includes('while') ? 'while' : 'if', a);
  }
  // A new guard's keyword stands on its condition's kill.
  const fresh = sg30('js', '  s = s.slice(1);\n  return s;', '  if (s.length > 9) s = s.slice(1);\n  return s;');
  assert(!fresh.ms.uncovered && fresh.sites.includes('negate_condition:if'), JSON.stringify(fresh.sites));
});

test('editMutants: a guard keyword whose stretch deletes any other keyword (`with`, `switch`, `try`, `match`, `async for`) is not covered by its own condition site (AUDIT-35 C1)', () => {
  const unc = (lang, b, a) => (sg30(lang, b, a).ms.uncovered || {}).text || null;
  const sloppy = (body) => `function f(s, o) {\n${body}\n  return s;\n}\n`;
  const w = bugInjector.editMutants(sloppy('  with (o || {}) s = s.slice(0, 9);').replace('with', 'if'), { file: 'src/x.js', before: sloppy('  with (o || {}) s = s.slice(0, 9);') });
  assert.strictEqual(w.uncovered && w.uncovered.text, 'if', 'JS `with` -> `if`');
  assert.strictEqual(unc('js', '  switch (n) { default: s = s.trim(); }\n  return s;', '  if (n) { s = s.trim(); }\n  return s;'), 'if', '`switch` -> `if`');
  assert.strictEqual(unc('js', '  try { s = s.trim(); } finally { n = 0; }\n  return s;', '  if (n) { s = s.trim(); }\n  n = 0;\n  return s;'), 'if', '`try` -> `if`');
  for (const [b, a, kw] of [
    ['    with t:\n        s = s.strip()\n    return s', '    if t:\n        s = s.strip()\n    return s', 'if'],
    ['    try:\n        s = s.strip()\n    finally:\n        pass\n    return s', '    if s:\n        s = s.strip()\n    return s', 'if'],
    ['    match n:\n        case _:\n            s = s.strip()\n    return s', '    if n:\n        s = s.strip()\n    return s', 'if'],
    ['    async for c in xs:\n        s = s + c\n    return s', '    while c in xs:\n        s = s + c\n    return s', 'while']
  ]) assert.strictEqual(unc('py', b, a), kw, a);
});

test('editMutants: `for`, `do` and `else` replaced by a guard, a Python `;` on a try / except / finally, async or case line and a comma splitting kept code are uncovered (AUDIT-34 H1, H2, M1)', () => {
  const unc = (lang, b, a) => (sg30(lang, b, a).ms.uncovered || {}).text || null;
  assert.strictEqual(unc('js', '  for (; n > 0;) { n--; t += 1; }\n  return t;', '  if (n > 0) { n--; t += 1; }\n  return t;'), 'if', '`for` -> `if` runs the body once');
  assert.strictEqual(unc('js', '  do { t += 1; } while (t < n);\n  return t;', '  if (t < n) { t += 1; } while (t < n);\n  return t;'), 'if', '`do` -> `if`');
  assert.strictEqual(unc('py', "    if n > 5:\n        t = t[:5]\n    else:\n        t = t + '!'\n    return t", "    if n > 5:\n        t = t[:5]\n    elif n:\n        t = t + '!'\n    return t"), 'elif', '`else:` -> `elif n:`');
  for (const [b, a] of [
    ['    try: t = int(t)\n    except ValueError: t = 0\n    t = t + 1', '    try: t = int(t)\n    except ValueError: t = 0; t = t + 2'],
    ['    try: t = int(t)\n    finally: n = 0\n    t = t + 1', '    try: t = int(t)\n    finally: n = 0; t = t + 2'],
    ['    try: t = int(t)\n    except ValueError: t = 0', '    try: t = int(t); t = t + 2\n    except ValueError: t = 0'],
    ['    async def g(): t = 1\n    t = t + 1', '    async def g(): t = 1; t = t + 2'],
    ['    match n:\n        case 1: t = t * 3\n    t = t + 1', '    match n:\n        case 1: t = t * 3; t = t + 2']
  ]) assert.strictEqual(unc('py', `${b}\n    return t`, `${a}\n    return t`), ';', a);
  assert.strictEqual(unc('py', '    return max(n - 1, 0)', '    return max(n, - 1, 2)'), ',', 'a comma splitting an operand');
});

// ---------- SG34: same-text mutant switch, structure, strings ----------

// Runs `call` on the module `src` (a JS file defining f) with the mutant's env set or unset.
function runJs(m, call, on) {
  const [name] = Object.keys(m.env);
  if (on) process.env[name] = m.env[name]; else delete process.env[name];
  try { return new Function(`${m.src}\nreturn ${call};`)(); } finally { delete process.env[name]; }
}

test('editMutants: a mutant is a switch: the same text runs the original unless its env variable is set (AUDIT-23 H2)', () => {
  const { ms, after } = sg30('js', '  return String(s).slice(1);', '  return String(s).slice(1, n + 1);');
  assert.deepStrictEqual(ms.map(m => m.mutation).sort(), ['numeric_off_by_one', 'swap_arith', 'use_site']);
  for (const m of ms) {
    const [name] = Object.keys(m.env);
    assert(!after.includes(name), name);
    assert.strictEqual(runJs(m, "f('abcdef', 0, 2)", false), 'bc', `switch off: the edit (${m.mutation})`);
    assert.notStrictEqual(runJs(m, "f('abcdef', 0, 2)", true), 'bc', `switch on: the mutant (${m.mutation})`);
  }
  assert(ms.every(m => m.src.includes(`slice(1, (_refactor_mutant === '${m.env.REFACTOR_MUTANT}' ? `) || m.src.includes(`slice(1, n + (_refactor_mutant === '${m.env.REFACTOR_MUTANT}' ? `)), 'the smallest expression holding the change');
  // A dropped return switches its statement; a call in statement position its expression statement.
  const ret = sg30('js', '  return t;', '  if (n) return s;\n  return t;').ms.find(m => m.mutation === 'drop_return');
  assert.strictEqual(runJs(ret, 'f(1, 2, 3)', false), 1);
  assert.strictEqual(runJs(ret, 'f(1, 2, 3)', true), 2);
  const stmt = sg30('js', '  return xs;', '  xs.push(n);\n  return xs;').ms.find(m => m.ref === 'push');
  assert.match(stmt.src, /\n {2}if \(_refactor_mutant === '[a-z]{16}'\) \(void 0\); else \(xs\.push\(n\)\);\n/, 'no line can start with the switch');
  assert.deepStrictEqual(runJs(stmt, 'f(0, 0, 5, [])', false), [5]);
  assert.deepStrictEqual(runJs(stmt, 'f(0, 0, 5, [])', true), []);
  // A member callee keeps its receiver: the call is switched, not `s.trim`.
  const call = sg30('js', '  return s;', '  return s.trim();').ms.find(m => m.ref === 'trim');
  assert(call.src.includes(': (s.trim()))'), call.src);
  // Python: the same switch through os.environ.
  const py = sg30('py', '    return str(s)[1:]', '    return str(s)[1:n]').ms.find(m => m.ref === 'n');
  assert.match(py.src, /\[1:\(\(.*\) if _refactor_mutant == '[a-z]{16}' else \(n\)\)\]/);
});

// ---------- SG35: switch read once per module, bounded JS parse check ----------

test('editMutants: the switch variable is read once per module load, into a binding after any prologue (AUDIT-25 H1)', () => {
  const b = "#!/usr/bin/env node\n'use strict';\nfunction f(x) {\n  return x + 1;\n}\nmodule.exports = { f };\n";
  const a = b.replace('x + 1', 'x + 2 - 1');
  const ms = bugInjector.editMutants(a, { file: 'src/m.js', before: b });
  assert(ms.length >= 2);
  for (const m of ms) {
    const [[name, val]] = Object.entries(m.env);
    assert.strictEqual(m.src.split(name).length, 2, 'one read of the variable');
    assert(m.src.startsWith(`#!/usr/bin/env node\n'use strict';\nvar _refactor_mutant = globalThis.process.env.${name}; function f(x) {\n`) && m.src.includes(`_refactor_mutant === '${val}'`), m.src);
    assert.strictEqual(m.src.split('\n').length, a.split('\n').length, 'no line added');
    const load = () => { const mod = { exports: {} }; new Function('module', m.src.replace(/^#!.*/, ''))(mod); return mod.exports.f; };
    const withVal = (v) => { process.env[name] = v; try { return load(); } finally { delete process.env[name]; } };
    const f = withVal(val);
    assert.notStrictEqual(f(1), 2, `${m.mutation}: switched on at load stays on`);
    assert.strictEqual(load()(1), 2, 'switched off at load: the edit');
    assert.strictEqual(withVal(m.control[name])(1), 2, 'the control value switches it off');
  }
  // A binding name the source already uses is never reused.
  const taken = 'const _refactor_mutant = 1;\nfunction f(x) {\n  return x + _refactor_mutant;\n}\n';
  const t = bugInjector.editMutants(taken.replace('x + _', 'x - _'), { file: 'm.js', before: taken });
  assert(t.length && t.every(m => Object.keys(m.env)[0] === 'REFACTOR_MUTANT_1' && m.src.startsWith('var _refactor_mutant_1 = ')), t.map(m => m.src).join('\n'));
});

test('editMutants: mutant and control runs set the same switch variable, to random values of one shape (AUDIT-31 H1)', () => {
  const runs = [['src/m.js', "function f(x) {\n  return x + 1;\n}\n"], ['app/m.py', 'def f(x):\n    return x + 1\n']].map(([file, b]) =>
    bugInjector.editMutants(b.replace('x + 1', 'x + 2'), { file, before: b }));
  for (const ms of runs) {
    assert(ms.length);
    for (const m of ms) {
      assert.deepStrictEqual(Object.keys(m.control), Object.keys(m.env), 'the same key set in the control');
      const [on, off] = [Object.values(m.env)[0], Object.values(m.control)[0]];
      assert(/^[a-z]{16}$/.test(on) && /^[a-z]{16}$/.test(off) && on !== off, `${on} ${off}`);
      assert(m.src.includes(`'${on}'`) && !m.src.includes(off), 'only the switch value is in the source');
    }
  }
  const again = bugInjector.editMutants("function f(x) {\n  return x + 2;\n}\n", { file: 'src/m.js', before: "function f(x) {\n  return x + 1;\n}\n" });
  assert.notStrictEqual(again[0].env.REFACTOR_MUTANT, runs[0][0].env.REFACTOR_MUTANT, 'a fresh value per call');
});

test('editMutants: the switch binding holds a value of one type in mutant and control runs: module state shows no flag (AUDIT-35 H1)', () => {
  const { spawnSync } = require('child_process');
  const pb = 'DEBUG = False\n\n\ndef f(x):\n    return x[:6000]\n';
  const code = "import json, sys\nns = {}\nexec(compile(sys.stdin.read(), 'm.py', 'exec'), ns)\n" +
    "print(json.dumps(sorted((k, type(v).__name__) for k, v in ns.items() if k != '__builtins__' and not callable(v))), [k for k, v in ns.items() if v is True])";
  const pms = bugInjector.editMutants(pb.replace('6000', '7000'), { file: 'app/m.py', before: pb });
  assert(pms.length);
  for (const m of pms) {
    const [on, off] = [m.env, m.control].map(e => spawnSync('python3', ['-I', '-c', code], { input: m.src, encoding: 'utf8', env: { ...process.env, ...e } }));
    assert.strictEqual(on.status, 0, on.stderr);
    assert.strictEqual(on.stdout, off.stdout, 'the same module state in mutant and control runs');
    assert(on.stdout.trim().endsWith(' []'), on.stdout);
  }
  const vm = require('vm');
  const jb = 'var max = 6000;\nfunction f(x) {\n  return x.slice(0, max);\n}\n';
  const jms = bugInjector.editMutants(jb.replace('0, max', '1, max'), { file: 'src/m.js', before: jb });
  assert(jms.length);
  for (const m of jms) {
    const [on, off] = [m.env, m.control].map(env => {
      const ctx = vm.createContext({ process: { env } });
      vm.runInContext(m.src, ctx);
      return JSON.stringify(Object.entries(ctx).filter(([k]) => k !== 'process').map(([k, v]) => [k, typeof v, v === true]));
    });
    assert.strictEqual(on, off, 'a sloppy script\'s globals have the same types in mutant and control runs');
  }
});

test('editMutants (Python): the switch binding goes after the docstring and __future__ imports, read once (AUDIT-25 H1)', () => {
  const { spawnSync } = require('child_process');
  const read = "_refactor_mutant = __import__('os').environ.get('REFACTOR_MUTANT')";
  const cases = [
    ['"""Doc."""\nfrom __future__ import annotations  # c\nimport os\n\n\ndef f(x):\n    return x + 1\n', `annotations; ${read}  # c\n`],
    ['import os\n\n\ndef f(x):\n    return x + 1\n', `${read}; import os\n`],
    ['@staticmethod\ndef f(x):\n    return x + 1\n', `${read}\n@staticmethod\n`]
  ];
  const code = "import os, sys\nns = {}\nexec(compile(sys.stdin.read(), 'm.py', 'exec'), ns)\nos.environ.pop('REFACTOR_MUTANT', None)\n" +
    "f = ns['f'].__func__ if isinstance(ns['f'], staticmethod) else ns['f']\nprint(f(1), ns.get('__doc__'))";
  for (const [b, head] of cases) {
    const ms = bugInjector.editMutants(b.replace('x + 1', 'x + 2'), { file: 'app/m.py', before: b });
    assert(ms.length, b);
    const doc = b.startsWith('"""') ? 'Doc.' : 'None';
    for (const m of ms) {
      assert(m.src.includes(head.replace('VAL', m.env.REFACTOR_MUTANT)), m.src);
      assert.strictEqual(m.src.split('REFACTOR_MUTANT').length, 2, 'one read of the variable');
      const run = (env) => spawnSync('python3', ['-I', '-c', code], { input: m.src, encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim();
      assert.strictEqual(run({}), `3 ${doc}`, 'switched off at load: the edit');
      assert.strictEqual(run(m.control), `3 ${doc}`, 'the control value switches it off');
      const on = run(m.env);
      assert(on !== `3 ${doc}` && on.endsWith(` ${doc}`), `${m.mutation}: switched on at load stays on; the docstring stays (${on})`);
    }
  }
});

test('editMutants (Python): a file that starts with a BOM gets switch mutants that load, the BOM kept first (AUDIT-28 M2)', () => {
  const { spawnSync } = require('child_process');
  const b = "﻿def label(n):\n    return 'n=' + str(n)\n";
  const ms = bugInjector.editMutants(b.replace('str(n)\n', "str(n) + '!'\n"), { file: 'app/m.py', before: b });
  assert(!ms.unchecked && ms.length, 'mutants built');
  for (const m of ms) {
    assert(m.src.startsWith('﻿') && m.src.split('﻿').length === 2, JSON.stringify(m.src));
    const run = (env) => spawnSync('python3', ['-I', '-c', "import sys\nns = {}\nexec(compile(sys.stdin.buffer.read(), 'm.py', 'exec'), ns)\nprint(ns['label'](1))"],
      { input: Buffer.from(m.src), encoding: 'utf8', env: { ...process.env, ...env } });
    assert.strictEqual(run({}).stdout.trim(), 'n=1!', 'switched off: the edit');
    const on = run(m.env);
    assert(!/SyntaxError/.test(on.stderr) && on.stdout.trim() !== 'n=1!', `${m.mutation}: ${on.stdout}${on.stderr}`);
  }
});

test('editMutants: a JS parse check that does not finish within timeoutMs gives no mutants, marked unchecked (AUDIT-25 M1)', () => {
  const rows = Array.from({ length: 4000 }, (_, i) => `  [${i}, 'k${i}', ${i * 3}],`).join('\n');
  const b = `const T = [\n${rows}\n  [1, 'a', 2],\n];\nmodule.exports = T;\n`;
  const a = b.replace("[1, 'a', 2]", "[2, 'b' + 'c', 3 * 4 - 1]");
  assert(bugInjector.editMutants(a, { file: 'm.js', before: b }).length, 'mutants within the default limit');
  const ms = bugInjector.editMutants(a, { file: 'm.js', before: b, timeoutMs: 1 });
  assert.strictEqual(ms.length, 0);
  assert.strictEqual(ms.unchecked, true);
});

test('editMutants: a change with no switch target has no mutant (AUDIT-23 H2)', () => {
  const key = sg30('js', '  class K { 1() { return t; } }\n  return K;', '  class K { 2() { return t; } }\n  return K;');
  assert.strictEqual(key.ms.length, 0);
  assert.strictEqual(key.ms.uncovered.text, '2', 'a method key in a class declaration is in no expression: no mutant, uncovered');
  const obj = sg30('js', '  return { 1: t };', '  return { 2: t };').ms;
  assert(obj.length === 1 && plain(obj[0]).includes('return { 3: t };'), 'an object key switches its object');
});

test('changeHunks: a backslash-continued string is one token; the code after it is code (AUDIT-23 C1)', () => {
  const { changeHunks } = require('../src/utils/hunks');
  const ins = (b, a, file) => changeHunks(b, a, file).flatMap(h => h.ranges).map(([s, e]) => a.slice(s, e));
  assert.deepStrictEqual(ins("  return 'ID:\\\n' + s;\n", "  return 'ID:\\\n' + String(s).trim();\n", 'a.js'), ['String', '(', ')', '.', 'trim', '(', ')']);
  assert.deepStrictEqual(ins("    return 'ID:\\\n' + s\n", "    return 'ID:\\\n' + str(s).strip()\n", 'a.py'), ['str', '(', ')', '.', 'strip', '(', ')']);
  const c01 = sg30('js', "  return 'ID:\\\n' + t;", "  return 'ID:\\\n' + String(t).normalize('NFKC');");
  assert(c01.ms.some(m => m.ref === 'normalize') || c01.ms.unmutated_ref, 'the inserted read has a use site');
});

test('changeHunks: a respelled string or number is no change (AUDIT-23 H1)', () => {
  const { changeHunks } = require('../src/utils/hunks');
  const ins = (b, a, file) => changeHunks(b, a, file).flatMap(h => h.ranges).map(([s, e]) => a.slice(s, e));
  assert.deepStrictEqual(ins("x = f('NFC', 120);\n", 'x = f("NFC", 0x78);\n', 'a.js'), []);
  assert.deepStrictEqual(ins("x = f('NFC', 4096)\n", 'x = f("NFC", 0x1000)\n', 'a.py'), []);
  assert.deepStrictEqual(ins("x = f('a\\n', 1.0)\n", 'x = f("a\\n", 1)\n', 'a.py'), ['"a\\n"', '1'], 'an escape or a float -> int change is a change');
  assert.deepStrictEqual(ins("x = 'a'\n", "x = b'a'\n", 'a.py'), ["b'a'"]);
});

test('changeHunks: BigInt and legacy-octal literals compare by value (AUDIT-26 H3)', () => {
  const { changeHunks } = require('../src/utils/hunks');
  const ins = (b, a) => changeHunks(b, a, 'a.js').flatMap(h => h.ranges).map(([s, e]) => a.slice(s, e));
  assert.deepStrictEqual(ins('x = f(1000n);\n', 'x = f(2000n);\n'), ['2000n']);
  assert.deepStrictEqual(ins('x = f(1000n);\n', 'x = f(0x3e8n);\n'), [], 'same BigInt, respelled');
  assert.deepStrictEqual(ins('x = f(10n);\n', 'x = f(10);\n'), ['10'], 'a BigInt is no Number');
  assert.deepStrictEqual(ins('x = f(10);\n', 'x = f(010);\n'), ['010'], '010 is 8, not 10');
  assert.deepStrictEqual(ins('x = f(10);\n', 'x = f(10.0);\n'), []);
});

test('changeHunks: a numeric token with no computable value compares by its text (AUDIT-27 C1)', () => {
  const { changeHunks } = require('../src/utils/hunks');
  const ins = (b, a, file) => changeHunks(b, a, file).flatMap(h => h.ranges).map(([s, e]) => a.slice(s, e));
  assert.deepStrictEqual(ins('x = f(0x1e+6000);\n', 'x = f(0x2e+6000);\n', 'a.js'), ['0x2e+6000']);
  assert.deepStrictEqual(ins('x = 6e3.toFixed();\n', 'x = 7e3.toFixed();\n', 'a.js'), ['7e3.toFixed']);
  assert.deepStrictEqual(ins('x = int(6e3.real)\n', 'x = int(7e3.real)\n', 'a.py'), ['7e3.real']);
  assert.deepStrictEqual(ins('x = 0x1e+6000\n', 'x = 0x3e+6000\n', 'a.py'), ['0x3e+6000']);
  assert.deepStrictEqual(ins('x = 6e3.toFixed();\n', 'x = 6e3.toFixed();\n', 'a.js'), []);
  assert.deepStrictEqual(ins('x = 1e3n;\n', 'x = 1.5n;\n', 'a.js'), ['1.5n'], 'a BigInt spelling with no value');
  const { ms } = sg30('js', '  return s.slice(0, 0x1e+6000);', '  return s.slice(0, 0x2e+6000);');
  assert.strictEqual(ms.uncovered && ms.uncovered.text, '0x2e+6000', 'a number with no mutant is uncovered');
});

test('editMutants: a bracket or indentation that changes what kept code it frames is uncovered (AUDIT-23 H1, AUDIT-27 H1)', () => {
  const braces = sg30('js', '  if (n > 1) t = t.slice(0, 9);\n  t = t.trim();\n  return t;', '  if (n > 1) { t = t.slice(0, 9);\n  t = t.trim(); }\n  return t;');
  assert.strictEqual(braces.ms.uncovered && braces.ms.uncovered.text, '{', 'a statement moved into a block');
  const parens = sg30('js', '  return s + t.trim();', '  return (s + t).trim();');
  assert.strictEqual(parens.ms.uncovered && parens.ms.uncovered.text, '(', 'an operand widened');
  const outside = sg30('js', '  if (n > 1) t = t.slice(0, 9);\n  t = t.trim();\n  return t;', '  if (n > 1) { t = t.slice(0, 9);\n  t = t.trim(); }\n  return t + 1;');
  assert.strictEqual(outside.ms.uncovered && outside.ms.uncovered.text, '{', 'a site outside the block does not cover it');
  const inside = sg30('js', '  if (n > 1) t = t.slice(0, 9);\n  t = t.trim();\n  return t;', '  if (n > 1) { t = t.slice(0, 8);\n  t = t.trim(); }\n  return t;');
  assert.strictEqual(inside.ms.uncovered && inside.ms.uncovered.text, '{', 'a sibling site inside the block does not cover it');
  const pyInside = sg30('py', '    if n > 1:\n        t = t[:9]\n    t = t.strip()\n    return t', '    if n > 1:\n        t = t[:8]\n        t = t.strip()\n    return t');
  assert.strictEqual(pyInside.ms.uncovered && pyInside.ms.uncovered.text, '        ', 'nor a sibling inside the block of a re-indented line');
  const indent = sg30('py', '    if n > 1:\n        t = t[:9]\n    t = t.strip()\n    return t', '    if n > 1:\n        t = t[:9]\n        t = t.strip()\n    return t');
  assert.strictEqual(indent.ms.uncovered && indent.ms.uncovered.text, '        ', 'a statement indented into a block');
  // Brackets of new code, a new call around kept code and continuation lines need nothing more.
  assert(!sg30('js', '  return s;', '  return s.trim();').ms.uncovered);
  assert(!sg30('js', '  return t;', '  return Math.max(0, t);').ms.uncovered);
  assert(!sg30('js', '  return t;', '  return String(t);').ms.uncovered);
  assert(!sg30('py', '    return f(s,\n        t)', '    return f(s,\n             t)').ms.uncovered, 'a continuation line is no statement');
});

test('editMutants: a `;` or `,` that changes statement or value structure is uncovered; others need nothing (AUDIT-27 H2)', () => {
  const unc = (lang, b, a) => (sg30(lang, b, a).ms.uncovered || {}).text || null;
  assert.strictEqual(unc('js', "  if (n > 1) t = t.trim();\n  return t;", "  if (n > 1); t = t.trim();\n  return t + '';"), ';', 'empty `if` body');
  assert.strictEqual(unc('js', "  if (n > 1) t = 1;\n  else t = t.trim();\n  return t;", "  if (n > 1) t = 1;\n  else; t = t.trim();\n  return t + '';"), ';', 'empty `else` body');
  assert.strictEqual(unc('js', "  for (const x of xs) t += x;\n  return t;", "  for (const x of xs); t += x;\n  return t + '';"), ';', 'empty loop body');
  assert.strictEqual(unc('js', "  const v = t\n  (s)\n  return v;", "  const v = t;\n  (s)\n  return v + '';"), ';', 'ends a statement ASI continued');
  assert.strictEqual(unc('py', "    if n > 1: t = t[:9]\n    t = t.strip()\n    return t", "    if n > 1: t = t[:9]; t = t.strip()\n    return t + ''"), ';', 'joins a line into a suite');
  assert.strictEqual(unc('py', "    t = t[:9]\n    return t", "    t = t[:9],\n    return t + ''"), ',', 'a trailing comma makes a tuple');
  assert.strictEqual(unc('py', "    return (t)", "    return (t,)"), ',', 'in a grouping paren');
  assert.strictEqual(unc('py', "    return xs[n]", "    return xs[n,]"), ',', 'in a subscript');
  assert.strictEqual(unc('js', "  return [s, t];", "  return [s, t,];"), null, 'a trailing comma in an array');
  assert.strictEqual(unc('js', "  t = t.trim()\n  return t;", "  t = t.trim();\n  return t;"), null, 'a statement-ending `;`');
  assert.strictEqual(unc('py', "    return f(s, t)", "    return f(s, t,)"), null, 'a trailing comma in a call');
  assert.strictEqual(unc('py', "    return [s, t]", "    return [s, t,]"), null, 'a trailing comma in a list');
  assert.strictEqual(unc('py', "    t = t.strip()\n    return t", "    t = t.strip(); t = t[:9]\n    return t"), null, 'joins two simple statements');
});

test('editMutants: every head, ASI line start, compound keyword and tuple-making comma of the structural rule is uncovered (AUDIT-30 H1, H2)', () => {
  const unc = (lang, b, a) => (sg30(lang, b, a).ms.uncovered || {}).text || null;
  assert.strictEqual(unc('js', '  while (n-- > 0) t += 1;\n  return t;', '  while (n-- > 0); t += 2;\n  return t;'), ';', 'empty `while` body');
  for (const line of ['[s].join()', '`${s}`.trim()', '+n', '-n', '/x/.test(s)']) {
    assert.strictEqual(unc('js', `  const v = s\n  ${line}\n  return v;`, `  const v = s * 2;\n  ${line}\n  return v;`), ';', `ends a statement ASI continued by ${line[0]}`);
  }
  for (const head of ['for x in xs', 'while n', 'with s', 'def g()', 'class C']) {
    assert.strictEqual(unc('py', `    ${head}: t = 1\n    t = t + 1\n    return t`, `    ${head}: t = 1; t = t + 2\n    return t`), ';', `joins a line into a \`${head}\` suite`);
  }
  assert.strictEqual(unc('py', '    x = xs\n    return x', '    x, = xs[:1]\n    return x'), ',', 'a trailing comma before `=` unpacks');
  for (const kw of ['in', 'not', 'and', 'or', 'is', 'if', 'else']) {
    const expr = kw === 'if' ? 's if (t,) else 1' : kw === 'else' ? '1 if s else (t,)' : kw === 'not' ? 's and not (t,)' : `s ${kw} (t,)`;
    assert.strictEqual(unc('py', `    return [${expr.replace('(t,)', '(t)')}, 1]`, `    return [${expr}, 2]`), ',', `a paren after \`${kw}\` groups, so its comma makes a tuple`);
  }
  // A site on the re-indented line itself does not cover the move into the block.
  const ind = sg30('py', '    if n > 1:\n        t = t[:9]\n    t = t.strip()\n    return t', "    if n > 1:\n        t = t[:9]\n        t = t.strip() + '!'\n    return t");
  assert.strictEqual(ind.ms.uncovered && ind.ms.uncovered.text, '        ');
});

test('editMutants: a comma making a tuple after any keyword head or beside a lambda is uncovered; one in a display with other commas, a `;` before `++` / `--` or after `match` / `case` names is not (AUDIT-32 H3, M1, L1)', () => {
  const unc = (lang, b, a) => (sg30(lang, b, a).ms.uncovered || {}).text || null;
  const head = (kw) => (kw === 'elif' ? '    if n > 5:\n        return s\n    elif' : `    ${kw}`);
  for (const kw of ['elif', 'while']) {
    assert.strictEqual(unc('py', `${head(kw)} (n > 1):\n        return t\n    return s`, `${head(kw)} (n > 1,):\n        return t + 'x'\n    return s`), ',', `\`${kw} (c,):\` is always true`);
  }
  assert.strictEqual(unc('py', '    for (x) in xs:\n        t = x\n    return t', '    for (x,) in xs:\n        t = x\n    return t + 1'), ',', 'a `for` target unpacks');
  assert.strictEqual(unc('py', '    return (lambda a, b: a)', '    return (lambda a, b: a,)'), ',', 'a lambda\'s commas are not the paren\'s');
  assert.strictEqual(unc('py', '    return xs[0]', '    x, = xs[:1]\n    return x'), ',', 'an unpacking comma in new code');
  assert.strictEqual(unc('py', '    return s.match(t)', '    return s.match(t,)'), null, 'an attribute named like a keyword is a call');
  const tup = (...xs) => `    T = (\n${xs.map(x => `        '${x}',\n`).join('')}    )\n    return s in T`;
  assert.strictEqual(unc('py', tup('a', 'b'), tup('a', 'b', 'c')), null, 'an element added to a multi-line tuple display');
  assert.strictEqual(unc('py', '    return xs[n, t]', '    return xs[n, t,]'), null, 'a subscript that is already a tuple');
  assert.strictEqual(unc('py', '    return [s, (t)]', '    return [s, (t, n,)]'), ',', 'the comma before `n` makes a tuple of kept `t` (SG44)');
  assert.strictEqual(unc('py', '    return [s, (t, u)]', '    return [s, (t, u, n,)]'), null, 'an element added to a tuple display is a site');
  for (const op of ['++', '--']) assert.strictEqual(unc('js', `  let i = n\n  ${op}t\n  return i + t;`, `  let i = n + 1;\n  ${op}t\n  return i + t;`), null, `ASI never joins a \`${op}\` line`);
  for (const name of ['match', 'case']) {
    assert.strictEqual(unc('py', `    ${name} = s\n    return ${name}`, `    ${name} = s; xs.append(n + 1)\n    return ${name}`), null, `\`${name}\` as a name`);
  }
  assert.strictEqual(unc('py', '    if (n >\n            1): t = 1\n    t = t + 1\n    return t', '    if (n >\n            1): t = 1; t = t + 2\n    return t'), ';', 'a compound statement continued over lines');
  assert.strictEqual(unc('py', '    if n > \\\n            1: t = 1\n    t = t + 1\n    return t', '    if n > \\\n            1: t = 1; t = t + 2\n    return t'), ';', 'a backslash-continued header');
});

test('editMutants: a JS `;` after a `for await` / `with` head or before same-line code the expression would continue into, and a comma splitting kept code, are uncovered (AUDIT-31 C1, H3)', () => {
  const unc = (b, a) => (sg30('js', b, a).ms.uncovered || {}).text || null;
  const head = (h, b, a) => {
    const wrap = (body) => `${h}function f(s, t, n, xs) {\n${body}\n}\nmodule.exports = { f };\n`;
    return (bugInjector.editMutants(wrap(a), { file: 'src/x.js', before: wrap(b) }).uncovered || {}).text || null;
  };
  assert.strictEqual(head("'use strict';\nasync ", '  for await (const x of xs) t += x;\n  return t;', "  for await (const x of xs); t += x;\n  return t + '';"), ';', 'empty `for await` body');
  assert.strictEqual(head('', '  with (s) t += 1;\n  return t;', "  with (s); t += 1;\n  return t + '';"), ';', 'empty `with` body (sloppy mode)');
  assert.strictEqual(unc("  return s + (n > 1 ? 'x' : '');", "  return s + ''; + (n > 1 ? 'x' : '');"), ';', 'a same-line `;` turns a binary `+` into a statement');
  assert.strictEqual(unc('  return s.slice(0, 6000 - 1);', '  return s.slice(0, 6000, - 1);'), ',', 'a comma splitting an operand');
  assert.strictEqual(unc('  return s.slice(0, n);', '  return s.slice(0, n, 1);'), null, 'a comma before an inserted argument');
  assert.strictEqual(unc('  t = t.trim()\n  return t;', '  t = t.trim(); t = t.slice(1);\n  return t;'), null, 'a `;` before a new statement');
});

test('editMutants: a moved argument-list bracket stands only on its own call or a prefix operator right before it (AUDIT-26 H1, H2)', () => {
  // `g(a) + b` -> `h(g(a + b))` / `~g(a + b)`: g's `)` moves past `+ b`.
  const wrapped = sg30('js', '  return g(s) + t;', '  return h(g(s + t));').ms;
  assert.strictEqual(wrapped.uncovered && wrapped.uncovered.text, ')', 'a wrapper\'s use site does not cover g\'s parentheses');
  const prefixed = sg30('js', '  return g(s) + t;', '  return ~g(s + t);').ms;
  assert.strictEqual(prefixed.uncovered && prefixed.uncovered.text, ')', 'a prefix applied to g(...) does not cover g\'s parentheses');
  assert(!sg30('js', '  return s + t;', '  return ~(s + t);').ms.uncovered, 'a prefix right before the pair covers it');
  assert(!sg30('js', '  return s + t;', '  return h(s + t);').ms.uncovered, 'a new call covers its own parentheses');
});

test('editMutants: a token with no mutant is covered by its own operands\' use sites, never a wrapper\'s (AUDIT-23 H3)', () => {
  const wrap = sg30('js', "  return 'K:' + (Number.isFinite(n) ? 'N' : 'O');", "  return ('k:' + (typeof n === 'number' ? 'n' : 'o')).toUpperCase();");
  assert.strictEqual(wrap.ms.uncovered && wrap.ms.uncovered.text, 'typeof');
  assert(!sg30('js', '  return s;', '  return s.trim();').ms.uncovered, 'the dot of a member call stands on its name');
  assert(!sg30('py', '    return s', '    return s.strip()').ms.uncovered);
});

test('editMutants: a `,` or JS `;` beside kept code that demotes it, an elision or a new tuple is uncovered; a new element, argument or statement is not (AUDIT-36 H1, H2, AUDIT-35 H2)', () => {
  const unc = (lang, b, a) => (sg30(lang, b, a).ms.uncovered || {}).text || null;
  for (const [b, a, why] of [
    ['  return s;', '  return s, t;', 'the comma operator discards `s`'],
    ['  const x = s && t;\n  return x;', '  const x = s; String(t) && t;\n  return x;', 'the `;` cuts `&& t` off `x`'],
    ['  return [s];', "  return [s + '',,];", 'a trailing hole'],
    ['  return [s, t];', "  return [s + '', , t];", 'an inner hole beside an inserted sibling'],
    ['  return s.slice(0, 6000 - 1);', '  return s.slice(0, 6000 | 0, - 1);', 'a split beside an inserted sibling']
  ]) assert.notStrictEqual(unc('js', b, a), null, why);
  for (const [b, a, why] of [
    ['    if (n > 1):\n        return t\n    return s', '    if (n > 1, len(t)):\n        return t\n    return s', 'an always-true tuple'],
    ['    return s', '    return s, t', 'a tuple of the returned value'],
    ['    return f"{s}"', "    return f\"{s[:9] + '',}\"", 'an f-string field made a tuple'],
    ['    x = s and t\n    return x', '    x = s; str(t) and t\n    return x', 'the `;` cuts `and t` off `x`'],
    ['    return s[:max(6000 - 1, 0)]', '    return s[:max(6000 | 0, - 1, 0)]', 'a split beside an inserted sibling']
  ]) assert.notStrictEqual(unc('py', b, a), null, why);
  for (const [b, a, why] of [
    ['  return [s];', '  return [s, t];', 'an element appended'],
    ['  return String(s);', '  return String(s, t);', 'an argument appended'],
    ['  let a = s;\n  return a;', '  let a = s, b = t;\n  return a + b;', 'a declarator appended'],
    ['  let x = s;\n  return x;', '  let x = s;\n  x = x + t;\n  return x;', 'a statement after a complete one'],
    ['  let x = s\n  return x', '  let x = s\n  x = x + t;\n  return x', 'a statement between ASI-separated ones']
  ]) assert.strictEqual(unc('js', b, a), null, why);
  for (const [b, a, why] of [
    ['    return [s]', '    return [s, t]', 'an element appended'],
    ['    return max(s)', '    return max(s, t)', 'an argument appended'],
    ['    return (s, t)', '    return (s, t, n)', 'an element appended to a tuple']
  ]) assert.strictEqual(unc('py', b, a), null, why);
});
