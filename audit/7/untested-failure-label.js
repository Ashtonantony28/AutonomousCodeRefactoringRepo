'use strict';

// AUDIT-7 H2: the "untested edit" rule (SG12) lives in test_outcome.reason,
// and the executor sets that reason only on a *green* suite. A red suite that
// never executed the edit (a pre-existing or flaky failure elsewhere) becomes
// `reverted` with no reason, although test_outcome.coverage says
// exercised=false / reason edit_not_exercised. collector.isLabeled then makes
// it a label-0 sample and calibration point, the reward books a false
// positive, and a Reflexion repair is requested for an edit no test ran.
//
//   node audit/7/untested-failure-label.js

const { makeRepo, runWith, proposals, report, exitCode } = require('./lib');
const { loadSamples, isLabeled } = require('../../src/rl/collector');
const calibration = require('../../src/rl/calibration');

(async () => {
  const repo = makeRepo({
    'src/greet.js': "'use strict';\nfunction greet(n) { return 'hello, ' + n; }\nmodule.exports = { greet };\n",
    'src/twice.js': "'use strict';\nfunction twice(x) {\n  const r = x * 2;\n  return r;\n}\nmodule.exports = { twice };\n",
    // twice.js is never loaded by the suite; one unrelated test is already red.
    'test/greet.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { greet } = require('../src/greet');\n" +
      "test('greet', () => assert.strictEqual(greet('a'), 'hello, a'));\ntest('known broken', () => assert.strictEqual(1, 2));\n"
  }, { pkg: { name: 'a7', version: '0.0.0', private: true, scripts: { test: 'node --test test/' } }, gitRepo: true });

  const reflexionCalls = [];
  const { s, stub } = await runWith(repo, proposals([{ file: 'src/twice.js',
    current_code: 'function twice(x) {\n  const r = x * 2;\n  return r;\n}', proposed_code: 'function twice(x) {\n  return x * 2;\n}' }],
  { reflexion: () => { reflexionCalls.push(1); return 'not json'; } }));
  const p = s.proposals[0];
  const o = p.test_outcome;
  const samples = loadSamples(repo).filter(x => x.proposal_id === p.issue_id);
  const pts = calibration.loadPoints(repo).filter(x => x.proposal_id === p.issue_id);
  console.log(`status=${o.status} reason=${o.reason === undefined ? '(none)' : o.reason} coverage=${JSON.stringify(o.coverage && { exercised: o.coverage.exercised, reason: o.coverage.reason, detail: o.coverage.detail })}`);
  console.log(`isLabeled=${isLabeled(o)} samples=${JSON.stringify(samples.map(x => x.label))} calibration_points=${JSON.stringify(pts.map(x => x.y))} reward_fp=${p.reward_breakdown && p.reward_breakdown.fp_penalty} failure_class=${p.failure_class} reflexion_calls=${stub.count('reflexion')}`);

  if (!['reverted', 'passed'].includes(o.status)) { console.log(`setup did not reach the executor (${o.status}: ${JSON.stringify(o.reasons || o.reason)})`); process.exit(2); }
  const untested = o.coverage && o.coverage.exercised === false;
  report('H2 a red suite that never ran the edit is labelled as a failed edit',
    !(untested && isLabeled(o)),
    `${o.status} with coverage.exercised=false: label-0 sample (${samples.length}), calibration point y=0 (${pts.length}), false-positive reward, failure_class=${p.failure_class}, ${stub.count('reflexion')} Reflexion call(s)`,
    'test_outcome carries reason edit_not_exercised (or isLabeled reads coverage.exercised) whenever no test executed the edit, pass or fail; no sample, no calibration point, no repair');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
