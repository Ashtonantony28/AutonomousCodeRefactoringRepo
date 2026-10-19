'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { trace, classifyFailure, persistRunSpans } = require('../src/interpretability/tracer');
const { freshSession } = require('../src/utils/checkpoint');
const { fakeProposals } = require('./helpers/factories');

test('trace appends an OTel-shaped step', () => {
  const p = fakeProposals()[0];
  const before = p.decision_trace.length;
  const step = trace(p, 'rl', { reasoning: 'gate', confidence: 0.5, outcome: 'ok', tokens: { input_tokens: 100, output_tokens: 50 }, model: 'claude-sonnet-4' });
  assert.strictEqual(p.decision_trace.length, before + 1);
  assert(step.otel && step.otel.attrs['gen_ai.system'] === 'anthropic');
  assert.strictEqual(step.otel.attrs['gen_ai.usage.input_tokens'], 100);
  assert(!('duration_ms' in step));
});

test('trace records optional duration_ms', () => {
  const step = trace({}, 'ast', { outcome: 'ok', duration_ms: 12.5 });
  assert.strictEqual(step.duration_ms, 12.5);
});

test('classifyFailure handles each branch', () => {
  assert.strictEqual(classifyFailure({ test_outcome: { status: 'timeout' }, combined_confidence: 0, critic_verdict: {} }), 'environment_issue');
  assert.strictEqual(classifyFailure({ test_outcome: { status: 'failed' }, combined_confidence: 0.8, critic_verdict: { claude_confidence: 0.85 } }), 'logic_error');
});

test('persistRunSpans writes ndjson under REFACTOR_STATE_DIR', () => {
  const props = fakeProposals();
  for (const p of props) trace(p, 'rl', { outcome: 'ok' });
  const sess = freshSession('/tmp/repo');
  const f = persistRunSpans(sess.run_id, props);
  assert(f.startsWith(path.join(env.stateDir, 'runs')));
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  assert(lines.length > 0);
  assert.strictEqual(JSON.parse(lines[0]).attrs['gen_ai.system'], 'anthropic');
});
