'use strict';

// AUDIT-3 H1: the gate and the score fusion read fields that are NOT in the
// JuryVerdict / DiffTest contracts (legacy aliases). A producer that emits
// exactly the contract shape passes every contract assert but flips a clean,
// approved proposal to critic_rejected.
//
//   node audit/3/legacy-alias-dependence.js

const { makeRepo, quiet, report, exitCode } = require('./lib');
const C = require('../../src/contracts');

// Strip to the documented contract fields, before the orchestrator binds them.
let mode = 'as-is';
const critic = require('../../src/agents/critic');
const realCritic = critic.runCritic;
critic.runCritic = async (args) => {
  const j = await realCritic(args);
  if (mode !== 'contract-jury') return j;
  return { panel: j.panel, p_preserves: j.p_preserves, agreement: j.agreement };
};
const dt = require('../../src/validation/diff-testing');
const realRun = dt.run;
dt.run = (args) => {
  const d = realRun(args);
  if (mode !== 'contract-difftest') return d;
  const out = { applicable: d.applicable, verdict: d.verdict, runs: d.runs, duration_ms: d.duration_ms };
  if (d.counterexample !== undefined) out.counterexample = d.counterexample;
  if (d.reason !== undefined) out.reason = d.reason;
  return out;
};

const { processProposal } = require('../../src/orchestrator');
const { freshSession } = require('../../src/utils/checkpoint');
const { TokenTracker } = require('../../src/utils/token-tracker');
const { Classifier } = require('../../src/rl/classifier');
const { installStub, resetClient } = require('../../test/helpers/stub-client');
const { makeProposal } = require('../../test/helpers/factories');

const SRC = 'function add(a, b) {\n  const result = a + b;\n  return result;\n}\nmodule.exports = { add };\n';
const CUR = 'function add(a, b) {\n  const result = a + b;\n  return result;\n}';
const PROP = 'function add(a, b) {\n  return a + b;\n}';

async function run(m) {
  mode = m;
  const repo = makeRepo({ 'src/math.js': SRC }, { pkg: { name: 'x', version: '0.0.0' } });
  installStub({ critic: { preserves_semantics: true, p_preserves: 0.95, edge_cases: [], hallucination_flags: [], reasoning: 'inlines a temporary' } });
  const session = freshSession(repo);
  const p = makeProposal('src/math.js', CUR, PROP);
  session.proposals.push(p);
  await quiet(() => processProposal({ proposal: p, session, tracker: new TokenTracker(session), classifier: new Classifier(null), dryRun: true, absRepo: repo, allowRepair: false }));
  resetClient();
  let juryOk = true, dtOk = true;
  try { C.assertJuryVerdict(p.critic_verdict); } catch { juryOk = false; }
  try { C.assertDiffTest(p.diff_test); } catch { dtOk = false; }
  return { status: p.test_outcome.status, reason: p.test_outcome.reason || '', combined: p.combined_confidence, juryOk, dtOk };
}

(async () => {
  const base = await run('as-is');
  console.log(`baseline (real producers): status=${base.status} combined=${base.combined}`);
  const j = await run('contract-jury');
  report('H1a gate reads jury.preserves_semantics (not in JuryVerdict contract)',
    j.status === base.status,
    `contract-valid JuryVerdict (assertJuryVerdict ok=${j.juryOk}, panel 3/3 approve, p_preserves=0.95) -> status=${j.status}: ${j.reason}`,
    `status=${base.status}: the gate should derive the majority from panel[] (contract) or the contract should list preserves_semantics`);
  const d = await run('contract-difftest');
  report('H1b fusion reads diff_test.score (not in DiffTest contract)',
    d.status === base.status,
    `contract-valid DiffTest (assertDiffTest ok=${d.dtOk}, verdict=equivalent) -> combined_confidence=${d.combined} status=${d.status}`,
    `combined=${base.combined}, status=${base.status}: score should be derived from verdict, or score added to the contract`);
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
