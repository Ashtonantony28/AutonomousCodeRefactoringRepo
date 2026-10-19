'use strict';

// AUDIT-7 H3: on --resume, a run worktree that cannot be re-attached makes
// resumeWorktree return { mode: 'in-place' } for a target that IS a git repo
// with commits. setupWorkspace overwrites session.worktree with it, so
//  - the executor edits the target's own working tree (CLAUDE.md: "never
//    modified"; in-place is only for non-git / no-commit targets), and
//  - reconcileWithBranch reads the replaced record, finds no branch, and a
//    proposal already committed on refactor/<run_id> is executed again.
// Two ordinary ways to get there: the worktree directory was deleted (state
// dir cleanup without `git worktree prune`), or the run branch was removed.
//
//   node audit/7/resume-worktree-gone.js

const { env, git, gitInit, runWith, report, exitCode } = require('./lib');
const fs = require('fs');
const { sessionPath } = require('../../src/utils/checkpoint');
const { loadFixtureResponses } = require('../../test/helpers/stub-client');

async function scenario(label, breakIt) {
  const repo = gitInit(env.copyFixture('js-basic'));
  const r1 = await runWith(repo, loadFixtureResponses('js-basic'));
  const wt = r1.s.worktree;
  const add = r1.s.proposals.find(p => p.test_outcome.status === 'passed');
  // Crash after the commit, before the outcome was saved (AUDIT-3 M1 window).
  const sess = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  sess.proposals.find(p => p.issue_id === add.issue_id).test_outcome = null;
  fs.writeFileSync(sessionPath(repo), JSON.stringify(sess));
  breakIt(repo, wt);

  const r2 = await runWith(repo, loadFixtureResponses('js-basic'), { resume: true });
  const after = r2.s.proposals.find(p => p.issue_id === add.issue_id);
  const dirty = git(repo, 'status', '--porcelain', '--untracked-files=no');
  console.log(`[${label}] run 1 committed ${add.issue_id} on ${wt.branch}; resumed session.worktree=${JSON.stringify({ mode: r2.s.worktree.mode, reason: r2.s.worktree.reason })}`);
  console.log(`[${label}] resumed outcome: ${after.test_outcome.status} commit=${after.test_outcome.commit || '-'} reason=${after.test_outcome.reason || '-'}; target git status: ${JSON.stringify(dirty)}`);
  report(`H3 [${label}] --resume falls back to editing the git target in place`,
    r2.s.worktree.mode === 'worktree' && dirty === '',
    `session.worktree replaced by mode=${r2.s.worktree.mode} (branch record lost); ${add.issue_id} re-executed -> ${after.test_outcome.status}${after.test_outcome.commit ? '' : ' (no commit)'}; target working tree now ${dirty ? `modified: ${dirty}` : 'clean'}`,
    'resume re-creates the worktree (prune / new branch from the recorded commits) or stops with an error; a git target is never edited in place and the recorded branch is kept for reconciliation');
}

(async () => {
  await scenario('worktree dir deleted', (repo, wt) => fs.rmSync(wt.path, { recursive: true, force: true }));
  await scenario('run branch removed', (repo, wt) => {
    git(repo, 'worktree', 'remove', '--force', wt.path);
    git(repo, 'branch', '-D', wt.branch);
  });
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
