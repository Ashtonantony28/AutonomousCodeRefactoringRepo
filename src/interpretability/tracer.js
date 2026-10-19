'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateDir } = require('../utils/checkpoint');

const VALID_STAGES = new Set(['analyzer', 'critic', 'ast', 'rl', 'executor']);

// Map our stages to OpenTelemetry GenAI semantic-conventions operation
// names (https://opentelemetry.io/docs/specs/semconv/gen-ai/). This gives
// our trace fields a vocabulary that any OTel-compatible backend ingests.
const OTEL_OP = {
  analyzer: 'invoke_agent',
  critic:   'invoke_agent',
  ast:      'execute_tool',
  rl:       'execute_tool',
  executor: 'invoke_agent'
};

const OTEL_AGENT_NAME = {
  analyzer: 'analyzer-agent',
  critic:   'critic-agent',
  ast:      'ast-checker',
  rl:       'rl-gate',
  executor: 'executor-agent'
};

function spanId() {
  return crypto.randomBytes(8).toString('hex');
}

function emitSpan(stage, attrs = {}) {
  const id = spanId();
  return {
    span_id: id,
    parent_id: attrs.parent_id || null,
    name: `${OTEL_OP[stage] || 'execute_tool'} ${OTEL_AGENT_NAME[stage] || stage}`,
    timestamp: new Date().toISOString(),
    attrs: {
      'gen_ai.system': 'anthropic',
      'gen_ai.operation.name': OTEL_OP[stage] || 'execute_tool',
      'gen_ai.agent.name': OTEL_AGENT_NAME[stage] || stage,
      ...attrs
    }
  };
}

function trace(proposal, stage, { reasoning = '', confidence = null, outcome = '', tokens, model, duration_ms } = {}) {
  if (!proposal.decision_trace) proposal.decision_trace = [];
  if (!VALID_STAGES.has(stage)) stage = 'rl';
  const attrs = {};
  if (tokens && typeof tokens === 'object') {
    if (tokens.input_tokens != null) attrs['gen_ai.usage.input_tokens'] = tokens.input_tokens;
    if (tokens.output_tokens != null) attrs['gen_ai.usage.output_tokens'] = tokens.output_tokens;
  }
  if (model) attrs['gen_ai.request.model'] = model;
  attrs['gen_ai.outcome'] = String(outcome);

  const step = {
    stage,
    timestamp: new Date().toISOString(),
    reasoning: String(reasoning).slice(0, 2000),
    confidence: confidence == null ? null : Number(confidence),
    outcome: String(outcome),
    otel: emitSpan(stage, attrs)
  };
  if (typeof duration_ms === 'number' && Number.isFinite(duration_ms)) step.duration_ms = duration_ms;
  proposal.decision_trace.push(step);
  return step;
}

function classifyFailure(proposal) {
  const status = proposal.test_outcome ? proposal.test_outcome.status : null;
  const conf = proposal.combined_confidence || 0;
  const claudeConf = proposal.critic_verdict ? (proposal.critic_verdict.claude_confidence || 0) : 0;
  if (status === 'timeout' || status === 'environment_error' || status === 'apply_failed') {
    return 'environment_issue';
  }
  if (status === 'failed' || status === 'reverted') {
    if (claudeConf > 0.7) return 'logic_error';
    if (typeof proposal.rl_prediction === 'number' && proposal.rl_prediction >= 0.4 &&
        proposal.critic_verdict && (proposal.critic_verdict.edge_cases || []).length > 0) {
      return 'rl_miss';
    }
    if (claudeConf < 0.5) return 'caught_correctly';
    return 'logic_error';
  }
  return null;
}

// Optional: append the spans to a per-run NDJSON file, OTel-style.
function persistRunSpans(runId, proposals) {
  const dir = path.join(stateDir(), 'runs', runId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'spans.ndjson');
  const lines = [];
  for (const p of proposals) {
    for (const step of (p.decision_trace || [])) {
      if (!step.otel) continue;
      lines.push(JSON.stringify({
        ...step.otel,
        attrs: { ...step.otel.attrs, 'proposal.issue_id': p.issue_id, 'proposal.file': p.file }
      }));
    }
  }
  fs.writeFileSync(out, lines.join('\n'));
  return out;
}

module.exports = { trace, classifyFailure, persistRunSpans, OTEL_OP, OTEL_AGENT_NAME, VALID_STAGES };
