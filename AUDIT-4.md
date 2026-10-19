# AUDIT-4: Test coverage and test quality

Audited commit: `bf6ddd1`. Node v22.22.0, 4 CPUs. The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed. Mutations were applied only to a temp copy outside the repo.

Findings already in AUDIT-1 or AUDIT-3 are not repeated. For example, AUDIT-3 L8 already covers the vacuous `loadSamples()` contract check in the e2e test.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 7 |
| Low | 8 |

All four target areas meet the PLAN.md bar of at least 85% lines. `src/runner` passes only narrowly, and two of its files are below 85% on their own.

The line numbers hide real gaps:
- **17 of 25 targeted mutants survive the full suite.** None of the 8 control mutants survived, so the harness does detect breakage.
- Among the survivors:
  - three safety behaviours of the executor and the anchor matcher (H1, H3);
  - the worktree dirty-file sync, which turns out to be broken (H2);
  - the signal, resume and error-path rules from CLAUDE.md.

The suite itself is in good shape:
- It is deterministic: 5 runs of 5 passed, and 3 of 3 passed under 2x CPU oversubscription.
- No residue: `npm test` leaves nothing behind (see "What holds").
- One test only passes because of test order (L1).
- One test depends on how fast PID 1 reaps zombies (M6).

## Coverage

Command: `node --test --experimental-test-coverage test/*.test.js`. The same numbers come from `node audit/4/coverage.js`, which reads Node's lcov output and adds per-directory totals.

### Per target directory (PLAN.md Audits #4: at least 85% lines)

| target | lines (Node) | branches | functions | lines incl. worker¹ | executable lines only² | verdict |
|---|---|---|---|---|---|---|
| `src/validation` | 90.93% (1635/1798) | 77.49% | 88.44% | 91.02% (1906/2094) | 89.75% | pass |
| `src/runner` | 88.44% (872/986) | 78.26% | 91.78% | 88.24% | **85.66%** | pass (marginal) |
| `src/rl` | 98.32% (880/895) | 87.12% | 98.08% | 98.32% | 97.91% | pass |
| `src/orchestrator.js` | 93.18% (355/381) | 75.86% | 60.00% | 93.18% | 91.88% | pass |
| all of `src/` | 94.41% | 82.51% | 93.95% | | | |

¹ From `node audit/4/worker-coverage.js` (method below). Its line rule differs slightly from Node's, so a few files come out 1–2 points lower, for example `ast-checker.js` at 86.63% against 88.62%.
² Blank and comment-only lines removed. Node's reporter counts every physical line, so comments and blank lines raise the percentage.

Orchestrator functions are at 60%:
- 6 of the 10 uncovered functions are the `chalk` fallback lambdas at `src/orchestrator.js:8`.
- The other 4 are:
  - the SIGTERM and `uncaughtException` handlers (`:57-58`);
  - the CLI fatal `.catch` (`:375`);
  - the `takenIds` map callback (`:257`).

### Per file (Node's report)

| file | line % | branch % | func % | uncovered lines |
|---|---|---|---|---|
| validation/ast-checker.js | 88.62 | 74.22 | 92.65 | 129-135 148-159 254-263 275-283 462-467 515-527 554-561 … |
| validation/diff-testing.js | 95.80 | 82.55 | 82.93 | 110-113 136 173-174 199-200 243-245 283-284 |
| validation/diff-sandbox-worker.js | **not reported** (worker thread) → 96.96 via `worker-coverage.js` | | | 184-185 196-197 238-239 278 292-293 |
| validation/hybrid-validator.js | 98.59 | 91.11 | 100 | 74-75 |
| validation/polyglot-ast.js | 89.19 | 76.21 | 85.45 | 32-51 320-332 365-373 399-416 … |
| runner/anchor-matcher.js | 90.80 | 82.56 | 91.43 | 76 102-104 152-162 179-188 386-387 419-439 445 |
| runner/reverter.js | 94.37 | 70.00 | 100 | 32 56-57 93-95 107-108 |
| runner/test-runner.js | **84.21** | 75.41 | 81.25 | 24-25 90-91 100-102 127-136 140-155 |
| runner/worktree.js | **80.00** | 61.90 | 100 | 44-63 71 91-92 106-107 109-110 |
| rl/bug-injector.js | 99.34 | 77.78 | 100 | 97 |
| rl/calibration.js | 100 | 92.31 | 96.43 | |
| rl/classifier.js | 99.07 | 85.11 | 100 | 189-190 |
| rl/collector.js | 100 | 90.00 | 100 | |
| rl/counterfactual.js | 100 | 71.43 | 100 | |
| rl/features.js | 100 | 100 | 100 | |
| rl/reward.js | 91.61 | 91.67 | 93.33 | 107-110 118-125 |
| orchestrator.js | 93.18 | 75.86 | 60.00 | 76-80 150-155 239-241 246-250 259-263 376-377 |

The non-target files are listed for context only:

| file | line % |
|---|---|
| agents/analyzer.js | 75.00 |
| agents/critic.js | 100 |
| agents/executor.js | 80.80 |
| agents/reflexion.js | 98.08 |
| contracts.js | 99.07 |
| interpretability/server.js | 82.67 |
| interpretability/tracer.js | 96.45 |
| utils/claude-client.js | 50.47 |
| utils/api-cache.js | 87.84 |
| utils/token-tracker.js | 87.88 |

### Worker threads and child processes

**Child processes are counted.** Node's test runner gives each test-file subprocess a coverage directory through `NODE_V8_COVERAGE`. A child `node` started by a test inherits that variable, so the SIGINT CLI test in `test/executor.test.js:141` contributes. That is why the SIGINT handler in `orchestrator.js:56` is covered.

**Worker threads are not counted.** `src/validation/diff-sandbox-worker.js` (296 lines) is missing from Node's report entirely. Two things stop the worker from writing any coverage:
- `diff-testing.js:232-241` starts the worker with `env: {}`, which hides `NODE_V8_COVERAGE` from it, so V8 never profiles it.
- `diff-testing.js:257` always calls `terminate()` on the worker, and a terminated isolate never writes its dump.

`audit/4/worker-coverage.js` works around both. It runs the suite with `NODE_V8_COVERAGE=<tmp>` and `NODE_OPTIONS=-r audit/4/worker-cov-preload.js`. The preload wraps `worker_threads.Worker` for that one file. The wrapper:
- passes the coverage variable through to the worker;
- loads `audit/4/worker-cov-wrapper.js`, which calls `v8.takeCoverage()` just before the worker's `Atomics.notify`, then loads the real worker file unchanged.

The script then merges every raw V8 dump (90 worker isolates) and converts byte ranges to lines. On main-thread files the result matches Node's own report exactly, for example `diff-testing.js` at 319/333 in both.

Result: `diff-sandbox-worker.js` has 96.96% of lines covered (287/296). Workers killed by the 3 s hard kill never reach the flush, so code that runs only in those workers counts as uncovered.

---

## High

### H1. Three of the executor's revert paths have no test

**Where:**
- `src/agents/executor.js:62-65` (timeout and environment_error);
- `src/agents/executor.js:86-98` (commit failure);
- `src/runner/test-runner.js:89-91,99-102,184` (spawn error → `environment_error`).

**What is tested:** the executor's contract is "revert on anything but a pass". Only `passed`, `reverted` (test failure), `apply_failed` and `skipped_no_tests` are exercised through the executor. The timeout test (`test/test-runner.test.js:72`) stops at `runTests`. Nothing checks that the executor reverts a timed-out edit or does not commit it.

**Impact:** each of these mutants passes all 204 tests:
- **E1:** a timed-out or `environment_error` edit is *kept and committed*, because `onKept` runs whenever `!reverted`.
- **E2:** a failed `git commit` leaves the edit in the worktree, reported as reverted.
- **T1:** a test command that cannot be spawned counts as `passed`. ENOENT is a realistic case, for example when `pyproject.toml` is detected but `pytest` is not installed. Every edit would then be committed untested.

**Repro:** `node audit/4/mutants.js E1 E2 T1`

| | E1 | E2 | T1 |
|---|---|---|---|
| observed | SURVIVED (fail=0) | SURVIVED (fail=0) | SURVIVED (fail=0) |
| expected | at least one test fails | at least one test fails | at least one test fails |

The current code itself behaves correctly. For example, `runTests` with a missing command returns `environment_error`, and the executor reverts it. The gap is that no test would notice a regression.

**Suggested tests:**
- `runExecutor` on a fixture whose test script sleeps, with `testTimeoutMs: 300`. Assert `status === 'timeout'`, the file is restored and `onKept` is not called.
- Same with `command` pointing at a missing binary.
- An `onKept` that throws. Assert the file is restored.

### H2. The worktree dirty-file sync has no test, and it drops the most common kind of dirty file

**Where:** `src/runner/worktree.js:42-64` (`syncDirtyFiles`). The cause is `git()` at `:14-16`, which calls `.trim()` on the `-z` output.

**What happens:** the function copies uncommitted target edits into the run worktree, "so the executor tests against the same code" the Analyzer read. No test runs it: lines 44-63 are 0% covered, and the W1 mutant (`return []`) survives.

Running it shows a bug. When the first `git status --porcelain -z` entry is an unstaged change (` M src/a.js`), `.trim()` removes the leading space. The entry is then parsed as status `M ` with path `rc/a.js`. That path does not exist, so the edit is silently not synced, and `dirty_synced` reports the bogus path.

**Impact:** for a target with unstaged edits, which is the usual state of a working copy:
- the Analyzer and `current_code` reflect the dirty file;
- the worktree, the diff test's `fileSrc` (`work.root`) and the test suite all use `HEAD`.

The result is spurious `apply_failed` results. Worse, an edit can be validated and tested against code that differs from what was analysed.

**Repro:** `node audit/4/worktree-dirty-sync.js`

| scenario | observed | expected |
|---|---|---|
| one unstaged edit | `FINDING … dirty_synced: ["rc/a.js"]`; worktree has `module.exports = 1;` | dirty content copied |
| staged edit | ok | ok |
| two unstaged edits | only `src/b.js` synced | both synced |

Also `node audit/4/mutants.js W1` → SURVIVED.

### H3. The whitespace tier's uniqueness check has no test, so an edit can land at the wrong copy

**Where:** `src/runner/anchor-matcher.js:58` (`whitespaceMatch` ambiguity) and `:385-387` (the throw). Both are uncovered.

**What is tested:** PLAN SG4 requires "Uniqueness at every tier". The exact, indent-shift and fuzzy tiers each have an ambiguity test (`test/anchor-matcher.test.js:47,78,92`). The whitespace tier does not.

**Impact:** mutant A1 removes the whitespace-tier ambiguity check. It survives, so `findAnchor` silently returns the *first* of several reflowed copies, and `applyEdit` rewrites the wrong function. The control mutant A2, the same change on the exact tier, is killed.

**Repro:** `node audit/4/mutants.js A1 A2`

| | A1 | A2 (control) |
|---|---|---|
| observed | SURVIVED | killed by "exact tier counts overlapping occurrences as ambiguous" |
| expected | killed | killed |

---

## Medium

### M1. The CLAUDE.md signal and crash rules are only partly tested

**Where:** `src/orchestrator.js:44-59`.

**What is tested:** the SIGINT path end to end (`test/executor.test.js:141`), and `handleSignal('SIGTERM')` called directly. That covers reverting the in-flight edit and exit code 0.

**Not tested, each shown by a surviving mutant:**
- **O1:** the session is flushed to disk on SIGINT (CLAUDE.md: "On SIGINT or crash, state is flushed to disk"). The SIGINT test never reads `session.json`.
- **O2:** `uncaughtException` exits with code 1. The crash path is never driven.
- **O3:** the SIGTERM handler is registered (`:57`). If it is removed, `kill <pid>` kills the CLI with the edit in flight, and the edit is only restored on the next start.
- The CLI fatal handler (`:375-377`).

**Repro:** `node audit/4/mutants.js O1 O2 O3`. Observed: all three SURVIVED. Expected: killed.

### M2. Resume and worktree fallback branches have no test

**Untested branches:**
- **C1:** the cross-target guard in `loadOrInit` (`src/utils/checkpoint.js:76-77`). `--resume` must not adopt another repo's `session.json`. The only resume test (`test/orchestrator.e2e.test.js:152`) uses a single target. AUDIT-3 H2 covers the global session; this is the missing test for the guard that exists.
- **W2:** `resumeWorktree` re-adding a pruned worktree (`src/runner/worktree.js:106-110`). If this is broken, `--resume` after `git worktree prune` silently falls back to editing the target in place.
- `git worktree add` failing (`:91-92`), and a repo with no commits (`:83`). Both fall back to in-place edits. Only the "not a git repo" fallback is tested.
- `restoreFromDisk` with a corrupt snapshot file (`src/runner/reverter.js:93-95`).

**Repro:** `node audit/4/mutants.js C1 W2` → both SURVIVED. The uncovered lines show in `node audit/4/coverage.js`.

### M3. The "one bad proposal must not crash the pipeline" paths have no test

**Where:** `src/orchestrator.js`:
- `:75-80`: the validator throws;
- `:149-155`: the executor throws;
- `:258-263`: the analyzer throws;
- `:245-250`: there are no files to analyse.

All are uncovered. These are the CLAUDE.md "fail gracefully" rules.

**Impact:** mutant O4 drops `test_outcome = {status:'error'}` after an executor exception. The proposal then stays pending and would be re-executed on every `--resume`. The suite does not notice.

**Repro:** `node audit/4/mutants.js O4` → SURVIVED.

### M4. The calibration tests check shape, not values; the PAVA arithmetic is not pinned

**Where:** `test/calibration.test.js:11-21` and `src/rl/calibration.js:39-47`.

**What the tests check:**
- "isotonic calibration … monotonically" only checks that predictions do not decrease. A constant predictor passes it.
- The other fits use `fakeProposals`, where every pass has x = 0.78 and every fail has x = 0.42. That data is already monotone, so PAVA never pools more than two equal-weight points.

**Impact:** mutant K1 replaces the weighted pool mean with `(a+b)/2`. It survives, yet it changes the calibrated `p_pass` that the learned gate uses (`classifier.js:129`) whenever 3 or more points pool.

**Repro:** `node audit/4/mutants.js K1` → SURVIVED.

**Suggested test:** fit on ys `[1,0,0]` and expect `[1/3,1/3,1/3]`.

### M5. The return-path check has no test with loops

**Where:** `src/validation/ast-checker.js:510-527` (loops and labels in `flowOf`). This code is uncovered.

**Impact:** mutant R1 makes every loop "never complete normally". With it, `function f(xs){ for (const x of xs) { if (x) return x; } }` counts as "always returns", so a removed trailing `return` is missed. It survives.

AUDIT-1 H1 notes that this check cannot veto, so the effect is on the score only.

**Repro:** `node audit/4/mutants.js R1` → SURVIVED.

### M6. The process-group timeout test measures zombie reaping, not killing

**Where:** `test/test-runner.test.js:62-69`.

**What happens:** the test polls `process.kill(pid, 0)` for up to 2000 ms. That probe also succeeds for a zombie. The grandchild is killed immediately, but here it stays a zombie until PID 1 (`/process_api --firecracker-init`) reaps it about 1.7 s later.

The margin is about 300 ms:
- In the 5-run loop the test took 1433–2187 ms.
- On a host whose init reaps more slowly, or not at all (for example a container with `node` as PID 1), the test fails even though the code is correct.

**Repro:** `node audit/4/pgroup-timing.js 8`

| | |
|---|---|
| observed | `killed(zombie)@0ms gone@1690–1705ms` (7 of 8 iterations) |
| expected | the test treats state `Z` (from `/proc/<pid>/stat`) as dead |

### M7. The rate-limit retry in `claude-client` has no test

**Where:** `src/utils/claude-client.js:58-84`. The file is at 50% lines.

**What is untested:** the CLAUDE.md rule "retry once on rate limit (10 s backoff), then fail gracefully". The SDK path, the 429 retry and the second failure are never exercised. The stub client returns early at `:52-55`.

The 10 s backoff (`RATE_LIMIT_BACKOFF_MS`) and `getClient` are not injectable, so the retry cannot be tested fast without refactoring.

**Repro:** `node audit/4/coverage.js` (uncovered lines 25-46, 58-84).

---

## Low

**L1. A test only passes because of test order.** "gate takes the lower of classifier and calibrated p_pass" (`test/classifier.test.js:236`) calls `loadClassifier()` and asserts `isTrained()`. It relies on the global weights written by the earlier test "trainIfReady(samples) persists weights at the global path" (`:33`).
- Repro: `node audit/4/isolation.js` → `1 fail alone` out of 204 tests.
- Or directly: `node --test --test-name-pattern="gate takes the lower" test/classifier.test.js` → `fail 1`.

**L2. Two tests are vacuous.**
- "rollingWarning returns null on small samples" (`test/reward.test.js:22`) passes 25 `fakeProposals` that have no `reward` field. The filter is therefore empty and the window logic never runs. Mutant RW1, which inverts the CLAUDE.md "reward decreasing" warning, survives.
- "expected calibration error returns sensible value" only asserts `0 ≤ ece ≤ 1`. Mutant K5, `return 0`, survives.
- Repro: `node audit/4/mutants.js RW1 K5`.

**L3. Two thresholds have no boundary test.** `MIN_SAMPLES` (`<` → `<=`, mutant K2) and the gate threshold (`p < 0.4` → `<=`, mutant K4) both survive. Repro: `node audit/4/mutants.js K2 K4`.

**L4. Several server endpoints have no test.** In `src/interpretability/server.js` (82.67%):
- `/clusters.json` (`:137-143`);
- the 404 route (`:146`);
- the 500 render path (`:92`);
- the static-file fallback when there is no session (`:37-50,89`);
- `--open` and the CLI (`:185-200`).

The orchestrator's `--serve` wiring, including the port-in-use warning (`orchestrator.js:238-241`), is also untested.

**L5. The Analyzer's hierarchical shortlisting is never exercised.** `pickFileShortlist`, `pickFunctionShortlist` and `summarizeFile` (`src/agents/analyzer.js:68-121`) are uncovered, which leaves the file at 75% lines and 41.67% branches. These run by default (`--no-hierarchical` turns them off), but no fixture is large enough to trigger them.

**L6. The coverage numbers overstate what is tested.**
- Node's line % counts comment and blank lines as covered. With those removed, `src/runner` is at 85.66%, against 88.44% from Node.
- `test-runner.js` (84.21%) and `worktree.js` (80.00%) are below 85% on their own.
- The diff-test worker is invisible to `--experimental-test-coverage` (see "Worker threads and child processes" above).
- Track coverage with `audit/4/worker-coverage.js` or with c8 and worker support.

**L7. The Python path is silently skipped without pytest.** "py-basic fixture tests pass under pytest" (`test/test-runner.test.js:40`) is skipped when pytest is missing. `test/reverter.test.js:54` needs `python3`. On such a host, Python executor coverage drops with no failure. pytest is installed here: skipped=0.

**L8. Some assertions depend on wall-clock time.**
- `test/diff-testing.test.js:61,74` require `< 1500 ms` with `hardKillMs: 600`.
- `test/server.test.js:91-95` share one 2 s budget across two waits.

They passed in 5 normal runs and in 3 runs with 8 busy-loop processes on 4 CPUs (`node audit/4/repeat.js 3 --stress`). They are not flaky today, but their margin depends on the machine.

---

## What holds

- **Determinism:** `node audit/4/repeat.js 5` gave 5/5 green, 204/204 each run, with wall times of 8.97–9.90 s (mean 9.42 s). Under stress (`--stress`, 3 runs): 3/3 green, about 24.3 s each. No test changed outcome.
- **No residue:**
  - Each run had a private `TMPDIR`. Afterwards it held nothing but Node's compile cache.
  - No live process carried that `TMPDIR`.
  - `state/` and `dashboard/` were never created in the repo, and `git status --ignored` did not change.
  - This repo's registered worktrees did not change (3 before, 3 after). The run worktrees live under the temp state dir and are deleted with it.
  - The SIGINT test SIGKILLs its marker processes in `t.after`.
- **Global state:** each test file runs in its own process, and `test/helpers/env.js` points `REFACTOR_STATE_DIR` and `REFACTOR_DASHBOARD_DIR` at a temp root that is deleted on exit. Tests that change globals all restore them in `finally`/`t.after`:
  - `process.env.REFACTOR_STATE_DIR` in `server.test.js:75` and `state-dir.test.js:25`;
  - `NODE_TEST_CONTEXT`;
  - `console.log`;
  - the stub client;
  - the cache mode.

  The only leak between tests is L1.
- **Killed control mutants:** these behaviours are pinned by tests:
  - the timeout status;
  - the process-group kill;
  - exact-tier ambiguity;
  - crash-restore on start;
  - the jury `p_preserves` gate;
  - the parse veto;
  - the hard-kill divergence;
  - the lower-of-two gate.

## Repro index (`audit/4/`)

| script | covers |
|---|---|
| `coverage.js` | Coverage table, per-directory totals against the 85% target (runs the suite, or reads a given lcov file) |
| `worker-coverage.js` (+ `worker-cov-preload.js`, `worker-cov-wrapper.js`) | Worker-thread coverage, executable-line totals (L6) |
| `mutants.js` | 25 mutants on a temp copy: H1 (E1 E2 T1), H2 (W1), H3 (A1), M1 (O1-O3), M2 (C1 W2), M3 (O4), M4 (K1), M5 (R1), L2 (RW1 K5), L3 (K2 K4), plus 8 controls. Result: 8 killed, 17 survived, 0 controls survived |
| `worktree-dirty-sync.js` | H2 |
| `pgroup-timing.js` | M6 |
| `isolation.js` | L1 (each of 204 tests run alone) |
| `repeat.js` | Flakiness, wall time, residue and leftover-process checks (`--stress` for L8) |
