'use strict';

// AUDIT-3: the dashboard's "What-if · RL gate" panel and src/rl/counterfactual.js
// model only the classifier, but the gate is min(classifier, calibrated
// combined_confidence) (CLAUDE.md "Learned gate"). counterfactual.js has no
// caller at all, although README says the dashboard's what-if sliders use it.
//
//   node audit/3/whatif-vs-gate.js

const { makeRepo, quiet, report, exitCode } = require('./lib');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { saveWeights, loadClassifier, RL_GATE_THRESHOLD } = require('../../src/rl/classifier');
const calibration = require('../../src/rl/calibration');
const { FEATURE_NAMES, extractFeatures } = require('../../src/rl/features');
const { counterfactuals } = require('../../src/rl/counterfactual');
const { renderHtml } = require('../../src/interpretability/dashboard');
const { processProposal } = require('../../src/orchestrator');
const { freshSession } = require('../../src/utils/checkpoint');
const { TokenTracker } = require('../../src/utils/token-tracker');
const { installStub, resetClient } = require('../../test/helpers/stub-client');
const { makeProposal } = require('../../test/helpers/factories');

(async () => {
  const SRC = 'function add(a, b) {\n  const result = a + b;\n  return result;\n}\nmodule.exports = { add };\n';
  const repo = makeRepo({ 'src/math.js': SRC }, { pkg: { name: 'x', version: '0.0.0' } });

  // A trained classifier that is optimistic (p ~ 0.88 everywhere) ...
  saveWeights({ w: [0, 0, 0, 0], b: 2, means: [0, 0, 0, 0], stds: [1, 1, 1, 1], feature_names: FEATURE_NAMES.slice() }, repo);
  // ... and a calibration that says high combined_confidence rarely passes.
  const xs = Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.025);
  calibration.save(calibration.fitIsotonic(xs, xs.map((_, i) => (i === 0 ? 1 : 0))), repo);

  installStub({ critic: { preserves_semantics: true, p_preserves: 0.95, edge_cases: [], hallucination_flags: [], reasoning: 'ok' } });
  const session = freshSession(repo);
  const p = makeProposal('src/math.js', 'function add(a, b) {\n  const result = a + b;\n  return result;\n}', 'function add(a, b) {\n  return a + b;\n}');
  session.proposals.push(p);
  await quiet(() => processProposal({ proposal: p, session, tracker: new TokenTracker(session), classifier: loadClassifier(repo), dryRun: true, absRepo: repo, allowRepair: false }));
  resetClient();
  const gate = loadClassifier(repo).gate(p);

  // The dashboard's in-page what-if function, evaluated on the same features
  // with the weights /rl-weights.json would serve.
  const html = renderHtml(session);
  const fnSrc = html.match(/function sigmoid[\s\S]*?(?=function wireWhatIf)/)[0];
  const predictPpass = new Function(`${fnSrc}; return predictPpass;`)();
  const weights = JSON.parse(fs.readFileSync(path.join(require('../../src/utils/checkpoint').stateDirFor(repo), 'rl-weights.json'), 'utf8'));
  const whatIf = predictPpass(weights, extractFeatures(p));
  const cf = counterfactuals(p, RL_GATE_THRESHOLD, repo);

  console.log(`gate: classifier_p=${gate.classifier_p.toFixed(3)} calibrated_p=${gate.calibrated_p.toFixed(3)} -> p_pass=${gate.p_pass.toFixed(3)} (${gate.source}); proposal status=${p.test_outcome.status}`);
  console.log(`dashboard what-if for the same features: ${whatIf.toFixed(3)} (${whatIf >= RL_GATE_THRESHOLD ? 'green = would pass' : 'red'})`);
  console.log(`counterfactual.counterfactuals: ${JSON.stringify(cf.map(c => ({ f: c.feature, req: c.required_value })))}`);

  report('M-whatif-1 what-if panel disagrees with the gate it is labelled as',
    (whatIf >= RL_GATE_THRESHOLD) === (gate.p_pass >= RL_GATE_THRESHOLD),
    `status=${p.test_outcome.status} (gate p_pass=${gate.p_pass.toFixed(3)} from ${gate.source}) but "What-if · RL gate" shows p_pass=${whatIf.toFixed(3)} in green; counterfactuals() only models the classifier term`,
    'what-if and counterfactuals apply min(classifier, calibrated(combined)) like Classifier.gate, or are labelled "classifier term only"');

  const root = path.resolve(__dirname, '../..');
  const callers = execFileSync('grep', ['-rln', 'counterfactual', 'src', 'bench'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(f => f !== 'src/rl/counterfactual.js' && f);
  report('L-whatif-2 src/rl/counterfactual.js has no caller (README: "used by the dashboard\'s what-if sliders")',
    callers.length > 0, `files referencing it outside itself: ${callers.join(', ') || 'none'}`, 'dashboard/server use attribute()/counterfactuals(), or README updated');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
