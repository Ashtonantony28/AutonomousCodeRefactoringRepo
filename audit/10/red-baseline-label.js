'use strict';

// AUDIT-10 M3: `reverted` with no reason means "the tests failed this edit"
// to every learning consumer (collector.isLabeled, calibration, reward,
// Reflexion). The executor never runs the suite before the edit, so on a
// target whose suite is already red, every edit the tests execute is
// recorded as a failed edit: a label-0 sample, a y=0 calibration point, a
// false-positive reward and a Reflexion repair (a Claude call), although the
// same failure happens without the edit. (AUDIT-7 H2 fixed the case where
// the red suite never ran the edit; the baseline it suggested was not added.)
//
//   node audit/10/red-baseline-label.js

const { makeRepo, runWith, proposals, report, exitCode } = require('./lib');
const { loadSamples, isLabeled } = require('../../src/rl/collector');
const calibration = require('../../src/rl/calibration');

(async () => {
  const repo = makeRepo({
    'src/twice.js': "'use strict';\nfunction twice(x) {\n  const r = x * 2;\n  return r;\n}\nmodule.exports = { twice };\n",
    // The suite runs the edited function and passes on it; one unrelated test is already red.
    'test/twice.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { twice } = require('../src/twice');\n" +
      "test('twice', () => assert.strictEqual(twice(2), 4));\ntest('known broken (red before any edit)', () => assert.strictEqual(1, 2));\n"
  }, { pkg: { name: 'a10', version: '0.0.0', private: true, scripts: { test: 'node --test test/twice.test.js' } }, gitRepo: true });

  const { s, stub } = await runWith(repo, proposals([{ file: 'src/twice.js',
    current_code: 'function twice(x) {\n  const r = x * 2;\n  return r;\n}', proposed_code: 'function twice(x) {\n  return x * 2;\n}' }]));
  const p = s.proposals.find(q => !q.parent_issue_id);
  const o = p.test_outcome;
  const samples = loadSamples(repo).filter(x => x.proposal_id === p.issue_id && !x.synthetic);
  const pts = calibration.loadPoints(repo).filter(x => x.proposal_id === p.issue_id);
  console.log(`   status=${o.status} reason=${o.reason || '(none)'} coverage=${JSON.stringify(o.coverage)} failed_tests=${o.failed_tests}`);
  console.log(`   isLabeled=${isLabeled(o)} samples=${JSON.stringify(samples.map(x => x.label))} calibration_points=${JSON.stringify(pts.map(x => x.y))} reward_fp=${p.reward_breakdown && p.reward_breakdown.fp_penalty} failure_class=${p.failure_class} reflexion_calls=${stub.count('reflexion')}`);
  if (o.status !== 'reverted') { console.log(`setup did not reach a red suite (${o.status})`); process.exit(2); }
  report('M3 a suite that is red before the edit labels every exercised edit as a failed edit',
    !isLabeled(o),
    `behaviour-preserving edit, the only failing test fails without it too: label-0 sample (${samples.length}), calibration point y=0 (${pts.length}), fp reward ${p.reward_breakdown && p.reward_breakdown.fp_penalty}, ${stub.count('reflexion')} Reflexion call(s)`,
    'a baseline run before the first edit (per run, in the worktree): failures that also occur without the edit are not a label (e.g. reverted reason `baseline_red`, listed in UNTESTED_REASONS) and get no repair');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
