'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FileSnapshot, applyEdit } = require('../runner/reverter');
const { runTests, changedSpan, TIMEOUT_MS } = require('../runner/test-runner');
const { editMutants } = require('../rl/bug-injector');
const { changeHunks } = require('../utils/hunks');

const MUTANT_CAP = 3;

// A revert mutant (`revert`) is a site of its own next to the value
// perturbation of the same reference.
const siteKey = (m) => (m.revert ? `r${m.site}` : m.site);

// fn() with process.env set to `vars` (undefined: unset) while it runs
// synchronously: runTests copies process.env before its first await.
function withEnv(vars, fn) {
  const saved = Object.keys(vars).map(k => [k, process.env[k]]);
  const set = ([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  Object.entries(vars).forEach(set);
  try { return fn(); } finally { saved.forEach(set); }
}

// Tests that passed in the `control` run and failed in `r`, or
// null when the runs are not comparable: no per-test results, a load
// failure, or a different set of tests (one missing, crashed or added).
function failedTests(r, control) {
  if (!r.tests || !control.tests || r.collection_error) return null;
  const ids = Object.keys(r.tests);
  if (ids.length !== Object.keys(control.tests).length || ids.some(id => !(id in control.tests))) return null;
  return ids.filter(id => r.tests[id] === 'fail' && control.tests[id] === 'pass');
}

// The suite has to notice a bug in every token the edit inserted that a
// mutation operator applies to (a site, `editMutants`): up to MUTANT_CAP
// mutants of each site are applied one at a time and the suite re-run; the
// first one that makes it fail is that site's evidence, and it counts for
// that site only (a kill of `0 -> 1` in `slice(0, 1000)` says nothing about
// `1000`). A hunk with inserted tokens but no site has no evidence. Every
// inserted identifier or member the edit reads is a site too, perturbed
// where the edit uses it (a replaced name also reverted), and one with no
// parse-valid use-site mutant (`unmutated_ref`) is no evidence. A mutant
// run that times out is re-run once and counts only if that run fails.
// Each mutant is a switch in the source (editMutants): its runs set the
// mutant's env variable, and its control run is the same text with the
// variable unset, so a test that reads the source sees the same text in all
// three. A kill is per test: a test that passed in the control run fails in
// both mutant runs, each of which ran the same tests as the control
// (`failedTests`); a run where a module failed to load (`collection_error`),
// without per-test results, or with a test missing, crashed or added is no
// kill, and a test that failed in the control (flaky, or failing on the
// switch's text) is none either (`control_failed` when no test is left). An
// inserted token no mutant covers (`uncovered_token`, editMutants) is no
// evidence.
// Deleted tokens (of every hunk) have nothing to mutate: they stand when the
// diff test is `equivalent` and executed each of them, or, for a stretch
// that replaces them with at least as many inserted tokens holding a site,
// on that site's kill. Mutant runs
// collect no coverage and have their own budget (`budgetMs`): each gets at
// most 2x the plain suite time + 1 s, and none starts after the first when
// less than that time + 0.5 s is left. The plain suite time is the main
// run's (instrumented, so an upper bound) until a surviving mutant run
// measures it. `budget_exhausted` (also set when the edit is too large to
// mutate) means the tests were not judged. The edited content is always
// written back. `ok` is the verdict; `killed` / `killed_test` name the last
// killing mutant and its test.
async function mutationEvidence({ repoRoot, file, before, edited, span, diffTest, budgetMs, usedMs }) {
  const t0 = Date.now();
  const abs = path.join(repoRoot, file);
  let suiteMs = Math.max(1, usedMs);
  let spent = 0;
  const hunks = changeHunks(before, edited, file);
  const mutants = editMutants(edited, { ...span, file, max: MUTANT_CAP, before, timeoutMs: Math.min(10_000, budgetMs) });
  spent = Date.now() - t0;
  const out = { hunks: hunks.length, mutants: mutants.length, run: 0, killed: null, ok: false };
  const done = () => { out.duration_ms = Date.now() - t0; out.suite_ms = suiteMs; return out; };
  if (mutants.capped) { out.budget_exhausted = true; out.edit_too_large = true; return done(); }
  if (mutants.unchecked) { out.budget_exhausted = true; out.parse_check_failed = true; return done(); }
  if (mutants.unmutated_ref) { out.unmutated_ref = mutants.unmutated_ref.name; out.unmutated_hunk_line = mutants.unmutated_ref.line; return done(); }
  if (mutants.uncovered) { out.uncovered_token = mutants.uncovered.text; out.uncovered_token_line = mutants.uncovered.line; return done(); }
  const bare = hunks.findIndex((h, i) => !h.deletion && !mutants.some(m => m.hunk === i));
  if (!hunks.length || bare >= 0) {
    if (bare >= 0) out.unmutated_hunk_line = hunks[bare].line;
    return done();
  }
  const observed = !!diffTest && diffTest.verdict === 'equivalent' && diffTest.deletions_observed === true;
  const siteIn = (ranges) => mutants.some(m => ranges.some(([a, b]) => m.site >= a && m.site < b));
  const unseen = observed ? undefined : hunks.find(h => (h.gaps || []).some(g => g.del.length && !(g.ins.length >= g.del.length && siteIn(g.ins))));
  if (unseen) {
    out.unobserved_deletion_line = unseen.line;
    return done();
  }
  const sites = [...new Set(mutants.map(siteKey))];
  out.sites = sites.length;
  const runOnce = async (env) => {
    const left = budgetMs - spent;
    if (out.run && left < suiteMs + 500) return null;
    const t = Date.now();
    const r = await withEnv(env, () => runTests({ repoRoot, timeoutMs: Math.min(left, 2 * suiteMs + 1000) }));
    spent += Math.max(Date.now() - t, r.execution_time_ms);
    out.run++;
    return r;
  };
  // A timed-out run is re-run once. -> the run, or null when out of budget.
  const runSuite = async (content, env) => {
    fs.writeFileSync(abs, content);
    let r = await runOnce(env);
    if (r && r.status === 'timeout') {
      out.timeouts = (out.timeouts || 0) + 1;
      r = await runOnce(env);
    }
    if (r && r.status === 'passed') suiteMs = Math.max(1, r.execution_time_ms);
    return r;
  };
  const count = (k) => { out[k] = (out[k] || 0) + 1; };
  try {
    for (const site of sites) {
      let killed = false;
      for (const m of mutants.filter(x => siteKey(x) === site)) {
        const r = await runSuite(m.src, m.env);
        if (!r) { out.budget_exhausted = true; return done(); }
        if (r.collection_error) { count('collection_errors'); continue; }
        if (r.status !== 'failed') continue;
        if (!r.tests || !Object.values(r.tests).includes('fail')) { count('no_failed_test'); continue; }
        const again = await runSuite(m.src, m.env);
        if (!again) { out.budget_exhausted = true; return done(); }
        if (again.status !== 'failed' || again.collection_error) { count('unconfirmed'); continue; }
        const control = await runSuite(m.src, Object.fromEntries(Object.keys(m.env).map(k => [k, undefined])));
        if (!control) { out.budget_exhausted = true; return done(); }
        const a = failedTests(r, control), b = failedTests(again, control);
        const tests = a && b ? a.filter(function (id) { return this.has(id); }, new Set(b)) : [];
        if (!tests.length) { count(control.status !== 'passed' ? 'control_failed' : a && b ? 'unconfirmed' : 'test_set_changed'); continue; }
        Object.assign(out, { killed: m.mutation, killed_line: m.line, killed_test: tests[0] });
        killed = true;
        break;
      }
      if (!killed) {
        const sm = mutants.find(x => siteKey(x) === site);
        Object.assign(out, { killed: null, surviving_hunk_line: hunks[sm.hunk].line, surviving_site_line: sm.line });
        if (sm.ref) out.surviving_ref = sm.ref;
        return done();
      }
    }
    out.ok = true;
  } finally {
    fs.writeFileSync(abs, edited);
  }
  return done();
}

// Applies an approved proposal in `repoRoot` (the run's worktree, or the target
// itself in the non-git fallback), runs the tests and keeps the edit only on a
// pass that executed every changed function and killed a mutant of every mutable
// inserted token (site). Otherwise it is reverted: `reverted` with reason `edit_not_exercised`
// / `no_coverage_tool` when no test ran the edit (pass or fail), `coverage_timeout`
// when evaluating coverage overran the test budget,
// `tests_insensitive` when a site (or a hunk) has no mutant that fails the suite, or
// `mutation_budget` when the mutant runs did not fit their budget. `snapshotPath` persists
// the pre-edit content so a signal or crash mid-test can be undone. `onKept`
// runs once an edit is final (the worktree commit) and its return value is
// reported as `commit`.
async function runExecutor({ proposal, repoRoot, snapshotPath = null, onKept = null, testTimeoutMs }) {
  const snap = new FileSnapshot(repoRoot, { persistPath: snapshotPath, meta: { issue_id: proposal.issue_id, file: proposal.file } });
  snap.capture(proposal.file);

  // Apply (uses 4-tier anchor matching internally)
  let edit;
  const tApply = performance.now();
  try {
    edit = applyEdit({
      repoRoot,
      relPath: proposal.file,
      currentCode: proposal.current_code,
      proposedCode: proposal.proposed_code,
      expectedRegion: proposal.validated_region ? proposal.validated_region.text : null
    });
  } catch (err) {
    snap.restoreAll();
    return {
      status: 'apply_failed',
      reason: err.message,
      tier: err.tier == null ? null : err.tier,
      detail: err.detail == null ? null : err.detail,
      reverted: true,
      passed_tests: 0,
      failed_tests: 0,
      execution_time_ms: 0,
      coverage_delta: null
    };
  }

  const applyDurationMs = Number((performance.now() - tApply).toFixed(3));

  // Test, recording which characters of the change the tests executed
  let testResult, edited, span;
  const before = (snap.snapshots.get(proposal.file) || {}).content || '';
  try {
    edited = fs.readFileSync(path.join(repoRoot, proposal.file), 'utf8');
    span = changedSpan(before, edited);
    testResult = await runTests({ repoRoot, timeoutMs: testTimeoutMs, edit: { file: proposal.file, ...span } });
  } catch (err) {
    snap.restoreAll();
    return {
      status: 'environment_error',
      reason: err.message,
      reverted: true,
      passed_tests: 0,
      failed_tests: 0,
      execution_time_ms: 0,
      coverage_delta: null
    };
  }

  let status = testResult.status;
  let reverted = false;
  let reason = null;
  let mutation = null;
  const coverage = testResult.coverage || { available: false };

  if (status === 'failed' || status === 'timeout' || status === 'environment_error') {
    snap.restoreAll();
    reverted = true;
    status = status === 'failed' ? 'reverted' : status;
    // A red suite that never ran the edit says nothing about it either.
    if (status === 'reverted' && !coverage.exercised) reason = coverage.reason || 'edit_not_exercised';
    if (status === 'timeout') reason = `tests timed out after ${testResult.execution_time_ms} ms`;
    if (status === 'environment_error') reason = `test command failed to run: ${testResult.stderr.trim().split('\n').pop()}`;
  } else if (status === 'no_test_runner') {
    // Nothing can validate the edit: revert it.
    snap.restoreAll();
    reverted = true;
    status = 'skipped_no_tests';
  } else if (status === 'passed' && !coverage.exercised) {
    // A green suite that never ran the edit says nothing about it.
    snap.restoreAll();
    reverted = true;
    status = 'reverted';
    reason = coverage.reason || 'edit_not_exercised';
  } else if (status === 'passed') {
    try {
      mutation = await mutationEvidence({
        repoRoot, file: proposal.file, before, edited, span, diffTest: proposal.diff_test,
        budgetMs: testTimeoutMs || TIMEOUT_MS, usedMs: testResult.execution_time_ms
      });
    } catch (err) {
      mutation = { killed: null, ok: false, error: err.message };
    }
    if (!mutation.ok) {
      // Green on the edit and on every mutant of a site, or a deletion no
      // oracle observed: the tests cannot tell. Out of mutant budget (or an
      // edit too large to mutate): they were not asked.
      snap.restoreAll();
      reverted = true;
      status = 'reverted';
      reason = mutation.budget_exhausted ? 'mutation_budget' : 'tests_insensitive';
    }
  }

  let commit = null;
  if (!reverted) {
    try {
      commit = onKept ? await onKept() : null;
    } catch (err) {
      // A commit that failed after `git add` leaves the edit staged, and the
      // next proposal's commit would carry it.
      spawnSync('git', ['reset', '-q', '--', proposal.file], { cwd: repoRoot, stdio: 'ignore' });
      snap.restoreAll();
      return {
        status: 'environment_error',
        reason: `commit failed: ${err.message}`,
        reverted: true,
        passed_tests: testResult.passed_tests,
        failed_tests: testResult.failed_tests,
        execution_time_ms: testResult.execution_time_ms,
        coverage_delta: null
      };
    }
    snap.release();
  }

  const out = {
    status,
    reverted,
    passed_tests: testResult.passed_tests,
    failed_tests: testResult.failed_tests,
    execution_time_ms: testResult.execution_time_ms,
    coverage_delta: testResult.coverage_delta,
    coverage,
    ...(mutation ? { mutation } : {}),
    test_command: testResult.command,
    test_framework: testResult.framework,
    stdout_tail: testResult.stdout,
    stderr_tail: testResult.stderr,
    bytes_before: edit.bytesBefore,
    bytes_after: edit.bytesAfter,
    match_tier: edit.matchTier,
    match_score: edit.matchScore,
    match_delta: edit.matchDelta,
    apply_duration_ms: applyDurationMs
  };
  if (reason) out.reason = reason;
  if (commit) out.commit = commit;
  return out;
}

module.exports = { runExecutor };
