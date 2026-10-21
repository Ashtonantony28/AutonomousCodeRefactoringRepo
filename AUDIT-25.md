# AUDIT-25 — Performance under load, round 7 (after SG31–SG34)

Commit audited: `4102e99` (SG31 whole-file lexing, SG32 linear per-test parsing charged to the mutant budget, SG33 load-hook keys, SG34 same-text mutant switch and structural-token rules). Independent auditor; no `src/`, `test/`, `state/` or `dashboard/` changes. Every script loads `test/helpers/env.js` first (through `audit/25/lib.js` → `audit/22/lib.js`, or directly in `mutant-gen.js`), so state goes to a temp dir. Pipeline runs use the stub client; no live API call.

**Machine:** Linux, 4 vCPU, Node v22.22.0, Python 3.13.16. Other sessions shared the machine; numbers vary about ±15%. Pre-SG34 comparisons use `--src` on a `git archive 5f26dd8 src` copy (see `audit/25/lib.js`).

**How to reproduce:** `bash audit/25/run-all.sh OUT` runs every probe below; `bash audit/22/run-all.sh OUT` and `bash audit/17/run-all.sh OUT leaks` re-run the earlier rounds. Each `audit/25/*.js` prints `ok` / `FINDING` per check and exits 1 on a reproduced finding.

## Summary

- `npm run bench`: ast p95 0.84 ms, difftest 304 ms, apply 30 ms, validator 417 ms. All within budget.
- AUDIT-22 C1 (quadratic per-test parsing, uncharged) is **fixed**: 20,000 same-name tests parse in 89 ms; the mutant phase stays within 60 s (53.3 s, stall 665 ms).
- SG34's switch is the new problem. The switch condition is re-evaluated every time the switched expression runs: a `process.env` read (a `getenv` scan) in JS, `__import__('os')` (through the pytest load hook) plus `os.environ.get` in Python. On a hot path this slows mutant **and control** runs by 7–350× per evaluation, so they run past their 2× suite + 1 s cap. A JS edit that passed at `5f26dd8` is now `reverted` / `tests_insensitive` (H1).
- SG31 whole-file lexing is not repeated per hunk or per mutant: 6 whole-file lexes per mutant phase at 1, 4 and 16 hunks (5–80 mutants). Structural-token cover (wrapping 300–1,000 lines in a block) is linear: ≤ 554 ms in all, mostly parsing.
- SG33's per-test `P` keys cost about 70 µs per passing pytest test (+1.5 s on 20,000 tests, L1).
- Leaks: none found after normal runs, SIGTERM in the main run, the first mutant run or a later (4th) run, timeouts (main run, spinning mutant, switch-induced), diff-test hard kills, or the reporter fallback.

| severity | count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 6 (1 worsened, 5 carried) |
| Low | 4 (+ carried A17 Lows) |

## Prior repros

| item | re-run | now | status |
|---|---|---|---|
| A22-C1 per-test parsing | `node audit/22/report-parse.js`; `node audit/22/dup-budget.js` | parse 20k dup TAP 89 ms / JUnit 73 ms; intersection 6 ms; 20k dup: `mutation_budget`, mutant phase 53.3 s, stall 665 ms | fixed |
| A22-M1 reporter fallback false timeout | `node audit/22/reporter-fallback.js --pre-s 0,3 --timeout-ms 6500` | pre 3 s: `timeout` at 6,516 ms; second call passes in 4,653 ms | open (M3) |
| A22-M2 mutant runs without per-test results | same | 1 wasted run (1,587 / 4,662 ms) | open (M4) |
| A22-M3 parse check inside one large statement | `node audit/22/sites-scale.js --cases table` | worse in JS (M1) | open, worse |
| A22-M4 site cap | `node audit/22/site-budget.js` | B14 and now R4 (callbacks → async/await, 8 lines) `capped` | open (M5) |
| A22-L1 pytest hook on hot imports | `node audit/22/load-hooks.js` | py-hot +80 ms (20%); all cases ≤ 250 ms or ≤ 10% when run alone | holds as Low |
| A17 leaks (normal, SIGTERM js/py, timeout, py hard kill) | `bash audit/17/run-all.sh OUT leaks` | all ok; repeat-js 3 runs → 3 worktrees / 3 branches | A17-L2 open |
| A22 leaks (SIGTERM in mutant run, mutant-run timeout) | `node audit/22/leaks.js` | all ok | holds |

Under concurrent load (the AUDIT-22 run-all while other probes ran), `load-hooks.js` js-files 200×50 measured +24.5%. Re-run alone: +8.8%. This is not a finding.

---

## High

### H1. The SG34 switch is re-read on every evaluation; hot-path edits time out their mutant and control runs and are rejected
- **Where:** `src/rl/bug-injector.js` `editMutants`, `on` = `` globalThis.process.env.${name} === '1' `` (JS) / `` __import__('os').environ.get('${name}') == '1' `` (Python). These are wrapped around the smallest expression holding the site. `src/agents/executor.js` `runOnce` caps each run at `2 * suiteMs + 1000`. A timed-out run is re-run once and then is not a kill. A timed-out switch-off control run is `control_failed`.
- **Cost per evaluation** (`node audit/25/switch-hot.js`, section 1):

  | | plain call | switched call | × |
  |---|---|---|---|
  | JS, 187 env vars | 2.0 ns | 336 ns | 166 |
  | JS, 487 env vars (CI-size env; `getenv` is a linear scan) | 1.7 ns | 581 ns | 346 |
  | Python | 123–134 ns | 859–920 ns | 7 |

  The control run pays this cost as well, with the switch off.
- **End to end** (`runExecutor`; `f(x)`: `return x + 1;` → `return x + 2 - 1;`; a small test kills every mutant; a loop test calls `f` N times):

  | lang | calls | edit suite | switch-off run | outcome | mutant runs (timeouts) | mutant phase |
  |---|---|---|---|---|---|---|
  | js | 1,000 | 331 ms | 304 ms | passed | 6 (0) | 2,199 ms |
  | js | 1,000,000 | 343 ms | 865 ms | passed | 6 (0) | 4,588 ms |
  | js | 5,000,000 | 325 ms | **2,635 ms** | **reverted tests_insensitive** | 4 (1) | 8,001 ms |
  | js @5f26dd8 | 5,000,000 | 417 ms | – | passed | 6 (0) | 2,075 ms |
  | py | 1,000 | 900 ms | 928 ms | passed | 6 (0) | 6,231 ms |
  | py | 3,000,000 | 1,235 ms | 4,612 ms | passed (coverage-inflated cap) | 6 (0) | **19,509 ms** |

  - JS at 5M calls: the switched run is 8× the edit's own suite, past the 2× + 1 s cap, so the site never gets a confirmed kill. The same edit passed before SG34.
  - Python survives only because the main run is under coverage.py, which inflates the first cap. It still spends 3.1× the mutant budget for a 1.4× slower suite.
  - With more sites, or a suite of a few seconds, the same budget runs out (`mutation_budget`).
- **Realistic:** a per-item / per-char helper (tokenizer, checksum, clamp, comparator) under a loop or property test. The more a function is used, the less its edits can be judged.
- **Expected:** evaluate the switch once per process. Read the variable into a module-level binding inserted with the switch text (JS `const __K = globalThis.process.env.K === '1';` at the top of the file; Python `__K = __import__('os').environ.get('K') == '1'` after the docstring and `__future__` imports), and test `__K` at the site. The text stays identical between the mutant and control runs.
- **Repro:** `node audit/25/switch-hot.js --lang js` (pre-SG34: add `--src <5f26dd8 copy>`)

## Medium

### M1. (A22-M3, worse) Parse check of an edit inside one large statement
- **Measured:** `node audit/22/sites-scale.js --cases table`, 183 KB literal:

  | edit | JS now (A22) | Python now (A22) |
  |---|---|---|
  | 4 hunks / 48 sites | 2,043–2,189 ms (1,535) | 3,394–3,464 ms (3,177) |
  | 16 hunks / 192 sites | 6,946–7,614 ms (5,726) | 10,593 ms → `unchecked` (10,180) |

- **Why:** each switch is parse-checked on the smallest enclosing statement, which is the whole table, and the switch text is longer than the old textual mutant. The cost is charged to the mutant budget, but it blocks the main thread. In JS it has no bound (`jsParseCheck` has no time limit).
- **Repro:** `node audit/22/sites-scale.js --cases table --reps 3`

### M2–M6 (carried, numbers this round)
- **M2 (A17-M1):** fresh Python bytecode cache per run. Unchanged code (`runTests` pycDir per run). Not re-run.
- **M3 (A22-M1):** the SG28 fallback's refused first run uses up the budget: pre-step 3 s, 6.5 s timeout → `timeout` at 6,516 ms. Repro: `node audit/22/reporter-fallback.js --pre-s 3 --timeout-ms 6500`.
- **M4 (A22-M2):** mutant runs start when the main run has no per-test results: 1 wasted run (1,587 / 4,662 ms). Same repro.
- **M5 (A22-M4):** realistic refactors at the 12-site cap. B14 (5 lines) and R4 (8 lines) are `capped` → `mutation_budget` with no test run. Repro: `node audit/22/site-budget.js`.
- **M6 (A17-M3):** Python diff test under 8× contention. Not re-run this round (code unchanged).

## Low

- **L1 (SG33):** the pytest plugin opens and appends to the load log once per passing test and per passing collector, on every run:

  | tests | added time | log |
  |---|---|---|
  | 1,000 | +56 ms (6.2%) | 1,021 lines |
  | 5,000 | +156 ms (4.6%) | 5,021 lines |
  | 20,000 | **+1,545 ms (11.4%)** | 20,021 lines, 739 KB, split 14 ms |

  - The JS hook logs only on a throw: 2 lines, +4.9% (noise).
  - Expected: keep the file handle open, or log only the keys that have a `T` line.
  - Repro: `node audit/25/hook-volume.js`
- **L2:** each mutant phase does duplicate whole-file work.
  - `changeHunks` runs twice (executor and `editMutants`): 4 of the 6 whole-file lexes.
  - JS parses the whole file 3 times (`jsShape`, `jsUses`, `jsParseCheck`).
  - `editMutants` on 100 KB: JS 386–441 ms (about equal to `5f26dd8`: 436–532 ms). Python 643–730 ms (`5f26dd8`: 533–553 ms, +25%).
  - Bounded and charged to the budget.
  - Repro: `node --expose-gc audit/25/mutant-gen.js`
- **L3 (SG34):** every mutant holds a full copy of the file with its switch (`src`): 80 mutants × 100 KB = 8 MB. The cap allows 16 hunks × 12 sites × 3 = 576 copies of a file of any size. Same repro.
- **L4 (carried):** A17-L2: every non-dry run keeps its worktree and branch (3 → 3). A17-L3: a `setsid` descendant outlives the group kill. A17-L5: a match-guard deletion is never observed.

## What holds

- **SG31 lexing:** `lexView` + `changeHunks` run a constant 6 whole-file lexes per mutant phase at 1 / 4 / 16 hunks (5 / 20 / 80 mutants). Nothing is lexed per hunk or per mutant. `lexView` on 5,000 lines ≤ 48 ms.
- **SG34 structural tokens:** wrapping a 300- or 1,000-line function body in `if (on) { … }` costs ≤ 554 ms in all, mostly parsing.
  - JS ends `uncovered`.
  - Python ends `capped`, because the re-indent spans past `EDIT_MAX_CHARS` / the line LCS.
  - `uncoveredToken` is linear in the changed tokens.
- **SG32:** per-test parsing is linear (20k tests ≤ 89 ms, either format). Uncharged `runTests` overhead is ≤ 42 ms (JS) and ≤ 65 ms (Python, after the first call) at 5,000 tests.
  - 20,000 unique-name tests now end `mutation_budget` at 58.6 s (passed at 60.8 s in A22): parsing is now charged, as intended.
- **Leaks** (`node audit/25/leaks.js`, `node audit/22/leaks.js`, `node audit/17/leaks.js`, `reporter-fallback.js`; private TMPDIR each). No process, `refactor-cov-*` / `refactor-pyc-*` / `pydt-*` dir or `REFACTOR_MUTANT*` env variable is left after:
  - SIGTERM during the 4th test run, with the switch text in the worktree file: exit 0, `inflight.json` cleared, file restored with no switch text, target clean.
  - Switch-induced mutant / control timeouts, with a child in the group: the edit is reverted and the file restored.
  - Normal runs, SIGTERM in the main or first mutant run, main-run and mutant-run timeouts, diff-test hard kills, the SG28 retry.

## Scripts (`audit/25/`)

| script | measures |
|---|---|
| `lib.js` | `audit/22` helpers, `--src DIR` (another commit's `src/`), hook text from `test-runner.js` |
| `run-all.sh` | every AUDIT-25 probe plus the A22 table case, one log each |
| `switch-hot.js` | H1: switch cost per evaluation (env size), hot-path edit outcome, mutant phase vs pre-SG34 |
| `mutant-gen.js` | whole-file lexes / parses / spawns per mutant phase, mutant copies, structural-wrap cost |
| `hook-volume.js` | L1: SG33 `P` key logging per test (pytest 1k–20k, node:test) |
| `leaks.js` | SIGTERM during a later (switch) run; switch-induced timeouts; env and file restore |
