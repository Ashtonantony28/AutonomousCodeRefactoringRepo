'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-repo-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tmp', version: '0.0.0', dependencies: { lodash: '^4.0.0' }, scripts: { test: 'echo "Tests:        2 passed" && exit 0' }
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), [
    "const _ = require('lodash');",
    'function add(a, b) {',
    '  try { return a + b; } catch (e) { return null; }',
    '}',
    'function double(x) { return x * 2; }',
    'module.exports = { add, double };'
  ].join('\n'));
  return dir;
}

function makeProposal(file, current, proposed, opts = {}) {
  return {
    issue_id: uuidv4(),
    file,
    current_code: current,
    proposed_code: proposed,
    reasoning: opts.reasoning || 'tighten',
    risk_estimate: opts.risk == null ? 0.2 : opts.risk,
    critic_verdict: null,
    pattern_check_results: [],
    diff_test: null,
    combined_confidence: null,
    test_outcome: null,
    decision_trace: []
  };
}

function fakeProposals(n = 25) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const passed = i % 3 !== 0;
    out.push({
      issue_id: 'p' + i, file: 'f.js', reasoning: '', current_code: 'x', proposed_code: 'y',
      risk_estimate: 0.1 + (i % 5) * 0.1,
      critic_verdict: {
        p_preserves: passed ? 0.85 : 0.4, edge_cases: passed ? [] : ['x'], hallucination_flags: [], reasoning: passed ? 'fine' : 'risky', preserves_semantics: passed,
        agreement: { mean_confidence: passed ? 0.85 : 0.4, std_confidence: passed ? 0.03 : 0.2, unanimous_approval: passed, approval_rate: passed ? 1 : 0.3, verbal_entropy: passed ? 0.1 : 0.6 }
      },
      pattern_check_results: [{ check_name: 'a', passed: true, detail: '' }, { check_name: 'b', passed, detail: '' }],
      diff_test: null,
      combined_confidence: passed ? 0.78 : 0.42,
      test_outcome: { status: passed ? 'passed' : 'failed', coverage: { available: true, lines_pct: passed ? 0.9 : 0.4 }, stderr_tail: passed ? '' : 'Error: expected 2 but got 1' },
      decision_trace: []
    });
  }
  return out;
}

module.exports = { makeTempRepo, makeProposal, fakeProposals };
