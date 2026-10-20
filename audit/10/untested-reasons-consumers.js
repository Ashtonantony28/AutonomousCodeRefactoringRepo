'use strict';

// AUDIT-10 M1 (AUDIT-7 M2, open and wider): SG14/SG16/SG18 added two more
// untested reasons, `tests_insensitive` and `coverage_timeout`, to
// collector.UNTESTED_REASONS. Learning excludes them; every diagnostic
// consumer still reads `reverted` as "the tests failed the edit": dashboard
// KPIs, reliability diagram, agreement grid and rl_accuracy, the probe,
// failure clustering, tracer.classifyFailure and the run summary. Since SG18
// `tests_insensitive` is the common executor outcome for edits whose
// changed tokens no operator mutates (renames, reorders), so the dashboard's
// failure numbers are mostly edits no test judged.
//
//   node audit/10/untested-reasons-consumers.js

require('./lib');
const { isLabeled, UNTESTED_REASONS } = require('../../src/rl/collector');
const calibration = require('../../src/rl/calibration');
const { aggregateStats, reliability, agreementMatrix } = require('../../src/interpretability/dashboard');
const { trainProbe } = require('../../src/interpretability/probe');
const { clusterFailures } = require('../../src/interpretability/clustering');
const { classifyFailure } = require('../../src/interpretability/tracer');
const { summarizeRun } = require('../../src/orchestrator');
const { report, exitCode } = require('./lib');

const mk = (i, status, reason, conf) => ({
  issue_id: `p${i}`, file: `f${i}.js`, current_code: `a${i}`, proposed_code: `b${i} token${i % 3}`, reasoning: '', risk_estimate: 0.2,
  critic_verdict: { p_preserves: conf, panel: [], agreement: { std: 0, unanimous: true, approval_rate: 1, verbal_entropy: 0 }, edge_cases: [], reasoning: 'r'.repeat(i * 40) },
  pattern_check_results: [], diff_test: null, combined_confidence: conf, rl_prediction: 0.9, decision_trace: [],
  test_outcome: Object.assign({ status, stderr_tail: `no mutant failed token${i}` }, reason ? { reason } : {},
    reason === 'tests_insensitive' ? { mutation: { hunks: 1, mutants: 3, run: 3, killed: null, ok: false, surviving_hunk_line: 2 } } : {})
});

// 6 untested reverts with the new reasons, 6 passes, 1 real failure.
const props = [];
for (let i = 0; i < 6; i++) props.push(mk(i, 'reverted', i % 2 ? 'coverage_timeout' : 'tests_insensitive', 0.9));
for (let i = 6; i < 12; i++) props.push(mk(i, 'passed', null, 0.9));
props.push(mk(12, 'reverted', null, 0.9));
const session = { proposals: props };

const labeled = props.filter(p => isLabeled(p.test_outcome)).length;
const cal = calibration.executedPoints(props).length;
const stats = aggregateStats(session);
const rel = reliability(session);
const agree = agreementMatrix(session);
const probe = trainProbe(props);
const clusters = clusterFailures(props);
const inClusters = (clusters.clusters || []).reduce((a, c) => a + c.size, 0);
const fc = classifyFailure(props[0]);
const sum = summarizeRun(session);
console.log(`   UNTESTED_REASONS = ${JSON.stringify(UNTESTED_REASONS)}`);
console.log(`   labelled outcomes (isLabeled) = ${labeled}; calibration points = ${cal}`);
console.log(`   dashboard: failed=${stats.failed} pass_rate=${stats.pass_rate.toFixed(2)} rl_accuracy=${stats.rl_accuracy} (n=${stats.rl_eval_count}); reliability n=${rel && rel.n}; agreement fp=${agree.fp} tp=${agree.tp}`);
console.log(`   probe trained on untested reverts: ${!!probe}; clustered failures=${inClusters}; classifyFailure(tests_insensitive)=${fc}; run summary failed=${sum.failed}`);

report('M1 tests_insensitive / coverage_timeout reverts are failures for every diagnostic consumer, excluded from learning',
  stats.failed === 1 && rel.n === cal && agree.fp === 1 && sum.failed === 1 && fc == null && inClusters <= 1,
  `learning sees ${labeled} labelled outcomes; dashboard failed=${stats.failed}, reliability n=${rel.n} (calibration n=${cal}), agreement-grid fp=${agree.fp}, rl_accuracy=${stats.rl_accuracy}, run summary failed=${sum.failed}, clustered failures=${inClusters}, classifyFailure=${fc}`,
  'one outcome class mapping (label 1 / label 0 / untested / not executed) exported next to isLabeled and used by every consumer; untested reverts shown with their reason');
process.exit(exitCode());
