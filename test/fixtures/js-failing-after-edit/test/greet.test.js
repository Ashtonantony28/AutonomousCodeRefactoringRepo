'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { greet } = require('../src/greet');

test('greet returns the canonical greeting and logs the call', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  assert.strictEqual(greet('ada'), 'hello, ada');
  assert.deepStrictEqual(log.mock.calls.map(c => c.arguments), [['greet', 'ada']]);
});
