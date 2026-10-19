'use strict';

const fs = require('fs');
const path = require('path');
const calibration = require('../rl/calibration');
const { clusterFailures } = require('./clustering');
const { trainProbe, PROBE_FEATURE_NAMES } = require('./probe');
const { RL_GATE_THRESHOLD } = require('../rl/classifier');
const { APPROVAL_THRESHOLD } = require('../rl/reward');

const DEFAULT_DASHBOARD_DIR = path.resolve(__dirname, '..', '..', 'dashboard');

function dashboardDir() {
  return process.env.REFACTOR_DASHBOARD_DIR ? path.resolve(process.env.REFACTOR_DASHBOARD_DIR) : DEFAULT_DASHBOARD_DIR;
}
function dashboardPath() { return path.join(dashboardDir(), 'dashboard.html'); }

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// JSON safe to inline in <script>: no `</script>`, `<!--`, or JS line breaks.
function safeJson(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function domId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_'); }

function criticConfidence(v) {
  if (!v) return null;
  return typeof v.p_preserves === 'number' ? v.p_preserves : v.claude_confidence;
}

function rowClass(status) {
  if (status === 'passed' || status === 'applied_no_tests') return 'row-pass';
  if (status === 'failed' || status === 'reverted' || status === 'apply_failed' ||
      status === 'timeout' || status === 'environment_error') return 'row-fail';
  if (status === 'rl_rejected' || status === 'critic_rejected' || status === 'vetoed') return 'row-skip';
  return 'row-other';
}

function pct(n) { if (n == null || isNaN(n)) return '—'; return (Number(n) * 100).toFixed(1) + '%'; }
function fmtNum(n, d = 3) { if (n == null || isNaN(n)) return '—'; return Number(n).toFixed(d); }

function aggregateStats(session) {
  const props = session.proposals || [];
  const total = props.length;
  let decided = 0, passed = 0, failed = 0, rlRejected = 0, criticRejected = 0;
  let confSum = 0, confN = 0;
  let rlCorrect = 0, rlN = 0;
  for (const p of props) {
    const s = p.test_outcome && p.test_outcome.status;
    if (s === 'passed') passed++;
    if (s === 'failed' || s === 'reverted') failed++;
    if (s === 'rl_rejected') rlRejected++;
    if (s === 'critic_rejected') criticRejected++;
    if (s) decided++;
    if (typeof p.combined_confidence === 'number') { confSum += p.combined_confidence; confN++; }
    if (typeof p.rl_prediction === 'number' && ['passed', 'failed', 'reverted'].includes(s)) {
      rlN++;
      const predictedPass = p.rl_prediction >= RL_GATE_THRESHOLD;
      const actualPass = s === 'passed';
      if (predictedPass === actualPass) rlCorrect++;
    }
  }
  return {
    total, decided, passed, failed, rl_rejected: rlRejected, critic_rejected: criticRejected,
    pass_rate: decided ? passed / decided : 0,
    avg_confidence: confN ? confSum / confN : 0,
    rl_accuracy: rlN ? rlCorrect / rlN : null,
    rl_eval_count: rlN
  };
}

function reliability(session) {
  const xs = [], ys = [];
  for (const p of session.proposals || []) {
    const s = p.test_outcome && p.test_outcome.status;
    if (!['passed', 'failed', 'reverted'].includes(s)) continue;
    if (typeof p.combined_confidence !== 'number') continue;
    xs.push(p.combined_confidence);
    ys.push(s === 'passed' ? 1 : 0);
  }
  if (!xs.length) return null;
  const bins = calibration.reliabilityBins(xs, ys);
  const ece = calibration.expectedCalibrationError(xs, ys);
  return { bins, ece, n: xs.length };
}

function statusOf(p) { return p.test_outcome ? p.test_outcome.status : null; }

// Ground truth where we have it: executed tests, else a divergent diff test.
function knownOutcome(p) {
  const s = statusOf(p);
  if (s === 'passed') return 'passed';
  if (s === 'failed' || s === 'reverted') return 'failed';
  if (p.diff_test && p.diff_test.verdict === 'divergent') return 'failed';
  return null;
}

function criticApproved(p) {
  const s = statusOf(p);
  if (s === 'critic_rejected' || s === 'vetoed') return false;
  if (p.veto && p.veto.vetoed !== false) return false;
  return (p.combined_confidence || 0) >= APPROVAL_THRESHOLD;
}

function agreementMatrix(session) {
  // critic decision (approved / rejected incl. vetoes) x known outcome
  const cells = { tp: 0, fp: 0, fn: 0, tn: 0, approved_untested: 0, rejected_untested: 0, not_approved: 0 };
  for (const p of session.proposals || []) {
    if (!statusOf(p)) continue;
    const approved = criticApproved(p);
    const outcome = knownOutcome(p);
    if (!approved) cells.not_approved++;
    if (outcome == null) { cells[approved ? 'approved_untested' : 'rejected_untested']++; continue; }
    const passed = outcome === 'passed';
    if (approved && passed) cells.tp++;
    else if (approved) cells.fp++;
    else if (passed) cells.fn++;
    else cells.tn++;
  }
  return cells;
}

function probePanel(proposals) {
  let w = null;
  try { w = trainProbe(proposals); } catch { w = null; }
  if (!w) return { trained: false, weights: [] };
  return { trained: true, bias: w.b, weights: PROBE_FEATURE_NAMES.map((name, j) => ({ feature: name, weight: w.w[j] })) };
}

function renderRow(p, idx) {
  const status = p.test_outcome ? p.test_outcome.status : 'pending';
  const klass = rowClass(status);
  const file = htmlEscape(p.file);
  const risk = fmtNum(p.risk_estimate, 2);
  const critic = p.critic_verdict ? fmtNum(criticConfidence(p.critic_verdict), 2) : '—';
  const rlPred = typeof p.rl_prediction === 'number' ? fmtNum(p.rl_prediction, 2) : '—';
  const failClass = p.failure_class ? `<span class="tag tag-${p.failure_class}">${p.failure_class}</span>` : '';
  const repair = p.parent_issue_id ? `<span class="tag tag-repair">repair #${p.attempt || ''}</span>` : '';
  const tier = (p.test_outcome && p.test_outcome.match_tier) ? `<span class="tag tag-${p.test_outcome.match_tier}">${p.test_outcome.match_tier}</span>` : '';
  const trace = (p.decision_trace || []).map(step => `
    <li class="trace-step trace-${htmlEscape(step.stage)}">
      <span class="trace-stage">${htmlEscape(step.stage)}</span>
      <span class="trace-time">${htmlEscape(step.timestamp)}</span>
      <span class="trace-conf">conf=${fmtNum(step.confidence, 2)}</span>
      <span class="trace-outcome">${htmlEscape(step.outcome)}</span>
      <div class="trace-reason">${htmlEscape(step.reasoning)}</div>
    </li>`).join('');
  const checks = (p.pattern_check_results || []).map(c =>
    `<li class="${c.passed ? 'check-pass' : 'check-fail'}"><b>${htmlEscape(c.check_name)}:</b> ${htmlEscape(c.detail)}</li>`
  ).join('');
  const panel = (p.critic_verdict && Array.isArray(p.critic_verdict.panel)) ? `
    <h4>Critic jury</h4>
    <table class="jury">
      <thead><tr><th>persona</th><th>approves</th><th>conf</th><th>reasoning</th></tr></thead>
      <tbody>
        ${p.critic_verdict.panel.map(v => `<tr>
          <td>${htmlEscape(v.persona)}</td>
          <td>${v.preserves_semantics ? '✓' : '✗'}</td>
          <td>${fmtNum(criticConfidence(v), 2)}</td>
          <td>${htmlEscape((v.reasoning || '').slice(0, 240))}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '';
  const diff = p.diff_test && p.diff_test.applicable
    ? `<h4>Differential testing</h4><pre>${htmlEscape(JSON.stringify(p.diff_test, null, 2))}</pre>`
    : '';
  const detailsId = `details-${domId(p.issue_id || idx)}`;
  return `
    <tr class="${klass}" data-toggle="${detailsId}">
      <td>${idx + 1}</td>
      <td title="${file}">${file}</td>
      <td>${risk}</td>
      <td>${critic}</td>
      <td>${fmtNum(p.combined_confidence, 2)}</td>
      <td>${rlPred}</td>
      <td><span class="status status-${htmlEscape(status)}">${htmlEscape(status)}</span> ${failClass}${repair}${tier}</td>
    </tr>
    <tr class="details-row" id="${detailsId}" style="display:none">
      <td colspan="7">
        <div class="details">
          <div class="cols">
            <div class="col">
              <h4>Analyzer reasoning</h4><pre>${htmlEscape(p.reasoning)}</pre>
              <h4>Current code</h4><pre>${htmlEscape(p.current_code)}</pre>
              <h4>Proposed code</h4><pre>${htmlEscape(p.proposed_code)}</pre>
            </div>
            <div class="col">
              ${panel}
              <h4>AST checks</h4>
              <ul class="checks">${checks || '<li>(none)</li>'}</ul>
              ${diff}
              <h4>Decision trace</h4>
              <ol class="trace">${trace || '<li>(empty)</li>'}</ol>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
}

function renderHtml(session) {
  const stats = aggregateStats(session);
  const proposals = (session.proposals || []).slice(-20);
  const rows = proposals.map(renderRow).join('\n');
  const updatedAt = session.updated_at || new Date().toISOString();
  const tokenUsage = session.token_usage || {};
  const saturation = session.context_saturation || {};
  const rel = reliability(session);
  const agree = agreementMatrix(session);
  let clusters = { clusters: [] };
  try { clusters = clusterFailures(session.proposals || []); } catch { /* */ }
  const calibModel = calibration.load();
  const probe = probePanel(session.proposals || []);

  const inline = {
    session: { proposals: session.proposals || [], updated_at: updatedAt },
    reliability: rel,
    agreement: agree,
    clusters,
    calibration: calibModel,
    probe
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Refactor Dashboard — ${htmlEscape(session.run_id || '')}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; margin: 0; padding: 24px; background: #0e1116; color: #e6edf3; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  .meta { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; }
  .stat .label { font-size: 11px; text-transform: uppercase; color: #8b949e; letter-spacing: .5px; }
  .stat .value { font-size: 20px; font-weight: 600; margin-top: 4px; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; }
  .panel h3 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; color: #8b949e; letter-spacing: .5px; }
  canvas { display: block; max-width: 100%; }
  table { width: 100%; border-collapse: collapse; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th, td { padding: 8px 10px; text-align: left; font-size: 13px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { background: #161b22; color: #8b949e; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; }
  tr.row-pass { background: rgba(46, 160, 67, 0.10); }
  tr.row-fail { background: rgba(248, 81, 73, 0.12); }
  tr.row-skip { background: rgba(187, 128, 9, 0.15); }
  tr[data-toggle] { cursor: pointer; }
  tr[data-toggle]:hover { background: rgba(56, 139, 253, 0.15); }
  .status { padding: 2px 8px; border-radius: 12px; font-size: 11px; }
  .status-passed { background: #238636; color: #fff; }
  .status-failed, .status-reverted, .status-apply_failed, .status-timeout, .status-environment_error { background: #da3633; color: #fff; }
  .status-rl_rejected, .status-critic_rejected { background: #9e6a03; color: #fff; }
  .status-dry_run, .status-applied_no_tests { background: #1f6feb; color: #fff; }
  .tag { padding: 1px 6px; border-radius: 8px; font-size: 10px; margin-left: 4px; background: #30363d; }
  .tag-logic_error { background: #da3633; }
  .tag-environment_issue { background: #9e6a03; }
  .tag-caught_correctly { background: #238636; }
  .tag-rl_miss { background: #8957e5; }
  .tag-repair { background: #1f6feb; }
  .tag-fuzzy { background: #6e7681; }
  .tag-whitespace, .tag-indent-shift { background: #8b949e; }
  .agree-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 10px; }
  .agree-cell { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 14px; text-align: center; }
  .agree-cell.tp { background: rgba(46, 160, 67, 0.20); }
  .agree-cell.tn { background: rgba(56, 139, 253, 0.15); }
  .agree-cell.fp { background: rgba(218, 54, 51, 0.30); }
  .agree-cell.fn { background: rgba(159, 109, 4, 0.30); }
  .agree-cell .count { font-size: 22px; font-weight: 700; }
  .agree-cell .lbl { font-size: 10px; color: #c9d1d9; text-transform: uppercase; letter-spacing: .4px; margin-top: 4px; }
  .clusters { list-style: none; padding: 0; margin: 0; }
  .clusters li { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; }
  .clusters .clbl { font-weight: 600; color: #79c0ff; }
  .clusters .csz { color: #8b949e; font-size: 11px; margin-left: 8px; }
  .what-if { font-size: 12px; }
  .what-if label { display: grid; grid-template-columns: 130px 1fr 50px; align-items: center; gap: 8px; margin: 6px 0; }
  .what-if input[type=range] { width: 100%; }
  .what-if .p-pass { font-size: 28px; font-weight: 700; }
  .details { padding: 12px 6px; }
  .details .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .details h4 { margin: 8px 0 6px; font-size: 12px; text-transform: uppercase; color: #8b949e; }
  .details pre { background: #010409; border: 1px solid #30363d; border-radius: 6px; padding: 10px; max-height: 260px; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .jury { font-size: 11px; margin-top: 4px; }
  .jury td { padding: 4px 6px; }
  .checks { padding-left: 18px; font-size: 12px; }
  .check-pass { color: #56d364; }
  .check-fail { color: #ff7b72; }
  .trace { padding-left: 18px; font-size: 12px; }
  .trace-step { margin-bottom: 6px; }
  .trace-stage { font-weight: 600; margin-right: 8px; color: #79c0ff; }
  .trace-time, .trace-conf, .trace-outcome { color: #8b949e; margin-right: 8px; font-size: 11px; }
  .trace-reason { color: #c9d1d9; margin-top: 2px; }
  footer { margin-top: 24px; color: #8b949e; font-size: 12px; }
  .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #6e7681; vertical-align: middle; margin-right: 4px; }
  .live-dot.on { background: #56d364; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
</style>
</head>
<body>
  <h1>Multi-Agent Refactoring — Dashboard <span class="live-dot" id="live-dot"></span><span id="live-text" style="font-size:12px;color:#8b949e">offline</span></h1>
  <main id="app">
  <div class="meta">
    run_id: <code>${htmlEscape(session.run_id || '')}</code> ·
    target: <code>${htmlEscape(session.target_repo || '')}</code> ·
    updated: <code id="updated">${htmlEscape(updatedAt)}</code>
  </div>

  <div class="stats">
    <div class="stat"><div class="label">Total proposals</div><div class="value" id="kpi-total">${stats.total}</div></div>
    <div class="stat"><div class="label">Pass rate</div><div class="value" id="kpi-pass">${pct(stats.pass_rate)}</div></div>
    <div class="stat"><div class="label">Avg confidence</div><div class="value" id="kpi-conf">${pct(stats.avg_confidence)}</div></div>
    <div class="stat"><div class="label">RL accuracy (n=${stats.rl_eval_count})</div><div class="value" id="kpi-rl">${stats.rl_accuracy == null ? '—' : pct(stats.rl_accuracy)}</div></div>
    <div class="stat"><div class="label">Failed</div><div class="value" id="kpi-fail">${stats.failed}</div></div>
    <div class="stat"><div class="label">Critic-rejected</div><div class="value">${stats.critic_rejected}</div></div>
    <div class="stat"><div class="label">RL-rejected</div><div class="value">${stats.rl_rejected}</div></div>
    <div class="stat"><div class="label">Tokens (A/C/E)</div><div class="value">${tokenUsage.analyzer || 0}/${tokenUsage.critic || 0}/${tokenUsage.executor || 0}</div></div>
    <div class="stat"><div class="label">Saturation (max)</div><div class="value">${pct(Math.max(saturation.analyzer || 0, saturation.critic || 0, saturation.executor || 0))}</div></div>
    <div class="stat"><div class="label">ECE</div><div class="value" id="kpi-ece">${rel ? fmtNum(rel.ece, 3) : '—'}</div></div>
  </div>

  <div class="panels">
    <div class="panel">
      <h3>Reliability diagram (calibration)</h3>
      <canvas id="reliability" width="360" height="240"></canvas>
      <div style="font-size:11px;color:#8b949e;margin-top:6px">
        Below the diagonal = overconfident · above = underconfident · dot size ∝ samples per bin
      </div>
    </div>
    <div class="panel">
      <h3>Critic vs. tests (agreement)</h3>
      <div class="agree-grid">
        <div class="agree-cell tp"><div class="count" id="ag-tp">${agree.tp}</div><div class="lbl">approved · passed</div></div>
        <div class="agree-cell fp"><div class="count" id="ag-fp">${agree.fp}</div><div class="lbl">approved · FAILED</div></div>
        <div class="agree-cell fn"><div class="count" id="ag-fn">${agree.fn}</div><div class="lbl">rejected · would have passed</div></div>
        <div class="agree-cell tn"><div class="count" id="ag-tn">${agree.tn}</div><div class="lbl">rejected · would have failed</div></div>
      </div>
      <div style="font-size:11px;color:#8b949e;margin-top:6px">
        not approved (incl. vetoes): <b id="ag-na">${agree.not_approved}</b> ·
        rejected, outcome unknown: <b id="ag-ru">${agree.rejected_untested}</b> ·
        approved, untested: <b id="ag-au">${agree.approved_untested}</b>
      </div>
    </div>
    <div class="panel">
      <h3>What-if · RL gate</h3>
      <div class="what-if">
        <div>predicted p_pass: <span class="p-pass" id="wi-ppass">—</span></div>
        <label>critic_confidence <input id="wi-f0" type="range" min="0" max="1" step="0.01" value="0.7"><span id="wi-v0">0.70</span></label>
        <label>pattern_score    <input id="wi-f1" type="range" min="0" max="1" step="0.01" value="0.7"><span id="wi-v1">0.70</span></label>
        <label>complexity (LOC) <input id="wi-f2" type="range" min="1" max="200" step="1" value="20"><span id="wi-v2">20</span></label>
        <label>files_changed    <input id="wi-f3" type="range" min="1" max="20" step="1" value="1"><span id="wi-v3">1</span></label>
        <label>risk_estimate    <input id="wi-f4" type="range" min="0" max="1" step="0.01" value="0.3"><span id="wi-v4">0.30</span></label>
      </div>
    </div>
    <div class="panel">
      <h3>Probe (diagnostic, never gates)</h3>
      ${probe.trained ? `<table class="jury" id="probe-weights"><thead><tr><th>feature</th><th>weight</th></tr></thead><tbody>
        ${probe.weights.map(x => `<tr><td>${htmlEscape(x.feature)}</td><td>${fmtNum(x.weight, 3)}</td></tr>`).join('')}
      </tbody></table>` : '<div style="color:#8b949e;font-size:12px" id="probe-empty">Needs ≥ 10 executed proposals with both outcomes.</div>'}
    </div>
    <div class="panel">
      <h3>Failure clusters</h3>
      <ul class="clusters" id="cluster-list">
        ${clusters.clusters.length ? clusters.clusters.map(c => `<li><span class="clbl">${htmlEscape(c.label)}</span><span class="csz">n=${c.size}</span></li>`).join('') : '<li style="color:#8b949e">No failure clusters yet.</li>'}
      </ul>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>#</th><th>file</th><th>risk</th><th>critic</th><th>combined</th><th>RL</th><th>outcome</th></tr>
    </thead>
    <tbody id="props-tbody">
      ${rows || '<tr><td colspan="7" style="text-align:center;padding:24px;color:#8b949e">No proposals yet.</td></tr>'}
    </tbody>
  </table>

  <footer>Live when served from <code>node src/interpretability/server.js</code> (SSE, re-rendered per request); otherwise a static snapshot.</footer>
  <script type="application/json" id="inline-data">${safeJson(inline)}</script>
  </main>

<script>
const RL_GATE_THRESHOLD = ${safeJson(RL_GATE_THRESHOLD)};
function readInline(root) {
  const el = (root || document).getElementById('inline-data');
  try { return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; }
}
let INLINE = readInline(document);

function drawReliability(rel) {
  const cnv = document.getElementById('reliability');
  if (!cnv) return;
  const ctx = cnv.getContext('2d');
  const W = cnv.width, H = cnv.height, P = 30;
  ctx.clearRect(0, 0, W, H);
  // axes
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(P, H-P); ctx.lineTo(W-10, H-P); ctx.moveTo(P, H-P); ctx.lineTo(P, 10); ctx.stroke();
  // diagonal
  ctx.strokeStyle = '#6e7681'; ctx.setLineDash([4,4]);
  ctx.beginPath(); ctx.moveTo(P, H-P); ctx.lineTo(W-10, 10); ctx.stroke(); ctx.setLineDash([]);
  if (!rel || !rel.bins) { ctx.fillStyle='#8b949e'; ctx.font='12px sans-serif'; ctx.fillText('no data', W/2-20, H/2); return; }
  // bars: predicted-confidence height = predicted, gap = predicted-actual
  const innerW = W - P - 20, innerH = H - P - 20;
  for (const b of rel.bins) {
    if (!b.n) continue;
    const x = P + b.conf * innerW;
    const y = (H - P) - b.acc * innerH;
    const r = Math.min(8, 3 + Math.sqrt(b.n));
    ctx.fillStyle = '#1f6feb';
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2*Math.PI); ctx.fill();
  }
  // ECE label
  ctx.fillStyle = '#c9d1d9'; ctx.font = '11px sans-serif';
  ctx.fillText('ECE = ' + (rel.ece != null ? rel.ece.toFixed(3) : '—') + '  (n=' + rel.n + ')', P+4, 18);
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function predictPpass(weights, x) {
  if (!weights || !weights.w) return null;
  let z = weights.b;
  for (let j = 0; j < weights.w.length; j++) {
    const xs = (x[j] - weights.means[j]) / (weights.stds[j] || 1);
    z += weights.w[j] * xs;
  }
  return sigmoid(z);
}

function wireWhatIf() {
  const f = [0,1,2,3,4].map(i => document.getElementById('wi-f'+i));
  const v = [0,1,2,3,4].map(i => document.getElementById('wi-v'+i));
  const out = document.getElementById('wi-ppass');
  function read() { return f.map(el => Number(el.value)); }
  function fmt(j) { return j === 2 || j === 3 ? String(read()[j]) : read()[j].toFixed(2); }
  function update() {
    const x = read();
    for (let j = 0; j < 5; j++) v[j].textContent = fmt(j);
    fetch('/rl-weights.json').then(r => r.ok ? r.json() : null).then(w => {
      const p = predictPpass(w, x);
      out.textContent = p == null ? '—' : p.toFixed(3);
      out.style.color = p == null ? '#8b949e' : (p >= RL_GATE_THRESHOLD ? '#56d364' : '#ff7b72');
    }).catch(() => { out.textContent = '—'; });
  }
  for (const el of f) el.addEventListener('input', update);
  update();
}

function wireToggles(open) {
  document.querySelectorAll('tr[data-toggle]').forEach(function (tr) {
    const id = tr.getAttribute('data-toggle');
    const d = document.getElementById(id);
    if (d && open && open.has(id)) d.style.display = 'table-row';
    tr.addEventListener('click', function () {
      if (!d) return;
      d.style.display = d.style.display === 'none' ? 'table-row' : 'none';
    });
  });
}

function init(open) {
  drawReliability(INLINE && INLINE.reliability);
  wireWhatIf();
  wireToggles(open);
}

// Live refresh: fetch the per-request render of '/' and swap #app in place,
// keeping open detail rows and slider positions.
let inflight = false, again = false;
function refresh() {
  if (inflight) { again = true; return; }
  inflight = true;
  fetch(window.location.pathname + '?ts=' + Date.now(), { cache: 'no-store' })
    .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const next = doc.getElementById('app');
      const cur = document.getElementById('app');
      if (!next || !cur) return;
      const open = new Set();
      document.querySelectorAll('tr.details-row').forEach(d => { if (d.style.display !== 'none') open.add(d.id); });
      const sliders = {};
      document.querySelectorAll('.what-if input').forEach(el => { sliders[el.id] = el.value; });
      cur.innerHTML = next.innerHTML;
      for (const id in sliders) { const el = document.getElementById(id); if (el) el.value = sliders[id]; }
      INLINE = readInline(document);
      init(open);
    })
    .catch(() => {})
    .finally(() => { inflight = false; if (again) { again = false; refresh(); } });
}

init();

(function liveOrPoll() {
  const dot = document.getElementById('live-dot');
  const lbl = document.getElementById('live-text');
  if (window.location.protocol === 'file:') { lbl.textContent = 'static snapshot'; return; }
  if (typeof EventSource !== 'undefined') {
    try {
      const es = new EventSource('/events');
      es.onopen = () => { dot.classList.add('on'); lbl.textContent = 'live'; };
      es.addEventListener('state', refresh);
      es.onerror = () => { dot.classList.remove('on'); lbl.textContent = 'reconnecting'; };
      return;
    } catch (e) { /* fall through */ }
  }
  lbl.textContent = 'polling';
  setInterval(refresh, 5000);
}());
</script>
</body>
</html>`;
}

function renderDashboard(session) {
  const dir = dashboardDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const html = renderHtml(session);
  const out = dashboardPath();
  fs.writeFileSync(out, html);
  return out;
}

module.exports = { renderDashboard, renderHtml, aggregateStats, reliability, agreementMatrix, probePanel, safeJson, dashboardDir, dashboardPath };
Object.defineProperty(module.exports, 'DASHBOARD_PATH', { enumerable: true, get: dashboardPath });
