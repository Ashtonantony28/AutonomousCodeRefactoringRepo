'use strict';

// AUDIT-15 H1: a crash after the executor's commit leaves the pre-edit
// snapshot (`inflight.json`) on disk: the executor releases it only after
// `onKept` (the commit) returns. The next start restores that snapshot into
// the run worktree *before* `--resume` reconciles the branch, so the
// committed edit is reverted in the worktree (uncommitted) while the session
// records the proposal as `passed` with that commit. The next passing edit of
// the same file stages the whole file, and its commit silently undoes the
// earlier one: the branch no longer holds an edit the session says it holds.
//
// The crash is real: a child process runs the pipeline and SIGKILLs itself the
// moment worktree.commitProposal returns (the state CLAUDE.md's "crash after
// the commit" resume path is meant for). The parent then runs `--resume`.
// Temp REFACTOR_STATE_DIR (test/helpers/env.js), stub client, no API calls.
//
//   node audit/15/crash-after-commit-inflight.js

const fs = require('fs');
const path = require('path');

if (process.argv[2] === 'child') {
  process.env.REFACTOR_STATE_DIR = process.env.AUDIT15_STATE_DIR;
  process.env.REFACTOR_DASHBOARD_DIR = process.env.AUDIT15_DASHBOARD_DIR;
  delete process.env.NODE_TEST_CONTEXT;
  const worktree = require('../../src/runner/worktree');
  const real = worktree.commitProposal;
  worktree.commitProposal = (info, proposal) => {
    const sha = real(info, proposal);
    if (sha) process.kill(process.pid, 'SIGKILL'); // power loss right after the commit
    return sha;
  };
  const { runPipeline } = require('../../src/orchestrator');
  const { installStub } = require('../../test/helpers/stub-client');
  installStub(JSON.parse(fs.readFileSync(process.env.AUDIT15_RESPONSES, 'utf8')));
  console.log = () => {};
  runPipeline({ repo: process.env.AUDIT15_REPO, cache: 'off' }).then(() => process.exit(3), () => process.exit(4));
  return;
}

const { env, git, gitInit, runWith, proposals, report, exitCode } = require('../10/lib');
const { spawnSync } = require('child_process');
const { inflightPath, sessionPath } = require('../../src/utils/checkpoint');

const ADD = { file: 'src/math.js', current_code: 'function add(a, b) {\n  const result = a + b;\n  return result;\n}', proposed_code: 'function add(a, b) {\n  return a + b;\n}' };
const TWICE = { file: 'src/math.js', current_code: 'function twice(x) {\n  const r = x + x;\n  return r;\n}', proposed_code: 'function twice(x) {\n  return x + x;\n}' };

(async () => {
  const dir = env.copyFixture('js-basic');
  const src = path.join(dir, 'src/math.js');
  fs.writeFileSync(src, fs.readFileSync(src, 'utf8')
    .replace('module.exports = { add, safeParse };', `${TWICE.current_code}\n\nmodule.exports = { add, safeParse, twice };`));
  const t = path.join(dir, 'test/math.test.js');
  fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace('{ add, safeParse }', '{ add, safeParse, twice }') +
    "\ntest('twice doubles', () => {\n  assert.strictEqual(twice(3), 6);\n  assert.strictEqual(twice(-2), -4);\n});\n");
  const repo = gitInit(dir);
  const responses = proposals([ADD, TWICE]);
  const respFile = path.join(env.root, 'audit15-responses.json');
  fs.writeFileSync(respFile, JSON.stringify(responses));

  const child = spawnSync(process.execPath, [__filename, 'child'], {
    encoding: 'utf8',
    env: { ...process.env, AUDIT15_STATE_DIR: env.stateDir, AUDIT15_DASHBOARD_DIR: env.dashboardDir, AUDIT15_REPO: repo, AUDIT15_RESPONSES: respFile },
    timeout: 300000
  });
  const crashed = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  const branch = crashed.worktree && crashed.worktree.branch;
  const inflight = fs.existsSync(inflightPath(repo));
  const c1 = branch ? git(repo, 'rev-parse', branch) : null;
  console.log(`crash: child signal=${child.signal}; branch=${branch} tip=${c1 && c1.slice(0, 8)}; inflight.json present=${inflight}; ` +
    `session outcomes: ${crashed.proposals.map(p => `${p.issue_id.slice(0, 8)}:${p.test_outcome ? p.test_outcome.status : 'null'}`).join(', ')}`);
  if (child.signal !== 'SIGKILL' || !branch) {
    console.log(`setup did not crash after a commit (status=${child.status}); stderr: ${String(child.stderr).slice(-400)}`);
    process.exit(2);
  }
  const addAtCrash = git(repo, 'show', `${branch}:src/math.js`).includes('const result = a + b');

  const { s } = await runWith(repo, responses, { resume: true });
  const wt = s.worktree.path;
  const out = s.proposals.map(p => `${p.issue_id.slice(0, 8)}:${p.test_outcome && p.test_outcome.status}${p.test_outcome && p.test_outcome.commit ? '@' + p.test_outcome.commit.slice(0, 8) : ''}`).join(', ');
  const add = s.proposals.find(p => p.current_code === ADD.current_code);
  const tip = git(repo, 'show', `${branch}:src/math.js`);
  const addOnTip = !tip.includes('const result = a + b');
  const log = git(repo, 'log', '--format=%h %s', `${s.worktree.base}..${branch}`);
  const lastDiff = git(repo, 'diff', `${branch}~1`, branch, '--', 'src/math.js');
  console.log(`branch after crash: add's edit committed=${!addAtCrash}`);
  console.log(`resume: outcomes ${out}`);
  console.log(`resume: commits on ${branch}:\n  ${log.split('\n').join('\n  ')}`);
  console.log(`resume: branch tip src/math.js holds add's edit: ${addOnTip}; last commit re-adds 'const result': ${/^\+\s*const result = a \+ b;/m.test(lastDiff)}`);
  console.log(`resume: worktree status: ${JSON.stringify(git(wt, 'status', '--porcelain', '--untracked-files=no'))}`);

  report('H1 a crash after the commit restores the pre-edit snapshot over a committed edit; the next commit of the file undoes it',
    !(add && add.test_outcome && add.test_outcome.status === 'passed' && !addOnTip),
    `session: add passed@${add && add.test_outcome && String(add.test_outcome.commit).slice(0, 8)} (reconciled), but ${branch} tip no longer holds that edit: ` +
      'restoreFromDisk wrote the pre-edit content into the worktree before reconcile, and the next commit of src/math.js staged that revert',
    'a snapshot whose edit is already committed on the run branch is discarded, not restored (e.g. compare the worktree file with HEAD, or release the snapshot before/atomically with the commit); resume never reverts a committed edit');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
