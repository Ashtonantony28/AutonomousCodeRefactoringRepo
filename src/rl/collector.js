'use strict';

const fs = require('fs');
const path = require('path');
const { stateDir } = require('../utils/checkpoint');
const { extractFeatures } = require('./features');

function samplesPath() { return path.join(stateDir(), 'rl-samples.json'); }

function buildSample(proposal, targetRepo = null) {
  const outcome = proposal.test_outcome ? proposal.test_outcome.status : null;
  return {
    proposal_id: proposal.issue_id,
    target_repo: targetRepo,
    features: extractFeatures(proposal),
    label: outcome === 'passed' ? 1 : 0,
    synthetic: false,
    timestamp: new Date().toISOString()
  };
}

function loadSamples() {
  const p = samplesPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function persistSamples(samples) {
  const dir = stateDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(samplesPath(), JSON.stringify(samples, null, 2));
}

function collectSample(proposal, targetRepo = null) {
  const sample = buildSample(proposal, targetRepo);
  const all = loadSamples();
  all.push(sample);
  persistSamples(all);
  return sample;
}

module.exports = { collectSample, buildSample, loadSamples, persistSamples, samplesPath };
Object.defineProperty(module.exports, 'SAMPLES_PATH', { enumerable: true, get: samplesPath });
