'use strict';

const fs = require('fs');
const path = require('path');
const { stateDir, stateDirFor } = require('../utils/checkpoint');
const { extractFeatures } = require('./features');

// Outcomes that say something about the edit itself. Environment problems,
// apply failures and untested edits are not labels.
const LABELED_STATUSES = ['passed', 'failed', 'reverted'];
// `reverted` because no test ran the edit, or no mutant of it failed the
// suite: the tests never judged it.
const UNTESTED_REASONS = ['edit_not_exercised', 'no_coverage_tool', 'tests_insensitive'];

function isLabeled(outcome) {
  return !!outcome && LABELED_STATUSES.includes(outcome.status) && !UNTESTED_REASONS.includes(outcome.reason);
}

// Learning state lives per target repo (stateDirFor); without a target the
// legacy global state dir is used.
function learningDir(targetRepo) {
  return targetRepo ? stateDirFor(targetRepo) : stateDir();
}

function samplesPath(targetRepo = null) { return path.join(learningDir(targetRepo), 'rl-samples.json'); }

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

// Timestamp-free identity: the same proposal (or the same mutant of it) is
// one sample however many times it is collected.
function sampleKey(s) {
  return `${s.proposal_id}|${s.synthetic ? 'synthetic' : 'real'}|${s.mutation || ''}`;
}

function loadSamples(targetRepo = null) {
  const p = samplesPath(targetRepo);
  if (!fs.existsSync(p)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(all) ? all : [];
  } catch { return []; }
}

function persistSamples(samples, targetRepo = null) {
  const dir = learningDir(targetRepo);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const p = samplesPath(targetRepo);
  fs.writeFileSync(p + '.tmp', JSON.stringify(samples, null, 2));
  fs.renameSync(p + '.tmp', p);
}

// Merge into the persisted set; a later sample with the same key replaces the earlier one.
function appendSamples(samples, targetRepo = null) {
  const all = loadSamples(targetRepo);
  const index = new Map(all.map((s, i) => [sampleKey(s), i]));
  for (const s of samples) {
    const k = sampleKey(s);
    if (index.has(k)) all[index.get(k)] = s;
    else { index.set(k, all.length); all.push(s); }
  }
  persistSamples(all, targetRepo);
  return all;
}

// Returns null when the outcome carries no label.
function collectSample(proposal, targetRepo = null) {
  if (!isLabeled(proposal.test_outcome)) return null;
  const sample = buildSample(proposal, targetRepo);
  appendSamples([sample], targetRepo);
  return sample;
}

module.exports = {
  collectSample, buildSample, loadSamples, persistSamples, appendSamples, sampleKey,
  samplesPath, learningDir, LABELED_STATUSES, UNTESTED_REASONS, isLabeled
};
Object.defineProperty(module.exports, 'SAMPLES_PATH', { enumerable: true, get: () => samplesPath() });
