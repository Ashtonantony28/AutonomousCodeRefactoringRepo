'use strict';

const fs = require('fs');
const path = require('path');
const { stateDir } = require('../utils/checkpoint');

// Isotonic regression via pool-adjacent-violators (PAVA). Non-parametric,
// monotone, robust to mis-calibrated linear blends. Used to map raw
// combined_confidence values into actual empirical pass-rate probabilities.
//
// Also exposes reliability-diagram bin computation and Expected Calibration
// Error (ECE) so the dashboard can show the calibration plot.

function modelPath() { return path.join(stateDir(), 'calibration.json'); }
const MIN_SAMPLES = 20;
const N_BINS = 10;

function ensureDir() {
  const dir = stateDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Sort (x,y) by x, then run PAVA on y. Returns sorted xs and isotonized ys.
function fitIsotonic(xs, ys) {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sortedX = idx.map(i => xs[i]);
  const sortedY = idx.map(i => ys[i]);
  const n = sortedY.length;
  const y = sortedY.slice();
  const w = new Array(n).fill(1);

  // PAVA: walk left-to-right, merging adjacent blocks that violate monotonicity.
  const blocks = []; // each block: { value, weight, start, end }
  for (let i = 0; i < n; i++) {
    let block = { value: y[i], weight: w[i], start: i, end: i };
    while (blocks.length > 0 && blocks[blocks.length - 1].value >= block.value) {
      const top = blocks.pop();
      block = {
        value: (top.value * top.weight + block.value * block.weight) / (top.weight + block.weight),
        weight: top.weight + block.weight,
        start: top.start,
        end: block.end
      };
    }
    blocks.push(block);
  }
  // Expand back to per-sample values
  const isoY = new Array(n);
  for (const b of blocks) for (let i = b.start; i <= b.end; i++) isoY[i] = b.value;
  return { xs: sortedX, ys: isoY, blocks };
}

function buildPredictor(fit) {
  // Stepwise interpolation: for query x, find the bracketing pair in xs
  // and interpolate linearly between block values.
  return function predict(x) {
    if (!fit.xs.length) return x;
    if (x <= fit.xs[0]) return fit.ys[0];
    if (x >= fit.xs[fit.xs.length - 1]) return fit.ys[fit.ys.length - 1];
    let lo = 0, hi = fit.xs.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (fit.xs[mid] <= x) lo = mid; else hi = mid;
    }
    const t = (x - fit.xs[lo]) / (fit.xs[hi] - fit.xs[lo] || 1);
    return fit.ys[lo] + t * (fit.ys[hi] - fit.ys[lo]);
  };
}

function save(fit) {
  ensureDir();
  fs.writeFileSync(modelPath(), JSON.stringify({
    xs: fit.xs, ys: fit.ys, fitted_at: new Date().toISOString(), n: fit.xs.length
  }, null, 2));
}

function load() {
  const p = modelPath();
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadPredictor() {
  const fit = load();
  if (!fit || !fit.xs || !fit.xs.length) return { predict: x => x, isTrained: () => false, raw: null };
  const predict = buildPredictor(fit);
  return { predict, isTrained: () => true, raw: fit };
}

function reliabilityBins(xs, ys, nBins = N_BINS) {
  const bins = Array.from({ length: nBins }, () => ({ conf_sum: 0, acc_sum: 0, n: 0 }));
  for (let i = 0; i < xs.length; i++) {
    const x = Math.max(0, Math.min(0.9999, xs[i]));
    const k = Math.min(nBins - 1, Math.floor(x * nBins));
    bins[k].conf_sum += xs[i];
    bins[k].acc_sum += ys[i];
    bins[k].n += 1;
  }
  return bins.map((b, k) => ({
    bin: k,
    lo: k / nBins,
    hi: (k + 1) / nBins,
    n: b.n,
    conf: b.n ? b.conf_sum / b.n : (k + 0.5) / nBins,
    acc: b.n ? b.acc_sum / b.n : null
  }));
}

function expectedCalibrationError(xs, ys, nBins = N_BINS) {
  const bins = reliabilityBins(xs, ys, nBins);
  const total = xs.length;
  if (!total) return 0;
  let ece = 0;
  for (const b of bins) {
    if (!b.n) continue;
    ece += (b.n / total) * Math.abs(b.conf - b.acc);
  }
  return ece;
}

function fitFromProposals(proposals) {
  const xs = [], ys = [];
  for (const p of proposals) {
    const s = p.test_outcome && p.test_outcome.status;
    if (s !== 'passed' && s !== 'failed' && s !== 'reverted') continue;
    if (typeof p.combined_confidence !== 'number') continue;
    xs.push(p.combined_confidence);
    ys.push(s === 'passed' ? 1 : 0);
  }
  if (xs.length < MIN_SAMPLES) return { trained: false, n: xs.length };
  const fit = fitIsotonic(xs, ys);
  save(fit);
  return { trained: true, n: xs.length, ece_before: expectedCalibrationError(xs, ys), bins_before: reliabilityBins(xs, ys) };
}

module.exports = {
  fitIsotonic,
  buildPredictor,
  loadPredictor,
  load,
  save,
  fitFromProposals,
  reliabilityBins,
  expectedCalibrationError,
  modelPath,
  MIN_SAMPLES
};
Object.defineProperty(module.exports, 'MODEL_PATH', { enumerable: true, get: modelPath });
