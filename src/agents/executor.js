'use strict';

const { callClaude, extractJsonBlock } = require('../utils/claude-client');
const { FileSnapshot, applyEdit } = require('../runner/reverter');
const { runTests, detectCommand, measureCoverage } = require('../runner/test-runner');
const { trace } = require('../interpretability/tracer');

const SYSTEM_PROMPT = [
  'You are an executor.',
  'You receive an approved refactoring proposal. Output exactly one JSON object:',
  '{',
  '  "proposal_id": "<issue_id>",',
  '  "files_to_modify": ["<relative path>", ...],',
  '  "apply_instructions": "<precise description of what to change>",',
  '  "test_command": "<npm test|pytest|etc>",',
  '  "predicted_outcome": "pass|fail",',
  '  "predicted_reasoning": "<why you think tests will pass or fail>"',
  '}',
  'Nothing else.'
].join('\n');

function renderProposal(p) {
  return [
    `proposal_id: ${p.issue_id}`,
    `file: ${p.file}`,
    `combined_confidence: ${p.combined_confidence}`,
    '',
    '--- current_code ---',
    p.current_code,
    '',
    '--- proposed_code ---',
    p.proposed_code
  ].join('\n');
}

async function planExecution({ proposal, tracker, repoRoot }) {
  const detected = detectCommand(repoRoot);
  let plan;
  try {
    const resp = await callClaude({ system: SYSTEM_PROMPT, user: renderProposal(proposal) });
    if (tracker) tracker.record('executor', resp.usage);
    plan = extractJsonBlock(resp.text);
  } catch (err) {
    plan = null;
  }
  if (!plan || typeof plan !== 'object') {
    plan = {
      proposal_id: proposal.issue_id,
      files_to_modify: [proposal.file],
      apply_instructions: 'replace current_code with proposed_code (executor used fallback plan)',
      test_command: detected ? `${detected.cmd} ${detected.args.join(' ')}` : 'none',
      predicted_outcome: 'pass',
      predicted_reasoning: 'fallback plan; relying on direct anchor replacement'
    };
  }
  if (!Array.isArray(plan.files_to_modify) || plan.files_to_modify.length === 0) {
    plan.files_to_modify = [proposal.file];
  }
  return plan;
}

async function runExecutor({ proposal, tracker, repoRoot }) {
  const tPlan = performance.now();
  const plan = await planExecution({ proposal, tracker, repoRoot });
  proposal.executor_plan = plan;
  trace(proposal, 'executor', {
    reasoning: plan.predicted_reasoning,
    confidence: plan.predicted_outcome === 'pass' ? 0.7 : 0.3,
    outcome: `predicted_${plan.predicted_outcome}`,
    duration_ms: Number((performance.now() - tPlan).toFixed(3))
  });

  const snap = new FileSnapshot(repoRoot);
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
      reverted: true,
      passed_tests: 0,
      failed_tests: 0,
      execution_time_ms: 0,
      coverage_delta: null,
      plan
    };
  }

  const applyDurationMs = Number((performance.now() - tApply).toFixed(3));

  // Test
  let testResult;
  try {
    testResult = await runTests({ repoRoot });
  } catch (err) {
    snap.restoreAll();
    return {
      status: 'environment_error',
      reason: err.message,
      reverted: true,
      passed_tests: 0,
      failed_tests: 0,
      execution_time_ms: 0,
      coverage_delta: null,
      plan
    };
  }

  let status = testResult.status;
  let reverted = false;

  if (status === 'failed' || status === 'timeout' || status === 'environment_error') {
    snap.restoreAll();
    reverted = true;
    status = status === 'failed' ? 'reverted' : status;
  } else if (status === 'no_test_runner') {
    // Keep change but flag — no way to validate
    status = 'applied_no_tests';
  }

  // Coverage (best-effort, only meaningful when tests actually ran)
  let coverage = { available: false };
  if (!reverted && (status === 'passed' || status === 'applied_no_tests')) {
    try {
      coverage = await measureCoverage({ repoRoot, file: proposal.file });
    } catch (err) {
      coverage = { available: false, reason: err.message };
    }
  }

  return {
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
    apply_duration_ms: applyDurationMs,
    plan
  };
}

module.exports = { runExecutor, planExecution, SYSTEM_PROMPT };
