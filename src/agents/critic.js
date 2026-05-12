'use strict';

const { callClaude, extractJsonBlock } = require('../utils/claude-client');

const SYSTEM_PROMPT = [
  'You are a code critic.',
  'You receive a refactoring proposal. Evaluate it and output exactly one JSON object:',
  '{',
  '  "proposal_id": "<issue_id from the proposal>",',
  '  "preserves_semantics": <true|false>,',
  '  "edge_cases": ["<description>", ...],',
  '  "hallucination_flags": ["<any claims not supported by the code>", ...],',
  '  "claude_confidence": <0.0-1.0>,',
  '  "reasoning": "<your evaluation>"',
  '}',
  'Nothing else.'
].join('\n');

function renderProposal(p) {
  return [
    `proposal_id: ${p.issue_id}`,
    `file: ${p.file}`,
    `risk_estimate: ${p.risk_estimate}`,
    `analyzer_reasoning: ${p.reasoning}`,
    '',
    '--- current_code ---',
    p.current_code,
    '',
    '--- proposed_code ---',
    p.proposed_code
  ].join('\n');
}

function normalizeVerdict(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') {
    return {
      proposal_id: fallbackId,
      preserves_semantics: false,
      edge_cases: [],
      hallucination_flags: ['critic returned no parseable verdict'],
      claude_confidence: 0,
      reasoning: 'malformed critic output'
    };
  }
  const conf = Number(raw.claude_confidence);
  return {
    proposal_id: raw.proposal_id || fallbackId,
    preserves_semantics: !!raw.preserves_semantics,
    edge_cases: Array.isArray(raw.edge_cases) ? raw.edge_cases.map(String) : [],
    hallucination_flags: Array.isArray(raw.hallucination_flags) ? raw.hallucination_flags.map(String) : [],
    claude_confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    reasoning: String(raw.reasoning || '')
  };
}

async function runCritic({ proposal, tracker }) {
  const user = renderProposal(proposal);
  let resp;
  try {
    resp = await callClaude({ system: SYSTEM_PROMPT, user });
  } catch (err) {
    return normalizeVerdict({
      preserves_semantics: false,
      claude_confidence: 0,
      reasoning: `critic API error: ${err.message}`
    }, proposal.issue_id);
  }
  if (tracker) tracker.record('critic', resp.usage);

  let parsed = extractJsonBlock(resp.text);
  if (!parsed) {
    // one retry
    try {
      const retry = await callClaude({
        system: SYSTEM_PROMPT,
        user: 'Your last response was not valid JSON. Return ONLY the JSON object, no prose.\n\n' + user
      });
      if (tracker) tracker.record('critic', retry.usage);
      parsed = extractJsonBlock(retry.text);
    } catch (err) { /* swallow */ }
  }
  return normalizeVerdict(parsed, proposal.issue_id);
}

module.exports = { runCritic, SYSTEM_PROMPT, normalizeVerdict };
