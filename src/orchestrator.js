#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { Command } = require('commander');
let chalk;
try { chalk = require('chalk'); } catch { chalk = { green: s => s, red: s => s, yellow: s => s, cyan: s => s, gray: s => s, bold: s => s }; }

const { loadOrInit, saveSession, inflightPath, worktreesDir } = require('./utils/checkpoint');
const { TokenTracker } = require('./utils/token-tracker');
const { discover } = require('./utils/file-discovery');
const apiCache = require('./utils/api-cache');

const { runAnalyzer } = require('./agents/analyzer');
const { runCritic } = require('./agents/critic');
const { runHybridValidator } = require('./validation/hybrid-validator');
const { runExecutor } = require('./agents/executor');
const reflexion = require('./agents/reflexion');
const { FileSnapshot } = require('./runner/reverter');
const { killActive } = require('./runner/test-runner');
const worktree = require('./runner/worktree');

const { collectSample, isLabeled } = require('./rl/collector');
const { trainIfReady, loadClassifier, RL_GATE_THRESHOLD } = require('./rl/classifier');
const { computeReward, rollingWarning, rewardBreakdown } = require('./rl/reward');
const calibration = require('./rl/calibration');
const bugInjector = require('./rl/bug-injector');
const { extractFeatures } = require('./rl/features');

const { trace, classifyFailure, persistRunSpans } = require('./interpretability/tracer');
const { renderDashboard } = require('./interpretability/dashboard');

const REJECT_THRESHOLD = 0.5;
const MIN_CRITIC_P = 0.5;

function logInfo(msg) { console.log(chalk.cyan('[orch] ') + msg); }
function logWarn(msg) { console.log(chalk.yellow('[orch] ') + msg); }
function logErr(msg)  { console.log(chalk.red('[orch] ')  + msg); }
function logOk(msg)   { console.log(chalk.green('[orch] ')+ msg); }

// Revert any in-flight edit (killing its test process group first), flush
// state, exit. Exported so tests can drive it without delivering a signal.
function handleSignal(signal, session, { exit = process.exit } = {}) {
  logWarn(`${signal} — reverting in-flight edit and flushing state`);
  try { killActive(); } catch { /* */ }
  try {
    const n = FileSnapshot.restoreLive();
    if (n) logWarn(`restored ${n} in-flight file(s)`);
  } catch (e) { logErr(`restore failed: ${e.message}`); }
  try { if (session) saveSession(session); } catch { /* */ }
  exit(signal === 'uncaughtException' ? 1 : 0);
}

function installSignalHandlers(session) {
  process.on('SIGINT', () => handleSignal('SIGINT', session));
  process.on('SIGTERM', () => handleSignal('SIGTERM', session));
  process.on('uncaughtException', (e) => { logErr(`uncaught: ${e.message}`); handleSignal('uncaughtException', session); });
}

function featuresFor(p) {
  return extractFeatures(p);
}

// `work` = { root, info, snapshotPath }: where edits are validated, applied
// and tested (the run's worktree, or the target itself in dry-run / non-git
// fallback). `absRepo` is the target, used only as the sample label.
async function processProposal({ proposal, session, tracker, classifier, dryRun, absRepo, work = null, allowRepair = true, attemptIdx = 0 }) {
  const trace_id = session.run_id;
  if (!work) work = { root: absRepo, info: null, snapshotPath: inflightPath(absRepo) };
  proposal.run_id = session.run_id;
  // Hybrid critic + AST + diff-testing
  try {
    await runHybridValidator({ proposal, tracker, repoRoot: work.root, runCritic, runId: session.run_id });
  } catch (err) {
    logErr(`hybrid validator error on ${proposal.file}: ${err.message}`);
    trace(proposal, 'critic', { reasoning: `validator error: ${err.message}`, confidence: 0, outcome: 'error', trace_id });
    proposal.combined_confidence = 0;
    proposal.veto = null;
  }
  saveSession(session);

  if (proposal.veto && proposal.veto.vetoed) {
    proposal.test_outcome = { status: 'vetoed', reasons: proposal.veto.reasons };
    trace(proposal, 'critic', {
      reasoning: `vetoed: ${proposal.veto.reasons.join('; ')}`,
      confidence: proposal.combined_confidence,
      outcome: 'vetoed',
      trace_id
    });
    saveSession(session);
    return proposal;
  }

  const jury = proposal.critic_verdict;
  const criticOk = !!jury && jury.preserves_semantics === true && (jury.p_preserves || 0) >= MIN_CRITIC_P;
  if ((proposal.combined_confidence || 0) < REJECT_THRESHOLD || !criticOk) {
    const reason = !criticOk
      ? `critic jury does not approve (majority preserves_semantics=${!!(jury && jury.preserves_semantics)}, p_preserves=${jury ? jury.p_preserves : 'n/a'}, need >= ${MIN_CRITIC_P})`
      : `combined_confidence < ${REJECT_THRESHOLD}`;
    proposal.test_outcome = { status: 'critic_rejected', reason };
    trace(proposal, 'critic', {
      reasoning: `${reason}; rejecting`,
      confidence: proposal.combined_confidence,
      outcome: 'critic_rejected',
      trace_id
    });
    saveSession(session);
    return proposal;
  }

  // RL gate
  const t0 = performance.now();
  const gate = classifier.gate(proposal);
  if (gate.gated) {
    const pPass = gate.p_pass;
    proposal.rl_prediction = pPass;
    trace(proposal, 'rl', {
      reasoning: `predicted p_pass=${pPass.toFixed(3)} (${gate.source})`,
      confidence: pPass,
      outcome: pPass < RL_GATE_THRESHOLD ? 'rl_rejected' : 'rl_approved',
      duration_ms: Number((performance.now() - t0).toFixed(3)),
      trace_id
    });
    if (pPass < RL_GATE_THRESHOLD) {
      proposal.test_outcome = { status: 'rl_rejected', p_pass: pPass };
      saveSession(session);
      return proposal;
    }
  }

  if (dryRun) {
    proposal.test_outcome = { status: 'dry_run' };
    trace(proposal, 'executor', { reasoning: 'dry-run; skipping executor', confidence: 0, outcome: 'dry_run', trace_id });
    saveSession(session);
    return proposal;
  }

  // Executor
  let result;
  const tExec = performance.now();
  try {
    result = await runExecutor({
      proposal,
      repoRoot: work.root,
      snapshotPath: work.snapshotPath,
      onKept: () => worktree.commitProposal(work.info, proposal)
    });
  } catch (err) {
    logErr(`executor failed on ${proposal.file}: ${err.message}`);
    trace(proposal, 'executor', { reasoning: `executor error: ${err.message}`, confidence: 0, outcome: 'error', trace_id });
    proposal.test_outcome = { status: 'error', error: err.message };
    saveSession(session);
    return proposal;
  }
  proposal.test_outcome = result;
  session.test_results.push({ proposal_id: proposal.issue_id, ...result });
  trace(proposal, 'executor', {
    reasoning: result.reason || `tests ${result.status}${result.commit ? `; committed ${result.commit.slice(0, 12)}` : ''}`,
    confidence: result.status === 'passed' ? 1 : 0,
    outcome: result.status,
    duration_ms: Number((performance.now() - tExec).toFixed(3)),
    trace_id
  });
  if (result.status === 'skipped_no_tests' || (result.status === 'reverted' && !isLabeled(result))) {
    saveSession(session);
    return proposal; // no test judged the edit: no reward signal, no sample, no repair
  }

  // Reward / RL sample
  const sample = collectSample(proposal, absRepo);
  if (sample) session.rl_samples.push(sample);
  proposal.reward = computeReward(proposal, absRepo);
  proposal.reward_breakdown = rewardBreakdown(proposal, absRepo);
  trace(proposal, 'rl', { reasoning: `reward=${proposal.reward.toFixed(3)}`, confidence: proposal.combined_confidence, outcome: result.status, trace_id });

  // Synthetic negatives (CriticGPT-style) when the proposal passed cleanly
  if (result.status === 'passed') {
    const negatives = bugInjector.syntheticNegatives(proposal, absRepo);
    if (negatives.length) {
      session.rl_samples.push(...negatives);
    }
  }

  // Failure attribution
  if (['failed', 'reverted', 'apply_failed', 'timeout', 'environment_error'].includes(result.status)) {
    proposal.failure_class = classifyFailure(proposal);

    // Reflexion repair loop: feed failure back to a repair pass, up to 2 retries.
    if (allowRepair && attemptIdx < reflexion.MAX_RETRIES &&
        ['failed', 'reverted', 'apply_failed'].includes(result.status)) {
      const repaired = await reflexion.repair({
        proposal, failure: result, tracker, attemptIdx: attemptIdx + 1,
        takenIds: new Set(session.proposals.map(p => p.issue_id))
      });
      if (repaired) {
        logInfo(`reflexion: emitted repair attempt ${repaired.attempt} for ${proposal.file}`);
        session.proposals.push(repaired);
        saveSession(session);
        await processProposal({
          proposal: repaired, session, tracker, classifier, dryRun, absRepo, work,
          allowRepair: true, attemptIdx: repaired.attempt
        });
      }
    }
  }

  saveSession(session);
  return proposal;
}

async function runPipeline({ repo, dryRun, resume, cache = 'read-write', hierarchical = true, serveDashboard = false, dashboardPort = 4173, cli = false }) {
  const absRepo = path.resolve(repo);
  if (!fs.existsSync(absRepo)) {
    logErr(`target repo does not exist: ${absRepo}`);
    if (cli) process.exit(2);
    const err = new Error(`target repo does not exist: ${absRepo}`);
    err.code = 'ENOREPO';
    throw err;
  }
  apiCache.setMode(cache);

  // A previous process died mid-edit: put the file back before anything else.
  const crashed = FileSnapshot.restoreFromDisk(inflightPath(absRepo));
  if (crashed) logWarn(`restored in-flight edit from a previous run: ${crashed.files.join(', ')} in ${crashed.repo_root}`);

  const session = loadOrInit(absRepo, { resume });
  if (cli) installSignalHandlers(session);
  const tracker = new TokenTracker(session);
  const classifier = loadClassifier(absRepo);

  logInfo(`run_id=${session.run_id} repo=${absRepo} dry_run=${!!dryRun} cache=${cache} hierarchical=${hierarchical}`);

  const work = setupWorkspace({ session, absRepo, dryRun });
  saveSession(session);

  // Optional: start the live dashboard server up-front so refreshes are visible.
  if (serveDashboard) {
    const { start } = require('./interpretability/server');
    try { await start({ port: dashboardPort }); } catch (err) { logWarn(`dashboard server failed: ${err.message}`); }
  }

  const files = discover(absRepo);
  logInfo(`discovered ${files.length} candidate files`);
  if (files.length === 0) {
    logWarn('no source files to analyze; nothing to do');
    saveSession(session);
    renderDashboard(session);
    return session;
  }

  if (resume && session.proposals.length) {
    logInfo(`resume: ${session.proposals.length} proposals in session; skipping analyzer`);
  } else {
    let analyzerProposals;
    try {
      analyzerProposals = await runAnalyzer({ files, tracker, hierarchical, takenIds: session.proposals.map(p => p.issue_id) });
    } catch (err) {
      logErr(`analyzer failed: ${err.message}`);
      saveSession(session);
      renderDashboard(session);
      return session;
    }
    for (const p of analyzerProposals) {
      p.decision_trace = p.decision_trace || [];
      p.run_id = session.run_id;
      trace(p, 'analyzer', { reasoning: p.reasoning, confidence: 1 - (p.risk_estimate || 0), outcome: 'proposed', trace_id: session.run_id });
      session.proposals.push(p);
    }
    saveSession(session);
    logOk(`analyzer produced ${analyzerProposals.length} proposals`);
  }

  // Unfinished proposals, including Reflexion repairs left pending by an
  // interrupted run. Repairs emitted during this loop are processed by their
  // parent and are not in this snapshot of the list.
  for (const proposal of [...session.proposals]) {
    if (proposal.test_outcome) continue;
    await processProposal({
      proposal, session, tracker, classifier, dryRun, absRepo, work,
      attemptIdx: proposal.parent_issue_id ? (proposal.attempt || 1) : 0
    });
  }

  // Train RL + calibration after the run
  try {
    const trained = trainIfReady(absRepo);
    if (trained) logOk('RL classifier retrained on all persisted samples for this target');
  } catch (err) { logWarn(`RL training skipped: ${err.message}`); }
  try {
    const calRes = calibration.fitFromProposals(session.proposals, absRepo);
    if (calRes.trained) logOk(`calibration refit (n=${calRes.n} ECE_before=${calRes.ece_before.toFixed(3)})`);
  } catch (err) { logWarn(`calibration skipped: ${err.message}`); }

  // Reward trend warning
  const warning = rollingWarning(session.proposals);
  if (warning) logWarn(warning);

  // Persist OTel-style spans and dashboard
  try { persistRunSpans(session.run_id, session.proposals); } catch (err) { /* */ }
  const dashFile = renderDashboard(session);
  logOk(`dashboard written: ${path.relative(process.cwd(), dashFile) || dashFile}`);

  const stats = summarizeRun(session);
  logInfo(`done. proposals=${stats.total} passed=${stats.passed} failed=${stats.failed} rl_rejected=${stats.rl_rejected} critic_rejected=${stats.critic_rejected} vetoed=${stats.vetoed}`);
  if (work.info && work.info.mode === 'worktree') {
    const commits = worktree.commitsSinceBase(work.info);
    logOk(`branch ${work.info.branch} (${commits.length} commit${commits.length === 1 ? '' : 's'}) in worktree ${work.info.path}`);
  }
  saveSession(session);
  return session;
}

// Executor isolation: a git worktree on refactor/<run_id> under the state dir.
// Dry runs never write, so they validate against the target directly.
function setupWorkspace({ session, absRepo, dryRun }) {
  const snapshotPath = inflightPath(absRepo);
  if (dryRun) return { root: absRepo, info: null, snapshotPath };
  let info = session.worktree
    ? worktree.resumeWorktree({ targetRepo: absRepo, info: session.worktree })
    : null;
  if (!info) info = worktree.createWorktree({ targetRepo: absRepo, runId: session.run_id, baseDir: worktreesDir(absRepo) });
  if (info.mode !== 'worktree') {
    logWarn(`${info.reason}; executor will edit the target in place`);
  } else {
    logInfo(`worktree ${info.path} on branch ${info.branch}`);
  }
  session.worktree = info;
  return { root: info.root, info, snapshotPath };
}

function summarizeRun(session) {
  const out = { total: session.proposals.length, passed: 0, failed: 0, rl_rejected: 0, critic_rejected: 0, vetoed: 0, dry_run: 0, error: 0 };
  for (const p of session.proposals) {
    const s = p.test_outcome ? p.test_outcome.status : null;
    if (s === 'passed') out.passed++;
    else if (s === 'failed' || s === 'reverted') out.failed++;
    else if (s === 'rl_rejected') out.rl_rejected++;
    else if (s === 'critic_rejected') out.critic_rejected++;
    else if (s === 'vetoed') out.vetoed++;
    else if (s === 'dry_run') out.dry_run++;
    else if (s === 'error') out.error++;
  }
  return out;
}

function buildCli() {
  const program = new Command();
  program
    .name('refactor')
    .description('Multi-agent autonomous code refactoring pipeline')
    .requiredOption('--repo <path>', 'path to target Git repo')
    .option('--resume', 'resume from existing state/session.json', false)
    .option('--dry-run', 'run Analyzer + Critic, skip Executor', false)
    .option('--cache <mode>', 'API cache mode: off | read-write | replay', 'read-write')
    .option('--no-hierarchical', 'disable Agentless-style file→function shortlisting')
    .option('--serve', 'start live SSE dashboard on http://127.0.0.1:<port>', false)
    .option('--port <n>', 'dashboard server port', '4173');
  return program;
}

if (require.main === module) {
  const program = buildCli();
  program.parse(process.argv);
  const opts = program.opts();
  runPipeline({
    repo: opts.repo,
    dryRun: opts.dryRun,
    resume: opts.resume,
    cache: opts.cache,
    hierarchical: opts.hierarchical !== false,
    serveDashboard: opts.serve,
    dashboardPort: Number(opts.port) || 4173,
    cli: true
  }).catch((err) => {
    console.error(chalk.red('[orch] fatal: '), err);
    process.exit(1);
  });
}

module.exports = { runPipeline, processProposal, handleSignal, setupWorkspace, REJECT_THRESHOLD, MIN_CRITIC_P, featuresFor, summarizeRun };
