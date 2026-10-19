#!/usr/bin/env node
'use strict';

// End-to-end load: N proposals through runPipeline (stub client, --cache off)
// on a generated 500-file repo, optionally with the live dashboard server
// (in-process, as --serve does) polled from a separate process.
//
// usage: node audit/2/pipeline-load.js [--files 500] [--proposals 50]
//          [--test fast|slow|hang|hang-escape] [--serve] [--drift] [--dry-run]
//          [--runs 1] [--json out.json]
//
// Proposals are seeded into session.json and run with resume:true because the
// Analyzer caps itself at 10 proposals (TARGET_PROPOSALS); everything after
// the Analyzer is the production path.

const fs = require('fs');
const path = require('path');
const { fork, execSync } = require('child_process');
const L = require('./lib');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const flag = (k) => args.includes(k);
const FILES = Number(opt('--files', 500));
const N = Number(opt('--proposals', 50));
const TEST = opt('--test', 'fast');
const SERVE = flag('--serve');
const DRIFT = flag('--drift');
const DRY = flag('--dry-run');
const RUNS = Number(opt('--runs', 1));
const JSON_OUT = opt('--json', null);

L.isolateState('pipe');
const checkpoint = require(L.src('utils/checkpoint'));
const collector = require(L.src('rl/collector'));
const classifier = require(L.src('rl/classifier'));
const dashboard = require(L.src('interpretability/dashboard'));
const tracer = require(L.src('interpretability/tracer'));
const bugInjector = require(L.src('rl/bug-injector'));
const worktree = require(L.src('runner/worktree'));
const hybrid = require(L.src('validation/hybrid-validator'));
const discovery = require(L.src('utils/file-discovery'));

const T = { save: [], saveBytes: [], collect: [], negatives: [], train: [], render: [], spans: [], validator: [], commit: [], discover: [], worktree: [] };
const origSave = checkpoint.saveSession;
checkpoint.saveSession = function (s) {
  const t = performance.now();
  origSave(s);
  T.save.push(performance.now() - t);
  try { T.saveBytes.push(fs.statSync(checkpoint.sessionPath()).size); } catch { /* */ }
};
L.timeExport(collector, 'collectSample', T.collect);
L.timeExport(classifier, 'trainIfReady', T.train);
L.timeExport(dashboard, 'renderDashboard', T.render);
L.timeExport(tracer, 'persistRunSpans', T.spans);
L.timeExport(bugInjector, 'syntheticNegatives', T.negatives);
L.timeExport(worktree, 'commitProposal', T.commit);
L.timeExport(worktree, 'createWorktree', T.worktree);
L.timeExport(hybrid, 'runHybridValidator', T.validator, { async: true });
L.timeExport(discovery, 'discover', T.discover);

const { installStub } = require(path.join(L.REPO_ROOT, 'test', 'helpers', 'stub-client'));
const stub = installStub({ critic: L.approvingCritic(), 'analyzer-files': [], 'analyzer-funcs': [], 'analyzer-propose': [], reflexion: 'not json' });
const { runPipeline } = require(L.src('orchestrator'));

async function main() {
  const tGen = performance.now();
  const { dir, meta } = L.genRepo({ files: FILES, test: TEST });
  L.gitInit(dir);
  const genMs = performance.now() - tGen;
  const repoBytes = meta.reduce((a, m) => a + m.bytes, 0);

  let server = null, poller = null, pollOut = null;
  if (SERVE) {
    const { start } = require(L.src('interpretability/server'));
    server = await start({ port: 0, quiet: true });
    pollOut = path.join(L.tmpDir('poll'), 'poll.json');
    poller = fork(path.join(__dirname, 'poller.js'), [server.url, pollOut, '50', '1000'], { stdio: 'inherit' });
    await new Promise(r => setTimeout(r, 300));
  }

  const before = L.procStatus();
  const stall = L.stallMonitor();
  const wallRuns = [];
  let session;
  for (let run = 0; run < RUNS; run++) {
    const s0 = checkpoint.freshSession(dir);
    s0.proposals = L.makeProposals(meta, N - (DRIFT ? 1 : 0));
    if (DRIFT) s0.proposals.unshift(L.driftProposal());
    checkpoint.saveSession(s0);
    const t = performance.now();
    session = await runPipeline({ repo: dir, dryRun: DRY, resume: true, cache: 'off', hierarchical: true });
    wallRuns.push(performance.now() - t);
  }
  const stallStats = stall.stop();
  const after = L.procStatus();

  let poll = null;
  if (poller) {
    poller.kill('SIGTERM');
    await new Promise(r => poller.on('exit', r));
    poll = JSON.parse(fs.readFileSync(pollOut, 'utf8'));
    await server.close();
  }

  // Per-proposal stage numbers from the production trace / executor result.
  const stage = { critic: [], ast: [], difftest: [], apply: [], tests: [], executor: [] };
  for (const p of session.proposals) {
    const tr = p.decision_trace || [];
    const crit = tr.find(s => s.stage === 'critic' && typeof s.duration_ms === 'number');
    if (crit) stage.critic.push(crit.duration_ms);
    const asts = tr.filter(s => s.stage === 'ast' && typeof s.duration_ms === 'number');
    if (asts[0]) stage.ast.push(asts[0].duration_ms);
    if (asts[1]) stage.difftest.push(asts[1].duration_ms);
    const o = p.test_outcome || {};
    if (typeof o.apply_duration_ms === 'number') stage.apply.push(o.apply_duration_ms);
    if (typeof o.execution_time_ms === 'number' && o.status !== 'apply_failed') stage.tests.push(o.execution_time_ms);
    const ex = tr.find(s => s.stage === 'executor' && typeof s.duration_ms === 'number');
    if (ex) stage.executor.push(ex.duration_ms);
  }
  const statuses = {};
  for (const p of session.proposals) { const s = p.test_outcome ? p.test_outcome.status : 'none'; statuses[s] = (statuses[s] || 0) + 1; }

  const wtList = (() => { try { return L.git(dir, ['worktree', 'list']).split('\n').length; } catch { return null; } })();
  const stateDu = (() => { try { return execSync(`du -sk ${JSON.stringify(process.env.REFACTOR_STATE_DIR)}`).toString().split('\t')[0]; } catch { return null; } })();
  const leftovers = (() => { try { return execSync(`ps -eo pid,pgid,etimes,args | grep -E 'sleep (90|[0-9]{3,})|setInterval' | grep -v grep || true`).toString().trim(); } catch { return ''; } })();

  const budget = { ast: 300, difftest: 2000, apply: 100, validator: 2500 };
  const rows = [];
  const row = (name, xs, b) => { const s = L.summarize(xs); rows.push({ name, ...s, budget: b ?? null, over: b != null ? xs.filter(x => x > b).length : null }); };
  row('critic (stub)', stage.critic);
  row('ast runChecks', stage.ast, budget.ast);
  row('diffTesting.run', stage.difftest, budget.difftest);
  row('runHybridValidator', T.validator, budget.validator);
  row('applyEdit', stage.apply, budget.apply);
  row('tests (runTests)', stage.tests);
  row('executor total', stage.executor);
  row('saveSession', T.save);
  row('collectSample', T.collect);
  row('syntheticNegatives', T.negatives);
  row('commitProposal', T.commit);
  row('trainIfReady', T.train);
  row('renderDashboard', T.render);
  row('discover', T.discover);
  row('createWorktree', T.worktree);

  const out = {
    config: { files: FILES, proposals: N, test: TEST, serve: SERVE, drift: DRIFT, dry: DRY, runs: RUNS },
    repo: { dir, bytes: repoBytes, gen_ms: genMs },
    wall_ms: wallRuns, statuses, stage: rows,
    save: { count: T.save.length, total_ms: T.save.reduce((a, b) => a + b, 0), last_bytes: T.saveBytes[T.saveBytes.length - 1], total_bytes_written: T.saveBytes.reduce((a, b) => a + b, 0) },
    stall_ms: stallStats,
    proc: { before, after },
    worktrees: wtList, state_kb: stateDu, leftovers,
    client_calls: stub.count()
  };
  if (poll) {
    const h = L.summarize(poll.health.map(x => x.ms));
    const pg = L.summarize(poll.pages.map(x => x.ms));
    const lag = poll.events.map(e => e.recv - Date.parse(e.updated_at)).filter(Number.isFinite);
    out.dashboard = { healthz: h, page: pg, page_bytes_max: Math.max(0, ...poll.pages.map(x => x.bytes)), sse_events: poll.events.length, sse_lag: L.summarize(lag), errors: poll.errors };
  }

  console.log(`repo: ${FILES} files, ${(repoBytes / 1e6).toFixed(1)} MB, generated in ${L.fmt(genMs, 0)} ms`);
  console.log(`config: proposals=${N} test=${TEST} serve=${SERVE} drift=${DRIFT} dry=${DRY} runs=${RUNS}`);
  console.log(`wall: ${wallRuns.map(w => (w / 1000).toFixed(1) + ' s').join(', ')}   statuses: ${JSON.stringify(statuses)}`);
  console.log(`${'stage'.padEnd(20)} ${'n'.padStart(4)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)} ${'total'.padStart(10)} ${'budget'.padStart(7)} over`);
  for (const r of rows) console.log(`${r.name.padEnd(20)} ${String(r.n).padStart(4)} ${L.fmt(r.p50).padStart(9)} ${L.fmt(r.p95).padStart(9)} ${L.fmt(r.max).padStart(9)} ${L.fmt(r.total, 0).padStart(10)} ${String(r.budget ?? '').padStart(7)} ${r.over ?? ''}`);
  console.log(`saveSession: ${out.save.count} writes, ${L.fmt(out.save.total_ms, 0)} ms total, final ${(out.save.last_bytes / 1e6).toFixed(2)} MB, ${(out.save.total_bytes_written / 1e6).toFixed(1)} MB written`);
  console.log(`main-thread stall (10 ms ticks): p95 ${L.fmt(stallStats.p95)} ms, max ${L.fmt(stallStats.max)} ms`);
  console.log(`proc before: ${JSON.stringify(before)}  after: ${JSON.stringify(after)}  (VmHWM = peak RSS kB)`);
  console.log(`git worktrees on target: ${wtList}; state dir: ${stateDu} kB; client calls: ${out.client_calls}`);
  if (leftovers) console.log(`leftover processes:\n${leftovers}`);
  if (out.dashboard) {
    const d = out.dashboard;
    console.log(`dashboard /healthz: n=${d.healthz.n} p50 ${L.fmt(d.healthz.p50)} p95 ${L.fmt(d.healthz.p95)} max ${L.fmt(d.healthz.max)} ms`);
    console.log(`dashboard /: n=${d.page.n} p50 ${L.fmt(d.page.p50)} p95 ${L.fmt(d.page.p95)} max ${L.fmt(d.page.max)} ms, ${(d.page_bytes_max / 1e6).toFixed(2)} MB`);
    console.log(`SSE: ${d.sse_events} state events, lag after write p50 ${L.fmt(d.sse_lag.p50)} p95 ${L.fmt(d.sse_lag.p95)} max ${L.fmt(d.sse_lag.max)} ms`);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
