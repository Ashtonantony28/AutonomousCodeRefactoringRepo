'use strict';

// Line coverage of src/ over the whole test suite, counting every isolate:
// test processes, child `node` processes and the diff-test worker threads
// (scripts/worker-coverage.js), which Node's --experimental-test-coverage
// does not see. A line is covered when any isolate ran it (innermost V8
// range); blank and comment-only lines are not counted.
//
//   npm run coverage            # table + per-target summary, exit 1 below 85%
//   npm run coverage -- --files # also list uncovered lines per file
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['src/validation', 'src/runner', 'src/rl', 'src/orchestrator.js'];
const MIN_PCT = 85;

function runSuite(dir) {
  const env = { ...process.env, NODE_V8_COVERAGE: dir };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} -r ${path.join(__dirname, 'worker-coverage.js')}`.trim();
  const tests = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
  return spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...tests], { cwd: ROOT, env, stdio: 'inherit' }).status;
}

// rel path -> [functions[] per isolate]
function loadDumps(dir) {
  const byFile = new Map();
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const s of data.result || []) {
      if (!s.url.startsWith('file://')) continue;
      const rel = path.relative(ROOT, fileURLToPath(s.url));
      if (!rel.startsWith('src' + path.sep)) continue;
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push(s.functions);
    }
  }
  return byFile;
}

function lineStats(rel, isolates) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const covered = new Uint8Array(src.length);
  for (const functions of isolates) {
    const counts = new Int32Array(src.length).fill(-1);
    const ranges = functions.flatMap(fn => fn.ranges).sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
    for (const r of ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, src.length));
    for (let i = 0; i < src.length; i++) if (counts[i] !== 0) covered[i] = 1;
  }
  let off = 0, inBlock = false, total = 0, hit = 0;
  const missed = [];
  src.split('\n').forEach((text, i) => {
    const t = text.trim();
    let comment;
    if (inBlock) { comment = true; inBlock = !t.includes('*/'); } else if (t.startsWith('/*')) { comment = true; inBlock = !t.includes('*/'); } else comment = t.startsWith('//');
    if (t && !comment) {
      total++;
      let any = false;
      for (let j = 0; j < text.length && !any; j++) any = !/\s/.test(text[j]) && covered[off + j] === 1;
      if (any) hit++; else missed.push(i + 1);
    }
    off += text.length + 1;
  });
  return { total, hit, missed };
}

const pct = (h, n) => (n ? (100 * h / n).toFixed(2) : '100.00');
const within = (t, f) => f === t || f.startsWith(t + '/');

function spans(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j;
  }
  return out.join(' ');
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-cov-'));
  let status, stats;
  try {
    status = runSuite(dir);
    stats = [...loadDumps(dir)].map(([rel, iso]) => ({ rel: rel.split(path.sep).join('/'), ...lineStats(rel, iso) })).sort((a, b) => a.rel.localeCompare(b.rel));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${'file'.padEnd(44)} ${'lines'.padStart(8)}`);
  for (const s of stats) {
    console.log(`${s.rel.padEnd(44)} ${pct(s.hit, s.total).padStart(7)}%${process.argv.includes('--files') && s.missed.length ? `  ${spans(s.missed)}` : ''}`);
  }
  let low = 0;
  console.log(`\nper target (>= ${MIN_PCT}% lines):`);
  for (const t of TARGETS) {
    const sel = stats.filter(s => within(t, s.rel));
    const total = sel.reduce((n, s) => n + s.total, 0), hit = sel.reduce((n, s) => n + s.hit, 0);
    const ok = total > 0 && 100 * hit / total >= MIN_PCT;
    if (!ok) low++;
    console.log(`${ok ? 'ok  ' : 'LOW '} ${t.padEnd(22)} ${pct(hit, total)}% (${hit}/${total})`);
  }
  if (status !== 0) console.log(`test suite exited ${status}`);
  process.exitCode = status !== 0 || low ? 1 : 0;
}

main();
