'use strict';

// AUDIT-30: test/test-runner.test.js ("V8 coverage: a file the tests never
// load ...", ~line 223) lists os.tmpdir() for `refactor-cov-*` before and
// after one runTests call and requires no new entry. Any other run in the
// same tmpdir creates such dirs: other test files of the same `npm test`
// (node --test runs files in parallel; executor, orchestrator and
// test-runner tests all call runTests with coverage), a second checkout's
// suite, or a real pipeline run. A dir created by someone else in that
// window and not yet removed fails the test.
//
//   node audit/30/tmpdir-race.js [--reps=5]
//
// Runs that one test --reps times alone (control), then --reps times while a
// churner process creates and removes `refactor-cov-*` dirs in os.tmpdir()
// (as concurrent runTests calls do; each dir lives 300 ms). Prints FINDING
// (exit 1) when the control is green and the churned runs fail.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const reps = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=5').slice(7));
const PATTERN = 'a file the tests never load';

function runOnce() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${PATTERN}`, 'test/test-runner.test.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  const pass = Number(((r.stdout || '').match(/^# pass (\d+)/m) || [])[1]);
  const fail = Number(((r.stdout || '').match(/^# fail (\d+)/m) || [])[1]);
  const why = [...new Set((r.stdout || '').match(/refactor-cov-\w+/g) || [])].slice(0, 3).map(n => `left: ${n}`).join(' ');
  return { ok: r.status === 0 && pass === 1 && fail === 0, pass, fail, why };
}

const CHURN = `
const fs = require('fs'), os = require('os'), path = require('path');
const live = new Set();
process.on('SIGTERM', () => { for (const d of live) fs.rmSync(d, { recursive: true, force: true }); process.exit(0); });
setInterval(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-cov-'));
  live.add(d);
  setTimeout(() => { fs.rmSync(d, { recursive: true, force: true }); live.delete(d); }, 300);
}, 50);
`;

async function main() {
  let ctl = 0, churned = 0;
  const before0 = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('refactor-cov-')).length;
  for (let i = 1; i <= reps; i++) {
    const r = runOnce();
    if (!r.ok) ctl++;
    console.log(`control ${i}/${reps}: pass=${r.pass} fail=${r.fail}${r.why ? ` ${r.why}` : ''}`);
  }
  const churner = spawn(process.execPath, ['-e', CHURN], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 300));
  try {
    for (let i = 1; i <= reps; i++) {
      const r = runOnce();
      if (!r.ok) churned++;
      console.log(`with concurrent runTests-like dirs ${i}/${reps}: pass=${r.pass} fail=${r.fail}${r.why ? ` ${r.why}` : ''}`);
    }
  } finally {
    churner.kill('SIGTERM');
  }
  await new Promise(r => churner.on('exit', r));
  const leftover = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('refactor-cov-')).length;
  console.log(`control failures ${ctl}/${reps}, churned failures ${churned}/${reps} (refactor-cov-* in tmpdir after: ${leftover}, before: ${before0})`);
  // A busy host (another suite or pipeline run in the same tmpdir) can fail
  // the control too; the finding is the churned runs failing more often.
  if (churned > ctl) { console.log('FINDING tmpdir-race: the test fails whenever another run in the same tmpdir creates a refactor-cov- dir'); process.exitCode = 1; } else console.log('ok');
}

main();
