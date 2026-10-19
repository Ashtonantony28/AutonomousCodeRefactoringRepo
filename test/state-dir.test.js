'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const checkpoint = require('../src/utils/checkpoint');

test('STATE_DIR and SESSION_PATH honour REFACTOR_STATE_DIR', () => {
  assert.strictEqual(checkpoint.STATE_DIR, env.stateDir);
  assert.strictEqual(checkpoint.SESSION_PATH, path.join(env.stateDir, 'session.json'));
});

test('saveSession / loadOrInit round-trip in the temp state dir', () => {
  const s = checkpoint.loadOrInit('/tmp/some-repo');
  assert(fs.existsSync(path.join(env.stateDir, 'session.json')));
  const resumed = checkpoint.loadOrInit('/tmp/some-repo', { resume: true });
  assert.strictEqual(resumed.run_id, s.run_id);
});

test('default state dir is <tool>/state when the env var is unset', (t) => {
  const prev = process.env.REFACTOR_STATE_DIR;
  delete process.env.REFACTOR_STATE_DIR;
  t.after(() => { process.env.REFACTOR_STATE_DIR = prev; });
  assert.strictEqual(checkpoint.stateDir(), path.resolve(__dirname, '..', 'state'));
});

test('stateDirFor keys the per-target subdir by sha256 of the absolute path', () => {
  const repo = path.join(env.root, 'some', '..', 'target');
  const expected = crypto.createHash('sha256').update(path.resolve(repo)).digest('hex');
  const dir = checkpoint.stateDirFor(repo);
  assert.strictEqual(dir, path.join(env.stateDir, 'targets', expected));
  assert.notStrictEqual(checkpoint.stateDirFor('/a'), checkpoint.stateDirFor('/b'));
});
