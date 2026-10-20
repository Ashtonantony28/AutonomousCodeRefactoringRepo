'use strict';

// AUDIT-11: line and branch coverage per file and per target directory
// (PLAN.md Audits #4: >= 85% lines on src/validation, src/runner, src/rl,
// src/orchestrator.js), measured two ways:
//
//   A. Node's own `node --test --experimental-test-coverage` (lcov reporter).
//      Counts test-file processes and child `node` processes that inherit
//      NODE_V8_COVERAGE; never counts worker_threads.
//   B. Raw V8 dumps (NODE_V8_COVERAGE=<tmp>, plus worker-cov-preload.js so the
//      diff-prep and diff-sandbox workers write theirs), merged over every
//      isolate: a line is covered if any isolate ran it (innermost V8 range,
//      as AUDIT-4's worker-coverage.js), a branch (a V8 block range, keyed by
//      its offsets) is covered if any isolate counted it.
//
// Since SG20 the JS diff test parses, locates targets and builds inputs in
// diff-prep-worker.js, which loads diff-testing.js in the worker, so Node's
// view (A) undercounts diff-testing.js badly; B is the real figure.
// The Python harness (src/validation/py_diff_harness.py) is measured by
// audit/11/py-coverage.js; pass its summary with --py <file> to fold it into
// the src/validation total.
//
//   node audit/11/coverage.js [--py py-summary.json] [--json out.json]
//
// Prints FINDING (exit 1) when a target directory is below 85% lines in
// view B (the one that sees all code); ok otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGETS = ['src/validation', 'src/runner', 'src/rl', 'src/orchestrator.js'];
const TARGET_PCT = 85;
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

function testFiles() {
  return fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// --- A: Node's report --------------------------------------------------------
function nodeReport() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit11-cov-'));
  const out = path.join(tmp, 'lcov.info');
  const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage',
    '--test-reporter=lcov', `--test-reporter-destination=${out}`,
    '--test-reporter=dot', '--test-reporter-destination=stdout', ...testFiles()],
  { cwd: ROOT, encoding: 'utf8', env: cleanEnv(), maxBuffer: 64 << 20 });
  if (r.status !== 0) console.log(`[A] suite exit ${r.status}\n${r.stdout.slice(-2000)}`);
  const recs = {};
  let cur = null;
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    if (line.startsWith('SF:')) cur = { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0, file: path.relative(ROOT, line.slice(3)) };
    else if (!cur) continue;
    else if (line.startsWith('LF:')) cur.lf = +line.slice(3);
    else if (line.startsWith('LH:')) cur.lh = +line.slice(3);
    else if (line.startsWith('BRF:')) cur.brf = +line.slice(4);
    else if (line.startsWith('BRH:')) cur.brh = +line.slice(4);
    else if (line.startsWith('FNF:')) cur.fnf = +line.slice(4);
    else if (line.startsWith('FNH:')) cur.fnh = +line.slice(4);
    else if (line === 'end_of_record') { if (cur.file.startsWith('src/')) recs[cur.file] = cur; cur = null; }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { recs, status: r.status };
}

// --- B: raw V8 dumps incl. workers -------------------------------------------
function rawRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit11-v8-'));
  const env = cleanEnv({ NODE_V8_COVERAGE: dir });
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} -r ${path.join(__dirname, 'worker-cov-preload.js')}`.trim();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...testFiles()], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) console.log(`[B] suite exit ${r.status}\n${r.stdout.slice(-2000)}`);
  return { dir, status: r.status };
}

function mergeDumps(dir) {
  const byFile = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const s of data.result || []) {
      if (!s.url.startsWith('file://')) continue;
      const rel = path.relative(ROOT, fileURLToPath(s.url));
      if (!rel.startsWith('src/')) continue;
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push(s.functions);
    }
  }
  return byFile;
}

function analyse(rel, isolates) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const covered = new Uint8Array(src.length);
  const branches = new Map(); // "start:end" -> hit
  const fns = new Map();
  for (const functions of isolates) {
    const ranges = [];
    for (const fn of functions) {
      fn.ranges.forEach((r, i) => {
        ranges.push(r);
        if (i > 0) { const k = `${r.startOffset}:${r.endOffset}`; branches.set(k, (branches.get(k) || 0) + (r.count > 0 ? 1 : 0)); }
      });
      if (fn.ranges[0] && !(fn.ranges[0].startOffset === 0 && fn.functionName === '')) { // skip the module wrapper
        const k = `${fn.ranges[0].startOffset}:${fn.ranges[0].endOffset}`;
        fns.set(k, (fns.get(k) || 0) + (fn.ranges[0].count > 0 ? 1 : 0));
      }
    }
    const counts = new Int32Array(src.length).fill(-1);
    for (const r of [...ranges].sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset))) {
      counts.fill(r.count, r.startOffset, Math.min(r.endOffset, src.length));
    }
    for (let i = 0; i < src.length; i++) if (counts[i] !== 0) covered[i] = 1;
  }
  const lines = src.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let off = 0, inBlock = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const t = text.trim();
    let comment = false;
    if (inBlock) { comment = true; if (t.includes('*/')) inBlock = false; } else if (t.startsWith('/*')) { comment = true; if (!t.includes('*/')) inBlock = true; } else if (t.startsWith('//')) comment = true;
    let any = false, hit = false;
    for (let j = 0; j < text.length; j++) {
      if (/\s/.test(text[j])) continue;
      any = true; if (covered[off + j]) { hit = true; break; }
    }
    out.push({ n: i + 1, executable: any && !comment, covered: !any || hit });
    off += text.length + 1;
  }
  const ex = out.filter(l => l.executable);
  return {
    lf: out.length, lh: out.filter(l => l.covered).length,
    ef: ex.length, eh: ex.filter(l => l.covered).length,
    brf: branches.size, brh: [...branches.values()].filter(v => v > 0).length,
    fnf: fns.size, fnh: [...fns.values()].filter(v => v > 0).length,
    isolates: isolates.length,
    uncovered: out.filter(l => !l.covered).map(l => l.n)
  };
}

function ranges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`); i = j;
  }
  return out.join(' ');
}

const pct = (h, f) => (f ? (100 * h / f).toFixed(2) : 'n/a');
const inTarget = (t, f) => f === t || f.startsWith(t + '/');

function main() {
  const A = nodeReport();
  const B = rawRun();
  const merged = mergeDumps(B.dir);
  const stats = {};
  for (const [rel, iso] of merged) stats[rel] = analyse(rel, iso);
  fs.rmSync(B.dir, { recursive: true, force: true });
  let py = null;
  if (opt('--py')) { try { py = JSON.parse(fs.readFileSync(opt('--py'), 'utf8')); } catch (e) { console.log(`--py unreadable: ${e.message}`); } }

  const allSrc = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else if (/\.(js|py)$/.test(a)) allSrc.push(path.relative(ROOT, a)); } })(path.join(ROOT, 'src'));

  console.log(`suite exit: A=${A.status} B=${B.status}`);
  console.log(`\n${'file'.padEnd(40)} ${'A lines'.padStart(8)} ${'A br'.padStart(7)} | ${'B lines'.padStart(8)} ${'B exec'.padStart(7)} ${'B br'.padStart(7)} ${'B fn'.padStart(7)}  isolates`);
  for (const f of allSrc.sort()) {
    const a = A.recs[f], b = stats[f];
    if (f.endsWith('.py')) {
      console.log(`${f.padEnd(40)} ${'-'.padStart(8)} ${'-'.padStart(7)} | ${py ? `${pct(py.covered_lines, py.num_statements)}*`.padStart(8) : 'see py-coverage.js'.padStart(8)}${py ? ` ${'-'.padStart(7)} ${pct(py.covered_branches, py.num_branches).padStart(7)}` : ''}`);
      continue;
    }
    console.log(`${f.padEnd(40)} ${(a ? pct(a.lh, a.lf) : 'absent').padStart(8)} ${(a ? pct(a.brh, a.brf) : '-').padStart(7)} | ${(b ? pct(b.lh, b.lf) : 'absent').padStart(8)} ${(b ? pct(b.eh, b.ef) : '-').padStart(7)} ${(b ? pct(b.brh, b.brf) : '-').padStart(7)} ${(b ? pct(b.fnh, b.fnf) : '-').padStart(7)}  ${b ? b.isolates : 0}`);
  }
  if (py) console.log('* py_diff_harness.py: coverage.py statements (lines) and branches, from --py');

  console.log('\nUncovered lines (view B) in target files:');
  for (const f of Object.keys(stats).sort()) {
    if (!TARGETS.some(t => inTarget(t, f))) continue;
    const u = stats[f].uncovered;
    if (u.length) console.log(`  ${f}: ${ranges(u)}`);
  }

  console.log(`\nPer target directory (target >= ${TARGET_PCT}% lines):`);
  let fail = 0;
  const summary = {};
  for (const t of TARGETS) {
    const sa = Object.values(A.recs).filter(r => inTarget(t, r.file)).reduce((s, r) => ({ lf: s.lf + r.lf, lh: s.lh + r.lh, brf: s.brf + r.brf, brh: s.brh + r.brh }), { lf: 0, lh: 0, brf: 0, brh: 0 });
    const sb = Object.entries(stats).filter(([f]) => inTarget(t, f)).map(([, v]) => v)
      .reduce((s, v) => ({ lf: s.lf + v.lf, lh: s.lh + v.lh, ef: s.ef + v.ef, eh: s.eh + v.eh, brf: s.brf + v.brf, brh: s.brh + v.brh }), { lf: 0, lh: 0, ef: 0, eh: 0, brf: 0, brh: 0 });
    let withPy = null;
    if (t === 'src/validation' && py) {
      withPy = { lf: sb.ef + py.num_statements, lh: sb.eh + py.covered_lines };
    }
    const linePct = 100 * sb.lh / sb.lf;
    const ok = linePct >= TARGET_PCT;
    if (!ok) fail++;
    summary[t] = { A: { lines: pct(sa.lh, sa.lf), branches: pct(sa.brh, sa.brf) }, B: { lines: pct(sb.lh, sb.lf), exec: pct(sb.eh, sb.ef), branches: pct(sb.brh, sb.brf) }, withPy: withPy && pct(withPy.lh, withPy.lf) };
    console.log(`${ok ? 'ok     ' : 'FINDING'} ${t.padEnd(22)} A: lines ${pct(sa.lh, sa.lf)}% (${sa.lh}/${sa.lf}) br ${pct(sa.brh, sa.brf)}%  |  B: lines ${pct(sb.lh, sb.lf)}% (${sb.lh}/${sb.lf}) exec ${pct(sb.eh, sb.ef)}% br ${pct(sb.brh, sb.brf)}%${withPy ? `  |  exec JS + py statements ${pct(withPy.lh, withPy.lf)}% (${withPy.lh}/${withPy.lf})` : ''}`);
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ A: A.recs, B: stats, summary }, null, 1));
  process.exitCode = fail ? 1 : 0;
}

main();
