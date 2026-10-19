'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const calibration = require('../src/rl/calibration');
const { fakeProposals } = require('./helpers/factories');

test('isotonic calibration trains and predicts monotonically', () => {
  const xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const ys = [0, 0, 0, 1, 0, 1, 1, 1, 1];
  const pred = calibration.buildPredictor(calibration.fitIsotonic(xs, ys));
  let prev = -1;
  for (let x = 0; x <= 1; x += 0.1) {
    const p = pred(x);
    assert(p >= prev - 1e-9);
    prev = p;
  }
});

test('expected calibration error returns sensible value', () => {
  const ece = calibration.expectedCalibrationError([0.9, 0.9, 0.9], [1, 1, 1]);
  assert(ece >= 0 && ece <= 1);
});

test('fitFromProposals refuses too-few samples', () => {
  assert.strictEqual(calibration.fitFromProposals(fakeProposals().slice(0, 3)).trained, false);
});

test('fitFromProposals fits and writes calibration.json', () => {
  const r = calibration.fitFromProposals(fakeProposals());
  assert.strictEqual(r.trained, true);
  assert.strictEqual(calibration.MODEL_PATH, path.join(env.stateDir, 'calibration.json'));
  assert(fs.existsSync(calibration.MODEL_PATH));
});
