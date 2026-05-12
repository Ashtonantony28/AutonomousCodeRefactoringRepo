#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { Command } = require('commander');
let chalk;
try { chalk = require('chalk'); } catch { chalk = { green: s => s, red: s => s, yellow: s => s, cyan: s => s, gray: s => s, bold: s => s }; }

const { loadOrInit, saveSession } = require('./utils/checkpoint');
const { TokenTracker } = require('./utils/token-tracker');
const { discover } = require('./utils/file-discovery');
const apiCache = require('./utils/api-cache');

const { runAnalyzer } = require('./agents/analyzer');
const { runCritic } = require('./agents/critic');
const { runHybridValidator } = require('./validation/hybrid-validator');
const { runExecutor } = require('./agents/executor');
const reflexion = require('./agents/reflexion');

const { collectSample } = require('./rl/collector');
const { trainIfReady, loadClassifier } = require('./rl/classifier');
const { computeReward, rollingWarning, rewardBreakdown } = require('./rl/reward');
const calibration = require('./rl/calibration');
const bugInjector = require('./rl/bug-injector');

const { trace, classifyFailure, persistRunSpans } = require('./interpretability/tracer');
const { renderDashboard } = require('./interpretability/dashboard');

const RL_GATE_THRESHOLD = 0.4;
const REJECT_THRESHOLD = 0.5;

function logInfo(msg) { console.log(chalk.cyan('[orch] ') + msg); }
function logWarn(msg) { console.log(chalk.yellow('[orch] ') + msg); }
function logErr(msg)  { console.log(chalk.red('[orch] ')  + msg); }
function logOk(msg)   { console.log(chalk.green('[orch] ')+ msg); }

function summarizeProposal(p) {
  return {
    issue_id: p.issue_id,
    file: p.file,
    risk_estimate: p.risk_estimate,
    combined_confidence: p.combined_confidence,
    outcome: p.test_outcome ? p.test_outcome.status : null
  };
}

function pruneContext(agentName, proposals, tracker) {
  if (!tracker.shouldPrune(agentName)) return proposals;
  logWarn(`pruning context for ${agentName} (saturation ${(tracker.saturationOf(agentName) * 100).toFixed(1)}%)`);
  return proposals.map(summarizeProposal);
}

function installSignalHandlers(session) {
  const flush = (code) => {
    try { saveSession(session); } catch (e) { /* */ }
    process.exit(code);
  };
  process.on('SIGINT', () => { logWarn('SIGINT — flushing state'); flush(0); });
  process.on('SIGTERM', () => { logWarn('SIGTERM — flushing state'); flush(0); });
  process.on('uncaughtException', (e) => { logErr(`uncaught: ${e.message}`); flush(1); });
}

function featuresFor(p) {
  const ast = p.pattern_check_results || [];
  const passed = ast.filter(c => c.passed).length;
  const patternScore = ast.length ? passed / ast.length : 0.5;
  const claudeConf = p.critic_verdict ? (p.critic_verdict.claude_confidence || 0) : 0;
  const complexity = Math.max(
    (p.proposed_code || '').split('\n').length,
    (p.current_code || '').split('\n').length
  );
  return [claudeConf, patternScore, complexity, 1, p.risk_estimate || 0];
}

async function processProposal({ proposal, session, tracker, classifier, dryRun, absRepo, allowRepair = true, attemptIdx = 0 }) {
  // Hybrid critic + AST + diff-testing
  try {
    await runHybridValidator({ proposal, tracker, repoRoot: absRepo, runCritic });
  } catch (err) {
    logErr(`hybrid validator error on ${proposal.file}: ${err.message}`);
    trace(proposal, 'critic', { reasoning: `validator error: ${err.message}`, confidence: 0, outcome: 'error' });
    proposal.combined_confidence = 0;
  }
  saveSession(session);

  if ((proposal.combined_confidence || 0) < REJECT_THRESHOLD) {
    proposal.test_outcome = { status: 'critic_rejected', reason: 'combined_confidence below threshold' };
    trace(proposal, 'critic', {
      reasoning: 'combined_confidence < 0.5; rejecting',
      confidence: proposal.combined_confidence,
      outcome: 'critic_rejected'
    });
    saveSession(session);
    return proposal;
  }

  // RL gate
  if (classifier.isTrained()) {
    const features = featuresFor(proposal);
    const pPass = classifier.predict(features);
    proposal.rl_prediction = pPass;
    trace(proposal, 'rl', {
      reasoning: `predicted p_pass=${pPass.toFixed(3)}`,
      confidence: pPass,
      outcome: pPass < RL_GATE_THRESHOLD ? 'rl_rejected' : 'rl_approved'
    });
    if (pPass < RL_GATE_THRESHOLD) {
      proposal.test_outcome = { status: 'rl_rejected', p_pass: pPass };
      saveSession(session);
      return proposal;
    }
  }

  if (dryRun) {
    proposal.test_outcome = { status: 'dry_run' };
    trace(proposal, 'executor', { reasoning: 'dry-run; skipping executor', confidence: 0, outcome: 'dry_run' });
    saveSession(session);
    return proposal;
  }

  // Executor
  let result;
  try {
    result = await runExecutor({ proposal, tracker, repoRoot: absRepo });
  } catch (err) {
    logErr(`executor failed on ${proposal.file}: ${err.message}`);
    trace(proposal, 'executor', { reasoning: `executor error: ${err.message}`, confidence: 0, outcome: 'error' });
    proposal.test_outcome = { status: 'error', error: err.message };
    saveSession(session);
    return proposal;
  }
  proposal.test_outcome = result;
  session.test_results.push({ proposal_id: proposal.issue_id, ...result });

  // Reward / RL sample
  const sample = collectSample(proposal);
  session.rl_samples.push(sample);
  proposal.reward = computeReward(proposal);
  proposal.reward_breakdown = rewardBreakdown(proposal);
  trace(proposal, 'rl', { reasoning: `reward=${proposal.reward.toFixed(3)}`, confidence: proposal.combined_confidence, outcome: result.status });

  // Synthetic negatives (CriticGPT-style) when the proposal passed cleanly
  if (result.status === 'passed') {
    const negatives = bugInjector.syntheticNegatives(proposal);
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
        proposal, failure: result, tracker, attemptIdx: attemptIdx + 1
      });
      if (repaired) {
        logInfo(`reflexion: emitted repair attempt ${repaired.attempt} for ${proposal.file}`);
        session.proposals.push(repaired);
        saveSession(session);
        await processProposal({
          proposal: repaired, session, tracker, classifier, dryRun, absRepo,
          allowRepair: true, attemptIdx: repaired.attempt
        });
      }
    }
  }

  saveSession(session);
  return proposal;
}

async function runPipeline({ repo, dryRun, resume, cache = 'read-write', hierarchical = true, serveDashboard = false, dashboardPort = 4173 }) {
  const absRepo = path.resolve(repo);
  if (!fs.existsSync(absRepo)) {
    logErr(`target repo does not exist: ${absRepo}`);
    process.exit(2);
  }
  apiCache.setMode(cache);

  const session = loadOrInit(absRepo, { resume });
  installSignalHandlers(session);
  const tracker = new TokenTracker(session);
  const classifier = loadClassifier();

  logInfo(`run_id=${session.run_id} repo=${absRepo} dry_run=${!!dryRun} cache=${cache} hierarchical=${hierarchical}`);

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
    return;
  }

  let analyzerProposals;
  try {
    analyzerProposals = await runAnalyzer({ files, tracker, hierarchical });
  } catch (err) {
    logErr(`analyzer failed: ${err.message}`);
    saveSession(session);
    renderDashboard(session);
    return;
  }
  for (const p of analyzerProposals) {
    p.decision_trace = p.decision_trace || [];
    trace(p, 'analyzer', { reasoning: p.reasoning, confidence: 1 - (p.risk_estimate || 0), outcome: 'proposed' });
    session.proposals.push(p);
  }
  saveSession(session);
  logOk(`analyzer produced ${analyzerProposals.length} proposals`);

  for (const proposal of [...session.proposals]) {
    if (proposal.test_outcome) continue; // already processed (resume)
    if (proposal.parent_issue_id) continue; // repair attempts processed by parent
    await processProposal({ proposal, session, tracker, classifier, dryRun, absRepo });
  }

  // Train RL + calibration after the run
  try {
    const trained = trainIfReady(session.rl_samples);
    if (trained) logOk(`RL classifier retrained on ${session.rl_samples.length} samples`);
  } catch (err) { logWarn(`RL training skipped: ${err.message}`); }
  try {
    const calRes = calibration.fitFromProposals(session.proposals);
    if (calRes.trained) logOk(`calibration refit (n=${calRes.n} ECE_before=${calRes.ece_before.toFixed(3)})`);
  } catch (err) { logWarn(`calibration skipped: ${err.message}`); }

  // Reward trend warning
  const warning = rollingWarning(session.proposals);
  if (warning) logWarn(warning);

  // Persist OTel-style spans and dashboard
  try { persistRunSpans(session.run_id, session.proposals); } catch (err) { /* */ }
  renderDashboard(session);
  logOk('dashboard written: dashboard/dashboard.html');

  const stats = summarizeRun(session);
  logInfo(`done. proposals=${stats.total} passed=${stats.passed} failed=${stats.failed} rl_rejected=${stats.rl_rejected} critic_rejected=${stats.critic_rejected}`);
  saveSession(session);
}

function summarizeRun(session) {
  const out = { total: session.proposals.length, passed: 0, failed: 0, rl_rejected: 0, critic_rejected: 0, dry_run: 0, error: 0 };
  for (const p of session.proposals) {
    const s = p.test_outcome ? p.test_outcome.status : null;
    if (s === 'passed') out.passed++;
    else if (s === 'failed' || s === 'reverted') out.failed++;
    else if (s === 'rl_rejected') out.rl_rejected++;
    else if (s === 'critic_rejected') out.critic_rejected++;
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
    dashboardPort: Number(opts.port) || 4173
  }).catch((err) => {
    console.error(chalk.red('[orch] fatal: '), err);
    process.exit(1);
  });
}

module.exports = { runPipeline, processProposal, pruneContext, summarizeProposal, featuresFor, summarizeRun };
