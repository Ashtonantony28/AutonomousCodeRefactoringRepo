'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { greet } = require('../src/greet');

test('greet uses the canonical greeting', () => {
  assert.strictEqual(greet('ada'), 'hello, ada');
});
