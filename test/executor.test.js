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
const factories = require('./helpers/factories');
// Proposals reach the executor only through the gate, which needs an
// `equivalent` diff test; this one also ran every deleted token.
const GATE_DIFF_TEST = { applicable: true, verdict: 'equivalent', runs: 12, deletions_observed: true, duration_ms: 1 };
const makeProposal = (...a) => ({ ...factories.makeProposal(...a), diff_test: { ...GATE_DIFF_TEST } });
const { git, gitInit, treeHash } = require('./helpers/git');

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

test('apply_failed (tier region) when the anchor no longer lands on the validated region', async (t) => {
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const before = fs.readFileSync(path.join(repo, MATH), 'utf8');
  const proposal = makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED);
  proposal.validated_region = { tier: 'exact', start: 0, end: 10, text: 'function add(a, b) { return a + b; }' };
  const res = await runExecutor({ proposal, repoRoot: repo });
  assert.strictEqual(res.status, 'apply_failed');
  assert.strictEqual(res.tier, 'region');
  assert.strictEqual(res.detail.reason, 'region_changed');
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

test('handleSignal flushes the session; an uncaught exception exits 1 (AUDIT-11 H1)', (t) => {
  const { freshSession, sessionPath } = require('../src/utils/checkpoint');
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const session = freshSession(repo);
  session.proposals.push({ issue_id: 'flushed-on-signal' });
  const codes = [];
  handleSignal('SIGTERM', session, { exit: (c) => codes.push(c) });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8')).proposals, [{ issue_id: 'flushed-on-signal' }]);
  handleSignal('uncaughtException', null, { exit: (c) => codes.push(c) });
  assert.deepStrictEqual(codes, [0, 1]);
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} to the CLI mid-test restores the worktree file, kills the test group, leaves the target clean`, async (t) => {
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

  child.kill(signal);
  const { code } = await exited;
  assert.strictEqual(code, 0, out);
  assert(!fs.readFileSync(wtFile, 'utf8').includes(ADD_PROPOSED), 'in-flight edit reverted');
  assert.strictEqual(fs.readFileSync(wtFile, 'utf8'), fs.readFileSync(path.join(repo, MATH), 'utf8'));
  assert(!fs.existsSync(snapPath), 'persisted snapshot cleared');
  assert.deepStrictEqual(treeHash(repo), before, 'target untouched');
  await waitFor(() => procsMatching(marker).length === 0, 3000);
});

// --- revert paths and execution evidence (SG12) ------------------------------

function setTestScript(repo, script) {
  const pkgPath = path.join(repo, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts.test = script;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  t.after(restore);
  return restore;
}

function assertReverted(res, repo, file, before, kept) {
  assert.strictEqual(res.reverted, true);
  assert.strictEqual(kept, false, 'onKept must not run');
  assert.strictEqual(fs.readFileSync(path.join(repo, file), 'utf8'), before, 'edit reverted');
  assertTestOutcome(res);
}

test('timeout: edit reverted, not kept, bounded even when a setsid daemon holds the test stdio', { skip: process.platform === 'win32' }, async (t) => {
  const repo = env.copyFixture('js-basic');
  const pidFile = path.join(repo, 'daemon.pid');
  fs.writeFileSync(path.join(repo, 'suite.js'), [
    "const c = require('child_process').spawn('sleep', ['20'], { detached: true, stdio: 'inherit' });",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    'c.unref(); setInterval(() => {}, 1000);'
  ].join('\n'));
  setTestScript(repo, 'node suite.js');
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* */ } env.rm(repo); });
  const before = fs.readFileSync(path.join(repo, MATH), 'utf8');
  let kept = false;
  const t0 = Date.now();
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED), repoRoot: repo, testTimeoutMs: 300, onKept: () => { kept = true; }
  }));
  assert(Date.now() - t0 < 300 + 2000, `took ${Date.now() - t0} ms`);
  assert.strictEqual(res.status, 'timeout');
  assert.match(res.reason, /timed out/);
  assertReverted(res, repo, MATH, before, kept);
});

test('spawn failure (test binary missing): environment_error with the cause, edit reverted', { skip: process.platform === 'win32' }, async (t) => {
  const repo = env.copyFixture('py-basic');
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-nobin-'));
  t.after(() => { env.rm(repo); env.rm(emptyBin); });
  const [p] = JSON.parse(fs.readFileSync(path.join(repo, 'proposals.json'), 'utf8'));
  const before = fs.readFileSync(path.join(repo, p.file), 'utf8');
  let kept = false;
  const restore = withEnv(t, { PATH: emptyBin });
  const res = await runExecutor({ proposal: makeProposal(p.file, p.current_code, p.proposed_code), repoRoot: repo, onKept: () => { kept = true; } });
  restore();
  assert.strictEqual(res.status, 'environment_error');
  assert.match(res.reason, /ENOENT/);
  assertReverted(res, repo, p.file, before, kept);
});

test('environment error (no usable temp dir for coverage): environment_error, edit reverted', async (t) => {
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const before = fs.readFileSync(path.join(repo, MATH), 'utf8');
  let kept = false;
  const restore = withEnv(t, { TMPDIR: path.join(repo, 'no-such-dir'), TMP: path.join(repo, 'no-such-dir') });
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED), repoRoot: repo, onKept: () => { kept = true; }
  }));
  restore();
  assert.strictEqual(res.status, 'environment_error');
  assertReverted(res, repo, MATH, before, kept);
});

test('commit failure: edit reverted in the tree AND unstaged from the index', async (t) => {
  const repo = gitInit(env.copyFixture('js-basic'));
  const { commitProposal } = require('../src/runner/worktree');
  t.after(() => env.rm(repo));
  const before = fs.readFileSync(path.join(repo, MATH), 'utf8');
  // `git add` succeeds, `git commit` cannot lock the branch ref.
  fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'main.lock'), '');
  const snapshotPath = path.join(repo, '..', path.basename(repo) + '-inflight.json');
  const proposal = makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED);
  const res = await withoutTestContext(() => runExecutor({
    proposal, repoRoot: repo, snapshotPath, onKept: () => commitProposal({ mode: 'worktree', path: repo, sub: '' }, proposal)
  }));
  assert.strictEqual(res.status, 'environment_error');
  assert.match(res.reason, /commit failed/);
  assert.strictEqual(res.reverted, true);
  assert.strictEqual(fs.readFileSync(path.join(repo, MATH), 'utf8'), before);
  assert.strictEqual(git(repo, ['diff', '--cached', '--name-only']), '', 'nothing left staged for the next commit');
  assert.strictEqual(git(repo, ['status', '--porcelain']), '');
  assert(!fs.existsSync(snapshotPath));
  assertTestOutcome(res);
});

test('green suite that never runs the edited code: reverted with reason edit_not_exercised, not kept', async (t) => {
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const file = 'src/extra.js';
  const cur = 'function triple(x) {\n  const out = x * 3;\n  return out;\n}';
  fs.writeFileSync(path.join(repo, file), `'use strict';\n${cur}\nmodule.exports = { triple };\n`);
  const before = fs.readFileSync(path.join(repo, file), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal(file, cur, 'function triple(x) {\n  return x * 3;\n}'), repoRoot: repo, onKept: () => { kept = true; }
  }));
  assert.strictEqual(res.status, 'reverted');
  assert.strictEqual(res.reason, 'edit_not_exercised');
  assert.strictEqual(res.coverage.exercised, false);
  assertReverted(res, repo, file, before, kept);
});

test('a kept edit carries the execution evidence', async (t) => {
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED), repoRoot: repo }));
  assert.strictEqual(res.status, 'passed', res.stderr_tail);
  assert.strictEqual(res.coverage.tool, 'v8');
  assert.strictEqual(res.coverage.exercised, true);
  assert(res.coverage.executed_lines >= 1);
  assert(!('reason' in res));
});

// ---------- SG14: test-backed commit bar ----------

const { editMutants } = require('../src/rl/bug-injector');
const { isLabeled } = require('../src/rl/collector');

function nodeRepo(t, files, script = 'node --test') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-sg14-'));
  t.after(() => env.rm(repo));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'sg14', version: '0.0.0', private: true, scripts: { test: script } }));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), src);
  }
  return repo;
}
const nodeTest = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;

test('kept edit: a mutant of the edited lines fails the suite, and the edited text is what gets committed', async (t) => {
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  let keptWith = null;
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED), repoRoot: repo,
    onKept: () => { keptWith = fs.readFileSync(path.join(repo, MATH), 'utf8'); return 'c1'; }
  }));
  assert.strictEqual(res.status, 'passed', res.stderr_tail);
  assert(res.mutation && res.mutation.killed, JSON.stringify(res.mutation));
  assert(res.mutation.run >= 1 && res.mutation.run <= 3);
  assert(keptWith.includes(ADD_PROPOSED), 'mutants are undone before the commit');
  assert.strictEqual(fs.readFileSync(path.join(repo, MATH), 'utf8'), keptWith);
});

test('green suite that runs the edit but cannot tell a mutant of it: reverted tests_insensitive, untested', async (t) => {
  const cur = 'function scale(x) {\n  const k = x * 3;\n  return k;\n}';
  const repo = nodeRepo(t, {
    'src/scale.js': `'use strict';\n${cur}\nmodule.exports = { scale };\n`,
    'test/scale.test.js': nodeTest("const { scale } = require('../src/scale');\ntest('runs', () => { scale(2); });")
  });
  const before = fs.readFileSync(path.join(repo, 'src/scale.js'), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal('src/scale.js', cur, 'function scale(x) {\n  return x * 3;\n}'), repoRoot: repo, onKept: () => { kept = true; }
  }));
  assert.strictEqual(res.status, 'reverted', res.stderr_tail);
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.coverage.exercised, true);
  assert(res.mutation.mutants >= 1 && res.mutation.run === res.mutation.mutants && !res.mutation.killed, JSON.stringify(res.mutation));
  assert(!isLabeled(res), 'no label from an insensitive suite');
  assertReverted(res, repo, 'src/scale.js', before, kept);
});

// ---------- SG20: mutant budget, timeouts and edit size ----------

const SLOW_CUR = 'function inc(x) {\n  const y = x + 1;\n  return y;\n}';
const SLOW_PROP = 'function inc(x) {\n  return x + 1;\n}';

test('mutant runs have their own budget: a suite that uses most of the test budget still gets a mutant run (AUDIT-9 C2)', async (t) => {
  // The main run takes ~2 s of the 4 s budget; a confirmed kill (mutant,
  // mutant again, unmutated) needs three more runs.
  const repo = countingSuite(t, "if (n === 1) { const t0 = Date.now(); while (Date.now() - t0 < 2000); }\nif (require('./src/inc').inc(1) !== 2) throw new Error('failed');");
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo, testTimeoutMs: 4000 }));
  assert.strictEqual(res.status, 'passed', JSON.stringify(res.mutation));
  assert(res.mutation.run === 3 && res.mutation.killed, JSON.stringify(res.mutation));
});

test('out of mutant budget: reverted mutation_budget, not tests_insensitive, and not a label (AUDIT-9 C2)', async (t) => {
  const cur = 'function f(a, b) {\n  return a;\n}';
  const prop = 'function f(a, b) {\n  return a > 1 && b < 2 ? a + 1 : 3;\n}';
  const repo = nodeRepo(t, {
    'src/f.js': `'use strict';\n${cur}\nmodule.exports = { f };\n`,
    'check.js': "require('node:test')('f', () => { const t0 = Date.now(); while (Date.now() - t0 < 900); require('assert').strictEqual(require('./src/f').f(1, 0), 3); });\n"
  }, 'node --test check.js');
  const before = fs.readFileSync(path.join(repo, 'src/f.js'), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal('src/f.js', cur, prop), repoRoot: repo, testTimeoutMs: 1500, onKept: () => { kept = true; }
  }));
  assert.strictEqual(res.status, 'reverted', res.stderr_tail);
  assert.strictEqual(res.reason, 'mutation_budget');
  assert.strictEqual(res.mutation.budget_exhausted, true);
  assert.strictEqual(res.mutation.run, 1, JSON.stringify(res.mutation));
  assert(res.mutation.mutants >= 2);
  assert(!isLabeled(res));
  assertReverted(res, repo, 'src/f.js', before, kept);
});

// One node:test test that never asserts; its n-th invocation (counted in a
// file outside the repo) runs `slow` instead of finishing at once.
function countingSuite(t, slow) {
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg20-count-')), 'n');
  t.after(() => env.rm(path.dirname(counter)));
  return nodeRepo(t, {
    'src/inc.js': `'use strict';\n${SLOW_CUR}\nmodule.exports = { inc };\n`,
    'check.js': `const fs = require('fs');\nrequire('node:test')('check', () => {\nconst p = ${JSON.stringify(counter)};\nconst n = (fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0) + 1;\nfs.writeFileSync(p, String(n));\nrequire('./src/inc').inc(1);\n${slow}\n});\n`
  }, 'node --test check.js');
}

test('a mutant run that times out is no kill: it is re-run once (AUDIT-9 H2)', async (t) => {
  const repo = countingSuite(t, 'if (n === 2) { const t0 = Date.now(); while (Date.now() - t0 < 8000); }');
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.timeouts, 1);
  assert.strictEqual(res.mutation.killed, null);
  assert(res.mutation.run >= 2);
});

test('a timed-out mutant whose re-run fails is killed', async (t) => {
  const repo = countingSuite(t, "if (n === 2) { const t0 = Date.now(); while (Date.now() - t0 < 8000); }\nif (require('./src/inc').inc(1) !== 2) throw new Error('failed');");
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo }));
  assert.strictEqual(res.status, 'passed', JSON.stringify(res.mutation));
  assert.strictEqual(res.mutation.timeouts, 1);
  assert.strictEqual(res.mutation.run, 4, 'timeout, its failing re-run, the confirming run, the unmutated run');
});

test('a mutant whose re-run times out again is no kill (AUDIT-11 C5)', async (t) => {
  const repo = countingSuite(t, 'if (n === 2 || n === 3) { const t0 = Date.now(); while (Date.now() - t0 < 8000); }');
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo, onKept: () => { kept = true; } }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.killed, null);
  assert(res.mutation.run >= 2);
  assert.strictEqual(kept, false);
});

// ---------- SG24: a kill must reproduce ----------

test('a mutant failure that does not reproduce is no kill: a suite failing on its first mutant run only (AUDIT-14 C1)', async (t) => {
  const repo = countingSuite(t, "if (n === 2) throw new Error('failed');");
  let kept = false;
  const before = fs.readFileSync(path.join(repo, 'src/inc.js'), 'utf8');
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo, onKept: () => { kept = true; } }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.killed, null);
  assert.strictEqual(res.mutation.unconfirmed, 1);
  assert(!isLabeled(res));
  assertReverted(res, repo, 'src/inc.js', before, kept);
});

test('a suite that also fails unmutated gives no kill: every run after the main one fails (load spike, AUDIT-14 C1)', async (t) => {
  const repo = countingSuite(t, "if (n > 1) throw new Error('failed');");
  let kept = false;
  const before = fs.readFileSync(path.join(repo, 'src/inc.js'), 'utf8');
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo, onKept: () => { kept = true; } }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.killed, null);
  assert.strictEqual(res.mutation.flaky, true);
  assert.strictEqual(res.mutation.run, 3, 'mutant, mutant again, unmutated');
  assertReverted(res, repo, 'src/inc.js', before, kept);
});

test('a parse check of the mutants that did not finish is mutation_budget, not tests_insensitive (AUDIT-14 H3)', async (t) => {
  const injector = require('../src/rl/bug-injector');
  const execPath = require.resolve('../src/agents/executor');
  const [origEdit, origExec] = [injector.editMutants, require.cache[execPath]];
  delete require.cache[execPath];
  injector.editMutants = () => Object.assign([], { unchecked: true });
  const fresh = require('../src/agents/executor');
  injector.editMutants = origEdit;
  require.cache[execPath] = origExec;
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const before = fs.readFileSync(path.join(repo, MATH), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => fresh.runExecutor({ proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED), repoRoot: repo, onKept: () => { kept = true; } }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'mutation_budget');
  assert.strictEqual(res.mutation.run, 0);
  assert(!isLabeled(res));
  assertReverted(res, repo, MATH, before, kept);
});

test('an exception while gathering mutation evidence reverts the edit (AUDIT-11 C5)', async (t) => {
  const hunks = require('../src/utils/hunks');
  const execPath = require.resolve('../src/agents/executor');
  const [origHunks, origExec] = [hunks.changeHunks, require.cache[execPath]];
  delete require.cache[execPath];
  hunks.changeHunks = () => { throw new Error('evidence boom'); };
  const fresh = require('../src/agents/executor');
  hunks.changeHunks = origHunks;
  require.cache[execPath] = origExec;
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const before = fs.readFileSync(path.join(repo, MATH), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => fresh.runExecutor({ proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED), repoRoot: repo, onKept: () => { kept = true; } }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.error, 'evidence boom');
  assertReverted(res, repo, MATH, before, kept);
});

test('an edit over the change-hunk cap gets no mutants: reverted mutation_budget (AUDIT-9 H1)', async (t) => {
  const n = 17;
  const fnSrc = (i, op) => `function f${i}(x) {\n  return x ${op} ${i};\n}\n`;
  const cur = Array.from({ length: n }, (_, i) => fnSrc(i, '+')).join('');
  const prop = Array.from({ length: n }, (_, i) => fnSrc(i, '-')).join('');
  const names = Array.from({ length: n }, (_, i) => `f${i}`).join(', ');
  const asserts = Array.from({ length: n }, (_, i) => `assert.strictEqual(m.f${i}(100), ${100 - i});`).join(' ');
  const repo = nodeRepo(t, {
    'src/many.js': `'use strict';\n${cur}module.exports = { ${names} };\n`,
    'test/many.test.js': nodeTest(`const m = require('../src/many');\ntest('all', () => { ${asserts} });`)
  });
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/many.js', cur, prop), repoRoot: repo }));
  assert.strictEqual(res.status, 'reverted', res.stderr_tail);
  assert.strictEqual(res.reason, 'mutation_budget');
  assert.strictEqual(res.mutation.edit_too_large, true);
  assert.strictEqual(res.mutation.run, 0);
});

test('red suite that never ran the edit: reverted edit_not_exercised, not a label', async (t) => {
  const cur = 'function twice(x) {\n  const r = x * 2;\n  return r;\n}';
  const repo = nodeRepo(t, {
    'src/twice.js': `'use strict';\n${cur}\nmodule.exports = { twice };\n`,
    'test/other.test.js': nodeTest("test('known broken', () => assert.strictEqual(1, 2));")
  });
  const before = fs.readFileSync(path.join(repo, 'src/twice.js'), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal('src/twice.js', cur, 'function twice(x) {\n  return x * 2;\n}'), repoRoot: repo, onKept: () => { kept = true; }
  }));
  assert.strictEqual(res.status, 'reverted');
  assert.strictEqual(res.reason, 'edit_not_exercised');
  assert(!isLabeled(res));
  assertReverted(res, repo, 'src/twice.js', before, kept);
});

test('a doc comment edit is no evidence: the changed function no test calls is reverted (AUDIT-5 C2)', async (t) => {
  const cur = "/** Strip parent segments. */\nfunction strip(p) {\n  return String(p).split('../').join('');\n}";
  const repo = nodeRepo(t, {
    'src/util.js': `'use strict';\n${cur}\nfunction size(s) {\n  return s.length;\n}\nmodule.exports = { strip, size };\n`,
    'test/util.test.js': nodeTest("const m = require('../src/util');\ntest('size', () => { assert.strictEqual(m.size('abc'), 3); });")
  });
  const res = await withoutTestContext(() => runExecutor({
    proposal: makeProposal('src/util.js', cur, "/** Remove parent segments. */\nfunction strip(p) {\n  return String(p).replace('../', '');\n}"), repoRoot: repo
  }));
  assert.strictEqual(res.status, 'reverted');
  assert.strictEqual(res.reason, 'edit_not_exercised');
  assert.strictEqual(res.coverage.exercised, false);
});

test('editMutants: parse-valid mutants of the changed characters only', () => {
  const src = "'use strict';\nconst x = require('./y');\nfunction g(s) {\n  if (s.length > 255) throw new RangeError('too long');\n  return s;\n}\n";
  const at = (needle) => ({ start: src.indexOf(needle), end: src.indexOf(needle) + needle.length, file: 'g.js' });
  const changed = editMutants(src, at('255'));
  assert.deepStrictEqual(changed.map(m => m.mutation), ['numeric_off_by_one']);
  assert(changed[0].src.includes('s.length > 256'));
  assert.deepStrictEqual(editMutants(src, at('throw')), [], 'unchanged tokens on the edited line are not mutated (AUDIT-8 C1/C2)');
  assert.deepStrictEqual(editMutants(src, at("require('./y')")), [], 'module specifiers are not mutated');
  const py = 'def f(x):\n    if x > 3:\n        return x + 1\n    return 0\n';
  const pm = editMutants(py, { start: py.indexOf('    if'), end: py.indexOf('    return 0'), file: 'f.py' });
  assert(pm.length >= 1 && pm.every(m => !m.src.includes('===')), JSON.stringify(pm));
  assert.deepStrictEqual(editMutants('a = 1\n', { start: 0, end: 5, file: 'a.go' }), []);
});

// ---------- SG16: coverage evaluation shares the test budget ----------

test('coverage evaluation that overruns the test budget: reverted coverage_timeout, untested, not edit_not_exercised', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-sg16-'));
  t.after(() => env.rm(repo));
  // `make test` is `true` (far inside 300 ms); evaluating a 4 MB edited file is not.
  fs.writeFileSync(path.join(repo, 'Makefile'), 'test:\n\t@true\n');
  const cur = 'function head(a, b) {\n  const t = a + b;\n  return t;\n}';
  let src = `'use strict';\n${cur}\n`;
  for (let j = 0; src.length < 4e6; j++) src += `function f${j}(a, b) {\n  const t = a * ${j} + b;\n  return t;\n}\n`;
  fs.writeFileSync(path.join(repo, 'big.js'), src);
  let kept = false;
  const res = await runExecutor({
    proposal: makeProposal('big.js', cur, 'function head(a, b) {\n  return a + b;\n}'), repoRoot: repo, testTimeoutMs: 300, onKept: () => { kept = true; }
  });
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.coverage));
  assert.strictEqual(res.reason, 'coverage_timeout');
  assert(!isLabeled(res), 'a coverage overrun is no label');
  assertReverted(res, repo, 'big.js', src, kept);
});

test('mutant runs collect no coverage, even with NODE_V8_COVERAGE inherited', async (t) => {
  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-sg16-cov-'));
  const prev = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = covDir;
  t.after(() => { if (prev === undefined) delete process.env.NODE_V8_COVERAGE; else process.env.NODE_V8_COVERAGE = prev; env.rm(covDir); });
  const repo = env.copyFixture('js-basic');
  t.after(() => env.rm(repo));
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal(MATH, ADD_CURRENT, ADD_PROPOSED), repoRoot: repo }));
  assert.strictEqual(res.status, 'passed', res.stderr_tail);
  assert(res.mutation.run >= 1);
  assert.strictEqual(res.coverage.exercised, true);
  assert.deepStrictEqual(fs.readdirSync(covDir), []);
});

// ---------- SG18: mutation evidence on the change itself ----------

const diffTesting = require('../src/validation/diff-testing');

async function execOn(t, file, cur, prop, rest, testBody, diffTest) {
  const repo = nodeRepo(t, { [file]: `'use strict';\n${cur}\n${rest}\n`, 'test/a.test.js': nodeTest(testBody) });
  const before = fs.readFileSync(path.join(repo, file), 'utf8');
  const proposal = makeProposal(file, cur, prop);
  proposal.diff_test = diffTest === undefined ? diffTesting.run({ currentSrc: cur, proposedSrc: prop, fileSrc: before }) : diffTest;
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({ proposal, repoRoot: repo, onKept: () => { kept = true; return 'c1'; } }));
  return { res, repo, before, kept };
}

test('a deleted line is no mutation evidence: a mutant of the adjacent tested line does not keep it (AUDIT-8 C1)', async (t) => {
  const cur = "function discount(price) {\n  const d = price > 100 ? price * 0.9 : price;\n  console.log('discount applied', price);\n  return d;\n}";
  const prop = 'function discount(price) {\n  const d = price > 100 ? price * 0.9 : price;\n  return d;\n}';
  const { res, repo, before, kept } = await execOn(t, 'src/billing.js', cur, prop, 'module.exports = { discount };',
    "const m = require('../src/billing');\ntest('discount', () => { assert.strictEqual(m.discount(50), 50); assert.strictEqual(m.discount(200), 180); });", null);
  assert.strictEqual(res.status, 'reverted', res.stderr_tail);
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.run, 0, 'no mutant of an unedited line is run');
  assert.strictEqual(res.mutation.unobserved_deletion_line, 4, 'the deletion point in the edited file');
  assertReverted(res, repo, 'src/billing.js', before, kept);
});

test('a deletion stands only on an equivalent diff test that ran the deleted code', async (t) => {
  const cur = 'function area(w, h) {\n  const unused = w * 2;\n  return w * h;\n}';
  const prop = 'function area(w, h) {\n  return w * h;\n}';
  const body = "const m = require('../src/area');\ntest('area', () => { assert.strictEqual(m.area(2, 3), 6); });";
  const ok = await execOn(t, 'src/area.js', cur, prop, 'module.exports = { area };', body);
  assert.strictEqual(ok.res.status, 'passed', JSON.stringify(ok.res.mutation));
  assert.strictEqual(ok.res.mutation.ok, true);
  assert.strictEqual(ok.res.mutation.run, 0);
  const unseen = await execOn(t, 'src/area.js', cur, prop, 'module.exports = { area };', body, { applicable: true, verdict: 'equivalent', runs: 12, deletions_observed: false, duration_ms: 1 });
  assert.strictEqual(unseen.res.status, 'reverted');
  assert.strictEqual(unseen.res.reason, 'tests_insensitive');
  assertReverted(unseen.res, unseen.repo, 'src/area.js', unseen.before, unseen.kept);
});

test('an unrelated token on the edited line is no evidence: a hunk with no mutable changed token is reverted (AUDIT-8 C2)', async (t) => {
  const cur = "function toRow(u) {\n  return { id: null, name: null, kind: 'user' };\n}";
  const prop = "function toRow(u) {\n  return { name: null, id: null, kind: 'user' };\n}";
  const { res, repo, before, kept } = await execOn(t, 'src/row.js', cur, prop, 'module.exports = { toRow };',
    "const m = require('../src/row');\ntest('toRow', () => { const r = m.toRow({}); assert.strictEqual(r.id, null); assert.strictEqual(r.kind, 'user'); });",
    { applicable: true, verdict: 'equivalent', runs: 12, duration_ms: 1 });
  assert.strictEqual(res.status, 'reverted', res.stderr_tail);
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.run, 0);
  assert.strictEqual(res.mutation.unmutated_hunk_line, 3);
  assertReverted(res, repo, 'src/row.js', before, kept);
});

test('every change hunk needs its own killed mutant', async (t) => {
  const cur = 'function f(x) {\n  const a = x * 2;\n  const keep = 0;\n  const b = x > 1000 ? 1 : 0;\n  return a + b + keep;\n}';
  const prop = 'function f(x) {\n  const a = x + x;\n  const keep = 0;\n  const b = x >= 1001 ? 1 : 0;\n  return a + b + keep;\n}';
  const weak = await execOn(t, 'src/f.js', cur, prop, 'module.exports = { f };',
    "const m = require('../src/f');\ntest('f', () => { assert.strictEqual(m.f(1), 2); });", null);
  assert.strictEqual(weak.res.status, 'reverted', weak.res.stderr_tail);
  assert.strictEqual(weak.res.reason, 'tests_insensitive');
  assert.strictEqual(weak.res.mutation.hunks, 2);
  assert.strictEqual(weak.res.mutation.surviving_hunk_line, 5);
  assertReverted(weak.res, weak.repo, 'src/f.js', weak.before, weak.kept);
  const strong = await execOn(t, 'src/f.js', cur, prop, 'module.exports = { f };',
    "const m = require('../src/f');\ntest('f', () => { assert.strictEqual(m.f(1), 2); assert.strictEqual(m.f(1001), 2003); });", null);
  assert.strictEqual(strong.res.status, 'passed', JSON.stringify(strong.res.mutation));
  assert.strictEqual(strong.res.mutation.ok, true);
  assert(strong.res.mutation.run >= 2);
});

// ---------- SG22: deleted tokens of every hunk; a kill counts for its own site ----------

test('deleted tokens in a hunk that also inserts need observation: a kill of the inserted token does not keep them (AUDIT-12 C2)', async (t) => {
  const cur = "function scale(n) {\n  if (typeof n === 'bigint') {\n    return n * 1000n;\n  }\n  return n * 1000;\n}";
  const prop = 'function scale(n) {\n  return 1000 * n;\n}';
  const body = "const m = require('../src/scale');\ntest('scale', () => { assert.strictEqual(m.scale(2), 2000); });";
  const { res, repo, before, kept } = await execOn(t, 'src/scale.js', cur, prop, 'module.exports = { scale };', body);
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.unobserved_deletion_line, 3);
  assert.strictEqual(res.mutation.run, 0);
  assertReverted(res, repo, 'src/scale.js', before, kept);
  // A token replaced one for one (`>` -> `>=`) is covered by the kill of its replacement.
  const sub = await execOn(t, 'src/lim.js', 'function lim(x) {\n  return x > 9 ? 1 : 0;\n}', 'function lim(x) {\n  return x >= 10 ? 1 : 0;\n}', 'module.exports = { lim };',
    "const m = require('../src/lim');\ntest('lim', () => { assert.strictEqual(m.lim(10), 1); assert.strictEqual(m.lim(9), 0); });",
    { applicable: true, verdict: 'equivalent', runs: 12, deletions_observed: false, duration_ms: 1 });
  assert.strictEqual(sub.res.status, 'passed', JSON.stringify(sub.res.mutation));
});

test('a killed mutant counts only for the token it mutates: slice(0, 1000) killed via 0 -> 1 keeps nothing (AUDIT-12 H3, DM3)', async (t) => {
  const cur = 'function body(s) {\n  return String(s);\n}';
  const prop = 'function body(s) {\n  return String(s).slice(0, 1000);\n}';
  const weak = await execOn(t, 'src/body.js', cur, prop, 'module.exports = { body };',
    "const m = require('../src/body');\ntest('body', () => { assert.strictEqual(m.body('abc'), 'abc'); });");
  assert.strictEqual(weak.res.status, 'reverted', JSON.stringify(weak.res.mutation));
  assert.strictEqual(weak.res.reason, 'tests_insensitive');
  assert.strictEqual(weak.res.mutation.sites, 3, 'the call of slice, 0 and 1000');
  assert.strictEqual(weak.res.mutation.surviving_site_line, 3, 'a site survives');
  assertReverted(weak.res, weak.repo, 'src/body.js', weak.before, weak.kept);
  const strong = await execOn(t, 'src/body.js', cur, prop, 'module.exports = { body };',
    "const m = require('../src/body');\ntest('body', () => { assert.strictEqual(m.body('abc'), 'abc'); assert.strictEqual(m.body('x'.repeat(1001)).length, 1000); });");
  assert.strictEqual(strong.res.status, 'passed', JSON.stringify(strong.res.mutation));
  assert.strictEqual(strong.res.mutation.run, 9, 'one confirmed kill (three runs) per site');
});

// ---------- SG25: evidence relevance, Python mutant runs ----------

test('a change carried by a named constant needs a kill of that constant: slice(0, MAX_BODY) killed via 0 -> 1 keeps nothing (AUDIT-13 H1, T06)', async (t) => {
  const cur = 'function body(s) {\n  return String(s);\n}';
  const prop = 'function body(s) {\n  return String(s).slice(0, MAX_BODY);\n}';
  const rest = 'const MAX_BODY = 4096;\nmodule.exports = { body };';
  // The call and the slice start are tested, the cap is not (any cap under 5000 passes).
  const weak = await execOn(t, 'src/body.js', cur, prop, rest,
    "const m = require('../src/body');\ntest('body', () => { const r = m.body('ab' + 'x'.repeat(5000)); assert(r.startsWith('ab') && r.length < 5000); });");
  assert.strictEqual(weak.res.status, 'reverted', JSON.stringify(weak.res.mutation));
  assert.strictEqual(weak.res.reason, 'tests_insensitive');
  assert.strictEqual(weak.res.mutation.surviving_ref, 'MAX_BODY');
  assertReverted(weak.res, weak.repo, 'src/body.js', weak.before, weak.kept);
  const strong = await execOn(t, 'src/body.js', cur, prop, rest,
    "const m = require('../src/body');\ntest('body', () => { assert.strictEqual(m.body('abc'), 'abc'); assert.strictEqual(m.body('x'.repeat(5000)).length, 4096); });");
  assert.strictEqual(strong.res.status, 'passed', JSON.stringify(strong.res.mutation));
});

test('a guard through an existing helper needs a kill at every site of the helper, not just the if (AUDIT-13 H1, U04)', async (t) => {
  const cur = 'function addPoints(user, n) {\n  user.points += n;\n  return user;\n}';
  const prop = 'function addPoints(user, n) {\n  if (isSafe(n)) user.points += n;\n  return user;\n}';
  const { res, repo, before, kept } = await execOn(t, 'src/pts.js', cur, prop,
    'function isSafe(n) {\n  return !(Math.abs(n) > Number.MAX_SAFE_INTEGER);\n}\nmodule.exports = { addPoints };',
    "const m = require('../src/pts');\ntest('pts', () => { assert.deepStrictEqual(m.addPoints({ points: 1 }, 2), { points: 3 }); });");
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.surviving_ref, 'isSafe');
  assertReverted(res, repo, 'src/pts.js', before, kept);
});

test('a replaced method reference with nothing to mutate is no evidence: includes -> indexOf !== -1 (AUDIT-13 H1, G05)', async (t) => {
  const { res, repo, before, kept } = await execOn(t, 'src/has.js', 'function has(xs, x) {\n  return xs.includes(x);\n}',
    'function has(xs, x) {\n  return xs.indexOf(x) !== -1;\n}', 'module.exports = { has };',
    "const m = require('../src/has');\ntest('has', () => { assert.strictEqual(m.has([1, 2], 2), true); assert.strictEqual(m.has([1, 2], 3), false); });");
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.unmutated_ref, 'indexOf');
  assert.strictEqual(res.mutation.run, 0);
  assertReverted(res, repo, 'src/has.js', before, kept);
});

// ---------- SG26: use-site relevance, per-test kills ----------

test('editMutants: every inserted read gets a use-site mutant, however and wherever its name is bound (AUDIT-16 C1, H1)', () => {
  const js = (pre, ref, body = 'String(s)') => editMutants(`'use strict';\n${pre}\nfunction f(s) {\n  return ${body}.slice(0, ${ref});\n}\n`,
    { file: 'f.js', before: `'use strict';\n${pre}\nfunction f(s) {\n  return ${body};\n}\n` });
  const py = (pre, ref, head = '') => editMutants(`${pre}\n\ndef f(s):\n${head}    return str(s)[0:${ref}]\n`,
    { file: 'f.py', before: `${pre}\n\ndef f(s):\n${head}    return str(s)\n` });
  const useOf = (ms, name) => ms.find(m => m.mutation === 'use_site' && m.ref === name);
  for (const [pre, ref] of [['const { maxLen } = LIMITS;', 'maxLen'], ['const [A, MAX] = [1, 4096];', 'MAX'], ['let MAX;\nMAX = 4096;', 'MAX'],
    ["const { MAX } = require('./limits');", 'MAX'], ['', 'f.MAX']]) {
    const m = useOf(js(pre, ref), ref.split('.')[0]);
    assert(m, `${pre} ${ref}`);
    assert.match(m.src, new RegExp(`slice\\(0, \\(\\(v\\) => .*\\)\\(${ref.replace('.', '\\.')}\\)\\)`), 'the value is perturbed where the edit reads it');
  }
  assert(useOf(editMutants("'use strict';\nfunction f(s) {\n  const max = 4096;\n  return String(s).slice(0, max);\n}\n",
    { file: 'f.js', before: "'use strict';\nfunction f(s) {\n  const max = 4096;\n  return String(s);\n}\n" }), 'max'), 'a local');
  assert(js('class K {\n  static MAX = 4;\n  static g(s) { return s; }\n}', 'this.MAX').some(m => m.ref === 'MAX' && m.src.includes('(this.MAX))')), 'a this. member');
  for (const [pre, ref, head] of [['MIN, MAX = 1, 4096', 'MAX'], ['try:\n    MAX = 4096\nexcept ImportError:\n    MAX = 1024', 'MAX'],
    ['from app.limits import MAX', 'MAX'], ['', 'cfg["max"]', '    cfg = {"max": 4096}\n'], ['', 'self.MAX']]) {
    const m = useOf(py(pre, ref, head), ref.split(/[.[]/)[0]);
    assert(m, `${pre} ${ref}`);
    assert(m.src.includes(`, ${ref})]`), m.src);
  }
  // A call is skipped: its receiver (else its first argument) takes its place.
  const nested = editMutants('def f(s):\n    def cut(x, n=4):\n        return x[0:n]\n    return cut(str(s)) + ""\n',
    { file: 'f.py', before: 'def f(s):\n    def cut(x, n=4):\n        return x[0:n]\n    return str(s)\n' });
  assert(useOf(nested, 'cut').src.includes('return (str(s)) + ""'));
  assert(useOf(js('', '4'), 'slice').src.includes('return (String(s));'));
  // Bindings, keys and labels are no use; a replaced name also reverts on its own site, unless the code around it changed.
  assert(!js('', '4', '{ k: s }').some(m => m.ref === 'k'));
  const swap = editMutants("'use strict';\nfunction t(s) {\n  return s.trimStart() + 1;\n}\n", { file: 't.js', before: "'use strict';\nfunction t(s) {\n  return s.trim() + 1;\n}\n" });
  assert(swap.some(m => m.revert && m.mutation === 'revert_reference' && m.src.includes('s.trim() + 1')));
  assert.deepStrictEqual(editMutants("'use strict';\nfunction t(s) {\n  return s.indexOf(1) !== -1;\n}\n",
    { file: 't.js', before: "'use strict';\nfunction t(s) {\n  return s.includes(1);\n}\n" }).unmutated_ref, { name: 'indexOf', line: 3, hunk: 0 });
  // A read with no parse-valid perturbation (a match-case value pattern) is no evidence.
  const pm = 'import enum\nclass C(enum.Enum):\n    A = 1\n    B = 2\n\n\ndef f(x):\n    match x:\n        case C.A:\n            return 1\n    return 0\n';
  assert.deepStrictEqual(editMutants(pm.replace('case C.A:', 'case C.B:'), { file: 'f.py', before: pm }).unmutated_ref, { name: 'B', line: 9, hunk: 0 });
});

const hasPyTooling = require('../src/runner/test-runner').coverageTool('a.py', { cmd: 'pytest' }) === 'coverage.py';

function pyPkgRepo(t, mod, body) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-sg25-'));
  t.after(() => env.rm(repo));
  fs.writeFileSync(path.join(repo, 'pytest.ini'), '[pytest]\n');
  fs.mkdirSync(path.join(repo, 'app'));
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(repo, 'app/m.py'), mod);
  fs.writeFileSync(path.join(repo, 'tests/test_m.py'), `import app.m as m\n\n\n${body}`);
  return repo;
}

test('Python mutant runs import the package like the edit run: a sensitive suite keeps the edit (AUDIT-13 C2)', { skip: hasPyTooling ? false : 'pytest + coverage.py not installed' }, async (t) => {
  const cur = 'def scale(x, n):\n    return x + n * 2\n';
  const repo = pyPkgRepo(t, cur, 'def test_scale():\n    assert m.scale(1, 2) == 7\n');
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('app/m.py', cur, 'def scale(x, n):\n    return x + n * 3\n'), repoRoot: repo, onKept: () => 'c1' }));
  assert.strictEqual(res.status, 'passed', `${res.reason} ${JSON.stringify(res.mutation)} ${res.stdout_tail}`);
  assert(!res.mutation.flaky && !res.mutation.collection_errors, JSON.stringify(res.mutation));
});

test('a Python mutant that fails at import (collection) is no kill (AUDIT-13 C2)', { skip: hasPyTooling ? false : 'pytest + coverage.py not installed' }, async (t) => {
  const repo = pyPkgRepo(t, 'SIZE = 2\nassert SIZE % 2 == 0\n', 'def test_loads():\n    assert m.SIZE > 0\n');
  const before = fs.readFileSync(path.join(repo, 'app/m.py'), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('app/m.py', 'SIZE = 2\n', 'SIZE = 4\n'), repoRoot: repo, onKept: () => { kept = true; return 'c1'; } }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert(res.mutation.collection_errors >= 1, JSON.stringify(res.mutation));
  assert.strictEqual(res.mutation.killed, null);
  assertReverted(res, repo, 'app/m.py', before, kept);
});

test('a cap read where the edit uses it needs its own kill, wherever it is bound: a local, or a shared constant another tested consumer reads (AUDIT-16 H1, H2)', async (t) => {
  const cur = 'function summary(s) {\n  const max = 4096;\n  return String(s);\n}';
  const prop = 'function summary(s) {\n  const max = 4096;\n  return String(s).slice(0, max);\n}';
  const weak = "const m = require('../src/s');\ntest('summary', () => { const r = m.summary('ab' + 'x'.repeat(5000)); assert(r.startsWith('ab') && r.length < 5000); });";
  const local = await execOn(t, 'src/s.js', cur, prop, 'module.exports = { summary };', weak);
  assert.strictEqual(local.res.status, 'reverted', JSON.stringify(local.res.mutation));
  assert.strictEqual(local.res.reason, 'tests_insensitive');
  assert.strictEqual(local.res.mutation.surviving_ref, 'max');
  assertReverted(local.res, local.repo, 'src/s.js', local.before, local.kept);
  const shared = await execOn(t, 'src/s.js', 'function summary(s) {\n  return String(s);\n}', 'function summary(s) {\n  return String(s).slice(0, MAX);\n}',
    'const MAX = 4096;\nfunction title(s) {\n  return String(s).slice(0, MAX);\n}\nmodule.exports = { summary, title };',
    `${weak}\ntest('title', () => { assert.strictEqual(m.title('x'.repeat(5000)).length, 4096); });`);
  assert.strictEqual(shared.res.status, 'reverted', JSON.stringify(shared.res.mutation));
  assert.strictEqual(shared.res.mutation.surviving_ref, 'MAX', 'the title test reads MAX elsewhere: no kill of this use');
  const strong = await execOn(t, 'src/s.js', cur, prop, 'module.exports = { summary };',
    "const m = require('../src/s');\ntest('summary', () => { assert.strictEqual(m.summary('ab' + 'x'.repeat(5000)), 'ab' + 'x'.repeat(4094)); });");
  assert.strictEqual(strong.res.status, 'passed', JSON.stringify(strong.res.mutation));
});

test('a mutant that breaks module load is no kill: required at a test file\'s top or inside a test (AUDIT-16 C2)', async (t) => {
  const cur = 'const P = [{ n: 3 }, { n: 4096 }];\nconst MAX = P[0].n;';
  const prop = 'const P = [{ n: 3 }, { n: 4096 }];\nconst MAX = P[1].n;';
  const rest = 'function body(s) {\n  return String(s).slice(0, MAX);\n}\nmodule.exports = { body };';
  for (const body of ["const m = require('../src/b');\ntest('body', () => { assert.strictEqual(m.body('x'.repeat(10)).length, 10); });",
    "test('body', () => { assert.strictEqual(require('../src/b').body('x'.repeat(10)).length, 10); });"]) {
    const { res, repo, before, kept } = await execOn(t, 'src/b.js', cur, prop, rest, body, { ...GATE_DIFF_TEST });
    assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
    assert.strictEqual(res.reason, 'tests_insensitive');
    assert(res.mutation.collection_errors >= 1, JSON.stringify(res.mutation));
    assert.strictEqual(res.mutation.killed, null);
    assertReverted(res, repo, 'src/b.js', before, kept);
  }
});

// The executor with runTests scripted: the main run passes and exercises the
// edit, then each call returns the next of `runs`.
function scriptedExecutor(runs) {
  const runner = require('../src/runner/test-runner');
  const execPath = require.resolve('../src/agents/executor');
  const [orig, origExec] = [runner.runTests, require.cache[execPath]];
  delete require.cache[execPath];
  const seq = [{ status: 'passed', tests: { a: 'pass', b: 'pass' }, coverage: { available: true, exercised: true } }, ...runs];
  let i = 0;
  runner.runTests = async () => ({ framework: 'npm', command: 'npm test', stdout: '', stderr: '', execution_time_ms: 5, ...seq[Math.min(i++, seq.length - 1)] });
  const fresh = require('../src/agents/executor');
  runner.runTests = orig;
  require.cache[execPath] = origExec;
  return fresh;
}

test('a kill is a test that passed unmutated and fails in both mutant runs, with the same set of tests (AUDIT-16 C2)', async (t) => {
  const cur = 'function inc(x) {\n  return x + 1;\n}';
  const prop = 'function inc(x) {\n  return x + 2;\n}';
  const pass = { status: 'passed', tests: { a: 'pass', b: 'pass' } };
  const fail = (tests) => ({ status: 'failed', ...(tests ? { tests } : {}) });
  const cases = [
    ['no per-test results', [fail(), fail(), pass], 'no_failed_test'],
    ['only a cancelled test', [fail({ a: 'error', b: 'pass' }), fail({ a: 'error', b: 'pass' }), pass], 'no_failed_test'],
    ['a test missing from the mutant run', [fail({ a: 'fail' }), fail({ a: 'fail' }), pass], 'test_set_changed'],
    ['a different test failing each time', [fail({ a: 'fail', b: 'pass' }), fail({ a: 'pass', b: 'fail' }), pass], 'unconfirmed']
  ];
  for (const [label, runs, counter] of cases) {
    const repo = nodeRepo(t, { 'src/inc.js': `'use strict';\n${cur}\nmodule.exports = { inc };\n` });
    const res = await scriptedExecutor(runs).runExecutor({ proposal: makeProposal('src/inc.js', cur, prop), repoRoot: repo, onKept: () => 'c1' });
    assert.strictEqual(res.status, 'reverted', `${label}: ${JSON.stringify(res.mutation)}`);
    assert.strictEqual(res.reason, 'tests_insensitive', label);
    assert.strictEqual(res.mutation.killed, null, label);
    assert(res.mutation[counter] >= 1, `${label}: ${JSON.stringify(res.mutation)}`);
  }
  const repo = nodeRepo(t, { 'src/inc.js': `'use strict';\n${cur}\nmodule.exports = { inc };\n` });
  const res = await scriptedExecutor([fail({ a: 'fail', b: 'pass' }), fail({ a: 'fail', b: 'fail' }), pass]).runExecutor({ proposal: makeProposal('src/inc.js', cur, prop), repoRoot: repo, onKept: () => 'c1' });
  assert.strictEqual(res.status, 'passed', JSON.stringify(res.mutation));
  assert.strictEqual(res.mutation.killed_test, 'a');
});

test('Python: a class attribute read through self. needs its own kill at the use (AUDIT-16 H1)', { skip: hasPyTooling ? false : 'pytest + coverage.py not installed' }, async (t) => {
  const cur = 'class Body:\n    MAX = 4096\n\n    def of(self, s):\n        return str(s)\n';
  const prop = 'class Body:\n    MAX = 4096\n\n    def of(self, s):\n        return str(s)[0:self.MAX]\n';
  const repo = pyPkgRepo(t, cur, 'def test_of():\n    assert m.Body().of("abc") == "abc"\n');
  const before = fs.readFileSync(path.join(repo, 'app/m.py'), 'utf8');
  let kept = false;
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('app/m.py', cur, prop), repoRoot: repo, onKept: () => { kept = true; return 'c1'; } }));
  assert.strictEqual(res.status, 'reverted', JSON.stringify(res.mutation));
  assert.strictEqual(res.reason, 'tests_insensitive');
  assert.strictEqual(res.mutation.surviving_ref, 'self');
  assertReverted(res, repo, 'app/m.py', before, kept);
});
