'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const anchor = require('../src/runner/anchor-matcher');

test('exact match returns tier=exact', () => {
  const r = anchor.findAnchor('a\nfunction f(){return 1}\nb', 'function f(){return 1}');
  assert.strictEqual(r.tier, 'exact');
});

test('whitespace-normalized match works across reflowed code', () => {
  const r = anchor.findAnchor('function f() {\n  return 1;\n}', 'function f() { return 1; }');
  assert.strictEqual(r.tier, 'whitespace');
});

test('indent-shift match across re-indented snippet', () => {
  const target = '    function f() {\n      return 1;\n    }';
  const needle = 'function f() {\n  return 1;\n}';
  const r = anchor.findAnchor(target, needle);
  assert(['indent-shift', 'fuzzy', 'whitespace'].includes(r.tier));
});

test('fuzzy match accepts near-identical lines', () => {
  const target = 'function f(x) {\n  return x*2;\n}\n';
  const needle = 'function f(x) {\n  return x * 2;\n}\n';
  const r = anchor.findAnchor(target, needle);
  assert(['whitespace', 'fuzzy'].includes(r.tier));
});

test('throws AnchorError when nothing matches', () => {
  assert.throws(() => anchor.findAnchor('abc', 'wholly different content'), anchor.AnchorError);
});

test('fuzzy rejects a token-different anchor (< vs >) with detail.closest', () => {
  const file = 'function g(a, b, x) {\n  if (a < b) { return x; }\n  return 0;\n}\n';
  let err;
  try { anchor.findAnchor(file, 'if (a > b) { return x; }'); } catch (e) { err = e; }
  assert(err instanceof anchor.AnchorError, 'expected AnchorError');
  assert.strictEqual(err.tier, 'fuzzy');
  const c = err.detail.closest;
  assert.strictEqual(file.slice(c.start, c.end), '  if (a < b) { return x; }');
  assert(c.score >= 0.85 && c.score < 1);
});

test('254-char lines sharing a 253-char prefix: anchor differing at last char is ambiguous', () => {
  const prefix = 'const v = ' + 'a'.repeat(243);
  assert.strictEqual(prefix.length, 253);
  const file = `${prefix}1\n${prefix}2\n`;
  assert.throws(() => anchor.findAnchor(file, `${prefix}3`), (e) => e instanceof anchor.AnchorError && /ambiguous/.test(e.message) && Boolean(e.detail.runner_up));
});

test('levenshtein is not truncated and bounded mode caps at maxDist+1', () => {
  const a = 'x'.repeat(300) + 'a';
  const b = 'x'.repeat(300) + 'b';
  assert.strictEqual(anchor.levenshtein(a, b), 1);
  assert.strictEqual(anchor.levenshtein(a, b, 5), 1);
  assert.strictEqual(anchor.levenshtein('abcdef', 'uvwxyz', 2), 3);
  assert.strictEqual(anchor.levenshtein('kitten', 'sitting'), 3);
  assert(anchor.similarity(a, b) < 1);
});

test('tokenizer keeps multi-char operators and string literals whole', () => {
  assert.deepStrictEqual(anchor.tokenize('a >= "x  y"'), ['a', '>=', '"x  y"']);
  assert.strictEqual(anchor.tokensEqual('a>=b', 'a >= b'), true);
  assert.strictEqual(anchor.tokensEqual('a >= b', 'a > = b'), false);
  assert.strictEqual(anchor.tokensEqual('s = "a b"', 's = "a  b"'), false);
});

test('fuzzy accepts a token-identical window and reports tier=fuzzy', () => {
  const file = 'function f(x) {\n  return x*2;\n}\nmodule.exports = f;\n';
  const r = anchor.findAnchor(file, 'function f(x) {\n  return x * 2;\n}\n');
  assert.strictEqual(r.tier, 'fuzzy');
  assert.strictEqual(file.slice(r.start, r.end), 'function f(x) {\n  return x*2;\n}');
});

test('indent-shift rejects when the anchor matches at two different indentations', () => {
  const file = 'if (a) {\n  foo();\n  bar();\n}\nif (b) {\n    foo();\n    bar();\n}\n';
  assert.throws(() => anchor.findAnchor(file, 'foo();\nbar();'), (e) => e instanceof anchor.AnchorError && e.tier === 'indent-shift' && /ambiguous/.test(e.message));
});

test('indent-shift matches tab-indented code by leading-whitespace string', () => {
  const file = 'class A {\n\tm() {\n\t\tif (x) {\n\t\t\ty();\n\t\t}\n\t}\n}\n';
  const r = anchor.findAnchor(file, '\tif (x) {\n\t\ty();\n\t}');
  assert.strictEqual(r.tier, 'indent-shift');
  assert.strictEqual(r.indent, '\t\t');
  assert.strictEqual(r.anchorIndent, '\t');
  assert.strictEqual(file.slice(r.start, r.end), '\t\tif (x) {\n\t\t\ty();\n\t\t}');
});

test('exact tier counts overlapping occurrences as ambiguous', () => {
  assert.throws(() => anchor.findAnchor('ab ab ab', 'ab ab'), /ambiguous/);
});

test('fuzzy over a 200 KB file finds the unique token-identical window', () => {
  let file = '';
  for (let i = 0; file.length < 200 * 1024; i++) {
    file += `function fn_${i}(a, b) {\n  const r${i} = a * ${i} + b;\n  return r${i};\n}\n`;
  }
  const r = anchor.findAnchor(file, 'function fn_2000(a, b) {\n  const r2000 = a*2000 + b;\n  return r2000;\n}');
  assert.strictEqual(r.tier, 'fuzzy');
  assert.strictEqual(file.slice(r.start, r.end), 'function fn_2000(a, b) {\n  const r2000 = a * 2000 + b;\n  return r2000;\n}');
});

// ---- SG10: whitespace/fuzzy tiers only accept regions that behave like the anchor

function refusal(fn) {
  try { fn(); } catch (e) { return e; }
  return assert.fail('expected the match to be refused');
}

test('whitespace tier: two reflowed copies of the anchor are ambiguous, never the first copy', () => {
  const file = 'function f() {\n  return 1;\n}\nfunction g() {}\nfunction f() {\n    return 1;\n}\n';
  const e = refusal(() => anchor.findAnchor(file, 'function f() { return 1; }'));
  assert(e instanceof anchor.AnchorError);
  assert.strictEqual(e.tier, 'whitespace');
  assert.match(e.message, /2 locations \(whitespace-norm\); ambiguous/);
  assert.strictEqual(e.detail.occurrences, 2);
});

test('whitespace tier refuses whitespace changes inside string, template and regex literals', () => {
  for (const [file, needle] of [
    ["function b(n) {\n  return 'Total:    ' + n;\n}", "function b(n) {\n  return 'Total: ' + n;\n}"],
    ['const s = `a\n    b`;', 'const s = `a b`;'],
    ['const r = /a  b/;\nr.test(x);', 'const r = /a b/; r.test(x);']
  ]) {
    const e = refusal(() => anchor.findAnchor(file, needle));
    assert.strictEqual(e.tier, 'whitespace', needle);
    assert.strictEqual(e.detail.reason, 'literal_whitespace', needle);
  }
});

test('whitespace tier refuses a line break that changes ASI, accepts one that does not', () => {
  const e = refusal(() => anchor.findAnchor('function total(a, b) {\n  return\n    a + b;\n}\n', 'function total(a, b) {\n  return a + b;\n}'));
  assert.strictEqual(e.detail.reason, 'asi_boundary');
  assert.strictEqual(refusal(() => anchor.findAnchor('a = b\n++c;\n', 'a = b ++c;')).detail.reason, 'asi_boundary');
  assert.strictEqual(anchor.findAnchor('function f() {\n  return 1 +\n    2;\n}', 'function f() { return 1 + 2; }').tier, 'whitespace');
});

test('whitespace tier refuses a line comment that would swallow code', () => {
  const e = refusal(() => anchor.findAnchor('x(); // note y();\nz();', 'x(); // note\ny();\nz();'));
  assert.strictEqual(e.detail.reason, 'comment_boundary');
});

test('whitespace tier refuses a Python match that changes block structure, keeps a consistent re-indent', () => {
  const file = 'def stats(xs):\n    total = 0\n    count = 0\n    for x in xs:\n        total += x\n        count += 1\n    return total, count\n';
  const e = refusal(() => anchor.findAnchor(file, '    for x in xs:\n        total += x\n    count += 1', { lang: 'python' }));
  assert.strictEqual(e.tier, 'whitespace');
  assert.strictEqual(e.detail.reason, 'indentation');
  const ok = anchor.findAnchor('class A:\n    def f(self):\n        if x:\n            y()\n        z()\n', 'def f(self):\n  if x:\n    y()\n  z()', { lang: 'python' });
  assert.strictEqual(ok.tier, 'whitespace');
});

test('other languages refuse a moved line break', () => {
  const e = refusal(() => anchor.findAnchor('func f() int {\n\treturn\n\t\tg()\n}\n', 'func f() int { return g() }', { lang: 'generic' }));
  assert.strictEqual(e.detail.reason, 'line_structure');
  assert.strictEqual(anchor.langOf('a/b.go'), 'generic');
  assert.strictEqual(anchor.langOf('a/b.py'), 'python');
  assert.strictEqual(anchor.langOf('a/b.tsx'), 'js');
});

test('fuzzy tier refuses a token-identical window that moves a line break after return', () => {
  const e = refusal(() => anchor.findAnchor('function f(x) { return\n  x*2;\n}\nmodule.exports = f;\n', 'function f(x) {\n  return x * 2;\n}'));
  assert.strictEqual(e.tier, 'fuzzy');
  assert.strictEqual(e.detail.reason, 'asi_boundary');
});

function nearDupFile(size, blockLines) {
  const block = (i) => {
    let b = `function g${i}(a, b) {\n`;
    for (let k = 0; k < blockLines - 2; k++) b += `  const v${k} = a + b * ${k} - ${i % 10};\n`;
    return b + '}\n';
  };
  let src = '';
  for (let i = 0; src.length + block(i).length <= size; i++) src += block(i);
  return { src, block };
}

test('fuzzy tier is bounded: near-duplicate 200-line blocks in 199 KB decide well under 1 s', () => {
  const { src, block } = nearDupFile(199000, 200);
  const needle = block(30).replace('const v0 = a + b', 'const v0 = a - b').replace(/\n {2}/g, '\n    ');
  const t0 = performance.now();
  const e = refusal(() => anchor.findAnchor(src, needle));
  const ms = performance.now() - t0;
  assert.strictEqual(e.tier, 'fuzzy');
  assert(ms < 500, `fuzzy tier took ${ms.toFixed(0)} ms`);
});

test('fuzzy tier stops at its work cap: apply_failed reason fuzzy_budget', () => {
  const { src } = nearDupFile(30000, 20);
  const half = src.slice(0, Math.floor(src.length / 2));
  const needle = half.slice(0, half.lastIndexOf('\n}\n') + 2).replace(/\n {2}/g, '\n\t').replace('a + b * 3', 'a + b * 4');
  assert.strictEqual(anchor.fuzzyMatch(src, needle, { maxCells: 1000 }).budget, true);
  const e = refusal(() => anchor.findAnchor(src, needle));
  assert.strictEqual(e.tier, 'fuzzy');
  assert.strictEqual(e.detail.reason, 'fuzzy_budget');
  assert.match(e.message, /^fuzzy_budget: /);
});

test('exact tier stops counting overlapping occurrences at a cap', () => {
  const e = refusal(() => anchor.findAnchor('a'.repeat(199000), 'a'.repeat(1000)));
  assert.match(e.message, /100\+ locations \(exact\)/);
});
