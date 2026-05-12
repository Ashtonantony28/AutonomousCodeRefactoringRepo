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
    '  "edge_cases": ["<description>", ...],',
    '  "hallucination_flags": ["<any claims not supported by the code>", ...],',
    '  "claude_confidence": <0.0-1.0>,',
    '  "reasoning": "<your evaluation>"',
    '}',
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

function normalizeVerdict(raw, fallbackId, persona) {
  if (!raw || typeof raw !== 'object') {
    return {
      proposal_id: fallbackId,
      persona,
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
    persona,
    preserves_semantics: !!raw.preserves_semantics,
    edge_cases: Array.isArray(raw.edge_cases) ? raw.edge_cases.map(String) : [],
    hallucination_flags: Array.isArray(raw.hallucination_flags) ? raw.hallucination_flags.map(String) : [],
    claude_confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    reasoning: String(raw.reasoning || '')
  };
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
    return normalizeVerdict({ preserves_semantics: false, claude_confidence: 0, reasoning: `critic ${persona.label} error: ${err.message}` }, proposal.issue_id, persona.label);
  }
  return normalizeVerdict(parsed, proposal.issue_id, persona.label);
}

// Returns a SINGLE composite verdict shaped like the original critic
// (so callers and the orchestrator don't need to change), but with an
// extra `panel` array of per-persona verdicts and an `agreement` block.
async function runCritic({ proposal, tracker, panel = ['strict', 'permissive', 'security'] }) {
  const personas = panel.map(k => PERSONAS[k]).filter(Boolean);
  const verdicts = await Promise.all(personas.map(p => singleCritic({ proposal, tracker, persona: p })));

  const confidences = verdicts.map(v => v.claude_confidence);
  const approvals = verdicts.map(v => v.preserves_semantics ? 1 : 0);
  const meanConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const stdConf = Math.sqrt(confidences.reduce((a, b) => a + (b - meanConf) ** 2, 0) / confidences.length);
  const approvalAgreement = approvals.every(a => a === approvals[0]); // unanimous?
  const approvalRate = approvals.reduce((a, b) => a + b, 0) / approvals.length;
  const verbalEntropy = entropy(verdicts.map(v => v.reasoning.slice(0, 120)));

  // Pick the "decisive" verdict to surface as the primary one: the
  // persona whose confidence is closest to the mean. This keeps the
  // contract with downstream code unchanged.
  const primary = verdicts
    .map(v => ({ v, delta: Math.abs(v.claude_confidence - meanConf) }))
    .sort((a, b) => a.delta - b.delta)[0].v;

  return {
    ...primary,
    panel: verdicts,
    agreement: {
      mean_confidence: meanConf,
      std_confidence: stdConf,
      unanimous_approval: approvalAgreement,
      approval_rate: approvalRate,
      verbal_entropy: verbalEntropy
    }
  };
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

module.exports = { runCritic, singleCritic, normalizeVerdict, systemPromptFor, PERSONAS, entropy };
