'use strict';

// AUDIT-11: flaky and order-dependent tests.
//
//   node audit/11/flaky.js [--repeat 3] [--files 2] [--serial 1] [--intra 2] [--seed 11] [test files...]
//
// Modes (each a full `node --test` run of the suite):
//   repeat  normal order, default concurrency (what `npm test` runs)
//   files   test files passed in a seeded shuffled order
//   serial  shuffled file order with --test-concurrency=1 (one file at a time)
//   intra   the top-level tests inside every file run in a seeded shuffled
//           order (shuffle-preload.js; Node 22 has no built-in shuffle)
// Every run gets a private TMPDIR. A test that fails in some runs and not in
// others is reported; one in a safety-path file (executor, runner, worktree,
// orchestrator, reverter, validators, diff tests, anchors) is a FINDING
// (exit 1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const num = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = Number(argv[i + 1]); argv.splice(i, 2); return v; };
const REPEAT = num('--repeat', 3), FILES = num('--files', 2), SERIAL = num('--serial', 1), INTRA = num('--intra', 2), SEED = num('--seed', 11);
const SAFETY = /(executor|test-runner|worktree|orchestrator|reverter|hybrid-validator|diff-testing|py-diff-testing|anchor-matcher)\.(e2e\.)?test\.js$/;

const allFiles = argv.length ? argv : fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));

function shuffled(xs, seed) {
  let s = Math.imul(seed, 2654435761) >>> 0 || 1;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < 16; i++) r();
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// TAP from several files: "# Subtest: <file>" opens a file; leaf results are
// "ok/not ok N - name" lines, attributed to the most recent file.
function parse(stdout) {
  const res = [];
  let file = null;
  for (const line of stdout.split('\n')) {
    const f = line.match(/^# Subtest: (.*\.test\.js)$/);
    if (f) { file = path.basename(f[1]); continue; }
    const m = line.match(/^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/);
    if (!m || /\.test\.js$/.test(m[3])) continue;
    res.push({ file, name: m[3], ok: m[2] === 'ok', skip: !!m[4] });
  }
  return res;
}

function run(label, files, { serial = false, intraSeed = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit11-flaky-'));
  const env = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  if (intraSeed != null) {
    env.AUDIT11_SEED = String(intraSeed);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} -r ${path.join(__dirname, 'shuffle-preload.js')}`.trim();
  }
  const args = ['--test', '--test-reporter=tap', ...(serial ? ['--test-concurrency=1'] : []), ...files];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 128 << 20, timeout: 1_200_000 });
  const wall = Date.now() - t0;
  // the TAP reporter prints files in completion order; name each file's subtests by file
  const tests = parse(r.stdout || '');
  const pass = (r.stdout.match(/^# pass (\d+)/m) || [])[1];
  const fail = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
  const failed = tests.filter(t => !t.ok);
  console.log(`${label.padEnd(26)} exit=${r.status} pass=${pass} fail=${fail} wall=${wall}ms${failed.length ? `  FAILED: ${failed.map(t => `${t.file} :: ${t.name}`).join(' | ')}` : ''}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { label, tests, status: r.status };
}

function main() {
  const runs = [];
  for (let i = 1; i <= REPEAT; i++) runs.push(run(`repeat #${i}`, allFiles));
  for (let i = 1; i <= FILES; i++) runs.push(run(`files shuffled seed=${SEED + i}`, shuffled(allFiles, SEED + i)));
  for (let i = 1; i <= SERIAL; i++) runs.push(run(`serial shuffled seed=${SEED + 100 + i}`, shuffled(allFiles, SEED + 100 + i), { serial: true }));
  for (let i = 1; i <= INTRA; i++) runs.push(run(`intra-file seed=${SEED + 200 + i}`, shuffled(allFiles, SEED + 200 + i), { intraSeed: SEED + 200 + i }));

  // Node 22's TAP output does not name the file of each test: find it by the
  // test's name in the sources.
  const sources = allFiles.map(f => [path.basename(f), fs.readFileSync(path.join(ROOT, f), 'utf8')]);
  const fileOf = (name) => { const hit = sources.find(([, s]) => s.includes(name) || s.includes(name.replace(/'/g, "\\'"))); return hit ? hit[0] : null; };
  const byTest = new Map();
  for (const r of runs) for (const t of r.tests) {
    if (t.skip) continue;
    if (!t.file) t.file = fileOf(t.name);
    const k = `${t.file} :: ${t.name}`;
    if (!byTest.has(k)) byTest.set(k, { file: t.file, pass: [], fail: [] });
    byTest.get(k)[t.ok ? 'pass' : 'fail'].push(r.label);
  }
  const unstable = [...byTest.entries()].filter(([, v]) => v.fail.length);
  console.log(`\n${byTest.size} distinct tests over ${runs.length} runs; ${unstable.length} failed at least once`);
  let findings = 0;
  for (const [k, v] of unstable) {
    const safety = SAFETY.test(v.file || '');
    if (safety) findings++;
    console.log(`${safety ? 'FINDING ' : 'note    '} ${k}: failed in [${v.fail.join(', ')}], passed in ${v.pass.length}`);
  }
  console.log(findings ? `FINDING: ${findings} unstable test(s) in the safety path` : 'ok: no unstable test in the safety path');
  process.exitCode = findings ? 1 : 0;
}

main();
