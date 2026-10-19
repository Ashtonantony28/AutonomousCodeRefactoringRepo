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
