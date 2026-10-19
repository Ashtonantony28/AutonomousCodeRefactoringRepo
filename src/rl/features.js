'use strict';

const FEATURE_NAMES = [
  'critic_confidence',
  'pattern_score',
  'proposal_complexity',
  'files_changed',
  'risk_estimate'
];

function num(x) { return Number(x) || 0; }

function patternScore(p) {
  const ast = p.pattern_check_results || [];
  const passed = ast.filter(c => c.passed).length;
  return ast.length ? passed / ast.length : 0.5;
}

function proposalComplexity(p) {
  return Math.max(
    (p.proposed_code || '').split('\n').length,
    (p.current_code || '').split('\n').length
  );
}

function extractFeatures(p) {
  const claudeConf = p.critic_verdict ? p.critic_verdict.claude_confidence : 0;
  return [num(claudeConf), patternScore(p), proposalComplexity(p), 1, num(p.risk_estimate)];
}

module.exports = { FEATURE_NAMES, extractFeatures, patternScore, proposalComplexity };
