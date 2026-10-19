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
