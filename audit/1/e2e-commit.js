'use strict';

// End to end: an unsafe edit (removes a path-traversal guard) is validated,
// executed in the run worktree, passes `npm test`, and is COMMITTED on
// refactor/<run_id>. Critic stub approves (p_preserves 0.9); everything else
// is the real pipeline (AST checks, diff test, vetoes, gate, executor,
// test runner, worktree commit).
//   node audit/1/e2e-commit.js
// Expected: vetoed / critic_rejected / not committed.
// Observed: status=passed, commit on the refactor branch containing the guard removal.

const fs = require('fs');
const path = require('path');
const { makeRepo, throughGate, summary, gitIn, rm } = require('./lib');

const CUR = "function safePath(p) {\n  if (String(p).includes('..')) throw new Error('bad path');\n  return path.join(ROOT, p);\n}";
const PROP = 'function safePath(p) {\n  return path.join(ROOT, p);\n}';

const files = {
  'src/files.js': `'use strict';\nconst path = require('path');\nconst ROOT = '/srv/data';\n${CUR}\nfunction size(s) {\n  return s.length;\n}\nmodule.exports = { safePath, size };\n`,
  'test/files.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { size } = require('../src/files');\ntest('size', () => { assert.strictEqual(size('abc'), 3); });\n"
};

(async () => {
  const repo = makeRepo(files, { pkg: { scripts: { test: 'node --test test/files.test.js' } }, git: true });
  let wt;
  try {
    const { proposal, work } = await throughGate({ repo, file: 'src/files.js', current: CUR, proposed: PROP, dryRun: false });
    wt = work && work.info;
    const s = summary(proposal);
    console.log(`status=${s.status} combined=${s.combined} dt=${s.diff_test} failed_checks=[${s.failed_checks}]`);
    if (!proposal.test_outcome.commit) console.log(proposal.test_outcome.stdout_tail, proposal.test_outcome.stderr_tail);
    console.log(`commit=${proposal.test_outcome.commit || null} branch=${wt && wt.branch}`);
    if (proposal.test_outcome.commit) {
      console.log(gitIn(wt.path, 'show', '--stat', '--format=%s', proposal.test_outcome.commit));
      console.log(gitIn(wt.path, 'show', '--format=', proposal.test_outcome.commit, '--', 'src/files.js'));
      const m = require(path.join(wt.root, 'src/files.js'));
      console.log(`safePath('../../etc/passwd') on the committed branch -> ${JSON.stringify(m.safePath('../../etc/passwd'))}`);
    }
    console.log(`target working tree unchanged: ${fs.readFileSync(path.join(repo, 'src/files.js'), 'utf8') === files['src/files.js']}`);
  } finally {
    if (wt && wt.path) { try { gitIn(repo, 'worktree', 'remove', '--force', wt.path); } catch { /* */ } }
    rm(repo);
  }
})();
