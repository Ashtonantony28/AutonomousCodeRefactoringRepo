'use strict';

// AUDIT-4: per-file and per-target-directory coverage from Node's built-in
// coverage (lcov reporter), compared with the PLAN.md target (>= 85% lines).
//
//   node audit/4/coverage.js            # runs the suite with coverage, then reports
//   node audit/4/coverage.js lcov.info  # reports an existing lcov file
//
// Node's runner merges coverage from test-file subprocesses (and from child
// node processes that inherit NODE_V8_COVERAGE, e.g. the SIGINT CLI test), but
// never from worker_threads: src/validation/diff-sandbox-worker.js is absent
// from its report. `audit/4/worker-coverage.js` measures that file separately.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGETS = ['src/validation', 'src/runner', 'src/rl', 'src/orchestrator.js'];
const TARGET_PCT = 85;

function runSuite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit4-cov-'));
  const out = path.join(tmp, 'lcov.info');
  const tests = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage',
    '--test-reporter=lcov', `--test-reporter-destination=${out}`,
    '--test-reporter=dot', '--test-reporter-destination=stdout', ...tests],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  if (r.status !== 0) { process.stdout.write(r.stdout); process.stderr.write(r.stderr); }
  return out;
}

function parseLcov(file) {
  const recs = [];
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('SF:')) cur = { file: path.relative(ROOT, line.slice(3)), lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0, uncovered: [] };
    else if (line.startsWith('DA:')) { const [n, c] = line.slice(3).split(',').map(Number); if (c === 0) cur.uncovered.push(n); }
    else if (line.startsWith('LF:')) cur.lf = +line.slice(3);
    else if (line.startsWith('LH:')) cur.lh = +line.slice(3);
    else if (line.startsWith('BRF:')) cur.brf = +line.slice(4);
    else if (line.startsWith('BRH:')) cur.brh = +line.slice(4);
    else if (line.startsWith('FNF:')) cur.fnf = +line.slice(4);
    else if (line.startsWith('FNH:')) cur.fnh = +line.slice(4);
    else if (line === 'end_of_record' && cur) { recs.push(cur); cur = null; }
  }
  return recs;
}

const pct = (h, f) => (f ? (100 * h / f).toFixed(2) : '  n/a');
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function main() {
  const lcov = process.argv[2] || runSuite();
  const recs = parseLcov(lcov).filter(r => r.file.startsWith('src/'));
  const allSrc = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else if (a.endsWith('.js')) allSrc.push(path.relative(ROOT, a)); } })(path.join(ROOT, 'src'));
  const missing = allSrc.filter(f => !recs.some(r => r.file === f));

  console.log(`${pad('file', 38)} ${lpad('lines', 16)} ${lpad('branches', 16)} ${lpad('funcs', 14)}`);
  for (const r of recs.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`${pad(r.file, 38)} ${lpad(`${pct(r.lh, r.lf)} (${r.lh}/${r.lf})`, 16)} ${lpad(`${pct(r.brh, r.brf)} (${r.brh}/${r.brf})`, 16)} ${lpad(`${pct(r.fnh, r.fnf)} (${r.fnh}/${r.fnf})`, 14)}`);
  }
  if (missing.length) console.log(`\nnot in report (never loaded in a measured isolate): ${missing.join(', ')}`);

  console.log(`\nTarget (PLAN.md Audits #4): >= ${TARGET_PCT}% lines`);
  let fail = 0;
  for (const t of TARGETS) {
    const rs = recs.filter(r => r.file === t || r.file.startsWith(t + '/'));
    const s = rs.reduce((a, r) => ({ lf: a.lf + r.lf, lh: a.lh + r.lh, brf: a.brf + r.brf, brh: a.brh + r.brh, fnf: a.fnf + r.fnf, fnh: a.fnh + r.fnh }), { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 });
    const ok = s.lh / s.lf * 100 >= TARGET_PCT;
    if (!ok) fail++;
    const miss = missing.filter(f => f.startsWith(t + '/'));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(t, 22)} lines ${pct(s.lh, s.lf)}% (${s.lh}/${s.lf})  branches ${pct(s.brh, s.brf)}%  funcs ${pct(s.fnh, s.fnf)}%${miss.length ? `  [excludes ${miss.join(', ')}]` : ''}`);
  }
  process.exitCode = fail ? 1 : 0;
}

main();
