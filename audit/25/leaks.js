#!/usr/bin/env node
'use strict';

// Leaks around the SG34 switch mutants (audit/22/leaks.js covers SIGTERM in
// the first mutant run and a spinning mutant; audit/17/leaks.js normal runs,
// SIGTERM in the main run, main-run timeout, diff-test hard kills;
// audit/22/reporter-fallback.js the SG28 retry).
//   sigterm-late-js: the CLI (stub client, js-basic fixture with a 2 s test
//     added) gets SIGTERM while the
//     --nth (default 4: main, mutant, mutant again, switch-off control) test
//     run is in flight. Checked: exit 0, no process, no src temp dir,
//     inflight.json cleared, worktree file back to its pre-edit content (no
//     switch text, no REFACTOR_MUTANT), target clean. (sigterm-late-py is
//     kept as an option: py-basic's only stub proposal fails its main run,
//     so no mutant run is reached there; it prints FINDING for that reason.)
//   hot-timeout: runExecutor in-process on a hot-path edit whose switch
//     makes mutant and control runs time out (audit/25/switch-hot.js, 5M
//     calls); the loop test also spawns `sleep 300`. Checked: no process,
//     no sleep child, no src temp dir, edited file restored to the original
//     (edit reverted, no switch text), no REFACTOR_MUTANT* left in
//     process.env.
// FINDING for any leftover process, temp dir, env variable or file content.
//
// usage: node audit/25/leaks.js [--cases sigterm-late-js,hot-timeout] [--nth 4]

const L = require('./lib');
const { spawn } = require('child_process');
const crypto = require('crypto');

const CASES = L.list('--cases', 'sigterm-late-js,hot-timeout');
const NTH = Number(L.opt('--nth', 4));
const ROOT = L.REPO_ROOT;

const FIX = {
  js: { name: 'js-basic', file: 'src/math.js', test: 'test/math.test.js', slow: "\nrequire('node:test')('slow', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); });\n" },
  py: { name: 'py-basic', file: 'calc/ops.py', test: 'tests/test_ops.py', slow: '\n\ndef test_slow():\n    import time\n    time.sleep(2)\n' }
};

async function sigtermLate(lang) {
  const fx = FIX[lang];
  const repo = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), `a25-leak-${lang}-`));
  L.fs.cpSync(L.path.join(ROOT, 'test', 'fixtures', fx.name), repo, { recursive: true });
  L.fs.appendFileSync(L.path.join(repo, fx.test), fx.slow);
  L.gitInit(repo);
  const tmp = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a25-leak-tmp-'));
  const stateDir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a25-leak-state-'));
  const env = { ...process.env, TMPDIR: tmp, REFACTOR_STATE_DIR: stateDir, REFACTOR_DASHBOARD_DIR: L.path.join(stateDir, 'dash'), STUB_FIXTURE: fx.name };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['-r', L.path.join(ROOT, 'test', 'helpers', 'stub-preload.js'),
    L.path.join(ROOT, 'src', 'orchestrator.js'), '--repo', repo, '--cache', 'off'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
  const targetState = L.path.join(stateDir, 'targets', crypto.createHash('sha256').update(L.path.resolve(repo)).digest('hex'));
  const seen = new Set();
  let signalled = false, live = false, switched = false;
  const end = Date.now() + 240_000;
  while (Date.now() < end && child.exitCode === null) {
    for (const d of L.fs.readdirSync(tmp).filter(n => n.startsWith('refactor-pyc-'))) seen.add(d);
    if (seen.size >= NTH) {
      await L.sleep(500);
      live = L.procsUnder([L.path.join(targetState, 'worktrees')]).length > 0;
      try {
        const wts = L.fs.readdirSync(L.path.join(targetState, 'worktrees'));
        switched = /REFACTOR_MUTANT/.test(L.fs.readFileSync(L.path.join(targetState, 'worktrees', wts[0], fx.file), 'utf8'));
      } catch { /* */ }
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
    wtFile = L.fs.readFileSync(L.path.join(targetState, 'worktrees', wts[0], fx.file), 'utf8');
  } catch { /* */ }
  const orig = L.fs.readFileSync(L.path.join(ROOT, 'test', 'fixtures', fx.name, fx.file), 'utf8');
  const clean = L.git(repo, ['status', '--porcelain']) === '';
  const n = `sigterm-late-${lang}`;
  console.log(`${n}: signalled ${signalled} at run ${seen.size} (switch text in file ${switched}, test process live ${live}); exit ${code}; procs ${procs.length}; temp dirs ${temps.length}; inflight ${inflight}; worktree file restored ${wtFile === orig}; target clean ${clean}`);
  L.check(`${n}: signal delivered during test run ${NTH}`, signalled && live, signalled ? '' : `only ${seen.size} runs`);
  L.check(`${n}: exit 0`, code === 0, String(code));
  L.check(`${n}: no process left`, !procs.length, procs.join('; '));
  L.check(`${n}: no src temp dir left`, !temps.length, temps.join(', '));
  L.check(`${n}: inflight.json cleared`, !inflight);
  L.check(`${n}: worktree file restored (no switch text left)`, wtFile === orig && !/REFACTOR_MUTANT/.test(wtFile || ''));
  L.check(`${n}: target clean`, clean);
  for (const p of procs) { try { process.kill(Number(p.split(' ')[0]), 'SIGKILL'); } catch { /* */ } }
  if (process.env.A25_VERBOSE) console.log(out.slice(-1500));
  L.rm(repo); L.rm(tmp); L.rm(stateDir);
}

async function hotTimeout() {
  const { runExecutor } = require(L.src('agents/executor'));
  const diffTesting = require(L.src('validation/diff-testing'));
  const dir = L.tmpDir('a25-leak-hot');
  L.write(dir, 'package.json', JSON.stringify({ name: 'hot', version: '1.0.0', scripts: { test: 'node --test' } }));
  const cur = 'function f(x) {\n  return x + 1;\n}\n';
  const before = `'use strict';\n${cur}module.exports = { f };\n`;
  L.write(dir, 'src/m.js', before);
  L.write(dir, 'test/m.test.js', [
    "const test = require('node:test');",
    "const assert = require('assert');",
    "const { spawn } = require('child_process');",
    "const { f } = require('../src/m');",
    "test('small', () => { assert.strictEqual(f(1), 2); });",
    // The sleep child is killed by the test when it finishes, so only a
    // timed-out run (group kill) can leave it.
    "test('loop', () => { const c = spawn('sleep', ['300'], { stdio: 'ignore' }); c.unref(); try { let s = 0; for (let i = 0; i < 5e6; i++) s += f(i) - i; assert.strictEqual(s, 5e6); } finally { c.kill('SIGKILL'); } });"
  ].join('\n') + '\n');
  L.gitInit(dir);
  const proposal = { issue_id: 'hot-leak', file: 'src/m.js', current_code: cur, proposed_code: 'function f(x) {\n  return x + 2 - 1;\n}\n' };
  proposal.diff_test = diffTesting.run({ currentSrc: cur, proposedSrc: proposal.proposed_code, fileSrc: before, file: 'src/m.js' });
  await L.withTmp(async (tmp) => {
    const r = await runExecutor({ proposal, repoRoot: dir });
    await L.sleep(2000);
    const m = r.mutation || {};
    const sleeps = L.procsMatching('sleep 300');
    const procs = L.procsUnder([dir]);
    const temps = L.srcTmpDirs(tmp);
    const file = L.fs.readFileSync(L.path.join(dir, 'src/m.js'), 'utf8');
    const envLeft = Object.keys(process.env).filter(k => /^REFACTOR_MUTANT/.test(k));
    console.log(`hot-timeout: ${r.status} ${r.reason || ''}; mutant runs ${m.run}, timeouts ${m.timeouts || 0}; procs ${procs.length}, sleep children ${sleeps.length} (killed groups leave them only if setsid), temp dirs ${temps.length}, file restored ${file === before}, env left ${envLeft.join(',') || 'none'}`);
    L.check('hot-timeout: switch runs timed out (scenario reached)', (m.timeouts || 0) > 0, JSON.stringify(m));
    L.check('hot-timeout: no process left', !procs.length && !sleeps.length, `${procs.join('; ')} ${sleeps.join(',')}`);
    L.check('hot-timeout: no src temp dir left', !temps.length, temps.join(', '));
    L.check('hot-timeout: file restored, no switch text', r.status === 'passed' || (file === before && !/REFACTOR_MUTANT/.test(file)));
    L.check('hot-timeout: no REFACTOR_MUTANT in process.env', !envLeft.length, envLeft.join(','));
    for (const p of sleeps) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
  });
  L.rm(dir);
}

(async () => {
  if (CASES.includes('sigterm-late-js')) await sigtermLate('js');
  if (CASES.includes('sigterm-late-py')) { L.pyPath(); await sigtermLate('py'); }
  if (CASES.includes('hot-timeout')) await hotTimeout();
  L.finish();
})();
