'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { freshSession } = require('../src/utils/checkpoint');
const { TokenTracker } = require('../src/utils/token-tracker');

test('records tokens and updates saturation', () => {
  const session = freshSession('/tmp/repo');
  const tracker = new TokenTracker(session);
  const r = tracker.record('analyzer', { input_tokens: 1000, output_tokens: 200 });
  assert.strictEqual(session.token_usage.analyzer, 1200);
  assert(r.saturation > 0 && r.saturation < 1);
});
