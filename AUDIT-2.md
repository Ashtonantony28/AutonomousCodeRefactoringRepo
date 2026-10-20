# AUDIT-2 — Performance under load and the latency budget

Audit of commit `e928c06` (PLAN.md "Audits" item 2). Independent auditor; no `src/` or `test/` changes.
All load is generated under `os.tmpdir()` by the scripts in `audit/2/`, which call the production modules directly. Each script sets its own `REFACTOR_STATE_DIR`, so the repo's `state/` is never touched.

**Machine:** Linux, 4 vCPU, 16 GB RAM, Node v22.22.0. `npm run bench` on the fixtures was within budget everywhere: AST p95 1.0 ms, diff p95 98 ms, apply p95 31 ms, validator p95 102 ms.

**Load repo** (`audit/2/lib.js genRepo`): 500 JS files, 19.1 MB in total, 1–12 directory levels deep. 50 files are about 197 KB and the rest are 1–41 KB. A helper `normalize()` in `src/core/normalize.js` is imported by every file. The repo has `npm test` and a git commit. Proposals go through `runPipeline` with the stub client (`test/helpers/stub-client.js`), `cache: 'off'` and a jury of three approving critics. The Analyzer caps itself at 10 proposals (`TARGET_PROPOSALS`), so the 50 proposals are seeded into `session.json` and run with `resume: true`. Everything after the Analyzer is the production path.

## Summary: measured numbers vs budget

Main run: `node audit/2/pipeline-load.js --proposals 50 --drift --serve`. This is 49 "inline temporary" edits (half on 197 KB files) plus one signature-changing edit of `normalize()`. The `--serve` dashboard server runs in the same process and is polled from another process. Result: all 50 passed.

| stage (per proposal) | PLAN p95 budget | 50-proposal run p50 / p95 / max (ms) | worst pathological case measured | verdict |
|---|---|---|---|---|
| AST `runChecks` | 300 | 185 / 288 / **6,918** | signature change, 500 referencing files: **6,736** p50 (`ast-scale.js`) | **over** (2/50 in the run) |
| Differential test `diffTesting.run` | 2,000 (hard kill 3,000) | 136 / 190 / 213 | 1,921 unloaded; **2,131** with 8 busy processes on 4 CPUs | within budget unloaded; hard kill never reached |
| Anchor match + apply `applyEdit` (≤ 200 KB) | 100 | 0.6 / 1.5 / 1.5 | **932,685** (1,000-line anchor); **>1,500,000** (half-file anchor, killed) | **over** on fuzzy tier |
| Whole validation `runHybridValidator` | 2,500 | 334 / 492 / **7,061** | 6,822 p50 (drift, K=500) | **over** (1/50) |
| tests `runTests` (no budget) | — | 184 / 217 / 237 | 20 s suite: 20,248; hang: 60,010; escaped daemon: **90,187 / 240,200** (unbounded) | — |
| `syntheticNegatives` (no budget) | — | 641 / 790 / 6,879 | — | 44% of wall time |
| `commitProposal` (sync git) | — | 141 / 168 / 271 | — | — |
| `saveSession` | — | 4.3 / 7.9 / 10.8 (103 writes, 32.9 MB written) | 65 ms per write at 1,000 proposals; a run growing to 300 proposals writes 0.86 GB | quadratic |

| whole-run metric | measured |
|---|---|
| Wall time, 50 proposals, fast tests | **66.1 s** (1.32 s per proposal). Validator 19.6 s, executor 16.7 s, synthetic negatives 29.0 s |
| Wall time, 5 proposals, 20 s suite | 110.6 s |
| Wall time, 2 proposals, hanging suite | 122.1 s (60 s timeout each, no run-level cap) |
| Wall time, 2 proposals, suite leaves a 90 s daemon | 182.5 s; **both correct edits reverted as `timeout`** |
| Peak RSS (VmHWM) | 373 MB (50-proposal run); 453 MB for one memory-hog diff test; 717 MB after 10 |
| Main-thread stall (10 ms ticker) | p95 660 ms, **max 7,660 ms** |
| Dashboard `/healthz` while the pipeline runs (`--serve`) | p50 1.5 ms, p95 971 ms, **max 7,649 ms** (9,074 ms in a first run with a vetoed drift edit) |
| SSE lag after `saveSession` | p50 15 ms, p95 28 ms (50 events for 103 writes) |
| Leaks | Threads 7→7 and FDs 25→26 across the run. No orphaned diff-test workers, even after 10 back-to-back OOM or hang runs. No test processes left after the timeout kill. **One git worktree, one branch and ~20 MB are left per run.** |

Severity counts: **Critical 2, High 2, Medium 5, Low 7.**

---

## Critical

### C1. A suite that leaves a `setsid` daemon makes `runTests` wait until the daemon exits; the 60 s timeout does not bound it, and a passing suite is reported as `timeout`
- **Where:** `src/runner/test-runner.js:93-111` (`runCommand`). Resolution waits only for `close`, which needs every holder of the stdout/stderr pipes to exit. `killGroup` signals only the npm process group, so a descendant that called `setsid()` (for example `spawn(..., { detached: true, stdio: 'inherit' })`, a common way to start a test DB or server) keeps the pipes open. The timer at 60 s sets `timedOut = true` but cannot make `close` fire.
- **Measured:** the suite prints `1 passing` and exits 0 at once. `runTests` returns after **90.2 s** with status `timeout` when the daemon lives 90 s, and after **240.2 s** when it lives 240 s. It grows linearly with the daemon's lifetime, so a daemon that never exits hangs the pipeline forever. Through `runPipeline`, 2 proposals took **182.5 s** and both correct edits were reverted (`statuses: {"timeout":2}`).
- **Expected:** `passed` in under 1 s. At worst, a hard bound at the 60 s timeout.
- **Repro:**
  ```
  AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes hang-escape
  # observed: hang-escape ... 240.2  timeout      expected: passed, <1 s
  AUDIT_DAEMON_S=90 node audit/2/pipeline-load.js --files 50 --proposals 2 --test hang-escape
  # observed: wall 182.5 s, statuses {"timeout":2}, tests p50 90187 ms
  ```

### C2. The fuzzy anchor tier is super-linear and blocks the process for minutes on a 199 KB file
- **Where:** `src/runner/anchor-matcher.js:317-332` (`fuzzyMatch`). For every line it rebuilds an N-line window string and runs a banded Levenshtein of width about `0.17 × anchorLength`. That costs O(lines × N) to build the windows and O(lines × anchorLength²) when the near-duplicate windows get past the character-histogram bound. It runs synchronously inside `applyEdit` (`src/runner/reverter.js:104`).
- **Measured** (`applyEdit`, 199 KB file, anchor misses tiers 1–3 so the fuzzy tier runs; budget 100 ms):

  | case | ms |
  |---|---|
  | exact, short anchor (control) | 2.2 |
  | 10-line anchor, 802 near-duplicate blocks | 72.5 |
  | 50-line anchor (1.5 KB), 137 blocks | **272.9** |
  | 200-line anchor (6.5 KB), 32 blocks | **1,338** |
  | 300 identical lines with one changed, in 18k identical lines | **45,822** |
  | 1,000-line anchor (33.7 KB), 6 blocks | **932,685** (15.5 min) |
  | anchor = half the file, re-indented, one token changed | **>1,500,000** (killed by `timeout 1500`) |

  Every case rejects in the end (`throw:fuzzy`), so all of this time is spent to produce an `apply_failed`.
- **Expected:** ≤ 100 ms for files ≤ 200 KB, as PLAN.md requires for all tiers.
- **Repro:**
  ```
  node audit/2/anchor-patho.js --reps 1 --case 7   # observed 45822 ms, expected <=100
  node audit/2/anchor-patho.js --reps 1 --case 2   # observed 273 ms
  node audit/2/anchor-patho.js --reps 1 --case 4   # observed 932685 ms (takes ~16 min)
  ```

## High

### H1. The AST `signature_drift` check parses every repo file that mentions the name: 6.7 s per proposal, repeated in synthetic negatives
- **Where:** `src/validation/ast-checker.js:268` (`findCallSites` loops over `collectRepoFiles(repoRoot, 500, JS_RE)`). Every file whose text contains the drifted name is Babel-parsed and walked, with no index and no cache. `src/rl/bug-injector.js:128` then calls `runChecks` again for each mutant of a passed proposal.
- **Measured** (`runChecks` for a signature change of a helper referenced from K files; budget 300 ms):

  | K | repo MB | p50 ms |
  |---|---|---|
  | 0 | 0 | 0.8 |
  | 10 | 2.0 | 716 |
  | 50 | 9.8 | 3,372 |
  | 100 | 10.9 | 3,774 |
  | 250 | 14.0 | 4,736 |
  | 500 | 19.1 | **6,736** |

  Cost is roughly linear in bytes parsed: 22× the budget at K=500. `runHybridValidator` on that proposal: **6,822 ms p50** against a 2,500 ms budget. In the 50-proposal pipeline run the drift proposal cost 6,918 ms in AST, 7,061 ms in the validator and another **6,879 ms** in `syntheticNegatives` (the mutant is re-checked). That is about 14 s of synchronous main-thread time for one proposal.
- **Repro:**
  ```
  node audit/2/ast-scale.js
  # observed (b) K=500: p50 6736 ms; (c) runHybridValidator p50 6822 ms; expected <=300 / <=2500
  ```

### H2. The diff-test per-call timeout counts as divergence, so identical code is hard-vetoed at random under CPU load
- **Where:** `src/validation/diff-sandbox-worker.js:215` (`one side timed out → 'mismatch'`), with `CALL_TIMEOUT_MS = 250` (`src/validation/diff-testing.js:31`). The orchestrator treats a `divergent` verdict as a hard veto (`hybrid-validator.js vetoReasons`).
- **Measured:** current and proposed differ only by a comment. 10 fresh runs each:

  | function cost per call | other load | verdicts |
  |---|---|---|
  | ~100 ms | none | 10 equivalent |
  | ~100 ms | 8 busy processes on 4 CPUs | **5 divergent** (3 "current side exceeded", 2 "proposed side exceeded"), 3 inconclusive, 2 equivalent |
  | ~150 ms | none | **7 divergent**, 3 equivalent |
  | ~150 ms | 8 busy processes | 8 inconclusive, **2 divergent** |

  Single-shot runs at 200 ms per call, with a 16 MB string return and with a 2e5-key object return were also `divergent` on identical code. The verdict depends on wall-clock timing, not semantics.
- **Expected:** `equivalent` or `inconclusive`, never `divergent`, for byte-identical semantics.
- **Repro:**
  ```
  node audit/2/diff-patho.js --flaky cpu-150ms-per-call --repeat 10
  node audit/2/diff-patho.js --flaky cpu-100ms-per-call --repeat 10 --contend 8
  # observed: divergent 7/10 and 5/10; expected 0/10 divergent
  ```

## Medium

### M1. With `--serve`, validation, synthetic negatives and git commits block the dashboard server for seconds
- **Where:** the server runs in the pipeline process (`src/orchestrator.js:238-241`). `diffTesting.run` blocks on `Atomics.wait` (`src/validation/diff-testing.js:248`), and `runChecks`, `applyEdit`, `syntheticNegatives` (`orchestrator.js:179`) and `commitProposal` (`execFileSync`) are all synchronous.
- **Measured** (50-proposal run, out-of-process poller hitting `/healthz` every 50 ms and `/` every 1 s): `/healthz` p50 1.5 ms, **p95 971 ms, max 7,649 ms**. `/` p95 1,114 ms, max 6,856 ms. In-process 10 ms ticker: p95 660 ms, max 7,660 ms. In an earlier run whose drift proposal was vetoed, `/healthz` max was 9,074 ms. SSE lag stays small (p95 28 ms after a write) only because the watcher catches up once the loop is free.
- **Expected:** a local dashboard that answers within the 2 s SG7 target. Not met while a drift proposal or slow anchor runs.
- **Repro:** `node audit/2/pipeline-load.js --proposals 50 --drift --serve`. Observed: `dashboard /healthz ... max 7648.7 ms`.

### M2. Synthetic negatives are the largest unbudgeted cost: 44% of wall time
- **Where:** `src/orchestrator.js:178-183` → `src/rl/bug-injector.js:128` (`syntheticNegatives`). For each passed proposal it runs up to six mutations, each with a `runChecks` and a full `diffTesting.run` in a fresh worker, all synchronously in the request path.
- **Measured:** p50 641 ms and p95 790 ms per passed proposal. That is 29.0 s of the 66.1 s run, more than the validator (19.6 s) or the executor including tests (16.7 s). It reaches 6,879 ms on the drift proposal (H1).
- **Repro:** `node audit/2/pipeline-load.js --proposals 50 --drift`. Observed: the `syntheticNegatives` row has total ≈ 29,000 ms.

### M3. Every run leaves a full git worktree, a branch and the checkout behind
- **Where:** `src/orchestrator.js:322` (`createWorktree` per run) and `src/runner/worktree.js:285-307`. Nothing removes worktrees (PLAN SG5 lists this as open).
- **Measured:** 3 runs on the 500-file repo left 4 entries in `git worktree list` (1 + 3) and a 60.4 MB state dir, about 20 MB per run. `createWorktree` takes 130–226 ms per run.
- **Expected:** a bounded number of worktrees, or cleanup of finished runs.
- **Repro:** `node audit/2/pipeline-load.js --proposals 2 --runs 3`. Observed: `git worktrees on target: 4; state dir: 60400 kB`.

### M4. Diff-test memory is not bounded by `RESOURCE_LIMITS`, and large return values are copied to the main thread on every input
- **Where:** `src/validation/diff-testing.js:35` (`maxOldGenerationSizeMb: 64`) and `src/validation/diff-sandbox-worker.js:254`. The `progress` message carries the full serialised `current` value, including unbounded strings, for every input.
- **Measured:** peak RSS per child process (baseline about 72 MB):

  | case | peak RSS |
  |---|---|
  | memory-hog (allocates until stopped) | **453 MB**; **717 MB** after 10 back-to-back runs |
  | 4 MB string return | 301 MB |
  | 16 MB string return | 379 MB |
  | 2e5-key object | 218 MB |

  Durations stay under 2 s, and thread counts go back to 7, so there is no leak.
- **Repro:** `node audit/2/diff-patho.js`. Observed: rows `memory-hog-oom` 453 / 717 MB and `huge-string-16MB` 379 MB.

### M5. Test time has a fixed 60 s per-proposal timeout, no run-level cap and no CLI control
- **Where:** `src/runner/test-runner.js:7` (`TIMEOUT_MS = 60_000`). `src/orchestrator.js:143-148` never passes `testTimeoutMs`.
- **Measured:** a hanging suite took 60.0 s per proposal; 2 proposals took 122.1 s with both `timeout` and nothing left running. A 20 s suite took 20.2 s per proposal; 5 proposals took 110.6 s. With 50 proposals, a hanging suite means at least 50 minutes.
- **Repro:**
  ```
  node audit/2/tests-load.js --modes slow,hang
  node audit/2/pipeline-load.js --files 50 --proposals 2 --test hang
  ```

## Low

### L1. `saveSession` rewrites the whole pretty-printed session each time, so total cost is O(n²)
- **Where:** `src/utils/checkpoint.js:69`, called about twice per proposal (`orchestrator.js` 81–208).
- **Measured:** the 50-proposal run made 103 writes, wrote 32.9 MB and spent 460 ms. Per write: 4 ms at 50 proposals and 65 ms (11 MB) at 1,000. A session growing to 300 proposals spends 3.8 s and writes 0.86 GB.
- **Why Low:** the Analyzer cap (10 per run, plus repairs) keeps real sessions small.
- **Repro:** `node audit/2/session-scale.js --sizes 50,100,250,500,1000 --grow 300`.

### L2. Per-target RL store: every sample rewrites the whole file, and training time grows linearly with samples, synchronously, at the end of each run
- **Where:** `src/rl/collector.js:56-64` (`appendSamples` loads, re-indexes and rewrites the pretty-printed JSON) and `src/rl/classifier.js:61,183` (400-epoch GD plus a 200-step ml-logistic-regression cross-check).
- **Measured:**

  | samples | `collectSample` per call | `trainIfReady` |
  |---|---|---|
  | 1k | 5 ms | 152 ms |
  | 10k | 48 ms | 2.4 s |
  | 100k (34 MB) | 716 ms | **44.1 s** |

  The store grows by 4 samples per passed proposal (1 real + 3 synthetic), so 10k samples is about 2,500 passed proposals.
- **Repro:** `node audit/2/rl-scale.js`.

### L3. AST checks on files near the 200 KB limit use most of the budget, even without drift
- **Where:** `src/validation/ast-checker.js:626` (two full Babel parses and walks per proposal).
- **Measured:** p50 for a no-drift edit: 20 ms at 10 KB, 108 ms at 100 KB, **229 ms** at 199 KB (p95 245 ms). The pipeline-run p95 was 288 ms against a 300 ms budget, and the bench fixtures do not show this.
- **Repro:** `node audit/2/ast-scale.js` (table a).

### L4. The dashboard renders the whole session on every request
- **Measured:** with a 1,000-proposal (11 MB) session: `GET /` 165 ms and 6.6 MB of HTML, `/session.json` 83 ms. With the file rewritten every 500 ms and `/` reloaded every 1 s, `/healthz` p95 was 87 ms and max 528 ms.
- **Repro:** `node audit/2/session-scale.js`.

### L5. `commitProposal` runs 3–4 synchronous git processes per kept edit
- **Measured:** 141 ms p50 and 271 ms max on the 500-file repo; 7.2 s of the 50-proposal run, all of it blocking the main thread.
- **Where:** `src/runner/worktree.js:328-336`.
- **Repro:** `node audit/2/pipeline-load.js --proposals 50`, `commitProposal` row.

### L6. (Incidental, not performance) Identical persona reasoning texts make `verbal_entropy` negative and break the contract
- **Where:** `src/agents/critic.js:177` (`1 - avgSim` can be −2.2e-16). `assertJuryVerdict` then throws in `runHybridValidator`, and the orchestrator records the proposal as `critic_rejected`. The first load run hit this: three malformed stub verdicts produced identical text and all 10 proposals were rejected.
- **Repro:** `node audit/2/entropy-repro.js`. Observed: `contract violation: ... got number -2.220446049250313e-16`. Expected: entropy clamped to [0, 1].

### L7. (Suspected, not measured) `SIGINT`/`SIGTERM` handlers cannot run during the synchronous stalls above
- `process.on('SIGINT')` handlers are JavaScript, so they cannot run while the main thread is inside a C2 fuzzy match (minutes) or an H1 scan (seconds). The in-flight revert promised by SG5 would be delayed by that long. Delivering signals during these stalls was not tested.

---

## Repro scripts (`audit/2/`)

| script | what it measures |
|---|---|
| `lib.js` | repo generator (500 files, deep directories, ≤ 199 KB), proposal factories, stub critic, stats, `/proc` sampling |
| `poller.js` | out-of-process dashboard client (`/healthz` every 50 ms, `/` every 1 s, SSE) |
| `pipeline-load.js` | end-to-end `runPipeline` load (`--proposals`, `--test fast/slow/hang/hang-escape`, `--serve`, `--drift`, `--runs`, `--dry-run`) |
| `ast-scale.js` | `runChecks` vs file size and vs number of referencing files |
| `diff-patho.js` | diff-test pathological inputs (`--case`, `--flaky ... --contend N`) |
| `anchor-patho.js` | fuzzy and exact anchor pathologies (`--case N`) |
| `rl-scale.js` | RL store I/O and training vs sample count |
| `session-scale.js` | `saveSession` and dashboard server vs session size |
| `tests-load.js` | test-runner timeout and process-group behaviour |
| `entropy-repro.js` | L6 |
| `fixtures/session-template.json` | real proposal captured from a load run (used by `session-scale.js`) |

Numbers vary by about ±15% between runs on this machine. Over-budget results were each reproduced at least twice, except the anchor cases at ≥ 932 s, which were run once.
