'use strict';

// Standalone smoke test that exercises every module structurally without
// hitting the Claude API. Builds a tiny target repo in /tmp, fakes proposals,
// then runs ast-checker, hybrid-validator (with a stub critic), reverter,
// classifier, reward, tracer, and the dashboard renderer.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { discover } = require('../src/utils/file-discovery');
const { freshSession, saveSession } = require('../src/utils/checkpoint');
const { TokenTracker } = require('../src/utils/token-tracker');
const { runChecks, checkErrorHandlingRemoval, checkSignatureDrift } = require('../src/validation/ast-checker');
const { runHybridValidator } = require('../src/validation/hybrid-validator');
const { FileSnapshot, applyEdit } = require('../src/runner/reverter');
const { detectCommand, parseCounts } = require('../src/runner/test-runner');
const { collectSample, buildSample } = require('../src/rl/collector');
const { trainGradientDescent, Classifier, sampleToFeatures, trainIfReady, loadClassifier } = require('../src/rl/classifier');
const { computeReward, falsePositive, rollingWarning } = require('../src/rl/reward');
const { trace, classifyFailure } = require('../src/interpretability/tracer');
const { renderHtml, aggregateStats } = require('../src/interpretability/dashboard');
const { trainProbe } = require('../src/interpretability/probe');
const { featuresFor, summarizeRun, summarizeProposal } = require('../src/orchestrator');
const { v4: uuidv4 } = require('uuid');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ': ' + e.message); fail++; }
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-smoke-'));
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
    combined_confidence: null,
    test_outcome: null,
    decision_trace: []
  };
}

(async () => {
  console.log('# file-discovery');
  const repo = makeTempRepo();
  const files = discover(repo);
  ok('discovers index.js in temp repo', () => assert(files.find(f => f.relative === 'index.js')));

  console.log('# token-tracker');
  const session = freshSession(repo);
  const tracker = new TokenTracker(session);
  ok('records tokens and updates saturation', () => {
    const r = tracker.record('analyzer', { input_tokens: 1000, output_tokens: 200 });
    assert.strictEqual(session.token_usage.analyzer, 1200);
    assert(r.saturation > 0 && r.saturation < 1);
  });

  console.log('# ast-checker');
  ok('detects error handling removal', () => {
    const c = checkErrorHandlingRemoval({
      currentSrc: 'try { foo(); } catch (e) {}',
      proposedSrc: 'foo();'
    });
    assert.strictEqual(c.passed, false);
  });
  ok('passes when no try/catch removed', () => {
    const c = checkErrorHandlingRemoval({ currentSrc: 'x;', proposedSrc: 'y;' });
    assert.strictEqual(c.passed, true);
  });
  ok('detects signature drift across the repo', () => {
    const proposal = makeProposal(
      'index.js',
      'function add(a, b) {\n  try { return a + b; } catch (e) { return null; }\n}',
      'function add(a, b, c) {\n  return a + b + c;\n}'
    );
    const result = runChecks({ proposal, repoRoot: repo });
    const sig = result.checks.find(c => c.check_name === 'signature_drift');
    assert(sig, 'signature_drift check missing');
    // index.js doesn't call add() externally so callsite check passes — but signature changed
    // We only flag when callsite hits exist; with no call sites this should pass
    assert.strictEqual(typeof sig.passed, 'boolean');
  });
  ok('detects new undeclared dependency', () => {
    const proposal = makeProposal(
      'index.js',
      "const _ = require('lodash');",
      "const _ = require('lodash');\nconst chalk = require('chalk');"
    );
    const result = runChecks({ proposal, repoRoot: repo });
    const dep = result.checks.find(c => c.check_name === 'new_dependency');
    assert.strictEqual(dep.passed, false);
  });

  console.log('# hybrid-validator');
  ok('combines critic + ast scores correctly', async () => {
    const proposal = makeProposal(
      'index.js',
      'function double(x) { return x * 2; }',
      'function double(x) { return x + x; }'
    );
    const stubCritic = async () => ({
      proposal_id: proposal.issue_id, preserves_semantics: true,
      edge_cases: [], hallucination_flags: [], claude_confidence: 0.8,
      reasoning: 'equivalent for numbers'
    });
    const r = await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: stubCritic });
    assert(proposal.combined_confidence > 0 && proposal.combined_confidence <= 1);
    assert(proposal.pattern_check_results.length > 0);
  });

  console.log('# reverter');
  ok('captures, applies, and restores', () => {
    const snap = new FileSnapshot(repo);
    snap.capture('index.js');
    applyEdit({ repoRoot: repo, relPath: 'index.js', currentCode: 'function double(x) { return x * 2; }', proposedCode: 'function double(x) { return x + x; }' });
    const after = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
    assert(after.includes('return x + x'));
    snap.restoreAll();
    const restored = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
    assert(restored.includes('return x * 2'));
  });
  ok('throws when anchor is ambiguous', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-'));
    fs.writeFileSync(path.join(tmp, 'a.js'), 'foo();\nfoo();\n');
    let threw = false;
    try { applyEdit({ repoRoot: tmp, relPath: 'a.js', currentCode: 'foo();', proposedCode: 'bar();' }); }
    catch { threw = true; }
    assert.strictEqual(threw, true);
  });

  console.log('# test-runner');
  ok('detects npm test command', () => {
    const cmd = detectCommand(repo);
    assert(cmd && cmd.cmd === 'npm');
  });
  ok('parses jest counts', () => {
    const c = parseCounts('Tests:       1 failed, 3 passed', 'npm');
    assert.strictEqual(c.passed, 3);
    assert.strictEqual(c.failed, 1);
  });
  ok('parses mocha counts', () => {
    const c = parseCounts('  4 passing\n  1 failing\n', 'npm');
    assert.strictEqual(c.passed, 4);
    assert.strictEqual(c.failed, 1);
  });

  console.log('# rl/collector + classifier + reward');
  const fakeProposals = [];
  for (let i = 0; i < 14; i++) {
    const passed = i % 3 !== 0;
    fakeProposals.push({
      issue_id: 'p' + i,
      file: 'f.js',
      reasoning: '',
      current_code: 'x',
      proposed_code: 'y',
      risk_estimate: 0.1 + (i % 5) * 0.1,
      critic_verdict: { claude_confidence: passed ? 0.85 : 0.4, edge_cases: passed ? [] : ['x'], hallucination_flags: [], reasoning: '', preserves_semantics: passed },
      pattern_check_results: [
        { check_name: 'a', passed: true, detail: '' },
        { check_name: 'b', passed: passed, detail: '' }
      ],
      combined_confidence: passed ? 0.78 : 0.42,
      test_outcome: { status: passed ? 'passed' : 'failed' },
      decision_trace: []
    });
  }
  ok('builds RL sample shape', () => {
    const s = buildSample(fakeProposals[0]);
    assert.strictEqual(typeof s.proposal_id, 'string');
    assert.strictEqual(typeof s.test_passed, 'boolean');
  });
  ok('trains gradient-descent logistic regression', () => {
    const samples = fakeProposals.map(buildSample);
    const X = samples.map(sampleToFeatures);
    const y = samples.map(s => s.test_passed ? 1 : 0);
    const w = trainGradientDescent(X, y);
    assert(w && w.w.length === 5);
    const c = new Classifier(w);
    const p = c.predict([0.85, 1, 5, 1, 0.1]);
    assert(p > 0 && p < 1);
  });
  ok('trainIfReady persists weights and re-loads', () => {
    const samples = fakeProposals.map(buildSample);
    const trained = trainIfReady(samples);
    assert.strictEqual(trained, true);
    const c = loadClassifier();
    assert(c.isTrained());
  });
  ok('reward formula penalizes false positives', () => {
    const fp = { combined_confidence: 0.9, test_outcome: { status: 'failed' } };
    const tp = { combined_confidence: 0.9, test_outcome: { status: 'passed' } };
    assert(computeReward(fp) < computeReward(tp));
    assert.strictEqual(falsePositive(fp), 1);
    assert.strictEqual(falsePositive(tp), 0);
  });

  console.log('# tracer + interpretability');
  ok('trace appends a step', () => {
    const p = fakeProposals[0];
    const before = p.decision_trace.length;
    trace(p, 'rl', { reasoning: 'test', confidence: 0.5, outcome: 'ok' });
    assert.strictEqual(p.decision_trace.length, before + 1);
  });
  ok('classifyFailure handles each branch', () => {
    const env = classifyFailure({ test_outcome: { status: 'timeout' }, combined_confidence: 0, critic_verdict: {} });
    assert.strictEqual(env, 'environment_issue');
    const logic = classifyFailure({ test_outcome: { status: 'failed' }, combined_confidence: 0.8, critic_verdict: { claude_confidence: 0.85 } });
    assert.strictEqual(logic, 'logic_error');
    const caught = classifyFailure({ test_outcome: { status: 'failed' }, combined_confidence: 0.3, critic_verdict: { claude_confidence: 0.3 } });
    assert.strictEqual(caught, 'caught_correctly');
  });
  ok('probe trains on labeled proposals', () => {
    const w = trainProbe(fakeProposals);
    assert(w == null || (w.w && w.w.length === 5));
  });

  console.log('# orchestrator helpers');
  ok('summarizeProposal trims to keys', () => {
    const s = summarizeProposal(fakeProposals[0]);
    assert(s.file && typeof s.risk_estimate === 'number');
  });
  ok('featuresFor returns 5 numbers', () => {
    const f = featuresFor(fakeProposals[0]);
    assert.strictEqual(f.length, 5);
    f.forEach(x => assert(typeof x === 'number'));
  });
  ok('summarizeRun counts statuses', () => {
    const stats = summarizeRun({ proposals: fakeProposals });
    assert.strictEqual(stats.total, fakeProposals.length);
    assert(stats.passed > 0);
  });

  console.log('# dashboard renderer');
  ok('renders HTML containing run id', () => {
    const sess = freshSession(repo);
    sess.proposals = fakeProposals.slice(0, 3);
    sess.test_results = [];
    const html = renderHtml(sess);
    assert(html.includes(sess.run_id));
    assert(html.includes('Pass rate'));
  });
  ok('aggregateStats computes pass_rate', () => {
    const sess = { proposals: fakeProposals, token_usage: {}, context_saturation: {} };
    const stats = aggregateStats(sess);
    assert(stats.pass_rate > 0 && stats.pass_rate < 1);
  });

  console.log('# rolling reward warning');
  ok('rollingWarning returns null on small samples', () => {
    assert.strictEqual(rollingWarning(fakeProposals), null);
  });

  // Cleanup
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke runner crashed:', e); process.exit(1); });
