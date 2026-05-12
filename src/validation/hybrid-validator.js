'use strict';

const { runChecks } = require('./ast-checker');

const CRITIC_WEIGHT = 0.6;
const PATTERN_WEIGHT = 0.4;

async function runHybridValidator({ proposal, tracker, repoRoot, runCritic }) {
  const verdict = await runCritic({ proposal, tracker });
  proposal.critic_verdict = verdict;

  const ast = runChecks({ proposal, repoRoot });
  proposal.pattern_check_results = ast.checks;

  const claudeConf = verdict.claude_confidence || 0;
  const patternScore = ast.score;
  const combined = CRITIC_WEIGHT * claudeConf + PATTERN_WEIGHT * patternScore;
  proposal.combined_confidence = Number(combined.toFixed(4));

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
      outcome: `pattern_score=${patternScore.toFixed(3)}`
    });
  }

  return { verdict, ast, combined: proposal.combined_confidence };
}

module.exports = { runHybridValidator, CRITIC_WEIGHT, PATTERN_WEIGHT };
