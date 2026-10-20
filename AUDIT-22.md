# AUDIT-22 — Performance under load, round 6 (after SG26–SG30)

Commit audited: `ed7597b` (SG26 per-test kills, SG27 temp dirs / Python constants, SG28 reporter fallback, SG29 tests, SG30 per-token sites, sham controls, load hooks). Independent auditor; no `src/`, `test/`, `state/` or `dashboard/` changes. Every script loads `test/helpers/env.js` first (through `audit/22/lib.js` → `audit/17/lib.js`), so state goes to a temp dir. Pipeline runs use the stub client; no live API call.

**Machine:** Linux, 4 vCPU, Node v22.22.0, Python 3.13.16, pytest 9.1.1, coverage 7.16.2. Other sessions shared the machine; numbers vary about ±15%.

**How to reproduce:** `bash audit/22/run-all.sh OUT` runs every probe below; `bash audit/17/run-all.sh OUT` re-runs AUDIT-17. Each `audit/22/*.js` prints `ok` / `FINDING` per check and exits 1 on a reproduced finding.

## Summary

- `npm run bench`: ast p95 1.7 ms, difftest 337 ms, apply 30 ms, validator 297 ms. All within budget.
- AUDIT-17 C1 (temp dirs on signal) and H1 (Python scaled constants) are **fixed** on their repros.
- SG26's per-test results are the new problem. The TAP / JUnit parsers and the executor's kill intersection are quadratic in the number of tests that share a name or fail together. That cost runs after every suite run, is not charged to the mutant budget and blocks the main thread. A 20,000-case table-driven node:test suite takes the mutant phase to **274.5 s against its 60 s budget** (C1).
- SG30's per-token sites, lexView and use sites are cheap at 5,000 lines (≤ 0.55 s), except for edits inside one large literal statement (M3).
- The load hooks cost nothing measurable per run, apart from hot function-level Python imports (L1).
- Shams add no suite runs: the sham replaces the third (control) run.
- Leaks: none found after normal runs, SIGTERM during the main run or a mutant run, a mutant-run timeout, or the reporter fallback.

| severity | count |
|---|---|
| Critical | 1 |
| High | 0 |
| Medium | 6 |
| Low | 4 |

## AUDIT-17 repros (`bash audit/17/run-all.sh`)

| AUDIT-17 item | re-run | now | status |
|---|---|---|---|
| C1 temp dirs leaked on signal | `node audit/17/leaks.js` | sigterm-js / sigterm-py: 0 procs, 0 temp dirs, exit 0 | fixed |
| H1 `x * 10 ** 9` diff test | `node audit/17/py-scale-const.js` (`--contend 8`) | all `equivalent`, max 191 ms (contend 8: 375 ms) | fixed |
| M1 fresh bytecode cache per Python run | `node audit/17/py-startup.js --files 200,500` | +2,436 / +3,700 ms per run | open (M5) |
| M2 3 runs × sites vs 60 s | `node audit/17/executor-refs.js --suite-s 0.5,1.5,3` | Python 3 s `inline` is now `mutation_budget` (6 sites, 14 runs, 59.2 s; was passed with 4 sites). JS: 1 wasted run, then `tests_insensitive` (no TAP from a plain script) | open (M2, M4) |
| M3 diff test under load | `node audit/17/py-probes.js --contend 8` | 3/11 inconclusive: chained ×300 2,062 ms, comprehension ×300 3,048 ms (hard kill), match ×300 2,576 ms | open (M6) |
| edit-refs, startup-head, py-adv-timer | run-all | all ok (≤ 605 ms; ≤ 36 ms; timer cases inconclusive as expected) | holds |
| L2 worktrees kept | `leaks.js` repeat-js | 3 runs → 3 worktrees, 3 branches | open (L2) |

---

## Critical

### C1. Per-test parsing is quadratic in repeated test names, and it is not charged to the mutant budget
- **Where:**
  - `src/runner/test-runner.js:396` (`tapResults`) and `:437` (`junitResults`) give a duplicate id a `#n` suffix by probing `id#2`, `id#3` … from 2 every time, so N tests with one name cost O(N²) string builds and lookups.
  - `src/agents/executor.js:124` keeps the tests that failed in both mutant runs with `a.filter(id => b.includes(id))`, which is O(F²) in the F failing tests.
  - `executor.js:92` charges only the child's `execution_time_ms`. Parsing, the intersection, `loadFailed` and temp-dir removal run after the child exits, on the main thread, and are never charged. The `left < suiteMs + 500` gate cannot see them.
- **Realistic:** a table-driven node:test suite, `for (const c of cases) test('works', ...)`, or the same name under one `describe`. A mutant in a core function fails every test.
- **Measured** (`node audit/22/report-parse.js`; one parse each):

  | tests | TAP, unique / one name | JUnit, unique / one name | intersection, all failing |
  |---|---|---|---|
  | 1,000 | 6 / 80 ms | 5 / 104 ms | 18 ms |
  | 5,000 | 16 / **2,277** ms | 15 / **2,659** ms | 291 ms |
  | 20,000 | 64 / **43,505** ms | 59 / **48,408** ms | **3,472** ms |

  - Real `runTests`, 5,000 same-name node:test cases: 2,299 ms per run uncharged (unique names: 35 ms).
  - End to end (`node audit/22/dup-budget.js`; `runExecutor`; 2-site edit; every mutant killed):

  | tests | names | outcome | mutant phase (budget 60 s) | main-thread stall | executor wall |
  |---|---|---|---|---|---|
  | 6,000 | one | passed | 40.2 s (unique: 18.3 s) | 4.2 s | 47.0 s |
  | 20,000 | one | `mutation_budget` | **274.5 s** | **43.9 s** | **322.9 s** |
  | 20,000 | unique | passed | 60.8 s | 0.6 s | 67.9 s |

  - The overrun grows with N² per run, so the 60 s budget has no bound. With 12 sites (36 runs) a 20,000-case suite would spend about 36 × 45 s ≈ 27 min.
- **Expected:**
  - Number duplicates with a per-id counter (`Map id → next n`).
  - Intersect through a `Set`.
  - Charge the post-exit work (wall time of the whole `runTests`) to `spent`.
- **Repro:** `node audit/22/dup-budget.js --n 20000 --names dup` (5 min); parsers alone `node audit/22/report-parse.js --n 5000,20000 --e2e 5000 --lang js`

## High

None.

## Medium

### M1. SG28 fallback: the refused first run uses up the test budget, so a suite that fits its timeout ends `timeout`
- **Where:** `test-runner.js:552-556`. The retry gets `deadline - now`. The first attempt has already run every pre-step before node refused the reporters, for example `npm run build && node --test --test-reporter=spec`.
- **Measured** (`node audit/22/reporter-fallback.js --pre-s 0,3 --timeout-ms 6500`):
  - A 3 s pre-step plus a 1 s suite, with a 6.5 s timeout: the first call ends `timeout` at 6,518 ms. The second call is memoised and passes in 4,505 ms.
  - With pre-step 0, the retry costs about 450 ms.
  - At the real 60 s timeout, this hits suites whose pre-step plus suite exceeds about 60 s − pre-step. The first proposal of every run in such a repo is reverted `timeout`, because `reporterConflicts` is per process and the worktree path is new each run.
- **Expected:** decide on the reporters before the run (resolve the delegated script, or probe `node --test` with the reporters on an empty file), or give the retry a fresh budget.
- **Repro:** `node audit/22/reporter-fallback.js --pre-s 3 --timeout-ms 6500`

### M2. Mutant runs are spent where no per-test result can exist
- **Where:** `executor.js:234` starts `mutationEvidence` whatever the main run reported. When the main run has no `tests`, every mutant run is `no_failed_test`, and the edit always ends `tests_insensitive`. This covers a reporter conflict, jest, mocha, a plain `node test.js` and `make`.
- **Measured:**
  - `reporter-fallback.js`: 1 wasted run each (1,618 ms, 3,510 ms).
  - `audit/17/executor-refs.js` JS: 1 wasted run each (850–3,298 ms).
  - Up to 3 runs (`MUTANT_CAP`) per proposal, bounded by the budget.
- **Expected:** skip the mutant phase (`tests_insensitive`) when the main run has no per-test results.
- **Repro:** `node audit/22/reporter-fallback.js`

### M3. Parse check of an edit inside one large statement: cost is sites × statement size, and JS has no bound
- **Where:**
  - `bug-injector.js` `jsParseCheck` / `PY_CHECK`: each candidate is parsed on the smallest enclosing statement that parses alone. In an object / dict literal table, that statement is the whole table.
  - JS runs in-process with no time limit. Python stops at the 10 s `timeoutMs`, then gives `unchecked` → `mutation_budget`.
- **Measured** (`node audit/22/sites-scale.js --cases table`; 181–183 KB literal, every other row edited, 12 numbers per row):

  | hunks (sites) | JS editMutants | Python editMutants |
  |---|---|---|
  | 1 (12) | 485 ms | 962 ms |
  | 4 (48) | 1,535 ms | 3,177 ms |
  | 16 (192) | **5,726 ms** | **10,180 ms → `unchecked`** |

  - The time is charged to the mutant budget, so the budget holds. It is a main-thread block of up to 10 s.
- **Expected:** a token-for-token swap (number→number, operator→operator) cannot change parseability, so skip its check. Otherwise check the smallest enclosing expression.
- **Repro:** `node audit/22/sites-scale.js --cases table --reps 3`

### M4. (Sharpened A17-M2) SG26/SG30 sites push realistic refactors to the 12-site cap and to ≤ 1.7 s suites
- **Measured** (`node audit/22/site-budget.js`; `editMutants` only):
  - B14 (5-line clamp `Math.min/max` → `if` chain) is `capped` → `mutation_budget` without running a test.
  - R2 (extract a validation helper, 8 lines) and R5 (Python loop → helper + `filter`, 11 lines) reach exactly 12 sites (36 runs). They can pass only when the suite takes ≤ 1.7 s.
  - The small audit/12 refactors take 1–4 sites (3–12 runs; suites ≤ 5–20 s).
  - `audit/17/executor-refs.js`: a Python 3 s suite on a 6-site inline edit ends `mutation_budget` at 59.2 s (it passed with 4 sites in AUDIT-17).
- **Repro:** `node audit/22/site-budget.js`; `node audit/17/executor-refs.js --suite-s 3 --lang py`

### M5. (Carried A17-M1) Fresh Python bytecode cache on every run
- **Measured:** 200 modules +2,436 ms per run, 500 modules +3,700 ms per run (`runTests` 2,614 / 5,019 ms). With 3 runs per kill this is the main cost of the Python mutant phase.
- **Repro:** `node audit/17/py-startup.js --files 200,500`

### M6. (Carried A17-M3) Python diff test on large probe counts is load-dependent
- **Measured:** with 8 busy processes, 3 of 11 cases are `inconclusive`, including one 3,048 ms hard kill. Unloaded, all 11 are `equivalent` (≤ 1,061 ms).
- **Repro:** `node audit/17/py-probes.js --reps 3 --contend 8`

## Low

- **L1:** the pytest load hook makes every executed `import` a Python call. A function doing 2 imports, called 200,000 times, gains +119 ms (+32% of a 372 ms suite). Import-heavy suites (2,000 tests × 200 modules) and the JS hook are within noise (−4% to +6.5%, 50–200 test files, 100 spawned node children). Repro: `node audit/22/load-hooks.js`.
- **L2 (carried A17-L2):** every non-dry run keeps its worktree and branch (3 runs → 3 / 3). Repro: `node audit/17/leaks.js --cases repeat-js`.
- **L3 (carried A17-L5):** a deletion in a `match` guard is never observed (`deletions_observed: false` at 10–300 cases). Repro: `node audit/17/py-probes.js`.
- **L4 (carried A17-L3, not re-run; `runCommand` unchanged):** a `setsid` descendant outlives the process-group kill.

## What holds

- **Leaks:** checked with `node audit/22/leaks.js`, `node audit/22/reporter-fallback.js` and `node audit/17/leaks.js`, each with a private TMPDIR. None of these leave a process, a `refactor-cov-*` / `refactor-pyc-*` / `pydt-*` dir, or TAP / junit / load-log files (they live in the pyc dir):
  - normal runs;
  - SIGTERM during the main run;
  - SIGTERM during a mutant run: exit 0, `inflight.json` cleared, worktree file back to its pre-edit content (no mutant left in it), target clean;
  - a mutant run that spins with a `sleep 300` grandchild: timed out, group killed;
  - a main-run timeout with grandchildren;
  - diff-test hard kills;
  - the SG28 retry.
- **SG30 lexView / changeHunks / editMutants** on about 5,000-line, 100 KB files with templates, regexes and f-strings in every function (`node audit/22/sites-scale.js`):
  - lexView ≤ 44 ms;
  - changeHunks ≤ 71 ms;
  - editMutants ≤ 546 ms for 1–16 hunks of use sites (80 sites) or 12-number hunks (192 sites);
  - a 1,000-line rewrite is `capped` in ≤ 65 ms.
- **Per-test parsing with unique names** is linear: 20,000 tests in 64 ms (TAP) and 59 ms (JUnit). Uncharged `runTests` overhead is ≤ 43 ms (JS) and ≤ 32 ms (Python, after the first call) at 5,000 tests.
- **Shams** add no suite run (the sham replaces the third run). A text-adding mutant carries one more file copy (≤ 36 × file size).
- **SG28 retry with no pre-step** costs about 450 ms once per repo per process. Nothing is left behind.

## Scripts (`audit/22/`)

| script | measures |
|---|---|
| `lib.js` | `audit/17` helpers plus option parsing, timing, `procsUnder`, private TMPDIR |
| `run-all.sh` | every AUDIT-22 probe in sequence, one log each |
| `report-parse.js` | C1: TAP/JUnit parse and kill intersection at 1k–20k tests; uncharged `runTests` overhead on real suites |
| `dup-budget.js` | C1 end to end: mutant phase vs 60 s, stall, executor wall |
| `reporter-fallback.js` | M1, M2: SG28 retry cost, false timeout, wasted mutant runs, leaks |
| `sites-scale.js` | M3, SG30 cost: lexView / changeHunks / editMutants at 5,000 lines |
| `site-budget.js` | M4: sites of realistic refactors vs the 12-site cap and the 60 s budget |
| `load-hooks.js` | L1: JS preload and pytest plugin overhead per run |
| `leaks.js` | SIGTERM during a mutant run, mutant-run timeout |
