'use strict';

const { callClaude, extractJsonBlock } = require('../utils/claude-client');

// Three personas, run in parallel. The verbal frame nudges each toward a
// distinct error mode (over-eager-approve / nitpicky-reject / security-paranoid),
// which surfaces disagreement we'd otherwise miss with a single critic.
// (DiverseAgentEntropy, EMNLP 2025; SE-Jury 2025; CriticGPT, McAleese 2024.)

const PERSONAS = {
  strict: {
    label: 'strict',
    framing: 'You are a STRICT reviewer who treats refactors as guilty until proven innocent. Flag every plausible behavior change.'
  },
  permissive: {
    label: 'permissive',
    framing: 'You are a PRAGMATIC reviewer who values readability and concision; accept refactors whose intent is clear and whose behavior is "obviously" preserved.'
  },
  security: {
    label: 'security',
    framing: 'You are a SECURITY-MINDED reviewer. Pay special attention to authentication, authorization, input validation, crypto, and error handling. Flag anything that softens a defense.'
  }
};

function systemPromptFor(persona) {
  return [
    persona.framing,
    '',
    'You receive a refactoring proposal. Output exactly one JSON object:',
    '{',
    '  "proposal_id": "<issue_id from the proposal>",',
    '  "preserves_semantics": <true|false>,',
    '  "p_preserves": <0.0-1.0>,',
    '  "edge_cases": ["<description>", ...],',
    '  "hallucination_flags": ["<any claims not supported by the code>", ...],',
    '  "reasoning": "<your evaluation>"',
    '}',
    'p_preserves is your probability (0.0-1.0) that proposed_code preserves the',
    'observable behaviour of current_code (return values, thrown errors, side',
    'effects) for every input. It is NOT your confidence in your own verdict:',
    'a clear behaviour change is p_preserves near 0. Keep it consistent with',
    'preserves_semantics: true means p_preserves > 0.5, false means p_preserves <= 0.5.',
    'edge_cases lists only inputs or situations on which proposed_code behaves',
    'differently from current_code; leave it empty when you know of none. Any',
    'entry blocks the edit.',
    'Nothing else.'
  ].join('\n');
}

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

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function malformedVerdict(fallbackId, persona, reason) {
  return {
    proposal_id: fallbackId,
    persona,
    preserves_semantics: false,
    p_preserves: 0,
    edge_cases: [],
    hallucination_flags: ['critic returned no parseable verdict'],
    reasoning: reason || 'malformed critic output',
    malformed: true
  };
}

// Output is a contract Verdict (src/contracts.js). Legacy outputs that only
// carry `claude_confidence` (confidence in the stated verdict) are mapped to
// P(preserved): c when preserves_semantics is true, 1 - c when false. A
// verdict that says "changes semantics" never contributes more than 0.5.
function normalizeVerdict(raw, fallbackId, persona) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return malformedVerdict(fallbackId, persona);
  const preserves = raw.preserves_semantics === true || raw.preserves_semantics === 'true';
  const pRaw = raw.p_preserves == null ? NaN : Number(raw.p_preserves);
  const legacy = raw.claude_confidence == null ? NaN : Number(raw.claude_confidence);
  let p;
  if (Number.isFinite(pRaw)) p = clamp01(pRaw);
  else if (Number.isFinite(legacy)) p = preserves ? clamp01(legacy) : 1 - clamp01(legacy);
  else return malformedVerdict(raw.proposal_id || fallbackId, persona, 'critic verdict has no p_preserves');
  if (!preserves) p = Math.min(p, 0.5);
  const v = {
    proposal_id: raw.proposal_id || fallbackId,
    persona,
    preserves_semantics: preserves,
    p_preserves: p,
    edge_cases: Array.isArray(raw.edge_cases) ? raw.edge_cases.map(String) : [],
    hallucination_flags: Array.isArray(raw.hallucination_flags) ? raw.hallucination_flags.map(String) : [],
    reasoning: String(raw.reasoning || '')
  };
  if (!Number.isFinite(pRaw)) v.legacy_schema = true;
  return v;
}

async function singleCritic({ proposal, tracker, persona }) {
  const sys = systemPromptFor(persona);
  const user = renderProposal(proposal);
  let parsed;
  try {
    const resp = await callClaude({ system: sys, user, cacheTag: `critic-${persona.label}` });
    if (tracker) tracker.record('critic', resp.usage);
    parsed = extractJsonBlock(resp.text);
    if (!parsed) {
      const retry = await callClaude({
        system: sys,
        user: 'Your last response was not valid JSON. Return ONLY the JSON object, no prose.\n\n' + user,
        cacheTag: `critic-${persona.label}-retry`
      });
      if (tracker) tracker.record('critic', retry.usage);
      parsed = extractJsonBlock(retry.text);
    }
  } catch (err) {
    return malformedVerdict(proposal.issue_id, persona.label, `critic ${persona.label} error: ${err.message}`);
  }
  return normalizeVerdict(parsed, proposal.issue_id, persona.label);
}

function uniq(xs) { return [...new Set(xs)]; }

// Aggregates per-persona Verdicts into a contract JuryVerdict.
// p_preserves is the panel mean. Legacy aliases for consumers not yet
// migrated: claude_confidence (= p_preserves), preserves_semantics
// (strict majority vote), reasoning/edge_cases/hallucination_flags (merged).
function aggregateJury(verdicts, proposalId) {
  const ps = verdicts.map(v => v.p_preserves);
  const approvals = verdicts.map(v => v.preserves_semantics ? 1 : 0);
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const std = Math.sqrt(ps.reduce((a, b) => a + (b - mean) ** 2, 0) / ps.length);
  const approvalRate = approvals.reduce((a, b) => a + b, 0) / approvals.length;
  const pPreserves = Number(mean.toFixed(4));
  return {
    proposal_id: proposalId,
    persona: 'jury',
    panel: verdicts,
    p_preserves: pPreserves,
    agreement: {
      std: Number(std.toFixed(4)),
      unanimous: approvals.every(a => a === approvals[0]),
      approval_rate: approvalRate,
      verbal_entropy: entropy(verdicts.map(v => v.reasoning.slice(0, 120)))
    },
    claude_confidence: pPreserves,
    preserves_semantics: approvalRate > 0.5,
    edge_cases: uniq(verdicts.flatMap(v => v.edge_cases)),
    hallucination_flags: uniq(verdicts.flatMap(v => v.hallucination_flags)),
    reasoning: verdicts.map(v => `[${v.persona}] ${v.reasoning}`).join(' ')
  };
}

async function runCritic({ proposal, tracker, panel = ['strict', 'permissive', 'security'] }) {
  const personas = panel.map(k => PERSONAS[k]).filter(Boolean);
  if (!personas.length) throw new Error(`runCritic: empty panel (${panel.join(',')})`);
  const verdicts = await Promise.all(personas.map(p => singleCritic({ proposal, tracker, persona: p })));
  return aggregateJury(verdicts, proposal.issue_id);
}

// Cheap "is the panel saying the same thing in different words" probe.
// Use cosine over character-trigram bags so we don't need an embedding model.
function entropy(texts) {
  if (texts.length < 2) return 0;
  const sims = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      sims.push(cosineTrigram(texts[i], texts[j]));
    }
  }
  const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;
  return 1 - avgSim; // 0 = perfectly aligned, 1 = disjoint
}

function cosineTrigram(a, b) {
  const A = trigramBag(a), B = trigramBag(b);
  let dot = 0;
  for (const k of Object.keys(A)) if (B[k]) dot += A[k] * B[k];
  const nA = Math.sqrt(Object.values(A).reduce((s, v) => s + v * v, 0));
  const nB = Math.sqrt(Object.values(B).reduce((s, v) => s + v * v, 0));
  if (!nA || !nB) return 0;
  return dot / (nA * nB);
}

function trigramBag(s) {
  const out = {};
  const t = s.toLowerCase();
  for (let i = 0; i + 3 <= t.length; i++) {
    const tri = t.slice(i, i + 3);
    out[tri] = (out[tri] || 0) + 1;
  }
  return out;
}

module.exports = { runCritic, singleCritic, normalizeVerdict, aggregateJury, malformedVerdict, systemPromptFor, PERSONAS, entropy };
