'use strict';

// AUDIT-4 repro: syncDirtyFiles (src/runner/worktree.js:42-64) has no test,
// and mangles the first `git status --porcelain -z` entry.
//
//   node audit/4/worktree-dirty-sync.js
//
// Expected: uncommitted target edits (what the Analyzer read) are copied into
// the run worktree. Observed: when the first status entry is an unstaged
// modification (" M path"), git()'s .trim() eats the leading space, so the
// entry is parsed as code "M " / path "<path minus first char>" and the
// edit is silently not synced.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
require('../../test/helpers/env'); // temp REFACTOR_STATE_DIR
const { createWorktree } = require('../../src/runner/worktree');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ID = ['-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false'];

function scenario(name, mutate) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit4-dirty-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit4-wt-'));
  try {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'module.exports = 2;\n');
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '-A'); git(repo, ...ID, 'commit', '-q', '-m', 'init');
    const expected = mutate(repo);
    const info = createWorktree({ targetRepo: repo, runId: 'r1', baseDir: base });
    const rows = Object.entries(expected).map(([rel, want]) => {
      const p = path.join(info.root, rel);
      const got = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      return { rel, ok: got === want, got, want };
    });
    const ok = rows.every(r => r.ok);
    console.log(`${ok ? 'ok     ' : 'FINDING'} ${name}`);
    console.log(`        status: ${JSON.stringify(git(repo, 'status', '--porcelain', '-z', '-uall'))}`);
    console.log(`        dirty_synced: ${JSON.stringify(info.dirty_synced)}`);
    for (const r of rows) if (!r.ok) console.log(`        ${r.rel}: worktree has ${JSON.stringify(r.got)}, target has ${JSON.stringify(r.want)}`);
    return ok;
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', path.join(base, 'r1')); } catch { /* */ }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const results = [
  scenario('unstaged edit to a tracked file (the common case)', (repo) => {
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 100; // dirty\n');
    return { 'src/a.js': 'module.exports = 100; // dirty\n' };
  }),
  scenario('staged edit (first entry starts with "M", not a space)', (repo) => {
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 100; // staged\n');
    git(repo, 'add', 'src/a.js');
    return { 'src/a.js': 'module.exports = 100; // staged\n' };
  }),
  scenario('two unstaged edits: only the first entry is mangled', (repo) => {
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 100;\n');
    fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'module.exports = 200;\n');
    return { 'src/a.js': 'module.exports = 100;\n', 'src/b.js': 'module.exports = 200;\n' };
  })
];
process.exitCode = results.every(Boolean) ? 0 : 1;
