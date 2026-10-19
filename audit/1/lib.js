'use strict';

// Shared harness for AUDIT-1 repros. Uses the repo's own temp state dir
// helper and stub Claude client; never touches state/ or the live API.
const { rm } = require('../../test/helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { freshSession } = require('../../src/utils/checkpoint');
const { TokenTracker } = require('../../src/utils/token-tracker');
const { processProposal, setupWorkspace } = require('../../src/orchestrator');
const { Classifier } = require('../../src/rl/classifier');
const { installStub, resetClient } = require('../../test/helpers/stub-client');
const { makeProposal } = require('../../test/helpers/factories');

const APPROVE = { preserves_semantics: true, p_preserves: 0.9, edge_cases: [], hallucination_flags: [], reasoning: 'behaviour preserved' };

function gitIn(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function makeRepo(files, { pkg = {}, git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit1-repo-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'audit1', version: '0.0.0', ...pkg }, null, 2));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), src);
  }
  if (git) {
    gitIn(dir, 'init', '-q');
    gitIn(dir, 'add', '-A');
    gitIn(dir, '-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '-m', 'init');
  }
  return dir;
}

// Runs one proposal through the real orchestrator gate (critic -> AST ->
// diff test -> vetoes -> fusion -> learned gate). dryRun stops right before
// the executor: status 'dry_run' == "would have been executed".
async function throughGate({ repo, file, current, proposed, critic = APPROVE, dryRun = true }) {
  installStub({ critic: typeof critic === 'function' ? critic : () => critic });
  const session = freshSession(repo);
  const tracker = new TokenTracker(session);
  const proposal = makeProposal(file, current, proposed);
  session.proposals.push(proposal);
  const opts = { proposal, session, tracker, classifier: new Classifier(null), dryRun, absRepo: repo, allowRepair: false };
  if (!dryRun) opts.work = setupWorkspace({ session, absRepo: repo, dryRun: false });
  await processProposal(opts);
  resetClient();
  return { proposal, session, work: opts.work };
}

function summary(p) {
  const dt = p.diff_test || {};
  return {
    status: p.test_outcome && p.test_outcome.status,
    combined: p.combined_confidence,
    diff_test: dt.verdict + (dt.reason ? ` (${dt.reason})` : ''),
    failed_checks: (p.pattern_check_results || []).filter(c => !c.passed).map(c => c.check_name),
    veto: p.veto ? p.veto.reasons : null
  };
}

module.exports = { makeRepo, throughGate, summary, gitIn, APPROVE, rm };
