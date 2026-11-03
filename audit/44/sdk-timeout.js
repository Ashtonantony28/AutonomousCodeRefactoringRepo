'use strict';

// AUDIT-44 L1: SG48 builds the SDK client with `maxRetries: 0` and a 300 s
// per-request `timeout` (claude-client.js REQUEST_TIMEOUT_MS). CLAUDE.md's
// SDK rules ("Model & token budgets", "Error handling rules") and README
// name the model, max_tokens 4000 and the one 10 s rate-limit retry, but no
// request timeout: a call that hangs now fails gracefully after 300 s (an
// APIConnectionTimeoutError, no retry), which neither file says.
//   a  the client options (SDK constructor stubbed in require.cache)
//   b  the request shape: model, max_tokens, one user message
//   c  docs name the timeout
// No network: the SDK module is replaced before claude-client loads.
//   node audit/44/sdk-timeout.js

require('../../test/helpers/env');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const seen = { opts: null, reqs: [] };
class Fake {
  constructor(opts) { seen.opts = opts; this.messages = { create: async (req) => { seen.reqs.push(req); return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 2 } }; } }; }
}
const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [ROOT] });
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: { Anthropic: Fake, default: Fake } };
process.env.ANTHROPIC_API_KEY = 'audit-44-dummy';
const { callClaude, DEFAULT_MAX_TOKENS } = require(path.join(ROOT, 'src/utils/claude-client.js'));

let findings = 0;
const row = (ok, label, detail) => { if (!ok) findings++; console.log(`${(ok ? 'ok' : 'FINDING').padEnd(8)} ${label}\n         ${detail}`); };

(async () => {
  await callClaude({ system: `audit-44 ${Date.now()}`, user: 'hi' });
  const o = seen.opts || {};
  row(o.maxRetries === 0 && typeof o.timeout === 'number', 'a client: SDK retries off and a bounded per-request timeout (SG48)', `maxRetries=${o.maxRetries} timeout=${o.timeout}`);
  const q = seen.reqs[0] || {};
  row(q.max_tokens === 4000 && DEFAULT_MAX_TOKENS === 4000 && Array.isArray(q.messages) && q.messages.length === 1 && /^claude-/.test(q.model || ''),
    'b request: model, max_tokens 4000, one stateless user message', `model=${q.model} max_tokens=${q.max_tokens} messages=${(q.messages || []).length}`);
  const docs = ['CLAUDE.md', 'README.md'].map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
  const secs = typeof o.timeout === 'number' ? o.timeout / 1000 : NaN;
  const named = docs.filter(([, t]) => new RegExp(`(?:${secs}\\s*s|${o.timeout}|${secs}-second|${secs / 60}\\s*min)[^\\n]{0,160}(?:request|call|API|Claude)|(?:request|call|API|Claude)[^\\n]{0,160}(?:${secs}\\s*s\\b|${o.timeout}|${secs / 60}\\s*min)`, 'i').test(t)).map(([f]) => f);
  row(named.length > 0, `c L1 the ${secs} s per-request timeout is documented`, named.length ? `named in ${named.join(', ')}` : 'CLAUDE.md and README name no Claude request timeout');
  process.exitCode = findings ? 1 : 0;
})().catch(e => { console.error(e); process.exit(2); });
