'use strict';

const env = require('./helpers/env');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const counterfactual = require('../src/rl/counterfactual');
const { collectSample } = require('../src/rl/collector');
const { trainIfReady } = require('../src/rl/classifier');
const { FEATURE_NAMES } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

test('counterfactual returns one contribution per feature for the target\'s weights', () => {
  const props = fakeProposals();
  const repo = path.join(env.root, 'cf-target');
  for (const p of props) collectSample(p, repo);
  assert(trainIfReady(repo));
  const attr = counterfactual.attribute(props[0], repo);
  assert(attr.trained);
  assert.strictEqual(attr.contributions.length, FEATURE_NAMES.length);
  assert.deepStrictEqual(attr.contributions.map(c => c.feature), FEATURE_NAMES);
  assert.strictEqual(counterfactual.counterfactuals(props[0], undefined, repo).length, FEATURE_NAMES.length);
  assert.strictEqual(counterfactual.attribute(props[0], path.join(env.root, 'cf-other')).trained, false);
});

test('counterfactual re-exports the shared FEATURE_NAMES', () => {
  assert.strictEqual(counterfactual.FEATURE_NAMES, FEATURE_NAMES);
});
