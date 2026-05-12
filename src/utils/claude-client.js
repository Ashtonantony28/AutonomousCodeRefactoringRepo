'use strict';

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}

const MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4000;
const RATE_LIMIT_BACKOFF_MS = 10_000;

function getClient() {
  if (!Anthropic) {
    throw new Error('@anthropic-ai/sdk is not installed. Run: npm install');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in the environment');
  }
  const Ctor = Anthropic.Anthropic || Anthropic.default || Anthropic;
  return new Ctor({ apiKey });
}

function isRateLimit(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('429');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callClaude({ system, user, maxTokens = DEFAULT_MAX_TOKENS }) {
  const client = getClient();
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }]
  };

  let attempt = 0;
  while (true) {
    try {
      const resp = await client.messages.create(params);
      const text = (resp.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { text, usage: resp.usage || {}, raw: resp };
    } catch (err) {
      if (attempt === 0 && isRateLimit(err)) {
        attempt += 1;
        await sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
}

function extractJsonBlock(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const trimmed = candidate.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)); } catch { /* */ }
  }
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)); } catch { /* */ }
  }
  return null;
}

module.exports = { callClaude, extractJsonBlock, MODEL, DEFAULT_MAX_TOKENS };
