'use strict';

// AUDIT-7 H1: learning state is de-duplicated by issue_id, and issue_id is
// sha256(file + current_code): it names the snippet, not the edit. Two
// different edits of the same snippet in two runs on the same target share
// one sample slot and one calibration point, and the later run silently
// replaces the earlier label. A failing edit is reverted, so its snippet
// stays and is proposed again by later runs: the labels lost are mostly 0s.
//
//   node audit/7/sample-identity.js

const { env, gitInit, runWith, proposals, report, exitCode } = require('./lib');
const { loadSamples } = require('../../src/rl/collector');
const calibration = require('../../src/rl/calibration');

const CUR = "console.log('greet', name);";

(async () => {
  const repo = gitInit(env.copyFixture('js-failing-after-edit'));

  // Run 1: an edit whose tests fail (the fixture's log-message change).
  const r1 = await runWith(repo, proposals([{ file: 'src/greet.js', current_code: CUR,
    proposed_code: "console.log('greet:', name);" }]));
  const p1 = r1.s.proposals[0];
  const after1 = loadSamples(repo).filter(s => !s.synthetic);
  console.log(`run 1: ${p1.issue_id} -> ${p1.test_outcome.status}; real samples ${JSON.stringify(after1.map(s => [s.proposal_id, s.label]))}; calibration points ${calibration.loadPoints(repo).length}`);

  // Run 2 (new run, same target): a different edit of the same snippet that passes.
  const r2 = await runWith(repo, proposals([{ file: 'src/greet.js', current_code: CUR,
    proposed_code: 'console.log("greet", name);' }]));
  const p2 = r2.s.proposals[0];
  const after2 = loadSamples(repo).filter(s => !s.synthetic);
  const pts = calibration.loadPoints(repo);
  console.log(`run 2: ${p2.issue_id} -> ${p2.test_outcome.status}; real samples ${JSON.stringify(after2.map(s => [s.proposal_id, s.label]))}; calibration points ${JSON.stringify(pts.map(p => [p.proposal_id, p.y]))}`);

  const executed = [p1, p2].filter(p => ['passed', 'reverted'].includes(p.test_outcome.status)).length;
  report('H1 samples and calibration points keyed by issue_id (= snippet) overwrite earlier labels across runs',
    executed === 2 && after2.length === executed && pts.length === executed,
    `two executed proposals with different proposed_code (${p1.test_outcome.status}, ${p2.test_outcome.status}) share issue_id ${p1.issue_id}; ` +
      `rl-samples.json keeps ${after2.length} real sample (label ${after2.map(s => s.label).join(',')}) and calibration-points.json ${pts.length} point; the run-1 label is gone`,
    `${executed} real samples and ${executed} calibration points (CLAUDE.md: samples "accumulate across runs", training "always uses all of them"); key them by the edit (file, current_code, proposed_code) or run_id + issue_id`);
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
