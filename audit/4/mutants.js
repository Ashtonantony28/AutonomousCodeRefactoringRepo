'use strict';

// AUDIT-4: targeted mutation testing. Each mutant breaks one behaviour the
// pipeline relies on; a mutant that SURVIVES (the whole suite still passes)
// means no test pins that behaviour.
//
//   node audit/4/mutants.js            # all mutants
//   node audit/4/mutants.js E1 W1      # selected ids
//
// The repo is copied to a temp dir OUTSIDE this checkout (node_modules is
// symlinked); src/ and test/ here are never modified. Each mutant is applied
// to the copy, `node --test test/*.test.js` runs there, and the file is
// restored. "control" mutants are expected to be killed and show the harness
// can detect a break.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const MUTANTS = [
  // --- executor / runner: revert-on-anything-but-pass
  { id: 'E1', file: 'src/agents/executor.js', why: 'timed-out / environment_error edits are kept (and committed) instead of reverted',
    from: "if (status === 'failed' || status === 'timeout' || status === 'environment_error') {",
    to: "if (status === 'failed') {" },
  { id: 'E2', file: 'src/agents/executor.js', why: 'a failed worktree commit leaves the edit in place',
    from: "      snap.restoreAll();\n      return {\n        status: 'environment_error',\n        reason: `commit failed",
    to: "      return {\n        status: 'environment_error',\n        reason: `commit failed" },
  { id: 'T1', file: 'src/runner/test-runner.js', why: 'a test command that cannot be spawned (ENOENT, e.g. pytest missing) counts as passed',
    from: "else if (result.spawnError) status = 'environment_error';",
    to: "else if (result.spawnError) status = 'passed';" },
  { id: 'T2', file: 'src/runner/test-runner.js', control: true, why: 'timeout no longer reported as timeout',
    from: "if (result.timedOut) status = 'timeout';", to: "if (false) status = 'timeout';" },
  { id: 'T3', file: 'src/runner/test-runner.js', control: true, why: 'timeout kills only the direct child, not the process group',
    from: 'else process.kill(-proc.pid, signal);', to: 'else proc.kill(signal);' },
  // --- anchor uniqueness at every tier (SG4)
  { id: 'A1', file: 'src/runner/anchor-matcher.js', why: 'whitespace tier silently picks the first of several matches (edit lands in the wrong place)',
    from: "  const idxs = allIndexes(H, N);\n  if (!idxs.length) return null;\n  if (idxs.length > 1) return { ambiguous: true, count: idxs.length };",
    to: "  const idxs = allIndexes(H, N);\n  if (!idxs.length) return null;" },
  { id: 'A2', file: 'src/runner/anchor-matcher.js', control: true, why: 'exact tier ignores ambiguity',
    from: "  if (!idxs.length) return null;\n  if (idxs.length > 1) return { ambiguous: true, count: idxs.length };\n  return { start: idxs[0], end: idxs[0] + needle.length };",
    to: "  if (!idxs.length) return null;\n  return { start: idxs[0], end: idxs[0] + needle.length };" },
  // --- worktree isolation
  { id: 'W1', file: 'src/runner/worktree.js', why: 'uncommitted target edits are never copied into the worktree',
    from: 'function syncDirtyFiles(top, wtTop) {\n', to: 'function syncDirtyFiles(top, wtTop) {\n  return [];\n' },
  { id: 'W2', file: 'src/runner/worktree.js', why: '--resume never re-adds a pruned worktree (falls back to editing the target in place)',
    from: "    try { git(top, ['worktree', 'add', info.path, info.branch]); } catch { /* */ }\n", to: '' },
  // --- signals / crash / resume
  { id: 'O1', file: 'src/orchestrator.js', why: 'SIGINT/SIGTERM no longer flush session.json (CLAUDE.md: "state is flushed to disk")',
    from: '  try { if (session) saveSession(session); } catch { /* */ }\n', to: '' },
  { id: 'O2', file: 'src/orchestrator.js', why: 'an uncaught exception exits 0 instead of 1',
    from: "exit(signal === 'uncaughtException' ? 1 : 0);", to: 'exit(0);' },
  { id: 'O3', file: 'src/orchestrator.js', why: 'SIGTERM handler not installed (the process dies with the edit in flight)',
    from: "  process.on('SIGTERM', () => handleSignal('SIGTERM', session));\n", to: '' },
  { id: 'O4', file: 'src/orchestrator.js', why: 'an executor exception leaves test_outcome null (proposal re-run on --resume, no error status)',
    from: "    proposal.test_outcome = { status: 'error', error: err.message };\n", to: '' },
  { id: 'O5', file: 'src/orchestrator.js', control: true, why: 'persisted in-flight snapshot is not restored on start',
    from: 'const crashed = FileSnapshot.restoreFromDisk(inflightPath(absRepo));', to: 'const crashed = null;' },
  { id: 'O6', file: 'src/orchestrator.js', control: true, why: 'gate ignores jury p_preserves',
    from: '(jury.p_preserves || 0) >= MIN_CRITIC_P', to: 'true' },
  { id: 'C1', file: 'src/utils/checkpoint.js', why: '--resume adopts a session.json that belongs to another target repo',
    from: 'if (!existing.target_repo || path.resolve(existing.target_repo) === path.resolve(targetRepo)) return existing;',
    to: 'return existing;' },
  // --- validation
  { id: 'H1', file: 'src/validation/hybrid-validator.js', control: true, why: 'severity:veto checks never veto',
    from: "if (c.severity === 'veto' && !c.passed)", to: 'if (false)' },
  { id: 'D1', file: 'src/validation/diff-testing.js', why: 'proposed side hanging past the hard kill is inconclusive instead of divergent',
    from: "if (last && last.type === 'progress' && last.current.kind !== 'timeout') {", to: 'if (false) {' },
  { id: 'R1', file: 'src/validation/ast-checker.js', why: 'return check treats every loop as never completing (lost return after a loop is missed)',
    from: '      r.normal = !infinite || b.brk;', to: '      r.normal = false;' },
  // --- learned gate / calibration / reward
  { id: 'K1', file: 'src/rl/calibration.js', why: 'PAVA pools blocks with an unweighted mean (wrong calibrated p_pass after 3+-point merges)',
    from: 'value: (top.value * top.weight + block.value * block.weight) / (top.weight + block.weight),', to: 'value: (top.value + block.value) / 2,' },
  { id: 'K2', file: 'src/rl/calibration.js', why: 'calibration also refuses to fit at exactly MIN_SAMPLES (20) points',
    from: 'if (xs.length < MIN_SAMPLES)', to: 'if (xs.length <= MIN_SAMPLES)' },
  { id: 'K3', file: 'src/rl/classifier.js', control: true, why: 'gate takes the higher instead of the lower p_pass',
    from: 'votes.reduce((a, c) => (c[1] < a[1] ? c : a))', to: 'votes.reduce((a, c) => (c[1] > a[1] ? c : a))' },
  { id: 'K4', file: 'src/rl/classifier.js', why: 'gate threshold boundary: p_pass == 0.4 rejected',
    from: 'rejected: p < RL_GATE_THRESHOLD', to: 'rejected: p <= RL_GATE_THRESHOLD' },
  { id: 'K5', file: 'src/rl/calibration.js', why: 'ECE always 0',
    from: '  let ece = 0;\n  for (const b of bins) {', to: '  let ece = 0;\n  return 0;\n  for (const b of bins) {' },
  { id: 'RW1', file: 'src/rl/reward.js', why: 'rolling-reward warning fires when reward improves instead of when it drops (CLAUDE.md rule)',
    from: 'if (recentAvg < priorAvg) {', to: 'if (recentAvg > priorAvg) {' }
];

function copyRepo() {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'audit4-mut-'));
  for (const e of fs.readdirSync(ROOT)) {
    if (e === '.git' || e === 'node_modules' || e === 'state' || e === 'dashboard') continue;
    fs.cpSync(path.join(ROOT, e), path.join(dst, e), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dst, 'node_modules'), 'dir');
  return dst;
}

function runSuite(dir) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const tests = fs.readdirSync(path.join(dir, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: dir, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 });
  const num = (k) => { const m = (r.stdout || '').match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  const failed = [...(r.stdout || '').matchAll(/^\s+not ok \d+ - (.*)$/gm)].map(m => m[1]);
  return { pass: num('pass'), fail: num('fail'), failed, status: r.status };
}

function main() {
  const only = process.argv.slice(2);
  const list = only.length ? MUTANTS.filter(m => only.includes(m.id)) : MUTANTS;
  const dir = copyRepo();
  let survived = 0, killed = 0, controlsSurvived = 0;
  try {
    const base = runSuite(dir);
    console.log(`baseline (unmutated copy): pass=${base.pass} fail=${base.fail}`);
    if (base.fail) { console.log('baseline is not green; aborting'); process.exitCode = 2; return; }
    for (const m of list) {
      const abs = path.join(dir, m.file);
      const orig = fs.readFileSync(abs, 'utf8');
      const n = orig.split(m.from).length - 1;
      if (n !== 1) { console.log(`${m.id}: pattern found ${n} times in ${m.file}; skipped`); continue; }
      fs.writeFileSync(abs, orig.replace(m.from, () => m.to));
      const t0 = Date.now();
      const r = runSuite(dir);
      fs.writeFileSync(abs, orig);
      const dead = r.fail > 0 || r.status !== 0;
      if (dead) killed++; else { survived++; if (m.control) controlsSurvived++; }
      console.log(`${dead ? 'killed  ' : 'SURVIVED'} ${m.id.padEnd(4)} ${m.control ? '(control) ' : ''}${m.file}: ${m.why}  [${Date.now() - t0} ms, fail=${r.fail}]`);
      if (dead && r.failed.length) console.log(`         by: ${[...new Set(r.failed)].slice(0, 3).join(' | ')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${killed} killed, ${survived} survived (${controlsSurvived} of them controls)`);
}

main();
