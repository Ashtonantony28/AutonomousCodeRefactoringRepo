'use strict';

const { callClaude, extractJsonBlock } = require('../utils/claude-client');
const { v4: uuidv4 } = require('uuid');

const MAX_RETRIES = 2;

// Reflexion (Shinn et al., NeurIPS 2023) + CRITIC (Gou et al., ICLR 2024):
// when a proposal's tests fail, ask Claude to produce a NEW proposal,
// grounded in the failure stderr/stdout — not in its own self-critique.
// Cap retries to avoid runaway loops.

const SYSTEM_PROMPT = [
  'You are a code repair agent.',
  'A previous refactoring proposal was applied and the test suite FAILED.',
  'You receive the original proposal AND the failure output.',
  'Produce a corrected proposal as one JSON object:',
  '{',
  '  "issue_id": "<new uuid>",',
  '  "file": "<relative path>",',
  '  "current_code": "<the exact snippet to replace in the CURRENT file content>",',
  '  "proposed_code": "<your corrected refactor>",',
  '  "reasoning": "<what you changed in response to the failure>",',
  '  "risk_estimate": <0.0-1.0>',
  '}',
  'CRITICAL: current_code MUST exist verbatim in the current file. The failure output is your ground truth — do not invent.',
  'Output the JSON object only. No prose.'
].join('\n');

function renderFailureContext(proposal, failure) {
  return [
    `original_issue_id: ${proposal.issue_id}`,
    `file: ${proposal.file}`,
    '',
    '--- previous current_code ---',
    proposal.current_code,
    '',
    '--- previous proposed_code (FAILED) ---',
    proposal.proposed_code,
    '',
    '--- previous reasoning ---',
    proposal.reasoning || '(none)',
    '',
    '--- failure summary ---',
    `status: ${failure.status || 'unknown'}`,
    `failed_tests: ${failure.failed_tests || 0}`,
    `command: ${failure.test_command || failure.command || 'unknown'}`,
    '',
    '--- stderr (tail) ---',
    (failure.stderr_tail || failure.stderr || '(empty)').slice(0, 2000),
    '',
    '--- stdout (tail) ---',
    (failure.stdout_tail || failure.stdout || '(empty)').slice(0, 2000)
  ].join('\n');
}

async function repair({ proposal, failure, tracker, attemptIdx = 1 }) {
  if (attemptIdx > MAX_RETRIES) return null;

  let resp;
  try {
    resp = await callClaude({
      system: SYSTEM_PROMPT,
      user: renderFailureContext(proposal, failure),
      cacheTag: `reflexion-${attemptIdx}`
    });
  } catch (err) {
    return null;
  }
  if (tracker) tracker.record('analyzer', resp.usage);

  let parsed = extractJsonBlock(resp.text);
  if (parsed && Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed || typeof parsed !== 'object') return null;

  const current = String(parsed.current_code || '');
  const proposed = String(parsed.proposed_code || '');
  if (!current || !proposed || current === proposed) return null;

  const risk = Number(parsed.risk_estimate);
  return {
    issue_id: parsed.issue_id || uuidv4(),
    parent_issue_id: proposal.issue_id,
    attempt: attemptIdx,
    file: proposal.file,
    current_code: current,
    proposed_code: proposed,
    reasoning: `[reflexion attempt ${attemptIdx}] ${parsed.reasoning || ''}`,
    risk_estimate: Number.isFinite(risk) ? Math.max(0, Math.min(1, risk)) : 0.5,
    critic_verdict: null,
    pattern_check_results: [],
    diff_test: null,
    combined_confidence: null,
    test_outcome: null,
    decision_trace: [{
      stage: 'analyzer',
      timestamp: new Date().toISOString(),
      reasoning: `reflexion-repair of ${proposal.issue_id} after failure: ${failure.status}`,
      confidence: 1 - (Number.isFinite(risk) ? risk : 0.5),
      outcome: 'repair_proposed'
    }]
  };
}

module.exports = { repair, MAX_RETRIES, SYSTEM_PROMPT };
