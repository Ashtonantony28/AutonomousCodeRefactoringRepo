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
  const repo = nodeRepo(t, {
    'src/inc.js': `'use strict';\n${SLOW_CUR}\nmodule.exports = { inc };\n`,
    'check.js': "const t0 = Date.now(); while (Date.now() - t0 < 900); require('assert').strictEqual(require('./src/inc').inc(1), 2);\n"
  }, 'node check.js');
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo, testTimeoutMs: 2500 }));
  assert.strictEqual(res.status, 'passed', JSON.stringify(res.mutation));
  assert(res.mutation.run >= 1 && res.mutation.killed, JSON.stringify(res.mutation));
});

test('out of mutant budget: reverted mutation_budget, not tests_insensitive, and not a label (AUDIT-9 C2)', async (t) => {
  const cur = 'function f(a, b) {\n  return a;\n}';
  const prop = 'function f(a, b) {\n  return a > 1 && b < 2 ? a + 1 : 3;\n}';
  const repo = nodeRepo(t, {
    'src/f.js': `'use strict';\n${cur}\nmodule.exports = { f };\n`,
    'check.js': "const t0 = Date.now(); while (Date.now() - t0 < 900); require('./src/f').f(0, 0);\n"
  }, 'node check.js');
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

// The suite never asserts; its n-th invocation (counted in a file outside
// the repo) runs `slow` instead of finishing at once.
function countingSuite(t, slow) {
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg20-count-')), 'n');
  t.after(() => env.rm(path.dirname(counter)));
  return nodeRepo(t, {
    'src/inc.js': `'use strict';\n${SLOW_CUR}\nmodule.exports = { inc };\n`,
    'check.js': `const fs = require('fs');\nconst p = ${JSON.stringify(counter)};\nconst n = (fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0) + 1;\nfs.writeFileSync(p, String(n));\nrequire('./src/inc').inc(1);\n${slow}\n`
  }, 'node check.js');
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
  const repo = countingSuite(t, 'if (n === 2) { const t0 = Date.now(); while (Date.now() - t0 < 8000); }\nif (n > 2) process.exit(1);');
  const res = await withoutTestContext(() => runExecutor({ proposal: makeProposal('src/inc.js', SLOW_CUR, SLOW_PROP), repoRoot: repo }));
  assert.strictEqual(res.status, 'passed', JSON.stringify(res.mutation));
  assert.strictEqual(res.mutation.timeouts, 1);
  assert.strictEqual(res.mutation.run, 2);
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
  const cur = "function toRow(u) {\n  return { id: u.id, name: u.name, kind: 'user' };\n}";
  const prop = "function toRow(u) {\n  return { name: u.name, id: u.id, kind: 'user' };\n}";
  const { res, repo, before, kept } = await execOn(t, 'src/row.js', cur, prop, 'module.exports = { toRow };',
    "const m = require('../src/row');\ntest('toRow', () => { const r = m.toRow({ id: 1, name: 'a' }); assert.strictEqual(r.id, 1); assert.strictEqual(r.kind, 'user'); });",
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
