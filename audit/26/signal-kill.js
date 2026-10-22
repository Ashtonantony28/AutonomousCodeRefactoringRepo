'use strict';

// AUDIT-26: does anything pin "SIGINT/SIGTERM kills the in-flight test
// process group"? A test command that writes into the worktree 2 s after it
// starts is running when handleSignal is called; 3 s later the file must
// not exist (the group was killed). Checked on src/ as it is and on a temp
// copy with mutant S-kill (handleSignal no longer calls killActive); the
// CLI signal tests are then run on the mutated copy (--reps=3).
//
//   node audit/26/signal-kill.js [--reps=3]
//
// Prints FINDING (exit 1) when the real handler leaves the group running,
// or when the mutated copy leaves it running and a test run stays green.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MUT = { file: 'src/orchestrator.js', from: '  try { killActive(); removeLiveDirs(); } catch { /* */ }\n', to: '  try { removeLiveDirs(); } catch { /* */ }\n' };

function probe(srcRoot) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit26-sig-'));
  const late = path.join(repo, 'late-write.txt');
  const code = `
    const { runTests } = require(${JSON.stringify(path.join(srcRoot, 'src/runner/test-runner.js'))});
    const { handleSignal } = require(${JSON.stringify(path.join(srcRoot, 'src/orchestrator.js'))});
    const child = "setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late).replace(/"/g, '\\"')}, 'x'), 2000); setTimeout(() => {}, 4000)";
    const run = runTests({ repoRoot: ${JSON.stringify(repo)}, command: { cmd: process.execPath, args: ['-e', child], framework: 'node:test' }, timeoutMs: 20000 });
    setTimeout(() => {
      handleSignal('SIGTERM', null, { exit: () => {} });
      setTimeout(() => { console.log(JSON.stringify({ late_write: require('fs').existsSync(${JSON.stringify(late)}) })); process.exit(0); }, 3000);
    }, 500);`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 60_000 });
  fs.rmSync(repo, { recursive: true, force: true });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout).slice(-500) }; }
}

function copy(withTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit26-src-'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (withTests) {
    fs.cpSync(path.join(ROOT, 'test'), path.join(dir, 'test'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  }
  const f = path.join(dir, MUT.file), text = fs.readFileSync(f, 'utf8');
  if (text.split(MUT.from).length !== 2) throw new Error('mutant pattern not found once');
  fs.writeFileSync(f, text.replace(MUT.from, () => MUT.to));
  return dir;
}

function main() {
  const real = probe(ROOT);
  console.log(`real code:    ${JSON.stringify(real)}`);
  if (real.late_write !== false) { console.log('FINDING: the real signal handler leaves the test process group running'); process.exitCode = 1; return; }
  let dir = copy(false);
  let mut;
  try { mut = probe(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`mutated copy: ${JSON.stringify(mut)}`);
  if (!mut.late_write) { console.log('ok: the mutated copy also stops the write'); return; }
  dir = copy(true);
  try {
    // The only test that drives a real signal is the CLI one; run it --reps
    // times (default 3): a run that stays green is a run where nothing
    // noticed the group still running.
    const reps = Number((process.argv.find(x => /^--reps=/.test(x)) || '--reps=3').split('=')[1]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    let green = 0;
    for (let i = 0; i < reps; i++) {
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=to the CLI mid-test', 'test/executor.test.js'], { cwd: dir, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 << 20 });
      const n = (k) => ((r.stdout || '').match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1];
      if (r.status === 0) green++;
      console.log(`CLI signal tests on the mutated copy, run ${i + 1}/${reps}: pass=${n('pass')} fail=${n('fail')}`);
    }
    if (green) { console.log(`FINDING H4 S-kill: the test group keeps running after the signal handler, and the CLI signal tests stay green in ${green}/${reps} runs`); process.exitCode = 1; } else console.log(`ok: the CLI signal tests kill the mutant in ${reps}/${reps} runs`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
