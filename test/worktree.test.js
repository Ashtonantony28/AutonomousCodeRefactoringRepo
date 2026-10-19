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
