'use strict';

// Optional probing classifier: a small diagnostic logistic-regression that
// answers "could I have predicted this outcome from the critic's reasoning
// length and edge-case count alone?". Used purely for interpretability —
// never gates the executor.

const { trainGradientDescent, sampleToFeatures } = require('../rl/classifier');

const PROBE_FEATURE_NAMES = ['reasoning_kchars', 'edge_cases', 'hallucination_flags', 'combined_confidence', 'risk_estimate'];

function probeFeatures(proposal) {
  const verdict = proposal.critic_verdict || {};
  return [
    (verdict.reasoning || '').length / 1000,
    (verdict.edge_cases || []).length,
    (verdict.hallucination_flags || []).length,
    proposal.combined_confidence || 0,
    proposal.risk_estimate || 0
  ];
}

function trainProbe(proposals) {
  const labeled = proposals.filter(p => p.test_outcome && ['passed', 'failed', 'reverted'].includes(p.test_outcome.status));
  if (labeled.length < 10) return null;
  const X = labeled.map(probeFeatures);
  const y = labeled.map(p => p.test_outcome.status === 'passed' ? 1 : 0);
  const hasPos = y.includes(1);
  const hasNeg = y.includes(0);
  if (!hasPos || !hasNeg) return null;
  return trainGradientDescent(X, y);
}

module.exports = { trainProbe, probeFeatures, PROBE_FEATURE_NAMES };
