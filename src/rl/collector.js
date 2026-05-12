'use strict';

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('../utils/checkpoint');

const SAMPLES_PATH = path.join(STATE_DIR, 'rl-samples.json');

function proposalComplexity(p) {
  const cur = (p.current_code || '').split('\n').length;
  const prop = (p.proposed_code || '').split('\n').length;
  return Math.max(cur, prop);
}

function buildSample(proposal) {
  const ast = proposal.pattern_check_results || [];
  const passed = ast.filter(c => c.passed).length;
  const patternScore = ast.length ? passed / ast.length : 0.5;
  const claudeConf = proposal.critic_verdict ? (proposal.critic_verdict.claude_confidence || 0) : 0;
  const outcome = proposal.test_outcome ? proposal.test_outcome.status : null;
  return {
    proposal_id: proposal.issue_id,
    file: proposal.file,
    critic_confidence: claudeConf,
    pattern_score: patternScore,
    combined_confidence: proposal.combined_confidence || 0,
    proposal_complexity: proposalComplexity(proposal),
    files_changed: 1,
    risk_estimate: proposal.risk_estimate || 0,
    test_passed: outcome === 'passed',
    outcome,
    timestamp: new Date().toISOString()
  };
}

function loadSamples() {
  if (!fs.existsSync(SAMPLES_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(SAMPLES_PATH, 'utf8')); } catch { return []; }
}

function persistSamples(samples) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SAMPLES_PATH, JSON.stringify(samples, null, 2));
}

function collectSample(proposal) {
  const sample = buildSample(proposal);
  const all = loadSamples();
  all.push(sample);
  persistSamples(all);
  return sample;
}

module.exports = { collectSample, buildSample, loadSamples, persistSamples, SAMPLES_PATH };
