'use strict';

// Shared harness for AUDIT-24 repros: the AUDIT-3 helpers (temp
// REFACTOR_STATE_DIR via test/helpers/env.js, makeRepo, report) plus one
// executor run on a temp git repo. No API calls; never touches src/, test/,
// state/ or dashboard/.
const lib = require('../3/lib');
const { runExecutor } = require('../../src/agents/executor');

// A diff test that vouches for every deleted token, so only the inserted-token
// (mutation) evidence decides.
const EQUIV = { applicable: true, verdict: 'equivalent', runs: 10, duration_ms: 1, deletions_observed: true };
const PKG = { name: 'audit24', version: '0.0.0', private: true, scripts: { test: 'node --test' } };

// files: the repo before the edit; edit: { file, current_code, proposed_code }.
// -> { o: the executor's TestOutcome, repo }
async function execOn(files, edit, { pkg = PKG } = {}) {
  const repo = lib.makeRepo(files, { pkg, gitRepo: true });
  const proposal = { issue_id: 'audit24', diff_test: EQUIV, reasoning: '', risk_estimate: 0.1, ...edit };
  const o = await lib.noTestCtx(() => lib.quiet(() => runExecutor({ proposal, repoRoot: repo, onKept: () => 'commit' })));
  return { o, repo };
}

const brief = (o) => `status=${o.status} reason=${o.reason || '(none)'} mutation=${JSON.stringify(o.mutation || null)}`;

module.exports = { ...lib, execOn, brief, EQUIV, PKG };
