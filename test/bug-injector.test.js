'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const bugInjector = require('../src/rl/bug-injector');
const { assertSample } = require('../src/contracts');
const { fakeProposals } = require('./helpers/factories');

test('injects deterministic mutations into passing code', () => {
  const muts = bugInjector.injectInto('function add(a, b) { return a + b; }');
  assert(muts.length > 0);
  assert(muts.every(m => m.mutated && m.mutated.length));
});

test('emits synthetic negatives for passing proposals only', () => {
  const fp = fakeProposals();
  const passed = { ...fp[1], test_outcome: { status: 'passed' }, proposed_code: 'function f(){ return 1; }' };
  const failed = { ...fp[0], test_outcome: { status: 'failed' } };
  const negs = bugInjector.syntheticNegatives(passed, '/abs/repo');
  assert(negs.length > 0);
  assert.strictEqual(bugInjector.syntheticNegatives(failed, '/abs/repo').length, 0);
  for (const s of negs) {
    assertSample(s);
    assert.strictEqual(s.label, 0);
    assert.strictEqual(s.synthetic, true);
  }
});

test('synthetic negative features match the pre-SG0 values', () => {
  const p = { issue_id: 'z', critic_verdict: { claude_confidence: 0.95 }, proposed_code: 'a\nb\nreturn 1;', risk_estimate: 0, test_outcome: { status: 'passed' } };
  const [s] = bugInjector.syntheticNegatives(p, '/abs/repo');
  assert.deepStrictEqual(s.features, [0.99, 0.5, 3, 1, 0.3]);
});
