'use strict';

// AUDIT-4: line coverage for code Node's test-runner coverage never sees.
//
//   node audit/4/worker-coverage.js [test files...]   (default: test/*.test.js)
//
// How: runs the suite with NODE_V8_COVERAGE=<tmp dir>. Every isolate that
// exits cleanly (main thread of each test-file subprocess, every
// worker_thread, child `node` processes) dumps raw V8 block coverage there.
// The script merges all dumps (a line counts as covered if any isolate ran
// it) and converts byte ranges to lines: a line is uncovered when every
// non-whitespace character on it lies in a range whose count is 0 (the
// innermost range wins). Blank and comment-only lines are reported separately
// as "executable" coverage, since Node's own report counts them as covered.
//
// diff-testing.js always terminate()s its worker, and a terminated isolate
// writes no dump, so the suite is run with worker-cov-preload.js, which
// flushes the worker's coverage (v8.takeCoverage) right before it signals the
// host. Workers killed by the 3 s hard kill (infinite loops) never reach that
// point; code that only runs in those workers is reported as uncovered.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const FOCUS = ['src/validation/diff-sandbox-worker.js', 'src/validation/diff-testing.js', 'src/orchestrator.js'];

function run(tests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit4-v8cov-'));
  const env = { ...process.env, NODE_V8_COVERAGE: dir };
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} -r ${path.join(__dirname, 'worker-cov-preload.js')}`.trim();
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...tests], { cwd: ROOT, env, encoding: 'utf8' });
  if (r.status !== 0) console.error(r.stdout, r.stderr);
  return dir;
}

function merge(dir) {
  const byFile = new Map(); // rel -> { dumps: number, isolates: [ranges[]] }
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const s of data.result || []) {
      if (!s.url.startsWith('file://')) continue;
      const abs = fileURLToPath(s.url);
      const rel = path.relative(ROOT, abs);
      if (!rel.startsWith('src/')) continue;
      const ranges = [];
      for (const fn of s.functions) for (const r of fn.ranges) ranges.push(r);
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push(ranges);
    }
  }
  return byFile;
}

function lineCoverage(rel, isolates) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const covered = new Uint8Array(src.length);
  for (const ranges of isolates) {
    const counts = new Int32Array(src.length).fill(-1);
    // larger ranges first so nested (more specific) ranges override them
    for (const r of [...ranges].sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset))) {
      counts.fill(r.count, r.startOffset, Math.min(r.endOffset, src.length));
    }
    for (let i = 0; i < src.length; i++) if (counts[i] !== 0) covered[i] = 1; // -1 = outside any range (module wrapper) -> loaded
  }
  const lines = src.split('\n');
  let off = 0; const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const t = text.trim();
    let comment = false;
    if (inBlock) { comment = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('/*')) { comment = true; if (!t.includes('*/')) inBlock = true; }
    else if (t.startsWith('//')) comment = true;
    let any = false, hit = false;
    for (let j = 0; j < text.length; j++) {
      if (/\s/.test(text[j])) continue;
      any = true; if (covered[off + j]) { hit = true; break; }
    }
    out.push({ n: i + 1, executable: any && !comment && t !== '', covered: !any || hit });
    off += text.length + 1;
  }
  if (lines[lines.length - 1] === '') out.pop();
  return out;
}

function ranges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`); i = j;
  }
  return out.join(' ');
}

function main() {
  const tests = process.argv.slice(2).length ? process.argv.slice(2)
    : fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));
  const dir = run(tests);
  const byFile = merge(dir);
  const verbose = process.env.AUDIT4_ALL === '1';
  const stats = {};
  for (const rel of [...new Set([...FOCUS, ...byFile.keys()])].sort()) {
    const iso = byFile.get(rel);
    if (!iso) { console.log(`${rel}: no V8 coverage dump contains this file`); continue; }
    const lines = lineCoverage(rel, iso);
    const all = lines.length, allHit = lines.filter(l => l.covered).length;
    const ex = lines.filter(l => l.executable), exHit = ex.filter(l => l.covered).length;
    stats[rel] = { all, allHit, ex: ex.length, exHit };
    if (!verbose && !FOCUS.includes(rel)) continue;
    console.log(`${rel}  isolates=${iso.length}  lines(all, Node-style) ${(100 * allHit / all).toFixed(2)}% (${allHit}/${all})  executable ${(100 * exHit / ex.length).toFixed(2)}% (${exHit}/${ex.length})`);
    console.log(`  uncovered: ${ranges(lines.filter(l => !l.covered).map(l => l.n))}`);
  }
  console.log('\nTarget dirs, worker included (all lines | executable lines only):');
  for (const t of ['src/validation', 'src/runner', 'src/rl', 'src/orchestrator.js']) {
    const s = Object.entries(stats).filter(([f]) => f === t || f.startsWith(t + '/')).map(([, v]) => v)
      .reduce((a, v) => ({ all: a.all + v.all, allHit: a.allHit + v.allHit, ex: a.ex + v.ex, exHit: a.exHit + v.exHit }), { all: 0, allHit: 0, ex: 0, exHit: 0 });
    console.log(`  ${t.padEnd(22)} ${(100 * s.allHit / s.all).toFixed(2)}% (${s.allHit}/${s.all}) | ${(100 * s.exHit / s.ex).toFixed(2)}% (${s.exHit}/${s.ex})`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

main();
