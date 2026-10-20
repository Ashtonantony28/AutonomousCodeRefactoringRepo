'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stateDirFor, freshSession } = require('../src/utils/checkpoint');
const { TokenTracker } = require('../src/utils/token-tracker');
const { buildSample, collectSample, loadSamples } = require('../src/rl/collector');
const {
  Classifier, trainGradientDescent, sampleToFeatures, sampleLabel, sampleWeight, trainIfReady,
  loadClassifier, loadWeights, saveWeights, weightsPath, WEIGHTS_PATH, RL_GATE_THRESHOLD
} = require('../src/rl/classifier');
const calibration = require('../src/rl/calibration');
const { computeReward, pCorrect } = require('../src/rl/reward');
const bugInjector = require('../src/rl/bug-injector');
const { runChecks } = require('../src/validation/ast-checker');
const { FEATURE_NAMES, extractFeatures } = require('../src/rl/features');
const { processProposal } = require('../src/orchestrator');
const { fakeProposals, makeTempRepo, makeProposal } = require('./helpers/factories');
const { installStub, resetClient } = require('./helpers/stub-client');

const samples = (repo = '/abs/repo') => fakeProposals().map(p => buildSample(p, repo));
const target = (name) => path.join(env.root, 'targets-under-test', name);

test('trains gradient-descent logistic regression on FEATURE_NAMES', () => {
  const s = samples();
  const w = trainGradientDescent(s.map(sampleToFeatures), s.map(sampleLabel));
  assert(w && w.w.length === FEATURE_NAMES.length);
});

test('trainIfReady(samples) persists weights at the global path', () => {
  assert.strictEqual(trainIfReady(samples()), true);
  assert.strictEqual(WEIGHTS_PATH, path.join(env.stateDir, 'rl-weights.json'));
  assert(fs.existsSync(WEIGHTS_PATH));
  const c = loadClassifier();
  assert(c.isTrained());
  assert.deepStrictEqual(c.weights.feature_names, FEATURE_NAMES);
});

test('legacy flat samples still map to the same features', () => {
  const p = fakeProposals()[1];
  const s = buildSample(p, '/abs/repo');
  const legacy = {
    critic_confidence: s.features[0], pattern_score: s.features[1], proposal_complexity: s.features[2],
    risk_estimate: s.features[3], test_passed: true
  };
  assert.deepStrictEqual(sampleToFeatures(legacy), sampleToFeatures(s));
  assert.strictEqual(sampleLabel(legacy), sampleLabel(s));
});

test('synthetic samples weigh 0.5 in the weighted gradient', () => {
  assert.strictEqual(sampleWeight({ synthetic: true }), 0.5);
  assert.strictEqual(sampleWeight({ synthetic: false }), 1);
  // Duplicating a row with weight 0.5 twice == the row once with weight 1.
  const X = [[0.9, 1, 2, 0.1], [0.4, 0.5, 9, 0.6], [0.8, 1, 3, 0.2], [0.5, 0.75, 8, 0.5]];
  const y = [1, 0, 1, 0];
  const a = trainGradientDescent(X, y, { sampleWeights: [1, 1, 1, 1] });
  const b = trainGradientDescent([...X, X[1]], [...y, y[1]], { sampleWeights: [1, 0.5, 1, 1, 0.5] });
  for (let j = 0; j < 4; j++) assert(Math.abs(a.w[j] - b.w[j]) < 1e-9, `w[${j}]`);
});

test('5-feature legacy weights are ignored, not applied to 4-feature vectors', () => {
  const repo = target('legacy-weights');
  const legacy = {
    w: [2, 1, 0.1, 0.5, -1], b: 0.3, means: [0.7, 0.8, 5, 1, 0.3], stds: [0.1, 0.1, 2, 1, 0.1],
    feature_names: ['critic_confidence', 'pattern_score', 'proposal_complexity', 'files_changed', 'risk_estimate']
  };
  saveWeights(legacy, repo);
  const c = loadClassifier(repo);
  assert.strictEqual(c.isTrained(), false);
  assert.match(c.ignored, /files_changed/);
  assert.strictEqual(c.predict([0.9, 1, 3, 0.1]), 0.5);
  assert.strictEqual(c.gate({ combined_confidence: 0.9 }).gated, false);
  // Same length but unnamed / wrong-length weights are rejected too.
  assert.strictEqual(new Classifier({ ...legacy, w: [1, 1, 1, 1], feature_names: undefined }).isTrained(), false);
  assert.strictEqual(new Classifier({ ...legacy, w: [1, 1, 1], feature_names: FEATURE_NAMES }).isTrained(), false);
  // Retraining replaces the legacy file with 4-feature weights.
  for (const s of samples(repo)) collectSample(fakeProposals().find(p => p.issue_id === s.proposal_id), repo);
  assert.strictEqual(trainIfReady(repo), true);
  const re = loadClassifier(repo);
  assert(re.isTrained());
  assert.strictEqual(re.weights.w.length, 4);
});

test('legacy 5-feature samples are skipped in training', () => {
  const repo = target('legacy-samples');
  const old = samples(repo).map(s => ({ ...s, features: [...s.features.slice(0, 3), 1, s.features[3]] }));
  fs.mkdirSync(stateDirFor(repo), { recursive: true });
  fs.writeFileSync(path.join(stateDirFor(repo), 'rl-samples.json'), JSON.stringify(old));
  assert.strictEqual(trainIfReady(repo), false, 'only legacy rows -> nothing to train on');
});

test('samples from two runs on the same target both feed training; other targets do not', () => {
  const a = target('repo-a');
  const b = target('repo-b');
  const props = fakeProposals(24);
  for (const p of props.slice(0, 6)) collectSample(p, a);   // run 1
  assert.strictEqual(trainIfReady(a), false, 'run 1 alone is below MIN_TRAIN_SAMPLES');
  for (const p of props.slice(6, 12)) collectSample({ ...p }, a); // run 2
  for (const p of props.slice(0, 6)) collectSample(p, a);   // resumed run re-collects run 1: de-duped
  for (const p of props.slice(12, 20)) collectSample({ ...p, issue_id: 'b-' + p.issue_id }, b);
  assert.strictEqual(loadSamples(a).length, 12);
  assert.strictEqual(trainIfReady(a), true);
  assert.strictEqual(loadWeights(a).sample_count, 12);
  assert.strictEqual(loadWeights(a).target_repo, path.resolve(a));
  assert(fs.existsSync(weightsPath(a)));
  assert.strictEqual(trainIfReady(b), false, 'B has 8 samples; A\'s do not leak in');
  assert.strictEqual(loadClassifier(b).isTrained(), false);
  for (const p of props.slice(20, 24)) collectSample({ ...p, issue_id: 'b-' + p.issue_id }, b);
  assert.strictEqual(trainIfReady(b), true);
  assert.strictEqual(loadWeights(b).sample_count, 12);
});

// --- Synthetic negatives vs the analysis repro (§7.3 item 18) -------------

const PASSES = [
  ['function isEven(n) {\n  if (n % 2 === 0) { return true; }\n  return false;\n}', 'function isEven(n) {\n  return n % 2 === 0;\n}', 0.92, 0.1],
  ['function inc(x) {\n  const y = x + 1;\n  return y;\n}', 'function inc(x) {\n  return x + 1;\n}', 0.9, 0.2],
  ['function isNil(v) {\n  if (v === null || v === undefined) { return true; }\n  return false;\n}', 'function isNil(v) {\n  return v == null;\n}', 0.85, 0.3],
  ['function abs(x) {\n  if (x < 0) { return -x; }\n  return x;\n}', 'function abs(x) {\n  return x < 0 ? -x : x;\n}', 0.88, 0.2],
  ["function greet(name) {\n  const s = 'Hello, ' + name;\n  return s;\n}", "function greet(name) {\n  return 'Hello, ' + name;\n}", 0.8, 0.4],
  ['function max2(a, b) {\n  if (a > b) { return a; }\n  return b;\n}', 'function max2(a, b) {\n  return a > b ? a : b;\n}', 0.95, 0.1]
];
const FAILS = [
  ['function safeParse(s) {\n  try { return JSON.parse(s); } catch (e) { return null; }\n}', 'function safeParse(s) {\n  return JSON.parse(s);\n}', 0.6, 0.5],
  ['function half(n) {\n  if (n % 2 === 0) { return n / 2; }\n  return (n - 1) / 2;\n}', 'function half(n) {\n  return n >> 1;\n}', 0.55, 0.6]
];

function fixtureSet({ zeroRisk = false } = {}) {
  const repo = makeTempRepo();
  fs.writeFileSync(path.join(repo, 'lib.js'), [...PASSES, ...FAILS].map(r => r[0]).join('\n\n') + '\n');
  const mk = ([cur, prop, p, risk], i, passed) => {
    const proposal = makeProposal('lib.js', cur, prop, { risk: zeroRisk ? 0 : risk });
    proposal.issue_id = `${passed ? 'pass' : 'fail'}-${i}`;
    proposal.critic_verdict = { panel: [], p_preserves: p, preserves_semantics: true, agreement: {} };
    proposal.pattern_check_results = runChecks({ proposal, repoRoot: repo }).checks;
    proposal.test_outcome = { status: passed ? 'passed' : 'reverted' };
    return proposal;
  };
  const passes = PASSES.map((r, i) => mk(r, i, true));
  const fails = FAILS.map((r, i) => mk(r, i, false));
  return { repo, passes, fails, real: [...passes, ...fails].map(p => buildSample(p, repo)) };
}

// The pre-SG6 generator: every mutation, parent features copied with
// critic + 0.1 and pattern_score 0.5, no re-scoring.
function oldNegatives(p, repo) {
  return bugInjector.injectInto(p.proposed_code).map(m => ({
    proposal_id: `${p.issue_id}::${m.mutation}`, target_repo: repo, label: 0, synthetic: true, mutation: m.mutation,
    timestamp: new Date().toISOString(),
    features: [Math.min(0.99, p.critic_verdict.p_preserves + 0.1), 0.5, extractFeatures(p)[2], p.risk_estimate || 0.3]
  }));
}

function fit(set, weighted = true) {
  return trainGradientDescent(set.map(sampleToFeatures), set.map(sampleLabel),
    weighted ? { sampleWeights: set.map(sampleWeight) } : {});
}

for (const zeroRisk of [false, true]) {
  test(`re-scored synthetic negatives keep the p_preserves sign and add no positive risk weight (risk ${zeroRisk ? 'all 0, as in the analysis repro' : 'varied'})`, (t) => {
    const { repo, passes, fails, real } = fixtureSet({ zeroRisk });
    t.after(() => env.rm(repo));
    const P = FEATURE_NAMES.indexOf('p_preserves');
    const R = FEATURE_NAMES.indexOf('risk_estimate');

    const baseline = fit(real);
    assert(baseline.w[P] > 0, `baseline p_preserves weight ${baseline.w[P]}`);
    assert(baseline.w[R] <= 0, `baseline risk weight ${baseline.w[R]}`);

    // The repro: fabricated negatives (critic + 0.1, pattern 0.5) wash out the critic signal.
    const old = fit([...real, ...passes.flatMap(p => oldNegatives(p, repo))], false);
    assert(old.w[P] < baseline.w[P], `old pipeline p_preserves weight ${old.w[P]} vs baseline ${baseline.w[P]}`);

    const negatives = passes.flatMap(p => bugInjector.syntheticNegatives(p, repo));
    assert(negatives.length >= passes.length, `got ${negatives.length} negatives`);
    for (const n of negatives) {
      const parent = passes.find(p => n.proposal_id.startsWith(p.issue_id + '::'));
      assert.strictEqual(n.features[P], parent.critic_verdict.p_preserves, 'parent critic feature, not +0.1');
      assert.strictEqual(n.features[R], parent.risk_estimate);
      assert.strictEqual(n.synthetic, true);
    }
    assert(negatives.some(n => n.features[1] < 1), 'some mutants fail a real AST check');
    const next = fit([...real, ...negatives]);
    assert(Math.sign(next.w[P]) === Math.sign(baseline.w[P]), `new p_preserves weight ${next.w[P]} vs baseline ${baseline.w[P]}`);
    assert(next.w[R] <= 1e-9, `new risk weight ${next.w[R]} must not turn positive (baseline ${baseline.w[R]})`);

    // Same result through the persisted per-target store (negatives were persisted above).
    for (const p of [...passes, ...fails]) collectSample(p, repo);
    assert.strictEqual(loadSamples(repo).length, real.length + negatives.length);
    assert(trainIfReady(repo));
    const w = loadWeights(repo);
    assert.strictEqual(w.synthetic_count, negatives.length);
    assert(w.w[P] > 0 && w.w[R] <= 1e-9, JSON.stringify(w.w));
  });
}

// --- Calibrated gate --------------------------------------------------------

// Monotone but miscalibrated: combined_confidence in [0.5, 0.95) passes only
// 0% of the time, >= 0.95 always passes.
function miscalibrated(n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = 0.5 + (0.5 * i) / n;
    out.push({ issue_id: `cal-${i}`, combined_confidence: Number(x.toFixed(4)), test_outcome: { status: x >= 0.95 ? 'passed' : 'reverted' } });
  }
  return out;
}

test('gate uses calibrated p_pass when calibration is trained', () => {
  const repo = target('calibrated-gate');
  const proposal = { combined_confidence: 0.8, critic_verdict: { p_preserves: 0.9 }, pattern_check_results: [], risk_estimate: 0.1 };
  assert.strictEqual(loadClassifier(repo).gate(proposal).gated, false, 'nothing trained: unchanged behaviour (no gate)');
  assert.strictEqual(pCorrect({ ...proposal, test_outcome: { status: 'passed' } }, repo), 0.8, 'reward uses raw when uncalibrated');

  const res = calibration.fitFromProposals(miscalibrated(), repo);
  assert.strictEqual(res.trained, true);
  assert(fs.existsSync(calibration.modelPath(repo)));
  const gate = loadClassifier(repo).gate(proposal);
  assert.strictEqual(gate.gated, true);
  assert.strictEqual(gate.source, 'calibration');
  assert(gate.p_pass < RL_GATE_THRESHOLD, `calibrated p_pass ${gate.p_pass}`);
  assert.strictEqual(gate.rejected, true);
  assert(loadClassifier(repo).gate({ ...proposal, combined_confidence: 0.97 }).p_pass >= RL_GATE_THRESHOLD);
  // Reward reads the same calibration.
  const passed = { ...proposal, test_outcome: { status: 'passed' } };
  assert(pCorrect(passed, repo) < 0.1);
  assert(computeReward(passed, repo) < computeReward(passed));
  // Other targets are unaffected.
  assert.strictEqual(loadClassifier(target('calibrated-gate-other')).gate(proposal).gated, false);
});

test('gate takes the lower of classifier and calibrated p_pass', () => {
  const hi = { isTrained: () => true, predict: () => 0.9 };
  const lo = { isTrained: () => true, predict: () => 0.1 };
  const c = new Classifier(null, { calibrator: hi });
  assert.deepStrictEqual([c.gate({ combined_confidence: 0.6 }).source, c.gate({ combined_confidence: 0.6 }).p_pass], ['calibration', 0.9]);
  const trained = loadClassifier();
  assert(trained.isTrained());
  const both = new Classifier(trained.weights, { calibrator: lo });
  const g = both.gate({ combined_confidence: 0.6, critic_verdict: { p_preserves: 0.9 }, pattern_check_results: [] });
  assert.strictEqual(g.source, 'calibration');
  assert.strictEqual(g.p_pass, 0.1);
  assert.strictEqual(typeof g.classifier_p, 'number');
});

test('calibration accumulates executed proposals across runs per target', () => {
  const repo = target('calibration-runs');
  const all = miscalibrated(24);
  assert.strictEqual(calibration.fitFromProposals(all.slice(0, 12), repo).trained, false);
  const r = calibration.fitFromProposals([...all.slice(12), ...all.slice(0, 2)], repo);
  assert.strictEqual(r.trained, true);
  assert.strictEqual(r.n, 24, 'de-duplicated by proposal id');
  assert.strictEqual(calibration.loadPoints(repo).length, 24);
});

test('orchestrator gate rejects via calibration (processProposal, dry run)', async (t) => {
  const repo = makeTempRepo();
  t.after(() => { resetClient(); env.rm(repo); });
  const DOUBLE = 'function double(x) { return x * 2; }';
  const SAME = 'function double(x) { const r = x * 2; return r; }';
  const run = async () => {
    const session = freshSession(repo);
    const proposal = makeProposal('index.js', DOUBLE, SAME);
    session.proposals.push(proposal);
    installStub({ critic: [{ response: { edge_cases: [], hallucination_flags: [], reasoning: 'r', preserves_semantics: true, p_preserves: 0.9 } }] });
    await processProposal({ proposal, session, tracker: new TokenTracker(session), classifier: loadClassifier(repo), dryRun: true, absRepo: repo, allowRepair: false });
    return proposal;
  };
  const before = await run();
  assert.strictEqual(before.test_outcome.status, 'dry_run');
  assert(before.combined_confidence > 0.9);
  const cal = miscalibrated(24).map(p => ({ ...p, test_outcome: { status: p.combined_confidence >= 0.99 ? 'passed' : 'reverted' } }));
  cal.push({ issue_id: 'cal-top', combined_confidence: 1, test_outcome: { status: 'passed' } });
  assert(calibration.fitFromProposals(cal, repo).trained);
  const after = await run();
  assert.strictEqual(after.test_outcome.status, 'rl_rejected');
  assert(after.decision_trace.some(s => s.stage === 'rl' && /calibration/.test(s.reasoning)));
});
