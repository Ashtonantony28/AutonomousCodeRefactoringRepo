'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { runExecutor } = require('../src/agents/executor');
const { runPipeline, handleSignal } = require('../src/orchestrator');
const { FileSnapshot } = require('../src/runner/reverter');
const { inflightPath } = require('../src/utils/checkpoint');
const { assertTestOutcome } = require('../src/contracts');
const { installStub, resetClient } = require('./helpers/stub-client');
const { makeProposal } = require('./helpers/factories');
const { gitInit, treeHash } = require('./helpers/git');

const ROOT = path.resolve(__dirname, '..');

async function withoutTestContext(fn) {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await fn(); } finally { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; }
}

function waitFor(pred, timeoutMs = 20000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = pred(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function procsMatching(marker) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker)) out.push(Number(pid));
    } catch { /* gone */ }
  }
  return out;
}

const MATH = 'src/math.js';
const ADD_CURRENT = 'function add(a, b) {\n  const result = a + b;\n  return result;\n}';
const ADD_PROPOSED = 'function add(a, b) {\n  return a + b;\n}';

test('executor makes no Claude call and commits a passing edit via onKept', async (t) => {
  const repo = env.copyFixture('js-basic');
  const stub = installStub({});
  t.after(() => { resetClient(); env.rm(repo); });
  const snapshotPath = path.join(repo, '..', path.basename(repo) + '-inflight.json');
  let keptWith = null;
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED),
    repoRoot: repo,
    snapshotPath,
    onKept: () => { keptWith = fs.readFileSync(path.join(repo, MATH), 'utf8'); assert(fs.existsSync(snapshotPath)); return 'abc123'; }
  }));
  assert.strictEqual(res.status, 'passed', res.stderr_tail);
  assert.strictEqual(res.commit, 'abc123');
  assert(keptWith.includes(ADD_PROPOSED));
  assert.strictEqual(stub.count(), 0);
  assert(!fs.existsSync(snapshotPath), 'snapshot released after the edit is kept');
  assert(!('plan' in res));
  assertTestOutcome(res);
});

test('apply_failed carries the anchor tier and closest window', async (t) => {
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const before = fs.readFileSync(path.join(repo, MATH), 'utf8');
  const res = await runExecutor({
    proposal: makeProposal(MATH, 'function add(a, b) {\n  const result = a - b;\n  return result;\n}', ADD_PROPOSED),
    repoRoot: repo
  });
  assert.strictEqual(res.status, 'apply_failed');
  assert.strictEqual(res.tier, 'fuzzy');
  assert(res.detail && res.detail.closest && typeof res.detail.closest.start === 'number', JSON.stringify(res.detail));
  assert.strictEqual(fs.readFileSync(path.join(repo, MATH), 'utf8'), before);
  assertTestOutcome(res);
});

test('no test runner: skipped_no_tests and the file is restored', async (t) => {
  const repo = env.copyFixture('no-tests');
  t.after(() => env.rm(repo));
  const file = path.join(repo, 'src', 'util.js');
  const before = fs.readFileSync(file, 'utf8');
  let kept = false;
  const res = await runExecutor({
    proposal: makeProposal('src/util.js', 'function double(x) {\n  const out = x * 2;\n  return out;\n}', 'function double(x) {\n  return x * 2;\n}'),
    repoRoot: repo,
    onKept: () => { kept = true; }
  });
  assert.strictEqual(res.status, 'skipped_no_tests');
  assert.strictEqual(res.reverted, true);
  assert.strictEqual(kept, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assertTestOutcome(res);
});

test('a crash mid-edit is restored from the persisted snapshot on the next start', async (t) => {
  const repo = gitInit(env.copyFixture('js-basic'));
  installStub({ 'analyzer-propose': [] });
  t.after(() => { resetClient(); env.rm(repo); });
  const file = path.join(repo, MATH);
  const before = fs.readFileSync(file, 'utf8');
  const snapPath = inflightPath(repo);
  // The on-disk state a killed process leaves behind: snapshot + edited file.
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  fs.writeFileSync(snapPath, JSON.stringify({ repo_root: repo, files: { [MATH]: { existed: true, content: before } } }));
  fs.writeFileSync(file, 'garbage from a dead process');

  await withoutTestContext(() => runPipeline({ repo, cache: 'off', resume: true, dryRun: true }));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert(!fs.existsSync(snapPath));
});

test('handleSignal reverts a live edit and exits 0', (t) => {
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const file = path.join(repo, MATH);
  const before = fs.readFileSync(file, 'utf8');
  const snap = new FileSnapshot(repo);
  snap.capture(MATH);
  fs.writeFileSync(file, 'half-applied');
  let code = null;
  handleSignal('SIGTERM', null, { exit: (c) => { code = c; } });
  assert.strictEqual(code, 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('SIGINT to the CLI mid-test restores the worktree file, kills the test group, leaves the target clean', async (t) => {
  const repo = env.copyFixture('js-basic');
  const marker = `refactor-sigint-${crypto.randomBytes(4).toString('hex')}`;
  const pkgPath = path.join(repo, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts.test = `node -e "setTimeout(()=>{},60000)" ${marker}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  gitInit(repo);
  const before = treeHash(repo);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-sigint-state-'));
  t.after(() => { env.rm(repo); env.rm(stateDir); for (const pid of procsMatching(marker)) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } });

  const childEnv = { ...process.env, REFACTOR_STATE_DIR: stateDir, STUB_FIXTURE: 'js-basic' };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['-r', path.join(ROOT, 'test', 'helpers', 'stub-preload.js'),
    path.join(ROOT, 'src', 'orchestrator.js'), '--repo', repo, '--cache', 'off'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));

  const targetState = path.join(stateDir, 'targets', crypto.createHash('sha256').update(path.resolve(repo)).digest('hex'));
  const snapPath = path.join(targetState, 'inflight.json');
  await waitFor(() => fs.existsSync(snapPath) && procsMatching(marker).length > 0);
  const { repo_root: wtRoot } = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  assert(wtRoot.startsWith(targetState), 'edits happen in the worktree under the state dir');
  const wtFile = path.join(wtRoot, MATH);
  assert(fs.readFileSync(wtFile, 'utf8').includes(ADD_PROPOSED), 'edit is in flight');

  child.kill('SIGINT');
  const { code } = await exited;
  assert.strictEqual(code, 0, out);
  assert(!fs.readFileSync(wtFile, 'utf8').includes(ADD_PROPOSED), 'in-flight edit reverted');
  assert.strictEqual(fs.readFileSync(wtFile, 'utf8'), fs.readFileSync(path.join(repo, MATH), 'utf8'));
  assert(!fs.existsSync(snapPath), 'persisted snapshot cleared');
  assert.deepStrictEqual(treeHash(repo), before, 'target untouched');
  await waitFor(() => procsMatching(marker).length === 0, 3000);
});
