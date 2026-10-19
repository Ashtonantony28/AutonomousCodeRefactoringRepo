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

test('saveSession / loadOrInit round-trip under the target state dir', () => {
  const s = checkpoint.loadOrInit('/tmp/some-repo');
  const file = path.join(checkpoint.stateDirFor('/tmp/some-repo'), 'session.json');
  assert(fs.existsSync(file));
  assert.strictEqual(checkpoint.sessionPath('/tmp/some-repo'), file);
  assert(!fs.existsSync(checkpoint.legacySessionPath()), 'no global session.json is written');
  const resumed = checkpoint.loadOrInit('/tmp/some-repo', { resume: true });
  assert.strictEqual(resumed.run_id, s.run_id);
});

test('a run on another target (even --resume) leaves the first target\'s session resumable', () => {
  const a = checkpoint.loadOrInit('/tmp/sg13-a');
  a.proposals.push({ issue_id: 'pending', test_outcome: null });
  checkpoint.saveSession(a);
  fs.utimesSync(checkpoint.sessionPath('/tmp/sg13-a'), new Date(0), new Date(0));
  const b = checkpoint.loadOrInit('/tmp/sg13-b', { resume: true });
  assert.notStrictEqual(b.run_id, a.run_id);
  assert.strictEqual(checkpoint.sessionPath(), checkpoint.sessionPath('/tmp/sg13-b'), 'no-arg path is the latest session');
  const again = checkpoint.loadOrInit('/tmp/sg13-a', { resume: true });
  assert.strictEqual(again.run_id, a.run_id);
  assert.deepStrictEqual(again.proposals.map(p => p.issue_id), ['pending']);
});

test('a legacy global session is read once, and only for its own target', () => {
  const legacy = checkpoint.freshSession('/tmp/sg13-legacy');
  fs.mkdirSync(env.stateDir, { recursive: true });
  fs.writeFileSync(checkpoint.legacySessionPath(), JSON.stringify(legacy));
  const other = checkpoint.loadOrInit('/tmp/sg13-other', { resume: true });
  assert.notStrictEqual(other.run_id, legacy.run_id);
  assert(fs.existsSync(checkpoint.legacySessionPath()), 'another target leaves the legacy session alone');
  const own = checkpoint.loadOrInit('/tmp/sg13-legacy', { resume: true });
  assert.strictEqual(own.run_id, legacy.run_id);
  assert(!fs.existsSync(checkpoint.legacySessionPath()), 'migrated into the target dir');
  assert.strictEqual(checkpoint.loadSession('/tmp/sg13-legacy').run_id, legacy.run_id);
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
