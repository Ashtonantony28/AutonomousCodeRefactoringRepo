# AUDIT-9 — Performance under load, round 3

This audit covers commit `eb29324` (SG17, after SG14–SG17). It is PLAN.md "Audits" item 2, round 3, done by an independent auditor. No `src/`, `test/`, `PLAN.md`, `CLAUDE.md` or `README.md` changes were made.
All load is generated at runtime under `os.tmpdir()` by the scripts in `audit/9/` (and `audit/2/`, `audit/6/`). The `audit/9` scripts load `test/helpers/env.js` first, so `REFACTOR_STATE_DIR` and `REFACTOR_DASHBOARD_DIR` point at a temp dir. Every pipeline run uses the stub client, so no live API call is made and `state/` and `dashboard/` are never touched.

**Machine:** Linux, 4 vCPU, 15 GB RAM (default V8 heap limit 8,240 MB), Node v22.22.0, Python coverage 7.16.2.

**Load repo:** the `audit/2/lib.js genRepo` fixture: 500 JS files, 19.1 MB, 50 files of about 197 KB. `audit/9/pipeline-load.js` exports every function, as audit/6 does, and replaces the suite with one that **asserts** each export's result. This is needed because of SG14: audit/6's `exercise` suite calls every export but asserts nothing, so every edit there is now reverted `tests_insensitive`. The audit/6 re-run below shows this: 49/49 reverted. Proposals are seeded and run with `resume: true`, as in AUDIT-2 and AUDIT-6.

## Prior criticals and highs: status

| id | re-run | observed now | status |
|---|---|---|---|
| A2-C1 setsid test hang | `AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes fast,hang-escape,hang` | hang-escape 0.4 s `passed`; hang 60.1 s `timeout`, nothing left in the group | **fixed**. The daemon is still alive afterwards (L2) |
| A2-C2 fuzzy anchor blowup | `node audit/2/anchor-patho.js --reps 3` | all 8 cases p50 0.3–81 ms, max 109 ms | **fixed** |
| A2-H1 drift scan | `node audit/2/ast-scale.js` | (b) K=500 p95 47.6 ms; (c) validator p50 151 ms | **fixed** |
| A2-H2 diff-test timeout flakiness | `node audit/2/diff-patho.js --flaky cpu-150ms-per-call --repeat 10`, `... cpu-100ms-per-call --repeat 10 --contend 8` | 0/20 divergent (10/10 and 10/10 `inconclusive`) | **fixed as stated**. M6 carries the remaining load dependence |
| A6-C1 V8 coverage post-processing | `node audit/6/coverage-load.js --cases span` and `--cases procs` | span 2–190 KB: post-exit 63–158 ms (was up to 49,571). 200 procs × 20 KB: 824 ms (was 110,158). Max stall 136 ms | **fixed** |
| A6-C2 coverage.py 30 s cap | `node audit/6/coverage-py.js --files 50,200,500` | `exercised: true` at 50/200/500 modules; post-exit 869–1,099 ms (was 30,036 ms and a wrong verdict) | **fixed**. Its 7–27× slowdown now hits the mutant budget instead (C2) |
| A6-C3 dirty sync skipped over 1 MB | `node audit/6/session-resume-scale.js --parts a,b,c,d` | 25,000 untracked: 25,001 synced, the modified file reached the worktree, 2,929 ms | **fixed**. Cost at 100k: M4 |
| A6-H1 polyglot drift scan | `node audit/6/drift-scan.js` | (b) Python cold 36 ms, warm 23 ms (was 1,170 / 1,007) | **fixed on that shape**. Large modules: H4 |
| A6-H2 JS common-name drift | `node audit/6/drift-scan.js` | (a) cold 53 ms, warm 39 ms (was 3,039). (d) the caller after the cap is now found | **fixed**. A single big importer still bypasses the byte cap: M1 |

AUDIT-6 Medium/Low items re-measured unchanged: indent-shift tier 4,327 ms (M5), `regionHazard` 16,143 ms (L1), setsid daemon (L2), session I/O 566 ms per save at 5,000 proposals (L5), resume reconciliation now complete above 1 MB of log (6,000 commits: 6,000 found; was 0).

## Summary: measured numbers vs budget

Main run: `node audit/9/pipeline-load.js --proposals 50 --drift --serve`. This is 49 "inline temporary" edits (half on 197 KB files) plus one signature change of `normalize()`. Result: 49 `passed` (49 commits, each with a mutant killed on the first mutant run) and 1 `vetoed` (correct: the drift has real call sites).

| stage (per proposal) | PLAN p95 budget | 50-proposal run p50 / p95 / max (ms) | worst case measured (script) | verdict |
|---|---|---|---|---|
| AST `runChecks` | 300 | 94 / 286 / 336 (1/50 over) | Python drift, 200 × 500 KB modules: **10,303 cold, 5,756 warm** (H4). JS 20 MB importer bundle: **7,618 cold** (M1) | **over** on large repos |
| Differential test `diffTesting.run` | 2,000 (hard kill 3,000) | 251 / 724 / 765 | nested-row function with literal 1999: **19,809** (1 param), 90,656 (4 params), **172,455** for two such functions (C1). 32 KB regex literal: 16,463 (M2) | **over, unbounded** |
| Anchor match + apply `applyEdit` (≤ 200 KB) | 100 | 1.0 / 1.9 / 4.1 | indent-shift 6,000 lines: 4,327 (M5); regex scan on a 99 KB line: 16,143 (L1) | over on adversarial inputs (carried) |
| Whole validation `runHybridValidator` | 2,500 | 305 / 987 / 1,058 | C1 case: **20,306 ms, main thread blocked 20,296 ms**, then `critic_rejected` | **over** |
| `runTests` main run (with coverage) | — (60 s test budget) | 4,971 / 6,290 / 8,324; post-exit coverage 394 / 526 / 571 | — | — |
| `runTests` mutant runs (SG14) | shares the 60 s | 1,640 / 2,941 / 3,240 (49 runs, 1 per kept edit) | insensitive suite: 3 runs per edit (audit/6 run: 147 runs, executor p50 13.9 s) | — |
| `editMutants` (SG14, sync) | — | in executor total | **10,100 p50 / 14,918 max, 3.3 GB RSS** on a 190 KB minified line; OOM with a 2 GB heap (H1) | — |
| executor total | — | 6,842 / 8,666 / 10,544 | suite of 29 s: 58,410 ms per proposal; suite of ≥ 31 s: no mutant run (C2) | — |
| `syntheticNegatives` | — | 1,020 / 1,239 / 1,281 | — | 33.7 s of the run |
| `commitProposal` | — | 146 / 196 / 208 | — | — |
| `saveSession` | — | 4.5 / 8.6 / 24 (103 writes) | 566 per write at 5,000 proposals | — |
| `createWorktree` / `resumeWorktree` | — | 192 | resume re-creation with 100k untracked files: **15,701** (M4) | — |

| whole-run metric | measured |
|---|---|
| Wall time, 50 proposals | 405.0 s. Main test runs 243 s, mutant runs 80 s, validator 28.2 s, synthetic negatives 33.7 s. AUDIT-6: 342 s with a suite that asserted nothing and was never re-run |
| Same run with audit/6's non-asserting suite (`node audit/6/pipeline-load.js --proposals 50 --drift --serve`) | 719.8 s; 49/49 `reverted tests_insensitive`; 196 suite runs (4 per edit) |
| Peak RSS (VmHWM) | **721 MB** (AUDIT-6: 589 MB) |
| Main-thread stall (10 ms ticker) | p95 0.7 ms, max 1,743 ms |
| Dashboard with `--serve` | `/healthz` p50 1.2 ms, p95 2.4 ms, max 1,732 ms; `/` p95 1,079 ms, max 1,640 ms; SSE lag p95 27 ms |
| Leaks | FDs 25 → 25; threads 7 → 11 (libuv pool started by the async coverage reads; stable); 2 worktrees on the target (1 + this run) |

Severity counts: **Critical 2, High 4, Medium 6, Low 6.**

---

## Critical

### C1. Diff-test boundary inputs grow to n × n arrays, built synchronously on the main thread: stalls of minutes, then a false `critic_rejected`
- **Where:** `src/validation/diff-testing.js`:
  - `buildInputs` (`:851`) adds one forced input per mined number ≤ 2,000, as `{ n, as: 'arr' }`, for every parameter.
  - In `generator`, `arrLen` (`:791`) returns `force.n` at depth 0 *and* 1. So when the elements of an array parameter are themselves indexed (`for (const row of m) … row[i]`), a single input is an n × n array. Every literal contributes n−1, n and n+1, so a literal 1999 gives three inputs of about 4M elements each, per parameter.
  - All of it (generation, `fits`, `toLiteral`, the `seen` key) runs in `run()` before `execute()`. The 3,000 ms hard kill only starts after that. The worker then gets `hardKillMs − elapsed` < 0, so it reports `hard kill ... within -16341 ms (after 0 runs)`.
- **Trigger:** a function that walks rows of a 2-D array and contains a numeric literal between about 500 and 2,000. This is an ordinary shape, for example a limit/threshold constant in matrix, grid or CSV code.
- **Measured** (behaviour-preserving edit `s += row[i]` → `s = s + row[i]`; budget 2,000 ms):

  | case | ms (main thread blocked) | verdict | peak RSS |
  |---|---|---|---|
  | literal 10 | 168 | equivalent | 73 MB |
  | literal 500 | 1,646 | equivalent | 149 MB |
  | literal 1999, 1 param | **19,809** | inconclusive, runs 0 | 505 MB |
  | literal 1999, 2 params | 43,521 | inconclusive, runs 0 | 990 MB |
  | literal 1999, 4 params | **90,656** | inconclusive, runs 0 | 1,750 MB |
  | literals 1000/1500/1999, 2 params | 77,667 | inconclusive, runs 0 | 1,584 MB |
  | two 4-param functions in the edit | **172,455** | inconclusive, runs 0 | 3,323 MB |

  The cost is linear in parameters × changed targets (cap 8), so 8 such targets reach about 6 minutes and more than 10 GB.
- **End to end:** `runHybridValidator` with a unanimous stub jury took 20,306 ms, with the main thread blocked for 20,296 ms (SIGINT handlers and the `--serve` dashboard included). The gate then blocks: "diff test ran no input on a JS edit", so the edit is `critic_rejected`. The literal-10 version of the same edit is `equivalent` and proceeds.
- **Expected:** input generation bounded in elements/bytes (for example, the force length only at depth 0, or a total literal budget) and counted inside the 2,000 ms budget. A behaviour-preserving edit should not be rejected because of how large its generated inputs are.
- **Repro:**
  ```
  node audit/9/diff-explosion.js                     # table above (about 10 min)
  node audit/9/diff-explosion.js --case rows-n1999   # one case, about 20 s
  node audit/9/validator-explosion.js                # validator_ms ~20,000, gate_block "diff test ran no input ..."
  ```

### C2. The mutant budget is derived from the coverage-instrumented main run: slow suites, and Python suites of ~1–4 s, never get a mutant run, so every edit is reverted `tests_insensitive`
- **Where:** `src/agents/executor.js:18-46` (`mutationEvidence`):
  - The main run's duration (with V8 coverage or `coverage run`) is `suiteMs`.
  - Mutant k runs only while `left >= suiteMs + 500`, with `left = 60,000 − suiteMs − coverageMs − earlier mutant runs`.
  - So a main run of ≥ ~29.8 s gets no mutant at all. Between ~19.8 s and 29.8 s, only the first mutant runs; if that first mutant is equivalent, nothing else is tried.
  - `budget_exhausted` is recorded, but the outcome is `reverted` with reason **`tests_insensitive`**, the same reason as a suite that really is insensitive.
- **Measured, JS** (`node audit/9/mutant-budget.js`; the suite asserts on the edited function, so it kills every mutant whenever one runs):

  | suite s | main run ms | outcome | wall per proposal |
  |---|---|---|---|
  | 5 | 5,208 | passed (killed, 1 run) | 10,423 |
  | 15 | 15,202 | passed | 30,434 |
  | 25 | 25,205 | passed | 50,389 |
  | 29 | 29,218 | passed | 58,410 |
  | 31 | 31,220 | **reverted `tests_insensitive`**, 0 of 2 run, `budget_exhausted` | 31,227 |
  | 45 | 45,217 | **reverted `tests_insensitive`** | 45,225 |

- **Measured, Python** (`--lang py`): the main run is under `coverage run`, but mutant runs are plain pytest. The slowdown is 7–27× for CPU-bound tests (here a pure-Python loop):
  - Slow 30: main run 29,496 ms, while the mutant run (plain) took about 1.1 s. Result: passed.
  - Slow 40: main run 37,558 ms. Result: **reverted `tests_insensitive`**. The mutant run would have taken about 1.5 s.
  - So a pytest suite of a few seconds (AUDIT-6 M5: import-heavy suites are slowed 7–16×) can never have an edit committed.
- **Consequence:** deterministically, no edit can ever be kept on a target whose suite takes more than about half the budget. The false reason means the run looks like a test-quality problem. The pipeline has no CLI/orchestrator control of `testTimeoutMs` (AUDIT-2 M5, still open).
- **Expected:**
  - Size mutant slices from a plain (uninstrumented) run time, or give mutant runs their own budget.
  - Report `budget_exhausted` as its own reason (for example `mutation_budget`), not `tests_insensitive`.
- **Repro:**
  ```
  node audit/9/mutant-budget.js --suite-s 29,31,45   # observed passed / tests_insensitive / tests_insensitive
  node audit/9/mutant-budget.js --lang py --suite-s 30,40
  ```

## High

### H1. `editMutants` is quadratic in time and memory on long edited lines and wide spans: 10–15 s on the main thread, 3–4 GB, and an OOM crash with a 2 GB heap
- **Where:** `src/rl/bug-injector.js:240-276` and `mutateAt` (`:194`):
  - For every operator match on the edited lines, it builds a full-file mutant string.
  - `mutated === src` flattens that rope into a new full-file copy.
  - It also computes `src.slice(0, m.index).split('\n')` for the line number.
  - All of this happens before taking the first `max * 4` candidates, and each candidate is then parsed in full.
  - It runs synchronously for every edit whose suite passed.
- **Measured** (`node audit/9/edit-mutants.js --reps 2`):

  | case | p50 ms | max ms | RSS |
  |---|---|---|---|
  | JS 199 KB, 1-line edit | 101 | 236 | 138 MB |
  | JS 190 KB single line (minified), small edit | **10,100** | **14,918** | **3,292 MB** |
  | JS 199 KB, edit spans the first 100 KB | 4,147 | 10,679 | 4,087 MB |
  | Python 199 KB, 1-line edit | 182 | 521 | — |
  | Python 199 KB, edit spans 100 KB | 4,494 | 8,003 | 3,482 MB |

  With `--max-old-space-size=2048` (the default on a ~4 GB machine), the process dies with `FATAL ERROR ... JavaScript heap out of memory` in `String::SlowFlatten` ← `Runtime_StringEqual`. That kills the run mid-edit; the in-flight snapshot restores on the next start.
- **Plausibility:** `file-discovery.js` does not exclude minified files under 200 KB (for example a vendored `*.min.js` in `src/`). Wide spans come from large proposals.
- **Expected:** cap matches scanned per operator, compare by span instead of whole-file equality, and compute line numbers from precomputed line starts.
- **Repro:** `node audit/9/edit-mutants.js` and `node --max-old-space-size=2048 audit/9/edit-mutants.js --reps 1` (crashes on the minified case).

### H2. A mutant run that is merely slow counts as a kill: suites with timing variance get edits kept on false evidence
- **Where:** `executor.js:35`. `r.status === 'timeout' && slice === full` counts as killed, with `full = 2 × main + 1 s`. A mutant run that takes longer for reasons unrelated to the mutant (a retry/backoff path, a slow port or a GC pause) is "evidence" that the suite detects the mutant.
- **Measured** (`node audit/9/mutant-timing.js --mode jitter --repeat 20`):
  - Setup: the suite never asserts (truly insensitive). It sleeps 300 ms, or 2,800 ms with probability 0.2.
  - Result: **7/20 edits kept** (`passed`, `killed by drop_return/swap_arith`); 13/20 `tests_insensitive`.
  - Every kept edit there is a false "the tests can tell" verdict, which SG14's bar (d) exists to prevent.
- **Not triggered by CPU contention from other sessions:** `--mode contention --busy 0,8,16,32` gave 0/32 kept. The test command runs `detached` (its own session), and Linux autogroup scheduling gives it a fair share regardless of how many busy processes run elsewhere. Load in the same session slows a process 9×; that was not tested through the executor.
- **Expected:** a timeout is not a kill unless the unmutated suite is shown to finish within the slice. For example, re-run once on timeout, or treat a timeout as inconclusive.
- **Repro:** `node audit/9/mutant-timing.js --mode jitter --repeat 20`. Observed `tests_insensitive:13 passed:7`; expected `tests_insensitive:20`.

### H3. Module-state snapshots after every call make every edit in a module with moderate exported data `inconclusive` (so `critic_rejected`), and load lowers the threshold
- **Where:** `diff-sandbox-worker.js` `take()` / `exportsState` / `bindState`. On both sides, after every call, the worker serialises args, `this`, every non-function export (≤ 20,000 nodes each) and the module bindings (≤ 5,000 nodes), then stringifies and parses them. With 63 inputs, this exhausts the 1,500 ms budget, so `n < calls.length`, so `inconclusive` "time budget reached". The SG9 gate rejects an inconclusive result with runs > 0.
- **Measured** (`node audit/9/diff-state.js --repeat 3`; edit `x * 2` → `x + x` in a 4-line function next to data):

  | module data | unloaded | 8 busy processes |
  |---|---|---|
  | none | equivalent, 236 ms | — |
  | exported array of 1,000 numbers | equivalent, 345 ms | equivalent, 1,189 ms |
  | exported array of 5,000 numbers (23 KB) | equivalent, 905 ms | **inconclusive 5/5** (46 of 63 inputs) |
  | exported array of 19,000 numbers (101 KB) | **inconclusive 3/3** (53/63) | inconclusive (22/63) |
  | exported object of 2,000 records (65 KB) | **inconclusive 3/3** (38/63) | — |
  | module-scope object of 2,000 records | equivalent, 978 ms | — |

- **Consequence:**
  - Every JS edit in a file that exports a lookup table of this size is rejected, deterministically.
  - Under CPU load the size needed is 4× smaller, so the verdict depends on load.
  - The rejection is safe (no wrong edit gets through), but it is a systematic false rejection.
- **Expected:** snapshot exports/bindings once per call only when the target can reach them (or diff-compare by identity/hash first), and make the per-call snapshot cost independent of the size of untouched data.
- **Repro:** `node audit/9/diff-state.js` and `node audit/9/diff-state.js --contend 8 --case "exported array"`

### H4. The Python drift scan caps files but not bytes, and its 64 MB strip cache thrashes: 5.8 s on every call
- **Where:** `src/validation/polyglot-ast.js:478-512` and `strippedFor` (`:521`). Up to 200 files that name the function are `stripCode`d in full; there is no byte cap like JS's 2 MB. The cache evicts oldest-first, so a sequential scan over more than 64 MB misses on every call.
- **Measured** (`node audit/9/drift-caps.js --cases c`; modules of 500 KB that mention `normalize` and `util` in a comment, no call site):
  - 100 modules (50 MB): cold 3,294 ms, warm 77 ms.
  - 200 modules (100 MB): **cold 10,303 ms, warm 5,756 ms, peak RSS 3,270 MB**. That is 19× the 300 ms budget on *every* call. It repeats in `syntheticNegatives`' `runChecks` per mutant.
- **Plausibility:** large generated Python modules (protobuf `_pb2.py`, vendored code, data modules) that mention a common helper name.
- **Expected:** a byte cap as for JS, and an LRU bounded so that a capped scan fits in it.
- **Repro:** `node audit/9/drift-caps.js --cases c`

## Medium

### M1. The JS drift scan exempts the first parsed file from the 2 MB cap
- **Where:** `ast-checker.js:308`. In `(scanned && bytes + src.length > CALL_SCAN_MAX_BYTES)`, the first candidate is parsed whatever its size.
- **Measured** (`node audit/9/drift-caps.js --cases b`): one importer bundle (`require('./core/normalize')`, `normalize (` only inside a string):
  - 8 MB: cold **3,228 ms**, 598 MB.
  - 20 MB: cold **7,618 ms**, 1,476 MB.
  - Warm (parse cached): 19 / 56 ms.

  The cold cost is paid once per run, per signature-changing proposal.
- **Expected:** skip files over the byte cap (counting them as capped), as for the rest.
- **Repro:** `node audit/9/drift-caps.js --cases b`

### M2. `regexSamples` is quadratic in the number of regex atoms and runs before the hard kill
- **Where:** `diff-testing.js:679-745`. Each quantified or metacharacter atom re-renders the whole atom list, and samples over 600 chars are dropped only afterwards. This runs on the main thread for every regex literal in the changed function, on both versions.
- **Measured** (`node audit/9/diff-regex.js`):
  - Escaped-dot regex: 2 KB 243 ms, 4 KB 551 ms, 8 KB 1,251 ms, 16 KB **4,148 ms**, 32 KB **16,463 ms** (`inconclusive`, runs 0, so `critic_rejected`).
  - `a+` × 4,000 (8 KB): 2,206 ms.
  - Ranked Medium because a regex literal of more than 8 KB of sequential atoms is unusual outside generated code.
- **Repro:** `node audit/9/diff-regex.js`

### M3. SG14 multiplies per-run wall time, with no run-level cap
- **Measured:**
  - Asserting 500-file run: executor p50 6.8 s, which is a 5.0 s main run plus a 1.6 s mutant run.
  - Insensitive suite (audit/6 run): 4 suite runs per edit; executor p50 13.9 s; 720 s for 50 proposals (342 s in AUDIT-6). All 49 reverted.
  - Slow suite: 2× suite time per kept edit (58.4 s at 29 s).
  - There is still no run-level budget or CLI control (AUDIT-2 M5).
- **Repro:** `node audit/6/pipeline-load.js --proposals 50 --drift --serve` (`executor total` row, 196 `runTests`), `node audit/9/mutant-budget.js`

### M4. Dirty-file sync on worktree re-creation (resume) is synchronous and linear in untracked files
- **Measured** (`node audit/9/resume-dirty.js`): `resumeWorktree` after the worktree directory vanished:
  - 1,000 untracked files: 157 ms.
  - 25,000: 2,293 ms.
  - 100,000: **15,701 ms**, main thread blocked throughout.
- **Correctness holds at every size:**
  - A target-dirty tracked file is synced.
  - A file the branch changed keeps the branch version.
- **Context:** AUDIT-6 L3 (an un-ignored `node_modules` is copied, not linked) applies here too.
- **Repro:** `node audit/9/resume-dirty.js --untracked 1000,25000,100000`

### M5. (Carried, AUDIT-6 M1) The indent-shift tier is O(starts × anchor lines)
- **Measured:** 6,000 identical lines: 4,327 ms; 2,000: 2,344 ms (budget 100 ms). Unchanged.
- **Repro:** `node audit/6/anchor-adversarial.js --case indent-dup`

### M6. (Carried, AUDIT-6 M3) Diff-test verdicts on identical code depend on CPU load
- **Measured:**
  - 150 ms per call, unloaded: 10/10 `inconclusive`.
  - 100 ms per call with 8 busy processes: 10/10 `inconclusive`.
  - 0 divergent.
- **Repro:** `node audit/2/diff-patho.js --flaky cpu-100ms-per-call --repeat 10 --contend 8`

## Low

### L1. (Carried, AUDIT-6 L1) `regionHazard` regex scan on a 99 KB line takes 16,143 ms
- **Repro:** `node audit/6/anchor-adversarial.js --case regex-scan`

### L2. (Carried, AUDIT-6 L4) The setsid daemon outlives `runTests`
- **Measured:** `sleep 240` was still alive after `hang-escape` returned. With SG14 each kept edit runs the suite 2–4 times, so such daemons accumulate faster.
- **Repro:** `AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes hang-escape`

### L3. The hard-kill reason reports a negative budget
- **What:** when main-thread preparation exceeds 3,000 ms (C1, M2), the result reads `hard kill: sandbox did not finish within -16341 ms (after 0 runs)`. The real cause (the time was spent before the worker started) is not reported.
- **Repro:** `node audit/9/diff-explosion.js --case rows-n1999`

### L4. Peak RSS of the end-to-end run is 721 MB (AUDIT-6: 589 MB)
- **Repro:** `node audit/9/pipeline-load.js --proposals 50 --drift --serve` (`proc after` line)

### L5. (Carried, AUDIT-6 L5) Session I/O at scale
- **Measured:** `saveSession` 566 ms and `loadSession` 365 ms at 5,000 proposals; `sessionPath()` 27 ms at 5,000 target dirs.
- **Repro:** `node audit/6/session-resume-scale.js --parts a,b`

### L6. Dashboard stalls of about 1.7 s during the run
- **Measured** with `--serve`: `/healthz` max 1,732 ms; `/` p95 1,079 ms, max 1,640 ms; main-thread max stall 1,743 ms. These come from synchronous validation, `syntheticNegatives` and git commits; similar to AUDIT-6 (1,964 ms).
- **Repro:** `node audit/9/pipeline-load.js --proposals 50 --drift --serve`

---

## What holds

- **All prior criticals and highs (AUDIT-2 C1, C2, H1, H2; AUDIT-6 C1, C2, C3, H1, H2) are fixed** on their original repros (table above).
- **SG16 async coverage evaluation is bounded and responsive:**
  - Post-exit work is ≤ 824 ms for 200 processes, with max stall ≤ 136 ms.
  - In the 500-file run it is 394 ms p50.
  - Coverage runs only on the main run: mutant runs collect none (1.6 s vs 5.0 s).
- **coverage.py** reports only the edited file, and `exercised` is now correct at 9.8–19.2 MB of imported Python.
- **The JS drift scan stays within budget at realistic and stressed shapes:**
  - 2,000 files × 60 KB (120 MB) that name the function without importing it: cold 173 ms, warm 152 ms.
  - On the 500-file fixture: cold 53 ms.
  - A real caller beyond the old cap is found.
- **SG17 resume re-creation is correct under large dirty sets** (synced vs branch-changed files, up to 100k untracked). Resume reconciliation now finds every commit above 1 MB of log (6,000 commits in 169 ms).
- **The SG14 bar works on the load fixture:** with an asserting suite, 49/49 edits were kept after exactly one mutant run each (the first mutant killed), and the drift proposal was vetoed.
- **CPU contention from other sessions does not distort mutant timing** (0/32 false kills), because test commands run in their own session.
- **The SG15 state snapshot is bounded per call** (node budgets 20,000/5,000). A 50,000-entry module-scope `Map` costs 563 ms.
  - **The diff test is unchanged on the round-2 stress set:** class with 2,000 methods 209 ms, 20k mined literals 504 ms, 500 require stubs 301 ms, 199 KB file 457 ms.
  - No case was divergent on identical code.
- **Resources:** FDs are steady, no test process is left after a timeout kill, and the thread count is stable after the libuv pool starts.

## Repro scripts (`audit/9/`)

| script | what it measures |
|---|---|
| `lib.js` | loads `test/helpers/env.js` (temp state dir), wraps `audit/2/lib.js`; git, stats, stall, contention, RSS helpers |
| `rerun-prior.sh` | re-runs the AUDIT-2 / AUDIT-6 scripts, each under `timeout 900`: `bash audit/9/rerun-prior.sh [OUT_DIR] [name ...]` |
| `pipeline-load.js` | end-to-end 500-file run with an asserting suite; main vs mutant `runTests`, mutation evidence (`AUDIT_SUITE_PAD_MS` for slow suites; all audit/2 flags) |
| `diff-explosion.js` | C1: diff-test input generation on nested-row functions vs literal, parameters, targets (`--case`, `--timeout-s`) |
| `validator-explosion.js` | C1 end to end: `runHybridValidator` time, main-thread stall, gate decision (`--lit`, `--params`) |
| `mutant-budget.js` | C2, M3: `runExecutor` outcome and wall time vs suite duration, JS and Python (`--lang`, `--suite-s`, `--sensitive`, `--budget-ms`) |
| `mutant-timing.js` | H2: false kills from timing variance or CPU spikes with an insensitive suite (`--mode jitter\|contention\|steady`, `--busy`, `--repeat`) |
| `edit-mutants.js` | H1: `editMutants` time/memory on minified lines and wide spans |
| `diff-state.js` | H3: module-state snapshot cost vs exported/module data (`--case`, `--repeat`, `--contend`) |
| `drift-caps.js` | H4, M1: drift scan on 2,000-file, single big bundle and big-Python-module repos (`--cases a,b,c`, `--bundle-mb`) |
| `diff-regex.js` | M2: regex-sample generation vs regex size |
| `resume-dirty.js` | M4: `resumeWorktree` re-creation vs untracked-file count, and sync correctness |

Numbers vary by about ±15% between runs on this machine. Reproduced at least twice:
- C1 (the 1-param case three times; the 4-param and two-function rows once each, because of their cost)
- C2 (the JS 31 s and 45 s rows once each, plus the threshold confirmed by the Python sweep)
- H1 and H3

H4 was run once (with two warm repetitions).

The AUDIT-2 and AUDIT-6 scripts were re-run unchanged with `audit/9/rerun-prior.sh`. The first `diff-state` and `diff-explosion` runs overlapped that re-run; the tables above are from quiet re-runs, except `diff-explosion` rows other than `rows-n1999`.
