#!/usr/bin/env node
'use strict';

// Leaks around the SG26-SG30 mutant phase (audit/17/leaks.js covers normal
// runs, SIGTERM during the main run, a main-run timeout and diff-test hard
// kills; reporter-fallback.js covers the SG28 retry).
//   sigterm-mutant: the CLI (stub client, js-basic fixture with a 2 s test
//     added) gets SIGTERM while a mutant run is in flight (the second
//     refactor-pyc-* dir seen in its private TMPDIR). Checked: exit 0, no
//     process under the repo / state dir, no src temp dir, inflight.json
//     cleared, worktree file back to its pre-edit content, target clean.
//   mutant-timeout: runExecutor in-process; one mutant makes the suite spin
//     forever (the test loops until f(1) === 2), so that run hits its
//     2x suite + 1 s timeout; its process group must be gone afterwards.
// FINDING for any leftover process, temp dir or file content.
//
// usage: node audit/22/leaks.js [--cases sigterm-mutant,mutant-timeout]

const L = require('./lib');
const { spawn } = require('child_process');
const crypto = require('crypto');

const CASES = L.list('--cases', 'sigterm-mutant,mutant-timeout');
const ROOT = L.REPO_ROOT;

async function sigtermMutant() {
  const repo = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a22-leak-js-'));
  L.fs.cpSync(L.path.join(ROOT, 'test', 'fixtures', 'js-basic'), repo, { recursive: true });
  L.fs.appendFileSync(L.path.join(repo, 'test', 'math.test.js'), "\nrequire('node:test')('slow', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); });\n");
  L.gitInit(repo);
  const tmp = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a22-leak-tmp-'));
  const stateDir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a22-leak-state-'));
  const env = { ...process.env, TMPDIR: tmp, REFACTOR_STATE_DIR: stateDir, REFACTOR_DASHBOARD_DIR: L.path.join(stateDir, 'dash'), STUB_FIXTURE: 'js-basic' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['-r', L.path.join(ROOT, 'test', 'helpers', 'stub-preload.js'),
    L.path.join(ROOT, 'src', 'orchestrator.js'), '--repo', repo, '--cache', 'off'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
  const targetState = L.path.join(stateDir, 'targets', crypto.createHash('sha256').update(L.path.resolve(repo)).digest('hex'));
  const seen = new Set();
  let signalled = false, live = false;
  const end = Date.now() + 180_000;
  while (Date.now() < end && child.exitCode === null) {
    for (const d of L.fs.readdirSync(tmp).filter(n => n.startsWith('refactor-pyc-'))) seen.add(d);
    if (seen.size >= 2) {
      await L.sleep(500);
      live = L.procsUnder([L.path.join(targetState, 'worktrees')]).length > 0;
      child.kill('SIGTERM');
      signalled = true;
      break;
    }
    await L.sleep(50);
  }
  const { code } = await exited;
  await L.sleep(2500);
  const procs = L.procsUnder([repo, stateDir]);
  const temps = L.srcTmpDirs(tmp);
  const inflight = L.fs.existsSync(L.path.join(targetState, 'inflight.json'));
  let wtFile = null;
  try {
    const wts = L.fs.readdirSync(L.path.join(targetState, 'worktrees'));
    wtFile = L.fs.readFileSync(L.path.join(targetState, 'worktrees', wts[0], 'src', 'math.js'), 'utf8');
  } catch { /* */ }
  const orig = L.fs.readFileSync(L.path.join(ROOT, 'test', 'fixtures', 'js-basic', 'src', 'math.js'), 'utf8');
  const clean = L.git(repo, ['status', '--porcelain']) === '';
  console.log(`sigterm-mutant: signalled ${signalled} (test runs seen ${seen.size}, test process live ${live}); exit ${code}; procs ${procs.length}; temp dirs ${temps.length}; inflight ${inflight}; worktree file restored ${wtFile === orig}; target clean ${clean}`);
  L.check('sigterm-mutant: signal delivered during a mutant run', signalled && live);
  L.check('sigterm-mutant: exit 0', code === 0, String(code));
  L.check('sigterm-mutant: no process left', !procs.length, procs.join('; '));
  L.check('sigterm-mutant: no src temp dir left', !temps.length, temps.join(', '));
  L.check('sigterm-mutant: inflight.json cleared', !inflight);
  L.check('sigterm-mutant: worktree file restored (no mutant left in it)', wtFile === orig);
  L.check('sigterm-mutant: target clean', clean);
  for (const p of procs) { try { process.kill(Number(p.split(' ')[0]), 'SIGKILL'); } catch { /* */ } }
  if (process.env.A22_VERBOSE) console.log(out.slice(-1500));
  L.rm(repo); L.rm(tmp); L.rm(stateDir);
}

async function mutantTimeout() {
  const { runExecutor } = require(L.src('agents/executor'));
  const diffTesting = require(L.src('validation/diff-testing'));
  const dir = L.tmpDir('a22-leak-to');
  L.write(dir, 'package.json', JSON.stringify({ name: 'to', version: '1.0.0', scripts: { test: 'node --test' } }));
  const cur = 'function f(x) {\n  return x + 1;\n}\n';
  L.write(dir, 'src/m.js', `'use strict';\n${cur}module.exports = { f };\n`);
  // f(1) === 2 holds on the edit; a mutant that changes it spins (with a
  // child process in the group that sleeps too).
  L.write(dir, 'test/m.test.js', "const test = require('node:test');\nconst assert = require('assert');\nconst { spawn } = require('child_process');\nconst { f } = require('../src/m');\ntest('f', () => { if (f(1) !== 2) { spawn('sleep', ['300'], { stdio: 'ignore' }); for (;;) {} } assert.strictEqual(f(5), 6); });\n");
  L.gitInit(dir);
  const proposal = { issue_id: 'to', file: 'src/m.js', current_code: cur, proposed_code: 'function f(x) {\n  return x + 2 - 1;\n}\n' };
  proposal.diff_test = diffTesting.run({ currentSrc: cur, proposedSrc: proposal.proposed_code, fileSrc: L.fs.readFileSync(L.path.join(dir, 'src/m.js'), 'utf8'), file: 'src/m.js' });
  await L.withTmp(async (tmp) => {
    const t0 = performance.now();
    const r = await runExecutor({ proposal, repoRoot: dir });
    const wall = performance.now() - t0;
    await L.sleep(2000);
    const m = r.mutation || {};
    const sleeps = L.procsMatching('sleep 300');
    const procs = L.procsUnder([dir]);
    const temps = L.srcTmpDirs(tmp);
    console.log(`mutant-timeout: ${r.status} ${r.reason || ''}; mutant runs ${m.run}, timeouts ${m.timeouts || 0}, mutant phase ${L.fmt(m.duration_ms)} ms; wall ${L.fmt(wall)} ms; procs ${procs.length}, sleep children ${sleeps.length}, temp dirs ${temps.length}`);
    L.check('mutant-timeout: a mutant run timed out', (m.timeouts || 0) > 0, JSON.stringify(m));
    L.check('mutant-timeout: no process left', !procs.length && !sleeps.length, `${procs.join('; ')} ${sleeps.join(',')}`);
    L.check('mutant-timeout: no src temp dir left', !temps.length, temps.join(', '));
    for (const p of sleeps) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
  });
  L.rm(dir);
}

(async () => {
  if (CASES.includes('sigterm-mutant')) await sigtermMutant();
  if (CASES.includes('mutant-timeout')) await mutantTimeout();
  L.finish();
})();
