'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { renderHtml, renderDashboard, aggregateStats, reliability, agreementMatrix, DASHBOARD_PATH } = require('../src/interpretability/dashboard');
const { freshSession } = require('../src/utils/checkpoint');
const { fakeProposals } = require('./helpers/factories');

test('renders HTML with reliability + agreement panels', () => {
  const sess = freshSession('/tmp/repo');
  sess.proposals = fakeProposals().slice(0, 5);
  const html = renderHtml(sess);
  assert(html.includes('Reliability diagram'));
  assert(html.includes('Critic vs. tests'));
  assert(html.includes('What-if'));
});

test('renderDashboard writes under REFACTOR_DASHBOARD_DIR', () => {
  const sess = freshSession('/tmp/repo');
  const out = renderDashboard(sess);
  assert.strictEqual(out, path.join(env.dashboardDir, 'dashboard.html'));
  assert.strictEqual(DASHBOARD_PATH, out);
  assert(fs.existsSync(out));
});

test('aggregateStats computes pass_rate', () => {
  const stats = aggregateStats({ proposals: fakeProposals(), token_usage: {}, context_saturation: {} });
  assert(stats.pass_rate > 0 && stats.pass_rate < 1);
});

test('reliability builds bins', () => {
  const r = reliability({ proposals: fakeProposals() });
  assert(r && Array.isArray(r.bins) && typeof r.ece === 'number');
});

test('agreementMatrix counts 4 cells', () => {
  const a = agreementMatrix({ proposals: fakeProposals() });
  assert(typeof a.tp === 'number' && typeof a.fp === 'number');
});
