'use strict';

// Shared harness for AUDIT-28 repros: the AUDIT-24 helpers (AUDIT-3 lib:
// temp REFACTOR_STATE_DIR via test/helpers/env.js, makeRepo, report) plus an
// executor run whose onKept commits the edited file the way
// worktree.commitProposal does (only that file staged). No API calls; never
// touches src/, test/, state/ or dashboard/.
const A24 = require('../24/lib');
const { runExecutor } = require('../../src/agents/executor');
const { execFileSync } = require('child_process');

const SWITCH = /REFACTOR_MUTANT|_refactor_mutant/;
const gitOut = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// files: the repo before the edit; edit: { file, current_code, proposed_code }.
// -> { o: TestOutcome, repo }
async function execCommit(files, edit, { pkg = A24.PKG } = {}) {
  const repo = A24.makeRepo(files, { pkg, gitRepo: true });
  const proposal = { issue_id: 'audit28', diff_test: A24.EQUIV, reasoning: '', risk_estimate: 0.1, ...edit };
  const onKept = () => {
    gitOut(repo, 'add', '--', edit.file);
    gitOut(repo, '-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', `issue_id: ${proposal.issue_id}`);
    return gitOut(repo, 'rev-parse', 'HEAD').trim();
  };
  const o = await A24.noTestCtx(() => A24.quiet(() => runExecutor({ proposal, repoRoot: repo, onKept })));
  return { o, repo, proposal };
}

const envKeys = () => Object.keys(process.env).filter(k => /^REFACTOR_MUTANT/.test(k));

module.exports = { ...A24, execCommit, gitOut, SWITCH, envKeys };
