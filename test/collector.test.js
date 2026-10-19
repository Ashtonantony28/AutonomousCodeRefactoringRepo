'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { stateDirFor } = require('../src/utils/checkpoint');
const { buildSample, collectSample, loadSamples, appendSamples, samplesPath, SAMPLES_PATH } = require('../src/rl/collector');
const { assertSample } = require('../src/contracts');
const { extractFeatures } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

test('builds RL sample shape', () => {
  const p = fakeProposals()[0];
  const s = buildSample(p, '/abs/repo');
  assert.strictEqual(typeof s.proposal_id, 'string');
  assertSample(s);
  assert.deepStrictEqual(s.features, extractFeatures(p));
  assert.strictEqual(s.label, 0);
  assert.strictEqual(buildSample(fakeProposals()[1], '/abs/repo').label, 1);
});

test('collectSample persists under the target state dir', () => {
  const repo = path.join(env.root, 'collector-target');
  assert.strictEqual(samplesPath(repo), path.join(stateDirFor(repo), 'rl-samples.json'));
  assert.strictEqual(SAMPLES_PATH, path.join(env.stateDir, 'rl-samples.json'));
  collectSample(fakeProposals()[1], repo);
  const all = loadSamples(repo);
  assert.strictEqual(all.length, 1);
  assertSample(all[0]);
  assert.deepStrictEqual(loadSamples(), [], 'nothing written to the global store');
});

test('collectSample de-dups by proposal and skips unlabeled outcomes', () => {
  const repo = path.join(env.root, 'collector-dedup');
  const p = fakeProposals()[1];
  collectSample(p, repo);
  collectSample(p, repo);
  assert.strictEqual(loadSamples(repo).length, 1);
  for (const status of ['apply_failed', 'environment_error', 'timeout', 'skipped_no_tests']) {
    assert.strictEqual(collectSample({ ...p, issue_id: status, test_outcome: { status } }, repo), null);
  }
  assert.strictEqual(loadSamples(repo).length, 1);
  const neg = { ...buildSample(p, repo), proposal_id: `${p.issue_id}::drop_return`, synthetic: true, mutation: 'drop_return', label: 0 };
  appendSamples([neg], repo);
  appendSamples([{ ...neg, timestamp: new Date(Date.now() + 1000).toISOString() }], repo);
  assert.strictEqual(loadSamples(repo).length, 2);
});

test('an edit reverted because no test ran it is neither a sample nor a calibration point', () => {
  const calibration = require('../src/rl/calibration');
  const repo = path.join(env.root, 'collector-untested');
  const p = fakeProposals()[1];
  for (const reason of ['edit_not_exercised', 'no_coverage_tool']) {
    const q = { ...p, issue_id: reason, combined_confidence: 0.8, test_outcome: { status: 'reverted', reason } };
    assert.strictEqual(collectSample(q, repo), null);
    assert.strictEqual(calibration.executedPoints([q]).length, 0);
  }
  const failed = { ...p, issue_id: 'tests-failed', combined_confidence: 0.8, test_outcome: { status: 'reverted' } };
  assert.strictEqual(collectSample(failed, repo).label, 0);
  assert.strictEqual(calibration.executedPoints([failed]).length, 1);
});

test('an edit reverted because no mutant of it failed the suite (tests_insensitive) is not a label', () => {
  const calibration = require('../src/rl/calibration');
  const repo = path.join(env.root, 'collector-insensitive');
  const q = { ...fakeProposals()[1], issue_id: 'insensitive', combined_confidence: 0.8, test_outcome: { status: 'reverted', reason: 'tests_insensitive' } };
  assert.strictEqual(collectSample(q, repo), null);
  assert.strictEqual(calibration.executedPoints([q]).length, 0);
});
