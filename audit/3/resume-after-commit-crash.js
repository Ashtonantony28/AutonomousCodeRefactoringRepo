'use strict';

// AUDIT-3: a crash (SIGKILL / OOM / power loss) after the executor's commit
// but before processProposal's next saveSession leaves session.json saying the
// proposal is unprocessed while the run branch already has its commit.
// `--resume` then re-runs it against the worktree that already contains the
// edit.
//
// The crash is simulated exactly: session.json is copied the moment
// worktree.commitProposal returns (the on-disk state a SIGKILL there leaves;
// the next saveSession is only after reward + up to 3 synthetic-negative diff
// tests), restored, and the run resumed.
//
//   node audit/3/resume-after-commit-crash.js

const { env, gitInit, git, noTestCtx, quiet, report, exitCode } = require('./lib');
const fs = require('fs');
const path = require('path');

const worktree = require('../../src/runner/worktree');
const { sessionPath } = require('../../src/utils/checkpoint');
let snapshot = null;
const realCommit = worktree.commitProposal;
worktree.commitProposal = (info, proposal) => {
  const sha = realCommit(info, proposal);
  if (!snapshot) snapshot = fs.readFileSync(sessionPath(), 'utf8');
  return sha;
};

const { runPipeline } = require('../../src/orchestrator');
const { installStub, resetClient, loadFixtureResponses } = require('../../test/helpers/stub-client');

(async () => {
  const repo = gitInit(env.copyFixture('js-basic'));
  const responses = loadFixtureResponses('js-basic');
  // A repair that would be emitted if the resumed proposal is mis-labelled.
  responses.reflexion = { current_code: 'function add(a, b) {\n  return a + b;\n}', proposed_code: 'function add(a, b) {\n  return b + a;\n}', reasoning: 'repair', risk_estimate: 0.1 };
  const stub = installStub(responses);
  const first = await quiet(() => noTestCtx(() => runPipeline({ repo, cache: 'off' })));
  const branch = first.worktree.branch;
  const commitsBefore = git(repo, 'rev-list', `main..${branch}`).split('\n').filter(Boolean).length;
  const crashed = JSON.parse(snapshot);
  const add = crashed.proposals.find(p => p.file === 'src/math.js' && p.current_code.includes('const result'));
  console.log(`first run: add=${first.proposals.find(p => p.issue_id === add.issue_id).test_outcome.status}, commits on ${branch}: ${commitsBefore}`);
  console.log(`session.json at the moment of the commit: add.test_outcome=${JSON.stringify(add.test_outcome)}`);

  // "Crash": session.json is what was on disk right after the commit.
  fs.writeFileSync(sessionPath(), snapshot);
  const callsBefore = stub.count();
  const resumed = await quiet(() => noTestCtx(() => runPipeline({ repo, resume: true, cache: 'off' })));
  resetClient();
  const after = resumed.proposals.find(p => p.issue_id === add.issue_id);
  const repairs = resumed.proposals.filter(p => p.parent_issue_id === add.issue_id);
  const commitsAfter = git(repo, 'rev-list', `main..${branch}`).split('\n').filter(Boolean).length;
  console.log(`resume: client calls=${stub.count() - callsBefore}, add -> ${after.test_outcome.status} (${(after.test_outcome.reason || '').slice(0, 120)})`);
  console.log(`resume: repairs emitted for add: ${repairs.map(r => `${r.issue_id}:${r.test_outcome && r.test_outcome.status}`).join(', ') || 'none'}; commits on branch: ${commitsAfter}`);
  console.log(`resume: critic verdict for add re-evaluated against ${path.basename(resumed.worktree.path)} (file already edited); trace steps: ${after.decision_trace.length}`);

  report('M-resume-1 crash after commit: resumed session contradicts the branch',
    after.test_outcome.status === 'passed',
    `branch ${branch} holds the commit for ${add.issue_id}, but resumed session records ${after.test_outcome.status}` +
      (repairs.length ? ` and spawned ${repairs.length} repair(s)` : ''),
    'resume detects the committed proposal (e.g. by issue_id in the branch log, which commit messages carry) and records it as passed');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
