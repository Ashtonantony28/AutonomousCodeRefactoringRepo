'use strict';

// Gate features. `files_changed` was dropped (always 1); weights persisted
// with a different FEATURE_NAMES list are ignored, not mis-applied.
const FEATURE_NAMES = [
  'p_preserves',
  'pattern_score',
  'proposal_complexity',
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

// Jury mean P(semantics preserved); the legacy `claude_confidence` alias is not read.
function pPreserves(p) {
  const v = p.critic_verdict;
  return v && typeof v.p_preserves === 'number' ? num(v.p_preserves) : 0;
}

function extractFeatures(p) {
  return [pPreserves(p), patternScore(p), proposalComplexity(p), num(p.risk_estimate)];
}

function sameFeatureNames(names) {
  return Array.isArray(names) && names.length === FEATURE_NAMES.length &&
    names.every((n, i) => n === FEATURE_NAMES[i]);
}

module.exports = { FEATURE_NAMES, extractFeatures, patternScore, proposalComplexity, pPreserves, sameFeatureNames };
