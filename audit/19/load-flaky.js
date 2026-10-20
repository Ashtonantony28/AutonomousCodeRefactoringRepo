'use strict';

// AUDIT-19: timing-bound tests under CPU contention. Runs the selected tests
// (default: the SG20 mutant-budget pair in test/executor.test.js, which
// AUDIT-18 saw fail under load) `--reps` times each with `--busy` busy-loop
// processes running, and once with none, and counts failures.
//
//   node audit/19/load-flaky.js [--reps 5] [--busy 8] [--pattern <re>] [--file test/executor.test.js]
//
// Prints FINDING (exit 1) when a test passes unloaded but fails in some
// loaded run; ok otherwise.
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REPS = Number(opt('--reps', 5));
const BUSY = Number(opt('--busy', 8));
const PATTERN = opt('--pattern', 'mutant runs have their own budget|out of mutant budget');
const FILE = opt('--file', 'test/executor.test.js');

function run() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${PATTERN}`, FILE], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const failed = [...(r.stdout || '').matchAll(/^\s*not ok \d+ - (.*)$/gm)].map(m => m[1]).filter(n => !/\.test\.js$/.test(n));
  const pass = Number(((r.stdout || '').match(/^# pass (\d+)/m) || [])[1] || 0);
  return { failed, pass, status: r.status, ms: Date.now() - t0 };
}

function main() {
  const base = run();
  console.log(`unloaded: pass=${base.pass} failed=${base.failed.length} (${base.ms} ms)${base.failed.length ? ` ${base.failed.join(' | ')}` : ''}`);
  const hogs = [];
  for (let i = 0; i < BUSY; i++) hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  const fails = new Map();
  try {
    for (let i = 0; i < REPS; i++) {
      const r = run();
      for (const n of r.failed) fails.set(n, (fails.get(n) || 0) + 1);
      console.log(`loaded run ${i + 1}/${REPS} (busy ${BUSY}): pass=${r.pass} failed=${r.failed.length} (${r.ms} ms)`);
    }
  } finally {
    for (const h of hogs) h.kill('SIGKILL');
  }
  const flaky = [...fails].filter(([n]) => !base.failed.includes(n));
  for (const [n, k] of flaky) console.log(`FINDING flaky under load: ${k}/${REPS} failed: ${n}`);
  console.log(flaky.length ? `FINDING: ${flaky.length} test(s) fail only under load` : 'ok: no load-only failure');
  process.exitCode = flaky.length ? 1 : 0;
}

main();
