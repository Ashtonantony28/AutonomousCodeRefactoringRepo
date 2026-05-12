'use strict';

const VALID_STAGES = new Set(['analyzer', 'critic', 'ast', 'rl', 'executor']);

function trace(proposal, stage, { reasoning = '', confidence = null, outcome = '' } = {}) {
  if (!proposal.decision_trace) proposal.decision_trace = [];
  if (!VALID_STAGES.has(stage)) stage = 'rl';
  proposal.decision_trace.push({
    stage,
    timestamp: new Date().toISOString(),
    reasoning: String(reasoning).slice(0, 2000),
    confidence: confidence == null ? null : Number(confidence),
    outcome: String(outcome)
  });
}

function classifyFailure(proposal) {
  const status = proposal.test_outcome ? proposal.test_outcome.status : null;
  const conf = proposal.combined_confidence || 0;
  const claudeConf = proposal.critic_verdict ? (proposal.critic_verdict.claude_confidence || 0) : 0;
  if (status === 'timeout' || status === 'environment_error' || status === 'apply_failed') {
    return 'environment_issue';
  }
  if (status === 'failed' || status === 'reverted') {
    if (claudeConf > 0.7) return 'logic_error';
    if (typeof proposal.rl_prediction === 'number' && proposal.rl_prediction >= 0.4 &&
        proposal.critic_verdict && (proposal.critic_verdict.edge_cases || []).length > 0) {
      return 'rl_miss';
    }
    if (claudeConf < 0.5) return 'caught_correctly';
    return 'logic_error';
  }
  return null;
}

module.exports = { trace, classifyFailure, VALID_STAGES };
