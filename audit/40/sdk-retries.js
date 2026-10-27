'use strict';

// AUDIT-40 M1: CLAUDE.md "Every Claude API call: retry once on rate limit
// (10 s backoff), then fail gracefully". claude-client.getClient builds the
// SDK client with its defaults (maxRetries 2, timeout 10 min), so the SDK
// retries a 429 (and any 408 / 409 / 5xx / connection error) twice on its
// own before callClaude's single 10 s retry, which the SDK retries twice
// again: up to 6 requests per call on a 429, 3 on a 500.
// No network: the SDK's fetchWithTimeout is stubbed (retry-after-ms: 1 keeps
// the SDK's own backoff short); a dummy ANTHROPIC_API_KEY is set. Takes
// about 10 s (callClaude's real backoff).
//   a  control: a 200 is one request
//   b  persistent 429: requests sent (documented: 2, the call and one retry)
//   c  persistent 500: requests sent (documented: 1, no retry on non-rate-limit errors)
//
//   node audit/40/sdk-retries.js

require('../../test/helpers/env');
const L = require('../3/lib');
const core = require('@anthropic-ai/sdk/core');

process.env.ANTHROPIC_API_KEY = 'sk-audit-40-dummy';
let sent = 0, status = 200;
core.APIClient.prototype.fetchWithTimeout = async function () {
  sent++;
  const body = status === 200
    ? JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'x', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    : JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message: 'audit' } });
  return new Response(body, { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
};
const { callClaude } = require('../../src/utils/claude-client');

(async () => {
  const run = async (s) => {
    sent = 0; status = s;
    let err = null;
    const t0 = Date.now();
    try { await callClaude({ system: 's', user: `u${s}` }); } catch (e) { err = e; }
    return { sent, err: err ? `${err.status || ''} ${err.constructor.name}` : null, ms: Date.now() - t0 };
  };
  const a = await run(200);
  const b = await run(429);
  const c = await run(500);
  console.log(`   a: requests=${a.sent} err=${a.err}  b: requests=${b.sent} err=${b.err} ms=${b.ms}  c: requests=${c.sent} err=${c.err}`);
  L.report('a control: a 200 is one request', a.sent === 1 && !a.err, `requests=${a.sent}`, '1');
  L.report('b a persistent 429 is sent more than twice (SDK maxRetries 2 under callClaude\'s one retry)', b.sent === 2, `requests=${b.sent} (${b.ms} ms)`, '2 (one retry after 10 s)');
  L.report('c a persistent 500 is retried by the SDK (CLAUDE.md: fail gracefully, retry only on rate limit)', c.sent === 1, `requests=${c.sent}`, '1');
  process.exit(L.exitCode());
})().catch(err => { console.error(err); process.exit(2); });
