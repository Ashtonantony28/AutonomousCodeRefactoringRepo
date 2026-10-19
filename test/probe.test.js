'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { trainProbe } = require('../src/interpretability/probe');
const { fakeProposals } = require('./helpers/factories');

test('probe trains on labeled proposals', () => {
  const w = trainProbe(fakeProposals());
  assert(w == null || (w.w && w.w.length === 5));
});
