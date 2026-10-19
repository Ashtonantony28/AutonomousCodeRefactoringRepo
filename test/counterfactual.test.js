'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const counterfactual = require('../src/rl/counterfactual');
const { buildSample } = require('../src/rl/collector');
const { trainIfReady } = require('../src/rl/classifier');
const { FEATURE_NAMES } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

test('counterfactual returns 5 contributions when trained', () => {
  const props = fakeProposals();
  assert(trainIfReady(props.map(p => buildSample(p, '/abs/repo'))));
  const attr = counterfactual.attribute(props[0]);
  assert(attr.trained);
  assert.strictEqual(attr.contributions.length, 5);
  assert.deepStrictEqual(attr.contributions.map(c => c.feature), FEATURE_NAMES);
  assert.strictEqual(counterfactual.counterfactuals(props[0]).length, 5);
});

test('counterfactual re-exports the shared FEATURE_NAMES', () => {
  assert.strictEqual(counterfactual.FEATURE_NAMES, FEATURE_NAMES);
});
