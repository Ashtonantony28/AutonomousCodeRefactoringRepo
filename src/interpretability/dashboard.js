'use strict';

const fs = require('fs');
const path = require('path');

const DASHBOARD_DIR = path.resolve(__dirname, '..', '..', 'dashboard');
const DASHBOARD_PATH = path.join(DASHBOARD_DIR, 'dashboard.html');

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rowClass(status) {
  if (status === 'passed' || status === 'applied_no_tests') return 'row-pass';
  if (status === 'failed' || status === 'reverted' || status === 'apply_failed' ||
      status === 'timeout' || status === 'environment_error') return 'row-fail';
  if (status === 'rl_rejected' || status === 'critic_rejected') return 'row-skip';
  return 'row-other';
}

function pct(n) {
  if (n == null || isNaN(n)) return '—';
  return (Number(n) * 100).toFixed(1) + '%';
}

function fmtNum(n, d = 3) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(d);
}

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
    if (typeof p.rl_prediction === 'number' && (s === 'passed' || s === 'failed' || s === 'reverted')) {
      rlN++;
      const predictedPass = p.rl_prediction >= 0.5;
      const actualPass = s === 'passed';
      if (predictedPass === actualPass) rlCorrect++;
    }
  }
  const passRate = decided ? passed / decided : 0;
  return {
    total, decided, passed, failed, rl_rejected: rlRejected, critic_rejected: criticRejected,
    pass_rate: passRate,
    avg_confidence: confN ? confSum / confN : 0,
    rl_accuracy: rlN ? rlCorrect / rlN : null,
    rl_eval_count: rlN
  };
}

function renderRow(p, idx) {
  const status = p.test_outcome ? p.test_outcome.status : 'pending';
  const klass = rowClass(status);
  const file = htmlEscape(p.file);
  const risk = fmtNum(p.risk_estimate, 2);
  const critic = p.critic_verdict ? fmtNum(p.critic_verdict.claude_confidence, 2) : '—';
  const rlPred = typeof p.rl_prediction === 'number' ? fmtNum(p.rl_prediction, 2) : '—';
  const failClass = p.failure_class ? `<span class="tag tag-${p.failure_class}">${p.failure_class}</span>` : '';
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
  const detailsId = `details-${idx}`;
  return `
    <tr class="${klass}" data-toggle="${detailsId}">
      <td>${idx + 1}</td>
      <td title="${file}">${file}</td>
      <td>${risk}</td>
      <td>${critic}</td>
      <td>${fmtNum(p.combined_confidence, 2)}</td>
      <td>${rlPred}</td>
      <td><span class="status status-${htmlEscape(status)}">${htmlEscape(status)}</span> ${failClass}</td>
    </tr>
    <tr class="details-row" id="${detailsId}" style="display:none">
      <td colspan="7">
        <div class="details">
          <div class="cols">
            <div class="col">
              <h4>Analyzer reasoning</h4>
              <pre>${htmlEscape(p.reasoning)}</pre>
              <h4>Current code</h4>
              <pre>${htmlEscape(p.current_code)}</pre>
              <h4>Proposed code</h4>
              <pre>${htmlEscape(p.proposed_code)}</pre>
            </div>
            <div class="col">
              <h4>Critic verdict</h4>
              <pre>${htmlEscape(JSON.stringify(p.critic_verdict || {}, null, 2))}</pre>
              <h4>AST checks</h4>
              <ul class="checks">${checks || '<li>(none)</li>'}</ul>
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
  .details { padding: 12px 6px; }
  .details .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .details h4 { margin: 8px 0 6px; font-size: 12px; text-transform: uppercase; color: #8b949e; }
  .details pre { background: #010409; border: 1px solid #30363d; border-radius: 6px; padding: 10px; max-height: 260px; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .checks { padding-left: 18px; font-size: 12px; }
  .check-pass { color: #56d364; }
  .check-fail { color: #ff7b72; }
  .trace { padding-left: 18px; font-size: 12px; }
  .trace-step { margin-bottom: 6px; }
  .trace-stage { font-weight: 600; margin-right: 8px; color: #79c0ff; }
  .trace-time, .trace-conf, .trace-outcome { color: #8b949e; margin-right: 8px; font-size: 11px; }
  .trace-reason { color: #c9d1d9; margin-top: 2px; }
  footer { margin-top: 24px; color: #8b949e; font-size: 12px; }
</style>
</head>
<body>
  <h1>Multi-Agent Refactoring — Dashboard</h1>
  <div class="meta">
    run_id: <code>${htmlEscape(session.run_id || '')}</code> ·
    target: <code>${htmlEscape(session.target_repo || '')}</code> ·
    updated: <code id="updated">${htmlEscape(updatedAt)}</code>
  </div>

  <div class="stats">
    <div class="stat"><div class="label">Total proposals</div><div class="value">${stats.total}</div></div>
    <div class="stat"><div class="label">Pass rate</div><div class="value">${pct(stats.pass_rate)}</div></div>
    <div class="stat"><div class="label">Avg confidence</div><div class="value">${pct(stats.avg_confidence)}</div></div>
    <div class="stat"><div class="label">RL accuracy (n=${stats.rl_eval_count})</div><div class="value">${stats.rl_accuracy == null ? '—' : pct(stats.rl_accuracy)}</div></div>
    <div class="stat"><div class="label">Failed</div><div class="value">${stats.failed}</div></div>
    <div class="stat"><div class="label">Critic-rejected</div><div class="value">${stats.critic_rejected}</div></div>
    <div class="stat"><div class="label">RL-rejected</div><div class="value">${stats.rl_rejected}</div></div>
    <div class="stat"><div class="label">Tokens (A/C/E)</div><div class="value">${tokenUsage.analyzer || 0}/${tokenUsage.critic || 0}/${tokenUsage.executor || 0}</div></div>
    <div class="stat"><div class="label">Saturation (max)</div><div class="value">${pct(Math.max(saturation.analyzer || 0, saturation.critic || 0, saturation.executor || 0))}</div></div>
  </div>

  <table>
    <thead>
      <tr><th>#</th><th>file</th><th>risk</th><th>critic</th><th>combined</th><th>RL</th><th>outcome</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7" style="text-align:center;padding:24px;color:#8b949e">No proposals yet.</td></tr>'}
    </tbody>
  </table>

  <footer>Auto-refreshes every 30s while the session updates. Click any row for the full decision trace.</footer>

<script>
  (function () {
    document.querySelectorAll('tr[data-toggle]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var id = tr.getAttribute('data-toggle');
        var d = document.getElementById(id);
        if (!d) return;
        d.style.display = d.style.display === 'none' ? 'table-row' : 'none';
      });
    });
    var lastUpdated = ${JSON.stringify(updatedAt)};
    setInterval(function () {
      fetch(window.location.pathname + '?ts=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.text(); })
        .then(function (html) {
          var m = html.match(/id="updated">([^<]+)</);
          if (m && m[1] && m[1] !== lastUpdated) { window.location.reload(); }
        })
        .catch(function () {});
    }, 30000);
  }());
</script>
</body>
</html>`;
}

function renderDashboard(session) {
  if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
  const html = renderHtml(session);
  fs.writeFileSync(DASHBOARD_PATH, html);
  return DASHBOARD_PATH;
}

module.exports = { renderDashboard, renderHtml, aggregateStats, DASHBOARD_PATH };
