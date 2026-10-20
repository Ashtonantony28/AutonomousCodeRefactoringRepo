'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { computeReward, rollingWarning, rewardBreakdown } = require('../src/rl/reward');
const { fakeProposals } = require('./helpers/factories');

test('reward breakdown includes all terms', () => {
  const b = rewardBreakdown(fakeProposals()[0]);
  assert('log_p' in b && 'fp_penalty' in b && 'stage_bonus' in b && 'coverage_penalty' in b && 'disagreement_penalty' in b);
  assert.strictEqual(typeof b.total, 'number');
});

test('reward formula still penalizes false positives', () => {
  const agreement = { std_confidence: 0, unanimous_approval: true, verbal_entropy: 0 };
  const fp = { combined_confidence: 0.9, test_outcome: { status: 'failed' }, critic_verdict: { agreement } };
  const tp = { combined_confidence: 0.9, test_outcome: { status: 'passed' }, critic_verdict: { agreement } };
  assert(computeReward(fp) < computeReward(tp));
});

test('rollingWarning returns null on small samples', () => {
  assert.strictEqual(rollingWarning(fakeProposals()), null);
});
