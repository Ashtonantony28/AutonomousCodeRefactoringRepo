'use strict';

// AUDIT-26: what the load-flaky tests report when they fail. Runs the
// selected tests `--reps` times with `--busy` busy-loop processes and once
// unloaded, and prints each failure with the value it got (TAP `actual` /
// error message). A failure whose value is a fail-closed verdict
// (`inconclusive`, `mutation_budget`, ...) is load; any other value (e.g.
// `divergent` where `equivalent` is expected) cannot be told apart from a
// real regression by its message.
//
//   node audit/26/load-verdicts.js [--reps 5] [--busy 8] [--file test/diff-testing.test.js] [--pattern <re>]
//
// Prints FINDING (exit 1) when a test passes unloaded and fails under load
// with a message that does not name a fail-closed outcome (the failure
// looks like a regression); ok otherwise.
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REPS = Number(opt('--reps', 5));
const BUSY = Number(opt('--busy', 8));
const FILE = opt('--file', 'test/diff-testing.test.js');
const PATTERN = opt('--pattern', 'escape through a thrown error or console stays inside the sandbox');
const CLOSED = /inconclusive|mutation_budget|budget|timed? ?out|hard kill|coverage_timeout/i;

function run() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${PATTERN}`, FILE], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const lines = (r.stdout || '').split('\n');
  const fails = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*not ok \d+ - (.*)$/);
    if (!m || /\.test\.js$/.test(m[1])) continue;
    const detail = [];
    for (let j = i + 1; j < lines.length && !/^\s*(?:not )?ok \d+ - /.test(lines[j]) && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) {
      const k = lines[j].trim();
      if (/^(?:error|actual|expected|message):/.test(k) || /"verdict"|verdict/.test(k)) detail.push(k.slice(0, 300));
    }
    fails.push({ name: m[1], detail: detail.join(' | ') });
  }
  const pass = Number(((r.stdout || '').match(/^# pass (\d+)/m) || [])[1] || 0);
  return { fails, pass, ms: Date.now() - t0 };
}

function main() {
  const base = run();
  console.log(`unloaded: pass=${base.pass} failed=${base.fails.length} (${base.ms} ms)`);
  for (const f of base.fails) console.log(`  unloaded failure: ${f.name}: ${f.detail}`);
  const hogs = [];
  for (let i = 0; i < BUSY; i++) hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  let looks = 0, closed = 0, total = 0;
  try {
    for (let i = 0; i < REPS; i++) {
      const r = run();
      console.log(`loaded run ${i + 1}/${REPS} (busy ${BUSY}): pass=${r.pass} failed=${r.fails.length} (${r.ms} ms)`);
      for (const f of r.fails) {
        if (base.fails.some(b => b.name === f.name)) continue;
        total++;
        const ok = CLOSED.test(f.detail);
        if (ok) closed++; else looks++;
        console.log(`  ${ok ? 'fail-closed' : 'LOOKS LIKE A REGRESSION'}: ${f.name}: ${f.detail}`);
      }
    }
  } finally {
    for (const h of hogs) h.kill('SIGKILL');
  }
  console.log(`${total} load failure(s): ${closed} name a fail-closed outcome, ${looks} do not`);
  console.log(looks ? `FINDING: ${looks} load failure(s) report a value a regression would also give` : total ? 'ok: every load failure names a fail-closed outcome' : 'ok: no load failure');
  process.exitCode = looks ? 1 : 0;
}

main();
