'use strict';

const fs = require('fs');
const path = require('path');
const { FEATURE_NAMES, extractFeatures, sameFeatureNames } = require('./features');
const { loadSamples, learningDir } = require('./collector');
const calibration = require('./calibration');

// The "RL gate": supervised logistic regression on test outcomes (the
// reward is diagnostic only and is not trained on). Optionally combined
// with the isotonic calibration of combined_confidence.

let MLLogReg, Matrix;
try { MLLogReg = require('ml-logistic-regression'); } catch { MLLogReg = null; }
try { Matrix = require('ml-matrix').Matrix; } catch { Matrix = null; }

function weightsPath(targetRepo = null) { return path.join(learningDir(targetRepo), 'rl-weights.json'); }
const FEATURE_COUNT = FEATURE_NAMES.length;
const MIN_TRAIN_SAMPLES = 10;
const RL_GATE_THRESHOLD = 0.4;
const SYNTHETIC_WEIGHT = 0.5;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sampleToFeatures(s) {
  if (Array.isArray(s.features)) return s.features.map(v => Number(v) || 0);
  return [
    Number(s.p_preserves ?? s.critic_confidence) || 0,
    Number(s.pattern_score) || 0,
    Number(s.proposal_complexity) || 0,
    Number(s.risk_estimate) || 0
  ];
}

function sampleLabel(s) {
  if (s.label === 0 || s.label === 1) return s.label;
  return s.test_passed ? 1 : 0;
}

function sampleWeight(s) { return s.synthetic ? SYNTHETIC_WEIGHT : 1; }

// Samples trainable under the current FEATURE_NAMES (legacy 5-feature rows are skipped).
function usableSamples(samples) {
  return (samples || []).filter(s => s && sampleToFeatures(s).length === FEATURE_COUNT);
}

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

// Self-contained weighted logistic regression (gradient descent on the
// weighted mean log-loss, features standardized with weighted moments).
function trainGradientDescent(X, y, opts = {}) {
  const { lr = 0.05, epochs = 400, l2 = 0.001 } = opts;
  const n = X.length;
  const d = X[0].length;
  const sw = opts.sampleWeights || new Array(n).fill(1);
  const W = sw.reduce((a, b) => a + b, 0) || 1;
  const w = new Array(d).fill(0);
  let b = 0;

  const means = new Array(d).fill(0);
  const stds = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sw[i] * X[i][j];
    means[j] = sum / W;
    let v = 0;
    for (let i = 0; i < n; i++) v += sw[i] * (X[i][j] - means[j]) ** 2;
    stds[j] = Math.sqrt(v / W) || 1;
  }
  const Xs = X.map(row => row.map((v, j) => (v - means[j]) / stds[j]));

  for (let e = 0; e < epochs; e++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Xs[i][j];
      const err = sw[i] * (sigmoid(z) - y[i]);
      for (let j = 0; j < d; j++) gradW[j] += err * Xs[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gradW[j] / W + l2 * w[j]);
    b -= lr * (gradB / W);
  }
  return { w, b, means, stds };
}

function validWeights(weights) {
  return !!weights && Array.isArray(weights.w) && weights.w.length === FEATURE_COUNT &&
    sameFeatureNames(weights.feature_names);
}

class Classifier {
  // Weights trained under a different FEATURE_NAMES list are dropped
  // (untrained) rather than applied to the wrong feature positions.
  constructor(weights, { calibrator = null } = {}) {
    this.weights = validWeights(weights) ? weights : null;
    this.ignored = weights && !this.weights
      ? `weights for [${(weights.feature_names || []).join(',') || `${(weights.w || []).length} features`}] do not match [${FEATURE_NAMES.join(',')}]`
      : null;
    this.calibrator = calibrator;
  }
  isTrained() { return !!this.weights; }
  predict(features) {
    if (!this.weights || !Array.isArray(features) || features.length !== this.weights.w.length) return 0.5;
    const { w, b, means, stds } = this.weights;
    let z = b;
    for (let j = 0; j < w.length; j++) {
      const xs = (features[j] - means[j]) / (stds[j] || 1);
      z += w[j] * xs;
    }
    return sigmoid(z);
  }
  // Pre-executor gate. Each trained signal votes: the classifier's p_pass on
  // the features and the calibrated pass rate of combined_confidence. The
  // gate uses the lower one; with neither trained it does not gate.
  gate(proposal) {
    const out = { gated: false, p_pass: null, source: null, classifier_p: null, calibrated_p: null };
    if (this.isTrained()) out.classifier_p = this.predict(extractFeatures(proposal));
    if (this.calibrator && this.calibrator.isTrained() && typeof proposal.combined_confidence === 'number') {
      out.calibrated_p = this.calibrator.predict(proposal.combined_confidence);
    }
    const votes = [['calibration', out.calibrated_p], ['classifier', out.classifier_p]].filter(([, v]) => typeof v === 'number');
    if (!votes.length) return out;
    const [source, p] = votes.reduce((a, c) => (c[1] < a[1] ? c : a));
    return { ...out, gated: true, p_pass: p, source, rejected: p < RL_GATE_THRESHOLD };
  }
}

function loadWeights(targetRepo = null) {
  const p = weightsPath(targetRepo);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function saveWeights(weights, targetRepo = null) {
  ensureDir(learningDir(targetRepo));
  fs.writeFileSync(weightsPath(targetRepo), JSON.stringify(weights, null, 2));
}

function loadClassifier(targetRepo = null) {
  return new Classifier(loadWeights(targetRepo), { calibrator: calibration.loadPredictor(targetRepo) });
}

// trainIfReady(targetRepo) trains on every persisted sample for that target
// (all runs). trainIfReady(samples[, { targetRepo }]) trains on the given set.
function trainIfReady(samplesOrTarget, { targetRepo = null } = {}) {
  let samples = samplesOrTarget;
  if (typeof samplesOrTarget === 'string') {
    targetRepo = samplesOrTarget;
    const abs = path.resolve(targetRepo);
    samples = loadSamples(targetRepo).filter(s => !s.target_repo || path.resolve(s.target_repo) === abs);
  }
  samples = usableSamples(samples);
  if (samples.length < MIN_TRAIN_SAMPLES) return false;
  // Need at least one positive AND one negative example
  const labels = samples.map(sampleLabel);
  const hasPos = labels.includes(1);
  const hasNeg = labels.includes(0);
  if (!hasPos || !hasNeg) return false;

  const X = samples.map(sampleToFeatures);
  const weights = trainGradientDescent(X, labels, { sampleWeights: samples.map(sampleWeight) });
  weights.trained_at = new Date().toISOString();
  weights.sample_count = samples.length;
  weights.synthetic_count = samples.filter(s => s.synthetic).length;
  weights.feature_names = FEATURE_NAMES.slice();
  weights.target_repo = targetRepo ? path.resolve(targetRepo) : null;

  // Optional: fit ml-logistic-regression as a sanity-check (not persisted as weights)
  if (MLLogReg && Matrix) {
    try {
      const Ctor = MLLogReg.default || MLLogReg;
      const lr = new Ctor({ numSteps: 200, learningRate: 0.05 });
      const Xm = new Matrix(X);
      const Ym = Matrix.columnVector(labels);
      lr.train(Xm, Ym);
      weights.cross_check = 'ml-logistic-regression trained successfully';
    } catch (err) {
      weights.cross_check = `ml-logistic-regression error: ${err.message}`;
    }
  }

  saveWeights(weights, targetRepo);
  return true;
}

module.exports = {
  Classifier,
  loadClassifier,
  loadWeights,
  saveWeights,
  trainIfReady,
  sampleToFeatures,
  sampleLabel,
  sampleWeight,
  usableSamples,
  validWeights,
  trainGradientDescent,
  MIN_TRAIN_SAMPLES,
  RL_GATE_THRESHOLD,
  SYNTHETIC_WEIGHT,
  FEATURE_COUNT,
  weightsPath
};
Object.defineProperty(module.exports, 'WEIGHTS_PATH', { enumerable: true, get: () => weightsPath() });
