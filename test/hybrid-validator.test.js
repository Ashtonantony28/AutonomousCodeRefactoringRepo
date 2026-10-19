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
const { processProposal, criticGate } = require('../src/orchestrator');
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

const untrained = new (require('../src/rl/classifier').Classifier)(null);

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

// SG9: fail-closed gate.
const APPROVE_RAW = { ...base, preserves_semantics: true, p_preserves: 0.9 };

test('a proposal failing all four anti-pattern checks is vetoed despite a unanimous approve', async (t) => {
  const ctx = setup(t);
  const cur = "function load(p, opts) {\n  try {\n    return fs.readFileSync(p, opts.encoding || 'utf8');\n  } catch (e) {\n    return null;\n  }\n}";
  const prop = "function load(p) {\n  const axios = require('axios');\n  if (p) {\n    axios.get(p);\n  }\n}";
  fs.mkdirSync(path.join(ctx.repo, 'src'));
  fs.writeFileSync(path.join(ctx.repo, 'src/loader.js'), `'use strict';\nconst fs = require('fs');\n${cur}\nmodule.exports = { load };\n`);
  fs.writeFileSync(path.join(ctx.repo, 'src/app.js'), "const { load } = require('./loader');\nmodule.exports = () => load('cfg.json', { encoding: 'utf8' });\n");
  const p = await viaPipeline(ctx, makeProposal('src/loader.js', cur, prop), APPROVE_RAW);
  assert.strictEqual(p.test_outcome.status, 'vetoed');
  for (const name of ['signature_drift', 'error_handling_removal', 'new_dependency', 'return_type_change']) {
    assert(p.veto.reasons.some(r => r.startsWith(`check_veto(${name})`)), `${name}: ${p.veto.reasons.join(' | ')}`);
  }
});

test('inconclusive diff test that ran inputs blocks even a unanimous approve (corpus M24)', async (t) => {
  const ctx = setup(t);
  const cur = 'function ext(p) {\n  return path.extname(p);\n}';
  fs.writeFileSync(path.join(ctx.repo, 'ext.js'), `'use strict';\nconst path = require('path');\n${cur}\nmodule.exports = { ext };\n`);
  const p = await viaPipeline(ctx, makeProposal('ext.js', cur, 'function ext(p) {\n  return path.basename(p);\n}'), APPROVE_RAW);
  assert.strictEqual(p.diff_test.verdict, 'inconclusive');
  assert(p.diff_test.runs > 0);
  assert.strictEqual(p.confidence_weights.diff_test, undefined, 'no diff-test weight without a verdict');
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /could not confirm equivalence/);
});

test('inapplicable diff test (non-JS) proceeds only with a unanimous approve and all checks passing', async (t) => {
  const ctx = setup(t);
  const cur = 'def add(a, b):\n    result = a + b\n    return result';
  fs.writeFileSync(path.join(ctx.repo, 'm.py'), `${cur}\n`);
  const prop = 'def add(a, b):\n    return a + b';
  const split = await viaPipeline(ctx, makeProposal('m.py', cur, prop),
    perPersona(persona => persona === 'security' ? { ...base, preserves_semantics: false, p_preserves: 0.6 } : APPROVE_RAW));
  assert.strictEqual(split.diff_test.applicable, false);
  assert(split.combined_confidence >= 0.5);
  assert.strictEqual(split.test_outcome.status, 'critic_rejected');
  assert.match(split.test_outcome.reason, /2\/3 approve \(need unanimous\)/);
  const unanimous = await viaPipeline(ctx, makeProposal('m.py', cur, prop), APPROVE_RAW);
  assert.strictEqual(unanimous.test_outcome.status, 'dry_run');
});

test('fusion and gate use only JuryVerdict / DiffTest contract fields', async (t) => {
  const { repo, tracker } = setup(t);
  const diffTesting = require('../src/validation/diff-testing');
  const realRun = diffTesting.run;
  diffTesting.run = (args) => {
    const d = realRun(args);
    return { applicable: d.applicable, verdict: d.verdict, runs: d.runs, duration_ms: d.duration_ms };
  };
  t.after(() => { diffTesting.run = realRun; });
  const strip = (j) => ({ panel: j.panel, p_preserves: j.p_preserves, agreement: j.agreement });
  const proposal = makeProposal('index.js', DOUBLE, SAME);
  const res = await runHybridValidator({ proposal, tracker, repoRoot: repo, runCritic: async () => strip(jury(APPROVE)) });
  assert.strictEqual(proposal.diff_test.verdict, 'equivalent');
  assert.strictEqual(proposal.combined_confidence, Number((0.5 * 0.9 + 0.3 * res.ast.score + 0.2).toFixed(4)));
  assert.strictEqual(criticGate(proposal), null);
});

test('criticGate derives majority and unanimity from panel[]', () => {
  const checks = [{ check_name: 'parse', passed: true, detail: '', severity: 'score' }];
  const inapplicable = { applicable: false, verdict: 'inconclusive', runs: 0, reason: 'non-JS file', duration_ms: 0 };
  const mk = (raws, extra = {}) => ({ critic_verdict: { ...jury(raws), preserves_semantics: true }, pattern_check_results: checks, diff_test: inapplicable, combined_confidence: 0.9, ...extra });
  const split = [APPROVE[0], APPROVE[1], { preserves_semantics: false, p_preserves: 0.9 }];
  assert.match(criticGate(mk(split)), /2\/3 approve/);
  assert.strictEqual(criticGate(mk(APPROVE)), null);
  assert.match(criticGate(mk(APPROVE, { pattern_check_results: [{ ...checks[0], passed: false }] })), /failed checks: parse/);
  assert.match(criticGate(mk(APPROVE, { combined_confidence: 0.4 })), /combined_confidence/);
  const rejects = [{ preserves_semantics: false, p_preserves: 0.9 }, { preserves_semantics: false, p_preserves: 0.9 }, APPROVE[0]];
  assert.match(criticGate({ ...mk(rejects), critic_verdict: { ...jury(rejects), preserves_semantics: true } }), /does not approve/);
});

// ---------- SG14: commit bar ----------

// The sandbox's console is a no-op, so the diff test sees this behaviour change
// as `equivalent`; only the jury can stop it.
const LOG_CUR = "function audit(user) {\n  console.log('audit', user);\n  return String(user).length;\n}";
const LOG_PROP = "function audit(user) {\n  console.log('audit:', user);\n  return String(user).length;\n}";

function logRepo(ctx) {
  fs.writeFileSync(path.join(ctx.repo, 'audit.js'), `'use strict';\n${LOG_CUR}\nmodule.exports = { audit };\n`);
}

test('a 2/3 jury is critic_rejected even when the diff test says equivalent (AUDIT-5 C1)', async (t) => {
  const ctx = setup(t);
  logRepo(ctx);
  const p = await viaPipeline(ctx, makeProposal('audit.js', LOG_CUR, LOG_PROP),
    perPersona(persona => persona === 'strict' ? { ...base, preserves_semantics: false, p_preserves: 0.2 } : APPROVE_RAW));
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert(p.combined_confidence >= 0.5);
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /2\/3 approve \(need unanimous\)/);
});

test('an approving persona listing a behaviour-changing edge case blocks the edit (AUDIT-5 M2 K2)', async (t) => {
  const ctx = setup(t);
  logRepo(ctx);
  const p = await viaPipeline(ctx, makeProposal('audit.js', LOG_CUR, LOG_PROP),
    perPersona(persona => persona === 'security' ? { ...APPROVE_RAW, edge_cases: ["every call logs 'audit:' instead of 'audit'"] } : APPROVE_RAW));
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /edge cases: security: every call logs 'audit:'/);
});

test('criticGate: a persona below the p_preserves floor blocks a unanimous approve', () => {
  const { MIN_PERSONA_P } = require('../src/orchestrator');
  assert.strictEqual(MIN_PERSONA_P, 0.2);
  const raws = [APPROVE[0], APPROVE[1], { preserves_semantics: true, p_preserves: 0.15 }];
  const dt = { applicable: true, verdict: 'equivalent', runs: 40, duration_ms: 1 };
  const checks = [{ check_name: 'parse', passed: true, detail: '', severity: 'score' }];
  const p = { file: 'a.js', critic_verdict: jury(raws), pattern_check_results: checks, diff_test: dt, combined_confidence: 0.8 };
  assert.match(criticGate(p), /below 0\.2: security=0\.15/);
  assert.strictEqual(criticGate({ ...p, critic_verdict: jury(APPROVE) }), null);
});

test('a JS edit the diff test cannot run (runs=0) is critic_rejected despite a unanimous approve and clean AST (AUDIT-5 C3/E6)', async (t) => {
  const ctx = setup(t);
  const cur = 'module.exports = function (a, b) {\n  return a - b;\n};';
  // Reading `process` at load keeps the sandbox from loading the module (runs=0).
  fs.writeFileSync(path.join(ctx.repo, 'sub.js'), `'use strict';\nconst VERBOSE = Boolean(process.env.SUB_VERBOSE);\n${cur}\n`);
  const p = await viaPipeline(ctx, makeProposal('sub.js', cur, 'module.exports = function (a, b) {\n  return Math.abs(a - b);\n};'), APPROVE_RAW);
  assert.strictEqual(p.diff_test.runs, 0);
  assert(p.pattern_check_results.every(c => c.passed));
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /ran no input on a JS edit/);
});

test('Python: a removed raise guard is vetoed by the lexical checks despite a unanimous approve (AUDIT-5 C3/E8)', async (t) => {
  const ctx = setup(t);
  const cur = 'def safe(p):\n    if ".." in p:\n        raise ValueError("bad path")\n    return os.path.join(ROOT, p)\n';
  fs.writeFileSync(path.join(ctx.repo, 'paths.py'), `import os\nROOT = "/srv"\n\n\n${cur}`);
  const p = await viaPipeline(ctx, makeProposal('paths.py', cur, 'def safe(p):\n    return os.path.join(ROOT, p)\n'), APPROVE_RAW);
  assert.strictEqual(p.test_outcome.status, 'vetoed');
  const failed = p.pattern_check_results.filter(c => !c.passed).map(c => c.check_name).sort();
  assert.deepStrictEqual(failed, ['condition_change', 'guard_removal']);
  assert(p.test_outcome.reasons.some(r => /check_veto\(guard_removal\)/.test(r)));
});

test('the critic prompt defines edge_cases as behaviour differences', () => {
  const { systemPromptFor, PERSONAS } = require('../src/agents/critic');
  assert.match(systemPromptFor(PERSONAS.strict), /edge_cases lists only inputs or situations on which proposed_code behaves\ndifferently/);
});
