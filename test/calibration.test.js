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

test('fitFromProposals without a target fits and writes the global calibration.json', () => {
  const r = calibration.fitFromProposals(fakeProposals());
  assert.strictEqual(r.trained, true);
  assert.strictEqual(calibration.MODEL_PATH, path.join(env.stateDir, 'calibration.json'));
  assert(fs.existsSync(calibration.MODEL_PATH));
});

test('fitFromProposals with a target writes under stateDirFor(target) and loadPredictor reads it', () => {
  const { stateDirFor } = require('../src/utils/checkpoint');
  const repo = path.join(env.root, 'cal-target');
  assert.strictEqual(calibration.loadPredictor(repo).isTrained(), false);
  const r = calibration.fitFromProposals(fakeProposals(), repo);
  assert.strictEqual(r.trained, true);
  assert.strictEqual(calibration.modelPath(repo), path.join(stateDirFor(repo), 'calibration.json'));
  assert(fs.existsSync(calibration.modelPath(repo)));
  const pred = calibration.loadPredictor(repo);
  assert(pred.isTrained());
  assert(pred.predict(0.78) > pred.predict(0.42));
});

test('only executed (labeled) proposals are calibration points', () => {
  const pts = calibration.executedPoints([
    { issue_id: 'a', combined_confidence: 0.7, test_outcome: { status: 'passed' } },
    { issue_id: 'b', combined_confidence: 0.6, test_outcome: { status: 'reverted' } },
    { issue_id: 'c', combined_confidence: 0.9, test_outcome: { status: 'dry_run' } },
    { issue_id: 'd', combined_confidence: 0.9, test_outcome: { status: 'environment_error' } },
    { issue_id: 'e', combined_confidence: null, test_outcome: { status: 'passed' } }
  ]);
  assert.deepStrictEqual(pts.map(({ proposal_id, x, y }) => ({ proposal_id, x, y })), [{ proposal_id: 'a', x: 0.7, y: 1 }, { proposal_id: 'b', x: 0.6, y: 0 }]);
});

test('calibration points are keyed by the edit; points stored before edit_id still load', () => {
  const repo = path.join(env.root, 'cal-edit-identity');
  fs.mkdirSync(path.dirname(calibration.pointsPath(repo)), { recursive: true });
  fs.writeFileSync(calibration.pointsPath(repo), JSON.stringify([{ proposal_id: 'snip', x: 0.9, y: 1 }]));
  const mk = (proposed, status) => ({ issue_id: 'snip', proposed_code: proposed, combined_confidence: 0.8, test_outcome: { status } });
  calibration.fitFromProposals([mk('a()', 'reverted')], repo);
  calibration.fitFromProposals([mk('b()', 'passed'), mk('a()', 'reverted')], repo);
  const pts = calibration.loadPoints(repo);
  assert.deepStrictEqual(pts.map(p => [p.proposal_id, p.y]), [['snip', 1], ['snip', 0], ['snip', 1]]);
  assert.strictEqual(new Set(pts.map(p => p.edit_id)).size, 3);
});
