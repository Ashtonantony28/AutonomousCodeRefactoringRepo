'use strict';

// AUDIT-10 C1: a fresh (non-dry) run on a git target with commits falls back
// to editing the target's own working tree whenever `git worktree add -b
// refactor/<run_id>` fails (worktree.createWorktree). CLAUDE.md / README:
// "The target's working tree is never modified"; in-place is only for a
// target that "is not a git repo (or has no commits)". One ordinary way to
// make the add fail: the target has a branch named `refactor`, so no ref
// refs/heads/refactor/* can be created.
//  a) the passing edit is left uncommitted in the user's checkout, next to
//     their own uncommitted work (only a warning is logged);
//  b) a user who keeps working (the docs say the target is never touched)
//     saves the file while the executor's tests run: the executor's final
//     write (mutant loop restore / revert) overwrites that save.
//
//   node audit/10/branch-namespace-in-place.js

const { env, git, gitInit, runWith, report, exitCode } = require('./lib');
const fs = require('fs');
const path = require('path');
const { loadFixtureResponses } = require('../../test/helpers/stub-client');

function fixture({ slowTests = false } = {}) {
  const dir = env.copyFixture('js-basic');
  if (slowTests) {
    const t = path.join(dir, 'test/math.test.js');
    fs.writeFileSync(t, "'use strict';\n{ const t0 = Date.now(); while (Date.now() - t0 < 1200) {} }\n" + fs.readFileSync(t, 'utf8').replace(/^'use strict';\n/, ''));
  }
  const repo = gitInit(dir);
  git(repo, 'branch', 'refactor'); // an ordinary branch name
  const file = path.join(repo, 'src/math.js');
  fs.appendFileSync(file, '\n// user work in progress\n');
  return { repo, file };
}

function outcomes(s) {
  return s.proposals.map(p => {
    const o = p.test_outcome || {};
    return `${p.issue_id.slice(0, 8)}:${o.status}${o.commit ? '@' + o.commit.slice(0, 8) : ''}`;
  }).join(', ');
}

(async () => {
  // a) the edit lands in the user's checkout
  {
    const { repo, file } = fixture();
    const before = fs.readFileSync(file, 'utf8');
    let s = null, err = null;
    try { ({ s } = await runWith(repo, loadFixtureResponses('js-basic'))); } catch (e) { err = e; }
    const after = fs.readFileSync(file, 'utf8');
    const status = git(repo, 'status', '--porcelain', '--untracked-files=no');
    console.log(`a) session.worktree=${s ? JSON.stringify({ mode: s.worktree.mode, reason: s.worktree.reason }) : '-'}${err ? `; threw ${err.code || ''} ${err.message}` : ''}`);
    console.log(`a) outcomes: ${s ? outcomes(s) : '-'}; target git status: ${JSON.stringify(status)}; src/math.js ${before === after ? 'unchanged' : 'rewritten by the executor'}`);
    report('C1a a fresh run on a git target edits the target in place when `git worktree add` fails',
      !!err || (s.worktree.mode === 'worktree' && before === after),
      `mode=${s && s.worktree.mode}; ${s && outcomes(s)} (no commit); the user's checkout of src/math.js now holds the executor's edit next to their uncommitted line`,
      'a git target with commits is never edited in place: stop with an error (as resume does with EWORKTREE), or use a ref that cannot collide with a user branch');
  }

  // b) the user saves the file while the tests run
  {
    const { repo, file } = fixture({ slowTests: true });
    const original = fs.readFileSync(file, 'utf8');
    const USER_LINE = '// user: saved while the refactor tool was running\n';
    let saved = false;
    const timer = setInterval(() => {
      if (saved) return;
      let now;
      try { now = fs.readFileSync(file, 'utf8'); } catch { return; }
      if (now !== original) { // the executor applied its edit: the user saves 300 ms later
        saved = true;
        setTimeout(() => fs.writeFileSync(file, original + USER_LINE), 300);
      }
    }, 20);
    let s = null, err = null;
    try { ({ s } = await runWith(repo, loadFixtureResponses('js-basic'))); } catch (e) { err = e; } finally { clearInterval(timer); }
    const after = fs.readFileSync(file, 'utf8');
    const kept = after.includes(USER_LINE);
    console.log(`b) mode=${s && s.worktree.mode}; outcomes: ${s ? outcomes(s) : '-'}; user saved during the run: ${saved}; user's line in src/math.js after the run: ${kept}`);
    report('C1b in-place fallback overwrites a save the user makes while the run is in progress',
      !!err || !saved || kept,
      `the user's save (${JSON.stringify(USER_LINE.trim())}) is gone: the executor's final write of the edited/snapshotted content replaced it`,
      'the executor never writes the target checkout of a git repo, so concurrent user work is never overwritten');
  }
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
