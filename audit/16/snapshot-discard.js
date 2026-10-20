'use strict';

// AUDIT-16 SG25 probe: can the startup "committed snapshot" discard drop a
// snapshot whose edit is NOT committed, so an unvalidated edit stays in the
// run worktree? Calls FileSnapshot.restoreFromDisk with the orchestrator's
// own predicate (worktree.headCommitOf) on throw-away git repos.
//   1  crash after the commit (HEAD = the edit's commit)        -> discard
//   2  crash mid-test, HEAD is an earlier commit of another issue -> restore
//   3  crash mid-test, HEAD carries the same issue_id trailer but
//      the file differs from HEAD (e.g. a user commit quoting it) -> restore
//   4  as 3, HEAD's free-text reasoning (not the trailer) names the issue -> restore
// Temp repos in os.tmpdir(); temp REFACTOR_STATE_DIR via audit/1/lib.js.
// Prints FINDING (exit 1) when a snapshot of an uncommitted edit is discarded.
//   node audit/16/snapshot-discard.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeRepo, gitIn, rm } = require('../1/lib');
const { FileSnapshot } = require('../../src/runner/reverter');
const worktree = require('../../src/runner/worktree');

const A = 'function f() {\n  return 1;\n}\nmodule.exports = { f };\n';
const B = 'function f() {\n  return 2;\n}\nmodule.exports = { f };\n';
const commit = (dir, msg) => gitIn(dir, '-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '-am', msg);

function scenario(id, setup) {
  const repo = makeRepo({ 'src/f.js': A }, { git: true });
  const snapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit16-snap-')), 'inflight.json');
  try {
    const { issue, expect } = setup(repo);
    fs.writeFileSync(snapPath, JSON.stringify({ repo_root: repo, meta: { issue_id: issue, file: 'src/f.js' }, files: { 'src/f.js': { existed: true, content: A } } }));
    const r = FileSnapshot.restoreFromDisk(snapPath, { committed: (d) => worktree.headCommitOf(d.repo_root, d.meta && d.meta.issue_id, Object.keys(d.files)) });
    const now = fs.readFileSync(path.join(repo, 'src/f.js'), 'utf8');
    const head = gitIn(repo, 'show', 'HEAD:src/f.js') + '\n';
    const uncommittedKept = now !== A && now !== head;
    const got = r.discarded ? 'discard' : 'restore';
    const bad = got !== expect || uncommittedKept;
    console.log(`${bad ? 'FINDING' : 'ok     '} ${id}: ${got} (expected ${expect}); worktree file ${now === A ? 'pre-edit' : now === head ? 'HEAD' : 'UNCOMMITTED EDIT'}${r.discarded ? ` [${r.discarded}]` : ''}`);
    return !bad;
  } finally { rm(repo); rm(path.dirname(snapPath)); }
}

const results = [
  scenario('1 crash after commit', (repo) => {
    fs.writeFileSync(path.join(repo, 'src/f.js'), B);
    commit(repo, 'refactor: src/f.js [aaaa]\n\nreason\n\nissue_id: aaaa\nfile: src/f.js\n');
    return { issue: 'aaaa', expect: 'discard' };
  }),
  scenario('2 crash mid-test, HEAD = other issue', (repo) => {
    fs.writeFileSync(path.join(repo, 'README'), 'x');
    gitIn(repo, 'add', 'README');
    commit(repo, 'refactor: README [bbbb]\n\nissue_id: bbbb\nfile: README\n');
    fs.writeFileSync(path.join(repo, 'src/f.js'), B);
    return { issue: 'aaaa', expect: 'restore' };
  }),
  scenario('3 crash mid-test, HEAD trailer = same issue, file differs', (repo) => {
    fs.writeFileSync(path.join(repo, 'README'), 'x');
    gitIn(repo, 'add', 'README');
    commit(repo, 'notes\n\nissue_id: aaaa\n');
    fs.writeFileSync(path.join(repo, 'src/f.js'), B);
    return { issue: 'aaaa', expect: 'restore' };
  }),
  scenario('4 crash mid-test, HEAD reasoning names the issue', (repo) => {
    fs.writeFileSync(path.join(repo, 'README'), 'x');
    gitIn(repo, 'add', 'README');
    commit(repo, 'refactor: README [bbbb]\n\nsee\nissue_id: aaaa\n\nissue_id: bbbb\nfile: README\n');
    fs.writeFileSync(path.join(repo, 'src/f.js'), B);
    return { issue: 'aaaa', expect: 'restore' };
  })
];

if (results.every(Boolean)) console.log('ok');
else { console.log('FINDING: a snapshot of an uncommitted edit was discarded or not restored'); process.exit(1); }
