'use strict';

// AUDIT-10 M2: the crash snapshot (`inflight.json`) records the worktree as
// its repo_root. If that worktree directory is gone when the next run starts
// (the AUDIT-7 H3 situation that SG17 now handles by re-creating it),
// FileSnapshot.restoreFromDisk throws ENOENT at the top of runPipeline,
// before the session or worktree is looked at, and leaves inflight.json in
// place: every later run on the target, with or without --resume, dies the
// same way (CLI: "fatal" stack trace, exit 1) until the user finds and
// deletes the file.
//
//   node audit/10/inflight-worktree-gone.js

const { env, gitInit, runWith, report, exitCode } = require('./lib');
const fs = require('fs');
const path = require('path');
const { inflightPath, sessionPath } = require('../../src/utils/checkpoint');
const { loadFixtureResponses } = require('../../test/helpers/stub-client');

(async () => {
  const repo = gitInit(env.copyFixture('js-basic'));
  const r1 = await runWith(repo, loadFixtureResponses('js-basic'));
  const wt = r1.s.worktree;
  // A crash mid-edit of a pending proposal: the snapshot is on disk, the outcome is not.
  const sess = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  const pending = sess.proposals[0];
  pending.test_outcome = null;
  fs.writeFileSync(sessionPath(repo), JSON.stringify(sess));
  fs.writeFileSync(inflightPath(repo), JSON.stringify({
    repo_root: wt.root, meta: { issue_id: pending.issue_id, file: pending.file },
    files: { [pending.file]: { existed: true, content: fs.readFileSync(path.join(repo, pending.file), 'utf8') } },
    captured_at: new Date().toISOString()
  }));
  fs.rmSync(wt.path, { recursive: true, force: true }); // worktrees/ cleaned up

  const results = [];
  for (const resume of [true, false]) {
    try {
      await runWith(repo, loadFixtureResponses('js-basic'), { resume });
      results.push(`resume=${resume}: completed`);
    } catch (e) {
      results.push(`resume=${resume}: threw ${e.code || e.name}: ${e.message.slice(0, 120)}`);
    }
  }
  const still = fs.existsSync(inflightPath(repo));
  for (const r of results) console.log(`   ${r}`);
  console.log(`   inflight.json still present: ${still}`);
  report('M2 a crash snapshot whose worktree is gone makes every later run on the target throw',
    results.every(r => r.includes('completed')),
    `${results.filter(r => !r.includes('completed')).length}/2 runs died in restoreFromDisk before the session was read; inflight.json kept (${still})`,
    'restoreFromDisk skips (and reports) a snapshot whose repo_root no longer exists, or resume re-creates the worktree first and then restores; a worktree that is gone has nothing to restore');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
