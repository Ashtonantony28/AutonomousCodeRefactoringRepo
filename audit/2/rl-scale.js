#!/usr/bin/env node
'use strict';

// Per-target RL store growth: collectSample() (src/rl/collector.js) re-reads,
// re-indexes and rewrites the whole pretty-printed rl-samples.json for every
// sample, and syntheticNegatives() does the same; trainIfReady() trains on all
// persisted samples (400 epochs GD + ml-logistic-regression cross-check).
//
// usage: node audit/2/rl-scale.js [--sizes 1000,5000,10000,50000,100000]

const fs = require('fs');
const L = require('./lib');

const args = process.argv.slice(2);
const SIZES = (args.includes('--sizes') ? args[args.indexOf('--sizes') + 1] : '1000,5000,10000,50000,100000').split(',').map(Number);

L.isolateState('rl');
const collector = require(L.src('rl/collector'));
const classifier = require(L.src('rl/classifier'));
const target = L.tmpDir('rl-target');

function sample(k, r) {
  const synthetic = k % 4 !== 0;
  return {
    proposal_id: `p${k}${synthetic ? '::numeric_off_by_one' : ''}`,
    target_repo: target,
    features: [r(), r(), r() * 3, r()],
    label: synthetic ? 0 : (r() < 0.7 ? 1 : 0),
    synthetic,
    ...(synthetic ? { mutation: 'numeric_off_by_one' } : {}),
    timestamp: new Date().toISOString()
  };
}

function proposalFor(k) {
  return {
    issue_id: `new-${k}`,
    test_outcome: { status: 'passed' },
    critic_verdict: { p_preserves: 0.9 },
    pattern_check_results: [{ check_name: 'x', passed: true }],
    current_code: 'function a(x) {\n  const t = x;\n  return t;\n}',
    proposed_code: 'function a(x) {\n  return x;\n}',
    risk_estimate: 0.1
  };
}

console.log('samples  file_MB  collectSample_ms  per-run(50 passed x 2 writes)_s  trainIfReady_ms  loadClassifier_ms');
for (const n of SIZES) {
  const r = (() => { let s = 7; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; })();
  const all = [];
  for (let k = 0; k < n; k++) all.push(sample(k, r));
  collector.persistSamples(all, target);
  const mb = fs.statSync(collector.samplesPath(target)).size / 1e6;
  const xs = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    collector.collectSample(proposalFor(i), target);
    xs.push(performance.now() - t);
  }
  const collect = L.summarize(xs).p50;
  const t1 = performance.now();
  const trained = classifier.trainIfReady(target);
  const train = performance.now() - t1;
  const t2 = performance.now();
  classifier.loadClassifier(target);
  const load = performance.now() - t2;
  // pipeline-load measured 1 collectSample + 1 syntheticNegatives append (+3 samples) per passed proposal
  const perRun = (collect * 2 * 50) / 1000;
  console.log(`${String(n).padStart(7)} ${mb.toFixed(1).padStart(8)} ${L.fmt(collect).padStart(17)} ${L.fmt(perRun, 1).padStart(30)} ${L.fmt(train, 0).padStart(16)}${trained ? '' : ' (not trained)'} ${L.fmt(load).padStart(18)}`);
}
