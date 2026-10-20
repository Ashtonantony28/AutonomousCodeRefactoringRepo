'use strict';

// Executor over-revert rate: behaviour-preserving refactors with suites that
// assert the edited function's results thoroughly, end to end (worktree, real
// tests, coverage, per-hunk mutants, commit). Critic: unanimous approve.
// Any outcome other than `passed` is an over-rejection; the reason is listed.
//
//   node audit/12/executor-benign.js           # all
//   node audit/12/executor-benign.js B03 B07   # some
// Prints FINDING (exit 1) when any safe refactor is not committed.

const { e2e, UNANIMOUS, pytestWithCoverageDir } = require('../5/lib');

const nodeTest = (req, body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('${req}');\n${body}\n`;
const NODE_PKG = { scripts: { test: 'node --test' } };

const CASES = [
  { id: 'B01', kind: 'rename parameters', cur: 'function scale(v, k) {\n  return v * k;\n}', prop: 'function scale(value, factor) {\n  return value * factor;\n}',
    t: 'assert.strictEqual(m.scale(2, 3), 6); assert.strictEqual(m.scale(-1, 4), -4); assert.strictEqual(m.scale(0, 9), 0);' },
  { id: 'B02', kind: 'let -> const', cur: "function full(a, b) {\n  let s = a + ' ' + b;\n  return s;\n}", prop: "function full(a, b) {\n  const s = a + ' ' + b;\n  return s;\n}",
    t: "assert.strictEqual(m.full('a', 'b'), 'a b'); assert.strictEqual(m.full('', 'x'), ' x');" },
  { id: 'B03', kind: 'for loop -> for...of', cur: 'function sum(xs) {\n  let s = 0;\n  for (let i = 0; i < xs.length; i++) s += xs[i];\n  return s;\n}', prop: 'function sum(xs) {\n  let s = 0;\n  for (const x of xs) s += x;\n  return s;\n}',
    t: 'assert.strictEqual(m.sum([1, 2, 3]), 6); assert.strictEqual(m.sum([]), 0); assert.strictEqual(m.sum([-5]), -5);' },
  { id: 'B04', kind: 'if/else -> ternary', cur: "function tag(n) {\n  if (n % 2 === 0) {\n    return 'even';\n  }\n  return 'odd';\n}", prop: "function tag(n) {\n  return n % 2 === 0 ? 'even' : 'odd';\n}",
    t: "assert.strictEqual(m.tag(2), 'even'); assert.strictEqual(m.tag(3), 'odd'); assert.strictEqual(m.tag(0), 'even');" },
  { id: 'B05', kind: 'string concat -> template literal', cur: "function greet(n) {\n  return 'Hi, ' + n + '!';\n}", prop: 'function greet(n) {\n  return `Hi, ${n}!`;\n}',
    t: "assert.strictEqual(m.greet('ada'), 'Hi, ada!'); assert.strictEqual(m.greet(''), 'Hi, !');" },
  { id: 'B06', kind: 'Object.assign -> spread', cur: 'function withId(o, id) {\n  return Object.assign({}, o, { id: id });\n}', prop: 'function withId(o, id) {\n  return { ...o, id };\n}',
    t: 'assert.deepStrictEqual(m.withId({ a: 1 }, 2), { a: 1, id: 2 }); assert.deepStrictEqual(m.withId({ id: 1 }, 3), { id: 3 });' },
  { id: 'B07', kind: 'loop -> some()', cur: 'function anyNeg(xs) {\n  for (const x of xs) {\n    if (x < 0) return true;\n  }\n  return false;\n}', prop: 'function anyNeg(xs) {\n  return xs.some((x) => x < 0);\n}',
    t: 'assert.strictEqual(m.anyNeg([1, -1]), true); assert.strictEqual(m.anyNeg([1, 2]), false); assert.strictEqual(m.anyNeg([0]), false); assert.strictEqual(m.anyNeg([]), false);' },
  { id: 'B08', kind: 'nested ifs -> guard clauses', cur: "function grade(s) {\n  if (s >= 50) {\n    if (s >= 90) {\n      return 'A';\n    }\n    return 'P';\n  }\n  return 'F';\n}", prop: "function grade(s) {\n  if (!(s >= 50)) return 'F';\n  if (s >= 90) return 'A';\n  return 'P';\n}",
    t: "assert.strictEqual(m.grade(95), 'A'); assert.strictEqual(m.grade(90), 'A'); assert.strictEqual(m.grade(60), 'P'); assert.strictEqual(m.grade(50), 'P'); assert.strictEqual(m.grade(49), 'F');" },
  { id: 'B09', kind: 'Math.pow -> **', cur: 'function cube(x) {\n  return Math.pow(x, 3);\n}', prop: 'function cube(x) {\n  return x ** 3;\n}',
    t: 'assert.strictEqual(m.cube(2), 8); assert.strictEqual(m.cube(-3), -27);' },
  { id: 'B10', kind: 'push loop -> map', cur: 'function names(us) {\n  const out = [];\n  for (const u of us) out.push(u.name);\n  return out;\n}', prop: 'function names(us) {\n  return Array.from(us, (u) => u.name);\n}',
    t: "assert.deepStrictEqual(m.names([{ name: 'a' }, { name: 'b' }]), ['a', 'b']); assert.deepStrictEqual(m.names([]), []);" },
  { id: 'B11', kind: 'inline temporary', cur: 'function area(w, h) {\n  const a = w * h;\n  return a;\n}', prop: 'function area(w, h) {\n  return w * h;\n}',
    t: 'assert.strictEqual(m.area(2, 3), 6); assert.strictEqual(m.area(0, 3), 0);' },
  { id: 'B12', kind: 'filter().length -> reduce count', cur: 'function countPos(xs) {\n  return xs.filter((x) => x > 0).length;\n}', prop: 'function countPos(xs) {\n  return xs.reduce((n, x) => (x > 0 ? n + 1 : n), 0);\n}',
    t: 'assert.strictEqual(m.countPos([1, -1, 2, 0]), 2); assert.strictEqual(m.countPos([]), 0);' },
  { id: 'B13', kind: 'add a comment and blank line', cur: 'function neg(x) {\n  return -x;\n}', prop: 'function neg(x) {\n  // flip the sign\n\n  return -x;\n}',
    t: 'assert.strictEqual(m.neg(2), -2); assert.strictEqual(m.neg(-1), 1);' },
  { id: 'B14', kind: 'clamp: min/max -> conditional chain', cur: 'function clamp(x) {\n  return Math.min(10, Math.max(0, x));\n}', prop: 'function clamp(x) {\n  if (x < 0) return 0;\n  if (x > 10) return 10;\n  return x;\n}',
    t: 'assert.strictEqual(m.clamp(-1), 0); assert.strictEqual(m.clamp(0), 0); assert.strictEqual(m.clamp(5), 5); assert.strictEqual(m.clamp(10), 10); assert.strictEqual(m.clamp(11), 10);' },
  { id: 'B15', py: true, kind: 'python: loop append -> list comprehension', cur: 'def squares(xs):\n    out = []\n    for x in xs:\n        out.append(x * x)\n    return out\n', prop: 'def squares(xs):\n    return [x * x for x in xs]\n',
    t: '    assert squares([1, 2, 3]) == [1, 4, 9]\n    assert squares([]) == []\n' },
  { id: 'B16', py: true, kind: 'python: rename local', cur: 'def area(w, h):\n    a = w * h\n    return a\n', prop: 'def area(w, h):\n    product = w * h\n    return product\n',
    t: '    assert area(2, 3) == 6\n    assert area(0, 3) == 0\n' },
  { id: 'B17', py: true, kind: 'python: str.format -> f-string', cur: 'def label(n, v):\n    return "{}={}".format(n, v)\n', prop: 'def label(n, v):\n    return f"{n}={v}"\n',
    t: '    assert label("a", 1) == "a=1"\n    assert label("", "") == "="\n' },
  { id: 'B18', py: true, kind: 'python: early return instead of else', cur: 'def sign(n):\n    if n < 0:\n        return -1\n    else:\n        return 1\n', prop: 'def sign(n):\n    if n < 0:\n        return -1\n    return 1\n',
    t: '    assert sign(-2) == -1\n    assert sign(0) == 1\n    assert sign(3) == 1\n' }
];

function filesFor(c) {
  if (c.py) {
    const name = /def (\w+)/.exec(c.cur)[1];
    return { file: 'app/mod.py', files: { 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', 'app/mod.py': c.cur, 'tests/test_it.py': `from app.mod import ${name}\n\n\ndef test_it():\n${c.t}` }, pkg: {} };
  }
  const name = /function (\w+)/.exec(c.cur)[1];
  return { file: 'src/mod.js', files: { 'src/mod.js': `'use strict';\n${c.cur}\nmodule.exports = { ${name} };\n`, 'test/a.test.js': nodeTest('../src/mod', `test('${name}', () => { ${c.t} });`) }, pkg: NODE_PKG };
}

(async () => {
  const pick = process.argv.slice(2);
  const quiet = console.log;
  const rows = [];
  for (const c of CASES) {
    if (pick.length && !pick.includes(c.id)) continue;
    if (c.py && !pytestWithCoverageDir()) { quiet(`${c.id} skipped: no pytest with coverage.py`); continue; }
    const { file, files, pkg } = filesFor(c);
    console.log = () => {};
    let r;
    try { r = await e2e({ files, pkg, file, cur: c.cur, prop: c.prop, critic: UNANIMOUS }); } finally { console.log = quiet; }
    const o = r.proposal.test_outcome || {};
    const mut = o.mutation || {};
    const ok = o.status === 'passed' && !!r.commit;
    rows.push({ id: c.id, ok });
    console.log(`${c.id} ${ok ? 'committed' : 'NOT COMMITTED'} status=${o.status}${o.reason ? ` reason=${o.reason}` : ''}${(o.reasons || []).length ? ` reasons=${o.reasons.join('; ').slice(0, 140)}` : ''} hunks=${mut.hunks} mutants=${mut.mutants} run=${mut.run} killed=${mut.killed}  -- ${c.kind}`);
  }
  const bad = rows.filter(r => !r.ok);
  console.log(`executor/gate over-rejection on safe refactors with good suites: ${bad.length}/${rows.length}`);
  if (bad.length) { console.log(`FINDING: ${bad.map(r => r.id).join(', ')} not committed`); process.exit(1); }
  console.log('ok');
})();
