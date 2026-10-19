'use strict';

const { loadPredictor } = require('./calibration');

const APPROVAL_THRESHOLD = 0.5;
const FALSE_POSITIVE_WEIGHT = 2.0;
const STAGE_SIGNAL_WEIGHT = 0.3;
const COVERAGE_PENALTY_WEIGHT = 0.5;
const DISAGREEMENT_PENALTY_WEIGHT = 1.0;

function calibrated(x) {
  const p = loadPredictor();
  return p.isTrained() ? p.predict(x) : x;
}

function pCorrect(proposal) {
  const raw = Number(proposal.combined_confidence) || 0;
  const conf = calibrated(raw);
  const passed = proposal.test_outcome && proposal.test_outcome.status === 'passed';
  return passed ? conf : 1 - conf;
}

function falsePositive(proposal) {
  const approved = (proposal.combined_confidence || 0) >= APPROVAL_THRESHOLD;
  const failed = proposal.test_outcome &&
    (proposal.test_outcome.status === 'failed' || proposal.test_outcome.status === 'reverted');
  return approved && failed ? 1 : 0;
}

// ORPS-style densification: each cheap intermediate signal contributes a
// fractional reward, so the classifier learns from runs where tests don't
// even fire (e.g., apply_failed) or when partial signals are available.
function stageSignals(proposal) {
  const sig = { syntax_ok: 0, ast_ok: 0, diff_test_ok: 0, applied: 0, tests_ran: 0, tests_passed: 0 };
  // Syntax / AST
  const ast = (proposal.pattern_check_results || []);
  if (ast.length) {
    const parse = ast.find(c => c.check_name === 'parse');
    sig.syntax_ok = parse ? (parse.passed ? 1 : 0) : 1;
    const passed = ast.filter(c => c.passed).length;
    sig.ast_ok = ast.length ? passed / ast.length : 0;
  }
  if (proposal.diff_test && proposal.diff_test.applicable) sig.diff_test_ok = proposal.diff_test.score || 0;
  const status = proposal.test_outcome && proposal.test_outcome.status;
  if (status && status !== 'apply_failed' && status !== 'error') sig.applied = 1;
  if (['passed', 'failed', 'reverted', 'applied_no_tests'].includes(status)) sig.tests_ran = 1;
  if (status === 'passed') sig.tests_passed = 1;
  const sum = Object.values(sig).reduce((a, b) => a + b, 0);
  const max = Object.keys(sig).length;
  return { signals: sig, score: sum / max };
}

function coveragePenalty(proposal) {
  const c = proposal.test_outcome && proposal.test_outcome.coverage;
  if (!c || c.available === false || c.lines_pct == null) return 0;
  return Math.max(0, 1 - c.lines_pct);
}

function disagreementPenalty(proposal) {
  const a = proposal.critic_verdict && proposal.critic_verdict.agreement;
  if (!a) return 0;
  // Higher std + non-unanimous + verbal entropy = more disagreement = more penalty.
  let p = 0;
  const std = typeof a.std === 'number' ? a.std : a.std_confidence;
  if (typeof std === 'number') p += Math.min(1, std * 2);
  if (a.unanimous === false || a.unanimous_approval === false) p += 0.5;
  if (typeof a.verbal_entropy === 'number') p += a.verbal_entropy * 0.3;
  return Math.min(1, p / 2);
}

function computeReward(proposal) {
  const p = pCorrect(proposal);
  const fp = falsePositive(proposal);
  const stage = stageSignals(proposal);
  const cov = coveragePenalty(proposal);
  const dis = disagreementPenalty(proposal);
  const reward =
      Math.log(p + 1e-9)
    - FALSE_POSITIVE_WEIGHT * fp
    + STAGE_SIGNAL_WEIGHT * stage.score
    - COVERAGE_PENALTY_WEIGHT * cov
    - DISAGREEMENT_PENALTY_WEIGHT * dis;
  return reward;
}

// Returns the per-term breakdown for interpretability / dashboard.
function rewardBreakdown(proposal) {
  const p = pCorrect(proposal);
  const fp = falsePositive(proposal);
  const stage = stageSignals(proposal);
  const cov = coveragePenalty(proposal);
  const dis = disagreementPenalty(proposal);
  return {
    p_correct: p,
    log_p: Math.log(p + 1e-9),
    fp_penalty: -FALSE_POSITIVE_WEIGHT * fp,
    stage_bonus: STAGE_SIGNAL_WEIGHT * stage.score,
    stage_signals: stage.signals,
    coverage_penalty: -COVERAGE_PENALTY_WEIGHT * cov,
    disagreement_penalty: -DISAGREEMENT_PENALTY_WEIGHT * dis,
    total: computeReward(proposal)
  };
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
  rewardBreakdown,
  pCorrect,
  falsePositive,
  stageSignals,
  coveragePenalty,
  disagreementPenalty,
  rollingWarning,
  calibrated,
  APPROVAL_THRESHOLD,
  FALSE_POSITIVE_WEIGHT,
  STAGE_SIGNAL_WEIGHT,
  COVERAGE_PENALTY_WEIGHT,
  DISAGREEMENT_PENALTY_WEIGHT
};
