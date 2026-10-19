'use strict';

const fs = require('fs');
const path = require('path');
const { stateDir } = require('../utils/checkpoint');
const { FEATURE_NAMES } = require('./features');

let MLLogReg, Matrix;
try { MLLogReg = require('ml-logistic-regression'); } catch { MLLogReg = null; }
try { Matrix = require('ml-matrix').Matrix; } catch { Matrix = null; }

function weightsPath() { return path.join(stateDir(), 'rl-weights.json'); }
const FEATURE_COUNT = FEATURE_NAMES.length;
const MIN_TRAIN_SAMPLES = 10;
const RL_GATE_THRESHOLD = 0.4;

function ensureStateDir() {
  const dir = stateDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sampleToFeatures(s) {
  if (Array.isArray(s.features)) return s.features.map(v => Number(v) || 0);
  return [
    Number(s.critic_confidence) || 0,
    Number(s.pattern_score) || 0,
    Number(s.proposal_complexity) || 0,
    Number(s.files_changed) || 1,
    Number(s.risk_estimate) || 0
  ];
}

function sampleLabel(s) {
  if (s.label === 0 || s.label === 1) return s.label;
  return s.test_passed ? 1 : 0;
}

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

// Self-contained logistic regression (gradient descent). Used as the default
// because it's deterministic, dependency-free, and small. If ml-logistic-regression
// is installed, we still use it for cross-checking but persist OUR weights.
function trainGradientDescent(X, y, opts = {}) {
  const { lr = 0.05, epochs = 400, l2 = 0.001 } = opts;
  const n = X.length;
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;

  // Standardize per-feature for stability
  const means = new Array(d).fill(0);
  const stds = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += X[i][j];
    means[j] = sum / n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i][j] - means[j]) ** 2;
    stds[j] = Math.sqrt(v / n) || 1;
  }
  const Xs = X.map(row => row.map((v, j) => (v - means[j]) / stds[j]));

  for (let e = 0; e < epochs; e++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Xs[i][j];
      const p = sigmoid(z);
      const err = p - y[i];
      for (let j = 0; j < d; j++) gradW[j] += err * Xs[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gradW[j] / n + l2 * w[j]);
    b -= lr * (gradB / n);
  }
  return { w, b, means, stds };
}

class Classifier {
  constructor(weights) {
    this.weights = weights || null;
  }
  isTrained() { return !!this.weights; }
  predict(features) {
    if (!this.weights) return 0.5;
    const { w, b, means, stds } = this.weights;
    let z = b;
    for (let j = 0; j < w.length; j++) {
      const xs = (features[j] - means[j]) / (stds[j] || 1);
      z += w[j] * xs;
    }
    return sigmoid(z);
  }
}

function loadWeights() {
  ensureStateDir();
  const p = weightsPath();
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function saveWeights(weights) {
  ensureStateDir();
  fs.writeFileSync(weightsPath(), JSON.stringify(weights, null, 2));
}

function loadClassifier() {
  return new Classifier(loadWeights());
}

function trainIfReady(samples) {
  if (!samples || samples.length < MIN_TRAIN_SAMPLES) return false;
  // Need at least one positive AND one negative example
  const labels = samples.map(sampleLabel);
  const hasPos = labels.includes(1);
  const hasNeg = labels.includes(0);
  if (!hasPos || !hasNeg) return false;

  const X = samples.map(sampleToFeatures);
  const weights = trainGradientDescent(X, labels);
  weights.trained_at = new Date().toISOString();
  weights.sample_count = samples.length;
  weights.feature_names = FEATURE_NAMES.slice();

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

  saveWeights(weights);
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
  trainGradientDescent,
  MIN_TRAIN_SAMPLES,
  RL_GATE_THRESHOLD,
  FEATURE_COUNT,
  weightsPath
};
Object.defineProperty(module.exports, 'WEIGHTS_PATH', { enumerable: true, get: weightsPath });
