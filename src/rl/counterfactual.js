'use strict';

const { loadClassifier, sampleToFeatures } = require('./classifier');

// Counterfactual feature attribution: for each feature, compute what value
// it would need to take (within the feature's empirical range) to flip the
// RL gate decision. Plus a closed-form linear-coefficient attribution for
// the *current* prediction.
//
// Cheap and exact for logistic regression with linear weights — no MC
// sampling needed. Surfaced on the dashboard as "what-if" sliders.

const FEATURE_NAMES = [
  'critic_confidence',
  'pattern_score',
  'proposal_complexity',
  'files_changed',
  'risk_estimate'
];

function featuresOf(proposal) {
  // Same shape as the orchestrator's featuresFor (kept in lockstep here so
  // the counterfactual matches what the gate actually sees).
  const ast = proposal.pattern_check_results || [];
  const passed = ast.filter(c => c.passed).length;
  const patternScore = ast.length ? passed / ast.length : 0.5;
  const claudeConf = proposal.critic_verdict ? (proposal.critic_verdict.claude_confidence || 0) : 0;
  const complexity = Math.max(
    (proposal.proposed_code || '').split('\n').length,
    (proposal.current_code || '').split('\n').length
  );
  return [claudeConf, patternScore, complexity, 1, proposal.risk_estimate || 0];
}

// Direct contribution = w_j * (x_j - mean_j) / std_j, expressed back in
// the original feature units for readability.
function attribute(proposal) {
  const cls = loadClassifier();
  if (!cls.isTrained() || !cls.weights) {
    return { trained: false, contributions: [], p_pass: null };
  }
  const w = cls.weights;
  const feats = featuresOf(proposal);
  const contributions = FEATURE_NAMES.map((name, j) => {
    const std = w.stds[j] || 1;
    const z = (feats[j] - w.means[j]) / std;
    return {
      feature: name,
      value: feats[j],
      mean: w.means[j],
      contribution_logit: w.w[j] * z,
      weight: w.w[j]
    };
  });
  return {
    trained: true,
    bias_logit: w.b,
    p_pass: cls.predict(feats),
    contributions
  };
}

// Counterfactual: what value would feature j need to flip the decision
// at threshold tau? Closed-form: solve for x_j such that the new logit
// crosses logit(tau).
function counterfactuals(proposal, threshold = 0.4) {
  const cls = loadClassifier();
  if (!cls.isTrained() || !cls.weights) return [];
  const w = cls.weights;
  const feats = featuresOf(proposal);
  // Current logit:
  let z = w.b;
  for (let j = 0; j < w.w.length; j++) z += w.w[j] * ((feats[j] - w.means[j]) / (w.stds[j] || 1));
  const logitTau = Math.log(threshold / (1 - threshold));

  const out = [];
  for (let j = 0; j < w.w.length; j++) {
    const wj = w.w[j];
    const std = w.stds[j] || 1;
    // Holding other features fixed, what z_j flips the decision?
    // logit = z - w_j*current_zj + w_j*new_zj = logitTau
    if (Math.abs(wj) < 1e-9) {
      out.push({ feature: FEATURE_NAMES[j], required_value: null, reason: 'feature weight is ~0' });
      continue;
    }
    const currentZj = (feats[j] - w.means[j]) / std;
    const newZj = currentZj + (logitTau - z) / wj;
    const newVal = newZj * std + w.means[j];
    out.push({
      feature: FEATURE_NAMES[j],
      current_value: feats[j],
      required_value: newVal,
      delta: newVal - feats[j]
    });
  }
  return out;
}

module.exports = { attribute, counterfactuals, featuresOf, FEATURE_NAMES };
