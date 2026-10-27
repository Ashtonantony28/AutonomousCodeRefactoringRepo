'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { callClaude } = require('../src/utils/claude-client');
const apiCache = require('../src/utils/api-cache');
const { installStub, resetClient, loadFixtureResponses, keyFor } = require('./helpers/stub-client');

test.afterEach(() => { resetClient(); apiCache.setMode('off'); });

test('keyFor maps cache tags to stub keys', () => {
  assert.strictEqual(keyFor(undefined), 'executor');
  assert.strictEqual(keyFor('critic-strict-retry'), 'critic');
  assert.strictEqual(keyFor('reflexion-2'), 'reflexion');
  assert.strictEqual(keyFor('analyzer-propose-retry'), 'analyzer-propose');
  assert.strictEqual(keyFor('analyzer-files'), 'analyzer-files');
});

test('callClaude routes through the injected client and counts calls', async () => {
  const stub = installStub({ critic: [{ match: 'needle', response: { ok: 1 } }, { response: 'fallback' }], executor: 'plan' });
  const a = await callClaude({ system: 's', user: 'has needle', cacheTag: 'critic-strict' });
  const b = await callClaude({ system: 's', user: 'other', cacheTag: 'critic-security' });
  const c = await callClaude({ system: 's', user: 'u' });
  assert.deepStrictEqual(JSON.parse(a.text), { ok: 1 });
  assert.strictEqual(b.text, 'fallback');
  assert.strictEqual(c.text, 'plan');
  assert.strictEqual(stub.count('critic'), 2);
  assert.strictEqual(stub.count(), 3);
});

test('injected client still goes through the cache wrapper', async () => {
  apiCache.setMode('read-write');
  const stub = installStub({ executor: 'cached' });
  const payload = { system: 'cache-test', user: String(Math.random()) };
  const first = await callClaude(payload);
  const second = await callClaude(payload);
  assert.strictEqual(stub.count(), 1);
  assert.strictEqual(first._cache_hit, false);
  assert.strictEqual(second._cache_hit, true);
  assert.strictEqual(second.text, 'cached');
});

test('missing canned response surfaces as an error', async () => {
  installStub({});
  await assert.rejects(callClaude({ system: 's', user: 'u', cacheTag: 'critic-strict' }), /no canned response/);
});

test('every fixture has proposals and canned responses', () => {
  for (const name of ['js-basic', 'js-failing-after-edit', 'py-basic', 'no-tests']) {
    const r = loadFixtureResponses(name);
    assert(Array.isArray(r['analyzer-propose']) && r['analyzer-propose'].length > 0, name);
    assert(r.critic && r.executor, name);
  }
});

test('callClaude: the SDK client does not retry on its own; a 500 is one request (AUDIT-40 M1)', async (t) => {
  const core = require('@anthropic-ai/sdk/core');
  const fetch = core.APIClient.prototype.fetchWithTimeout, key = process.env.ANTHROPIC_API_KEY;
  const timeouts = [];
  t.after(() => { core.APIClient.prototype.fetchWithTimeout = fetch; if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; });
  process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
  core.APIClient.prototype.fetchWithTimeout = async function (url, init, ms) {
    timeouts.push(ms);
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'x' } }), { status: 500, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
  };
  await assert.rejects(callClaude({ system: 's', user: 'm1' }), (e) => e.status === 500);
  assert.deepStrictEqual(timeouts, [300_000]);
});
