'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { entropy, runCritic } = require('../src/agents/critic');
const { installStub, resetClient } = require('./helpers/stub-client');

test('verbal entropy is bounded in [0,1]', () => {
  const e1 = entropy(['the code is fine', 'looks good to me', 'i approve this']);
  const e2 = entropy(['identical', 'identical', 'identical']);
  assert(e1 >= 0 && e1 <= 1);
  assert(e2 <= e1);
});

test('runCritic queries each persona through the injected client', async (t) => {
  const stub = installStub({ critic: [{ response: { preserves_semantics: true, claude_confidence: 0.8, reasoning: 'ok', edge_cases: [], hallucination_flags: [] } }] });
  t.after(resetClient);
  const v = await runCritic({ proposal: { issue_id: 'x', file: 'a.js', current_code: 'a', proposed_code: 'b' } });
  assert.strictEqual(stub.count('critic'), 3);
  assert.strictEqual(v.panel.length, 3);
  assert.strictEqual(v.claude_confidence, 0.8);
});
