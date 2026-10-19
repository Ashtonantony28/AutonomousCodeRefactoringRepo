'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FileSnapshot, applyEdit } = require('../runner/reverter');
const { runTests, changedSpan, TIMEOUT_MS } = require('../runner/test-runner');
const { editMutants } = require('../rl/bug-injector');

const MUTANT_CAP = 3;

// The suite has to notice a bug in the edited lines: up to MUTANT_CAP mutants
// of them are applied one at a time and the suite re-run; the first one that
// makes it fail (or run out its full slice) is the evidence. The mutant runs
// share what the main run left of the test budget, each getting at most
// 2x the main run's time + 1 s, and stop when less than the main run's time
// + 0.5 s is left. The edited content is always written back.
async function mutationEvidence({ repoRoot, file, edited, span, budgetMs, usedMs, coverageMs = 0 }) {
  const t0 = Date.now();
  const abs = path.join(repoRoot, file);
  const suiteMs = usedMs;
  usedMs += coverageMs; // the main run's coverage evaluation shares the budget; mutant runs collect none
  const mutants = editMutants(edited, { ...span, file, max: MUTANT_CAP });
  const out = { mutants: mutants.length, run: 0, killed: null };
  try {
    for (const m of mutants) {
      const left = budgetMs - usedMs;
      const full = 2 * suiteMs + 1000;
      if (left < suiteMs + 500) { out.budget_exhausted = true; break; }
      const slice = Math.min(left, full);
      fs.writeFileSync(abs, m.src);
      const r = await runTests({ repoRoot, timeoutMs: slice });
      usedMs += r.execution_time_ms;
      out.run++;
      if (r.status === 'failed' || (r.status === 'timeout' && slice === full)) {
        out.killed = m.mutation;
        out.killed_line = m.line;
        break;
      }
    }
  } finally {
    fs.writeFileSync(abs, edited);
  }
  out.duration_ms = Date.now() - t0;
  return out;
}

// Applies an approved proposal in `repoRoot` (the run's worktree, or the target
// itself in the non-git fallback), runs the tests and keeps the edit only on a
// pass that executed every changed function and killed a mutant of the edited
// lines. Otherwise it is reverted: `reverted` with reason `edit_not_exercised`
// / `no_coverage_tool` when no test ran the edit (pass or fail), `coverage_timeout`
// when evaluating coverage overran the test budget, or
// `tests_insensitive` when no mutant failed the suite. `snapshotPath` persists
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
  try {
    const before = (snap.snapshots.get(proposal.file) || {}).content || '';
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
        repoRoot, file: proposal.file, edited, span,
        budgetMs: testTimeoutMs || TIMEOUT_MS, usedMs: testResult.execution_time_ms, coverageMs: coverage.duration_ms || 0
      });
    } catch (err) {
      mutation = { killed: null, error: err.message };
    }
    if (!mutation.killed) {
      // Green on the edit and on every mutant of it: the tests cannot tell.
      snap.restoreAll();
      reverted = true;
      status = 'reverted';
      reason = 'tests_insensitive';
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
