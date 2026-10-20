'use strict';

// AUDIT-3: TestOutcome.status vocabulary vs its consumers.
//  1. Static: every status-like string literal compared against a `.status`
//     (or listed next to one) in src/, vs contracts.TEST_OUTCOME_STATUSES.
//  2. Dynamic: how each consumer treats each contract status (label, reward,
//     calibration, dashboard, run summary, clustering, failure class, repair).
//
//   node audit/3/status-vocabulary.js

require('./lib');
const fs = require('fs');
const path = require('path');
const { TEST_OUTCOME_STATUSES } = require('../../src/contracts');
const { LABELED_STATUSES, buildSample } = require('../../src/rl/collector');
const reward = require('../../src/rl/reward');
const calibration = require('../../src/rl/calibration');
const { summarizeRun } = require('../../src/orchestrator');
const { clusterFailures } = require('../../src/interpretability/clustering');
const { classifyFailure } = require('../../src/interpretability/tracer');
const { renderHtml } = require('../../src/interpretability/dashboard');
const { report, exitCode } = require('./lib');

// ---- 1. static scan ----
const SRC = path.resolve(__dirname, '../../src');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else if (a.endsWith('.js')) files.push(a); } })(SRC);
const KNOWN_NON_OUTCOME = new Set(['no_test_runner', 'pending']); // test-runner internal / dashboard placeholder
const uses = new Map();
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/status/.test(line)) return;
    for (const m of line.matchAll(/'([a-z_]+)'/g)) {
      const s = m[1];
      if (!/^(passed|failed|reverted|timeout|environment_error|apply_failed|critic_rejected|vetoed|rl_rejected|dry_run|skipped_no_tests|error|applied_no_tests|no_test_runner|pending)$/.test(s)) continue;
      if (!uses.has(s)) uses.set(s, []);
      uses.get(s).push(`${path.relative(path.resolve(__dirname, '../..'), f)}:${i + 1}`);
    }
  });
}
console.log('Status literals next to `.status` in src/ that are NOT contract statuses:');
for (const [s, where] of uses) {
  if (TEST_OUTCOME_STATUSES.includes(s) || KNOWN_NON_OUTCOME.has(s)) continue;
  console.log(`  '${s}' x${where.length}: ${where.join(' ')}`);
}
const unusedInSrc = TEST_OUTCOME_STATUSES.filter(s => !uses.has(s));
console.log(`Contract statuses never named next to .status in src/: ${unusedInSrc.join(', ') || '(none)'}`);

// ---- 2. consumer treatment table ----
const mk = (status) => ({
  issue_id: `id-${status}`, file: 'a.js', current_code: 'x', proposed_code: 'y', reasoning: '', risk_estimate: 0.2,
  critic_verdict: { p_preserves: 0.9, panel: [], agreement: { std: 0, unanimous: true, approval_rate: 1, verbal_entropy: 0 }, reasoning: 'r' },
  pattern_check_results: [], diff_test: null, combined_confidence: 0.8, decision_trace: [],
  test_outcome: { status, stderr_tail: 'boom failure' }
});
function rowClassOf(status) {
  const html = renderHtml({ proposals: [mk(status)] });
  const m = html.match(/<tr class="(row-[a-z]+)" data-toggle/);
  return m ? m[1] : '?';
}
function hasCss(status) { return renderHtml({ proposals: [] }).includes(`.status-${status}`); }
function summaryBucket(status) {
  const out = summarizeRun({ proposals: [mk(status)] });
  const k = Object.keys(out).find(key => key !== 'total' && out[key] === 1);
  return k || '(not counted)';
}
const rows = [];
for (const s of TEST_OUTCOME_STATUSES) {
  const p = mk(s);
  rows.push({
    status: s,
    sample_label: LABELED_STATUSES.includes(s) ? buildSample(p).label : '-',
    calib_point: calibration.executedPoints([p]).length ? 'y' : '-',
    reward_pcorrect: reward.pCorrect(p).toFixed(2),
    reward_fp: reward.falsePositive(p),
    tests_ran: reward.stageSignals(p).signals.tests_ran,
    cluster: clusterFailures([p, { ...p, issue_id: 'b' }, { ...p, issue_id: 'c' }, { ...p, issue_id: 'd' }]).clusters.length ? 'fail' : '-',
    failure_class: classifyFailure(p) || '-',
    dash_row: rowClassOf(s),
    dash_css: hasCss(s) ? 'y' : 'MISSING',
    run_summary: summaryBucket(s)
  });
}
console.log('\nHow each consumer treats each contract status (combined_confidence=0.8):');
console.table(rows);

// ---- findings ----
const timeout = rows.find(r => r.status === 'timeout');
report('M-status-1 timeout: no label/calibration point, but reward scores it as a failed prediction, clustering and dashboard call it a failure',
  timeout.sample_label !== '-' || timeout.reward_pcorrect === '0.80',
  `sample_label=${timeout.sample_label} calib_point=${timeout.calib_point} reward p_correct=${timeout.reward_pcorrect} (1-c) fp=${timeout.reward_fp} tests_ran=${timeout.tests_ran} cluster=${timeout.cluster} dashboard=${timeout.dash_row}`,
  'one documented mapping status -> {label | excluded} used by collector, calibration, reward and dashboard');
const dead = ['failed', 'applied_no_tests'].filter(s => uses.has(s));
report('L-status-2 dead statuses still matched in src',
  dead.length === 0,
  dead.map(s => `'${s}' at ${uses.get(s).length} sites`).join('; '),
  'only TEST_OUTCOME_STATUSES (executor maps failed -> reverted; applied_no_tests was replaced by skipped_no_tests)');
const notCounted = rows.filter(r => r.run_summary === '(not counted)').map(r => r.status);
report('L-status-3 run summary line silently drops statuses',
  notCounted.length === 0, `not counted: ${notCounted.join(', ')}`, 'every contract status counted in the "done." line');
const noCss = rows.filter(r => r.dash_css === 'MISSING').map(r => r.status);
const other = rows.filter(r => r.dash_row === 'row-other').map(r => r.status);
report('L-status-4 dashboard has no style for some contract statuses',
  noCss.length === 0, `no .status-* css: ${noCss.join(', ')}; row-other: ${other.join(', ')}`, 'a class for every contract status');
process.exit(exitCode());
