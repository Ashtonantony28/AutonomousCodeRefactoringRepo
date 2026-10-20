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
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('refactor-cov-')));
  const r = await runTests({ repoRoot: dir, command: { cmd: process.execPath, args: ['-e', '0'], framework: 'npm' }, edit: spanOf('  return a + 1;') });
  assert.strictEqual(r.coverage.exercised, false);
  assert.match(r.coverage.detail, /never loaded/);
  const left = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('refactor-cov-') && !before.has(n));
  assert.deepStrictEqual(left, []);
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
