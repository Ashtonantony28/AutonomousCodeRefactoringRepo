'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FileSnapshot, applyEdit } = require('../runner/reverter');
const { runTests, changedSpan, TIMEOUT_MS } = require('../runner/test-runner');
const { editMutants } = require('../rl/bug-injector');
const { changeHunks } = require('../utils/hunks');

const MUTANT_CAP = 3;

// The suite has to notice a bug in each change hunk: up to MUTANT_CAP
// mutants of the tokens a hunk changed are applied one at a time and the
// suite re-run; the first one that makes it fail is that hunk's evidence. A
// mutant run that times out is re-run once and counts only if that run fails.
// A hunk that only deletes has nothing to mutate: it stands only when the
// diff test is `equivalent` and executed the deleted code. Mutant runs
// collect no coverage and have their own budget (`budgetMs`): each gets at
// most 2x the plain suite time + 1 s, and none starts after the first when
// less than that time + 0.5 s is left. The plain suite time is the main
// run's (instrumented, so an upper bound) until a surviving mutant run
// measures it. `budget_exhausted` (also set when the edit is too large to
// mutate) means the tests were not judged. The edited content is always
// written back. `ok` is the verdict; `killed` names the last killing mutant.
async function mutationEvidence({ repoRoot, file, before, edited, span, diffTest, budgetMs, usedMs }) {
  const t0 = Date.now();
  const abs = path.join(repoRoot, file);
  let suiteMs = Math.max(1, usedMs);
  let spent = 0;
  const hunks = changeHunks(before, edited, file);
  const mutants = editMutants(edited, { ...span, file, max: MUTANT_CAP, before });
  const out = { hunks: hunks.length, mutants: mutants.length, run: 0, killed: null, ok: false };
  const done = () => { out.duration_ms = Date.now() - t0; out.suite_ms = suiteMs; return out; };
  const deletions = hunks.filter(h => h.deletion);
  if (deletions.length && !(diffTest && diffTest.verdict === 'equivalent' && diffTest.deletions_observed === true)) {
    out.unobserved_deletion_line = deletions[0].line;
    return done();
  }
  if (mutants.capped) { out.budget_exhausted = true; out.edit_too_large = true; return done(); }
  const open = hunks.map((h, i) => i).filter(i => !hunks[i].deletion);
  const bare = open.find(i => !mutants.some(m => m.hunk === i));
  if (!hunks.length || bare !== undefined) {
    if (bare !== undefined) out.unmutated_hunk_line = hunks[bare].line;
    return done();
  }
  const runMutant = async () => {
    const left = budgetMs - spent;
    if (out.run && left < suiteMs + 500) return null;
    const r = await runTests({ repoRoot, timeoutMs: Math.min(left, 2 * suiteMs + 1000) });
    spent += r.execution_time_ms;
    out.run++;
    return r;
  };
  try {
    for (const hi of open) {
      let killed = false;
      for (const m of mutants.filter(x => x.hunk === hi)) {
        fs.writeFileSync(abs, m.src);
        let r = await runMutant();
        if (r && r.status === 'timeout') {
          out.timeouts = (out.timeouts || 0) + 1;
          r = await runMutant();
        }
        if (!r) { out.budget_exhausted = true; return done(); }
        if (r.status === 'passed') suiteMs = Math.max(1, r.execution_time_ms);
        if (r.status === 'failed') {
          out.killed = m.mutation;
          out.killed_line = m.line;
          killed = true;
          break;
        }
      }
      if (!killed) { out.killed = null; out.surviving_hunk_line = hunks[hi].line; return done(); }
    }
    out.ok = true;
  } finally {
    fs.writeFileSync(abs, edited);
  }
  return done();
}

// Applies an approved proposal in `repoRoot` (the run's worktree, or the target
// itself in the non-git fallback), runs the tests and keeps the edit only on a
// pass that executed every changed function and killed a mutant of every
// change hunk. Otherwise it is reverted: `reverted` with reason `edit_not_exercised`
// / `no_coverage_tool` when no test ran the edit (pass or fail), `coverage_timeout`
// when evaluating coverage overran the test budget,
// `tests_insensitive` when a hunk has no mutant that fails the suite, or
// `mutation_budget` when the mutant runs did not fit their budget. `snapshotPath` persists
// the pre-edit content so a signal or crash mid-test can be undone. `onKept`
// runs once an edit is final (the worktree commit) and its return value is
// reported as `commit`.
async function runExecutor({ proposal, repoRoot, snapshotPath = null, onKept = null, testTimeoutMs }) {
  const snap = new FileSnapshot(repoRoot, { persistPath: snapshotPath, meta: { issue_id: proposal.issue_id, file: proposal.file } });
  snap.capture(proposal.file);

  // Apply (uses 4-tier anchor matching internally)
  let edit;
  const tApply = performance.now();
  try {
    edit = applyEdit({
      repoRoot,
      relPath: proposal.file,
      currentCode: proposal.current_code,
      proposedCode: proposal.proposed_code,
      expectedRegion: proposal.validated_region ? proposal.validated_region.text : null
    });
  } catch (err) {
    snap.restoreAll();
    return {
      status: 'apply_failed',
      reason: err.message,
      tier: err.tier == null ? null : err.tier,
      detail: err.detail == null ? null : err.detail,
      reverted: true,
      passed_tests: 0,
      failed_tests: 0,
      execution_time_ms: 0,
      coverage_delta: null
    };
  }

  const applyDurationMs = Number((performance.now() - tApply).toFixed(3));

  // Test, recording which characters of the change the tests executed
  let testResult, edited, span;
  const before = (snap.snapshots.get(proposal.file) || {}).content || '';
  try {
    edited = fs.readFileSync(path.join(repoRoot, proposal.file), 'utf8');
    span = changedSpan(before, edited);
    testResult = await runTests({ repoRoot, timeoutMs: testTimeoutMs, edit: { file: proposal.file, ...span } });
  } catch (err) {
    snap.restoreAll();
    return {
      status: 'environment_error',
      reason: err.message,
      reverted: true,
      passed_tests: 0,
      failed_tests: 0,
      execution_time_ms: 0,
      coverage_delta: null
    };
  }

  let status = testResult.status;
  let reverted = false;
  let reason = null;
  let mutation = null;
  const coverage = testResult.coverage || { available: false };

  if (status === 'failed' || status === 'timeout' || status === 'environment_error') {
    snap.restoreAll();
    reverted = true;
    status = status === 'failed' ? 'reverted' : status;
    // A red suite that never ran the edit says nothing about it either.
    if (status === 'reverted' && !coverage.exercised) reason = coverage.reason || 'edit_not_exercised';
    if (status === 'timeout') reason = `tests timed out after ${testResult.execution_time_ms} ms`;
    if (status === 'environment_error') reason = `test command failed to run: ${testResult.stderr.trim().split('\n').pop()}`;
  } else if (status === 'no_test_runner') {
    // Nothing can validate the edit: revert it.
    snap.restoreAll();
    reverted = true;
    status = 'skipped_no_tests';
  } else if (status === 'passed' && !coverage.exercised) {
    // A green suite that never ran the edit says nothing about it.
    snap.restoreAll();
    reverted = true;
    status = 'reverted';
    reason = coverage.reason || 'edit_not_exercised';
  } else if (status === 'passed') {
    try {
      mutation = await mutationEvidence({
        repoRoot, file: proposal.file, before, edited, span, diffTest: proposal.diff_test,
        budgetMs: testTimeoutMs || TIMEOUT_MS, usedMs: testResult.execution_time_ms
      });
    } catch (err) {
      mutation = { killed: null, ok: false, error: err.message };
    }
    if (!mutation.ok) {
      // Green on the edit and on every mutant of a hunk, or a deletion no
      // oracle observed: the tests cannot tell. Out of mutant budget (or an
      // edit too large to mutate): they were not asked.
      snap.restoreAll();
      reverted = true;
      status = 'reverted';
      reason = mutation.budget_exhausted ? 'mutation_budget' : 'tests_insensitive';
    }
  }

  let commit = null;
  if (!reverted) {
    try {
      commit = onKept ? await onKept() : null;
    } catch (err) {
      // A commit that failed after `git add` leaves the edit staged, and the
      // next proposal's commit would carry it.
      spawnSync('git', ['reset', '-q', '--', proposal.file], { cwd: repoRoot, stdio: 'ignore' });
      snap.restoreAll();
      return {
        status: 'environment_error',
        reason: `commit failed: ${err.message}`,
        reverted: true,
        passed_tests: testResult.passed_tests,
        failed_tests: testResult.failed_tests,
        execution_time_ms: testResult.execution_time_ms,
        coverage_delta: null
      };
    }
    snap.release();
  }

  const out = {
    status,
    reverted,
    passed_tests: testResult.passed_tests,
    failed_tests: testResult.failed_tests,
    execution_time_ms: testResult.execution_time_ms,
    coverage_delta: testResult.coverage_delta,
    coverage,
    ...(mutation ? { mutation } : {}),
    test_command: testResult.command,
    test_framework: testResult.framework,
    stdout_tail: testResult.stdout,
    stderr_tail: testResult.stderr,
    bytes_before: edit.bytesBefore,
    bytes_after: edit.bytesAfter,
    match_tier: edit.matchTier,
    match_score: edit.matchScore,
    match_delta: edit.matchDelta,
    apply_duration_ms: applyDurationMs
  };
  if (reason) out.reason = reason;
  if (commit) out.commit = commit;
  return out;
}

module.exports = { runExecutor };
