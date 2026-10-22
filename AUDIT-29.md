# AUDIT-29 — Performance under load, round 10 (after SG36–SG38)

Commit audited: `1fe6399` (SG36 pinned safety rules, SG37 fail-closed numbers / structural extent / statement separators, SG38 per-test caught-load attribution in JS and Python BOM). Independent auditor; no `src/`, `test/`, `state/` or `dashboard/` changes. Every script loads `test/helpers/env.js` first (through `audit/29/lib.js` → `audit/25/lib.js`), so state goes to a temp dir. No live API call.

**Machine:** Linux, 4 vCPU, Node v22.22.0, Python 3.13. Other sessions shared the machine; numbers vary about ±15%. Before/after comparisons use `git archive` copies of `74dafcf` (pre-SG38 hook / runTests) and `3ea49df` (pre-SG37 `bug-injector`), made by the scripts.

**How to reproduce:** `bash audit/29/run-all.sh OUT` runs every probe below plus the A25 re-runs and the bench, one log each. Each `audit/29/*.js` prints `ok` / `FINDING` per check and exits 1 on a reproduced finding.

## Summary

- `npm run bench` p95: ast 1.08 ms (budget 300), difftest 256 ms (2,000), apply 23.5 ms (100), validator 269 ms (2,500). All within budget.
- A25-H1 (switch re-read on every evaluation) is **fixed** by SG35. `audit/25/switch-hot.js` is all ok: JS at 5M calls is `passed` with a 1.5 s mutant phase (was `tests_insensitive`). Python at 3M calls is `passed` with 9.5 s (was 19.5 s).
- A25-M1 (parse check inside one large literal) is **partly fixed**. The JS check is now bounded: 16 hunks take 5.3 s (was 7.6 s). Python is unchanged: 16 hunks take 10.5 s and end `unchecked`.
- New, SG38: `loadFailed` is O(named rows × tests) on every run. It runs after the test process exits. The main run does not charge it to any timeout. In the mutant phase it is charged, and it pushes a passing edit to `mutation_budget` (H1).
- New, SG37: the Python `,` check in `structural()` scans back to the enclosing bracket, or to offset 0 at statement level. So it is O(separators × file offset) (M1).
- SG38 node:test wrapper (proxy plus an AsyncLocalStorage around each test callback):
  - It costs nothing measurable on flat, `describe`, deep-subtest and concurrent suites.
  - It adds about 4 ms per test-file process and 8% on promise-heavy tests (L1).
  - Every run (main, mutant, control) has the hook. So the 2× + 1 s mutant cap ratio does not change.
- SG37 `valueKey` (one extra `Number()` per numeric token), the JS `;` structural regexes and the Python BOM handling cost nothing measurable. JS `editMutants` with 96 `;` tokens is within ±6% of pre-SG37 at 100 KB–2 MB.
- Memory: 120 proposals × (JS + Python `editMutants`, 480 mutants) plus 12 `runTests` with 500 caught-load rows each. Retained heap stays flat (12.2 → 11.9 MB); peak RSS is 213 MB.

| severity | count |
|---|---|
| Critical | 0 |
| High | 1 (new) |
| Medium | 2 (1 new, 1 carried and partly fixed) + A25 M2–M6 carried |
| Low | 1 new + A25 L1–L4 carried |

## Prior repros

| item | re-run | now | status |
|---|---|---|---|
| A25-H1 switch re-read per evaluation | `node audit/25/switch-hot.js` | all ok. js 5M calls: `passed`, 6 runs, 0 timeouts, mutant phase 1,540 ms. py 3M calls: `passed`, 9,529 ms | fixed (SG35) |
| A25-M1 parse check in one large literal | `node audit/22/sites-scale.js --cases table --reps 2` | js table-16: 5,272 ms, 192 sites (was 7,614). py table-4: 3,080 ms. py table-16: 10,476 ms → `unchecked` | JS bounded; Python open (M2) |
| A25-L2/L3 whole-file work, mutant copies | `node --expose-gc audit/25/mutant-gen.js --reps 2` | 6 lexes per phase at 1/4/16 hunks. js uses-16: 402 ms. py uses-16: 750 ms. 80 mutants × 100 KB = 7.8–8.1 MB | holds as Low |

---

## High

### H1. SG38 `loadFailed` is O(named rows × tests) per run; a passing edit ends `mutation_budget` and the mutant phase overruns 60 s
- **Where:** `src/runner/test-runner.js` `loadFailed`, the `testPassed(json)` closure.
  - It runs once for every `T` row that carries a test name.
  - Each call rebuilds `Object.keys(tests)` and filters every test id with `startsWith`.
  - A module whose body throws is not cached, so each `require` of it inside a test logs one more row.
  - `loadFailed` runs synchronously after the test process exits, on every run: main, each mutant run, control.
- **Cost of `loadFailed` alone** (its text extracted from the source; all rows excused):

  | tests | named rows | time |
  |---|---|---|
  | 2,000 | 1,000 | 211 ms |
  | 10,000 | 5,000 | 6,154 ms |
  | 20,000 | 10,000 | 29,064 ms |
  | 20,000 | 100 (one table test) | 334 ms |
  | 20,000 | 500 | 1,682 ms |
  | 20,000 | 1,000 | 3,297 ms |
  | 20,000 | 2,000 | 6,480 ms |

  That is about 3.3 ms per row at 20,000 tests.
- **End to end, `runTests`** (wall time minus the test process's own time):

  | tests | pre-SG38 | now |
  |---|---|---|
  | 2,000 | 25 ms | 225 ms |
  | 10,000 | 58 ms | 6,395 ms |
  | 20,000 | 112 ms | **29,622 ms**, for a suite whose process takes 6.2 s |

  - In the main run, this time is outside the 60 s test timeout and outside `execution_time_ms`.
  - The event loop is blocked for that long, so a SIGINT / SIGTERM revert waits too.
- **`runExecutor`** (`return x + 1;` → `return x + 2 - 1;`; a small test kills every mutant; 20,000 tests; one table test re-requires a config module that throws at load):

  | table rows | outcome | mutant runs | suite_ms | mutant phase | executor wall |
  |---|---|---|---|---|---|
  | 0 | passed | 6 | 5,504 | 35,601 ms | 42.0 s |
  | 2,000 | **reverted `mutation_budget`** | 5 | 5,816 | **62,190 ms** (over the 60 s budget) | 74.9 s |

  The pre-SG38 code cannot be compared on this suite: it never kills when a caught load throw shares the process (A28-H1), so it ends `tests_insensitive`.
- **Realistic:** a large suite (10k–20k tests) with one table-driven test of a few hundred to a few thousand bad configurations. Each case `assert.throws(() => require('../config'))`.
- **Expected:** index the test ids once per call.
  - Build a `Map` from base name to "every id passed": strip a `#\d+` suffix once per id.
  - Then do one lookup per row. Deduplicating the rows by name gives the same result.
- **Repro:**
  - `node audit/29/load-names.js` (direct and end-to-end runs)
  - `node audit/29/load-names.js --sizes '' --table '' --exec 20000,2000` (executor run)

## Medium

### M1. SG37 Python `,` structural check scans the whole prefix per comma
- **Where:** `src/rl/bug-injector.js` `uncoveredToken` → `structural()`.
  - For every inserted Python `,` it walks back character by character to the enclosing open bracket. At statement level (`c, d = d, c`) that walk goes to offset 0.
  - It then runs head regexes over `code.slice(0, …)`.
  - It runs for every separator token, whether or not the edit already failed.
  - It is synchronous and charged to the mutant budget.
- **Measured** (`editMutants`; 16 hunks × 5 `c, d = d, c` statements, 160 commas, at the end of the file; median of 2):

  | file | pre-SG37 | now | Δ |
  |---|---|---|---|
  | py 100 KB | 740 ms | 1,054 ms | +314 ms |
  | py 500 KB | 3,165 ms | 5,098 ms | +1.9 s |
  | py 2 MB | 13,431 ms | 20,051 ms | +6.6 s; CPU profile: `structural` 6,618 ms self time |
  | js 100 KB – 2 MB (96 `;`) | 235 / 917 / 3,529 ms | 250 / 898 / 3,527 ms | none |

- **Also:**
  - At 2 MB Python, `editMutants` blocks for 20 s and still returns 160 mutants.
  - The 10 s limit applies to each `python3` spawn (`pyShape`, the parse batch), not to the call. The JS-side work has no limit.
  - CLAUDE.md says a parse check over 10 s gives `mutation_budget`; here one third of the 60 s budget is gone before the first mutant run.
- **Expected:**
  - Use the bracket `pair` map already built in the same function, plus a precomputed enclosing-open array, instead of the backward scan.
  - Test the head regexes on a bounded tail, `code.slice(Math.max(0, o - 16), o)`.
  - Charge one deadline to the whole of `editMutants`.
- **Repro:** `node audit/29/struct-scale.js` (exits 0: it flags only more than 2× and 500 ms over pre-SG37 or more than 10 s; the measured deltas are the finding). Profile: `node --cpu-prof audit/29/struct-scale.js --lang py --kb 2000 --reps 1`

### M2. (A25-M1, partly fixed) Python parse check of an edit inside one large literal
- py table-4 takes 3,080 ms. py table-16 takes 10,476 ms and ends `unchecked`.
- JS is bounded now: table-16 takes 5,272 ms (was 7,614).
- **Repro:** `node audit/22/sites-scale.js --cases table --reps 2`

### A25 M2–M6 (carried, not re-run)
- A17-M1 per-run Python bytecode cache, A22-M1 reporter-fallback budget, A22-M2 mutant runs without per-test results, A22-M4 12-site cap on realistic refactors, A17-M3 Python diff test under contention.
- The code paths are unchanged by SG36–SG38: SG38 touched only the hook text and `loadFailed`.
- Repros: as listed in AUDIT-25.

## Low

### L1. SG38 node:test wrapper costs about 4 ms per test-file process and 8% on promise-heavy tests
- **Measured** (`node audit/29/hook-overhead.js`; `node --test` run as `runTests` runs it; medians of 3 runs, 7 for the starred rows):

  | suite | no hook | pre-SG38 hook | SG38 hook | SG38 / pre |
  |---|---|---|---|---|
  | flat, 5,000 sync tests * | 1,916 ms | 2,015 ms | 2,003 ms | 0.99 |
  | describe, 5,000 `it` | 2,088 ms | 2,162 ms | 2,135 ms | 0.99 |
  | deep `t.test`, 3,280 tests | 1,621 ms | 1,615 ms | 1,533 ms | 0.95 |
  | 2,000 concurrent subtests | 1,327 ms | 1,386 ms | 1,340 ms | 0.97 |
  | promise-heavy, 3M awaits * | 4,242 ms | 4,350 ms | 4,705 ms | **1.08 (+354 ms)** |
  | sync hot loop, 30M calls | 202 ms | 199 ms | 205 ms | 1.03 |
  | 100 files × 5 tests * | 2,742 ms | 2,617 ms | 3,047 ms | **1.16 (+430 ms)** |

- **Why:** once the AsyncLocalStorage has run, Node 22 keeps async_hooks promise hooks on for the rest of the process.
- **Effect on the budgets:**
  - Every run (main, mutant, control) preloads the same hook, so the 2× + 1 s mutant cap ratio does not change.
  - Only the absolute suite time grows. A 60 s budget fits about 14% fewer mutant runs for a many-file suite.
- **Repro:** `node audit/29/hook-overhead.js [--reps 7]` (exits 0 below 25% and 250 ms)

### Carried
- **A25-L1:** pytest per-test `P` logging (+11% at 20k tests). Not re-run; the pytest hook is unchanged.
- **A25-L2:** duplicate whole-file work. Re-run above.
- **A25-L3:** mutant source copies, 80 × 100 KB = 8 MB. Re-run above.
- **A25-L4:** worktree / branch kept per run, `setsid` survivor, match guard. Not re-run.

## What holds

- **SG38 wrapper on large suites:** no slowdown on 5,000 flat tests, 5,000 `describe`/`it`, 3,280 nested subtests or 2,000 concurrent subtests. The test counts are identical under all three hooks.
- **SG37 JS separators and brackets:**
  - `;` structural regexes and the bracket rule (`applied` only, `inside` removed): no measurable change at 100 KB–2 MB with 96 inserted `;`.
  - Bracket `fresh()` stops at the first kept character.
- **SG37 `valueKey`:** one extra `Number()` per numeric token, within noise in the `changeHunks` timings (86–119 ms on the 183 KB table).
- **Memory** (`node --expose-gc audit/29/memory.js --n 120`): 120 proposals, 480 mutants, 12 `runTests` with 500 named rows each.
  - Retained heap 12.2 → 11.9 MB.
  - Peak RSS 213 MB.
  - No growth from the hoisted switch binding or the per-test `T` rows.

## Scripts (`audit/29/`)

| script | measures |
|---|---|
| `lib.js` | `audit/25` helpers; the hook text at another revision (`--old-rev`, `--old-src`); `srcAt(rev)` (git archive of `src/`) |
| `run-all.sh` | every AUDIT-29 probe, the A25 re-runs and the bench, one log each |
| `load-names.js` | H1: `loadFailed` direct, table-test shape, `runTests` post-exit time vs pre-SG38, `runExecutor` with R = 0 vs R rows |
| `struct-scale.js` | M1: `editMutants` with 16 hunks of separators on 100 KB–2 MB files, now vs pre-SG37 |
| `hook-overhead.js` | L1: node:test suites under no hook, the pre-SG38 hook and the SG38 hook |
| `memory.js` | retained heap and peak RSS over many proposals |
