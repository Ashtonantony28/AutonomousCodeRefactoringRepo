'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { FEATURE_NAMES, extractFeatures, sameFeatureNames } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

test('FEATURE_NAMES: jury p_preserves first, constant files_changed dropped', () => {
  assert.deepStrictEqual(FEATURE_NAMES, ['p_preserves', 'pattern_score', 'proposal_complexity', 'risk_estimate']);
});

test('extractFeatures reads jury p_preserves, not the claude_confidence alias', () => {
  const base = { pattern_check_results: [{ passed: true }, { passed: false }], current_code: 'a\nb', proposed_code: 'a', risk_estimate: 0.3 };
  assert.deepStrictEqual(extractFeatures({ ...base, critic_verdict: { p_preserves: 0.8, claude_confidence: 0.1 } }), [0.8, 0.5, 2, 0.3]);
  assert.strictEqual(extractFeatures({ ...base, critic_verdict: { claude_confidence: 0.9 } })[0], 0);
  const p = fakeProposals()[1];
  assert.strictEqual(extractFeatures(p)[0], p.critic_verdict.p_preserves);
});

test('extractFeatures returns one finite number per FEATURE_NAME', () => {
  const f = extractFeatures({});
  assert.strictEqual(f.length, FEATURE_NAMES.length);
  assert(f.every(Number.isFinite));
  assert.deepStrictEqual(f, [0, 0.5, 1, 0]);
});

test('sameFeatureNames detects legacy feature lists', () => {
  assert(sameFeatureNames(FEATURE_NAMES.slice()));
  assert(!sameFeatureNames(['critic_confidence', 'pattern_score', 'proposal_complexity', 'files_changed', 'risk_estimate']));
  assert(!sameFeatureNames(undefined));
});
