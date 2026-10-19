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

test('runTests reports timeout through the process-group kill', { skip: process.platform === 'win32' }, async () => {
  const r = await runTests({ repoRoot: process.cwd(), command: { cmd: 'sh', args: ['-c', 'sleep 30 & wait'], framework: 'sh' }, timeoutMs: 200 });
  assert.strictEqual(r.status, 'timeout');
});
