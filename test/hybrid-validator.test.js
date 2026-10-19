'use strict';

const { rm } = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshSession } = require('../src/utils/checkpoint');
const { TokenTracker } = require('../src/utils/token-tracker');
const { runHybridValidator } = require('../src/validation/hybrid-validator');
const { runCritic, normalizeVerdict, aggregateJury } = require('../src/agents/critic');
const { processProposal } = require('../src/orchestrator');
const { assertJuryVerdict, assertVerdict, assertCheckResult, assertDiffTest, assertProposal } = require('../src/contracts');
const { makeTempRepo, makeProposal } = require('./helpers/factories');
const { installStub, resetClient } = require('./helpers/stub-client');

const DOUBLE = 'function double(x) { return x * 2; }';
const SAME = 'function double(x) { const r = x * 2; return r; }';
const base = { edge_cases: [], hallucination_flags: [], reasoning: 'r' };

function jury(raws) {
  const personas = ['strict', 'permissive', 'security'];
  return aggregateJury(raws.map((r, i) => normalizeVerdict({ ...base, ...r }, 'x', personas[i])), 'x');
}
const fixedCritic = (raws) => async () => jury(raws);
const APPROVE = [{ preserves_semantics: true, p_preserves: 0.9 }, { preserves_semantics: true, p_preserves: 0.9 }, { preserves_semantics: true, p_preserves: 0.9 }];

function setup(t) {
  const repo = makeTempRepo();
  const session = freshSession(repo);
  t.after(() => { resetClient(); rm(repo); });
  return { repo, session, tracker: new TokenTracker(session) };
}

const untrained = { isTrained: () => false };

async function viaPipeline({ repo, session, tracker }, proposal, critic, { dryRun = true } = {}) {
  installStub({ critic });
  session.proposals.push(proposal);
  await processProposal({ proposal, session, tracker, classifier: untrained, dryRun, absRepo: repo, allowRepair: false });
  assertProposal(proposal);
  return proposal;
}

// critic stub keyed by persona: (persona) => raw verdict
const perPersona = (fn) => ({ cacheTag }) => fn(cacheTag.replace(/^critic-/, '').replace(/-retry$/, ''));

test('combines jury p_preserves + ast + diff-test scores and asserts stage contracts', async (t) => {
  const { repo, tracker } = setup(t);
  const proposal = makeProposal('index.js', DOUBLE, SAME);
  const res = await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: fixedCritic(APPROVE) });
  assertJuryVerdict(proposal.critic_verdict);
  proposal.critic_verdict.panel.forEach(assertVerdict);
  proposal.pattern_check_results.forEach(assertCheckResult);
  assertDiffTest(proposal.diff_test);
  assert.strictEqual(proposal.diff_test.verdict, 'equivalent');
  assert.strictEqual(proposal.confidence_weights.diff_test, 0.2);
  assert.strictEqual(proposal.combined_confidence, Number((0.5 * 0.9 + 0.3 * res.ast.score + 0.2 * 1).toFixed(4)));
  assert.strictEqual(proposal.veto, null);
  const timed = proposal.decision_trace.filter(s => typeof s.duration_ms === 'number');
  assert(timed.length >= 2, 'critic and ast trace steps carry duration_ms');
});

test('a non-JuryVerdict critic output is rejected at the boundary', async (t) => {
  const { repo, tracker } = setup(t);
  const proposal = makeProposal('index.js', DOUBLE, SAME);
  const legacy = async () => ({ preserves_semantics: true, claude_confidence: 0.9, panel: [], agreement: {} });
  await assert.rejects(runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: legacy }), { name: 'ContractError' });
});

test('diff test sees the whole file, so helpers defined outside the edit resolve', async (t) => {
  const { repo, tracker } = setup(t);
  const cur = 'function f(x) { return sq(x) + 1; }';
  fs.writeFileSync(path.join(repo, 'h.js'), `function sq(x) { return x * x; }\n${cur}\nmodule.exports = { f };\n`);
  const proposal = makeProposal('h.js', cur, 'function f(x) { return 1 + sq(x); }');
  await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: fixedCritic(APPROVE) });
  assert.strictEqual(proposal.diff_test.mode, 'file');
  assert.strictEqual(proposal.diff_test.verdict, 'equivalent');
});

test('one {false, 0.1} persona lowers combined below a {true, 0.9} persona', async (t) => {
  const { repo, tracker } = setup(t);
  const run = async (third) => {
    const proposal = makeProposal('index.js', DOUBLE, SAME);
    await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: fixedCritic([APPROVE[0], APPROVE[1], third]) });
    return proposal.combined_confidence;
  };
  const hi = await run({ preserves_semantics: true, p_preserves: 0.9 });
  const lo = await run({ preserves_semantics: false, p_preserves: 0.1 });
  assert(lo < hi, `${lo} < ${hi}`);
  assert(Math.abs((hi - lo) - 0.5 * (0.8 / 3)) < 1e-3, 'difference is w_c * (0.9 - 0.1) / 3');
});

test('veto: divergent diff test -> vetoed via processProposal', async (t) => {
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, 'function double(x) { return x * 3; }'),
    [{ response: { ...base, preserves_semantics: true, p_preserves: 0.95 } }], { dryRun: false });
  assert.strictEqual(p.diff_test.verdict, 'divergent');
  assert(p.combined_confidence >= 0.5, 'score alone would pass');
  assert.strictEqual(p.test_outcome.status, 'vetoed');
  assert(p.test_outcome.reasons.some(r => r.startsWith('diff_test_divergent')));
  assert.strictEqual(fs.readFileSync(path.join(ctx.repo, 'index.js'), 'utf8').includes('x * 2'), true, 'executor never ran');
  assert(p.decision_trace.some(s => s.outcome === 'vetoed'));
  assert(!p.decision_trace.some(s => s.stage === 'executor' || s.stage === 'rl'));
});

test('veto: proposed source that does not parse -> vetoed via processProposal', async (t) => {
  const ctx = setup(t);
  const cur = 'export function inc(x: number): number { return x + 1; }';
  fs.writeFileSync(path.join(ctx.repo, 'inc.ts'), cur + '\n');
  const p = await viaPipeline(ctx, makeProposal('inc.ts', cur, 'export function inc(x: number): number { return x + ; }'),
    [{ response: { ...base, preserves_semantics: true, p_preserves: 0.95 } }]);
  assert.strictEqual(p.diff_test.applicable, false);
  assert.strictEqual(p.test_outcome.status, 'vetoed');
  assert(p.test_outcome.reasons.some(r => r.startsWith('check_veto(parse)')), p.test_outcome.reasons.join('|'));
});

test('veto: unanimous reject with high stated confidence -> vetoed via processProposal', async (t) => {
  for (const raw of [
    { preserves_semantics: false, p_preserves: 0.95 },       // inconsistent new schema, capped at 0.5
    { preserves_semantics: false, claude_confidence: 0.95 }  // legacy schema, mapped to 0.05
  ]) {
    const ctx = setup(t);
    const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME),
      [{ response: { ...base, ...raw } }]);
    assert.strictEqual(p.diff_test.verdict, 'equivalent');
    assert(p.critic_verdict.p_preserves <= 0.5);
    assert.strictEqual(p.test_outcome.status, 'vetoed', JSON.stringify(raw));
    assert(p.test_outcome.reasons.some(r => r.startsWith('unanimous_reject')));
  }
});

test('mixed panel with low p_preserves is critic_rejected, not vetoed', async (t) => {
  const ctx = setup(t);
  const cur = 'export function inc(x: number): number { return x + 1; }';
  fs.writeFileSync(path.join(ctx.repo, 'inc.ts'), cur + '\n');
  const p = await viaPipeline(ctx, makeProposal('inc.ts', cur, 'export function inc(x: number): number { return 1 + x; }'),
    perPersona(persona => persona === 'permissive'
      ? { ...base, preserves_semantics: true, p_preserves: 0.45 }
      : { ...base, preserves_semantics: false, p_preserves: 0 }));
  assert.strictEqual(p.veto, null);
  assert(p.combined_confidence < 0.5);
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
});

test('2 rejects + 1 approve (0/0/0.55) is critic_rejected despite clean AST and equivalent diff test', async (t) => {
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME),
    perPersona(persona => persona === 'permissive'
      ? { ...base, preserves_semantics: true, p_preserves: 0.55 }
      : { ...base, preserves_semantics: false, p_preserves: 0 }));
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert(p.pattern_check_results.every(c => c.passed));
  assert(p.combined_confidence >= 0.5, 'score alone would pass');
  assert.strictEqual(p.veto, null);
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /critic jury does not approve/);
});

test('majority approve with jury p_preserves below 0.5 is critic_rejected', async (t) => {
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME),
    perPersona(persona => persona === 'security'
      ? { ...base, preserves_semantics: false, p_preserves: 0 }
      : { ...base, preserves_semantics: true, p_preserves: 0.6 }));
  assert.strictEqual(p.critic_verdict.preserves_semantics, true);
  assert(p.critic_verdict.p_preserves < 0.5);
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
});

test('clean 3-approve panel passes the gate', async (t) => {
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME),
    perPersona(() => ({ ...base, preserves_semantics: true, p_preserves: 0.8 })));
  assert.strictEqual(p.critic_verdict.agreement.unanimous, true);
  assert.strictEqual(p.test_outcome.status, 'dry_run');
});

test('all-malformed panel (critic unavailable) is vetoed even when AST + diff test pass', async (t) => {
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME), 'not json');
  assert.strictEqual(p.critic_verdict.p_preserves, 0);
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert.strictEqual(p.test_outcome.status, 'vetoed');
  assert(p.test_outcome.reasons.some(r => r.startsWith('unanimous_reject')));
});

test('clean proposal passes the gate and every trace step carries trace_id = run_id', async (t) => {
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME),
    [{ response: { ...base, preserves_semantics: true, p_preserves: 0.9 } }]);
  assert.strictEqual(p.veto, null);
  assert.strictEqual(p.test_outcome.status, 'dry_run');
  assert(p.decision_trace.length >= 4);
  for (const s of p.decision_trace) assert.strictEqual(s.otel.trace_id, ctx.session.run_id, s.stage);
});

test('runCritic output feeds runHybridValidator end to end through the stub client', async (t) => {
  const { repo, tracker } = setup(t);
  installStub({ critic: [{ response: { ...base, preserves_semantics: true, p_preserves: 0.8 } }] });
  const proposal = makeProposal('index.js', DOUBLE, SAME);
  await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic });
  assert.strictEqual(proposal.critic_verdict.p_preserves, 0.8);
  assert.strictEqual(proposal.critic_verdict.panel.length, 3);
});
