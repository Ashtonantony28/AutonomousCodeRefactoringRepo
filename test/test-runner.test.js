'use strict';

const { rm, copyFixture } = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { detectCommand, parseCounts, runTests } = require('../src/runner/test-runner');
const { makeTempRepo } = require('./helpers/factories');

const hasPytest = (() => {
  try { return spawnSync('pytest', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
})();

test('detects npm test command', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const cmd = detectCommand(repo);
  assert(cmd && cmd.cmd === 'npm');
});

test('parses jest counts', () => {
  const c = parseCounts('Tests:       1 failed, 3 passed', 'npm');
  assert.strictEqual(c.passed, 3);
  assert.strictEqual(c.failed, 1);
});

test('no-tests fixture has no test runner', (t) => {
  const repo = copyFixture('no-tests');
  t.after(() => rm(repo));
  assert.strictEqual(detectCommand(repo), null);
});

test('py-basic fixture detects pytest', (t) => {
  const repo = copyFixture('py-basic');
  t.after(() => rm(repo));
  const cmd = detectCommand(repo);
  assert.strictEqual(cmd && cmd.framework, 'pytest');
});

test('py-basic fixture tests pass under pytest', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  const repo = copyFixture('py-basic');
  t.after(() => rm(repo));
  const r = await runTests({ repoRoot: repo, command: { cmd: 'pytest', args: ['-q', '-p', 'no:cacheprovider'], framework: 'pytest' } });
  assert.strictEqual(r.status, 'passed', r.stdout + r.stderr);
});

test('timeout kills the whole process group, grandchildren included', { skip: process.platform === 'win32' }, async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { runCommand } = require('../src/runner/test-runner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-pgrp-'));
  t.after(() => rm(dir));
  const pidFile = path.join(dir, 'pid');
  const r = await runCommand({
    cmd: 'sh',
    args: ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`],
    cwd: dir,
    env: process.env,
    timeoutMs: 300
  });
  assert.strictEqual(r.timedOut, true);
  assert(r.durationMs < 5000, `returned after ${r.durationMs} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert(pid > 0);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const t0 = Date.now();
  while (alive() && Date.now() - t0 < 2000) await new Promise(r2 => setTimeout(r2, 20));
  assert.strictEqual(alive(), false, `grandchild sleep ${pid} survived the timeout`);
});

test('a process left in the test group after a normal exit is killed (AUDIT-11 H2)', { skip: process.platform !== 'linux' }, async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { runCommand } = require('../src/runner/test-runner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-straggler-'));
  const pidFile = path.join(dir, 'pid');
  let pid = 0;
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } rm(dir); });
  const r = await runCommand({ cmd: 'sh', args: ['-c', `sleep 30 & echo $! > "${pidFile}"`], cwd: dir, env: process.env, timeoutMs: 20000 });
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.exitCode, 0);
  pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert(pid > 0);
  // Dead or a zombie waiting to be reaped (no PID 1 reaping assumed).
  const dead = () => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] === 'Z'; } catch { return true; } };
  const t0 = Date.now();
  while (!dead() && Date.now() - t0 < 3000) await new Promise(r2 => setTimeout(r2, 20));
  assert(dead(), `straggler sleep ${pid} still running after the test command exited`);
});

test('runTests reports timeout through the process-group kill', { skip: process.platform === 'win32' }, async () => {
  const r = await runTests({ repoRoot: process.cwd(), command: { cmd: 'sh', args: ['-c', 'sleep 30 & wait'], framework: 'sh' }, timeoutMs: 200 });
  assert.strictEqual(r.status, 'timeout');
});

// --- bounded runner and execution evidence (SG12) ---------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCommand, changedSpan, coverageTool } = require('../src/runner/test-runner');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir));
  return dir;
}

// A suite that leaves a setsid() daemon holding our stdout/stderr, then exits
// 0 ('exit') or never exits ('hang').
function daemonSuite(t, mode) {
  const dir = tmp(t, 'refactor-daemon-');
  const pidFile = path.join(dir, 'daemon.pid');
  fs.writeFileSync(path.join(dir, 'suite.js'), [
    "const c = require('child_process').spawn('sleep', ['20'], { detached: true, stdio: 'inherit' });",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    "c.unref(); console.log('1 passing');",
    mode === 'exit' ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'
  ].join('\n'));
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* */ } });
  return { dir, command: { cmd: process.execPath, args: ['suite.js'], framework: 'npm' } };
}

test('runTests returns on exit while a setsid daemon still holds stdio', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, command } = daemonSuite(t, 'exit');
  const t0 = Date.now();
  const r = await runTests({ repoRoot: dir, command, timeoutMs: 10_000 });
  assert(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.status, 'passed');
  assert.strictEqual(r.passed_tests, 1, 'output written before exit is kept');
});

test('timeout is a hard bound even when a setsid daemon holds stdio', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, command } = daemonSuite(t, 'hang');
  const t0 = Date.now();
  const r = await runCommand({ ...command, cwd: dir, env: process.env, timeoutMs: 300 });
  assert(Date.now() - t0 < 300 + 2000, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.timedOut, true);
  assert.match(r.stdout, /1 passing/);
});

test('a command that cannot be spawned is environment_error, never passed', async (t) => {
  const dir = tmp(t, 'refactor-enoent-');
  const r = await runTests({ repoRoot: dir, command: { cmd: 'refactor-no-such-binary', args: [], framework: 'npm' } });
  assert.strictEqual(r.status, 'environment_error');
  assert.match(r.stderr, /ENOENT/);
});

test('changedSpan is the minimal changed region of the new text', () => {
  assert.deepStrictEqual(changedSpan('abcXdef', 'abcYYdef'), { start: 3, end: 5 });
  assert.deepStrictEqual(changedSpan('abcXdef', 'abcdef'), { start: 3, end: 3 });
  assert.deepStrictEqual(changedSpan('aaa', 'aaaa'), { start: 3, end: 4 });
  assert.deepStrictEqual(changedSpan('same', 'same'), { start: 4, end: 4 });
});

test('coverageTool: v8 for plain JS; none for other languages or Python outside pytest', () => {
  assert.strictEqual(coverageTool('src/a.js', { cmd: 'npm' }), 'v8');
  assert.strictEqual(coverageTool('src/a.mjs', { cmd: 'make' }), 'v8');
  assert.strictEqual(coverageTool('src/a.ts', { cmd: 'npm' }), null);
  assert.strictEqual(coverageTool('main.go', { cmd: 'make' }), null);
  assert.strictEqual(coverageTool('calc/ops.py', { cmd: 'make' }), null);
});

const COV_SRC = [
  "'use strict';",
  "const LABEL = 'x';",
  'function used(a) {',
  '  if (a > 100) {',
  '    return -1;',
  '  }',
  '  return a + 1;',
  '}',
  'function unused(p) {',
  '  return p * 2;',
  '}',
  'module.exports = { used, unused, LABEL };',
  ''
].join('\n');

function covRepo(t) {
  const dir = tmp(t, 'refactor-v8cov-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'm.js'), COV_SRC);
  fs.writeFileSync(path.join(dir, 'check.js'), "require('assert').strictEqual(require('./src/m').used(1), 2);\n");
  return { dir, command: { cmd: process.execPath, args: ['check.js'], framework: 'npm' } };
}

function spanOf(needle) {
  const start = COV_SRC.indexOf(needle);
  assert(start >= 0, needle);
  return { file: 'src/m.js', start, end: start + needle.length };
}

for (const [name, needle, exercised] of [
  ['called function body', '  return a + 1;', true],
  ['top-level constant', "'x'", true],
  ['never-called function', '  return p * 2;', false],
  ['never-taken branch', '    return -1;', false],
  ['header of a never-called function', 'function unused(p)', false]
]) {
  test(`V8 coverage: an edit in a ${name} is ${exercised ? '' : 'not '}exercised`, async (t) => {
    const { dir, command } = covRepo(t);
    const r = await runTests({ repoRoot: dir, command, edit: spanOf(needle) });
    assert.strictEqual(r.status, 'passed', r.stderr);
    assert.strictEqual(r.coverage.tool, 'v8');
    assert.strictEqual(r.coverage.exercised, exercised, JSON.stringify(r.coverage));
    if (!exercised) assert.strictEqual(r.coverage.reason, 'edit_not_exercised');
  });
}

test('V8 coverage: a pure deletion is judged at the deletion point', async (t) => {
  const { dir, command } = covRepo(t);
  const at = COV_SRC.indexOf('  return p * 2;');
  const r = await runTests({ repoRoot: dir, command, edit: { file: 'src/m.js', start: at, end: at } });
  assert.strictEqual(r.coverage.exercised, false);
  const at2 = COV_SRC.indexOf('  return a + 1;');
  const r2 = await runTests({ repoRoot: dir, command, edit: { file: 'src/m.js', start: at2, end: at2 } });
  assert.strictEqual(r2.coverage.exercised, true);
});

test('V8 coverage: a file the tests never load is not exercised; coverage goes to a removed temp dir', async (t) => {
  const { dir } = covRepo(t);
  // A private TMPDIR: other runs in the shared tmpdir create such dirs too (AUDIT-30 H4).
  const seen = path.join(tmp(t, 'refactor-seen-'), 'cov');
  const own = tmp(t, 'refactor-tmp-');
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = own;
  t.after(() => { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; });
  const record = `require('fs').writeFileSync(${JSON.stringify(seen)}, process.env.NODE_V8_COVERAGE)`;
  const r = await runTests({ repoRoot: dir, command: { cmd: process.execPath, args: ['-e', record], framework: 'npm' }, edit: spanOf('  return a + 1;') });
  assert.strictEqual(r.coverage.exercised, false);
  assert.match(r.coverage.detail, /never loaded/);
  const cov = fs.readFileSync(seen, 'utf8');
  assert.strictEqual(path.dirname(cov), own);
  assert.match(path.basename(cov), /^refactor-cov-/);
  assert.deepStrictEqual(fs.readdirSync(own), [], 'coverage and bytecode dirs removed');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['check.js', 'src'], 'nothing written into the repo');
});

test('Python edit without coverage.py: no_coverage_tool', { skip: process.platform === 'win32' }, async (t) => {
  const repo = copyFixture('py-basic');
  const bin = tmp(t, 'refactor-bin-');
  fs.writeFileSync(path.join(bin, 'pytest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = prev; rm(repo); });
  const r = await runTests({ repoRoot: repo, edit: { file: 'calc/ops.py', start: 0, end: 10 } });
  assert.strictEqual(r.status, 'passed');
  assert.deepStrictEqual(r.coverage, { available: false, reason: 'no_coverage_tool' });
});

const hasPyCoverage = hasPytest && coverageTool('a.py', { cmd: 'pytest' }) === 'coverage.py';

test('coverage.py: a tested body line is exercised, an untested function is not', { skip: hasPyCoverage ? false : 'coverage.py/pytest not installed' }, async (t) => {
  const repo = copyFixture('py-basic');
  t.after(() => rm(repo));
  const src = 'def total(values):\n    return sum(values)\n\n\ndef unused(x):\n    return x * 3\n';
  fs.writeFileSync(path.join(repo, 'calc', 'ops.py'), src);
  const span = (needle) => ({ file: 'calc/ops.py', start: src.indexOf(needle), end: src.indexOf(needle) + needle.length });
  const hit = await runTests({ repoRoot: repo, edit: span('    return sum(values)') });
  assert.strictEqual(hit.status, 'passed', hit.stdout + hit.stderr);
  assert.strictEqual(hit.coverage.tool, 'coverage.py');
  assert.strictEqual(hit.coverage.exercised, true, JSON.stringify(hit.coverage));
  const miss = await runTests({ repoRoot: repo, edit: span('def unused(x):\n    return x * 3') });
  assert.strictEqual(miss.coverage.exercised, false, JSON.stringify(miss.coverage));
  assert.strictEqual(miss.coverage.reason, 'edit_not_exercised');
});

// ---------- SG14: comments are no evidence; every changed function must run ----------

const DOC_SRC = [
  "'use strict';",
  '/** Adds one. */',
  'function used(a) {',
  '  return a + 1;',
  '}',
  '/** Doubles. */',
  'function unused(p) {',
  '  return p * 2;',
  '}',
  'module.exports = { used, unused };',
  ''
].join('\n');

function docRepo(t) {
  const dir = tmp(t, 'refactor-v8doc-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'm.js'), DOC_SRC);
  fs.writeFileSync(path.join(dir, 'check.js'), "require('assert').strictEqual(require('./src/m').used(1), 2);\n");
  return { dir, command: { cmd: process.execPath, args: ['check.js'], framework: 'npm' } };
}
const docSpan = (from, to) => ({ file: 'src/m.js', start: DOC_SRC.indexOf(from), end: DOC_SRC.indexOf(to) + to.length });

test('V8 coverage: a doc comment in the changed span is no evidence for an uncalled function', async (t) => {
  const { dir, command } = docRepo(t);
  const r = await runTests({ repoRoot: dir, command, edit: docSpan('/** Doubles. */', '  return p * 2;') });
  assert.strictEqual(r.status, 'passed', r.stderr);
  assert.strictEqual(r.coverage.exercised, false, JSON.stringify(r.coverage));
  assert.strictEqual(r.coverage.reason, 'edit_not_exercised');
});

test('V8 coverage: a comment-only change is not exercised', async (t) => {
  const { dir, command } = docRepo(t);
  const r = await runTests({ repoRoot: dir, command, edit: docSpan('/** Adds one. */', '/** Adds one. */') });
  assert.strictEqual(r.coverage.exercised, false, JSON.stringify(r.coverage));
  assert.match(r.coverage.detail, /only comments or whitespace/);
});

test('V8 coverage: every changed function must run, not just one of them', async (t) => {
  const { dir, command } = docRepo(t);
  const r = await runTests({ repoRoot: dir, command, edit: docSpan('  return a + 1;', '  return p * 2;') });
  assert.strictEqual(r.coverage.exercised, false, JSON.stringify(r.coverage));
  assert.strictEqual(r.coverage.functions_missed, 1);
  assert.match(r.coverage.detail, /1 of \d+ function\(s\) never executed \(line 7\)/);
  const ok = await runTests({ repoRoot: dir, command, edit: docSpan('/** Adds one. */', '  return a + 1;') });
  assert.strictEqual(ok.coverage.exercised, true, JSON.stringify(ok.coverage));
});

test('coverage.py: a span over a tested and an untested function is not exercised', { skip: hasPyCoverage ? false : 'coverage.py/pytest not installed' }, async (t) => {
  const repo = copyFixture('py-basic');
  t.after(() => rm(repo));
  const src = 'def total(values):\n    """Sum."""\n    return sum(values)\n\n\ndef unused(x):\n    # triple\n    return x * 3\n';
  fs.writeFileSync(path.join(repo, 'calc', 'ops.py'), src);
  const span = (from, to) => ({ file: 'calc/ops.py', start: src.indexOf(from), end: src.indexOf(to) + to.length });
  const both = await runTests({ repoRoot: repo, edit: span('    return sum(values)', '    return x * 3') });
  assert.strictEqual(both.status, 'passed', both.stdout + both.stderr);
  assert.strictEqual(both.coverage.exercised, false, JSON.stringify(both.coverage));
  assert.strictEqual(both.coverage.functions_missed, 1);
  const docOnly = await runTests({ repoRoot: repo, edit: span('    """Sum."""', '    return sum(values)') });
  assert.strictEqual(docOnly.coverage.exercised, true, JSON.stringify(docOnly.coverage));
  assert.strictEqual(docOnly.coverage.edited_lines, 1, 'the docstring is not a statement');
});

test('pytest never runs a stale .pyc: a same-size, same-mtime rewrite is what gets tested', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  const dir = tmp(t, 'refactor-pyc-test-');
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(dir, 'mod.py'), 'def f():\n    return 1\n');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'test_mod.py'),
    'import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))\nfrom mod import f\n\n\ndef test_f():\n    assert f() == 1\n');
  const command = { cmd: 'pytest', args: ['-q', '-p', 'no:cacheprovider'], framework: 'pytest' };
  const stat = fs.statSync(path.join(dir, 'mod.py'));
  const first = await runTests({ repoRoot: dir, command });
  assert.strictEqual(first.status, 'passed', first.stdout + first.stderr);
  // A plain interpreter run caches the original bytecode next to the source.
  spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, "."); import mod'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'mod.py'), 'def f():\n    return 2\n');
  fs.utimesSync(path.join(dir, 'mod.py'), stat.atime, stat.mtime);
  const second = await runTests({ repoRoot: dir, command });
  assert.strictEqual(second.status, 'failed', 'the rewritten source is tested, not the cached bytecode');
});

// ---------- SG16: coverage post-processing is linear, bounded and shares the test budget ----------

// ~199 KB of small functions; the edit rewrites the bodies in its last `spanBytes`.
function bigModule(spanBytes) {
  let src = "'use strict';\n";
  for (let j = 0; src.length + 200 < 199_000; j++) src += `function f${j}(a, b) {\n  const t${j} = a * ${j} + b;\n  return t${j};\n}\n`;
  src += 'module.exports = { f0 };\n';
  const cut = src.length - spanBytes;
  const after = src.slice(0, cut) + src.slice(cut).replace(/return t(\d+);/g, 'return t$1 + 0;');
  return { before: src, after };
}

// Post-exit time (total - suite) and the longest event-loop stall during runTests.
async function timedRun(opts) {
  let last = Date.now(), stall = 0;
  const ticker = setInterval(() => { const now = Date.now(); stall = Math.max(stall, now - last); last = now; }, 10);
  const t0 = Date.now();
  try {
    const r = await runTests(opts);
    return { r, post: Date.now() - t0 - r.execution_time_ms, stall: Math.max(stall, Date.now() - last) };
  } finally { clearInterval(ticker); }
}

function bigRepo(t, spanBytes, suite) {
  const dir = tmp(t, 'refactor-v8big-');
  const m = bigModule(spanBytes);
  fs.writeFileSync(path.join(dir, 'mod.js'), m.after);
  fs.writeFileSync(path.join(dir, 'check.js'), suite);
  return { dir, command: { cmd: process.execPath, args: ['check.js'], framework: 'npm' }, edit: { file: 'mod.js', ...changedSpan(m.before, m.after) } };
}

test('V8 coverage: a 60 KB edit span on a 199 KB file is evaluated quickly, without stalling the event loop', async (t) => {
  const { dir, command, edit } = bigRepo(t, 60_000, "require('./mod.js');\n");
  const { r, post, stall } = await timedRun({ repoRoot: dir, command, edit });
  assert.strictEqual(r.status, 'passed', r.stderr);
  assert.strictEqual(r.coverage.exercised, false);
  assert.strictEqual(r.coverage.reason, 'edit_not_exercised');
  assert(post < 3000, `post-exit coverage work took ${post} ms`);
  assert(stall < 1500, `event loop stalled ${stall} ms`);
  // The same sweep still sees an executed function body.
  fs.writeFileSync(path.join(dir, 'call.js'), "require('./mod.js').f0(1, 2);\n");
  const body = '  const t0 = a * 0 + b;\n  return t0;';
  const at = fs.readFileSync(path.join(dir, 'mod.js'), 'utf8').indexOf(body);
  const hit = await runTests({ repoRoot: dir, command: { ...command, args: ['call.js'] }, edit: { file: 'mod.js', start: at, end: at + body.length } });
  assert.strictEqual(hit.coverage.exercised, true, JSON.stringify(hit.coverage));
  assert.strictEqual(hit.coverage.edited_lines, 2);
  assert.strictEqual(hit.coverage.executed_lines, 2);
});

test('V8 coverage: many test processes loading the edited file cost seconds at most', async (t) => {
  const suite = "const { spawnSync } = require('child_process');\nfor (let i = 0; i < 20; i++) spawnSync(process.execPath, ['-e', \"require('./mod.js')\"], { cwd: __dirname, stdio: 'ignore' });\n";
  const { dir, command, edit } = bigRepo(t, 20_000, suite);
  const { r, post, stall } = await timedRun({ repoRoot: dir, command, edit });
  assert.strictEqual(r.status, 'passed', r.stderr);
  assert.strictEqual(r.coverage.exercised, false);
  assert(post < 3000, `post-exit coverage work took ${post} ms`);
  assert(stall < 1500, `event loop stalled ${stall} ms`);
});

test('V8 coverage that overruns the test budget: coverage_timeout, not edit_not_exercised', async (t) => {
  const dir = tmp(t, 'refactor-v8slow-');
  // Evaluating a multi-MB edited file outlasts a 300 ms budget that the
  // suite itself (`true`) is far inside.
  let src = "'use strict';\n";
  for (let j = 0; src.length < 4e6; j++) src += `function f${j}(a, b) {\n  const t = a * ${j} + b;\n  return t;\n}\n`;
  fs.writeFileSync(path.join(dir, 'big.js'), src);
  const r = await runTests({ repoRoot: dir, command: { cmd: 'true', args: [], framework: 'make' }, timeoutMs: 300, edit: { file: 'big.js', start: 20, end: 40 } });
  assert.strictEqual(r.status, 'passed');
  assert.strictEqual(r.coverage.exercised, false);
  assert.strictEqual(r.coverage.reason, 'coverage_timeout', JSON.stringify(r.coverage));
  assert(r.coverage.duration_ms >= 0);
});

test('a run without an edit collects no coverage, even with NODE_V8_COVERAGE inherited', async (t) => {
  const covDir = tmp(t, 'refactor-inherited-cov-');
  const prev = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = covDir;
  t.after(() => { if (prev === undefined) delete process.env.NODE_V8_COVERAGE; else process.env.NODE_V8_COVERAGE = prev; });
  const r = await runTests({ repoRoot: covDir, command: { cmd: process.execPath, args: ['-e', '0'], framework: 'npm' } });
  assert.strictEqual(r.status, 'passed');
  assert.deepStrictEqual(fs.readdirSync(covDir), []);
});

test('coverage.py reports only the edited file: megabytes of other imported modules add little post-exit time', { skip: hasPyCoverage ? false : 'coverage.py/pytest not installed' }, async (t) => {
  const dir = tmp(t, 'refactor-pybig-');
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
  fs.mkdirSync(path.join(dir, 'tests'));
  let suite = 'import importlib\n\n\ndef test_all():\n';
  for (let i = 0; i < 13; i++) {
    let body = '';
    for (let j = 0; body.length < 197_000; j++) body += `def f${i}_${j}(a, b):\n    t = a * ${j} + b\n    return t\n\n\n`;
    fs.writeFileSync(path.join(dir, 'pkg', `m${i}.py`), body);
    suite += `    assert importlib.import_module('pkg.m${i}').f${i}_0(1, 2) == 2\n`;
  }
  fs.writeFileSync(path.join(dir, 'tests', 'test_all.py'), suite);
  const src = fs.readFileSync(path.join(dir, 'pkg', 'm0.py'), 'utf8');
  const needle = '    t = a * 0 + b\n    return t';
  const { r, post } = await timedRun({ repoRoot: dir, edit: { file: 'pkg/m0.py', start: src.indexOf(needle), end: src.indexOf(needle) + needle.length } });
  assert.strictEqual(r.status, 'passed', r.stdout + r.stderr);
  assert.strictEqual(r.coverage.exercised, true, JSON.stringify(r.coverage));
  assert(post < 4000, `post-exit coverage work took ${post} ms`);
  // An edited file the tests never import has an empty report: not exercised, no error.
  fs.writeFileSync(path.join(dir, 'pkg', 'orphan.py'), 'def lone(x):\n    return x\n');
  const orphan = await runTests({ repoRoot: dir, edit: { file: 'pkg/orphan.py', start: 16, end: 24 } });
  assert.strictEqual(orphan.coverage.exercised, false);
  assert.strictEqual(orphan.coverage.reason, 'edit_not_exercised');
  assert.match(orphan.coverage.detail, /never imported/);
});

// ---------- SG25: one invocation for every run ----------

test('pytest runs as `python -m pytest` with or without coverage: a package the tests import resolves in both (AUDIT-13 C2)', { skip: hasPyCoverage ? false : 'coverage.py/pytest not installed' }, async (t) => {
  const dir = tmp(t, 'refactor-pyimp-');
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'app/m.py'), 'def f(x):\n    return x + 1\n');
  fs.writeFileSync(path.join(dir, 'tests/test_m.py'), 'import app.m as m\n\n\ndef test_f():\n    assert m.f(1) == 2\n');
  const edited = await runTests({ repoRoot: dir, edit: { file: 'app/m.py', start: 15, end: 27 } });
  const plain = await runTests({ repoRoot: dir });
  assert.strictEqual(edited.status, 'passed', edited.stdout + edited.stderr);
  assert.strictEqual(plain.status, 'passed', plain.stdout + plain.stderr);
  assert.match(plain.command, / -m pytest -q$/);
  assert.strictEqual(edited.command.replace(' -m coverage run', ''), plain.command, 'same interpreter and arguments, minus coverage');
  assert.strictEqual(plain.collection_error, undefined);
  // An import that breaks at collection is flagged: no test judged the code.
  fs.writeFileSync(path.join(dir, 'app/m.py'), 'raise ImportError("broken")\n');
  const broken = await runTests({ repoRoot: dir });
  assert.strictEqual(broken.status, 'failed');
  assert.strictEqual(broken.collection_error, true);
  fs.writeFileSync(path.join(dir, 'app/m.py'), 'def f(x):\n    return x + 2\n');
  const red = await runTests({ repoRoot: dir });
  assert.strictEqual(red.status, 'failed');
  assert.strictEqual(red.collection_error, undefined, 'a failing test is a real failure');
});

// ---------- SG26: per-test results, load failures ----------

test('tapResults / junitResults: per-test states; a crashed test file or a failure raised from a module body is a load failure', () => {
  const { tapResults, junitResults } = require('../src/runner/test-runner');
  const tap = [
    'TAP version 13', '# Subtest: a', 'ok 1 - a', '  ---', "  type: 'test'", '  ...', '# Subtest: s', '    # Subtest: x', '    not ok 1 - x', '      ---',
    "      type: 'test'", "      failureType: 'testCodeFailure'", '      ...', '    # Subtest: y', '    ok 2 - y # SKIP', '      ---', "      type: 'test'", '      ...',
    'not ok 2 - s', '  ---', "  type: 'suite'", "  failureType: 'subtestsFailed'", '  ...', '# Subtest: c', 'not ok 3 - c', '  ---', "  type: 'test'",
    "  failureType: 'cancelledByParent'", '  ...', '1..3'
  ].join('\n');
  assert.deepStrictEqual(tapResults(tap), { tests: { a: 'pass', 's > x': 'fail', 's > y': 'skip', c: 'error' }, load: false, suites: { s: 'fail' } });
  const lazy = tap.replace("      failureType: 'testCodeFailure'", "      failureType: 'testCodeFailure'\n      stack: |-\n        Object.<anonymous> (/r/src/a.js:1:41)\n        Module._compile (node:internal/modules/cjs/loader:1706:14)");
  assert.strictEqual(tapResults(lazy).load, true);
  const crashed = tap.replace("  failureType: 'cancelledByParent'", "  failureType: 'testCodeFailure'\n  exitCode: 1");
  assert.strictEqual(tapResults(crashed).load, true);
  assert.strictEqual(tapResults('no tap here'), null);
  const xml = (body) => `<testsuites><testsuite><testcase classname="t.m" name="ok" /><testcase classname="t.m" name="bad">${body}</testcase></testsuite></testsuites>`;
  assert.deepStrictEqual(junitResults(xml('<failure message="assert 1 == 2">t/m.py:5: in test_bad\n    assert 1 == 2</failure>')), { tests: { 't.m::ok': 'pass', 't.m::bad': 'fail' }, load: false });
  assert.strictEqual(junitResults(xml('<failure message="IndexError">t/m.py:2: in test_bad\napp/m.py:2: in &lt;module&gt;\n    X = S[2]</failure>')).load, true);
  assert.strictEqual(junitResults(xml('<error message="collection failure">t/m.py:1: in &lt;module&gt;</error>')).load, true);
  assert.deepStrictEqual(junitResults(xml('<skipped message="x" />')).tests, { 't.m::ok': 'pass', 't.m::bad': 'skip' });
});

test('tapResults / junitResults: a fixture error is no test failure; duplicate ids are kept apart (AUDIT-19 M2, M3)', () => {
  const { tapResults, junitResults } = require('../src/runner/test-runner');
  const xml = (...cases) => `<testsuites><testsuite>${cases.join('')}</testsuite></testsuites>`;
  const tc = (name, body = '') => `<testcase classname="t.m" name="${name}">${body}</testcase>`;
  const setup = '<error message="failed on setup with &quot;fixture \'db\' not found&quot;">file t/m.py, line 4\n  def test_bad(db):\nE       fixture \'db\' not found</error>';
  assert.deepStrictEqual(junitResults(xml(tc('ok'), tc('bad', setup))), { tests: { 't.m::ok': 'pass', 't.m::bad': 'error' }, load: false });
  const fail = '<failure message="assert 1 == 2">t/m.py:5: in test_x\n    assert 1 == 2</failure>';
  assert.deepStrictEqual(junitResults(xml(tc('x'), tc('x', fail))).tests, { 't.m::x': 'pass', 't.m::x\t#2': 'fail' });
  assert.deepStrictEqual(junitResults(xml(tc('x', fail), tc('x'), tc('x'))).tests, { 't.m::x': 'fail', 't.m::x\t#2': 'pass', 't.m::x\t#3': 'pass' });
  const entry = (n, ok) => [`# Subtest: a`, `${ok ? '' : 'not '}ok ${n} - a`, '  ---', "  type: 'test'", ...(ok ? [] : ["  failureType: 'testCodeFailure'"]), '  ...'];
  const tap = ['TAP version 13', ...entry(1, true), ...entry(2, false), ...entry(3, true), '1..3'].join('\n');
  assert.deepStrictEqual(tapResults(tap), { tests: { a: 'pass', 'a\t#2': 'fail', 'a\t#3': 'pass' }, load: false });
});

test('runTests: node:test per-test results; a module that throws while loading, in a test or at a test file\'s top, is a collection error (AUDIT-16 C2)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; });
  const dir = tmp(t, 'refactor-sg26-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  const good = "'use strict';\nconst P = [{ max: 3 }, { max: 4 }];\nconst MAX = P[1].max;\nmodule.exports = { f: (s) => s.slice(0, MAX) };\n";
  fs.writeFileSync(path.join(dir, 'src/a.js'), good);
  const nodeTest = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), nodeTest("test('one', () => assert.strictEqual(1, 1));\ntest('lazy', () => { assert.strictEqual(require('../src/a').f('abc'), 'abc'); });"));
  const ok = await runTests({ repoRoot: dir });
  assert.strictEqual(ok.status, 'passed', ok.stdout + ok.stderr);
  assert.deepStrictEqual(ok.tests, { one: 'pass', lazy: 'pass' });
  fs.writeFileSync(path.join(dir, 'src/a.js'), good.replace('P[1]', 'P[2]'));
  const lazy = await runTests({ repoRoot: dir });
  assert.strictEqual(lazy.status, 'failed');
  assert.strictEqual(lazy.collection_error, true, JSON.stringify(lazy.tests));
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), nodeTest("const m = require('../src/a');\ntest('top', () => assert.strictEqual(m.f('abc'), 'abc'));"));
  const top = await runTests({ repoRoot: dir });
  assert.strictEqual(top.collection_error, true, JSON.stringify(top.tests));
  fs.writeFileSync(path.join(dir, 'src/a.js'), good.replace('s.slice(0, MAX)', 's.slice(1, MAX)'));
  const red = await runTests({ repoRoot: dir });
  assert.strictEqual(red.status, 'failed');
  assert.strictEqual(red.collection_error, undefined, 'a failing assertion is a real failure');
  assert.deepStrictEqual(red.tests, { top: 'fail' });
});

test('runTests: pytest per-test results; an import failure is a collection error with --continue-on-collection-errors or inside a test (AUDIT-16 C2)', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  const dir = tmp(t, 'refactor-sg26py-');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
  const top = 'import app.m as m\n\n\ndef test_top():\n    assert m.MAX == 4\n';
  const lazy = 'def test_lazy():\n    import app.m as m\n    assert m.MAX == 4\n';
  for (const [ini, body] of [['[pytest]\naddopts = --continue-on-collection-errors\n', top], ['[pytest]\n', lazy]]) {
    fs.writeFileSync(path.join(dir, 'pytest.ini'), ini);
    fs.writeFileSync(path.join(dir, 'tests/test_m.py'), body);
    fs.writeFileSync(path.join(dir, 'app/m.py'), 'SIZES = (1, 4)\nMAX = SIZES[1]\n');
    const ok = await runTests({ repoRoot: dir });
    assert.strictEqual(ok.status, 'passed', ok.stdout + ok.stderr);
    assert.deepStrictEqual(Object.values(ok.tests), ['pass']);
    fs.writeFileSync(path.join(dir, 'app/m.py'), 'SIZES = (1, 4)\nMAX = SIZES[2]\n');
    const broken = await runTests({ repoRoot: dir });
    assert.strictEqual(broken.status, 'failed');
    assert.strictEqual(broken.exit_code, 1);
    assert.strictEqual(broken.collection_error, true, broken.stdout);
    fs.writeFileSync(path.join(dir, 'app/m.py'), 'SIZES = (1, 4)\nMAX = SIZES[0]\n');
    const red = await runTests({ repoRoot: dir });
    assert.strictEqual(red.collection_error, undefined, red.stdout);
    assert.deepStrictEqual(Object.values(red.tests), ['fail']);
  }
});

test('runTests: a delegated script with its own --test-reporter runs green without per-test results, here and in later runs (AUDIT-18 H1)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; });
  const dir = tmp(t, 'refactor-sg28-');
  const scripts = { test: 'npm run unit --silent', unit: 'node --test --test-reporter=dot test/a.test.js' };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts }));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), "'use strict';\nconst test = require('node:test');\ntest('one', () => {});\n");
  for (let i = 0; i < 2; i++) {
    const r = await runTests({ repoRoot: dir });
    assert.strictEqual(r.status, 'passed', r.stdout + r.stderr);
    assert.strictEqual(r.tests, undefined);
  }
});

// ---------- SG30: load failures however deep or however reported ----------

test('runTests: a module body that throws deep in its stack or under a test that wraps the require is a collection error; a test fixture throwing is not (AUDIT-20 M5)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; });
  const dir = tmp(t, 'refactor-sg30-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test test/a.test.js' } }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test/fixtures'), { recursive: true });
  const nodeTest = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
  const deep = "'use strict';\nfunction nest(n, f) { return n ? nest(n - 1, f) : f(); }\nconst CFG = nest(12, () => JSON.parse('{\"max\": 4'));\nmodule.exports = { f: (s) => s.slice(0, CFG.max) };\n";
  fs.writeFileSync(path.join(dir, 'src/a.js'), deep);
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), nodeTest("test('lazy', () => { assert.strictEqual(require('../src/a').f('abc'), 'abc'); });"));
  assert.strictEqual((await runTests({ repoRoot: dir })).collection_error, true, '12 calls deep');
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), nodeTest("test('wrapped', () => { let m; try { m = require('../src/a'); } catch (e) { assert.fail(`cannot load: ${e.message}`); } assert.strictEqual(m.f('abc'), 'abc'); });"));
  assert.strictEqual((await runTests({ repoRoot: dir })).collection_error, true, 'require wrapped by the test');
  fs.writeFileSync(path.join(dir, 'src/a.js'), "'use strict';\nmodule.exports = { f: (s) => s.slice(1) };\n");
  fs.writeFileSync(path.join(dir, 'test/fixtures/bad.js'), "throw new Error('bad fixture');\n");
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), nodeTest("test('fixture', () => assert.throws(() => require('./fixtures/bad')));\ntest('f', () => assert.strictEqual(require('../src/a').f('abc'), 'abc'));"));
  const red = await runTests({ repoRoot: dir });
  assert.strictEqual(red.status, 'failed');
  assert.strictEqual(red.collection_error, undefined, 'a test fixture that throws is no load failure of the code');
  assert.deepStrictEqual(red.tests, { fixture: 'pass', f: 'fail' });
});

test('runTests: pytest: an import inside a test that reports pytest.fail(pytrace=False) is a collection error; a missing optional module is not (AUDIT-20 M5)', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  const dir = tmp(t, 'refactor-sg30py-');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'app/m.py'), 'import json\nCFG = json.loads(\'{"max": 4\')\n\n\ndef f(s):\n    return s[:CFG["max"]]\n');
  fs.writeFileSync(path.join(dir, 'tests/test_m.py'), 'import pytest\n\n\ndef test_f():\n    try:\n        import app.m as m\n    except Exception as e:\n        pytest.fail(f"cannot load: {e}", pytrace=False)\n    assert m.f("abc") == "abc"\n');
  const broken = await runTests({ repoRoot: dir });
  assert.strictEqual(broken.status, 'failed');
  assert.strictEqual(broken.collection_error, true, broken.stdout);
  fs.writeFileSync(path.join(dir, 'app/m.py'), 'try:\n    import no_such_module_sg30\nexcept ImportError:\n    pass\n\n\ndef f(s):\n    return s[1:]\n');
  const red = await runTests({ repoRoot: dir });
  assert.strictEqual(red.status, 'failed');
  assert.strictEqual(red.collection_error, undefined, red.stdout);
});

// ---------- SG33: a load failure a test catches on purpose ----------

test('runTests: a module body throw that a passing test expects (in a test or at a test file\'s top) is no collection error; a failing assertion elsewhere is a real failure (AUDIT-24 H1)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; });
  const dir = tmp(t, 'refactor-sg33-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  const nodeTest = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
  fs.writeFileSync(path.join(dir, 'src/config.js'), "'use strict';\nif (!process.env.SG33_KEY) throw new Error('SG33_KEY required');\nmodule.exports = {};\n");
  fs.writeFileSync(path.join(dir, 'src/a.js'), "'use strict';\nmodule.exports = { f: (s) => s.slice(1) };\n");
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), nodeTest("test('f', () => assert.strictEqual(require('../src/a').f('abc'), 'abc'));"));
  for (const body of ["test('config', () => assert.throws(() => require('../src/config'), /SG33_KEY/));", "assert.throws(() => require('../src/config'));\ntest('config', () => {});"]) {
    fs.writeFileSync(path.join(dir, 'test/config.test.js'), nodeTest(body));
    const red = await runTests({ repoRoot: dir });
    assert.strictEqual(red.status, 'failed');
    assert.strictEqual(red.collection_error, undefined, body);
    assert.deepStrictEqual(red.tests, { f: 'fail', config: 'pass' });
  }
});

test('runTests: a caught load throw in a passing node:test test is no collection error in the failing test\'s own file or process; a failing test, hook or top level is (AUDIT-28 H1)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; });
  const dir = tmp(t, 'refactor-sg38-');
  const pkg = (test) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test } }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  const head = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { describe, it, before } = test;\n";
  const caught = "assert.throws(() => require('../src/config'), /SG38_KEY/);";
  const red = "test('f', () => assert.strictEqual(1, 2));\n";
  fs.writeFileSync(path.join(dir, 'src/config.js'), "'use strict';\nif (!process.env.SG38_KEY) throw new Error('SG38_KEY required');\n");
  const run = async (body, cmd = 'node --test') => {
    pkg(cmd);
    fs.writeFileSync(path.join(dir, 'test/a.test.js'), head + body);
    const r = await runTests({ repoRoot: dir });
    assert.strictEqual(r.status, 'failed', r.stdout);
    return r;
  };
  for (const [body, tests] of [
    [`test('config', () => { ${caught} });\n${red}`, { config: 'pass', f: 'fail' }],
    [`describe('s', () => { it('config', () => { ${caught} }); });\n${red}`, { 's > config': 'pass', f: 'fail' }],
    [`test('p', async (t) => { await t.test('c', () => { ${caught} }); });\n${red}`, { 'p > c': 'pass', p: 'pass', f: 'fail' }],
    [`test('cb', (t, done) => { ${caught} setImmediate(done); });\ntest(function named() { ${caught} });\n${red}`, { cb: 'pass', named: 'pass', f: 'fail' }]
  ]) {
    for (const cmd of ['node --test', 'node --test --experimental-test-isolation=none']) {
      const r = await run(body, cmd);
      assert.strictEqual(r.collection_error, undefined, `${cmd}: ${body}`);
      assert.deepStrictEqual(r.tests, tests);
    }
  }
  const uncaught = await run("test('config', () => { require('../src/config'); });\ntest('g', () => {});\n");
  assert.strictEqual(uncaught.collection_error, true, 'the test that hit the throw failed');
  // A rethrown throw (no load frame in the TAP stack) is excused only when every
  // test of the logged name passed, and never by a test whose name it prefixes (AUDIT-30 H3, M1).
  const rethrow = "try { require('../src/config'); } catch (e) { throw new Error('setup: ' + e.message); }";
  for (const body of [`describe('s', () => { before(() => { ${caught} }); it('f', () => assert.strictEqual(1, 2)); });\n`, `${caught}\n${red}`,
    `test('x', () => { ${caught} });\ntest('x', () => { ${rethrow} });\n`,
    `test('set', () => {});\ndescribe('s', () => { ${rethrow} it('a', () => {}); });\n${red}`]) {
    assert.strictEqual((await run(body)).collection_error, true, body);
  }
});

test('runTests: a caught load throw in a passing describe() callback or a test named with `#`, `\\` or a newline is no collection error; ids carry the names (AUDIT-32 H1, H2)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; });
  const dir = tmp(t, 'refactor-sg41-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'src/config.js'), "'use strict';\nif (!process.env.SG41_KEY) throw new Error('SG41_KEY required');\n");
  const head = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { describe, it } = test;\n";
  const caught = "assert.throws(() => require('../src/config'), /SG41_KEY/);";
  const red = "test('f', () => assert.strictEqual(1, 2));\n";
  const run = async (body, cmd = 'node --test') => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: cmd } }));
    fs.writeFileSync(path.join(dir, 'test/a.test.js'), head + body);
    const r = await runTests({ repoRoot: dir });
    assert.strictEqual(r.status, 'failed', r.stdout);
    return r;
  };
  for (const [body, tests] of [
    [`describe('s', () => { ${caught} it('a', () => {}); });\n${red}`, { 's > a': 'pass', f: 'fail' }],
    [`test('issue #12', () => { ${caught} });\n${red}`, { 'issue #12': 'pass', f: 'fail' }],
    [`describe('s #1', () => { it('x \\\\ y', () => { ${caught} }); });\n${red}`, { 's #1 > x \\ y': 'pass', f: 'fail' }],
    [`test('a\\nb', () => { ${caught} });\n${red}`, { 'a\\nb': 'pass', f: 'fail' }]
  ]) {
    for (const cmd of ['node --test', 'node --test --experimental-test-isolation=none']) {
      const r = await run(body, cmd);
      assert.strictEqual(r.collection_error, undefined, `${cmd}: ${body}`);
      assert.deepStrictEqual(r.tests, tests);
    }
  }
  assert.strictEqual((await run(`describe('s #1', () => { ${caught} it('a', () => assert.strictEqual(1, 2)); });\n`)).collection_error, true, 'the suite failed');
  assert.strictEqual((await run(`test('issue #12', () => { ${caught} assert.strictEqual(1, 2); });\ntest('g', () => {});\n`)).collection_error, true, 'the test failed');
});

test('runTests: a load throw in a child process the test spawns or in an ES module caught by import() is a collection error; one a passing test expects is not (AUDIT-35 C2)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; delete process.env.SG45_BAD; });
  const dir = tmp(t, 'refactor-sg45-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  for (const d of ['src', 'bin', 'test']) fs.mkdirSync(path.join(dir, d));
  const body = "if (process.env.SG45_BAD) throw new Error('bad');\n";
  fs.writeFileSync(path.join(dir, 'src/m.js'), `'use strict';\n${body}module.exports = { show: (s) => s };\n`);
  fs.writeFileSync(path.join(dir, 'src/m.mjs'), `${body}export const show = (s) => s;\n`);
  fs.writeFileSync(path.join(dir, 'bin/cli.js'), "'use strict';\nlet m;\ntry { m = require('../src/m'); } catch (e) { console.log('error: ' + e.message); process.exit(0); }\nconsole.log(m.show(process.argv[2]));\n");
  const head = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n";
  const run = async (file, text, bad) => {
    for (const f of fs.readdirSync(path.join(dir, 'test'))) fs.rmSync(path.join(dir, 'test', f));
    fs.writeFileSync(path.join(dir, 'test', file), text);
    if (bad) process.env.SG45_BAD = '1'; else delete process.env.SG45_BAD;
    return runTests({ repoRoot: dir });
  };
  const cli = head + "test('cli', () => {\n  const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, '../bin/cli.js'), 'ab'], { encoding: 'utf8' });\n  assert.strictEqual(r.stdout, 'ab\\n');\n});\n";
  const esm = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('show', async () => {\n  let m = null;\n  try { m = await import('../src/m.mjs'); } catch { m = null; }\n  assert.ok(m);\n});\n";
  for (const [file, text] of [['cli.test.js', cli], ['esm.test.mjs', esm]]) {
    assert.strictEqual((await run(file, text, false)).status, 'passed', file);
    const r = await run(file, text, true);
    assert.strictEqual(r.status, 'failed', r.stdout);
    assert.strictEqual(r.collection_error, true, file);
  }
  // An ES module throw a passing (CJS) test expects is caught by that test's name.
  const expected = await run('e.test.js', head + "test('esm', async () => { await assert.rejects(import('../src/m.mjs'), /bad/); });\ntest('f', () => assert.strictEqual(1, 2));\n", true);
  assert.deepStrictEqual(expected.tests, { esm: 'pass', f: 'fail' });
  assert.strictEqual(expected.collection_error, undefined);
});

test('runTests: an ES module CLI child, or a child spawned without NODE_TEST_CONTEXT, that catches a load throw and exits 0 is a collection error (AUDIT-38 H4)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; delete process.env.SG45_BAD; });
  const dir = tmp(t, 'refactor-sg47-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  for (const d of ['src', 'bin', 'test']) fs.mkdirSync(path.join(dir, d));
  const body = "if (process.env.SG45_BAD) throw new Error('bad');\n";
  fs.writeFileSync(path.join(dir, 'src/m.js'), `'use strict';\n${body}module.exports = { show: (s) => s };\n`);
  fs.writeFileSync(path.join(dir, 'src/m.mjs'), `${body}export const show = (s) => s;\n`);
  const catchExit = "catch (e) { console.log('error: ' + e.message); process.exit(0); }\nconsole.log(m.show(process.argv[2]));\n";
  fs.writeFileSync(path.join(dir, 'bin/cli.js'), `'use strict';\nlet m;\ntry { m = require('../src/m.js'); } ${catchExit}`);
  fs.writeFileSync(path.join(dir, 'bin/cli.mjs'), `let m;\ntry { m = await import('../src/m.mjs'); } ${catchExit}`);
  const cli = (bin, env) => "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n" +
    `test('cli', () => {\n  const env = ${env};\n  const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, '../bin/${bin}'), 'ab'], { encoding: 'utf8', env });\n  assert.strictEqual(r.stdout, 'ab\\n');\n});\n`;
  const stripped = '{ ...process.env, NODE_TEST_CONTEXT: undefined }';
  for (const [bin, env] of [['cli.mjs', 'process.env'], ['cli.mjs', stripped], ['cli.js', stripped]]) {
    fs.writeFileSync(path.join(dir, 'test/cli.test.js'), cli(bin, env));
    delete process.env.SG45_BAD;
    assert.strictEqual((await runTests({ repoRoot: dir })).status, 'passed', `${bin} ${env}`);
    process.env.SG45_BAD = '1';
    const r = await runTests({ repoRoot: dir });
    assert.strictEqual(r.status, 'failed', r.stdout);
    assert.strictEqual(r.collection_error, true, `${bin} ${env}`);
  }
});

test('runTests: a CommonJS source caught in import(), a nested node --test a test spawns, and a node without module.registerHooks are collection errors (AUDIT-39 H4, H5, H6)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT, opts = process.env.NODE_OPTIONS;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev;
    if (opts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = opts;
    delete process.env.SG50_BAD;
  });
  const dir = tmp(t, 'refactor-sg50-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  for (const d of ['src', 'sub', 'test']) fs.mkdirSync(path.join(dir, d));
  const body = "if (process.env.SG50_BAD) throw new Error('bad');\n";
  fs.writeFileSync(path.join(dir, 'src/m.js'), `'use strict';\n${body}module.exports = { show: (s) => s };\n`);
  fs.writeFileSync(path.join(dir, 'src/m.mjs'), `${body}export const show = (s) => s;\n`);
  fs.writeFileSync(path.join(dir, 'old-node.js'), "delete require('module').registerHooks;\n");
  const cjs = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n";
  const esm = "import test from 'node:test';\nimport assert from 'node:assert';\n";
  const caught = (src) => `test('a', async () => { let m; try { m = await import('${src}'); } catch { m = null; } assert.ok(m); });\n`;
  fs.writeFileSync(path.join(dir, 'sub/inner.js'), `${cjs}test('inner', () => { let m; try { m = require('../src/m.js'); } catch { m = null; } console.log(m ? 'LOADED' : 'MISSING'); });\n`);
  const nested = `${cjs}test('a', () => {\n  const env = { ...process.env, NODE_TEST_CONTEXT: undefined };\n  const r = require('child_process').spawnSync(process.execPath, ['--test', require('path').join(__dirname, '../sub/inner.js')], { encoding: 'utf8', env });\n  assert.match(r.stdout, /LOADED/);\n});\n`;
  const cases = [
    ['esm.test.mjs', esm + caught('../src/m.js')],
    ['cjs.test.js', cjs + caught('../src/m.js')],
    ['nested.test.js', nested],
    ['old.test.mjs', esm + caught('../src/m.mjs'), `--require=${path.join(dir, 'old-node.js')}`]
  ];
  for (const [file, text, options] of cases) {
    for (const f of fs.readdirSync(path.join(dir, 'test'))) fs.rmSync(path.join(dir, 'test', f));
    fs.writeFileSync(path.join(dir, 'test', file), text);
    if (options) process.env.NODE_OPTIONS = options; else if (opts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = opts;
    delete process.env.SG50_BAD;
    assert.strictEqual((await runTests({ repoRoot: dir })).status, 'passed', file);
    process.env.SG50_BAD = '1';
    const r = await runTests({ repoRoot: dir });
    assert.strictEqual(r.status, 'failed', r.stdout);
    assert.strictEqual(r.collection_error, true, file);
  }
  // A CommonJS source that loads through import() and completes is no load failure.
  if (opts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = opts;
  delete process.env.SG50_BAD;
  for (const f of fs.readdirSync(path.join(dir, 'test'))) fs.rmSync(path.join(dir, 'test', f));
  fs.writeFileSync(path.join(dir, 'test/esm.test.mjs'), `${esm}test('show', async () => { const m = await import('../src/m.js'); assert.strictEqual(m.default.show('a'), 'b'); });\n`);
  const red = await runTests({ repoRoot: dir });
  assert.strictEqual(red.status, 'failed', red.stdout);
  assert.strictEqual(red.collection_error, undefined);
});

test('runTests: pytest: a module body that raises under importlib.import_module, reload or exec_module, in the test or a child, is a collection error (AUDIT-39 H3)', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  t.after(() => { delete process.env.SG50_BAD; });
  const dir = tmp(t, 'refactor-sg50py-');
  for (const d of ['app', 'tests']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'app/m.py'), "import os\nif os.environ.get('SG50_BAD'):\n    raise ValueError('bad')\n");
  const caught = (expr) => `    try:\n        m = ${expr}\n    except Exception:\n        m = None\n    assert m is not None\n`;
  const child = "import importlib\\ntry:\\n    importlib.import_module('app.m'); print('ok')\\nexcept Exception:\\n    print('err')";
  const bodies = [
    `import importlib\n\n\ndef test_a():\n${caught("importlib.import_module('app.m')")}`,
    `import importlib, os\n\n\ndef test_a():\n    saved = os.environ.pop('SG50_BAD', None)\n    import app.m\n    if saved is not None:\n        os.environ['SG50_BAD'] = saved\n${caught('importlib.reload(app.m)')}`,
    `import importlib.util, pathlib\n\n\ndef load():\n    spec = importlib.util.spec_from_file_location('mm', pathlib.Path(__file__).parent.parent / 'app' / 'm.py')\n    mod = importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(mod)\n    return mod\n\n\ndef test_a():\n${caught('load()')}`,
    `import subprocess, sys\n\n\ndef test_a():\n    r = subprocess.run([sys.executable, '-c', "${child}"], capture_output=True, text=True)\n    assert r.stdout.strip() == 'ok'\n`
  ];
  for (const body of bodies) {
    fs.writeFileSync(path.join(dir, 'tests/test_a.py'), body);
    delete process.env.SG50_BAD;
    assert.strictEqual((await runTests({ repoRoot: dir })).status, 'passed', body);
    process.env.SG50_BAD = '1';
    const r = await runTests({ repoRoot: dir });
    assert.strictEqual(r.status, 'failed', r.stdout);
    assert.strictEqual(r.collection_error, true, body);
  }
});

test('loadFailed: a duplicate whose name holds U+2028 is indexed under that name (AUDIT-38 H5)', (t) => {
  const { loadFailed } = require('../src/runner/test-runner');
  const dir = tmp(t, 'refactor-sg47lf-');
  const log = path.join(dir, 'load.log');
  const name = 'a b';
  fs.writeFileSync(log, `T\t1.2\t${dir}/src/m.js\t${JSON.stringify(name)}\n`);
  assert.strictEqual(loadFailed(log, dir, { [name]: 'pass', [`${name}\t#2`]: 'fail' }), true);
  assert.strictEqual(loadFailed(log, dir, { [name]: 'pass', [`${name}\t#2`]: 'pass' }), false);
});

test('loadFailed: a process whose parent is no node --test runner is a spawned child: its key never passes and its rows carry no name (AUDIT-35 C2)', (t) => {
  const { loadFailed } = require('../src/runner/test-runner');
  const dir = tmp(t, 'refactor-sg45log-');
  const log = path.join(dir, 'load.log');
  const at = (rows) => { fs.writeFileSync(log, rows.map(r => r.join('\t')).join('\n') + '\n'); return loadFailed(log, dir, { a: 'pass' }); };
  const T = (k, name) => ['T', k, path.join(dir, 'src/m.js'), ...(name ? [JSON.stringify(name)] : [])];
  assert.strictEqual(at([['R', '10'], ['C', '11.1', '10'], T('11.1'), ['P', '11.1']]), false, 'a file process that exited 0');
  assert.strictEqual(at([['R', '10'], ['C', '12.1', '11'], T('12.1'), ['P', '12.1']]), true, 'a child of the file process');
  assert.strictEqual(at([['R', '10'], ['C', '11.1', '10'], T('11.1', 'a')]), false, 'named in a file process');
  assert.strictEqual(at([['R', '10'], ['C', '12.1', '11'], T('12.1', 'a')]), true, 'a child\'s row is not excused by a test of its name');
});

test('runTests: pytest: a python child that fails to import the code or whose main module raises is a collection error (AUDIT-35 C2)', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  t.after(() => { delete process.env.SG45_BAD; });
  const dir = tmp(t, 'refactor-sg45py-');
  for (const d of ['app', 'tests']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'app/m.py'), "import os\n\nif os.environ.get('SG45_BAD'):\n    raise RuntimeError('bad')\n\n\ndef show(s):\n    return s\n");
  fs.writeFileSync(path.join(dir, 'app/n.py'), "import os\n\n\ndef show(s):\n    if os.environ.get('SG45_BAD'):\n        raise ValueError('bad')\n    return s\n");
  const child = (code) => `import os, subprocess, sys\n\nROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\n\n\ndef test_cli():\n    r = subprocess.run([sys.executable, '-c', ${JSON.stringify(code)}], cwd=ROOT, capture_output=True, text=True)\n    assert r.stdout == 'ab\\n'\n`;
  const run = async (code, bad, extra = '') => {
    fs.writeFileSync(path.join(dir, 'tests/test_cli.py'), child(code) + extra);
    if (bad) process.env.SG45_BAD = '1'; else delete process.env.SG45_BAD;
    return runTests({ repoRoot: dir });
  };
  for (const code of ["import sys\ntry:\n    import app.m as m\nexcept Exception as e:\n    print('error', e)\n    sys.exit(0)\nprint(m.show('ab'))", "import app.n as n\nprint(n.show('ab'))"]) {
    assert.strictEqual((await run(code, false)).status, 'passed', code);
    const r = await run(code, true);
    assert.strictEqual(r.status, 'failed', r.stdout);
    assert.strictEqual(r.collection_error, true, code);
  }
  const red = await run("import app.n as n\nprint(n.show('ab'))", false, '\n\ndef test_red():\n    assert 1 == 2\n');
  assert.strictEqual(red.collection_error, undefined, 'a child that runs cleanly logs nothing');
});

test('loadFailed: a logged name matches a test or suite as TAP writes it; a name no test or suite has falls back to its process key (AUDIT-32 H1, H2)', (t) => {
  const { loadFailed, tapResults } = require('../src/runner/test-runner');
  const entry = (n, name, type, ok = true) => [`# Subtest: ${name}`, `${ok ? '' : 'not '}ok ${n} - ${name}`, '  ---', `  type: '${type}'`, '  ...'];
  const tap = ['TAP version 13', ...entry(1, 'issue \\#12 \\\\ x\\\\n', 'test'), ...entry(2, 's \\#1', 'suite'), ...entry(3, 'r', 'suite', false), '1..3'].join('\n');
  const { tests, suites } = tapResults(tap);
  assert.deepStrictEqual(tests, { 'issue #12 \\ x\\n': 'pass' });
  assert.deepStrictEqual(suites, { 's #1': 'pass', r: 'fail' });
  const dir = tmp(t, 'refactor-lf41-');
  const log = path.join(dir, 'load.log');
  const check = (name, rows = []) => {
    fs.writeFileSync(log, [`T\t1.2\t${dir}/src/bad.js\t${JSON.stringify(name)}`, ...rows].join('\n') + '\n');
    return loadFailed(log, dir, tests, suites);
  };
  assert.strictEqual(check('issue #12 \\ x\n'), false, 'a newline is written `\\n`');
  assert.strictEqual(check('s #1'), false, 'a passing suite');
  assert.strictEqual(check('r'), true, 'a failing suite');
  assert.strictEqual(check('r', ['P\t1.2']), true, 'a failing suite is never excused by its process');
  assert.strictEqual(check('gone'), true, 'no test or suite of that name, process not passed');
  assert.strictEqual(check('gone', ['P\t1.2']), false, 'no test or suite of that name, process exited 0');
});

test('runTests: pytest: pytest.raises around an import (in a test or at a test module\'s top) is no collection error; a failing assertion elsewhere is a real failure (AUDIT-24 H1)', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  const dir = tmp(t, 'refactor-sg33py-');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'app/config.py'), "import os\n\nif not os.environ.get('SG33_KEY'):\n    raise RuntimeError('SG33_KEY required')\n");
  fs.writeFileSync(path.join(dir, 'app/m.py'), 'def f(s):\n    return s[1:]\n');
  fs.writeFileSync(path.join(dir, 'tests/test_m.py'), 'from app.m import f\n\n\ndef test_f():\n    assert f("abc") == "abc"\n');
  const inTest = 'import pytest\n\n\ndef test_config():\n    with pytest.raises(RuntimeError):\n        import app.config  # noqa: F401\n';
  const atTop = 'import pytest\n\nwith pytest.raises(RuntimeError):\n    import app.config  # noqa: F401\n\n\ndef test_config():\n    pass\n';
  for (const body of [inTest, atTop]) {
    fs.writeFileSync(path.join(dir, 'tests/test_config.py'), body);
    const red = await runTests({ repoRoot: dir });
    assert.strictEqual(red.status, 'failed');
    assert.strictEqual(red.collection_error, undefined, red.stdout);
    assert.deepStrictEqual(red.tests, { 'tests.test_config::test_config': 'pass', 'tests.test_m::test_f': 'fail' });
  }
});

test('tapResults / junitResults: 20,000 tests sharing one name parse in linear time, numbered \\t#2, \\t#3 … (AUDIT-22 C1)', () => {
  const { tapResults, junitResults } = require('../src/runner/test-runner');
  const n = 20_000;
  let tap = 'TAP version 13\n';
  for (let i = 1; i <= n; i++) tap += `# Subtest: works\nok ${i} - works\n  ---\n  duration_ms: 1\n  ...\n`;
  const xml = `<testsuite>${'<testcase classname="t" name="works"/>'.repeat(n)}</testsuite>`;
  const t0 = Date.now();
  const a = tapResults(tap), b = junitResults(xml);
  assert(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  assert.strictEqual(Object.keys(a.tests).length, n);
  assert.strictEqual(a.tests[`works\t#${n}`], 'pass');
  assert.strictEqual(b.tests[`t::works\t#${n}`], 'pass');
  const ok = (i, id) => `ok ${i} - ${id}\n  ---\n  duration_ms: 1\n  ...\n`;
  assert.deepStrictEqual(Object.keys(tapResults(ok(1, 'x#2') + ok(2, 'x') + ok(3, 'x')).tests), ['x#2', 'x', 'x\t#2']);
});

test('loadFailed: 10,000 caught-load rows against 20,000 test ids index the ids once; duplicate names must all pass (AUDIT-29 H1)', (t) => {
  const { loadFailed } = require('../src/runner/test-runner');
  const dir = tmp(t, 'refactor-lf-');
  const log = path.join(dir, 'load.log');
  const check = (names, tests) => {
    fs.writeFileSync(log, names.map(n => `T\t1.2\t${dir}/src/bad.js\t${JSON.stringify(n)}`).join('\n') + '\n');
    return loadFailed(log, dir, tests);
  };
  const tests = {}, names = [];
  for (let i = 0; i < 20_000; i++) tests[i % 2 ? `t ${i}` : `cfg ${i}`] = 'pass';
  for (let i = 0; i < 20_000; i += 2) names.push(`cfg ${i}`);
  const t0 = Date.now();
  assert.strictEqual(check(names, tests), false);
  assert(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.strictEqual(check(['a', 'a#2'], { a: 'pass', 'a\t#2': 'pass', 'a#2': 'pass', 'a#2\t#2': 'pass' }), false);
  assert.strictEqual(check(['a'], { a: 'pass', 'a\t#2': 'fail' }), true);
  assert.strictEqual(check(['a#2'], { a: 'fail', 'a#2': 'pass' }), false);
  assert.strictEqual(check(['a'], { 'a#x': 'pass' }), true);
});

test('loadFailed: a failing test of the logged name is never excused by a later passing one or a passing suite (AUDIT-34 H3)', (t) => {
  const { loadFailed } = require('../src/runner/test-runner');
  const dir = tmp(t, 'refactor-lf34-');
  const log = path.join(dir, 'load.log');
  fs.writeFileSync(log, `T\t1.2\t${dir}/src/bad.js\t"x"\nP\t1.2\n`);
  assert.strictEqual(loadFailed(log, dir, { x: 'fail', 'x\t#2': 'pass' }), true);
  assert.strictEqual(loadFailed(log, dir, { x: 'fail' }, { x: 'pass' }), true);
  assert.strictEqual(loadFailed(log, dir, { x: 'pass', 'x\t#2': 'pass' }, { x: 'pass' }), false);
});

test('tapResults / loadFailed: a name ending in `#<n>` is never a duplicate marker; names holding U+2028 / U+2029 are kept (AUDIT-36 L1, L2)', (t) => {
  const { tapResults, loadFailed } = require('../src/runner/test-runner');
  const ok = (i, id) => `ok ${i} - ${id}\n  ---\n  duration_ms: 1\n  ...\n`;
  assert.deepStrictEqual(Object.keys(tapResults(ok(1, 'dup') + ok(2, 'dup') + ok(3, 'dup\\#2')).tests), ['dup', 'dup\t#2', 'dup#2']);
  const sep = `# Subtest: s\u2029y\n    # Subtest: in\u2028ner\n    ok 1 - in\u2028ner\n      ---\n      duration_ms: 1\n      ...\n    1..1\nok 1 - s\u2029y\n  ---\n  type: 'suite'\n  ...\n`;
  assert.deepStrictEqual(tapResults(sep), { tests: { 's\u2029y > in\u2028ner': 'pass' }, load: false, suites: { 's\u2029y': 'pass' } });
  const dir = tmp(t, 'refactor-lf44-');
  const log = path.join(dir, 'load.log');
  fs.writeFileSync(log, `T\t1.2\t${dir}/src/bad.js\t"parse"\n`);
  assert.strictEqual(loadFailed(log, dir, { parse: 'pass', 'parse#1': 'fail' }), false, 'a failing test named `parse#1` is not `parse`');
  assert.strictEqual(loadFailed(log, dir, { parse: 'pass', 'parse\t#2': 'fail' }), true, 'a failing duplicate of `parse`');
});

test('runTests: a suite with an async loader (--import + module.register, --experimental-loader, NODE_OPTIONS) runs; its ES module loads are unobserved, so a failing run is a collection error (AUDIT-37 H1)', async (t) => {
  const prev = process.env.NODE_TEST_CONTEXT, opts = process.env.NODE_OPTIONS;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => {
    if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev;
    if (opts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = opts;
  });
  const dir = tmp(t, 'refactor-sg46-');
  for (const d of ['src', 'test']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'loader.mjs'), 'export async function load(url, ctx, next) { return next(url, ctx); }\n');
  fs.writeFileSync(path.join(dir, 'register.mjs'), "import { register } from 'node:module';\nregister('./loader.mjs', import.meta.url);\n");
  fs.writeFileSync(path.join(dir, 'src/calc.js'), 'export const twice = (x) => 2 * x;\n');
  const body = (n) => `import test from 'node:test';\nimport assert from 'node:assert';\nimport { twice } from '../src/calc.js';\ntest('twice', () => assert.strictEqual(twice(2), ${n}));\n`;
  for (const [cmd, options] of [['node --import ./register.mjs --test'], ['node --experimental-loader ./loader.mjs --test'], ['node --test', '--no-warnings --import ./register.mjs']]) {
    if (options) process.env.NODE_OPTIONS = options; else if (opts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = opts;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', type: 'module', private: true, scripts: { test: cmd } }));
    fs.writeFileSync(path.join(dir, 'test/calc.test.js'), body(4));
    const ok = await runTests({ repoRoot: dir });
    assert.strictEqual(ok.status, 'passed', `${cmd}: ${ok.stdout}${ok.stderr}`);
    assert.deepStrictEqual(ok.tests, { twice: 'pass' });
    fs.writeFileSync(path.join(dir, 'test/calc.test.js'), body(5));
    const red = await runTests({ repoRoot: dir });
    assert.strictEqual(red.status, 'failed', cmd);
    assert.strictEqual(red.collection_error, true, `${cmd}: no ES module load evidence`);
  }
});

test('loadFailed: a process whose ES module loads are unobserved (U row) is a load failure unless its file process exited 0 (AUDIT-37 H1)', (t) => {
  const { loadFailed } = require('../src/runner/test-runner');
  const dir = tmp(t, 'refactor-sg46log-');
  const log = path.join(dir, 'load.log');
  const at = (rows) => { fs.writeFileSync(log, rows.map(r => r.join('\t')).join('\n') + '\n'); return loadFailed(log, dir, { a: 'pass' }); };
  assert.strictEqual(at([['R', '10'], ['C', '11.1', '10'], ['U', '11.1'], ['P', '11.1']]), false);
  assert.strictEqual(at([['R', '10'], ['C', '11.1', '10'], ['U', '11.1']]), true);
  assert.strictEqual(at([['R', '10'], ['C', '12.1', '11'], ['U', '12.1'], ['P', '12.1']]), true, 'a spawned child never passes');
});

test('runTests: pytest: a nested run (two hook dirs on PYTHONPATH) starts python children cleanly (AUDIT-37 L4)', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  const dir = tmp(t, 'refactor-sg46py-');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(dir, 'tests/test_nest.py'), [
    'import os, shutil, subprocess, sys, tempfile',
    'import refactor_load_core',
    '',
    '',
    'def test_nested():',
    '    tmp = tempfile.mkdtemp()',
    "    inner = os.path.join(tmp, 'hook')",
    '    shutil.copytree(os.path.dirname(refactor_load_core.__file__), inner)',
    "    env = dict(os.environ, PYTHONPATH=os.environ['PYTHONPATH'] + os.pathsep + inner)",
    "    r = subprocess.run([sys.executable, '-c', 'pass'], env=env, capture_output=True, text=True)",
    '    shutil.rmtree(tmp)',
    "    assert r.stderr == ''",
    ''].join('\n'));
  const r = await runTests({ repoRoot: dir });
  assert.strictEqual(r.status, 'passed', r.stdout);
});

test('runTests: pytest: an operator sitecustomize on PYTHONPATH still runs, and a python child that fails to import the code is still a collection error (AUDIT-40 C1)', { skip: hasPytest ? false : 'pytest not installed' }, async (t) => {
  const prev = { PYTHONPATH: process.env.PYTHONPATH, SG48_MARK: process.env.SG48_MARK, SG48_BAD: process.env.SG48_BAD };
  t.after(() => { for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = tmp(t, 'refactor-sg48py-');
  const site = tmp(t, 'refactor-sg48site-');
  const mark = path.join(site, 'mark');
  fs.writeFileSync(path.join(site, 'sitecustomize.py'), "import os\nopen(os.environ['SG48_MARK'], 'a').write('x')\n");
  process.env.PYTHONPATH = [site, prev.PYTHONPATH].filter(Boolean).join(path.delimiter);
  process.env.SG48_MARK = mark;
  for (const d of ['app', 'tests']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(dir, 'app/__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'app/m.py'), "import os\n\nif os.environ.get('SG48_BAD'):\n    raise RuntimeError('bad')\n\n\ndef show(s):\n    return s\n");
  fs.writeFileSync(path.join(dir, 'tests/test_cli.py'), "import os, subprocess, sys\n\nROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\n\n\ndef test_cli():\n    r = subprocess.run([sys.executable, '-c', \"import app.m as m\\nprint(m.show('ab'))\"], cwd=ROOT, capture_output=True, text=True)\n    assert r.stdout == 'ab\\n'\n");
  delete process.env.SG48_BAD;
  const ok = await runTests({ repoRoot: dir });
  assert.strictEqual(ok.status, 'passed', ok.stdout + ok.stderr);
  assert.strictEqual(fs.readFileSync(mark, 'utf8'), 'xx', 'the operator sitecustomize runs once in pytest and once in its child');
  process.env.SG48_BAD = '1';
  const r = await runTests({ repoRoot: dir });
  assert.strictEqual(r.status, 'failed', r.stdout);
  assert.strictEqual(r.collection_error, true, r.stdout);
});
