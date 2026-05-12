'use strict';

const APPROVAL_THRESHOLD = 0.5;
const FALSE_POSITIVE_WEIGHT = 2.0;

function pCorrect(proposal) {
  const conf = Number(proposal.combined_confidence) || 0;
  const passed = proposal.test_outcome && proposal.test_outcome.status === 'passed';
  return passed ? conf : 1 - conf;
}

function falsePositive(proposal) {
  const approved = (proposal.combined_confidence || 0) >= APPROVAL_THRESHOLD;
  const failed = proposal.test_outcome &&
    (proposal.test_outcome.status === 'failed' || proposal.test_outcome.status === 'reverted');
  return approved && failed ? 1 : 0;
}

function computeReward(proposal) {
  const p = pCorrect(proposal);
  const fp = falsePositive(proposal);
  return Math.log(p + 1e-9) - FALSE_POSITIVE_WEIGHT * fp;
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rollingWarning(proposals, window = 10) {
  const rewards = proposals
    .filter(p => typeof p.reward === 'number' && p.test_outcome &&
      ['passed', 'failed', 'reverted'].includes(p.test_outcome.status))
    .map(p => p.reward);
  if (rewards.length < window * 2) return null;
  const recent = rewards.slice(-window);
  const prior = rewards.slice(-window * 2, -window);
  const recentAvg = average(recent);
  const priorAvg = average(prior);
  if (recentAvg < priorAvg) {
    return `rolling reward decreasing: prior_avg=${priorAvg.toFixed(3)} recent_avg=${recentAvg.toFixed(3)}`;
  }
  return null;
}

module.exports = {
  computeReward,
  pCorrect,
  falsePositive,
  rollingWarning,
  APPROVAL_THRESHOLD,
  FALSE_POSITIVE_WEIGHT
};
