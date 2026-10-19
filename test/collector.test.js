'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildSample, collectSample, loadSamples, SAMPLES_PATH } = require('../src/rl/collector');
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

test('collectSample persists under REFACTOR_STATE_DIR', () => {
  assert.strictEqual(SAMPLES_PATH, path.join(env.stateDir, 'rl-samples.json'));
  collectSample(fakeProposals()[1], '/abs/repo');
  const all = loadSamples();
  assert.strictEqual(all.length, 1);
  assertSample(all[0]);
});
