'use strict';

const fs = require('fs');
const path = require('path');
const { runChecks } = require('./ast-checker');
const diffTesting = require('./diff-testing');
const { assertJuryVerdict, assertCheckResult, assertDiffTest } = require('../contracts');
const { trace } = require('../interpretability/tracer');

// combined = w_c * jury.p_preserves + w_a * pattern_score (+ w_d * diff score)
// Weights are adaptive:
//   - if the diff test is applicable (equivalent|divergent), critic=0.5 / ast=0.3 / diff=0.2
//   - otherwise, critic=0.6 / ast=0.4 (original spec); an unconfirmed edit
//     must also clear unconfirmedBlock() in the gate
// Vetoes (proposal.veto) override the score: see vetoReasons().
// Only contract fields are read: JuryVerdict {panel, p_preserves, agreement},
// DiffTest {applicable, verdict, runs, reason}.
const CRITIC_WEIGHT_DEFAULT  = 0.6;
const PATTERN_WEIGHT_DEFAULT = 0.4;
const CRITIC_WEIGHT_WITH_DT  = 0.5;
const PATTERN_WEIGHT_WITH_DT = 0.3;
const DT_WEIGHT              = 0.2;
const PY_FILE = /\.py$/i;
const DIFF_FILE = /\.(js|cjs|mjs|py)$/i;

function readFileSrc(repoRoot, file) {
  if (!repoRoot || !file) return undefined;
  try { return fs.readFileSync(path.resolve(repoRoot, file), 'utf8'); } catch { return undefined; }
}

function inconclusive(reason, extra = {}) {
  return { applicable: false, verdict: 'inconclusive', runs: 0, reason, duration_ms: 0, ...extra };
}

function diffScore(dt) {
  if (!dt || !dt.applicable) return null;
  return dt.verdict === 'equivalent' ? 1 : dt.verdict === 'divergent' ? 0 : null;
}

function juryVotes(jury) {
  const panel = (jury && Array.isArray(jury.panel)) ? jury.panel : [];
  const approve = panel.filter(v => v.preserves_semantics === true).length;
  return { n: panel.length, approve, majority: approve * 2 > panel.length, unanimous: panel.length > 0 && approve === panel.length };
}

// Without an `equivalent` diff test nothing deterministic confirms the edit, so
// it fails closed: a diff test that exercised the code (runs > 0) but could not
// confirm equivalence blocks, and so does a JS or Python edit (`file`) the diff
// test could not run on (the AST checks only catch their four anti-patterns);
// otherwise (other languages) every persona must approve and every check must
// pass. -> reason string, or null when the edit may proceed.
function unconfirmedBlock({ jury, checks, dt, file = null }) {
  if (dt && dt.applicable && dt.verdict === 'equivalent') return null;
  if (dt && dt.verdict === 'inconclusive' && dt.runs > 0) {
    return `diff test ran ${dt.runs} input(s) but could not confirm equivalence (${dt.reason || 'inconclusive'})`;
  }
  if (file && DIFF_FILE.test(file)) {
    return `diff test ran no input on a ${PY_FILE.test(file) ? 'Python' : 'JS'} edit (${(dt && dt.reason) || 'missing'}); no deterministic check covers it`;
  }
  const votes = juryVotes(jury);
  const failed = (checks || []).filter(c => !c.passed).map(c => c.check_name);
  if (votes.unanimous && !failed.length) return null;
  const why = [];
  if (!votes.unanimous) why.push(`jury ${votes.approve}/${votes.n} approve (need unanimous)`);
  if (failed.length) why.push(`failed checks: ${failed.join(', ')}`);
  return `diff test ${dt ? dt.verdict : 'missing'} (${(dt && dt.reason) || 'not applicable'}); ${why.join('; ')}`;
}

// The Python `condition_change` check is lexical: a reworded comparison
// (`== None` -> `is None`, chained comparisons, if/else -> conditional) looks
// like a lost one. An `equivalent` diff test shows the behaviour is kept, so
// the check then only lowers the score instead of vetoing, unless part of a
// condition was deleted (`deletes_condition`): an equivalent verdict may
// only mean the inputs never reached it (`a < n <= b` -> `a < n`).
function relaxConditionChange(ast, dt) {
  if (!dt || dt.verdict !== 'equivalent') return;
  for (const c of ast.checks) {
    if (c.check_name === 'condition_change' && !c.passed && c.severity === 'veto' && !c.deletes_condition) {
      c.severity = 'score';
      c.detail = `${c.detail} (not a veto: the Python diff test is equivalent)`;
    }
  }
}

function vetoReasons({ jury, checks, dt }) {
  const reasons = [];
  if (dt && dt.verdict === 'divergent') {
    const args = dt.counterexample && dt.counterexample.args !== undefined ? JSON.stringify(dt.counterexample.args) : 'n/a';
    reasons.push(`diff_test_divergent: ${dt.function_name || 'function'} differs on input ${String(args).slice(0, 200)}`);
  }
  for (const c of checks) {
    if (c.severity === 'veto' && !c.passed) reasons.push(`check_veto(${c.check_name}): ${c.detail}`);
  }
  // Malformed verdicts (API error / unparseable) count as rejects: with no usable
  // critic the AST + diff-test terms alone can reach the 0.5 threshold.
  if (jury.panel.length && jury.panel.every(v => v.preserves_semantics === false)) {
    const who = jury.panel.map(v => v.malformed ? `${v.persona}(malformed)` : v.persona).join(', ');
    reasons.push(`unanimous_reject: ${who} say preserves_semantics=false`);
  }
  return reasons;
}

async function runHybridValidator({ proposal, tracker, repoRoot, runCritic, runId }) {
  const traceId = runId || proposal.run_id || undefined;
  const elapsed = (t0) => Number((performance.now() - t0).toFixed(3));
  let t0 = performance.now();
  const jury = await runCritic({ proposal, tracker });
  const criticMs = elapsed(t0);
  assertJuryVerdict(jury);
  proposal.critic_verdict = jury;

  t0 = performance.now();
  const ast = runChecks({ proposal, repoRoot });
  const astMs = elapsed(t0);
  ast.checks.forEach(assertCheckResult);
  proposal.pattern_check_results = ast.checks;

  // Differential testing oracle (JS and Python), evaluated against the whole file.
  let dt;
  t0 = performance.now();
  if (DIFF_FILE.test(proposal.file)) {
    try {
      dt = diffTesting.run({
        currentSrc: proposal.current_code,
        proposedSrc: proposal.proposed_code,
        fileSrc: readFileSrc(repoRoot, proposal.file),
        file: proposal.file
      });
    } catch (err) {
      dt = inconclusive(`diff-test error: ${err.message}`, { duration_ms: elapsed(t0) });
    }
  } else {
    dt = inconclusive('no diff test for this language');
  }
  const dtMs = elapsed(t0);
  assertDiffTest(dt);
  proposal.diff_test = dt;
  if (PY_FILE.test(proposal.file)) relaxConditionChange(ast, dt);

  const pPreserves = jury.p_preserves;
  const patternScore = ast.score;
  let combined;
  let weights;
  const dScore = diffScore(dt);
  if (dScore !== null) {
    combined = CRITIC_WEIGHT_WITH_DT * pPreserves
             + PATTERN_WEIGHT_WITH_DT * patternScore
             + DT_WEIGHT * dScore;
    weights = { critic: CRITIC_WEIGHT_WITH_DT, ast: PATTERN_WEIGHT_WITH_DT, diff_test: DT_WEIGHT };
  } else {
    combined = CRITIC_WEIGHT_DEFAULT * pPreserves + PATTERN_WEIGHT_DEFAULT * patternScore;
    weights = { critic: CRITIC_WEIGHT_DEFAULT, ast: PATTERN_WEIGHT_DEFAULT };
  }
  proposal.combined_confidence = Number(combined.toFixed(4));
  proposal.confidence_weights = weights;

  const reasons = vetoReasons({ jury, checks: ast.checks, dt });
  proposal.veto = reasons.length ? { vetoed: true, reasons } : null;

  const a = jury.agreement;
  trace(proposal, 'critic', {
    reasoning: jury.panel.map(v => `[${v.persona}] ${v.preserves_semantics ? 'preserves' : 'changes'} p=${v.p_preserves.toFixed(2)}: ${v.reasoning}`).join(' '),
    confidence: pPreserves,
    outcome: `p_preserves=${pPreserves.toFixed(3)} approval_rate=${a.approval_rate.toFixed(2)} unanimous=${a.unanimous}`,
    duration_ms: criticMs,
    trace_id: traceId
  });
  trace(proposal, 'ast', {
    reasoning: ast.checks.map(c => `${c.check_name}:${c.passed ? 'pass' : 'fail'}${c.severity === 'veto' ? '(veto)' : ''}`).join(', '),
    confidence: patternScore,
    outcome: `pattern_score=${patternScore.toFixed(3)} lang=${ast.lang || 'unknown'}`,
    duration_ms: astMs,
    trace_id: traceId
  });
  if (DIFF_FILE.test(proposal.file)) {
    trace(proposal, 'ast', {
      reasoning: dt.applicable
        ? `differential testing on ${dt.function_name}/${dt.arity}: ${dt.runs} runs, verdict ${dt.verdict}`
        : `differential testing inconclusive: ${dt.reason || 'n/a'}`,
      confidence: dScore,
      outcome: dt.verdict === 'divergent'
        ? `divergent: ${JSON.stringify(dt.counterexample && dt.counterexample.args)}`
        : dt.verdict,
      duration_ms: dtMs,
      trace_id: traceId
    });
  }

  return { verdict: jury, ast, diff_test: dt, combined: proposal.combined_confidence, veto: proposal.veto };
}

module.exports = {
  runHybridValidator,
  vetoReasons,
  unconfirmedBlock,
  juryVotes,
  diffScore,
  CRITIC_WEIGHT_DEFAULT,
  PATTERN_WEIGHT_DEFAULT,
  CRITIC_WEIGHT_WITH_DT,
  PATTERN_WEIGHT_WITH_DT,
  DT_WEIGHT
};
