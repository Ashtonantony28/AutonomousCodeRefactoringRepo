'use strict';

// AUDIT-3 executable contract check: runs the real pipeline (runPipeline,
// stub Claude client, fixture repos, non-dry runs in git worktrees) and
// validates every object crossing a stage boundary against src/contracts.js.
//
// Each producer is wrapped *before* the orchestrator is required so the
// destructured imports pick up the wrappers. Nothing under src/ is modified.
//
//   node audit/3/boundaries.js            # summary + every violation
//
// Exit 1 when any boundary object violates its contract.

const { env, gitInit, noTestCtx, quiet } = require('./lib');
const fs = require('fs');
const path = require('path');
const C = require('../../src/contracts');

const violations = [];
const seen = { statuses: new Set(), proposalKeys: new Set(), juryKeys: new Set(), dtKeys: new Set(), outcomeKeys: new Set(), sessionKeys: new Set() };
let current = '';

function check(boundary, fn, obj) {
  try { fn(obj); } catch (e) { violations.push({ fixture: current, boundary, error: e.message }); }
}
function wrap(mod, name, after) {
  const orig = mod[name];
  mod[name] = function wrapped(...args) {
    const out = orig.apply(this, args);
    if (out && typeof out.then === 'function') return out.then(v => { after(v, args); return v; });
    after(out, args);
    return out;
  };
}

// --- producers, wrapped before anything destructures them ---
const analyzer = require('../../src/agents/analyzer');
wrap(analyzer, 'runAnalyzer', (ps) => ps.forEach(p => check('analyzer -> Proposal', C.assertProposal, p)));

const critic = require('../../src/agents/critic');
wrap(critic, 'runCritic', (j) => {
  Object.keys(j).forEach(k => seen.juryKeys.add(k));
  check('critic -> JuryVerdict', C.assertJuryVerdict, j);
  (j.panel || []).forEach(v => check('critic -> Verdict (panel)', C.assertVerdict, v));
});

const ast = require('../../src/validation/ast-checker');
wrap(ast, 'runChecks', (r) => r.checks.forEach(c => check('ast -> CheckResult', C.assertCheckResult, c)));

const dt = require('../../src/validation/diff-testing');
wrap(dt, 'run', (d) => { Object.keys(d).forEach(k => seen.dtKeys.add(k)); check('diff-testing -> DiffTest', C.assertDiffTest, d); });

const executor = require('../../src/agents/executor');
wrap(executor, 'runExecutor', (o) => {
  Object.keys(o).forEach(k => seen.outcomeKeys.add(k));
  check('executor -> TestOutcome', C.assertTestOutcome, o);
});

const reflexion = require('../../src/agents/reflexion');
wrap(reflexion, 'repair', (p) => { if (p) check('reflexion -> Proposal', C.assertProposal, p); });

const collector = require('../../src/rl/collector');
wrap(collector, 'collectSample', (s) => { if (s) check('collector -> Sample', C.assertSample, s); });

const bug = require('../../src/rl/bug-injector');
wrap(bug, 'syntheticNegatives', (ss) => ss.forEach(s => check('bug-injector -> Sample', C.assertSample, s)));

const { runPipeline } = require('../../src/orchestrator');
const { installStub, resetClient, loadFixtureResponses } = require('../../test/helpers/stub-client');
const { loadSamples, samplesPath } = collector;
const { stateDir, sessionPath } = require('../../src/utils/checkpoint');

function spansOf(runId) {
  const f = path.join(stateDir(), 'runs', runId, 'spans.ndjson');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function checkSpans(session) {
  const spans = spansOf(session.run_id);
  if (!spans) { violations.push({ fixture: current, boundary: 'tracer -> spans.ndjson', error: 'file missing' }); return; }
  const ids = new Set(spans.map(s => s.span_id));
  for (const s of spans) {
    const errs = [];
    if (s.trace_id !== session.run_id) errs.push(`trace_id ${s.trace_id} != run_id`);
    if (s.parent_id !== null && !ids.has(s.parent_id)) errs.push(`parent_id ${s.parent_id} not a span in the file`);
    if (!(Date.parse(s.start) <= Date.parse(s.end))) errs.push(`start ${s.start} > end ${s.end}`);
    if (errs.length) violations.push({ fixture: current, boundary: 'tracer -> span', error: `${s.name}: ${errs.join('; ')}` });
  }
  // every decision_trace step should have a span (README: "every decision_trace step also emits a span")
  for (const p of session.proposals) {
    for (const st of p.decision_trace) {
      if (!st.otel) violations.push({ fixture: current, boundary: 'trace step -> span', error: `${p.issue_id} step stage=${st.stage} outcome=${st.outcome} has no otel span (not persisted to spans.ndjson)` });
    }
  }
}

const SESSION_KEYS = ['run_id', 'target_repo', 'started_at', 'updated_at', 'proposals', 'test_results', 'rl_samples', 'token_usage', 'context_saturation'];

async function runFixture(name, { responses, gitRepo = true, label = name } = {}) {
  current = label;
  const repo = env.copyFixture(name);
  if (gitRepo) gitInit(repo);
  installStub(responses || loadFixtureResponses(name));
  const session = await quiet(() => noTestCtx(() => runPipeline({ repo, cache: 'off' })));
  resetClient();
  Object.keys(session).forEach(k => seen.sessionKeys.add(k));
  for (const p of session.proposals) {
    Object.keys(p).forEach(k => seen.proposalKeys.add(k));
    check('session.proposals[] (final)', C.assertProposal, p);
    if (p.test_outcome) seen.statuses.add(p.test_outcome.status);
  }
  for (const s of session.rl_samples) check('session.rl_samples[]', C.assertSample, s);
  for (const s of loadSamples(repo)) check(`per-target ${path.basename(samplesPath(repo))}`, C.assertSample, s);
  const persisted = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  for (const k of SESSION_KEYS) if (!(k in persisted)) violations.push({ fixture: label, boundary: 'session.json schema (CLAUDE.md)', error: `missing ${k}` });
  checkSpans(session);
  const statuses = session.proposals.map(p => `${p.parent_issue_id ? 'repair ' : ''}${p.test_outcome && p.test_outcome.status}`);
  console.log(`  ${label.padEnd(28)} proposals=${session.proposals.length} statuses=[${statuses.join(', ')}] samples=${session.rl_samples.length}`);
  return session;
}

(async () => {
  console.log('Running pipeline on fixtures with contract checks at every boundary:');
  await runFixture('js-basic');
  await runFixture('js-failing-after-edit');
  // Reflexion boundary: a repair that passes.
  const r = loadFixtureResponses('js-failing-after-edit');
  r.reflexion = { current_code: "const GREETING = 'hello';", proposed_code: "const GREETING = \"hello\";", reasoning: 'keep value', risk_estimate: 0.1 };
  await runFixture('js-failing-after-edit', { responses: r, label: 'js-failing+repair' });
  await runFixture('no-tests');
  await runFixture('py-basic');

  console.log('\nKeys seen beyond the contract shapes:');
  const shapeKeys = (s) => C.SHAPES[s].map(k => k.replace(/[?\[\]]|\{.*\}/g, ''));
  const extra = (set, shape) => [...set].filter(k => !shapeKeys(shape).includes(k));
  console.log(`  Proposal:    ${extra(seen.proposalKeys, 'Proposal').join(', ')}`);
  console.log(`  JuryVerdict: ${extra(seen.juryKeys, 'JuryVerdict').join(', ')}`);
  console.log(`  DiffTest:    ${extra(seen.dtKeys, 'DiffTest').join(', ')}`);
  console.log(`  session.json (vs CLAUDE.md schema): ${[...seen.sessionKeys].filter(k => !SESSION_KEYS.includes(k)).join(', ') || '(none)'}`);
  console.log(`  statuses produced: ${[...seen.statuses].join(', ')}`);

  console.log(`\nContract violations: ${violations.length}`);
  const grouped = new Map();
  for (const v of violations) {
    const k = `${v.boundary}: ${v.error.replace(/[0-9a-f]{16}/g, '<id>')}`;
    grouped.set(k, (grouped.get(k) || new Set()).add(v.fixture));
  }
  for (const [k, fx] of grouped) console.log(`  [${[...fx].join(',')}] ${k}`);
  process.exit(violations.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
