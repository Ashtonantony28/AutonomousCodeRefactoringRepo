'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/contracts');
const { makeProposal } = require('./helpers/factories');

function rejects(fn, re) {
  assert.throws(fn, (e) => e instanceof c.ContractError && re.test(e.message), `expected ContractError matching ${re}`);
}

const verdict = () => ({ persona: 'strict', preserves_semantics: true, p_preserves: 0.9, edge_cases: [], hallucination_flags: [], reasoning: 'ok' });

test('assertProposal accepts a fresh analyzer proposal', () => {
  assert.strictEqual(c.assertProposal(makeProposal('a.js', 'x', 'y')), true);
});

test('assertProposal accepts optional repair fields and a test outcome', () => {
  const p = { ...makeProposal('a.js', 'x', 'y'), parent_issue_id: 'p1', attempt: 1, combined_confidence: 0.7, test_outcome: { status: 'passed' } };
  assert.strictEqual(c.assertProposal(p), true);
});

test('assertProposal reports every violation', () => {
  const p = { ...makeProposal('a.js', 'x', 'y'), risk_estimate: 2, decision_trace: null };
  delete p.diff_test;
  rejects(() => c.assertProposal(p), /risk_estimate.*diff_test.*decision_trace/);
});

test('assertProposal rejects unknown test outcome status', () => {
  rejects(() => c.assertProposal({ ...makeProposal('a.js', 'x', 'y'), test_outcome: { status: 'applied_no_tests' } }), /test_outcome\.status/);
});

test('assertProposal rejects non-object input', () => {
  rejects(() => c.assertProposal(null), /expected object, got null/);
});

test('assertVerdict accepts the target shape', () => {
  assert.strictEqual(c.assertVerdict(verdict()), true);
});

test('assertVerdict rejects legacy claude_confidence-only verdicts', () => {
  const v = verdict();
  delete v.p_preserves;
  v.claude_confidence = 0.9;
  rejects(() => c.assertVerdict(v), /p_preserves/);
});

test('assertVerdict rejects out-of-range p_preserves and non-string edge cases', () => {
  rejects(() => c.assertVerdict({ ...verdict(), p_preserves: 1.5, edge_cases: [1] }), /p_preserves.*edge_cases\[0\]/);
});

test('assertJuryVerdict validates panel and agreement', () => {
  const j = { panel: [verdict(), verdict()], p_preserves: 0.9, agreement: { std: 0, unanimous: true, approval_rate: 1, verbal_entropy: 0.1 } };
  assert.strictEqual(c.assertJuryVerdict(j), true);
  rejects(() => c.assertJuryVerdict({ ...j, panel: [{}] }), /panel\[0\]/);
  rejects(() => c.assertJuryVerdict({ ...j, agreement: { std: 0 } }), /agreement\.unanimous/);
});

test('assertCheckResult requires severity', () => {
  assert.strictEqual(c.assertCheckResult({ check_name: 'parse', passed: true, detail: '', severity: 'veto' }), true);
  rejects(() => c.assertCheckResult({ check_name: 'parse', passed: true, detail: '' }), /severity/);
  rejects(() => c.assertCheckResult({ check_name: 'parse', passed: 'yes', detail: '', severity: 'score' }), /passed/);
});

test('assertDiffTest accepts the target shape', () => {
  assert.strictEqual(c.assertDiffTest({ applicable: true, verdict: 'equivalent', runs: 25, duration_ms: 12 }), true);
  assert.strictEqual(c.assertDiffTest({ applicable: false, verdict: 'inconclusive', runs: 0, reason: 'no fn', duration_ms: 0 }), true);
});

test('assertDiffTest rejects legacy and inconsistent results', () => {
  rejects(() => c.assertDiffTest({ applicable: true, runs: 25, mismatches: 0, score: 1 }), /verdict.*duration_ms/);
  rejects(() => c.assertDiffTest({ applicable: true, verdict: 'divergent', runs: 3, duration_ms: 1 }), /counterexample/);
  rejects(() => c.assertDiffTest({ applicable: false, verdict: 'equivalent', runs: 0, duration_ms: 1 }), /inconclusive/);
});

test('assertSample accepts real and synthetic samples', () => {
  const s = { proposal_id: 'p', target_repo: '/r', features: [0.9, 1, 3, 1, 0.1], label: 1, synthetic: false, timestamp: new Date().toISOString() };
  assert.strictEqual(c.assertSample(s), true);
  assert.strictEqual(c.assertSample({ ...s, label: 0, synthetic: true, mutation: 'drop_return' }), true);
});

test('assertSample rejects wrong feature length, label, and missing mutation', () => {
  const s = { proposal_id: 'p', target_repo: '/r', features: [1, 2], label: true, synthetic: true, timestamp: 'nope' };
  rejects(() => c.assertSample(s), /features: expected length 5.*label.*mutation|features: expected length 5.*label/);
  rejects(() => c.assertSample({ ...s, features: [1, 2, 3, 4, NaN], label: 0 }), /features\[4\]/);
});

test('assertTestOutcome covers the contract statuses', () => {
  for (const status of c.TEST_OUTCOME_STATUSES) assert.strictEqual(c.assertTestOutcome({ status }), true);
  rejects(() => c.assertTestOutcome({ status: 'failed' }), /status/);
});
