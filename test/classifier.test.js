'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildSample } = require('../src/rl/collector');
const { trainGradientDescent, sampleToFeatures, sampleLabel, trainIfReady, loadClassifier, WEIGHTS_PATH } = require('../src/rl/classifier');
const { FEATURE_NAMES } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

const samples = () => fakeProposals().map(p => buildSample(p, '/abs/repo'));

test('trains gradient-descent logistic regression', () => {
  const s = samples();
  const w = trainGradientDescent(s.map(sampleToFeatures), s.map(sampleLabel));
  assert(w && w.w.length === 5);
});

test('trainIfReady persists weights', () => {
  assert.strictEqual(trainIfReady(samples()), true);
  assert.strictEqual(WEIGHTS_PATH, path.join(env.stateDir, 'rl-weights.json'));
  assert(fs.existsSync(WEIGHTS_PATH));
  const c = loadClassifier();
  assert(c.isTrained());
  assert.deepStrictEqual(c.weights.feature_names, FEATURE_NAMES);
});

test('legacy flat samples still map to the same features', () => {
  const p = fakeProposals()[1];
  const s = buildSample(p, '/abs/repo');
  const legacy = {
    critic_confidence: s.features[0], pattern_score: s.features[1], proposal_complexity: s.features[2],
    files_changed: 1, risk_estimate: s.features[4], test_passed: true
  };
  assert.deepStrictEqual(sampleToFeatures(legacy), sampleToFeatures(s));
  assert.strictEqual(sampleLabel(legacy), sampleLabel(s));
});
