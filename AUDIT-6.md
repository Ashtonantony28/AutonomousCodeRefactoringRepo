# AUDIT-6 — Performance under load, round 2

This audit covers commit `9420b9a` (SG10, after SG9–SG13). It is PLAN.md "Audits" item 2, round 2, done by an independent auditor. No `src/`, `test/`, `PLAN.md`, `CLAUDE.md` or `README.md` changes were made.
All load is generated at runtime under `os.tmpdir()` by the scripts in `audit/6/` (and `audit/2/`). Each script sets its own `REFACTOR_STATE_DIR`, and every pipeline run uses the stub client, so no live API call is made and `state/` and `dashboard/` are never touched.

**Machine:** Linux, 4 vCPU, 15 GB RAM, Node v22.22.0, Python coverage 7.16.2 (in pytest's uv interpreter).

**Load repo:** the repo is the `audit/2/lib.js genRepo` fixture: 500 JS files, 19.1 MB, 50 files of about 197 KB, directories 1–12 levels deep. `audit/6/pipeline-load.js` makes two changes to it:
- Every function is exported.
- The suite requires every module and calls every export.

These changes are needed because of SG12. With audit/2's `fast` suite, the tests never execute any edit, so every edit is now reverted as `edit_not_exercised`. Proposals are seeded and run with `resume: true`, as in AUDIT-2.

## Round-1 criticals and highs: status

| AUDIT-2 id | re-run | observed now | status |
|---|---|---|---|
| C1 setsid test hang | `AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes fast,hang-escape,hang` | hang-escape **0.5 s `passed`** (was 240.2 s `timeout`); hang 60.0 s `timeout`, nothing left in the group | **fixed**. The daemon itself is still alive afterwards (L4) |
| C2 fuzzy anchor blowup | `node audit/2/anchor-patho.js --reps 3` | all 8 cases p50 0.6–71 ms, max 81 ms (was up to 932,685 ms and >1,500,000 ms) | **fixed**. The other tiers are not bounded the same way (M1, L1) |
| H1 signature_drift scan | `node audit/2/ast-scale.js` | (b) K=500 p95 **7.5 ms** (was 6,736 ms); (c) validator p50 117 ms | **fixed for that case only.** It is still 3.0 s when the name is common and the cap is reached (H2), and it is unfixed for Python/Go/Ruby (H1) |
| H2 diff-test timeout flakiness | `node audit/2/diff-patho.js --flaky cpu-150ms-per-call --repeat 10` and `... cpu-100ms-per-call --repeat 10 --contend 8` | **0/20 divergent** (was 7/10 and 5/10). Instead: 6/10 and **10/10 `inconclusive`** | **fixed as stated.** Load still changes the outcome: inconclusive → `critic_rejected` (M3) |

## Summary: measured numbers vs budget

Main run: `node audit/6/pipeline-load.js --proposals 50 --drift --serve`. This is 49 "inline temporary" edits (half of them on 197 KB files) plus one signature change of `normalize()`. The run was 49 `passed` and 1 `vetoed`. The veto is correct: the drift has real call sites.

| stage (per proposal) | PLAN p95 budget | 50-proposal run p50 / p95 / max (ms) | worst case measured (script) | verdict |
|---|---|---|---|---|
| AST `runChecks` | 300 | 89 / **364** / 482 (7/50 over) | JS drift, common name, cold: **3,039** (`drift-scan` a); Python drift: **1,007–1,170 on every call** (`drift-scan` b) | **over** |
| Differential test `diffTesting.run` | 2,000 (hard kill 3,000) | 172 / 346 / 398 | 1,899 (`load-time-900ms`); 924 for a 199 KB file with 8 busy processes; 975 stub chain | within |
| Anchor match + apply `applyEdit` (≤ 200 KB) | 100 | 1.2 / 3.3 / 33 | indent-shift on repeated lines: 661 (500-line anchor), **4,434** (6,000 lines); regex scan on a 99 KB line: **16,738** | **over** on adversarial inputs |
| Whole validation `runHybridValidator` | 2,500 | 249 / 707 / 881 | Python drift 1,098; JS cold drift > 3,000 (`runChecks` alone is 3,039) | over on the cold drift case |
| `runTests` in full (no budget; test timeout 60 s) | — | 5,661 / 6,858 / 7,922 | post-exit V8 coverage work: **110,158** (200 processes, 20 KB edit); coverage.py: **30,036** and a wrong verdict | **unbounded** (C1, C2) |
| of which post-exit coverage work | — | 404 / 542 / 602 | see C1 | — |
| `syntheticNegatives` | — | 817 / 1,090 / 1,126 | — | 29.1 s of the run |
| `commitProposal` | — | 169 / 211 / 258 | — | — |
| `saveSession` | — | 5.0 / 9.0 / 29 (103 writes) | 543 per write at 5,000 proposals | — |
| `createWorktree` | — | 219 | 1,152 with 10k untracked files; wrong result at 25k (C3) | — |

| whole-run metric | measured |
|---|---|
| Wall time, 50 proposals | 342.2 s. The exercising suite is 263 s of it; validator 19.8 s, synthetic negatives 29.1 s |
| Peak RSS (VmHWM) | **589 MB** (AUDIT-2: 373 MB with a suite that loaded nothing) |
| Main-thread stall (10 ms ticker) | p95 0.7 ms, max **1,964 ms** (AUDIT-2: max 7,660 ms) |
| Dashboard `/healthz` with `--serve` | p50 1.4 ms, p95 2.8 ms, max 1,938 ms; `/` p95 1,174 ms, max 1,713 ms; SSE lag p95 42 ms |
| Leaks | threads 7→7, FDs 25→25, 2 worktrees on the target (1 + this run) |
| Diff-test memory | memory-hog 300 MB, **452 MB** after 10 runs (AUDIT-2: 453 / 717 MB); 16 MB string 85 MB |

Severity counts: **Critical 3, High 2, Medium 5, Low 7.**

---

## Critical

### C1. V8 coverage post-processing is quadratic and synchronous, and runs outside the test timeout: stalls of minutes
- **Where:** `src/runner/test-runner.js:193-228` (`v8Exercised`), in two places:
  - Line 226: every probe (each non-whitespace character of the changed span) goes through `lineOf` (`:146`), which scans from offset 0. That is O(span × offset).
  - Lines 210-222: for every coverage file of every process that loaded the edited file, every probe not yet hit is checked against every V8 range of the file. That is O(processes × span × ranges). Probes that are never hit (exactly the `edit_not_exercised` case) are re-scanned in every process.
- **Why it is unbounded:** all of this runs after the child has exited. It is not under `timeoutMs`, it blocks the event loop (the `--serve` dashboard included), and the SIGINT/SIGTERM handlers cannot run during it.
- **Measured** (199 KB module of about 2,800 functions, edit at the end of the file, tests load the file but do not run the edit; `post` = total − suite time):

  | case | suite ms | post-exit ms (main thread blocked) |
  |---|---|---|
  | 1 process, 2 KB span | 274 | 1,121 |
  | 1 process, 20 KB span | 268 | 8,396 |
  | 1 process, 50 KB span | 254 | 20,495 |
  | 1 process, 190 KB span | 249 | **49,571** |
  | 200 processes, 2 KB span | 12,195 | 11,811 |
  | 100 processes, 20 KB span | 5,423 | **59,483** |
  | 200 processes, 20 KB span | 11,673 | **110,158** |

  The size of the coverage JSON is not the problem: 8 × 5 MB modules (70 MB of JSON) added only about 0.6 s. In the 500-file pipeline run, with edits in the middle of the files, the post-exit cost was already 404 ms p50 and 602 ms max per proposal.
- **Expected:** coverage evaluation in O(span + ranges) per process: line starts computed once, ranges sorted or indexed. A large span or many processes should cost seconds at most, and the work should be bounded by the test timeout.
- **Repro:**
  ```
  node audit/6/coverage-load.js --cases span    # observed 49,571 ms post-exit at 190 KB span
  node audit/6/coverage-load.js --cases procs   # observed 110,158 ms at 200 procs x 20 KB
  node audit/6/coverage-load.js --quick         # ~1 min smoke version
  ```

### C2. coverage.py: `coverage json` exceeds its 30 s spawnSync timeout on about 7 MB of imported Python, so exercised edits are reverted as `edit_not_exercised`
- **Where:** `src/runner/test-runner.js:292`. `spawnSync(cmd, ['-m','coverage','json',...], { timeout: 30_000 })` writes a report for every measured file, not just the edited one. When it is killed there is no JSON, so `pyExercised` returns `no coverage data`, which becomes `exercised: false` and the edit is reverted. The call is synchronous, so the main thread is blocked for the full 30 s, outside the test timeout.
- **Measured** (`coverage json` alone, generated pytest repos): 1.0 MB of source took 4.3 s, 2.0 MB took 7.7 s, and 3.9 MB took 18.8 s. That is about 4.5 s per MB. Through `runTests`, where the test calls the edited function:

  | modules | MB | plain suite | suite under `coverage run` | post-exit (blocked) | result |
  |---|---|---|---|---|---|
  | 50 | 9.8 | 343 ms | 5,361 ms | **30,036 ms** | `passed` but `exercised: false edit_not_exercised` |
  | 200 | 12.9 | 621 ms | 6,774 ms | 30,056 ms | same |
  | 500 | 19.2 | 702 ms | 10,120 ms | 30,040 ms | same |

  Every Python edit in such a repo is reverted with a false reason, deterministically, after a 30 s stall.
- **Expected:** `exercised: true`. The report should be limited to the edited file (`coverage json --include <file>`), or the data should be read for that file only.
- **Repro:** `node audit/6/coverage-py.js --files 50`. Observed `post_ms 30036 ... false edit_not_exercised`; expected `exercised: true`.

### C3. Dirty-file sync is silently skipped when `git status` output exceeds 1 MB, so the worktree validates and tests HEAD, not what the Analyzer read
- **Where:** `src/runner/worktree.js:49-50`. `syncDirtyFiles` runs `git status --porcelain -z -uall` through `execFileSync` with the default 1 MB `maxBuffer` (`gitRaw`, `:14`). Over the limit, `tryGitRaw` returns `null` and the function returns `[]`. No warning is printed and `dirty_synced` is empty.
- **Trigger:** about 17k or more untracked, non-ignored files. A common case is a target without `node_modules/` in `.gitignore`.
- **Measured:**

  | untracked files | status MB | `createWorktree` ms | synced | modified tracked `src/a.js` in worktree |
  |---|---|---|---|---|
  | 1,000 | 0.06 | 163 | 1,001 | yes |
  | 10,000 | 0.60 | 1,152 | 10,001 | yes |
  | 25,000 | 1.51 | 101 | **0** | **no: HEAD version** |

- **Consequence:** this breaks the CLAUDE.md contract "uncommitted target changes are copied into the worktree".
  - Proposals whose anchor exists only in the uncommitted code end as `apply_failed`.
  - Proposals whose anchor also exists at HEAD are validated, tested and committed against code the Analyzer never saw.
- **Expected:** a full sync (larger `maxBuffer` or streamed output), or a loud failure.
- **Repro:** `node audit/6/session-resume-scale.js --parts d`. Observed the `25000 ... 0 NO (worktree has HEAD version)` row.

## High

### H1. The polyglot (Python/Go/Ruby) `signature_drift` scan is unchanged by SG9: about 1.1 s on every call, with no cap, cache or early stop
- **Where:** `src/validation/polyglot-ast.js:478-499`. It walks up to 500 files. Every file that contains the name as a substring is put through `stripCode`, which runs `split('')` on the whole file, and then a regex scan. It does not stop at the first call site and does not cache parses. AUDIT-2 H1 was fixed only in `ast-checker.js`.
- **Measured:** 500-file Python repo (19.1 MB, 50 files of 197 KB), signature change of a helper imported everywhere:
  - `runChecks`: cold 1,170 ms, warm p50 1,007 ms, max 1,116 ms. That is 3.4–3.9× the 300 ms budget.
  - `runHybridValidator`: 1,098 ms.
  - `syntheticNegatives` repeats `runChecks` for each mutant.
- **Expected:** ≤ 300 ms, as for JS since SG9.
- **Repro:** `node audit/6/drift-scan.js`. Observed rows `(b) python runChecks ... 1170 1007`.

### H2. JS `signature_drift` with a common function name parses up to 200 large files on the first check: 3.0 s
- **Where:** `src/validation/ast-checker.js:270-296` (cap `CALL_SCAN_MAX_FILES = 200` at `:301`). When many files mention the name but none is a call site, nothing stops the scan. Typical cases are files with their own local `normalize`/`format`/`parse`, or files that use the name without importing the edited module. Up to 200 files are Babel-parsed, each up to 199 KB.
  - The parse cache is per process, so the first such proposal of every run pays this cost.
- **Measured:** 500-file repo (19.1 MB):
  - `runChecks` cold: **3,039 ms** (2,881 ms in a second run), about 10× the budget.
  - Warm: 35 ms p50.
  - The detail reads "capped at 200 files".
- **Expected:** ≤ 300 ms p95. A byte budget (not a file-count cap) or an import-graph prefilter before parsing would bound this.
- **Repro:** `node audit/6/drift-scan.js`. Observed row `(a) js runChecks, 500 files ... cold_ms 3039`.

## Medium

### M1. The indent-shift tier is O(starts × anchor lines) on self-similar anchors and has no occurrence cap
- **Where:** `src/runner/anchor-matcher.js:165-209`. For a periodic anchor, the KMP prefilter yields every line as a start. Each start is then compared over all N anchor lines, building `P + dl[k]` strings, before the ambiguity is reported. The exact and whitespace tiers stop at 100 occurrences; this tier does not.
- **Measured** (199 KB file of identical 4-space-indented lines; anchor of N identical lines at indent 0, which is ambiguous in the end):

  | N | time |
  |---|---|
  | 100 | 140 ms |
  | 500 | 661 ms |
  | 2,000 | 2,343 ms |
  | 6,000 | **4,434 ms** |

  Budget: 100 ms; SG10 claimed a worst case below 1 s. This is ranked Medium rather than High because it needs a long run of identical lines (for example generated tables) plus a re-indented anchor.
- **Repro:** `node audit/6/anchor-adversarial.js --case indent-dup`

### M2. The 200-file drift cap is a load-dependent false pass
- **Where:** `ast-checker.js:276`. This behaviour is by design (SG9 and CLAUDE.md), and the detail says "rest not checked". It is listed because the result depends on repo size: the same edit is vetoed in a small repo and passes in a large one.
- **Measured:** in the H2 repo plus `src/aa/caller.js`, which imports `normalize` and calls it with the old arity, the check returns **pass**. Without the 200 other mentioning files it fails. Only executed tests can catch the drift after that.
- **Repro:** `node audit/6/drift-scan.js`. Observed row `(d) js: real caller after the cap ... pass (call site missed)`.

### M3. Diff-test verdicts on identical code still depend on CPU load: `inconclusive`, so `critic_rejected`
- **Where:** `diff-sandbox-worker.js` per-call timeout (250 ms) and budget (1,500 ms); the SG9 gate rejects `inconclusive` with `runs > 0`.
- **Measured:** current and proposed differ only by a comment.
  - 150 ms per call, unloaded: 4 equivalent, **6 inconclusive** out of 10.
  - 100 ms per call with 8 busy processes: **10/10 inconclusive**.
  - None was divergent, so the AUDIT-2 H2 fix holds.
- **Repro:** `node audit/2/diff-patho.js --flaky cpu-100ms-per-call --repeat 10 --contend 8`. Observed `{"inconclusive":10}`.

### M4. AST checks on files near 200 KB exceed the budget in the end-to-end run
- **Measured:** pipeline run p95 **364 ms**, max 482 ms, with 7 of 50 over 300 ms. `ast-scale` (a) at 199 KB: p95 301 ms. This is AUDIT-2 L3 carried forward; it is now over budget in a real run.
- **Repro:** `node audit/6/pipeline-load.js --proposals 50 --drift --serve` (row `ast runChecks`), and `node audit/2/ast-scale.js`.

### M5. `coverage run` slows the Python suite by 10–16× against the fixed 60 s timeout
- **Measured:** suite time went from 343 ms to 5,361 ms, 621 ms to 6,774 ms, and 702 ms to 10,120 ms (`coverage-py.js`, import-heavy suites).
  - With the same factor, a suite of about 4–6 s plain would hit the 60 s timeout, and every edit would be reverted as `timeout`.
  - There is still no CLI or orchestrator control for `testTimeoutMs` (AUDIT-2 M5).
- **Repro:** `node audit/6/coverage-py.js` (columns `plain_ms` vs `cov_suite_ms`).

## Low

### L1. `regionHazard` regex scanning is quadratic on long lines with unterminated `/[`
- **Where:** `anchor-matcher.js:590` and `:647`. Every `/` after punctuation rescans to the end of the line.
- **Measured:** whitespace-tier match on a 99 KB line `x = (/[(/[...`: **16,738 ms**.
- **Why Low:** valid JS closes its regexes, so the trigger needs invalid JS or a "generic" (non-JS/Python) file with such a line.
- **Repro:** `node audit/6/anchor-adversarial.js --case regex-scan`

### L2. Resume reconciliation silently finds nothing above 1 MB of `git log`
- **Where:** `worktree.js:143` (`committedIssues`, default 1 MB `maxBuffer`).
- **Measured:**
  - 400 commits with 2 KB reasoning: 400 found.
  - **600: 0 found, 0 reconciled.**
  - 3,000 commits with 200 B reasoning: all found.
  - **6,000: 0.**

  The committed proposals would be re-executed.
- **Why Low:** the Analyzer cap keeps a run's branch to about 30 commits.
- **Repro:** `node audit/6/session-resume-scale.js --parts c`

### L3. Dirty sync copies every untracked file into each run's worktree
- **Measured:** 10k files took 1,152 ms per `createWorktree`. An un-ignored `node_modules` is copied instead of symlinked, because `linkNodeModules` runs after the sync and skips an existing directory.
- **Repro:** `node audit/6/session-resume-scale.js --parts d`

### L4. The setsid daemon outlives `runTests`
- **Measured:** `sleep 240` was still running after `hang-escape` returned `passed` in 0.5 s. This is the SG12 open item; repeated runs accumulate such daemons.
- **Repro:** `AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes hang-escape` (leftover column).

### L5. Session I/O at scale
- **Measured:**
  - `saveSession`: 6 ms at 100 proposals, 103 ms at 1,000, 543 ms at 5,000 (50 MB).
  - `loadSession`: 422 ms at 5,000.
  - `sessionPath()` with no target (standalone dashboard, every 250 ms watcher tick): 4.8 ms at 1,000 target dirs, 30.5 ms at 5,000.
- **Why Low:** sessions are per target and reset on every non-resume run, so they stay small.
- **Repro:** `node audit/6/session-resume-scale.js --parts a,b`

### L6. Peak RSS of the end-to-end run is 589 MB
- **Measured:** 589 MB, up from 373 MB in AUDIT-2. The cause was not attributed; the likely sources are V8 coverage JSON of a process that loaded 19 MB of source, plus diff-test workers. Diff-test memory is still not bounded by `RESOURCE_LIMITS`: memory-hog reaches 452 MB after 10 runs.
- **Repro:** `node audit/6/pipeline-load.js --proposals 50` (`proc after` line), and `node audit/2/diff-patho.js`.

### L7. (Precision, not performance) The diff-test generator cannot satisfy nested reads
- **Measured:** functions that read `o.aI.bJ.cK` (400 paths) or `cfg.kI[j].vI` (30 indexed keys) throw on every input on both sides. The result is `inconclusive` ("both sides threw on every input"), so the edit is `critic_rejected`, for any edit to such a function.
- **Repro:** `node audit/6/diffgen-load.js --case deep-object-3-levels-20-keys`

---

## What holds

- **Round-1 criticals are fixed:**
  - `runTests` resolves on `exit` (setsid case 0.5 s).
  - The fuzzy tier is bounded on every AUDIT-2 case (≤ 81 ms).
- **The fuzzy tier's pruning withstood targeted attacks:**
  - Anchors of 30–100 KB built to defeat the hashed 3-gram bound (random lowercase anchor vs uppercase file) were rejected in 18–33 ms.
  - 200 lines of distinct near-duplicates stopped in 65 ms.
  - The whitespace tier plus region lexing on a whole 199 KB file took 86 ms.
- **Diff test (SG11)** stays within budget on every input-generation stress case: 200 changed callables (532 ms p50), a class with 2,000 methods (256 ms), 20k mined literals (270 ms), 500 `require` stubs (197 ms), a 199 KB file (217 ms; 822 ms p50 with 8 busy processes).
  - Main-thread preparation before the worker starts is ≤ 437 ms.
  - Input literals are ≤ 400 KB.
  - No case reached the hard kill, and none was divergent on identical code.
- **The JS drift scan** on the AUDIT-2 shape is 7.5 ms p95 (K=500). The warm cache is 35 ms. The pipeline's drift proposal is correctly vetoed.
- **Coverage JSON size** is not a bottleneck: 70 MB of coverage JSON costs about 0.6 s.
- **Dashboard responsiveness improved:** max stall 1.96 s (was 7.66 s), `/healthz` p95 2.8 ms.
- **Resources:** threads and FDs are steady across the run, and no test processes are left after a timeout kill.
- **Resume reconciliation and session I/O are fast at realistic sizes:** 11–26 ms for ≤ 600 commits; 5 ms per save at 50 proposals.

## Repro scripts (`audit/6/`)

| script | what it measures |
|---|---|
| `lib.js` | wraps `audit/2/lib.js`; temp state dir, rng, timing and table helpers |
| `pipeline-load.js` | end-to-end 500-file run with an exercising suite, plus full `runTests` and post-exit coverage timing (all `audit/2/pipeline-load.js` flags) |
| `coverage-load.js` | C1: V8 coverage post-processing vs span size, process count and coverage JSON size (`--cases span,procs,json`, `--quick`) |
| `coverage-py.js` | C2, M5: coverage.py path vs repo size (`--files`) |
| `drift-scan.js` | H1, H2, M2: JS and Python `signature_drift` repo scans, cold/warm, and the cap false pass |
| `anchor-adversarial.js` | M1, L1, and attacks on the fuzzy pruning (`--case PREFIX`) |
| `diffgen-load.js` | diff-test input generation, large classes, deep objects, mined literals, require stubs (`--case`, `--contend N`, `--repeat N`) |
| `session-resume-scale.js` | C3, L2, L3, L5: session I/O, `sessionPath()`, resume reconciliation, dirty-file sync (`--parts a,b,c,d`) |

Numbers vary by about ±15% between runs on this machine. The C1 and C2 tables, the H1 and H2 numbers, and M1 were each reproduced at least twice; the 100- and 200-process C1 rows were run once. AUDIT-2 scripts were re-run unchanged, each under `timeout 900`.
