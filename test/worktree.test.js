'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktree = require('../src/runner/worktree');
const { git, gitInit } = require('./helpers/git');

function makeRepo(t, mutate) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-base-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'module.exports = 2;\n');
  gitInit(repo);
  mutate(repo);
  const info = worktree.createWorktree({ targetRepo: repo, runId: 'r1', baseDir: base });
  t.after(() => { env.rm(repo); env.rm(base); });
  assert.strictEqual(info.mode, 'worktree');
  return { repo, info, read: (rel) => { const p = path.join(info.root, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } };
}

const write = (repo, rel, src) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), src);
};

test('unstaged edit as the first status entry is synced (leading space kept)', (t) => {
  const { info, read } = makeRepo(t, (repo) => write(repo, 'src/a.js', 'module.exports = 100;\n'));
  assert.deepStrictEqual(info.dirty_synced, ['src/a.js']);
  assert.strictEqual(read('src/a.js'), 'module.exports = 100;\n');
});

test('several unstaged, staged, untracked and deleted entries are all synced', (t) => {
  const { info, read } = makeRepo(t, (repo) => {
    write(repo, 'src/a.js', 'A\n');
    write(repo, 'src/b.js', 'B\n');
    git(repo, ['add', 'src/b.js']);
    write(repo, 'src/b.js', 'B2\n');
    write(repo, 'src/new dir/c d.js', 'C\n');
  });
  assert.deepStrictEqual([...info.dirty_synced].sort(), ['src/a.js', 'src/b.js', 'src/new dir/c d.js']);
  assert.strictEqual(read('src/a.js'), 'A\n');
  assert.strictEqual(read('src/b.js'), 'B2\n');
  assert.strictEqual(read('src/new dir/c d.js'), 'C\n');
});

test('a deleted tracked file is removed from the worktree', (t) => {
  const { read } = makeRepo(t, (repo) => fs.rmSync(path.join(repo, 'src', 'b.js')));
  assert.strictEqual(read('src/b.js'), null);
  assert.strictEqual(read('src/a.js'), 'module.exports = 1;\n');
});

test('a staged rename moves the file: new path written, source removed', (t) => {
  const { info, read } = makeRepo(t, (repo) => {
    git(repo, ['mv', 'src/a.js', 'src/renamed.js']);
    assert.match(git(repo, ['status', '--porcelain']), /^R {2}src\/a\.js -> src\/renamed\.js/);
  });
  assert.deepStrictEqual([...info.dirty_synced].sort(), ['src/a.js', 'src/renamed.js']);
  assert.strictEqual(read('src/renamed.js'), 'module.exports = 1;\n');
  assert.strictEqual(read('src/a.js'), null);
  assert.strictEqual(read('src/b.js'), 'module.exports = 2;\n');
});

test('committedIssues maps issue_id trailers on the run branch to commits', (t) => {
  const { info } = makeRepo(t, () => {});
  fs.writeFileSync(path.join(info.root, 'src', 'a.js'), 'module.exports = 10;\n');
  const s1 = worktree.commitProposal(info, { issue_id: 'aaaa000011112222', file: 'src/a.js', reasoning: 'issue_id: not-this\nmore' });
  fs.writeFileSync(path.join(info.root, 'src', 'b.js'), 'module.exports = 20;\n');
  const s2 = worktree.commitProposal(info, { issue_id: 'bbbb000011112222-2', file: 'src/b.js', reasoning: '' });
  const map = worktree.committedIssues(info);
  assert.strictEqual(map.get('aaaa000011112222'), s1);
  assert.strictEqual(map.get('bbbb000011112222-2'), s2);
  assert.strictEqual(map.size, 2, 'an issue_id line inside the reasoning is not a trailer');
  assert.strictEqual(worktree.committedIssues({ mode: 'in-place' }).size, 0);
});

// ---------- SG16: the dirty-file sync never silently skips ----------

test('git status output over 1 MB is synced in full (no output cap)', (t) => {
  const deep = ['a', 'b', 'c'].map(c => c.repeat(250)).join('/');
  const n = 1200;
  const { info, read } = makeRepo(t, (repo) => {
    write(repo, 'src/a.js', 'module.exports = 100;\n');
    fs.mkdirSync(path.join(repo, deep), { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(repo, deep, `${String(i).padStart(4, '0')}${'f'.repeat(196)}.js`), `// ${i}\n`);
    const status = require('child_process').execFileSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    assert(status.length > 1024 * 1024, 'fixture exceeds the old 1 MB cap');
  });
  assert.strictEqual(info.dirty_synced.length, n + 1);
  assert.strictEqual(read('src/a.js'), 'module.exports = 100;\n', 'the worktree has the uncommitted version, not HEAD');
  assert.strictEqual(read(`${deep}/0000${'f'.repeat(196)}.js`), '// 0\n');
});

test('a failing dirty-file sync stops worktree creation with an error and leaves no worktree or branch behind', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-base-'));
  t.after(() => { env.rm(repo); env.rm(base); });
  write(repo, 'src/a.js', 'module.exports = 1;\n');
  gitInit(repo);
  write(repo, 'src/a.js', 'module.exports = 100;\n');
  fs.writeFileSync(path.join(repo, '.git', 'index'), 'corrupt'); // `git status` now fails
  assert.throws(() => worktree.createWorktree({ targetRepo: repo, runId: 'r1', baseDir: base }), /could not be copied into the worktree.*git status failed.*refusing to validate HEAD/s);
  assert.strictEqual(fs.existsSync(path.join(base, 'r1')), false);
  assert.strictEqual(git(repo, ['branch', '--list', 'refactor/r1']), '');
});

test('syncDirtyFiles throws instead of returning an empty list when git status fails', (t) => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-norepo-'));
  t.after(() => env.rm(notRepo));
  assert.throws(() => worktree.syncDirtyFiles(notRepo, notRepo), /git status failed/);
});

test('a dirty submodule-like directory entry is skipped, not an error', (t) => {
  const { info, read } = makeRepo(t, (repo) => {
    const nested = path.join(repo, 'vendor', 'lib');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'x.js'), '1;\n');
    gitInit(nested); // nested repository: `git status` lists it as a directory entry
    write(repo, 'src/b.js', 'module.exports = 20;\n');
  });
  assert.deepStrictEqual(info.dirty_synced, ['src/b.js']);
  assert.strictEqual(read('src/b.js'), 'module.exports = 20;\n');
});

// ---------- SG17: resume never falls back to editing a git target in place ----------

test('resumeWorktree re-creates a deleted worktree from the run branch, commits and dirty changes kept', (t) => {
  const { repo, info } = makeRepo(t, (r) => {
    write(r, 'src/a.js', 'module.exports = 100;\n');
    write(r, 'src/b.js', 'module.exports = 200;\n');
  });
  fs.writeFileSync(path.join(info.root, 'src', 'b.js'), 'module.exports = 2000;\n');
  const sha = worktree.commitProposal(info, { issue_id: 'cccc000011112222', file: 'src/b.js', reasoning: '' });
  fs.rmSync(info.path, { recursive: true, force: true });
  const before = git(repo, ['status', '--porcelain']);

  const again = worktree.resumeWorktree({ targetRepo: repo, info });
  assert.strictEqual(again.mode, 'worktree');
  assert.strictEqual(again.path, info.path);
  assert.strictEqual(again.branch, info.branch);
  assert.strictEqual(git(again.path, ['rev-parse', 'HEAD']), sha);
  assert.strictEqual(worktree.committedIssues(again).get('cccc000011112222'), sha);
  assert.strictEqual(fs.readFileSync(path.join(again.root, 'src', 'a.js'), 'utf8'), 'module.exports = 100;\n', 'target change re-synced');
  assert.strictEqual(fs.readFileSync(path.join(again.root, 'src', 'b.js'), 'utf8'), 'module.exports = 2000;\n', 'committed edit not overwritten');
  assert.strictEqual(git(repo, ['status', '--porcelain']), before, 'target untouched');
});

test('resumeWorktree stops with an error naming the branch when the run branch is gone', (t) => {
  const { repo, info } = makeRepo(t, () => {});
  git(repo, ['worktree', 'remove', '--force', info.path]);
  git(repo, ['branch', '-D', info.branch]);
  assert.throws(() => worktree.resumeWorktree({ targetRepo: repo, info }),
    (err) => err.code === 'EWORKTREE' && err.message.includes(`branch ${info.branch} no longer exists`) && /not edited in place/.test(err.message));
  assert.strictEqual(git(repo, ['status', '--porcelain']), '');
});

test('resumeWorktree refuses a directory that is not the run branch worktree', (t) => {
  const { repo, info } = makeRepo(t, () => {});
  git(repo, ['worktree', 'remove', '--force', info.path]);
  fs.mkdirSync(info.path, { recursive: true });
  assert.throws(() => worktree.resumeWorktree({ targetRepo: repo, info }), (err) => err.code === 'EWORKTREE');
});

// ---------- SG21: a git target with commits is never edited in place ----------

function blockedRepo(t, branches) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-base-'));
  t.after(() => { env.rm(repo); env.rm(base); });
  write(repo, 'src/a.js', 'module.exports = 1;\n');
  gitInit(repo);
  for (const b of branches) git(repo, ['branch', b]);
  write(repo, 'src/a.js', 'module.exports = 1; // user work\n');
  return { repo, base };
}

test('a user branch named `refactor` makes the run use refactor-run/<run_id>, not the target', (t) => {
  const { repo, base } = blockedRepo(t, ['refactor']);
  const info = worktree.createWorktree({ targetRepo: repo, runId: 'r1', baseDir: base });
  assert.strictEqual(info.mode, 'worktree');
  assert.strictEqual(info.branch, 'refactor-run/r1');
  assert.strictEqual(git(info.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'refactor-run/r1');
  assert.deepStrictEqual(info.dirty_synced, ['src/a.js']);
  fs.writeFileSync(path.join(info.root, 'src', 'a.js'), 'module.exports = 2;\n');
  assert(worktree.commitProposal(info, { issue_id: 'aaaa000011112222', file: 'src/a.js', reasoning: '' }));
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), 'module.exports = 1; // user work\n');
  assert.strictEqual(git(repo, ['status', '--porcelain']), 'M src/a.js');
});

test('worktree add failing on both branch names throws EWORKTREE; no worktree, no new branch, target untouched', (t) => {
  const { repo, base } = blockedRepo(t, ['refactor', 'refactor-run', 'refactor-run-r1']);
  const refs = git(repo, ['for-each-ref', '--format=%(refname)']);
  assert.throws(() => worktree.createWorktree({ targetRepo: repo, runId: 'r1', baseDir: base }),
    (err) => err.code === 'EWORKTREE' && /not edited in place/.test(err.message) && err.message.includes('refactor-run-r1'));
  assert.strictEqual(fs.existsSync(path.join(base, 'r1')), false);
  assert.strictEqual(git(repo, ['for-each-ref', '--format=%(refname)']), refs, 'pre-existing refactor-run-r1 kept, nothing added');
  assert.strictEqual(git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).length, 1);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), 'module.exports = 1; // user work\n');
});
