'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const diffTesting = require('../src/validation/diff-testing');

test('finds counterexample when proposed breaks semantics', () => {
  const r = diffTesting.run({
    currentSrc: 'module.exports.double = function double(x) { return x * 2; }',
    proposedSrc: 'module.exports.double = function double(x) { return x + 2; }',
    arity: 1
  });
  assert(r.applicable);
  assert(r.mismatches > 0);
  assert(r.score < 1);
});

test('passes equivalent rewrites', () => {
  const r = diffTesting.run({
    currentSrc: 'module.exports.id = function id(x) { return x; }',
    proposedSrc: 'module.exports.id = function id(x) {\n  return x;\n}',
    arity: 1
  });
  assert(r.applicable);
  assert.strictEqual(r.mismatches, 0);
  assert(r.score >= 0.99);
});
