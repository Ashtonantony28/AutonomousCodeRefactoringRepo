'use strict';

// Shared helpers for the AUDIT-9 scripts. Loading this file first points
// REFACTOR_STATE_DIR / REFACTOR_DASHBOARD_DIR at a temp dir (test/helpers/env.js),
// before any src module loads. Fixtures are generated under os.tmpdir() at
// runtime; nothing large is committed. No script makes a Claude API call.

const env = require('../../test/helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const A2 = require('../2/lib');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const src = (p) => path.join(REPO_ROOT, 'src', p);

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `audit9-${tag}-`));
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ } }

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity }).trim();
}

function gitInit(dir) {
  const id = ['-c', 'user.name=audit', '-c', 'user.email=audit@localhost', '-c', 'commit.gpgsign=false'];
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, [...id, 'commit', '-q', '-m', 'fixture']);
}

function write(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function pct(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1] };
}

function fmt(x, d = 0) { return x == null || Number.isNaN(x) ? '-' : Number(x).toFixed(d); }

function row(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i] || 10)).join(' ');
}

// Longest gap between 10 ms ticks of the main thread while `fn` runs.
async function withStall(fn, intervalMs = 10) {
  let last = performance.now(), max = 0;
  const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - intervalMs); last = n; }, intervalMs);
  try {
    const t0 = performance.now();
    const r = await fn();
    return { r, ms: performance.now() - t0, stall: max };
  } finally {
    clearInterval(t);
  }
}

// N busy-looping child processes (CPU contention), killed by the returned fn.
function contend(n) {
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  return () => kids.forEach(k => { try { k.kill('SIGKILL'); } catch { /* */ } });
}

function rssMb() { return process.memoryUsage().rss / 1048576; }

function hwmMb() {
  try {
    const m = /VmHWM:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    return m ? Number(m[1]) / 1024 : NaN;
  } catch { return NaN; }
}

module.exports = { ...A2, env, REPO_ROOT, src, tmpDir, rm, git, gitInit, write, pct, stats, fmt, row, withStall, contend, rssMb, hwmMb };
