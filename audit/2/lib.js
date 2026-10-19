'use strict';

// Shared helpers for the AUDIT-2 load scripts. Everything is generated under
// os.tmpdir(); nothing is written inside the repository.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const src = (p) => path.join(REPO_ROOT, 'src', p);

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `audit2-${tag}-`));
}

// Isolated state/dashboard dirs. Must run before any src module is required.
function isolateState(tag = 'state') {
  const root = tmpDir(tag);
  process.env.REFACTOR_STATE_DIR = path.join(root, 'state');
  process.env.REFACTOR_DASHBOARD_DIR = path.join(root, 'dashboard');
  return root;
}

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function fnText(i, j) {
  return `function f${i}_${j}(a, b) {\n  const t${j} = a * ${j} + b;\n  return t${j};\n}\n`;
}

const TEST_SCRIPTS = {
  // ~instant pass
  fast: "console.log('1 passing'); process.exit(0);",
  // slow suite: SLOW_MS (default 20 s)
  slow: "setTimeout(() => { console.log('1 passing'); }, Number(process.env.AUDIT_SLOW_MS || 20000));",
  // hangs forever with a same-group child (should be killed by the timeout)
  hang: "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000);",
  // passes immediately, but leaves a daemon that called setsid() (new session /
  // process group) and inherited stdout/stderr, e.g. a test that starts a
  // background server with { detached: true, stdio: 'inherit' }.
  'hang-escape': "const c = require('child_process').spawn('sleep', [String(process.env.AUDIT_DAEMON_S || 90)], { detached: true, stdio: 'inherit' }); c.unref(); console.log('1 passing'); process.exit(0);"
};

// 500-file JS repo: deep directories (up to `depth`), sizes up to maxBytes
// (kept under file-discovery's 200_000-byte cut-off), a widely used helper
// `normalize` in src/core/normalize.js called from every file, a git commit.
function genRepo({ dir = tmpDir('repo'), files = 500, maxBytes = 199_000, bigFiles = 50, depth = 12, test = 'fast', seed = 7 } = {}) {
  const r = rng(seed);
  fs.mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'audit2-load', version: '1.0.0', private: true, scripts: { test: 'node test/run.js' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'test', 'run.js'), TEST_SCRIPTS[test] + '\n');
  fs.writeFileSync(path.join(dir, 'src', 'core', 'normalize.js'),
    "'use strict';\nfunction normalize(a, b) {\n  const s = Number(a) + Number(b);\n  return s;\n}\nmodule.exports = { normalize };\n");
  const meta = [];
  for (let i = 0; i < files; i++) {
    const d = 1 + (i % depth);
    const segs = [];
    for (let k = 0; k < d; k++) segs.push(`d${k}_${(i + k) % 7}`);
    const rel = path.join('src', ...segs, `mod_${i}.js`);
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const target = i < bigFiles ? maxBytes - 2000 : Math.floor(1000 + r() * 40_000);
    const up = path.relative(path.dirname(abs), path.join(dir, 'src', 'core', 'normalize')).split(path.sep).join('/');
    let body = `'use strict';\nconst { normalize } = require('${up.startsWith('.') ? up : './' + up}');\n`;
    body += `function useNormalize${i}(a, b) {\n  return normalize(a, b) + ${i};\n}\n`;
    let j = 0;
    const names = [`useNormalize${i}`];
    while (body.length + 200 < target) { body += fnText(i, j); names.push(`f${i}_${j}`); j++; }
    // module.exports omitted on purpose for big files (thousands of names); the
    // diff-test sandbox resolves top-level functions through eval capture.
    body += `module.exports = { useNormalize${i}, f${i}_0 };\n`;
    fs.writeFileSync(abs, body);
    meta.push({ rel: rel.split(path.sep).join('/'), i, fns: j, bytes: body.length });
  }
  return { dir, meta };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitInit(dir) {
  const id = ['-c', 'user.name=audit', '-c', 'user.email=audit@localhost', '-c', 'commit.gpgsign=false'];
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, [...id, 'commit', '-q', '-m', 'load fixture']);
}

// Behaviour-preserving "inline the temporary" proposals spread over files.
function inlineProposal(m, j) {
  return {
    issue_id: `audit-${m.i}-${j}`,
    file: m.rel,
    current_code: `function f${m.i}_${j}(a, b) {\n  const t${j} = a * ${j} + b;\n  return t${j};\n}`,
    proposed_code: `function f${m.i}_${j}(a, b) {\n  return a * ${j} + b;\n}`,
    reasoning: 'inline temporary',
    risk_estimate: 0.1,
    critic_verdict: null, pattern_check_results: [], diff_test: null,
    combined_confidence: null, test_outcome: null, decision_trace: []
  };
}

// Signature change of the helper used by every file: triggers the repo-wide
// call-site scan in the AST signature_drift check.
function driftProposal() {
  return {
    issue_id: 'audit-drift-normalize',
    file: 'src/core/normalize.js',
    current_code: 'function normalize(a, b) {\n  const s = Number(a) + Number(b);\n  return s;\n}',
    proposed_code: 'function normalize(a, b, ...rest) {\n  return Number(a) + Number(b);\n}',
    reasoning: 'inline temporary; accept (ignored) extra arguments',
    risk_estimate: 0.3,
    critic_verdict: null, pattern_check_results: [], diff_test: null,
    combined_confidence: null, test_outcome: null, decision_trace: []
  };
}

function makeProposals(meta, n) {
  const out = [];
  // Half on the largest files, half on small ones.
  const big = meta.filter(m => m.bytes > 150_000);
  const small = meta.filter(m => m.bytes <= 150_000 && m.fns > 2);
  for (let k = 0; out.length < n; k++) {
    const pool = !small.length ? big : !big.length ? small : (k % 2 === 0 ? big : small);
    const m = pool[Math.floor(k / (pool === big && small.length ? 2 : pool === small && big.length ? 2 : 1)) % pool.length];
    out.push(inlineProposal(m, Math.min(m.fns - 1, 1 + (k % Math.max(1, m.fns - 1)))));
  }
  return out;
}

function approvingCritic() {
  // Reasoning differs per persona: identical texts make critic.entropy()
  // return -2.2e-16 and trip the JuryVerdict contract (see AUDIT-2 L-notes).
  return async ({ system, user }) => {
    const id = (/proposal_id: (\S+)/.exec(user) || [])[1] || 'x';
    const who = /STRICT/.test(system) ? 'strict reviewer' : /SECURITY/.test(system) ? 'security reviewer' : 'pragmatic reviewer';
    return { proposal_id: id, preserves_semantics: true, p_preserves: 0.9, edge_cases: [], hallucination_flags: [], reasoning: `${who}: inlining a temporary keeps behaviour` };
  };
}

function pct(sorted, q) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1], total: sum };
}

function fmt(x, d = 1) { return x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d); }

function procStatus(pid = 'self') {
  const out = {};
  try {
    const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    for (const k of ['VmHWM', 'VmRSS', 'Threads']) {
      const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(txt);
      if (m) out[k] = Number(m[1]);
    }
  } catch { /* */ }
  try { out.fds = fs.readdirSync(`/proc/${pid}/fd`).length; } catch { /* */ }
  return out;
}

// Wrap a function property on a module's exports, recording durations.
function timeExport(mod, name, bucket, { async = false } = {}) {
  const orig = mod[name];
  mod[name] = async
    ? async function (...a) { const t = performance.now(); try { return await orig.apply(this, a); } finally { bucket.push(performance.now() - t); } }
    : function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { bucket.push(performance.now() - t); } };
  return () => { mod[name] = orig; };
}

// Main-thread stall detector: largest gap between 10 ms ticks.
function stallMonitor(intervalMs = 10) {
  let last = performance.now();
  const gaps = [];
  const t = setInterval(() => { const n = performance.now(); gaps.push(n - last - intervalMs); last = n; }, intervalMs);
  t.unref();
  return { stop() { clearInterval(t); return summarize(gaps.map(g => Math.max(0, g))); } };
}

module.exports = {
  REPO_ROOT, src, tmpDir, isolateState, genRepo, gitInit, git, makeProposals, inlineProposal, driftProposal,
  approvingCritic, summarize, pct, fmt, procStatus, timeExport, stallMonitor, TEST_SCRIPTS, fnText
};
