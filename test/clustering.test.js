'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const clustering = require('../src/interpretability/clustering');
const { fakeProposals } = require('./helpers/factories');

test('tfidf + kmeans cluster failed proposals', () => {
  const r = clustering.clusterFailures(fakeProposals());
  assert(r.clusters.length > 0);
  assert(r.clusters.every(c => c.size > 0 && typeof c.label === 'string'));
});
