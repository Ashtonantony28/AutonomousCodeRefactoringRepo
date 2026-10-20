# AUDIT-17 — Performance under load, round 5 (confirmation)

Commit audited: `d728205` (after SG24 and SG25). Independent auditor; no `src/`, `test/`, `state/` or `dashboard/` changes. All scripts load `test/helpers/env.js` first (through `audit/5/lib.js` / `audit/14/lib.js`), so state goes to a temp dir. Every pipeline run uses the stub client; no live API call.

**Machine:** Linux, 4 vCPU, 15 GB, Node v22.22.0, Python 3.13.16, pytest 9.1.1, coverage 7.16.2. Numbers vary about ±15% between runs.

**How to reproduce:** `bash audit/17/rerun-a14.sh OUT` re-runs every AUDIT-14 repro and the earlier rounds' set; `bash audit/17/run-all.sh OUT` runs the new probes. Each `audit/17/*.js` prints `ok` / `FINDING` per check and exits 1 on a reproduced finding.

## Summary

- `npm run bench`: ast p95 1.0 ms, difftest 258 ms, apply 24 ms, validator 265 ms. All within budget.
- Every AUDIT-14 Critical and High is **fixed** on its repro (table below). No re-run left a `refactor-cov-*`, `refactor-pyc-*` or `pydt-*` dir behind.
- SG25's additions are cheap:
  - `moduleBindings` / `carriedReferences`: ≤ 180 ms on a 10,530-line file, linear in the number of references.
  - Python probe sites: ≤ 809 ms unloaded.
  - Startup HEAD check: ≤ 27 ms at 25,000 files.
- The new problems are elsewhere:
  - A signal leaks the run's temp dirs (C1).
  - The Python diff test cannot judge `x * 10 ** 9`-style code (H1).
  - A fresh bytecode cache on every Python test run makes each run 6–7× slower (M1).
  - Three runs per kill × the sites added by reference expansion push realistic suites into `mutation_budget` (M2).
- Whole-run cost of SG24/SG25 on the AUDIT-14 load fixtures:
  - JS (50 proposals): wall 405 → 620 s; 147 mutant runs, 3 per kill.
  - Python (20 proposals): wall 186 → 586 s; mutant runs p50 0.9 → 6.5 s. The 0.9 s runs in AUDIT-14 were collection failures (A13-C1); the 6.5 s runs are real runs.
  - All 20 Python proposals are now judged (19 `passed`, 1 `vetoed`). In AUDIT-14, 7 were `critic_rejected`.

| severity | count |
|---|---|
| Critical | 1 |
| High | 1 |
| Medium | 4 |
| Low | 5 |

## AUDIT-14 Critical/High: status

| id | re-run | now | status |
|---|---|---|---|
| A14-C1 flaky failure counted as a kill | `node audit/14/mutant-flaky.js --mode timing --repeat 20 --busy 8` (also `steady`, `random`) | 0/20, 0/10, 0/20 kept | fixed |
| A14-H1 Python deletion offset rescans | `node audit/14/py-deletion.js --kb 2,10,14,30,60` | 240–284 ms (was 2.1–8.9 s); rewrites 1.66 s | fixed |
| A14-H2 Python diff test on large modules | `node audit/14/diff-size.js --lang py --kb 100,150,199` | p95 534 / 685 / 1,051 ms, all `equivalent`. 500-module pipeline: 10/10 large-module edits `equivalent` | fixed (load: M3) |
| A14-H3 synchronous per-site mutants | `node audit/14/edit-sites.js --lang py --hunks 4,16 --sites 6,12 --contend 8` | 535–671 ms, every hunk has mutants (was 10.4 s, 0 mutants). JS 16×12: 218 ms | fixed |
| A14-H4 per-call binding state | `node audit/14/diff-bindings.js --kind const` | 500–9,000 constants: 351–1,561 ms, all `equivalent` | fixed (load: M3) |
| earlier rounds (A2, A6, A9 C/H) | `bash audit/14/rerun-prior.sh` | all as in AUDIT-14. A9-C2 JS 29 s suite is now `mutation_budget` (documented SG24 trade-off; see M2) | fixed |

## Budget table (this run)

| stage | budget p95 | JS 500-file run p50 / p95 / max (ms) | Python 500-module run p50 / p95 / max (ms) |
|---|---|---|---|
| AST `runChecks` | 300 | 84 / 273 / 371 (2/50 over) | 40 / 111 / 129 |
| diff test | 2,000 (kill 3,000) | 397 / 777 / 1,002 | 343 / 855 / 887 |
| `applyEdit` | 100 | 1.1 / 6.0 / 6.3 | 0.8 / 1.4 / 1.4 |
| validator | 2,500 | 436 / 1,020 / 1,375 | 365 / 952 / 999 |
| mutant runs | 60 s shared | 147 runs, p50 2,173 | 57 runs, p50 6,544 |
| executor wall | — | 10,648 / 14,056 / 14,409 | 27,493 / 36,926 / 36,926 |
| main-thread stall | — | max 2,477 | max 2,410 |

Commands: `node audit/9/pipeline-load.js --proposals 50 --drift --serve` and `node audit/14/pipeline-load-py.js --proposals 20 --drift --serve`.

---

## Critical

### C1. SIGINT/SIGTERM during a test run leaks that run's `refactor-cov-*` and `refactor-pyc-*` dirs
- **Where:** `src/orchestrator.js:45-54`, `src/runner/test-runner.js:397-443`.
  - `handleSignal` kills the test group, restores the file, saves the session and calls `process.exit`.
  - The `finally` in `runTests` that removes `covDir` and `pycDir` never runs.
  - `pycDir` is created for every run, JS runs included.
- **Measured** (`node audit/17/leaks.js --cases sigterm-js,sigterm-py`; CLI with the stub client, private TMPDIR): each signal leaves 2 dirs. JS: 8 KB. Python: 2.9–3.9 MB (the pytest/coverage bytecode compiled into the prefix).
  - If the signal arrives during coverage post-processing, the dir also holds coverage data.
  - The system `/tmp` on this machine holds 726 `refactor-cov-*` and 692 `refactor-pyc-*` dirs from earlier sessions, some of them 348 KB.
- **Not affected:** processes (none left), `inflight.json` (cleared), the target (clean).
- **Expected:** `handleSignal` removes the live runs' temp dirs (track them like `active`), or the temp dirs live under the state dir and are swept at startup.
- **Repro:** `node audit/17/leaks.js --cases sigterm-js,sigterm-py`

## High

### H1. Python diff test on `x * 10 ** N` or `x * MODULE_CONST`: over budget and `inconclusive`, so every such edit is `critic_rejected`
- **Where:** `src/validation/py_diff_harness.py:360-375` (`const_kind`) and `:425-441`.
  - The other operand of `*` is classed `num` only when it is a literal number or a known int variable.
  - `10 ** 9` (a `BinOp`) and `NS_PER_S` (a module constant) are not, so the parameter gets kind `any`.
  - String and list inputs then build `str * 10**9` per call. Every call hits the 250 ms per-call timeout, and the run hits the 1,500 ms budget.
- **Measured** (`node audit/17/py-scale-const.js`; behaviour-preserving "inline the temporary" in a 2-line function):

  | expression | unloaded p50 / max ms, verdict | 8 busy processes max ms, verdict |
  |---|---|---|
  | `s * 10 ** 9` | 1,914 / **2,342**, inconclusive 5/5 | **2,823**, inconclusive |
  | `s * 10 ** 6` | 1,835 / 1,949, inconclusive 5/5 | **3,111**, hard kill |
  | `s * NS_PER_S` (`NS_PER_S = 1000000000`) | 1,842 / **2,130**, inconclusive 5/5 | **3,020**, hard kill |
  | `s * 1000000000` (folded) | 135 / 150, equivalent | 768, equivalent |
  | `s * 2 ** 30`, `s * 1024 ** 3` | ≤ 226, equivalent | ≤ 816, equivalent |

- **Not a regression:** the AUDIT-14 baseline `62485b9` gives the same result (1,786–1,862 ms, inconclusive).
- **Realistic:** unit-conversion code (`seconds * 10 ** 9`, `ms * MS_PER_S`) is common. Such functions can never be refactored, and each attempt blocks the main thread for about 2 s (spawnSync).
- **Repro:** `node audit/17/py-scale-const.js` (`--contend 8` for the loaded column)

## Medium

### M1. Every Python test run compiles everything from scratch, the pytest package included (fresh `PYTHONPYCACHEPREFIX` per run)
- **Where:** `src/runner/test-runner.js:400-401` (since SG14).
  - The prefix is fresh for every run: the main run, every mutant run and every control run.
  - Since SG24 a kill takes 3 runs, so each kill pays the compile 3 times.
- **Measured** (`node audit/17/py-startup.js`; repo of N × 20 KB modules, one test importing all of them):

  | modules (MB) | `-m pytest`, warm cache | fresh prefix | `runTests` |
  |---|---|---|---|
  | 200 (4.7) | 313 ms | 2,129 ms (+1,816) | 2,130 ms |
  | 500 (11.7) | 596 ms | 3,833 ms (+3,237) | 3,620 ms |

  - `-m pytest` (SG25) costs nothing over the script (313 vs 341 ms).
  - The first-call `pytestInterpreter` probe stalls the main thread for 294 ms.
  - 500-module pipeline: mutant runs p50 6.5 s; wall 586 s.
- **Expected:** keep a per-worktree prefix and invalidate stale `.pyc` by hash, e.g. `--check-hash-based-pycs always` or `SOURCE_DATE_EPOCH` with `py_compile` invalidation mode `CHECKED_HASH`, rather than starting with an empty cache.
- **Repro:** `node audit/17/py-startup.js --files 200,500`

### M2. Mutation evidence costs about 3 × sites suite runs; with SG25 reference expansion, realistic suites end `mutation_budget` after spending the whole 60 s
- **Measured** (`node audit/17/executor-refs.js`; 200-file repo; the suite sleeps S seconds and then kills every mutant):
  - `inline`: 4 sites, 12 runs.
  - `ref`: a call to a 7-site helper, 21 runs.

  | S | JS inline / ref | Python inline / ref |
  |---|---|---|
  | 0.5 s | passed 9.2 s / passed 16.4 s | passed 21.7 s / passed 36.0 s |
  | 1.5 s | passed 22.2 s / passed 37.6 s | passed 34.6 s / passed 59.8 s |
  | 3 s | passed 41.9 s / **mutation_budget 61.4 s** | passed 53.7 s / **mutation_budget 62.3 s** |

- **What this means:**
  - A 3 s suite judges the inlined edit but not the same change written as a helper call.
  - A9-C2's 29 s JS suite is now `mutation_budget` (87.9 s wall).
  - The budget is never exceeded: the mutant phase is ≤ 58.1 s; executor wall per proposal ≤ about 2 × 60 s.
- **Repro:** `node audit/17/executor-refs.js --suite-s 0.5,1.5,3`

### M3. (Carried, A14-M1/H2/H4 residue) Diff-test verdicts on large inputs still depend on CPU load
- **Measured** with 8 busy processes. Unloaded, every case below is `equivalent`.

  | case | max ms | verdicts | repro |
  |---|---|---|---|
  | JS, 199 KB module | 2,918 | 1/3 inconclusive (hard kill) | `node audit/14/diff-size.js --lang js --kb 150,199 --contend 8 --reps 3` |
  | JS, 5,000 top-level constants | 2,920 | 2/3 inconclusive | `node audit/14/diff-bindings.js --kind const --n 1000,2000,3000,5000 --contend 8` |
  | JS, 3,000 top-level constants | 2,406 | equivalent | same |
  | Python, 150 KB module | 1,728 | 1/3 inconclusive | `node audit/14/diff-size.js --lang py --kb 50,75,100,150 --contend 8 --reps 3` |
  | Python, 300 deleted comprehension iterables | 2,825 | inconclusive | `node audit/17/py-probes.js --contend 8` |

### M4. (Carried, A14-M3) Main-thread stalls of about 2.4 s
- **Measured:**
  - JS run: max 2,477 ms; `/healthz` max 2,478 ms.
  - Python run: max 2,410 ms.
  - `syntheticNegatives` p95: JS 1,803 ms, Python 1,965 ms.
- **Repro:** the two pipeline commands above.

## Low

- **L1 (carried A14-L4):** `runChecks` on large JS files is at the 300 ms budget. JS pipeline p95 273 ms, max 371 ms (2/50 over). `audit/2/ast-scale.js`: 199 KB p95 265 ms.
- **L2:** every non-dry run keeps its worktree and `refactor/<run_id>` branch, and nothing prunes them. Three runs on one target leave 3 worktrees and 3 branches (`node audit/17/leaks.js --cases repeat-js`). On the 19 MB fixture each worktree is a full checkout. This is by design (the branch is the output), but disk use grows without bound.
- **L3 (carried A14-L3):** the setsid daemon outlives `runTests`: `sleep 240` was still alive after `hang-escape` (`audit/2/tests-load.js`).
- **L4:** a reference's definition sites count toward `EDIT_MAX_SITES` (12). Calling two 7-site helpers, or one helper with more than 12 sites, gives `capped`, so the edit is `reverted mutation_budget` without a test run. The reason blames the budget. This is cheap: ≤ 132 ms (`node audit/17/edit-refs.js`).
- **L5 (seen in passing, not load):** deleting a term from a `match` guard (`case n if b > 1 and True:`) gives `deletions_observed: false` in all 9 runs, at 10, 100 and 300 cases. Such an edit then has no evidence for its deleted tokens (`node audit/17/py-probes.js`).

## What holds

- **Leaks** (`node audit/17/leaks.js`):
  - Normal JS and Python CLI runs, a 2 s test timeout with grandchildren, and Python diff-test hard kills (module top level never ends, `except` swallowing the timer) all leave no process and no src temp dir.
  - `inflight.json` is cleared each time.
  - Under 8 busy processes, the py-adversarial "timer swallowed" cases leave 0 harness processes. The single "2 left" seen once came from concurrent probes in this audit.
- **SG25 reference expansion** (`node audit/17/edit-refs.js`): 1,549–10,530-line files, 1–200 references, constants, a 5,000-entry table. Every case finishes in ≤ 180 ms, and the time grows linearly with the number of references (0.28–0.33 ms/ref at 200).
- **SG25 Python probes** (`node audit/17/py-probes.js`): chained tails (10–300), comprehension iterables (10–300), match guards (10–300) and one chain of 200 comparators run in 321–809 ms unloaded, all `equivalent`.
- **SG25 startup HEAD check** (`node audit/17/startup-head.js`): 200 / 5,000 / 25,000 files. A crash mid-test is restored in ≤ 12.7 ms. A crash after the commit is discarded in ≤ 27.3 ms. With no snapshot the check costs 0 ms.
- **SG24 worktree retry** (`node audit/14/worktree-retry.js`): 338–409 ms p50, and the target stays clean.

## Scripts (`audit/17/`)

| script | measures |
|---|---|
| `lib.js` | `audit/5` + `audit/14` helpers; `check`/`finish` (prints ok/FINDING, exit 1), temp-dir and process scans |
| `rerun-a14.sh` | all AUDIT-14 repros + `audit/14/rerun-prior.sh`, private TMPDIR, src temp-dir leftovers |
| `run-all.sh` | every AUDIT-17 probe in sequence |
| `leaks.js` | C1, L2, what holds: processes, temp dirs, worktrees after normal runs, SIGTERM, timeouts, hard kills |
| `py-scale-const.js` | H1 |
| `py-startup.js` | M1, `-m pytest` cost, first-call stall |
| `executor-refs.js` | M2 |
| `py-probes.js` | M3 row, L5, SG25 probe cost |
| `edit-refs.js` | L4, SG25 `moduleBindings`/`carriedReferences` cost |
| `startup-head.js` | SG25 startup HEAD check |
