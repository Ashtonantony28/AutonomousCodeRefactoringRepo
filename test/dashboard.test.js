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

function inlineJson(html) {
  const m = html.match(/<script type="application\/json" id="inline-data">([\s\S]*?)<\/script>/);
  assert(m, 'inline data script present');
  return m[1];
}

test('proposal containing </script> renders inert and inline data round-trips', () => {
  const evil = '</script><script>window.__x=1</script> <!-- & \u2028 \u2029 >';
  const sess = freshSession('/tmp/repo');
  const p = fakeProposals(1)[0];
  p.proposed_code = evil;
  p.file = 'evil</script>.js';
  sess.proposals = [p];
  const html = renderHtml(sess);
  const raw = inlineJson(html);
  assert(!/<\/script/i.test(raw), 'no raw </script> inside inline JSON');
  assert(!/[<>&\u2028\u2029]/.test(raw), 'no unescaped <, >, &, U+2028, U+2029');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.session.proposals[0].proposed_code, evil);
  assert.deepStrictEqual(parsed.session.proposals, JSON.parse(JSON.stringify(sess.proposals)));
  assert(!html.includes('<script>window.__x=1'), 'payload never appears as markup');
});

test('agreement grid counts critic-rejected and vetoed proposals as not approved', () => {
  const props = fakeProposals(6);
  props[0].test_outcome = { status: 'critic_rejected' };
  props[0].combined_confidence = 0.3;
  props[0].diff_test = { applicable: true, verdict: 'divergent', runs: 10, counterexample: [1], duration_ms: 5 };
  props[1].test_outcome = { status: 'vetoed' };
  props[1].veto = { check_name: 'error_handling_removal' };
  props[1].combined_confidence = 0.9;
  props[2].test_outcome = { status: 'critic_rejected' };
  props[2].combined_confidence = 0.2;
  const a = agreementMatrix({ proposals: props });
  assert.strictEqual(a.not_approved, 4); // 3 rejected/vetoed + fixture #3 (executed, conf 0.42)
  assert.strictEqual(a.tn, 2, 'divergent diff test is a known failure');
  assert.strictEqual(a.rejected_untested, 2);
  assert(a.tp > 0);
  const html = renderHtml({ proposals: props });
  assert(html.includes('id="ag-tn">2<'));
  assert(html.includes('id="ag-na">4<'));
});

test('rl_accuracy uses the RL gate threshold', () => {
  const { RL_GATE_THRESHOLD } = require('../src/rl/classifier');
  const props = fakeProposals(2);
  props[0].test_outcome = { status: 'passed' };
  props[0].rl_prediction = (RL_GATE_THRESHOLD + 0.5) / 2;
  props[1].test_outcome = { status: 'failed' };
  props[1].rl_prediction = RL_GATE_THRESHOLD / 2;
  const s = aggregateStats({ proposals: props });
  assert.strictEqual(s.rl_accuracy, 1);
});

test('probe weights are shown when trainable', () => {
  const html = renderHtml({ proposals: fakeProposals() });
  assert(html.includes('id="probe-weights"'));
  assert(html.includes('edge_cases'));
  const empty = renderHtml({ proposals: fakeProposals(3) });
  assert(empty.includes('id="probe-empty"'));
});
