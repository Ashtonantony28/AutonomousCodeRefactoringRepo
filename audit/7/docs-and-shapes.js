'use strict';

// AUDIT-7 Low findings: shapes outside the contracts and docs vs code after
// SG9-SG13. Each check prints FINDING or ok.
//
//   node audit/7/docs-and-shapes.js

const { env, report, exitCode } = require('./lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { stateDirFor, loadOrInit, saveSession, loadSession } = require('../../src/utils/checkpoint');
const { vetoReasons } = require('../../src/validation/hybrid-validator');
const { aggregateJury, malformedVerdict } = require('../../src/agents/critic');
const { juryVotes } = require('../../src/validation/hybrid-validator');
const diffTesting = require('../../src/validation/diff-testing');

const ROOT = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// L1: state is keyed by path.resolve, worktrees by realpath.
{
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'audit7-real-'));
  const link = real + '-link';
  fs.symlinkSync(real, link, 'dir');
  const a = stateDirFor(real), b = stateDirFor(link);
  report('L1 one target, two state dirs (symlinked or differently spelled --repo)',
    a === b,
    `stateDirFor(${path.basename(real)}) != stateDirFor(${path.basename(link)}): separate session, inflight.json, samples and calibration for the same repo (a crash snapshot written under one is not restored under the other)`,
    'key stateDirFor by fs.realpathSync like worktree.createWorktree does');
  fs.rmSync(link); fs.rmSync(real, { recursive: true, force: true });
}

// L2: a non-resume run (incl. --dry-run) silently replaces the target's unfinished session.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit7-l2-'));
  const s = loadOrInit(repo, { resume: false });
  s.proposals.push({ issue_id: 'pending', test_outcome: null });
  s.worktree = { mode: 'worktree', branch: 'refactor/x' };
  saveSession(s);
  loadOrInit(repo, { resume: false });
  const now = loadSession(repo);
  report('L2 a run without --resume discards the target\'s unfinished session without a warning',
    now.proposals.length === 1,
    `session with 1 unprocessed proposal and worktree record refactor/x replaced by a fresh one (proposals=${now.proposals.length}, worktree=${now.worktree ? 'kept' : 'gone'})`,
    'warn (or refuse without --force) when the existing session has proposals without test_outcome; keep the old session file');
}

// L3: counterexample shape is not contracted; load/resolve-phase counterexamples have no args.
{
  const dt = diffTesting.run({ currentSrc: 'function f(a) { return a; }', proposedSrc: 'function f(a) { return a; }\nthrow new Error("boom");', fileSrc: 'function f(a) { return a; }\nmodule.exports = { f };\n' });
  const jury = aggregateJury([malformedVerdict('x', 'strict')], 'x');
  const reasons = vetoReasons({ jury: { ...jury, panel: [] }, checks: [], dt });
  console.log(`   diff test: verdict=${dt.verdict} counterexample keys=${dt.counterexample ? Object.keys(dt.counterexample).join(',') : '-'}`);
  report('L3 DiffTest.counterexample has three shapes; the veto reason reads `args` and `function_name`',
    !(dt.verdict === 'divergent' && dt.counterexample && dt.counterexample.args === undefined),
    `veto reason: "${reasons[0]}"`,
    'contract the counterexample ({phase, target, args?, current?, proposed?}) and render each phase');
}

// L4: TestOutcome.reason is both a machine code (isLabeled matches it) and prose; vetoed uses `reasons[]`.
{
  const orch = read('src/orchestrator.js');
  const prose = orch.includes("reason: 'reconciled from branch commit'");
  const plural = orch.includes("status: 'vetoed', reasons:");
  report('L4 TestOutcome.reason vocabulary is undefined',
    !(prose && plural),
    'reverted.reason ∈ {edit_not_exercised, no_coverage_tool} (codes, matched by collector.UNTESTED_REASONS) or absent; passed.reason = "reconciled from branch commit", apply_failed/critic_rejected/timeout reason = prose; vetoed carries reasons[] instead',
    'TestOutcome contract lists reason codes per status (plus a separate detail/message field) and assertTestOutcome checks them');
}

// L5: agreement.unanimous is true for a unanimous reject.
{
  const v = (persona) => ({ persona, preserves_semantics: false, p_preserves: 0.1, edge_cases: [], hallucination_flags: [], reasoning: 'no' });
  const jury = aggregateJury([v('strict'), v('permissive'), v('security')], 'x');
  report('L5 JuryVerdict.agreement.unanimous means "all agree", juryVotes().unanimous means "all approve"',
    jury.agreement.unanimous === juryVotes(jury).unanimous,
    `3/3 reject: agreement.unanimous=${jury.agreement.unanimous}, juryVotes.unanimous=${juryVotes(jury).unanimous}; the gate uses the latter, reward.disagreementPenalty and the dashboard trace the former`,
    'one meaning, documented in the JuryVerdict contract (or rename to agreement.consensus)');
}

// L6: docs that went stale with SG12/SG13.
{
  const help = spawnSync(process.execPath, [path.join(ROOT, 'src/orchestrator.js'), '--help'], { encoding: 'utf8' }).stdout;
  const claude = read('CLAUDE.md');
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json'));
  const srcAll = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else srcAll.push(fs.readFileSync(a, 'utf8')); } })(path.join(ROOT, 'src'));
  const uses = (m) => srcAll.some(s => s.includes(`require('${m}')`));
  const stale = [];
  if (/resume from existing state\/session\.json/.test(help)) stale.push('--help: "--resume  resume from existing state/session.json" (session is per target since SG13)');
  if (claude.includes('.refactor-coverage')) stale.push('CLAUDE.md: coverage output ".refactor-coverage" in the worktree (SG12 writes it to an os.tmpdir() dir and deletes it)');
  if (/fast-check/.test(readme) && !uses('fast-check')) stale.push('README: diff test uses "fast-check" generated inputs and `vm` contexts; fast-check is never required (own generator, worker_thread)');
  if (pkg.dependencies['@babel/traverse'] && !uses('@babel/traverse')) stale.push('package.json: @babel/traverse unused');
  if (/>=\s*18/.test(pkg.engines.node)) stale.push(`package.json engines.node "${pkg.engines.node}" vs PLAN "Node >= 22"`);
  if (!/"worktree"/.test(claude)) stale.push('CLAUDE.md session schema: no `worktree` key (written by every non-dry run, read by --resume)');
  if (!/validated_region/.test(claude) && !/validated_region/.test(read('src/contracts.js'))) stale.push('`validated_region` (executor requires it to match) is in neither the Proposal contract nor CLAUDE.md');
  if (!/diff_test/.test(claude.split('### Proposal shape')[1].split('---')[0])) stale.push('CLAUDE.md Proposal shape: no diff_test / veto (contract has both)');
  for (const s of stale) console.log(`   - ${s}`);
  report('L6 CLI help, CLAUDE.md, README and package.json vs code after SG9-SG13',
    stale.length === 0, `${stale.length} stale statements (listed above)`, 'docs and help describe the per-target session, temp coverage dir, worker-thread diff test and the Proposal fields the executor relies on');
}

process.exit(exitCode());
