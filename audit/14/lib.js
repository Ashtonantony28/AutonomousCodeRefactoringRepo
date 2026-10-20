'use strict';

// Shared helpers for the AUDIT-14 scripts. Loading this file first points
// REFACTOR_STATE_DIR / REFACTOR_DASHBOARD_DIR at a temp dir (test/helpers/env.js
// through audit/9/lib.js) before any src module loads. Every fixture is
// generated under os.tmpdir() at runtime; no script makes a Claude API call.

const fs = require('fs');
const path = require('path');
const L9 = require('../9/lib');

// The diff test the orchestrator would have attached before the executor runs
// (hybrid-validator: diffTesting.run on the validated region with fileSrc).
// Since SG22 the executor needs it to accept deleted tokens, so executor-level
// repros that skip the validator must attach it themselves.
function attachDiffTest(proposal, repoRoot) {
  const diffTesting = require(L9.src('validation/diff-testing'));
  const fileSrc = fs.readFileSync(path.join(repoRoot, proposal.file), 'utf8');
  proposal.diff_test = diffTesting.run({ currentSrc: proposal.current_code, proposedSrc: proposal.proposed_code, fileSrc, file: proposal.file });
  return proposal.diff_test;
}

// Wraps executor.runExecutor (before a script destructures it) so every call
// carries that diff test.
function patchExecutorWithDiffTest() {
  const executor = require(L9.src('agents/executor'));
  if (executor.__a14) return executor;
  const orig = executor.runExecutor;
  executor.runExecutor = async function (o) {
    if (o && o.proposal && !o.proposal.diff_test) attachDiffTest(o.proposal, o.repoRoot);
    return orig.call(this, o);
  };
  executor.__a14 = true;
  return executor;
}

// Child processes of this process still alive (pid, args).
function liveChildren() {
  try {
    const out = require('child_process').execFileSync('ps', ['-eo', 'pid,ppid,etimes,args'], { encoding: 'utf8' });
    return out.split('\n').filter(l => l.trim().split(/\s+/)[1] === String(process.pid));
  } catch { return []; }
}

function threads() {
  try { return Number(/Threads:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1]); } catch { return NaN; }
}

function fds() {
  try { return fs.readdirSync('/proc/self/fd').length; } catch { return NaN; }
}

module.exports = { ...L9, attachDiffTest, patchExecutorWithDiffTest, liveChildren, threads, fds };
