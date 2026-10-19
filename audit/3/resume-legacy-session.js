'use strict';

// AUDIT-3: `--resume` on a session.json written before SG1/SG5 (commit
// a5baaeb shapes: jury = closest-to-mean persona spread with
// claude_confidence = confidence in the stated verdict, agreement.std_confidence /
// unanimous_approval, status 'applied_no_tests', uuid issue_ids, no worktree).
// Checks that resume does not crash, and how legacy fields are interpreted.
//
//   node audit/3/resume-legacy-session.js

const { env, gitInit, noTestCtx, quiet, report, exitCode } = require('./lib');
const fs = require('fs');
const { runPipeline } = require('../../src/orchestrator');
const { saveSession, freshSession } = require('../../src/utils/checkpoint');
const calibration = require('../../src/rl/calibration');
const { renderHtml } = require('../../src/interpretability/dashboard');
const { normalizeVerdict } = require('../../src/agents/critic');
const { installStub, resetClient, loadFixtureResponses } = require('../../test/helpers/stub-client');

const legacyVerdict = (pres, conf) => ({
  proposal_id: 'x', preserves_semantics: pres, claude_confidence: conf, edge_cases: [], hallucination_flags: [], reasoning: 'legacy',
  panel: [{ persona: 'strict', preserves_semantics: pres, claude_confidence: conf, edge_cases: [], hallucination_flags: [], reasoning: 'legacy' }],
  agreement: { mean_confidence: conf, std_confidence: 0, unanimous_approval: true, approval_rate: pres ? 1 : 0, verbal_entropy: 0 }
});
const legacyProposal = (id, status, pres, conf, combined) => ({
  issue_id: id, file: 'src/math.js', current_code: 'function x() {}', proposed_code: 'function x() { }', reasoning: 'old',
  risk_estimate: 0.3, critic_verdict: legacyVerdict(pres, conf), pattern_check_results: [], combined_confidence: combined,
  test_outcome: { status }, decision_trace: [{ stage: 'critic', timestamp: new Date().toISOString(), reasoning: 'old', confidence: conf, outcome: 'x' }]
});

(async () => {
  const repo = gitInit(env.copyFixture('js-basic'));
  const old = freshSession(repo);
  delete old.worktree;
  // "critic 90% sure this CHANGES behaviour", executed under the old gate and reverted.
  old.proposals.push(legacyProposal('7f1c2a9e-0000-4000-8000-000000000001', 'reverted', false, 0.9, 0.62));
  old.proposals.push(legacyProposal('7f1c2a9e-0000-4000-8000-000000000002', 'applied_no_tests', true, 0.8, 0.8));
  // A pending proposal from the old analyzer (uuid id, no diff_test key).
  const fx = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../../test/fixtures/js-basic/proposals.json'), 'utf8'))[0];
  old.proposals.push({ issue_id: '7f1c2a9e-0000-4000-8000-000000000003', file: fx.file, current_code: fx.current_code, proposed_code: fx.proposed_code,
    reasoning: fx.reasoning, risk_estimate: fx.risk_estimate, critic_verdict: null, pattern_check_results: [], combined_confidence: null, test_outcome: null, decision_trace: [] });
  saveSession(old);

  installStub(loadFixtureResponses('js-basic'));
  let s, crash = null;
  try { s = await quiet(() => noTestCtx(() => runPipeline({ repo, resume: true, cache: 'off' }))); } catch (e) { crash = e; }
  resetClient();
  report('resume of a pre-SG1/SG5 session completes', !crash, crash ? crash.stack.split('\n').slice(0, 2).join(' | ') : `statuses: ${s.proposals.map(p => p.test_outcome.status).join(', ')}`, 'no crash');
  if (crash) process.exit(exitCode());

  const pts = calibration.loadPoints(repo);
  const legacyPts = pts.filter(p => /^7f1c2a9e-.*000[12]$/.test(p.proposal_id));
  report('L-legacy-1 legacy combined_confidence (old closest-persona formula) is merged into the per-target calibration set',
    legacyPts.length === 0,
    `calibration-points.json: ${pts.length} points, ${legacyPts.length} from the legacy session (${legacyPts.map(p => `x=${p.x}`).join(', ')})`,
    'points tagged with the formula/run that produced them, or legacy proposals skipped');

  const html = renderHtml(s);
  const row = html.split('data-toggle="details-7f1c2a9e-0000-4000-8000-000000000001">')[1].split('</tr>')[0];
  const criticCol = [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1])[3]; // #, file, risk, critic
  const mapped = normalizeVerdict(old.proposals[0].critic_verdict.panel[0], 'x', 'strict').p_preserves;
  report('L-legacy-2 dashboard shows legacy claude_confidence as p_preserves without the critic.js reject mapping',
    Number(criticCol) === Number(mapped.toFixed(2)),
    `legacy reject with claude_confidence=0.9: dashboard "critic" column ${criticCol}; critic.normalizeVerdict maps it to p_preserves=${mapped}`,
    'one legacy mapping (critic.normalizeVerdict) used by dashboard.criticConfidence as well');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
