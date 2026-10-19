'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { entropy, runCritic, normalizeVerdict, aggregateJury, systemPromptFor, PERSONAS } = require('../src/agents/critic');
const { assertVerdict, assertJuryVerdict } = require('../src/contracts');
const { installStub, resetClient } = require('./helpers/stub-client');

const PROPOSAL = { issue_id: 'x', file: 'a.js', current_code: 'a', proposed_code: 'b' };
const base = { edge_cases: [], hallucination_flags: [], reasoning: 'r' };

test('verbal entropy is bounded in [0,1]', () => {
  const e1 = entropy(['the code is fine', 'looks good to me', 'i approve this']);
  const e2 = entropy(['identical', 'identical', 'identical']);
  assert(e1 >= 0 && e1 <= 1);
  assert(e2 <= e1);
});

test('persona prompts ask for p_preserves, not claude_confidence', () => {
  for (const p of Object.values(PERSONAS)) {
    const sys = systemPromptFor(p);
    assert(sys.includes('"p_preserves"'));
    assert(!sys.includes('claude_confidence'));
  }
});

test('normalizeVerdict keeps a new-schema verdict and satisfies the Verdict contract', () => {
  const v = normalizeVerdict({ ...base, preserves_semantics: true, p_preserves: 0.85 }, 'x', 'strict');
  assertVerdict(v);
  assert.strictEqual(v.p_preserves, 0.85);
  assert.strictEqual(v.preserves_semantics, true);
  assert.strictEqual(v.persona, 'strict');
});

test('normalizeVerdict maps legacy claude_confidence by the verdict direction', () => {
  const yes = normalizeVerdict({ ...base, preserves_semantics: true, claude_confidence: 0.8 }, 'x', 'strict');
  const no = normalizeVerdict({ ...base, preserves_semantics: false, claude_confidence: 0.9 }, 'x', 'strict');
  const noLow = normalizeVerdict({ ...base, preserves_semantics: false, claude_confidence: 0.3 }, 'x', 'strict');
  assertVerdict(yes); assertVerdict(no);
  assert.strictEqual(yes.p_preserves, 0.8);
  assert(Math.abs(no.p_preserves - 0.1) < 1e-9, '1 - claude_confidence when preserves_semantics is false');
  assert.strictEqual(noLow.p_preserves, 0.5, 'a reject never contributes more than 0.5');
  assert.strictEqual(yes.legacy_schema, true);
});

test('normalizeVerdict caps p_preserves of a reject at 0.5', () => {
  const v = normalizeVerdict({ ...base, preserves_semantics: false, p_preserves: 0.95 }, 'x', 'strict');
  assert.strictEqual(v.p_preserves, 0.5);
  const s = normalizeVerdict({ ...base, preserves_semantics: 'false', p_preserves: 0.95 }, 'x', 'strict');
  assert.strictEqual(s.preserves_semantics, false, 'string "false" is not truthy approval');
});

test('normalizeVerdict maps malformed output to p_preserves 0', () => {
  for (const raw of [null, 'text', [], { ...base, preserves_semantics: true }, { preserves_semantics: true, p_preserves: 'abc' }]) {
    const v = normalizeVerdict(raw, 'x', 'strict');
    assertVerdict(v);
    assert.strictEqual(v.p_preserves, 0);
    assert.strictEqual(v.preserves_semantics, false);
    assert.strictEqual(v.malformed, true);
  }
});

test('runCritic queries each persona and returns a JuryVerdict with the panel mean', async (t) => {
  const byPersona = { strict: 0.6, permissive: 0.9, security: 0.3 };
  const stub = installStub({
    critic: ({ cacheTag }) => {
      const persona = cacheTag.replace('critic-', '');
      const p = byPersona[persona];
      return { ...base, preserves_semantics: p > 0.5, p_preserves: p, reasoning: persona, edge_cases: [`e-${persona}`] };
    }
  });
  t.after(resetClient);
  const j = await runCritic({ proposal: PROPOSAL });
  assertJuryVerdict(j);
  assert.strictEqual(stub.count('critic'), 3);
  assert.strictEqual(j.panel.length, 3);
  assert.strictEqual(j.p_preserves, 0.6);
  assert.strictEqual(j.claude_confidence, j.p_preserves, 'legacy alias');
  assert.strictEqual(j.preserves_semantics, true, 'majority vote (2 of 3)');
  assert.strictEqual(j.agreement.unanimous, false);
  assert(Math.abs(j.agreement.approval_rate - 2 / 3) < 1e-9);
  assert(j.agreement.std > 0);
  assert.deepStrictEqual(j.edge_cases.sort(), ['e-permissive', 'e-security', 'e-strict']);
});

test('runCritic maps legacy single-schema stub output', async (t) => {
  installStub({ critic: [{ response: { ...base, preserves_semantics: true, claude_confidence: 0.8 } }] });
  t.after(resetClient);
  const j = await runCritic({ proposal: PROPOSAL });
  assertJuryVerdict(j);
  assert.strictEqual(j.p_preserves, 0.8);
  assert.strictEqual(j.claude_confidence, 0.8);
  assert.strictEqual(j.agreement.unanimous, true);
});

test('runCritic turns a client error into a malformed verdict with p_preserves 0', async (t) => {
  installStub({ critic: () => { throw new Error('boom'); } });
  t.after(resetClient);
  const j = await runCritic({ proposal: PROPOSAL, panel: ['strict'] });
  assertJuryVerdict(j);
  assert.strictEqual(j.p_preserves, 0);
  assert.strictEqual(j.panel[0].malformed, true);
  assert.match(j.panel[0].reasoning, /boom/);
});

test('aggregateJury: a tie is not a majority', () => {
  const j = aggregateJury([
    normalizeVerdict({ ...base, preserves_semantics: true, p_preserves: 0.9 }, 'x', 'strict'),
    normalizeVerdict({ ...base, preserves_semantics: false, p_preserves: 0.2 }, 'x', 'permissive')
  ], 'x');
  assertJuryVerdict(j);
  assert.strictEqual(j.preserves_semantics, false);
  assert.strictEqual(j.p_preserves, 0.55);
});
