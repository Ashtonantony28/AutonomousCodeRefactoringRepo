'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const apiCache = require('../src/utils/api-cache');

test.afterEach(() => apiCache.setMode('off'));

test('cache dir lives under REFACTOR_STATE_DIR', () => {
  assert.strictEqual(apiCache.CACHE_DIR, path.join(env.stateDir, 'cache'));
});

test('cache wraps live call and rehydrates on second call', async () => {
  apiCache.setMode('read-write');
  let calls = 0;
  const fakePayload = { kind: 'smoke', salt: Math.random() };
  const a = await apiCache.wrap(fakePayload, async () => { calls++; return { text: 'first', usage: {} }; });
  const b = await apiCache.wrap(fakePayload, async () => { calls++; return { text: 'second', usage: {} }; });
  assert.strictEqual(calls, 1);
  assert.strictEqual(a.text, 'first');
  assert.strictEqual(b.text, 'first');
  assert.strictEqual(b._cache_hit, true);
});

test('cache replay mode throws on miss', async () => {
  apiCache.setMode('replay');
  await assert.rejects(
    apiCache.wrap({ kind: 'never-cached', n: Math.random() }, async () => ({})),
    (e) => e.code === 'CACHE_MISS'
  );
});
