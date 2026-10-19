#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-bench-'));
if (!process.env.REFACTOR_STATE_DIR) process.env.REFACTOR_STATE_DIR = path.join(scratch, 'state');
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* */ } });

const { runChecks } = require('../src/validation/ast-checker');
const diffTesting = require('../src/validation/diff-testing');
const { applyEdit } = require('../src/runner/reverter');
const { runHybridValidator } = require('../src/validation/hybrid-validator');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'test', 'fixtures');
const FIXTURES = ['js-basic', 'js-failing-after-edit', 'py-basic', 'no-tests'];

// p95 budgets from PLAN.md "Latency budget", per proposal, excluding Claude calls.
const STAGES = {
  ast: { label: 'AST checks (runChecks)', budget: 300 },
  difftest: { label: 'Differential test (diffTesting.run)', budget: 2000 },
  apply: { label: 'Anchor match + apply (applyEdit)', budget: 100 },
  validator: { label: 'runHybridValidator (stub critic)', budget: 2500 }
};

function parseArgs(argv) {
  const out = { stage: null, iterations: 20 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stage') out.stage = argv[++i];
    else if (argv[i] === '--iterations' || argv[i] === '-n') out.iterations = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function loadCases() {
  const cases = [];
  for (const name of FIXTURES) {
    const repo = path.join(scratch, 'fixtures', name);
    fs.cpSync(path.join(FIXTURES_DIR, name), repo, { recursive: true });
    const proposals = JSON.parse(fs.readFileSync(path.join(repo, 'proposals.json'), 'utf8'));
    for (const p of proposals) {
      const { expected_status, ...rest } = p;
      const abs = path.join(repo, rest.file);
      cases.push({ fixture: name, repo, abs, original: fs.readFileSync(abs, 'utf8'), proposal: rest });
    }
  }
  return cases;
}

function freshProposal(p) {
  return {
    ...p,
    critic_verdict: null,
    pattern_check_results: [],
    diff_test: null,
    combined_confidence: null,
    test_outcome: null,
    decision_trace: []
  };
}

const stubCritic = async ({ proposal }) => ({
  proposal_id: proposal.issue_id, persona: 'strict', preserves_semantics: true,
  edge_cases: [], hallucination_flags: [], claude_confidence: 0.8, reasoning: 'bench stub',
  panel: [], agreement: { mean_confidence: 0.8, std_confidence: 0, unanimous_approval: true, approval_rate: 1, verbal_entropy: 0 }
});

const RUNNERS = {
  ast: { filter: () => true, run: (c) => runChecks({ proposal: freshProposal(c.proposal), repoRoot: c.repo }) },
  difftest: {
    filter: (c) => /\.(js|cjs|mjs)$/i.test(c.proposal.file),
    run: (c) => diffTesting.run({ currentSrc: c.proposal.current_code, proposedSrc: c.proposal.proposed_code, fileSrc: c.original })
  },
  apply: {
    filter: () => true,
    before: (c) => fs.writeFileSync(c.abs, c.original),
    run: (c) => applyEdit({ repoRoot: c.repo, relPath: c.proposal.file, currentCode: c.proposal.current_code, proposedCode: c.proposal.proposed_code }),
    after: (c) => fs.writeFileSync(c.abs, c.original)
  },
  validator: { filter: () => true, run: (c) => runHybridValidator({ proposal: freshProposal(c.proposal), repoRoot: c.repo, runCritic: stubCritic }) }
};

function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function benchStage(name, cases, iterations) {
  const r = RUNNERS[name];
  const subset = cases.filter(r.filter);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    for (const c of subset) {
      if (r.before) r.before(c);
      const t0 = performance.now();
      await r.run(c);
      samples.push(performance.now() - t0);
      if (r.after) r.after(c);
    }
  }
  samples.sort((a, b) => a - b);
  return { name, n: samples.length, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), budget: STAGES[name].budget };
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node bench/run.js [--stage ' + Object.keys(STAGES).join('|') + '] [--iterations N]');
    return 0;
  }
  if (args.stage && !STAGES[args.stage]) {
    console.error(`unknown stage "${args.stage}"; expected one of ${Object.keys(STAGES).join(', ')}`);
    return 2;
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1) {
    console.error('--iterations must be a positive integer');
    return 2;
  }
  const cases = loadCases();
  const names = args.stage ? [args.stage] : Object.keys(STAGES);
  const rows = [];
  for (const name of names) {
    await benchStage(name, cases, 1);
    rows.push(await benchStage(name, cases, args.iterations));
  }

  console.log(`bench: ${cases.length} fixture proposals, ${args.iterations} iterations`);
  console.log(`${pad('stage', 10)} ${pad('description', 38)} ${lpad('n', 5)} ${lpad('p50 ms', 9)} ${lpad('p95 ms', 9)} ${lpad('budget', 8)}  result`);
  let failed = 0;
  for (const r of rows) {
    const ok = r.p95 <= r.budget;
    if (!ok) failed++;
    console.log(`${pad(r.name, 10)} ${pad(STAGES[r.name].label, 38)} ${lpad(r.n, 5)} ${lpad(r.p50.toFixed(2), 9)} ${lpad(r.p95.toFixed(2), 9)} ${lpad(r.budget, 8)}  ${ok ? 'ok' : 'OVER BUDGET'}`);
  }
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('bench failed:', err);
  process.exitCode = 1;
});
