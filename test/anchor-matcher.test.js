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
