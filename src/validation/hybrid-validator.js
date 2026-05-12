'use strict';

const { runChecks } = require('./ast-checker');
const diffTesting = require('./diff-testing');

// Weights are adaptive:
//   - if differential testing is applicable, claude=0.5 / ast=0.3 / diff=0.2
//   - otherwise, claude=0.6 / ast=0.4 (original spec)
const CRITIC_WEIGHT_DEFAULT  = 0.6;
const PATTERN_WEIGHT_DEFAULT = 0.4;
const CRITIC_WEIGHT_WITH_DT  = 0.5;
const PATTERN_WEIGHT_WITH_DT = 0.3;
const DT_WEIGHT              = 0.2;

async function runHybridValidator({ proposal, tracker, repoRoot, runCritic }) {
  const verdict = await runCritic({ proposal, tracker });
  proposal.critic_verdict = verdict;

  const ast = runChecks({ proposal, repoRoot });
  proposal.pattern_check_results = ast.checks;

  // Differential testing oracle (JS only and only when we can isolate a fn).
  let dt = null;
  if (/\.(js|cjs|mjs)$/i.test(proposal.file)) {
    try {
      dt = diffTesting.run({
        currentSrc: proposal.current_code,
        proposedSrc: proposal.proposed_code
      });
      proposal.diff_test = dt;
    } catch (err) {
      proposal.diff_test = { applicable: false, reason: `diff-test error: ${err.message}`, score: 0.5 };
      dt = proposal.diff_test;
    }
  } else {
    proposal.diff_test = { applicable: false, reason: 'non-JS file', score: null };
  }

  const claudeConf = verdict.claude_confidence || 0;
  const patternScore = ast.score;
  let combined;
  let weights;
  if (dt && dt.applicable) {
    combined = CRITIC_WEIGHT_WITH_DT * claudeConf
             + PATTERN_WEIGHT_WITH_DT * patternScore
             + DT_WEIGHT * dt.score;
    weights = { critic: CRITIC_WEIGHT_WITH_DT, ast: PATTERN_WEIGHT_WITH_DT, diff_test: DT_WEIGHT };
  } else {
    combined = CRITIC_WEIGHT_DEFAULT * claudeConf + PATTERN_WEIGHT_DEFAULT * patternScore;
    weights = { critic: CRITIC_WEIGHT_DEFAULT, ast: PATTERN_WEIGHT_DEFAULT };
  }
  proposal.combined_confidence = Number(combined.toFixed(4));
  proposal.confidence_weights = weights;

  if (proposal.decision_trace) {
    proposal.decision_trace.push({
      stage: 'critic',
      timestamp: new Date().toISOString(),
      reasoning: verdict.reasoning,
      confidence: claudeConf,
      outcome: verdict.preserves_semantics ? 'preserves_semantics' : 'semantics_change_or_unsure'
    });
    proposal.decision_trace.push({
      stage: 'ast',
      timestamp: new Date().toISOString(),
      reasoning: ast.checks.map(c => `${c.check_name}:${c.passed ? 'pass' : 'fail'}`).join(', '),
      confidence: patternScore,
      outcome: `pattern_score=${patternScore.toFixed(3)} lang=${ast.lang || 'unknown'}`
    });
    if (dt && dt.applicable) {
      proposal.decision_trace.push({
        stage: 'ast',
        timestamp: new Date().toISOString(),
        reasoning: `differential testing on ${dt.function_name}/${dt.arity}: ${dt.runs} runs, ${dt.mismatches} mismatches`,
        confidence: dt.score,
        outcome: dt.mismatches === 0 ? 'equivalent_under_inputs' : `divergent: ${JSON.stringify(dt.counterexample && dt.counterexample.args)}`
      });
    }
  }

  return { verdict, ast, diff_test: dt, combined: proposal.combined_confidence };
}

module.exports = {
  runHybridValidator,
  CRITIC_WEIGHT_DEFAULT,
  PATTERN_WEIGHT_DEFAULT,
  CRITIC_WEIGHT_WITH_DT,
  PATTERN_WEIGHT_WITH_DT,
  DT_WEIGHT
};
