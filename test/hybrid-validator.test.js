'use strict';

const { rm } = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshSession } = require('../src/utils/checkpoint');
const { TokenTracker } = require('../src/utils/token-tracker');
const { runHybridValidator } = require('../src/validation/hybrid-validator');
const { makeTempRepo, makeProposal } = require('./helpers/factories');

test('combines critic + ast + diff-test scores', async (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const tracker = new TokenTracker(freshSession(repo));
  const proposal = makeProposal('index.js',
    'module.exports.double = function double(x) { return x * 2; }',
    'module.exports.double = function double(x) { return x + x; }'
  );
  fs.writeFileSync(path.join(repo, 'index.js'), proposal.current_code);
  const stubCritic = async () => ({
    proposal_id: proposal.issue_id, persona: 'strict', preserves_semantics: true,
    edge_cases: [], hallucination_flags: [], claude_confidence: 0.8,
    reasoning: 'looks equivalent', panel: [], agreement: { mean_confidence: 0.8, std_confidence: 0.05, unanimous_approval: true, approval_rate: 1, verbal_entropy: 0.1 }
  });
  await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: stubCritic });
  assert(proposal.combined_confidence > 0 && proposal.combined_confidence <= 1);
  assert(proposal.confidence_weights.diff_test === 0.2);
  const timed = proposal.decision_trace.filter(s => typeof s.duration_ms === 'number');
  assert(timed.length >= 2, 'critic and ast trace steps carry duration_ms');
});
