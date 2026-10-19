'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { FEATURE_NAMES, extractFeatures } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

function legacyFeaturesFor(p) {
  const ast = p.pattern_check_results || [];
  const passed = ast.filter(c => c.passed).length;
  const patternScore = ast.length ? passed / ast.length : 0.5;
  const claudeConf = p.critic_verdict ? (p.critic_verdict.claude_confidence || 0) : 0;
  const complexity = Math.max((p.proposed_code || '').split('\n').length, (p.current_code || '').split('\n').length);
  return [claudeConf, patternScore, complexity, 1, p.risk_estimate || 0];
}

test('FEATURE_NAMES keeps the current five features in order', () => {
  assert.deepStrictEqual(FEATURE_NAMES, ['critic_confidence', 'pattern_score', 'proposal_complexity', 'files_changed', 'risk_estimate']);
});

test('extractFeatures matches the pre-SG0 gate features', () => {
  const cases = [
    ...fakeProposals(),
    { current_code: 'a\nb', proposed_code: 'a\nb\nc\nd' },
    { critic_verdict: {}, pattern_check_results: [{ passed: false }], risk_estimate: 0.7, current_code: 'x' }
  ];
  for (const p of cases) assert.deepStrictEqual(extractFeatures(p), legacyFeaturesFor(p));
});

test('extractFeatures returns one finite number per FEATURE_NAME', () => {
  const f = extractFeatures({});
  assert.strictEqual(f.length, FEATURE_NAMES.length);
  assert(f.every(Number.isFinite));
});
