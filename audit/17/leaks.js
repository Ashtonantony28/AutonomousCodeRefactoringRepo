#!/usr/bin/env node
'use strict';

// Leaks after normal runs, SIGTERM and timeouts: child processes (any process
// whose cwd is under the target, its worktree or the state dir), src temp
// dirs (refactor-cov-*, refactor-pyc-*, pydt-*) and worktrees/branches.
// The CLI runs as a child with the stub client (test/helpers/stub-preload.js),
// its own REFACTOR_STATE_DIR and a private TMPDIR, so every leftover counted
// is the pipeline's. No live API call.
//   normal-js / normal-py: full non-dry run on the js-basic / py-basic fixture
//   sigterm-js / sigterm-py: SIGTERM while the main test run is in flight
//   timeout: runTests with a 2 s timeout on a command whose group keeps
//            sleeping children (in-process)
//   py-hardkill: Python diff test of a module whose top level never ends
// FINDING for any leftover process or src temp dir, or a SIGTERM exit != 0.
// Worktrees and refactor/<run_id> branches are reported (kept by design so
// the branch can be reviewed), not judged.
//
//   repeat-js: three normal runs on one target (worktrees/branches reported)
//
// usage: node audit/17/leaks.js [--cases normal-js,normal-py,sigterm-js,sigterm-py,repeat-js,timeout,py-hardkill]

const L = require('./lib');
const { spawn } = require('child_process');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const CASES = opt('--cases', 'normal-js,normal-py,sigterm-js,sigterm-py,repeat-js,timeout,py-hardkill').split(',');
const ROOT = L.REPO_ROOT;

const pyDir = L.pytestWithCoverageDir();
if (pyDir) process.env.PATH = `${pyDir}:${process.env.PATH}`;

// pids whose cwd is under one of `dirs`.
function procsUnder(dirs) {
  const out = [];
  for (const pid of L.fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    let cwd;
    try { cwd = L.fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
    if (dirs.some(d => cwd === d || cwd.startsWith(d + '/'))) {
      let cmd = '';
      try { cmd = L.fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { /* */ }
      out.push(`${pid} ${cmd.slice(0, 60)}`);
    }
  }
  return out;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; }

function fixture(name) {
  const dir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), `a17-leak-${name}-`));
  L.fs.cpSync(L.path.join(ROOT, 'test', 'fixtures', name), dir, { recursive: true });
  return dir;
}

async function cli(name, { slow = false, signalWhenTesting = null, repo: given = null, stateDir: givenState = null } = {}) {
  const repo = given || fixture(name);
  if (slow) {
    if (name === 'js-basic') {
      const pkgPath = L.path.join(repo, 'package.json');
      const pkg = JSON.parse(L.fs.readFileSync(pkgPath, 'utf8'));
      pkg.scripts.test = 'node -e "setTimeout(()=>{},60000)"';
      L.fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    } else {
      L.fs.writeFileSync(L.path.join(repo, 'tests', 'test_slow.py'), 'import time\n\ndef test_slow():\n    time.sleep(60)\n');
    }
  }
  if (!given) L.gitInit(repo);
  const tmp = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a17-leak-tmp-'));
  const stateDir = givenState || L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a17-leak-state-'));
  const env = { ...process.env, TMPDIR: tmp, REFACTOR_STATE_DIR: stateDir, REFACTOR_DASHBOARD_DIR: L.path.join(stateDir, 'dash'), STUB_FIXTURE: name };
  delete env.NODE_TEST_CONTEXT;
  const t0 = Date.now();
  const child = spawn(process.execPath, ['-r', L.path.join(ROOT, 'test', 'helpers', 'stub-preload.js'),
    L.path.join(ROOT, 'src', 'orchestrator.js'), '--repo', repo, '--cache', 'off'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
  const targetState = L.path.join(stateDir, 'targets', crypto.createHash('sha256').update(L.path.resolve(repo)).digest('hex'));
  let signalled = false;
  if (signalWhenTesting) {
    const snap = L.path.join(targetState, 'inflight.json');
    const ok = await waitFor(() => L.fs.existsSync(snap) && procsUnder([L.path.join(targetState, 'worktrees')]).length > 0, 120_000);
    if (ok) { await sleep(500); child.kill(signalWhenTesting); signalled = true; }
  }
  let guard;
  const { code, sig } = await Promise.race([exited, new Promise(r => { guard = setTimeout(() => { child.kill('SIGKILL'); r({ code: null, sig: 'timeout' }); }, 300_000); })]);
  clearTimeout(guard);
  await sleep(2500); // EXIT_GRACE / DRAIN: let anything that will exit, exit
  const procs = procsUnder([repo, stateDir]);
  const temps = L.srcTmpDirs(tmp);
  const tempBytes = temps.reduce((n, d) => n + Number(require('child_process').execSync(`du -sk ${L.path.join(tmp, d)}`).toString().split('\t')[0]), 0);
  const wts = (() => { try { return L.git(repo, ['worktree', 'list']).split('\n').length - 1; } catch { return '?'; } })();
  const branches = (() => { try { return L.git(repo, ['branch', '--list', 'refactor*']).split('\n').filter(Boolean).length; } catch { return '?'; } })();
  const inflight = L.fs.existsSync(L.path.join(targetState, 'inflight.json'));
  for (const p of procs) { try { process.kill(Number(p.split(' ')[0]), 'SIGKILL'); } catch { /* */ } }
  return { repo, tmp, stateDir, code, sig, signalled, procs, temps, tempKb: tempBytes, wts, branches, inflight, ms: Date.now() - t0, out };
}

function report(label, r, { expectExit0 = true } = {}) {
  console.log(`${label}: exit ${r.code}${r.sig ? ' ' + r.sig : ''} in ${r.ms} ms${r.signalled ? ' (signalled)' : ''}; procs left ${r.procs.length}; src temp dirs left ${r.temps.length} (${r.tempKb} KB: ${[...new Set(r.temps.map(t => t.replace(/-[^-]*$/, '')))].join(', ') || '-'}); worktrees ${r.wts}, refactor branches ${r.branches}; inflight.json ${r.inflight}`);
  for (const p of r.procs) console.log(`    left: ${p}`);
  if (expectExit0) L.check(`${label}: exit 0`, r.code === 0, `exit ${r.code} ${r.sig || ''}`);
  L.check(`${label}: no process left`, r.procs.length === 0, `${r.procs.length}`);
  L.check(`${label}: no src temp dir left`, r.temps.length === 0, `${r.temps.length} (${r.tempKb} KB)`);
  L.check(`${label}: inflight.json cleared`, !r.inflight);
  if (r.code !== 0 && process.env.A17_VERBOSE) console.log(r.out.slice(-2000));
  L.rm(r.repo); L.rm(r.tmp); L.rm(r.stateDir);
}

(async () => {
  if (CASES.includes('normal-js')) report('normal-js', await cli('js-basic'));
  if (CASES.includes('normal-py')) report('normal-py', await cli('py-basic'));
  if (CASES.includes('sigterm-js')) { const r = await cli('js-basic', { slow: true, signalWhenTesting: 'SIGTERM' }); L.check('sigterm-js: signal delivered mid-test', r.signalled); report('sigterm-js', r); }
  if (CASES.includes('sigterm-py')) { const r = await cli('py-basic', { slow: true, signalWhenTesting: 'SIGTERM' }); L.check('sigterm-py: signal delivered mid-test', r.signalled); report('sigterm-py', r); }
  if (CASES.includes('repeat-js')) {
    // Three normal runs on the same target: one worktree + branch each, kept.
    let r = await cli('js-basic');
    const { repo, stateDir } = r;
    L.rm(r.tmp);
    for (let i = 0; i < 2; i++) { r = await cli('js-basic', { repo, stateDir }); L.rm(r.tmp); }
    const branches = L.git(repo, ['branch', '--list', 'refactor*', '--format=%(refname:short)']).split('\n').filter(Boolean);
    const commits = branches.map(b => Number(L.git(repo, ['rev-list', '--count', `main..${b}`])));
    const kb = Number(require('child_process').execSync(`du -sk ${stateDir}`).toString().split('\t')[0]);
    console.log(`repeat-js: 3 runs -> worktrees ${r.wts}, branches ${branches.length} (commits each: ${commits.join(', ')}), state dir ${kb} KB`);
    L.rm(repo); L.rm(stateDir);
  }
  if (CASES.includes('timeout')) {
    const { runTests } = require(L.src('runner/test-runner'));
    const tmp = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a17-leak-tmp-'));
    const dir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a17-leak-to-'));
    L.write(dir, 'x.js', 'module.exports = 1;\n');
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    const t0 = Date.now();
    const r = await runTests({ repoRoot: dir, command: { cmd: 'sh', args: ['-c', 'sleep 30 & sleep 30 & node -e "setTimeout(()=>{},30000)"; wait'], framework: 'unknown' }, timeoutMs: 2000, edit: { file: 'x.js', start: 0, end: 5 } });
    const took = Date.now() - t0;
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    await sleep(2000);
    const procs = procsUnder([dir]);
    const temps = L.srcTmpDirs(tmp);
    console.log(`timeout: status ${r.status} in ${took} ms; procs left ${procs.length}; src temp dirs left ${temps.length}`);
    L.check('timeout: status timeout within 2 s + grace', r.status === 'timeout' && took < 2000 + 1500 + 500, `${r.status} ${took} ms`);
    L.check('timeout: no process left', procs.length === 0, procs.join('; '));
    L.check('timeout: no src temp dir left', temps.length === 0, temps.join(', '));
    for (const p of procs) { try { process.kill(Number(p.split(' ')[0]), 'SIGKILL'); } catch { /* */ } }
    L.rm(dir); L.rm(tmp);
  }
  if (CASES.includes('py-hardkill')) {
    const diffTesting = require(L.src('validation/diff-testing'));
    const tmp = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a17-leak-tmp-'));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    const before = L.procsMatching('py_diff_harness').length;
    const cur = 'def f(a):\n    t = a + 1\n    return t\n';
    const prop = 'def f(a):\n    return a + 1\n';
    const results = [];
    for (const top of ['while True:\n    pass\n', 'import time\nwhile True:\n    try:\n        time.sleep(0.01)\n    except BaseException:\n        pass\n']) {
      const t0 = performance.now();
      const r = diffTesting.run({ currentSrc: cur, proposedSrc: prop, fileSrc: top + cur, file: 'pkg/m.py' });
      results.push(`${Math.round(performance.now() - t0)} ms ${r.verdict}`);
    }
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    await sleep(1500);
    const after = L.procsMatching('py_diff_harness').length;
    const temps = L.srcTmpDirs(tmp);
    console.log(`py-hardkill: ${results.join('; ')}; harness procs ${before} -> ${after}; src temp dirs left ${temps.length}`);
    L.check('py-hardkill: no harness process left', after <= before, `${before} -> ${after}`);
    L.check('py-hardkill: no src temp dir left', temps.length === 0, temps.join(', '));
    L.rm(tmp);
  }
  L.finish();
})();
