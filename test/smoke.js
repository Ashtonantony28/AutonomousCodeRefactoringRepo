'use strict';

// Standalone smoke test that exercises every module structurally without
// hitting the Claude API. Builds a tiny target repo in /tmp, fakes proposals,
// then runs ast-checker, hybrid-validator (with a stub critic), reverter,
// classifier, reward, tracer, dashboard, polyglot AST, anchor matcher,
// differential testing, calibration, clusters, counterfactuals, OTel
// tracer, and the SSE dashboard server.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const http = require('http');

const { discover } = require('../src/utils/file-discovery');
const { freshSession, saveSession } = require('../src/utils/checkpoint');
const { TokenTracker } = require('../src/utils/token-tracker');
const apiCache = require('../src/utils/api-cache');

const { runChecks, checkErrorHandlingRemoval, checkSignatureDrift } = require('../src/validation/ast-checker');
const { runHybridValidator } = require('../src/validation/hybrid-validator');
const polyglot = require('../src/validation/polyglot-ast');
const diffTesting = require('../src/validation/diff-testing');

const anchor = require('../src/runner/anchor-matcher');
const { FileSnapshot, applyEdit } = require('../src/runner/reverter');
const { detectCommand, parseCounts } = require('../src/runner/test-runner');

const { collectSample, buildSample } = require('../src/rl/collector');
const { trainGradientDescent, Classifier, sampleToFeatures, trainIfReady, loadClassifier } = require('../src/rl/classifier');
const { computeReward, falsePositive, rollingWarning, rewardBreakdown } = require('../src/rl/reward');
const calibration = require('../src/rl/calibration');
const counterfactual = require('../src/rl/counterfactual');
const bugInjector = require('../src/rl/bug-injector');

const { trace, classifyFailure, persistRunSpans } = require('../src/interpretability/tracer');
const { renderHtml, aggregateStats, reliability, agreementMatrix } = require('../src/interpretability/dashboard');
const { trainProbe } = require('../src/interpretability/probe');
const clustering = require('../src/interpretability/clustering');

const { featuresFor, summarizeRun, summarizeProposal } = require('../src/orchestrator');
const { v4: uuidv4 } = require('uuid');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.message)); fail++; }
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
  await ok('discovers index.js in temp repo', () => assert(files.find(f => f.relative === 'index.js')));

  console.log('# token-tracker');
  const session = freshSession(repo);
  const tracker = new TokenTracker(session);
  await ok('records tokens and updates saturation', () => {
    const r = tracker.record('analyzer', { input_tokens: 1000, output_tokens: 200 });
    assert.strictEqual(session.token_usage.analyzer, 1200);
    assert(r.saturation > 0 && r.saturation < 1);
  });

  console.log('# ast-checker (JS)');
  await ok('detects error handling removal', () => {
    const c = checkErrorHandlingRemoval({ currentSrc: 'try { foo(); } catch (e) {}', proposedSrc: 'foo();' });
    assert.strictEqual(c.passed, false);
  });
  await ok('passes when no try/catch removed', () => {
    const c = checkErrorHandlingRemoval({ currentSrc: 'x;', proposedSrc: 'y;' });
    assert.strictEqual(c.passed, true);
  });
  await ok('detects signature drift across the repo', () => {
    const proposal = makeProposal('index.js',
      'function add(a, b) {\n  try { return a + b; } catch (e) { return null; }\n}',
      'function add(a, b, c) {\n  return a + b + c;\n}'
    );
    const result = runChecks({ proposal, repoRoot: repo });
    assert(result.checks.find(c => c.check_name === 'signature_drift'));
  });
  await ok('detects new undeclared dependency', () => {
    const proposal = makeProposal('index.js',
      "const _ = require('lodash');",
      "const _ = require('lodash');\nconst chalk = require('chalk');"
    );
    const result = runChecks({ proposal, repoRoot: repo });
    const dep = result.checks.find(c => c.check_name === 'new_dependency');
    assert.strictEqual(dep.passed, false);
  });

  console.log('# polyglot-ast (Python / Go / Ruby)');
  await ok('parses Python functions and imports', () => {
    const r = polyglot.parsePython('import os\nimport json\n\ndef foo(a, b):\n    return a + b\n');
    assert(r.functions.find(f => f.name === 'foo' && f.params === 2));
    assert(r.imports.includes('os') && r.imports.includes('json'));
  });
  await ok('flags Python signature drift via runChecks', () => {
    const r = polyglot.runChecks({
      file: 'mod.py',
      currentSrc: 'def foo(a, b):\n    return a+b\n',
      proposedSrc: 'def foo(a, b, c):\n    return a+b+c\n'
    });
    assert(r.checks.find(c => c.check_name === 'signature_drift' && c.passed === false));
  });
  await ok('parses Go functions and imports', () => {
    const r = polyglot.parseGo('package x\nimport "fmt"\n\nfunc Hello(a int) string { return "hi" }\n');
    assert(r.functions.find(f => f.name === 'Hello' && f.params === 1));
    assert(r.imports.includes('fmt'));
  });
  await ok('parses Ruby methods', () => {
    const r = polyglot.parseRuby('def hello(a, b)\n  a + b\nend\n');
    assert(r.functions.find(f => f.name === 'hello' && f.params === 2));
  });

  console.log('# anchor-matcher');
  await ok('exact match returns tier=exact', () => {
    const r = anchor.findAnchor('a\nfunction f(){return 1}\nb', 'function f(){return 1}');
    assert.strictEqual(r.tier, 'exact');
  });
  await ok('whitespace-normalized match works across reflowed code', () => {
    const r = anchor.findAnchor('function f() {\n  return 1;\n}', 'function f() { return 1; }');
    assert.strictEqual(r.tier, 'whitespace');
  });
  await ok('indent-shift match across re-indented snippet', () => {
    const target = '    function f() {\n      return 1;\n    }';
    const needle = 'function f() {\n  return 1;\n}';
    const r = anchor.findAnchor(target, needle);
    assert(['indent-shift', 'fuzzy', 'whitespace'].includes(r.tier));
  });
  await ok('fuzzy match accepts near-identical lines', () => {
    const target = 'function f(x) {\n  return x*2;\n}\n';
    const needle = 'function f(x) {\n  return x * 2;\n}\n';
    const r = anchor.findAnchor(target, needle);
    assert(['whitespace', 'fuzzy'].includes(r.tier));
  });
  await ok('throws AnchorError when nothing matches', () => {
    let threw = false;
    try { anchor.findAnchor('abc', 'wholly different content'); } catch (e) { threw = e instanceof anchor.AnchorError; }
    assert.strictEqual(threw, true);
  });

  console.log('# diff-testing (fast-check + vm)');
  await ok('finds counterexample when proposed breaks semantics', () => {
    const r = diffTesting.run({
      currentSrc:  'module.exports.double = function double(x) { return x * 2; }',
      proposedSrc: 'module.exports.double = function double(x) { return x + 2; }',
      arity: 1
    });
    assert(r.applicable);
    assert(r.mismatches > 0);
    assert(r.score < 1);
  });
  await ok('passes equivalent rewrites', () => {
    // Identity is trivially equivalent across all input types fast-check generates.
    const r = diffTesting.run({
      currentSrc:  'module.exports.id = function id(x) { return x; }',
      proposedSrc: 'module.exports.id = function id(x) {\n  return x;\n}',
      arity: 1
    });
    assert(r.applicable);
    assert.strictEqual(r.mismatches, 0);
    assert(r.score >= 0.99);
  });

  console.log('# api-cache');
  await ok('cache wraps live call and rehydrates on second call', async () => {
    apiCache.setMode('read-write');
    let calls = 0;
    const fakePayload = { kind: 'smoke', salt: Math.random() };
    const a = await apiCache.wrap(fakePayload, async () => { calls++; return { text: 'first', usage: {} }; });
    const b = await apiCache.wrap(fakePayload, async () => { calls++; return { text: 'second', usage: {} }; });
    assert.strictEqual(calls, 1);
    assert.strictEqual(a.text, 'first');
    assert.strictEqual(b.text, 'first');
    assert.strictEqual(b._cache_hit, true);
  });
  await ok('cache replay mode throws on miss', async () => {
    apiCache.setMode('replay');
    let threw = false;
    try { await apiCache.wrap({ kind: 'never-cached', n: Math.random() }, async () => ({})); }
    catch (e) { threw = e && e.code === 'CACHE_MISS'; }
    apiCache.setMode('off');
    assert.strictEqual(threw, true);
  });

  console.log('# critic ensemble (stub)');
  const { entropy } = require('../src/agents/critic');
  await ok('verbal entropy is bounded in [0,1]', () => {
    const e1 = entropy(['the code is fine', 'looks good to me', 'i approve this']);
    const e2 = entropy(['identical', 'identical', 'identical']);
    assert(e1 >= 0 && e1 <= 1);
    assert(e2 <= e1);
  });

  console.log('# hybrid-validator with stub critic + diff-test');
  await ok('combines critic + ast + diff-test scores', async () => {
    const proposal = makeProposal('index.js',
      'module.exports.double = function double(x) { return x * 2; }',
      'module.exports.double = function double(x) { return x + x; }'
    );
    // write file so AST checker can read it
    fs.writeFileSync(path.join(repo, 'index.js'), proposal.current_code);
    const stubCritic = async () => ({
      proposal_id: proposal.issue_id, persona: 'strict', preserves_semantics: true,
      edge_cases: [], hallucination_flags: [], claude_confidence: 0.8,
      reasoning: 'looks equivalent', panel: [], agreement: { mean_confidence: 0.8, std_confidence: 0.05, unanimous_approval: true, approval_rate: 1, verbal_entropy: 0.1 }
    });
    const r = await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: stubCritic });
    assert(proposal.combined_confidence > 0 && proposal.combined_confidence <= 1);
    assert(proposal.confidence_weights.diff_test === 0.2);
  });

  console.log('# reverter (4-tier)');
  await ok('captures, applies via fuzzy match, and restores', () => {
    const targetFile = path.join(repo, 'idx2.js');
    fs.writeFileSync(targetFile, '  function f() {\n    return  1;\n  }\n');
    const snap = new FileSnapshot(repo);
    snap.capture('idx2.js');
    const res = applyEdit({ repoRoot: repo, relPath: 'idx2.js', currentCode: 'function f() { return 1; }', proposedCode: 'function f() { return 2; }' });
    const after = fs.readFileSync(targetFile, 'utf8');
    assert(after.includes('return 2'));
    assert(['whitespace', 'fuzzy', 'indent-shift'].includes(res.matchTier));
    snap.restoreAll();
  });

  console.log('# test-runner');
  await ok('detects npm test command', () => {
    const cmd = detectCommand(repo);
    assert(cmd && cmd.cmd === 'npm');
  });
  await ok('parses jest counts', () => {
    const c = parseCounts('Tests:       1 failed, 3 passed', 'npm');
    assert.strictEqual(c.passed, 3);
    assert.strictEqual(c.failed, 1);
  });

  console.log('# rl + calibration + counterfactual');
  const fakeProposals = [];
  for (let i = 0; i < 25; i++) {
    const passed = i % 3 !== 0;
    fakeProposals.push({
      issue_id: 'p' + i, file: 'f.js', reasoning: '', current_code: 'x', proposed_code: 'y',
      risk_estimate: 0.1 + (i % 5) * 0.1,
      critic_verdict: { claude_confidence: passed ? 0.85 : 0.4, edge_cases: passed ? [] : ['x'], hallucination_flags: [], reasoning: passed ? 'fine' : 'risky', preserves_semantics: passed,
        agreement: { mean_confidence: passed ? 0.85 : 0.4, std_confidence: passed ? 0.03 : 0.2, unanimous_approval: passed, approval_rate: passed ? 1 : 0.3, verbal_entropy: passed ? 0.1 : 0.6 } },
      pattern_check_results: [{ check_name: 'a', passed: true, detail: '' }, { check_name: 'b', passed: passed, detail: '' }],
      combined_confidence: passed ? 0.78 : 0.42,
      test_outcome: { status: passed ? 'passed' : 'failed', coverage: { available: true, lines_pct: passed ? 0.9 : 0.4 }, stderr_tail: passed ? '' : 'Error: expected 2 but got 1' },
      decision_trace: []
    });
  }
  await ok('builds RL sample shape', () => { const s = buildSample(fakeProposals[0]); assert.strictEqual(typeof s.proposal_id, 'string'); });
  await ok('trains gradient-descent logistic regression', () => {
    const samples = fakeProposals.map(buildSample);
    const X = samples.map(sampleToFeatures);
    const y = samples.map(s => s.test_passed ? 1 : 0);
    const w = trainGradientDescent(X, y);
    assert(w && w.w.length === 5);
  });
  await ok('trainIfReady persists weights', () => {
    const samples = fakeProposals.map(buildSample);
    assert.strictEqual(trainIfReady(samples), true);
    const c = loadClassifier();
    assert(c.isTrained());
  });
  await ok('isotonic calibration trains and predicts monotonically', () => {
    const xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const ys = [0, 0, 0, 1, 0, 1, 1, 1, 1];
    const fit = calibration.fitIsotonic(xs, ys);
    const pred = calibration.buildPredictor(fit);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.1) {
      const p = pred(x);
      assert(p >= prev - 1e-9);
      prev = p;
    }
  });
  await ok('expected calibration error returns sensible value', () => {
    const ece = calibration.expectedCalibrationError([0.9, 0.9, 0.9], [1, 1, 1]);
    assert(ece >= 0 && ece <= 1);
  });
  await ok('fitFromProposals refuses too-few samples', () => {
    const r = calibration.fitFromProposals(fakeProposals.slice(0, 3));
    assert.strictEqual(r.trained, false);
  });
  await ok('fitFromProposals fits and writes calibration.json', () => {
    const r = calibration.fitFromProposals(fakeProposals);
    assert.strictEqual(r.trained, true);
    assert(fs.existsSync(require('../src/rl/calibration').MODEL_PATH));
  });
  await ok('counterfactual returns 5 contributions when trained', () => {
    const attr = counterfactual.attribute(fakeProposals[0]);
    assert(attr.trained);
    assert.strictEqual(attr.contributions.length, 5);
    const cf = counterfactual.counterfactuals(fakeProposals[0]);
    assert.strictEqual(cf.length, 5);
  });
  await ok('reward breakdown includes all terms', () => {
    const b = rewardBreakdown(fakeProposals[0]);
    assert('log_p' in b && 'fp_penalty' in b && 'stage_bonus' in b && 'coverage_penalty' in b && 'disagreement_penalty' in b);
    assert.strictEqual(typeof b.total, 'number');
  });
  await ok('reward formula still penalizes false positives', () => {
    const fp = { combined_confidence: 0.9, test_outcome: { status: 'failed' }, critic_verdict: { agreement: { std_confidence: 0, unanimous_approval: true, verbal_entropy: 0 } } };
    const tp = { combined_confidence: 0.9, test_outcome: { status: 'passed' }, critic_verdict: { agreement: { std_confidence: 0, unanimous_approval: true, verbal_entropy: 0 } } };
    assert(computeReward(fp) < computeReward(tp));
  });

  console.log('# bug-injector');
  await ok('injects deterministic mutations into passing code', () => {
    const muts = bugInjector.injectInto('function add(a, b) { return a + b; }');
    assert(muts.length > 0);
    assert(muts.every(m => m.mutated && m.mutated.length));
  });
  await ok('emits synthetic negatives for passing proposals only', () => {
    const passed = { ...fakeProposals[1], test_outcome: { status: 'passed' }, proposed_code: 'function f(){ return 1; }' };
    const failed = { ...fakeProposals[0], test_outcome: { status: 'failed' } };
    assert(bugInjector.syntheticNegatives(passed).length > 0);
    assert.strictEqual(bugInjector.syntheticNegatives(failed).length, 0);
  });

  console.log('# tracer (OTel) + clustering + dashboard');
  await ok('trace appends an OTel-shaped step', () => {
    const p = fakeProposals[0];
    const before = p.decision_trace.length;
    const step = trace(p, 'rl', { reasoning: 'gate', confidence: 0.5, outcome: 'ok', tokens: { input_tokens: 100, output_tokens: 50 }, model: 'claude-sonnet-4' });
    assert.strictEqual(p.decision_trace.length, before + 1);
    assert(step.otel && step.otel.attrs['gen_ai.system'] === 'anthropic');
    assert.strictEqual(step.otel.attrs['gen_ai.usage.input_tokens'], 100);
  });
  await ok('classifyFailure handles each branch', () => {
    const env = classifyFailure({ test_outcome: { status: 'timeout' }, combined_confidence: 0, critic_verdict: {} });
    assert.strictEqual(env, 'environment_issue');
    const logic = classifyFailure({ test_outcome: { status: 'failed' }, combined_confidence: 0.8, critic_verdict: { claude_confidence: 0.85 } });
    assert.strictEqual(logic, 'logic_error');
  });
  await ok('probe trains on labeled proposals', () => {
    const w = trainProbe(fakeProposals);
    assert(w == null || (w.w && w.w.length === 5));
  });
  await ok('tfidf + kmeans cluster failed proposals', () => {
    const r = clustering.clusterFailures(fakeProposals);
    assert(r.clusters.length > 0);
    assert(r.clusters.every(c => c.size > 0 && typeof c.label === 'string'));
  });

  console.log('# dashboard renderer');
  await ok('renders HTML with reliability + agreement panels', () => {
    const sess = freshSession(repo);
    sess.proposals = fakeProposals.slice(0, 5);
    const html = renderHtml(sess);
    assert(html.includes('Reliability diagram'));
    assert(html.includes('Critic vs. tests'));
    assert(html.includes('What-if'));
  });
  await ok('aggregateStats computes pass_rate', () => {
    const stats = aggregateStats({ proposals: fakeProposals, token_usage: {}, context_saturation: {} });
    assert(stats.pass_rate > 0 && stats.pass_rate < 1);
  });
  await ok('reliability builds bins', () => {
    const r = reliability({ proposals: fakeProposals });
    assert(r && Array.isArray(r.bins) && typeof r.ece === 'number');
  });
  await ok('agreementMatrix counts 4 cells', () => {
    const a = agreementMatrix({ proposals: fakeProposals });
    assert(typeof a.tp === 'number' && typeof a.fp === 'number');
  });

  console.log('# OTel span persistence');
  await ok('persistRunSpans writes ndjson', () => {
    const sess = freshSession(repo);
    sess.proposals = fakeProposals;
    const f = persistRunSpans(sess.run_id, sess.proposals);
    assert(fs.existsSync(f));
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    assert(lines.length > 0);
    const parsed = JSON.parse(lines[0]);
    assert(parsed.attrs && parsed.attrs['gen_ai.system'] === 'anthropic');
  });

  console.log('# SSE dashboard server');
  await ok('server starts on ephemeral port and serves /healthz + /session.json', async () => {
    const { start } = require('../src/interpretability/server');
    const { server } = await start({ port: 0 });
    const addr = server.address();
    const get = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: addr.port, path: p }, (res) => {
        let body = '';
        res.on('data', d => body += d.toString());
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    const health = await get('/healthz');
    const sess = await get('/session.json');
    server.close();
    assert.strictEqual(health.status, 200);
    assert.strictEqual(sess.status, 200);
  });

  console.log('# orchestrator helpers');
  await ok('summarizeProposal trims to keys', () => {
    const s = summarizeProposal(fakeProposals[0]);
    assert(s.file && typeof s.risk_estimate === 'number');
  });
  await ok('featuresFor returns 5 numbers', () => {
    const f = featuresFor(fakeProposals[0]);
    assert.strictEqual(f.length, 5);
  });
  await ok('summarizeRun counts statuses', () => {
    const stats = summarizeRun({ proposals: fakeProposals });
    assert.strictEqual(stats.total, fakeProposals.length);
  });

  console.log('# rolling reward warning');
  await ok('rollingWarning returns null on small samples', () => {
    assert.strictEqual(rollingWarning(fakeProposals), null);
  });

  // Cleanup
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke runner crashed:', e); process.exit(1); });
