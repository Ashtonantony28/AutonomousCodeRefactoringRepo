# AUDIT-14 — Performance under load, round 4

This audit covers commit `62485b9` (SG23, after SG18–SG23). It is PLAN.md "Audits" item 2, round 4, done by an independent auditor. No `src/`, `test/`, `PLAN.md`, `CLAUDE.md` or `README.md` changes were made.
All load is generated at runtime under `os.tmpdir()` by the scripts in `audit/14/` (and `audit/2/`, `audit/6/`, `audit/9/`). The `audit/14` scripts load `test/helpers/env.js` first (through `audit/9/lib.js`), so `REFACTOR_STATE_DIR` and `REFACTOR_DASHBOARD_DIR` point at a temp dir. Every pipeline run uses the stub client, so no live API call is made and `state/` and `dashboard/` are never touched.

**Machine:** Linux, 4 vCPU, 15 GB RAM, Node v22.22.0, Python 3.13.16, pytest 9.1.1, coverage 7.16.2. `kernel.sched_autogroup_enabled = 1`.

**Load repos:**
- JS: the `audit/2/lib.js genRepo` fixture (500 files, 19.1 MB, 50 files of about 197 KB) with audit/9's asserting suite: `node audit/9/pipeline-load.js --proposals 50 --drift --serve`.
- Python (new): `audit/14/pipeline-load-py.js` generates the same shape in Python (500 modules under `pkg/`, 50 of about 197 KB, a pytest suite that imports every module and asserts every function's result) and seeds 19 "inline the temporary" proposals (half on the 197 KB modules) plus a `normalize` signature change. It runs through `audit/2/pipeline-load.js` (resume: true).

## Prior criticals and highs: status

| id | re-run (`bash audit/14/rerun-prior.sh OUT [name]`) | observed now | status |
|---|---|---|---|
| A2-C1 setsid test hang | `AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes fast,hang-escape,hang` | hang-escape 0.4 s `passed`; hang 60.1 s `timeout`, nothing left in the group | **fixed** (the daemon still outlives the run: L3) |
| A2-C2 fuzzy anchor blowup | `node audit/2/anchor-patho.js --reps 3` | 8 cases, p50 0.4–58.5 ms, max 58.8 ms | **fixed** |
| A2-H1 drift scan | `node audit/2/ast-scale.js` | (b) K=500 p95 39 ms; (c) validator 285 ms | **fixed**. (a) at 199 KB is at the budget: L4 |
| A2-H2 diff-test timeout flakiness | `node audit/2/diff-patho.js --flaky cpu-150ms-per-call --repeat 10`, `... cpu-100ms-per-call --repeat 10 --contend 8` | 10/10 and 10/10 `inconclusive`, 0 divergent | **fixed** |
| A6-C1 V8 coverage post-processing | `node audit/6/coverage-load.js --cases span`, `--cases procs` | span 2–190 KB: post-exit 52–132 ms. 200 procs × 20 KB: 665 ms. Max stall 116 ms | **fixed** |
| A6-C2 coverage.py cap | `node audit/6/coverage-py.js --files 50,200,500` | `exercised: true` at 50/200/500 modules, post-exit 731–904 ms | **fixed** |
| A6-C3 dirty sync over 1 MB | `node audit/6/session-resume-scale.js --parts d` | 25,000 untracked: 25,001 synced, modified file reached, 1,436 ms | **fixed** |
| A6-H1 / A6-H2 drift scans | `node audit/6/drift-scan.js` | JS cold 48 / warm 35 ms; Python cold 32 / warm 21 ms; caller after the cap found | **fixed** |
| A9-C1 diff-test input explosion | `node audit/9/diff-explosion.js`, `node audit/9/validator-explosion.js` | 9 cases 255–1,045 ms, all `equivalent` (was up to 172 s); validator 502 ms, proceeds | **fixed** |
| A9-C2 mutant budget from the instrumented run | `node audit/14/mutant-budget.js mutant-budget --suite-s 29,31,45` and `... --lang py --suite-s 30,40` | JS 29/31/45 s: all `passed` (wall 58.7 / 62.6 / 90.6 s). Python 30/40: both `passed` | **fixed** (wall per proposal: M4) |
| A9-H1 quadratic `editMutants` | `node audit/9/edit-mutants.js`; same with `--max-old-space-size=2048 --reps 1` | max 413 ms, no OOM; wide spans get 0 mutants (`mutation_budget`) | **fixed** on its repro. Many sites: H3 |
| A9-H2 slow mutant counted as a kill | `node audit/14/mutant-budget.js mutant-timing --mode jitter --repeat 20` | 20/20 `tests_insensitive`, mutant runs up to 2,044 ms | **fixed** for timeouts. A failing mutant run is still never re-checked: C1 |
| A9-H3 module-state snapshots | `node audit/9/diff-state.js`; `--contend 8 --case "exported array"` | all 10 cases `equivalent` 218–1,032 ms; under load 4/4 `equivalent`, 1,295–1,998 ms | **fixed** for exports. The same cost has moved to module bindings: H4 |
| A9-H4 Python drift byte cap | `node audit/9/drift-caps.js --cases c` | 200 × 500 KB: cold 215 ms, warm 101 ms (was 10,303 / 5,756) | **fixed** |

**Note on the audit/9 executor repros:** `audit/9/mutant-budget.js` and `audit/9/mutant-timing.js` call `runExecutor` without the `proposal.diff_test` that the orchestrator attaches. Since SG22 the executor accepts a deleted token only with an `equivalent` diff test that observed it. Their edit (`return a + b` → `const sum = a + b; return sum`) deletes `return`, so they now report `reverted tests_insensitive` with 0 mutant runs whatever the suite does. That looks like A9-C2 is "still open" and like A9-H2 is "fixed", and both readings are artefacts (L2). `audit/14/mutant-budget.js` attaches `diffTesting.run`'s result and runs the audit/9 scripts unchanged. The table above uses it.

## Summary: measured numbers vs budget

| stage (per proposal) | PLAN p95 budget | JS run p50 / p95 / max (ms) | Python run p50 / p95 / max (ms) | worst case measured (script) | verdict |
|---|---|---|---|---|---|
| AST `runChecks` | 300 | 82 / 298 / 329 (2/50 over) | 34 / 113 / 125 | 199 KB JS file p95 304 (L4) | at budget |
| Differential test `diffTesting.run` | 2,000 (hard kill 3,000) | 449 / 1,014 / 1,132 | 527 / **2,285** / 2,317 (4/20 over) | Python deletion of 14 KB / 30 KB: **4,455 / 8,934**, all on the main thread (H1). Python 199 KB module: p95 2,128, `inconclusive` (H2). JS 199 KB module with 8 busy processes: p95 2,712 (M1) | **over** for Python |
| Anchor match + apply `applyEdit` | 100 | 1.2 / 3.4 / 11.8 | 0.5 / 1.2 / 1.2 | — | ok |
| Whole validation `runHybridValidator` | 2,500 | 521 / 1,344 / 1,391 | 548 / 2,397 / 2,399 | Python deletion case: > 4,455 (H1) | over on Python deletions |
| `runTests` main run (coverage) | — (60 s) | 4,609 / 4,991 / 5,110; post-exit 375 / 475 | 10,715 / 11,703; post-exit 320 / 965 | — | — |
| `runTests` mutant runs | own 60 s budget | 1,401 / 2,780 / 2,968 (49 runs) | 943 / 1,146 (12 runs) | 192 runs for one 192-site edit (M4) | — |
| `editMutants` (sync) | — | in executor | in executor | JS 192 sites **6,368**; Python 96 sites **7,903**; Python ≥ 48 sites under load: **10.4 s and 0 mutants** (H3) | — |
| executor total | — | 6,247 / 7,669 / 7,880 | 11,965 / 12,980 | 192-site edit 44,440 ms; 45 s suite 90,647 ms (M4) | — |
| `syntheticNegatives` | — | 1,504 / 1,827 / 1,883 | 718 / **4,095** / 4,095 | — | (M3) |
| `commitProposal` | — | 132 / 159 / 232 | 116 / 184 | — | — |
| `createWorktree` | — | 164 | 206 | SG21 retry on the 500-file repo: 131–136 ms (no extra cost) | ok |

| whole-run metric | JS (50 proposals) | Python (20 proposals) |
|---|---|---|
| Outcomes | 49 `passed` (one mutant run each, killed), 1 `vetoed` (drift, correct) | 12 `passed`, 1 `vetoed` (drift, correct), **7 `critic_rejected`**: all on 197 KB modules, all behaviour-preserving (H2) |
| Wall | 404.8 s (AUDIT-9: 405.0 s) | 185.9 s |
| Peak RSS (VmHWM) | 670 MB (AUDIT-9: 721 MB) | 171 MB |
| Main-thread stall (10 ms ticker) | p95 0.7 ms, **max 2,489 ms** (AUDIT-9: 1,743) | p95 0.6 ms, **max 4,765 ms** (M3) |
| Dashboard with `--serve` | `/healthz` p95 2.1 ms, max 2,491 ms; `/` p95 1,760 ms; SSE lag p95 35 ms | `/healthz` max 4,776 ms; `/` p95 2,398 ms, max 4,574 ms |
| Leaks | FDs 25 → 25; threads 7 → 11 (libuv pool, as in AUDIT-9) | FDs 25 → 25; threads 7 → 7 |

Severity counts: **Critical 1, High 4, Medium 4, Low 5.**

---

## Critical

### C1. A mutant run that fails because the machine is loaded counts as a kill: 18/20 edits on a test-insensitive suite kept
- **Where:** `src/agents/executor.js:69-80` (`mutationEvidence`).
  - SG20 made a timed-out mutant run re-run once, and a timeout never counts. That closed A9-H2.
  - But any mutant run with `status === 'failed'` is a kill at once.
  - Nothing checks that the failure is caused by the mutant: the unmutated suite is not re-run after a kill, the mutant is not run twice, and the failing test is not compared with anything.
  - A suite that fails for a reason that has nothing to do with the mutant (CPU load, a flaky test) therefore gives "evidence" that the tests detect the change.
- **Trigger:** a suite with a timing or performance assertion (e.g. "parses 10k rows in < 600 ms"). The machine gets busy between the main run and the mutant run: other users' jobs, CI neighbours, a build in another terminal, each in its own session. The test command runs in its own session/autogroup. AUDIT-9 showed that this protects it from busy processes started in the pipeline's own session. Load from other sessions is not shared that way, and it slows the test down.
- **Measured** (`node audit/14/mutant-flaky.js`):
  - Setup: the suite never asserts on the edited function, so the right outcome is always `tests_insensitive`. The edit is `return a + b;` → `return (a + b) * 1;`: one site, no deleted token.

  | mode | load during mutant runs | kept edits (false evidence) |
  |---|---|---|
  | `steady` (timing assertion, CPU loop ~300 ms must finish < 600 ms) | none | 0/10 |
  | `timing` | 4 busy processes in their own sessions (4 vCPU) | 0/10 |
  | `timing` | 8 busy processes in their own sessions | **18/20**, and on re-run **9/10** (`passed`, "killed by numeric_off_by_one after 1 run") |
  | `random` (a test that fails 20% of the time) | none | **4/20** |

- **Consequence:**
  - An edit is committed as "tests detect this change" (SG14 bar (d), SG22 per-site evidence) when they do not.
  - Whenever the gate's `equivalent` was wrong, that wrong edit now lands on false evidence.
  - Under 2× CPU oversubscription, timing-sensitive suites make the mutation bar decide on noise.
  - The `random` row shows the same hole without any load: a single flaky failure on the mutant run is enough.
- **Expected:**
  - A kill should be confirmed. Either the failing mutant is re-run and must fail again, with the unmutated suite passing right after; or the failing test(s) are named and the same test must pass on the unmutated code.
  - At minimum, a mutant run whose failure also happens on the unmutated suite should not count.
- **Repro:**
  ```
  node audit/14/mutant-flaky.js --mode timing --repeat 20 --busy 8   # kept 18/20 (expected 0)
  node audit/14/mutant-flaky.js --mode steady --repeat 10            # control: 0/10
  node audit/14/mutant-flaky.js --mode random --repeat 20 --p 0.2    # no load: 4/20
  ```

## High

### H1. The Python diff test maps every deleted token's offset by rescanning the file from 0, on the main thread, before the hard kill starts: 3.4–8.9 s for 10–30 KB deletions
- **Where:** `src/validation/py-diff-testing.js:23-31,54-56`.
  - `cpOffset(s, i)` walks `s` from 0 to `i` to convert a UTF-16 offset into a code-point offset.
  - It is called twice per deleted token from SG22's `changeHunks(...).flatMap(h => h.deleted)`. The cost is O(deleted tokens × offset in file).
  - All of this happens in `run()` before `spawnSync`, so it is outside the harness. The harness's `timeout` is `hardKillMs − elapsed`, floored at 1 ms. So after a slow mapping the Python process is killed at once, and the result reads "hard kill: python sandbox did not finish within 3000 ms".
  - The Node event loop (SIGINT handlers, the `--serve` dashboard) is blocked for all of it.
- **Trigger:** a "remove dead code" proposal, or any edit that deletes many tokens, near the end of a large Python module. A capped token diff (more than 2,000 tokens on each side of a hunk) counts every token of the hunk as deleted.
- **Measured** (`node audit/14/py-deletion.js`, 199 KB module; budget 2,000 ms, hard kill 3,000):

  | case | deleted tokens | before spawn (ms) | Python (ms) | wall (ms) | verdict |
  |---|---|---|---|---|---|
  | delete 2 KB at end | 682 | 1,120 | 996 | 2,118 | inconclusive |
  | delete 5 KB | 1,705 | 1,812 | 1,064 | 2,877 | inconclusive |
  | delete 10 KB | 3,379 | **3,398** | 2 | 3,401 | inconclusive, "hard kill … 3000 ms" |
  | delete 14 KB (about the largest a 4,000-token Analyzer answer carries) | 4,743 | **4,452** | 2 | **4,455** | same |
  | delete 30 KB | 10,137 | **8,931** | 2 | **8,934** | same |

  The time grows linearly with the deletion size and with its position in the file. `changeHunks` itself takes 2–12 ms of it.
- **Expected:** compute the code-point offsets in one pass over sorted offsets (or once per file), and count that pass inside the hard kill. Report "input preparation" (as the JS side does since SG20) when the time ran out before the spawn.
- **Repro:** `node audit/14/py-deletion.js` (`--kb 10,14,30` for the over-budget rows)

### H2. The Python diff test cannot finish on large modules: behaviour-preserving edits in modules of ~190 KB (≥ 100 KB under load) are `inconclusive`, so `critic_rejected`
- **Where:** `src/validation/py_diff_harness.py:1151-1260`.
  - The parent parses both versions, runs `layout`/`ast.dump` on every function of both trees, mines literals, builds the plan and probes.
  - Only after that do the three forked sides (current, proposed, current again) split what is left of the 1,500 ms budget (`share = (budget − elapsed) / (3 − i)`). Each side then re-executes the whole module.
  - On a large module the parent work and three module loads use up the budget. The second current side gets cut short, and its missing runs are reported as "N of N runs differ only through dependency stubs or missing snippet context" (`:1332`). That is a misleading reason (L1, already noted as open in SG23's log). Or no side gets a run at all ("time budget reached after 0 of 80 runs").
  - The SG9/SG14 gate rejects both outcomes.
- **Measured** (`node audit/14/diff-size.js`; edit `if t > 100: return t - 100` → conditional expression; 5 reps):

  | module KB | unloaded p50 / p95 ms, verdict | 8 busy processes p50 / p95 ms, verdict |
  |---|---|---|
  | 25 | 376 / 398, equivalent | 779 / 891, equivalent |
  | 50 | 575 / 619, equivalent | 1,154 / 1,253, equivalent |
  | 75 | — | 1,778 / 1,872, equivalent |
  | 100 | 1,055 / 1,091, equivalent | 2,479 / 2,502, **inconclusive 3/3** (0 runs) |
  | 150 | 1,597 / 1,650, equivalent | 2,595 / 3,007, **inconclusive 3/3** (hard kill) |
  | 199 | 1,912 / **2,128**, **inconclusive 5/5** ("16 of 16 runs differ only through dependency stubs") | — |

  - JS on the same shapes stays `equivalent` up to 199 KB unloaded (957 ms p95).
- **End to end:** in the Python 500-module run, **7 of the 10 proposals on 197 KB modules were `critic_rejected`** with the diff test `inconclusive` (4 × "time budget reached after 0 of 80 runs", 3 × "differ only through dependency stubs"). All 10 proposals on smaller modules were `equivalent` and passed. The diff-test p95 there is 2,285 ms (4/20 over budget).
- **Consequence:**
  - Every Python edit in a large module is rejected; this is deterministic near 200 KB.
  - The size limit halves under CPU load, so the verdict depends on load.
  - The rejection is safe, but it is systematic, and its stated reason points at stubs rather than time.
- **Expected:**
  - Load and parse the module once per side before the budget starts, or give the module load its own allowance.
  - Restrict the parent's whole-tree work to the changed callables.
  - Report a budget cut as a budget cut.
- **Repro:**
  ```
  node audit/14/diff-size.js --lang py --kb 100,150,199
  node audit/14/diff-size.js --lang py --kb 50,75,100,150 --contend 8 --reps 3
  node audit/14/pipeline-load-py.js --proposals 20 --drift --serve   # diff-test verdicts line
  ```

### H3. Per-site mutants (SG22) are built and parsed synchronously: up to 10 s of main-thread block, and in Python a parse timeout leaves 0 mutants, so the edit is reverted `tests_insensitive` without running a test
- **Where:**
  - `src/rl/bug-injector.js:251-327` (`editMutants`). With SG22, every inserted token that an operator applies to is a site (≤ 12 per hunk, ≤ 16 hunks). Each site gets up to 3 full-file mutants, and each mutant is parsed in full: JS through Babel, one at a time; Python in one batch through `parsesPython` (`:231-235`).
  - `parsesPython` is a `spawnSync('python3', …, { timeout: 10_000 })`. On a timeout it returns all-false, so no candidate survives. `mutationEvidence` (executor.js) then finds a hunk with no mutant and returns `ok: false` without `budget_exhausted`. The outcome is `reverted` reason `tests_insensitive`: "the tests cannot tell", although no test ran.
  - A second batch (`rest`) can add another 10 s.
- **Measured** (`node audit/14/edit-sites.js`, 199 KB file, ` + 0` pairs added to H functions):

  | lang | hunks × sites | unloaded: ms, mutants | 8 busy processes: ms, mutants |
  |---|---|---|---|
  | JS | 4 × 12 = 48 | 1,471, 48 | — |
  | JS | 16 × 6 = 96 | 2,502, 96 | — |
  | JS | 16 × 12 = 192 | **5,208–6,368**, 192 | — |
  | Python | 4 × 6 = 24 | 2,304, 24 | 5,886, 24 |
  | Python | 4 × 12 = 48 | 4,440, 48 | **10,385, 0 → every hunk bare** |
  | Python | 16 × 6 = 96 | **7,903**, 96 | 10,450, **0** |
  | Python | 16 × 12 = 192 | **10,330, 0** | 10,742, **0** |

  - End to end (`node audit/14/executor-sites.js`, JS, the suite kills every site mutant): 192 sites took 44.4 s of executor wall, with a 6.4 s main-thread stall inside it; the outcome was `passed`.
- **Consequence:**
  - A legitimate Python edit of about 50 or more sites under load (about 120 or more unloaded) is reverted with a reason that blames the tests. The reason should be `mutation_budget`, and the edit should get its test runs.
  - The outcome depends on load.
  - The event loop (SIGINT, `--serve`) is blocked for 2–10 s per such edit.
- **Expected:**
  - Parse mutants of the edited region (or of the enclosing function) instead of the whole file.
  - Run the Python check asynchronously, with its timeout inside the mutant budget.
  - Treat a parse-check failure or timeout as `mutation_budget`, never as "no mutant".
- **Repro:**
  ```
  node audit/14/edit-sites.js --lang py --hunks 4,16 --sites 6,12 --contend 8
  node audit/14/edit-sites.js --hunks 16 --sites 12
  node audit/14/executor-sites.js --hunks 16 --sites 12
  ```

### H4. Per-call module-binding state (SG22) is linear in the number of top-level bindings: modules with 2,000–5,000 constants get `inconclusive` (so `critic_rejected`), and load lowers the threshold
- **Where:** `src/validation/diff-sandbox-worker.js:381-430` and `take` (`:537-553`).
  - After every call, on both sides, every module-scope binding present in both versions is looked up with a direct `eval(name)`. Function bindings are skipped only after that lookup.
  - Below 2,000 load-time nodes (`STATE_NODES`), the bindings are serialised in full (`bindState`, up to 5,000 nodes). Above it they go through `smallDigest`, which serialises each binding with `SMALL_NODES` until `SMALL_TOTAL`.
  - Either way the per-call cost grows with the number of bindings, whatever the target touches. With 59 inputs, the 1,500 ms budget runs out, and the result is "time budget reached after n of 59 inputs".
  - This is the A9-H3 pattern again. SG20 fixed it for exports; SG22 brought per-call work back for bindings.
- **Measured** (`node audit/14/diff-bindings.js`; a behaviour-preserving edit in a 7-line function next to N `const K_i = i;`):

  | N constants (file KB) | unloaded | 8 busy processes |
  |---|---|---|
  | 500 (9) | equivalent, 419 ms | — |
  | 1,000 (18) | — | equivalent, 1,683 ms |
  | 2,000 (36) | equivalent, 860 ms | **inconclusive 2/3** (54 of 59) |
  | 3,000 (54) | — | **inconclusive 3/3** (36 of 59) |
  | 5,000 (91) | **inconclusive 1/3**, 1,998 ms | **inconclusive 3/3** (20 of 59) |
  | 9,000 (165) | **inconclusive 3/3** (47 of 59), 2,480 ms | — |
  | 9,000 *functions* (324 KB) | equivalent, 2,176 ms | — |

- **Plausibility:** constant-heavy modules are common: generated error-code and opcode tables, i18n keys, configuration constants, enums written as `const`s.
- **Consequence:** every JS edit in such a module is rejected deterministically above ~5,000 bindings, and above ~2,000 under load. The rejection is safe, but it is a systematic false rejection, and its rate depends on load.
- **Expected:**
  - Snapshot only the bindings the target (or its callees) can reach. Otherwise hash a binding once and re-walk it only when its identity or a cheap version stamp changes.
  - Do not `eval` function bindings at all.
- **Repro:** `node audit/14/diff-bindings.js --kind const` and `node audit/14/diff-bindings.js --kind const --n 1000,2000,3000,5000 --contend 8`

## Medium

### M1. (Carried pattern, AUDIT-9 M6) JS diff-test verdicts on large modules depend on CPU load
- **Measured** (`node audit/14/diff-size.js --lang js --contend 8`):
  - 150 KB: p95 2,609 ms, `equivalent`.
  - 199 KB: p95 2,712 ms, **2/3 `inconclusive`** ("time budget reached after 57 of 59 inputs").
  - Unloaded: 199 KB 957 ms, `equivalent`.
- **Fixed cost:** a trivial edit takes 221 / 242 ms p50/p95 (prep worker + sandbox worker; `node audit/14/diff-prep.js --parts a`).
- **Repro:** `node audit/14/diff-size.js --lang js --kb 150,199 --contend 8 --reps 3`

### M2. SG18 oracle and sandbox: moderate output or literal counts exhaust the time budget
- **Measured** (`node audit/14/diff-prep.js --parts b`). These behaviour-preserving edits all end `inconclusive` ("time budget reached"), so `critic_rejected`:
  - A function that `console.log`s a 5,000-row module array per call: 1,707 ms, 37 of 56 inputs.
  - A function returning a frozen object with 5,000 own properties of mixed enumerability: 1,665 ms, 52 of 69.
  - A 150 KB file with 3,000 regex literals: 2,063–2,456 ms, 49 of 56.
- **Within budget:** a 190 KB string literal (385 ms), a 30,000-number exported array (530 ms), nesting depth 2,000 (306 ms), a minified 190 KB line (1,505–1,656 ms) and 8 changed targets over a 2,000-literal pool (792–871 ms) are all `equivalent`.
- **Repro:** `node audit/14/diff-prep.js --parts b`

### M3. Main-thread stalls during a run are 2.5 s (JS) and 4.8 s (Python), up from 1.7 s
- **Measured:**
  - JS 500-file run: max stall 2,489 ms; `/healthz` max 2,491 ms; `/` p95 1,760 ms.
  - Python run: max stall **4,765 ms**; `/healthz` max 4,776 ms; `/` p95 2,398 ms.
- **Sources:**
  - `syntheticNegatives`: JS p95 1,827 ms, Python p95 **4,095 ms**. It is synchronous, and in Python it rescores up to 3 mutants, each through the Python diff test (a blocking `spawnSync` of up to 3 s each) plus `parsesPython`.
  - The synchronous diff test (≤ 3 s by design).
  - H1 and H3 when they apply.
- **Repro:** `node audit/9/pipeline-load.js --proposals 50 --drift --serve`, `node audit/14/pipeline-load-py.js --proposals 20 --drift --serve`

### M4. (Carried, AUDIT-9 M3) Executor wall per proposal: about 2× the suite for slow suites, about one suite run per site for many-site edits, still no run-level cap
- **Measured:**
  - 45 s suite: 90,647 ms per proposal; 31 s suite: 62,609 ms (`node audit/14/mutant-budget.js mutant-budget --suite-s 29,31,45`).
  - A 192-site edit with a 0.2 s suite: 192 mutant runs, 44,440 ms. 96 sites: 20,925 ms (`node audit/14/executor-sites.js`).
  - Python 500-module run: executor p50 12.0 s (10.7 s main run under coverage.py + 0.9 s mutant run).
- **Repro:** as above.

## Low

### L1. Misleading inconclusive reasons
- The Python hard-kill reason says "python sandbox did not finish within 3000 ms" when the time was spent in Node before the spawn (H1); the Python process got 1–2 ms.
- A Python budget cut on the second current side is reported as "N of N runs differ only through dependency stubs or missing snippet context" (H2).
- A Python module whose top level burns 0.8 s is reported as "module state after load is not deterministic" (`node audit/14/py-adversarial.js --contend 0 --case "module load"`).

### L2. The audit/9 executor repros are stale since SG22
- `audit/9/mutant-budget.js` and `audit/9/mutant-timing.js` pass no `diff_test`, so their deleting edit is reverted before any mutant runs.
- With them, A9-C2 reads "not fixed" and A9-H2 reads "fixed", for the wrong reason in both cases.
- `audit/14/mutant-budget.js` wraps them with the orchestrator's diff test, and `audit/14/rerun-prior.sh` uses the wrapper.

### L3. (Carried, AUDIT-9 L2) The setsid daemon outlives `runTests`
- **Measured:** after `hang-escape`, `sleep 240` was still running.
- **Repro:** `AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes hang-escape`

### L4. (Carried) `runChecks` on a 199 KB JS file sits at the 300 ms budget
- **Measured:**
  - `node audit/2/ast-scale.js` (a): 199 KB p95 304 ms.
  - 500-file run: p95 298 ms, 2/50 over.

### L5. Seen in passing (not load): multi-hunk edits must execute every function between the first and the last change
- **What:**
  - The coverage bar uses `changedSpan`, a single span from the first to the last changed character. Every function in that span must run, including unchanged ones between two hunks.
  - Example: an edit to `g1` and `g3` with an unchanged `g2` between them, which no test calls. The outcome is `reverted edit_not_exercised` even though each changed function ran.
- **Measured:** `node audit/14/executor-sites.js` before its suite was widened: 4- and 16-hunk edits gave `edit_not_exercised`. The comment in the script explains why it now calls every function in the span.
- **Effect:** an untested outcome, so no wrong label.

---

## What holds

- **All prior criticals and highs (AUDIT-2 C1, C2, H1, H2; AUDIT-6 C1, C2, C3, H1, H2; AUDIT-9 C1, C2, H1, H2, H3, H4) are fixed** on their repros (A9-C2/H2 through the diff-test wrapper, L2).
- **SG20 diff-prep worker:** input preparation is bounded and inside the hard kill.
  - A9-C1's 172 s case now takes 0.9 s and is `equivalent`.
  - 30 timeout/hard-kill runs in a row leave no worker, thread, FD or memory behind (threads 9 → 7, FDs 31 → 21, RSS 121 → 86 MB).
  - A 2,000-deep literal, a 190 KB string and a minified 190 KB line are all handled.
- **SG19 Python harness is bounded against adversarial modules** (`node audit/14/py-adversarial.js`, 13 cases, unloaded and with 8 busy processes, 3 reps each). Every call finished ≤ 3,009 ms with no harness process left. The cases were: catastrophic regex and huge `**` in C (per-call timeout), a bare `except` loop that swallows the timer (killed at the side's hard deadline), sleeps, a 1 GB allocation (RLIMIT_AS → both sides throw), 50 MB of output per call, 8 MB file writes (RLIMIT_FSIZE), deep recursion (crash → hard kill) and a 1M-element return.
  - No case was `equivalent` on a changed function.
  - A timer swallowed by `except:` cannot turn into a false `equivalent`, because each slow input appears at least twice per side and the 1.5 s budget then ends the run as `inconclusive`.
  - Controls behaved correctly: equivalent → `equivalent`, divergent → `divergent`.
- **Load never produced a false `equivalent` or `divergent` in the diff tests.** Every load effect seen was `inconclusive` (JS and Python), and the gate rejects it.
- **The SG20 mutant budget works:** suites up to 45 s get their mutant run, and a timeout never counts as a kill (jitter 20/20 `tests_insensitive`).
- **SG21 worktree retry** costs nothing measurable on the 500-file repo (131–136 ms vs 161 ms normal), and the target stays clean.
- **SG22 deletion probes and SG18 per-hunk evidence on the JS load fixture:** 49/49 "inline temporary" edits (each deletes tokens) were kept after one killed mutant. The diff test observed the deletions, and the drift proposal was vetoed.
- **Memory:** peak RSS of the JS 500-file run is 670 MB (AUDIT-9 721 MB); the Python run peaks at 171 MB. No FD growth.

## Repro scripts (`audit/14/`)

| script | what it measures |
|---|---|
| `lib.js` | wraps `audit/9/lib.js` (temp state dir first); `attachDiffTest`, `patchExecutorWithDiffTest`, thread/FD helpers |
| `rerun-prior.sh` | re-runs every prior C/H repro (AUDIT-2/6/9), each under `timeout 900`: `bash audit/14/rerun-prior.sh [OUT_DIR] [name ...]` |
| `mutant-budget.js` | runs `audit/9/mutant-budget.js` / `mutant-timing.js` with the orchestrator's diff test attached (A9-C2, A9-H2, M4) |
| `mutant-flaky.js` | C1: false kills from a timing assertion under a load spike in other sessions, or a flaky test (`--mode timing\|steady\|random`, `--busy`, `--p`) |
| `py-deletion.js` | H1: Python diff test vs deletion size; time before the spawn vs in Python |
| `diff-size.js` | H2, M1: diff-test time and verdict vs module size, JS and Python, with `--contend` |
| `pipeline-load-py.js` | H2, M3: end-to-end 500-module Python repo (pytest + coverage.py), per-stage table, diff-test verdicts by module size |
| `edit-sites.js` | H3: `editMutants` time and mutant count vs hunks × sites, JS and Python, with `--contend` |
| `executor-sites.js` | H3, M4: executor wall and stall for many-site edits with a killing suite |
| `diff-bindings.js` | H4: per-call binding state vs number of top-level bindings, with `--contend` |
| `diff-prep.js` | M2, what holds: diff-prep fixed cost, adversarial ≤ 200 KB files and SG18 oracle cases, leaks over repeated hard kills |
| `py-adversarial.js` | what holds, L1: Python harness against adversarial modules, unloaded and loaded |
| `worktree-retry.js` | SG21 retry cost on the 500-file repo |

**Variance and repetition:** numbers vary by about ±15% between runs on this machine.
- Reproduced at least twice: C1 (18/20, then 9/10), H1 (10 KB case twice), H2 (unloaded and loaded sweeps, plus the pipeline), H3 (the Python rows twice, once overlapping the prior re-run), H4 (unloaded and loaded).
- The prior re-run (`rerun-prior.sh`) ran alone, except that the first `edit-sites`/`py-deletion` checks overlapped its last scripts. All tables above come from quiet re-runs.
