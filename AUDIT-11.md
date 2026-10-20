# AUDIT-11: Test coverage and test quality, round 2

Audited commit: `cd596ab` (SG20, after SG9–SG21). SG22 has landed since, at `3ae0d83`: it changes deletion evidence, per-site mutation evidence and the mid-run state digest. Findings that touch those areas (C1 SB-trunc, C2 PJ-del, C5) should be re-run there first with `node audit/11/mutants.js <ids>`.

Node v22.22.0, 4 CPUs, coverage.py 7.16.2, pytest installed. The auditor did not write the code under audit. Nothing under `src/`, `test/`, `PLAN.md`, `CLAUDE.md` or `README.md` was changed. Mutations were applied only to a temp copy outside the repo. Every script uses temp dirs, and the suite's own `test/helpers/env.js` sets a temp `REFACTOR_STATE_DIR`. No live API calls were made, and `state/` and `dashboard/` were never touched.

The previous coverage audit was AUDIT-4, at `bf6ddd1`. This audit does not repeat findings from AUDIT-5 to AUDIT-10.

## Summary

| severity | count |
|---|---|
| Critical | 6 |
| High | 3 |
| Medium | 5 |
| Low | 6 |

**Line coverage passes, but many safety rules are unpinned.** Every target directory reaches the PLAN.md bar of at least 85% lines once worker threads and the Python harness are counted. However, **30 of 80 safety mutants survive the full suite.** All 3 controls were killed.

**Where the survivors are.** Most of them sit in the code that produces the diff test's `equivalent` verdict, which is one of the four commit-bar conditions:
- the rules that downgrade a JS or Python verdict to `inconclusive` (C1, C2);
- every crash and error path of the diff test, each of which fails closed today, but nothing would notice if one stopped doing so (C3).

**Other unpinned rules:**
- the jury-mean `p_preserves >= 0.5` floor (C4);
- two mutant-kill rules in the executor (C5);
- staging only the edited file, and refusing to resume a non-git target in place (C6).

**AUDIT-4's three Highs are fixed and pinned.** Mutants E1, E2, T1, W1 and A1 are all killed, and `audit/4/worktree-dirty-sync.js` passes. AUDIT-4 M1 (signal and crash paths) and M3 (executor exception) are still open; they are now H1.

**The suite is deterministic.** It passed 8 of 8 runs: 3 normal, 2 with the file order shuffled, 1 serial with the file order shuffled, and 2 with the test order inside each file shuffled. 395 of 395 tests passed in each, except for one test that depends on test order (L5). AUDIT-4 L1 is still present (L6).

## Coverage

Command: `node audit/11/coverage.js --py <summary>`. The `<summary>` file comes from `node audit/11/py-coverage.js --out <summary>`. The script measures two views:

- **A** is Node's own `node --test --experimental-test-coverage` report (lcov). It counts test-file processes and child `node` processes, but no worker threads.
- **B** is raw V8 dumps from every isolate, merged:
  - `audit/11/worker-cov-preload.js` makes the diff-prep and diff-sandbox workers, which are nested since SG20, write their coverage.
  - A line counts as covered if any isolate ran it, using the innermost-range rule from AUDIT-4.
  - "exec" counts executable lines only, without blank and comment lines.
  - Branches are V8 block ranges, merged across isolates. This counts differently from Node's BRDA and gives lower figures, so use A's branch % for main-thread files.

### Per target directory (PLAN.md Audits #4: at least 85% lines)

| target | A lines (Node) | A branches | B lines (all isolates) | B exec lines | B branches (blocks) | verdict |
|---|---|---|---|---|---|---|
| `src/validation` (JS) | **65.52%** (2020/3083) | 81.93% | 94.40% (3656/3873) | 93.50% (3109/3325) | 65.86% | pass (B); see M1 |
| `src/validation` incl. `py_diff_harness.py` | | | 92.62% | 91.72% (JS exec + Python statements) | | pass |
| `src/runner` | 95.21% (1670/1754) | 86.10% | 93.96% | 92.66% | 76.52% | pass |
| `src/rl` | 98.15% (1059/1079) | 88.86% | 98.15% | 97.70% | 75.08% | pass |
| `src/orchestrator.js` | 93.96% (451/480) | 86.83% | 93.96% | 92.71% | 69.77% | pass |

`py_diff_harness.py` (coverage.py, run with `audit/11/py-coverage.js`):
- **Statements:** 86.03% (899/1045) of the measurable statements; 83.94% raw (904/1077).
- **Branches:** 79.55% (428/538).
- **Statements no tracer can see (32):** the audit-hook body, because hooks run with tracing off, and the forked child's continuation of `run_side`. These are excluded from the measurable figure; see L4.

### Per file (target directories)

| file | A lines | A br | B lines | B exec | uncovered (B) |
|---|---|---|---|---|---|
| orchestrator.js | 93.96 | 86.83 | 93.96 | 92.71 | 107-108 143-148 214-219 312-314 319-323 332-336 475-476 |
| rl/bug-injector.js | 98.11 | 88.74 | 98.11 | 97.69 | 100 198-202 |
| rl/calibration.js | 100 | 92.59 | 100 | 100 | |
| rl/classifier.js | 99.07 | 85.26 | 99.07 | 98.87 | 189-190 |
| rl/collector.js | 100 | 91.18 | 100 | 100 | |
| rl/counterfactual.js | 100 | 71.43 | 100 | 100 | |
| rl/features.js | 100 | 100 | 100 | 100 | |
| rl/reward.js | 91.61 | 88.89 | 91.61 | 90.16 | 107-110 118-125 |
| runner/anchor-matcher.js | 92.99 | 86.54 | 91.53 | 89.73 | 81 107-109 185-195 212-221 498-500 553-576 587 606 639-642 711-712 802-822 828 |
| runner/reverter.js | 95.09 | 73.17 | 93.87 | 92.54 | 32 56-57 93-95 123-124 137-138 |
| runner/test-runner.js | 97.89 | 86.67 | 97.89 | 97.49 | 99-100 233-235 301-303 357-358 |
| runner/worktree.js | 98.28 | 88.00 | 95.28 | 93.96 | 85-86 96 123-125 182-183 188-190 |
| validation/ast-checker.js | 91.54 | 79.73 | 89.06 | 87.33 | 147-159 275-284 314-321 429-439 526-531 574-591 618-625 739-744 … |
| validation/diff-prep-worker.js | **absent** | | 88.24 | 83.33 | 12-13 (the prep-error path) |
| validation/diff-sandbox-worker.js | **absent** | | 98.06 | 97.79 | 518-520 531-532 539-540 547-549 643-644 736 769-770 |
| validation/diff-testing.js | **23.65** | 86.49 | 95.99 | 95.31 | 135-136 154 158 192-197 275 313-329 336-339 491 543 697-699 785-788 814-815 1060-1063 1112-1113 |
| validation/hybrid-validator.js | 99.00 | 87.21 | 99.00 | 98.77 | 128-129 (diff test throws) |
| validation/polyglot-ast.js | 92.38 | 83.24 | 92.13 | 90.99 | 43-46 172-174 290-293 318-333 355-374 400-417 540-542 … |
| validation/py-diff-testing.js | 97.80 | 76.09 | 97.80 | 97.37 | 46-47 |
| validation/py_diff_harness.py | | | 86.03 (statements, measurable) | | 109-157 180-231 (input builders) 271-306 355-422 949-962 (side hard kill) 1114-1115 1201-1202 1217-1237 (load verdicts) 1251 1290-1298 1326-1333 (harness error) |

Outside the targets, for context: `executor.js` is at 99.16% lines, missing only 178-179, the mutation-evidence exception path (see C5). Other non-target files: `claude-client.js` 50.47% (AUDIT-4 M7, unchanged), `server.js` 82.04%, `analyzer.js` 75.19%.

### Worker threads, child processes and Python

**Child `node` processes are counted in both views**, because they inherit `NODE_V8_COVERAGE`. This includes the SIGINT CLI test and the orchestrator e2e tests.

**Worker threads are counted only in B.** Since SG20, `diffTesting.run()` starts `diff-prep-worker.js`. That worker loads `diff-testing.js` itself, parses both versions and builds the inputs, then starts the sandbox worker. Both workers start with `env: {}` and are always `terminate()`d.
- Node's report therefore sees only the thin main-thread part of `diff-testing.js`, at 23.65%.
- 266 prep-worker isolates and 263 sandbox isolates were merged in B.
- Workers killed by the hard kill never flush their coverage, so code that runs only in those workers counts as uncovered.

**The Python harness is measured by `audit/11/py-coverage.js`:**
- A `python3` shim first on `PATH` starts the harness under coverage.py through `py-cov-launcher.py`.
- The launcher restarts coverage in each forked side and saves its data before `os._exit`. It wraps the audit hook the harness adds only while that data file is written.
- The suite stays green under the shim (395/395), with 192 data files combined.

---

## Critical

Each Critical finding is a rule that decides whether an edit is committed or the target is touched, and that can be removed or inverted with all 395 tests still green. Repro: `node audit/11/mutants.js <ids>`. The script prints `FINDING SURVIVED` per survivor and exits 1.

Every survivor was confirmed against the full suite, not just a subset. Another audit was running on the machine during part of the mutant run. That load can only cause false *kills*, never false survivals.

### C1. The JS diff-test rules that keep a verdict from being `equivalent` have no test

**Where:**
- `src/validation/diff-sandbox-worker.js:739` (`n >= calls.length` and `value >= need`);
- `:737` (deferred module state truncated);
- `:748` (no changed callable resolved);
- `src/validation/diff-testing.js:313` (`pureExpr`, which `declLike` uses for a new or removed top-level `const x = <expr>`). Lines 313-329 have 0% coverage.

**What is tested:** SG11, SG15 and SG20 each list these as `inconclusive` rules. The SG15 test "targets beyond the cap and an exhausted time budget are inconclusive, never equivalent" (`test/diff-testing.test.js:555`) reaches the budget only through a path other than the per-target `n >= calls.length` check.

**Impact:** the diff test's `equivalent` is commit-bar condition (c). Each of these mutants turns a case the code currently reports as `inconclusive` into a possible `equivalent`. Nothing in the suite notices:

| mutant | what changes | observed | expected |
|---|---|---|---|
| SB-budget | a target cut short by the time budget can be `equivalent` | SURVIVED | killed |
| SB-allthrow | drop `value >= need` | SURVIVED | killed |
| SB-trunc | module state too large to compare is ignored | SURVIVED | killed |
| SB-tested | no callable resolved, yet `equivalent` | SURVIVED | killed |
| DT-pure | every top-level initialiser is "side-effect free" | SURVIVED | killed |

SB-allthrow can only matter when the repeat phase runs out of budget, so it is the same gap as SB-budget. With DT-pure, `const x = counter++` or `const y = fs.writeFileSync(...)` added outside a located callable is no longer a cap.

**Repro:** `node audit/11/mutants.js SB-budget SB-allthrow SB-trunc SB-tested DT-pure`

**Suggested tests:**
- an edit with `budgetMs` small enough that one target is cut short mid-inputs;
- a module-state object over `STATE_NODES` with `trunc`;
- a proposal adding `let n = 0; const id = n++;` at top level.

### C2. The Python diff-test verdict rules have no test

**Where:** `src/validation/py_diff_harness.py`:
- `:1231` (non-deterministic load);
- `:1235-1237` (load state differing through stubs);
- `:1279` (the `n == len(sched)` budget check; the `break` at `:1251` is never reached);
- `src/validation/py-diff-testing.js:86` (`deletions_observed`).

**What is tested:** the Python oracle tests (`test/py-diff-testing.test.js`) cover the divergent, equivalent and timeout cases. They do not cover any of the downgrade rules above, and they check `deletions_observed` only when it is true.

**Impact:** SG19 makes the gate treat `.py` like JS, so a Python `equivalent` satisfies commit-bar condition (c). A false `deletions_observed: true` lets a deletion-only hunk stand without mutation evidence (`executor.js:36`).

| mutant | observed | expected |
|---|---|---|
| PH-nondet | SURVIVED | killed |
| PH-stub | SURVIVED | killed |
| PH-budget | SURVIVED | killed |
| PJ-del | SURVIVED | killed |

**Repro:** `node audit/11/mutants.js PH-nondet PH-stub PH-budget PJ-del`

### C3. Every diff-test crash path fails closed today, and no test would notice if one stopped

**Where:**
- `src/validation/hybrid-validator.js:127-129`: `diffTesting.run` throws;
- `src/validation/diff-prep-worker.js:11-13`: preparation throws;
- `src/validation/diff-sandbox-worker.js:768-770`: the sandbox throws;
- `src/validation/py-diff-testing.js:83`: unparseable harness output;
- `src/validation/py_diff_harness.py:1326-1327`: harness exception;
- `py_diff_harness.py:1201-1202`: a side died before loading.

All six are uncovered. The JS and Python hard-kill paths are tested; DT-hard, DT-exechard and PJ-hard are killed.

**Impact:** if any of these were changed to report `equivalent`, an exception inside the oracle would satisfy commit-bar condition (c) for every edit that reaches it. Mutants HV-err, PW-err, SB-err, PJ-parse, PH-err and PH-noload all SURVIVED. Expected: killed.

**Repro:** `node audit/11/mutants.js HV-err PW-err SB-err PJ-parse PH-err PH-noload`

**Suggested tests:**
- the pass-through options that already exist: `diffTesting.run({ python: '/bin/false' })` and a non-JSON-printing interpreter;
- a stubbed `diffTesting.run` that throws inside `runHybridValidator`;
- a `fileSrc` that makes `prepareFile` throw.

### C4. The jury-mean floor (`p_preserves >= MIN_CRITIC_P`) can be removed

**Where:** `src/orchestrator.js:80`.

**What is tested:** the only test of this rule, "majority approve with jury p_preserves below 0.5 is critic_rejected" (`test/hybrid-validator.test.js:160`), uses a split panel. Since SG14 the unanimity rule rejects that panel anyway.

**Impact:** a unanimous approve whose personas all sit between 0.2 and 0.5 (mean below 0.5) now passes only because of this check. CLAUDE.md lists it explicitly ("AST + diff-test terms can never outvote the critic"). AUDIT-4's control mutant O6, which made the same change, was killed at `bf6ddd1`.

**Repro:** `node audit/11/mutants.js G-p`

| observed | expected |
|---|---|
| SURVIVED | killed (e.g. by a panel of `{true, 0.3}` ×3 with an equivalent diff test → `critic_rejected`) |

### C5. Two mutant-kill rules in the executor are unpinned

**Where:** `src/agents/executor.js:67` (only a failing run kills a mutant) and `:177-179` (an exception in `mutationEvidence`).

**What is tested:** the tests "a mutant run that times out is no kill" (`test/executor.test.js:417`) and "a timed-out mutant whose re-run fails is killed" (`:427`) cover a timeout followed by a pass, and a timeout followed by a fail. They do not cover a timeout followed by another timeout. The exception path at 178-179 is the executor's only uncovered code.

**Impact:**
- **X-tokill:** with `status === 'failed' || status === 'timeout'`, two timed-out runs count as a kill. SG20 and CLAUDE.md say they must not ("counts only if that run fails"). A slow mutant then keeps an edit that the tests never judged.
- **X-mutthrow:** an exception while mutants run is recorded as `ok: true`, and the edit is committed with no evidence.

Both SURVIVED. Expected: killed.

**Repro:** `node audit/11/mutants.js X-tokill X-mutthrow`

### C6. Worktree commit and resume isolation rules are unpinned

**Where:** `src/runner/worktree.js:204` (`git add -- <edited file>`) and `:173` (resume on a target that is no longer a git repo).

**Impact:**
- **W-add:** `git add -A` stages every worktree change, including the dirty files synced from the target. Those dirty files then go into a "passing proposal" commit that no gate judged. CLAUDE.md says "only the edited file is staged". The commit tests use clean targets, so they cannot tell the difference.
- **W-notgit:** `resumeWorktree` returns an in-place workspace instead of throwing `EWORKTREE`, and the executor then edits the target. SG17 says "Resume never edits a git target in place". The sibling rules W-gone (branch removed) and W-head (path not on the branch) are killed; only this branch of the guard is not.

Both SURVIVED. Expected: killed.

**Repro:** `node audit/11/mutants.js W-add W-notgit`

**Suggested test:** a commit on a target with an unstaged change to another file must contain exactly one file.

---

## High

### H1. The signal and crash paths are still only partly tested (AUDIT-4 M1/M3, open)

**Where:** `src/orchestrator.js:52-58` and `:213-219`.

**Impact:** the SIGTERM handler is the revert path for `kill <pid>` or a container stop. All four mutants still survive:
- **O3:** the handler is not installed.
- **O1:** state is no longer flushed on a signal.
- **O2:** an uncaught exception exits 0.
- **O4:** an executor exception leaves `test_outcome` null, so the proposal is re-executed on every `--resume`.

The SIGINT path is pinned: S-kill and the AUDIT-4 controls are killed.

**Repro:** `node audit/11/mutants.js O1 O2 O3 O4` → all SURVIVED.

### H2. Killing the test process group after a normal exit has no test

**Where:** `src/runner/test-runner.js:128`, which kills stragglers left in the group after the test command exits.

**Impact:** a test that leaves a background process in its group, such as a watcher or a forked server, keeps running after the result is in. It could write into the worktree after the edit has been committed or reverted. Mutant T-straggler drops the kill and SURVIVES. The existing timeout tests only exercise the kill on timeout, and the setsid tests use a process outside the group.

**Repro:** `node audit/11/mutants.js T-straggler`

### H3. Dirty-sync copy failures can be swallowed, and the run then validates the wrong code

**Where:** `src/runner/worktree.js:84-86`, a file that cannot be copied (lines 85-86 uncovered), and `:187-190`, sync failure in a re-created worktree (uncovered).

**Impact:** SG16 says "on failure the run stops with an error instead of validating HEAD". Two mutants survive:
- **W-copy:** `continue` past an unreadable dirty file.
- **W-resync:** swallow a resume sync failure.

Either way the edit is validated and tested against `HEAD` while the Analyzer read the dirty file. The git-status-failure branch (W-status) is pinned.

**Repro:** `node audit/11/mutants.js W-copy W-resync` → SURVIVED. One way to test it: a dirty file that `chmod 000` makes unreadable.

---

## Medium

### M1. Node's built-in coverage now reports `src/validation` below 85%

**Where:** the PLAN.md Audits #4 metric.

**What happens:** `node --test --experimental-test-coverage` reports `src/validation` at **65.52%** lines and `diff-testing.js` at 23.65%, and leaves both worker files out entirely. The real figure is 94.40% (B). The cause is SG20, which moved parsing, target location and input construction into a worker.

**Impact:** anyone checking the bar with the built-in tool sees a failure; anyone trusting a passing figure from a worker-blind tool gets no information about the oracle.

**Suggested fix:** track coverage with `audit/11/coverage.js`, or with c8 and worker support plus the coverage flush.

### M2. The hard bound after a timeout kill has no test

**Where:** `src/runner/test-runner.js:105`.

**What happens:** mutant T-grace removes the 1.5 s `EXIT_GRACE_MS` bound and SURVIVES. A child that never emits `exit` after the group SIGKILL would then hang the run. An example is a process in uninterruptible sleep. This is hard to reproduce on purpose, hence Medium.

**Repro:** `node audit/11/mutants.js T-grace`

### M3. The process-group timeout test still measures zombie reaping (AUDIT-4 M6, open)

**Where:** `test/test-runner.test.js:62-69`.

The test still polls `kill(pid, 0)` with a 2 s budget, so its margin depends on how fast PID 1 reaps zombies. It passed in all 8 runs here.

### M4. The rate-limit retry is still untested (AUDIT-4 M7, open)

`src/utils/claude-client.js` is unchanged, at 50.47% lines.

### M5. Untested error branches in the runner and the orchestrator

These are untested, but each fails safe:
- the validator throws (`orchestrator.js:143-148`);
- the executor throws (`:214-219`, see H1);
- the analyzer fails (`:332-336`);
- there are no files (`:319-323`);
- `regionView` cannot resolve (`:107-108`);
- `spawn` throws synchronously (`test-runner.js:99-100`);
- the coverage file read is interrupted by the deadline (`:301-303`);
- the babel-failure comment mask (`:233-235`);
- the Python header-only edit lookahead (`:357-358`);
- `createWorktree` on an existing worktree path (`worktree.js:123-125`);
- the resume re-add failure (`:182-183`);
- a corrupt crash snapshot (`reverter.js:93-95`);
- `applyEdit` on a missing file (`:137-138`);
- the worker failing to start (`diff-testing.js:1060-1063`, `1112-1113`).

Mutant W-readd also survives, but it is effectively equivalent: the HEAD check at `worktree.js:192` still throws.

---

## Low

**L1. One reconciliation rule is not separately pinned.** Mutant G-reconcile2 (`orchestrator.js:417`, overwriting an existing outcome) survives. A proposal with an outcome and a branch commit is in practice already `passed`, so the mutant is near-equivalent.

**L2. A labelling rule is untested.** Mutant T-covto survives: a coverage.py `json` overrun is reported as `edit_not_exercised` instead of `coverage_timeout`. Both are untested reasons, so no sample results either way.

**L3. Redundant rules show the backups work.** HV-relax survives because the gate requires `equivalent` for `.py` anyway. The other redundant rules (HV-runs, HV-div, HV-unrej, G-comb, G-testfile1) are each killed by a dedicated test.

**L4. Part of the Python harness cannot be measured.**
- 32 harness statements are invisible to coverage.py: the audit-hook body and the forked child's continuation of `run_side`.
- The audit hook's refusals are tested behaviourally ("sandbox refuses network, processes and writes outside its cwd").
- The harness's own side kill (`:949-962`) is uncovered. A failure there is caught by the 3 s outer hard kill, which is tested.

**L5. One state test depends on test order.** "STATE_DIR and SESSION_PATH honour REFACTOR_STATE_DIR" (`test/state-dir.test.js:11`) fails when it runs after the round-trip test. The no-argument `SESSION_PATH` returns the latest written session.
- Repro: `node audit/11/flaky.js --repeat 0 --files 0 --serial 0 --intra 1 test/state-dir.test.js` → fails with seed 212.
- In the normal order it passes.

**L6. AUDIT-4 L1 is still present.**
- Repro: `node --test --test-name-pattern="gate takes the lower" test/classifier.test.js` → `fail 1`.
- The test depends on weights written by an earlier test in the file.

---

## What holds

**AUDIT-4 Highs: fixed and pinned.**
- E1, E2 and T1 are killed by the SG12 revert-path tests.
- W1 is killed by the `worktree.test.js` sync tests, and `node audit/4/worktree-dirty-sync.js` reports ok in all three scenarios.
- A1 is killed by the two whitespace-uniqueness tests.

**Killed safety mutants: 50 of 80.** Among them:
- **Revert decisions:** not exercised (X-noexec), no test runner, `mutation.ok`, per-hunk evidence, both deletion rules, a mutant left in the file, `runTests` throwing, the failed-commit unstage.
- **Coverage evidence:** per-function coverage, a never-executed character, the coverage.py hit.
- **Gate:** dry-run never executes, veto, unanimity, persona floor, edge cases, unconfirmed block, RL threshold, test files, region validation.
- **Resume and signals:** reconciliation on resume, the SIGINT group kill.
- **Validators:** JS runs=0 block, non-JS checks rule.
- **JS diff test:** hard-kill verdicts, caps, state writes, host globals, target cap, load-stub rule.
- **Python diff test:** hard kill.
- **Worktree:** in-place fallback (SG21), git status failure, rename parsing, branch gone, wrong HEAD, resync skip set, trailer parsing.
- **Crash snapshots:** discard of a vanished worktree, persist before the edit, executor region check.

**Labelling and budget rules: 8 of 9 killed.** These cover `edit_id` dedup for both samples and calibration, the `mutation_budget` and `coverage_timeout` untested reasons, the capped-edit reason and the mutant budget.

**Determinism:** `node audit/11/flaky.js` ran 8 full runs, each 395/395 except L5's single run:

| mode | runs | wall time |
|---|---|---|
| normal | 3 | 51.3–53.4 s |
| file order shuffled | 2 | about 51 s |
| serial, file order shuffled | 1 | 113 s |
| test order shuffled inside each file | 2 | about 50 s |

No safety-path test changed outcome in any mode.

**No residue:** every run used a private `TMPDIR`. `state/` and `dashboard/` were never created in the repo, and `git status` was unchanged apart from `audit/11/`.

## Repro index (`audit/11/`)

| script | covers |
|---|---|
| `coverage.js` (+ `worker-cov-preload.js`, `worker-cov-wrapper.js`) | Coverage tables: Node view A and the all-isolate view B, per file and per directory; `--py` folds in the harness; M1 |
| `py-coverage.js` (+ `py-cov-launcher.py`) | coverage.py of `py_diff_harness.py` under the suite; L4 |
| `mutants.js` | 98 mutants on a temp copy: C1–C6, H1–H3, M2, M5, L1–L3, plus the AUDIT-4 re-checks and controls. Each runs on a subset first, then the full suite. Result: 50/80 safety, 6/7 label, 2/2 perf, 5/6 redundant and 3/3 control mutants killed |
| `flaky.js` (+ `shuffle-preload.js`) | Repeat, file-shuffled, serial and intra-file-shuffled suite runs; L5 |
