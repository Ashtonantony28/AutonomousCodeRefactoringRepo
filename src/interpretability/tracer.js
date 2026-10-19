'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateDir } = require('../utils/checkpoint');
const { RL_GATE_THRESHOLD } = require('../rl/classifier');

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

// Deterministic root span per proposal, so every step can link to it without
// storing extra state on the proposal.
function rootSpanId(issueId) {
  return crypto.createHash('sha256').update(`proposal:${issueId}`).digest('hex').slice(0, 16);
}

function emitSpan(stage, attrs = {}, { parent_id = null, trace_id = null, start, end, duration_ms } = {}) {
  const span = {
    span_id: spanId(),
    trace_id,
    parent_id,
    name: `${OTEL_OP[stage] || 'execute_tool'} ${OTEL_AGENT_NAME[stage] || stage}`,
    timestamp: end,
    start,
    end,
    attrs: {
      'gen_ai.system': 'anthropic',
      'gen_ai.operation.name': OTEL_OP[stage] || 'execute_tool',
      'gen_ai.agent.name': OTEL_AGENT_NAME[stage] || stage,
      ...attrs
    }
  };
  if (typeof duration_ms === 'number') span.duration_ms = duration_ms;
  return span;
}

function trace(proposal, stage, { reasoning = '', confidence = null, outcome = '', tokens, model, duration_ms, trace_id } = {}) {
  if (!proposal.decision_trace) proposal.decision_trace = [];
  if (!VALID_STAGES.has(stage)) stage = 'rl';
  const attrs = {};
  if (tokens && typeof tokens === 'object') {
    if (tokens.input_tokens != null) attrs['gen_ai.usage.input_tokens'] = tokens.input_tokens;
    if (tokens.output_tokens != null) attrs['gen_ai.usage.output_tokens'] = tokens.output_tokens;
  }
  if (model) attrs['gen_ai.request.model'] = model;
  attrs['gen_ai.outcome'] = String(outcome);

  const endMs = Date.now();
  const hasDuration = typeof duration_ms === 'number' && Number.isFinite(duration_ms);
  const end = new Date(endMs).toISOString();
  const start = hasDuration ? new Date(endMs - Math.max(0, duration_ms)).toISOString() : end;
  const step = {
    stage,
    timestamp: end,
    reasoning: String(reasoning).slice(0, 2000),
    confidence: confidence == null ? null : Number(confidence),
    outcome: String(outcome),
    otel: emitSpan(stage, attrs, {
      parent_id: proposal.issue_id ? rootSpanId(proposal.issue_id) : null,
      trace_id: trace_id || proposal.run_id || null,
      start,
      end,
      duration_ms: hasDuration ? duration_ms : undefined
    })
  };
  if (hasDuration) step.duration_ms = duration_ms;
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
    if (typeof proposal.rl_prediction === 'number' && proposal.rl_prediction >= RL_GATE_THRESHOLD &&
        proposal.critic_verdict && (proposal.critic_verdict.edge_cases || []).length > 0) {
      return 'rl_miss';
    }
    if (claudeConf < 0.5) return 'caught_correctly';
    return 'logic_error';
  }
  return null;
}

// Spans for a run: one root span per proposal (spanning its steps) plus one
// child span per decision_trace step, all stamped with trace_id = run_id.
function runSpans(runId, proposals) {
  const out = [];
  for (const p of proposals || []) {
    const steps = (p.decision_trace || []).filter(s => s && s.otel);
    if (!steps.length) continue;
    const rootId = rootSpanId(p.issue_id);
    const children = steps.map((step) => {
      const o = step.otel;
      const end = o.end || o.timestamp || step.timestamp;
      const start = o.start || end;
      const span = {
        ...o,
        trace_id: runId,
        parent_id: rootId,
        start,
        end,
        attrs: { ...o.attrs, 'proposal.issue_id': p.issue_id, 'proposal.file': p.file }
      };
      const d = typeof o.duration_ms === 'number' ? o.duration_ms : step.duration_ms;
      if (typeof d === 'number') span.duration_ms = d;
      return span;
    });
    const starts = children.map(c => Date.parse(c.start)).filter(Number.isFinite);
    const ends = children.map(c => Date.parse(c.end)).filter(Number.isFinite);
    const start = new Date(starts.length ? Math.min(...starts) : Date.now()).toISOString();
    const end = new Date(ends.length ? Math.max(...ends) : Date.now()).toISOString();
    out.push({
      span_id: rootId,
      trace_id: runId,
      parent_id: null,
      name: 'refactor proposal',
      timestamp: end,
      start,
      end,
      duration_ms: Date.parse(end) - Date.parse(start),
      attrs: {
        'gen_ai.system': 'anthropic',
        'proposal.issue_id': p.issue_id,
        'proposal.file': p.file,
        'proposal.status': p.test_outcome ? p.test_outcome.status : null
      }
    }, ...children);
  }
  return out;
}

function persistRunSpans(runId, proposals) {
  const dir = path.join(stateDir(), 'runs', runId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'spans.ndjson');
  fs.writeFileSync(out, runSpans(runId, proposals).map(s => JSON.stringify(s)).join('\n'));
  return out;
}

module.exports = { trace, classifyFailure, persistRunSpans, runSpans, rootSpanId, OTEL_OP, OTEL_AGENT_NAME, VALID_STAGES };
