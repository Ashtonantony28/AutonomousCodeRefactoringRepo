'use strict';

// AUDIT-15: CLI exit codes for "no worktree can be created" (README: "If no
// worktree can be created the run stops (exit 2)"; CLAUDE.md: EWORKTREE, exit 2).
//  a) both `git worktree add` attempts fail (.git/worktrees is a file):
//     expect exit 2, EWORKTREE, target untouched.            (SG21 recheck)
//  b) the per-target worktrees dir cannot be created (a file sits at
//     <state>/targets/<sha>/worktrees): the mkdir runs outside the add loop,
//     so the run dies with a raw EEXIST stack trace and exit 1.   (L3)
// The CLI is spawned with a temp REFACTOR_STATE_DIR (test/helpers/env.js); it
// stops before the Analyzer, so no Claude call is made.
//
//   node audit/15/cli-exit-codes.js

const { env, git, gitInit, report, exitCode } = require('../10/lib');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { worktreesDir } = require('../../src/utils/checkpoint');

const CLI = path.join(__dirname, '..', '..', 'src', 'orchestrator.js');
function cli(repo) {
  return spawnSync(process.execPath, [CLI, '--repo', repo, '--cache', 'off'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ANTHROPIC_API_KEY: '', NODE_TEST_CONTEXT: '' }
  });
}

{
  const repo = gitInit(env.copyFixture('js-basic'));
  fs.writeFileSync(path.join(repo, '.git', 'worktrees'), 'not a directory\n');
  const before = fs.readFileSync(path.join(repo, 'src/math.js'), 'utf8');
  const r = cli(repo);
  const out = r.stdout + r.stderr;
  const clean = git(repo, 'status', '--porcelain', '--untracked-files=no') === '' && fs.readFileSync(path.join(repo, 'src/math.js'), 'utf8') === before;
  console.log(`a) exit=${r.status}; mentions EWORKTREE text: ${/not edited in place/.test(out)}; target clean: ${clean}`);
  report('a) both worktree adds fail -> exit 2, target untouched', r.status === 2 && clean,
    `exit=${r.status}, target clean=${clean}`, 'exit 2 (EWORKTREE), target untouched');
}

{
  const repo = gitInit(env.copyFixture('js-basic'));
  const wd = worktreesDir(path.resolve(repo));
  fs.mkdirSync(path.dirname(wd), { recursive: true });
  fs.writeFileSync(wd, 'blocks the worktrees dir\n');
  const r = cli(repo);
  const out = r.stdout + r.stderr;
  const frames = (out.match(/^\s+at /mg) || []).length;
  const last = out.split('\n').find(l => /ENOTDIR|EEXIST/.test(l)) || '';
  console.log(`b) exit=${r.status}; ${last.trim().slice(0, 160)}; stack frames printed: ${frames}`);
  report('L3 a worktree that cannot be created for a filesystem reason exits 1 with a stack trace, not 2',
    r.status === 2,
    `exit=${r.status}, ${frames} stack frames (mkdir of the worktrees dir throws outside createWorktree's EWORKTREE handling)`,
    'README: "If no worktree can be created the run stops (exit 2)": EWORKTREE with a one-line reason');
}

process.exit(exitCode());
