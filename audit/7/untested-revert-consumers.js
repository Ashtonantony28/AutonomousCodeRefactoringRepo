'use strict';

// AUDIT-7 M2: SG12 made `reverted` + reason edit_not_exercised /
// no_coverage_tool mean "no test judged the edit" (collector.isLabeled:
// no sample, no calibration point, no reward, no repair). Every diagnostic
// consumer still reads `reverted` as "the tests failed the edit": the
// dashboard's KPIs, reliability diagram, agreement grid and RL accuracy, the
// probe, failure clustering and classifyFailure. The reliability diagram on
// the dashboard is therefore fitted on a different set than the calibration
// the gate uses.
//
//   node audit/7/untested-revert-consumers.js

require('./lib');
const { isLabeled } = require('../../src/rl/collector');
const calibration = require('../../src/rl/calibration');
const { aggregateStats, reliability, agreementMatrix } = require('../../src/interpretability/dashboard');
const { trainProbe } = require('../../src/interpretability/probe');
const { clusterFailures } = require('../../src/interpretability/clustering');
const { classifyFailure } = require('../../src/interpretability/tracer');
const { summarizeRun } = require('../../src/orchestrator');
const { report, exitCode } = require('./lib');

const mk = (i, status, reason, conf) => ({
  issue_id: `p${i}`, file: `f${i}.js`, current_code: `a${i}`, proposed_code: `b${i} token${i % 3}`, reasoning: '', risk_estimate: 0.2,
  critic_verdict: { p_preserves: conf, panel: [], agreement: { std: 0, unanimous: true, approval_rate: 1, verbal_entropy: 0 }, edge_cases: ['e'], reasoning: 'r'.repeat(i * 40) },
  pattern_check_results: [], diff_test: null, combined_confidence: conf, rl_prediction: 0.9, decision_trace: [],
  test_outcome: Object.assign({ status, stderr_tail: `no test ran token${i}` }, reason ? { reason } : {})
});

// 6 edits no test executed (green suite), 6 passes, 1 real failure.
const props = [];
for (let i = 0; i < 6; i++) props.push(mk(i, 'reverted', i % 2 ? 'edit_not_exercised' : 'no_coverage_tool', 0.9));
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
console.log(`labelled outcomes (isLabeled) = ${labeled}; calibration points = ${cal}`);
console.log(`dashboard: failed=${stats.failed} pass_rate=${stats.pass_rate.toFixed(2)} rl_accuracy=${stats.rl_accuracy} (n=${stats.rl_eval_count}); reliability n=${rel && rel.n}; agreement fp=${agree.fp} tp=${agree.tp}`);
console.log(`probe trained on untested reverts: ${!!probe}; clustered failures=${inClusters}; classifyFailure(untested revert)=${fc}; run summary failed=${sum.failed}`);

report('M2 untested reverts are failures for every diagnostic consumer, excluded from learning',
  stats.failed === 1 && rel.n === cal && agree.fp === 1 && sum.failed === 1 && fc == null,
  `learning sees ${labeled} labelled outcomes; dashboard failed=${stats.failed}, reliability n=${rel.n} (calibration n=${cal}), agreement-grid fp=${agree.fp}, rl_accuracy=${stats.rl_accuracy}, run summary failed=${sum.failed}, classifyFailure=${fc}`,
  'one status -> {label 1, label 0, untested, excluded} mapping (isLabeled) used by collector, calibration, reward, dashboard, probe, clustering, tracer and summarizeRun; untested reverts shown as such');
process.exit(exitCode());
