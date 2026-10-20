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

test('inapplicable diff test (no oracle for the language) proceeds only with a unanimous approve and all checks passing', async (t) => {
  const ctx = setup(t);
  const cur = 'func add(a int, b int) int {\n\tresult := a + b\n\treturn result\n}';
  fs.writeFileSync(path.join(ctx.repo, 'm.go'), `package m\n\n${cur}\n`);
  const prop = 'func add(a int, b int) int {\n\treturn a + b\n}';
  const split = await viaPipeline(ctx, makeProposal('m.go', cur, prop),
    perPersona(persona => persona === 'security' ? { ...base, preserves_semantics: false, p_preserves: 0.6 } : APPROVE_RAW));
  assert.strictEqual(split.diff_test.applicable, false);
  assert(split.combined_confidence >= 0.5);
  assert.strictEqual(split.test_outcome.status, 'critic_rejected');
  assert.match(split.test_outcome.reason, /2\/3 approve \(need unanimous\)/);
  const unanimous = await viaPipeline(ctx, makeProposal('m.go', cur, prop), APPROVE_RAW);
  assert.strictEqual(unanimous.test_outcome.status, 'dry_run');
});

// ---------- SG19: Python diff test in the gate ----------

test('Python edits get the diff test: equivalent proceeds, divergent is vetoed', async (t) => {
  const ctx = setup(t);
  const cur = 'def add(a, b):\n    result = a + b\n    return result';
  fs.writeFileSync(path.join(ctx.repo, 'm.py'), `${cur}\n`);
  const same = await viaPipeline(ctx, makeProposal('m.py', cur, 'def add(a, b):\n    return a + b'), APPROVE_RAW);
  assert.strictEqual(same.diff_test.verdict, 'equivalent');
  assert(same.diff_test.runs >= 10);
  assert.strictEqual(same.confidence_weights.diff_test, 0.2);
  assert.strictEqual(same.test_outcome.status, 'dry_run');
  const changed = await viaPipeline(ctx, makeProposal('m.py', cur, 'def add(a, b):\n    return a - b'), APPROVE_RAW);
  assert.strictEqual(changed.diff_test.verdict, 'divergent');
  assert.strictEqual(changed.test_outcome.status, 'vetoed');
  assert.match(changed.veto.reasons.join(' '), /diff_test_divergent: add/);
});

test('a Python edit the diff test runs no input on is rejected like JS (runs=0)', async (t) => {
  const ctx = setup(t);
  const cur = 'if True:\n    LIMIT = 3';
  fs.writeFileSync(path.join(ctx.repo, 'cfg.py'), `${cur}\n`);
  const p = await viaPipeline(ctx, makeProposal('cfg.py', cur, 'if True:\n    LIMIT = 4'), APPROVE_RAW);
  assert.strictEqual(p.diff_test.runs, 0);
  assert.notStrictEqual(p.diff_test.verdict, 'equivalent');
  assert.notStrictEqual(p.test_outcome.status, 'dry_run');
});

test('Python condition_change does not veto a reworded comparison the diff test shows equivalent', async (t) => {
  const ctx = setup(t);
  const cur = 'def between(x):\n    return x > 0 and x < 10';
  fs.writeFileSync(path.join(ctx.repo, 'r.py'), `${cur}\n`);
  const p = await viaPipeline(ctx, makeProposal('r.py', cur, 'def between(x):\n    return 0 < x < 10'), APPROVE_RAW);
  const cc = p.pattern_check_results.find(c => c.check_name === 'condition_change');
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert.strictEqual(cc.passed, false);
  assert.strictEqual(cc.severity, 'score');
  assert.match(cc.detail, /diff test is equivalent/);
  assert.strictEqual(p.veto, null);
  assert.strictEqual(p.test_outcome.status, 'dry_run');
  // guard_removal keeps its veto even when the diff test says equivalent.
  const g = 'def sign(n):\n    if n < 0:\n        return "neg"\n    else:\n        return "pos"';
  fs.writeFileSync(path.join(ctx.repo, 's.py'), `${g}\n`);
  const q = await viaPipeline(ctx, makeProposal('s.py', g, 'def sign(n):\n    return "neg" if n < 0 else "pos"'), APPROVE_RAW);
  assert.strictEqual(q.diff_test.verdict, 'equivalent');
  assert.strictEqual(q.test_outcome.status, 'vetoed');
  assert.match(q.veto.reasons.join(' '), /guard_removal/);
});

test('Python condition_change stays a veto when part of a condition is deleted, even on an equivalent diff test (AUDIT-13 L1, U01)', async (t) => {
  const ctx = setup(t);
  const cur = 'def needs_bigint(n):\n    return 2 ** 53 < n <= 2 ** 64';
  fs.writeFileSync(path.join(ctx.repo, 'b.py'), `${cur}\n`);
  const p = await viaPipeline(ctx, makeProposal('b.py', cur, 'def needs_bigint(n):\n    return 2 ** 53 < n'), APPROVE_RAW);
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert.strictEqual(p.test_outcome.status, 'vetoed');
  assert.match(p.veto.reasons.join(' '), /condition_change/);
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

// The diff test never generates strings past 5000 characters, so it sees
// this behaviour change as `equivalent`; only the jury can stop it.
const CUT_CUR = 'function body(s) {\n  return String(s);\n}';
const CUT_PROP = 'function body(s) {\n  return String(s).slice(0, 10000);\n}';

function cutRepo(ctx) {
  fs.writeFileSync(path.join(ctx.repo, 'body.js'), `'use strict';\n${CUT_CUR}\nmodule.exports = { body };\n`);
}

test('a 2/3 jury is critic_rejected even when the diff test says equivalent (AUDIT-5 C1)', async (t) => {
  const ctx = setup(t);
  cutRepo(ctx);
  const p = await viaPipeline(ctx, makeProposal('body.js', CUT_CUR, CUT_PROP),
    perPersona(persona => persona === 'strict' ? { ...base, preserves_semantics: false, p_preserves: 0.2 } : APPROVE_RAW));
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert(p.combined_confidence >= 0.5);
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /2\/3 approve \(need unanimous\)/);
});

test('an approving persona listing a behaviour-changing edge case blocks the edit (AUDIT-5 M2 K2)', async (t) => {
  const ctx = setup(t);
  cutRepo(ctx);
  const p = await viaPipeline(ctx, makeProposal('body.js', CUT_CUR, CUT_PROP),
    perPersona(persona => persona === 'security' ? { ...APPROVE_RAW, edge_cases: ['inputs over 10000 characters are truncated'] } : APPROVE_RAW));
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /edge cases: security: inputs over 10000 characters are truncated/);
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

test('a unanimous approve whose jury mean p_preserves is below 0.5 is critic_rejected (AUDIT-11 C4)', async (t) => {
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME), perPersona(() => ({ ...base, preserves_semantics: true, p_preserves: 0.3 })));
  assert.strictEqual(p.critic_verdict.agreement.unanimous, true);
  assert.strictEqual(p.diff_test.verdict, 'equivalent');
  assert(p.combined_confidence >= 0.5, 'score alone would pass');
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
  assert.match(p.test_outcome.reason, /critic jury does not approve.*p_preserves=0\.3/);
});

test('a diff test that throws is inconclusive, never equivalent (AUDIT-11 C3)', async (t) => {
  const diffTesting = require('../src/validation/diff-testing');
  const orig = diffTesting.run;
  diffTesting.run = () => { throw new Error('oracle crashed'); };
  t.after(() => { diffTesting.run = orig; });
  const ctx = setup(t);
  const p = await viaPipeline(ctx, makeProposal('index.js', DOUBLE, SAME), perPersona(() => ({ ...base, preserves_semantics: true, p_preserves: 0.9 })));
  assert.strictEqual(p.diff_test.verdict, 'inconclusive');
  assert.match(p.diff_test.reason, /diff-test error: oracle crashed/);
  assert.strictEqual(p.test_outcome.status, 'critic_rejected');
});
