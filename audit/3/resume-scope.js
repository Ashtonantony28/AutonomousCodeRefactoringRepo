'use strict';

// AUDIT-3: session.json is one global file while every other piece of run
// state (inflight snapshot, worktrees, RL samples, weights, calibration) is
// per target. Two scenarios:
//
//  A. Any run on target B (even --dry-run, even a mistaken --resume) replaces
//     target A's unfinished session; `--resume` on A then re-analyses from
//     scratch with a new run_id, orphaning A's worktree branch.
//  B. `--dry-run` then `--resume` (the natural "review, then apply" flow)
//     executes nothing: dry_run is a terminal test_outcome.
//
//   node audit/3/resume-scope.js

const { env, gitInit, git, noTestCtx, quiet, report, exitCode } = require('./lib');
const fs = require('fs');
const { runPipeline } = require('../../src/orchestrator');
const { sessionPath } = require('../../src/utils/checkpoint');
const { installStub, resetClient, loadFixtureResponses } = require('../../test/helpers/stub-client');

async function run(repo, fixture, opts) {
  const stub = installStub(loadFixtureResponses(fixture));
  const s = await quiet(() => noTestCtx(() => runPipeline({ repo, cache: 'off', ...opts })));
  resetClient();
  return { s, analyzerCalls: stub.count('analyzer-propose'), criticCalls: stub.count('critic') };
}

(async () => {
  // ---- A: global session clobbered by another target ----
  const A = gitInit(env.copyFixture('js-basic'));
  const B = env.copyFixture('no-tests');
  const a1 = await run(A, 'js-basic', {});
  // Simulate an interrupted run on A: one proposal still unprocessed.
  const sess = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
  sess.proposals[1].test_outcome = null;
  fs.writeFileSync(sessionPath(), JSON.stringify(sess));
  const pendingId = sess.proposals[1].issue_id;
  // Someone does a dry run on another repo (or mistypes --resume --repo B).
  await run(B, 'no-tests', { dryRun: true, resume: true });
  const a2 = await run(A, 'js-basic', { resume: true });
  const branchesA = git(A, 'branch', '--list', 'refactor/*').split('\n').map(s => s.trim()).filter(Boolean);
  console.log(`A first run_id=${a1.s.run_id}; resumed run_id=${a2.s.run_id}; analyzer calls on resume=${a2.analyzerCalls}`);
  console.log(`A refactor branches now: ${branchesA.join(', ')}`);
  report('M-scope-1 one global session.json: a run on another target discards A\'s resumable state',
    a2.s.run_id === a1.s.run_id && a2.analyzerCalls === 0,
    `after a --dry-run --resume on B, "--resume --repo A" started run ${a2.s.run_id.slice(0, 8)} (new), re-ran the Analyzer (${a2.analyzerCalls} call) and left branch refactor/${a1.s.run_id.slice(0, 8)}… orphaned; pending proposal ${pendingId} was never resumed`,
    'session.json under stateDirFor(target) like inflight.json/worktrees/RL state, so --resume on A finds A\'s session');

  // ---- B: --dry-run then --resume executes nothing ----
  const R = gitInit(env.copyFixture('js-basic'));
  const d1 = await run(R, 'js-basic', { dryRun: true });
  const d2 = await run(R, 'js-basic', { resume: true });
  const statuses = d2.s.proposals.map(p => p.test_outcome.status);
  const commits = d2.s.worktree && d2.s.worktree.mode === 'worktree'
    ? git(R, 'rev-list', `main..${d2.s.worktree.branch}`).split('\n').filter(Boolean).length : 0;
  console.log(`dry run statuses: ${d1.s.proposals.map(p => p.test_outcome.status).join(', ')}; resumed non-dry statuses: ${statuses.join(', ')}; commits: ${commits}; critic calls on resume: ${d2.criticCalls}`);
  report('M-scope-2 --resume after --dry-run applies nothing',
    !statuses.includes('dry_run'),
    `non-dry --resume left statuses [${statuses.join(', ')}], ${commits} commits; a worktree/branch was created anyway`,
    'dry_run treated as "validated, not executed" so a non-dry resume executes approved proposals (or the CLI says it will not)');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
