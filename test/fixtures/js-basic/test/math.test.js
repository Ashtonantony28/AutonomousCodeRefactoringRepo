'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { add, safeParse } = require('../src/math');

test('add sums numbers', () => {
  assert.strictEqual(add(2, 3), 5);
  assert.strictEqual(add(-1, 1), 0);
});

test('safeParse returns null on bad input', () => {
  assert.deepStrictEqual(safeParse('{"a":1}'), { a: 1 });
  assert.strictEqual(safeParse('nope'), null);
});
