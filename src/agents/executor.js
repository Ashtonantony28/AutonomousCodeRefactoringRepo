'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FileSnapshot, applyEdit } = require('../runner/reverter');
const { runTests, changedSpan } = require('../runner/test-runner');

// Applies an approved proposal in `repoRoot` (the run's worktree, or the target
// itself in the non-git fallback), runs the tests and reverts on anything but
// a pass that executed the edit (otherwise `reverted` with reason
// `edit_not_exercised` / `no_coverage_tool`). `snapshotPath` persists the
// pre-edit content so a signal or crash mid-test can be undone. `onKept` runs
// once an edit is final (the worktree commit) and its return value is
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
      proposedCode: proposal.proposed_code
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
  let testResult;
  try {
    const before = (snap.snapshots.get(proposal.file) || {}).content || '';
    const span = changedSpan(before, fs.readFileSync(path.join(repoRoot, proposal.file), 'utf8'));
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
  const coverage = testResult.coverage || { available: false };

  if (status === 'failed' || status === 'timeout' || status === 'environment_error') {
    snap.restoreAll();
    reverted = true;
    status = status === 'failed' ? 'reverted' : status;
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
