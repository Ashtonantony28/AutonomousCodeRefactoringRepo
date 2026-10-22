# AUDIT-33 — Performance under load, round 11 (after SG39–SG42)

Commit audited: `233e66d` (SG39 linear caught-load lookup / bounded Python comma scan, SG40 pins, SG41 suite and escaped-name caught-load attribution plus structural separators, SG42 random switch values). Independent auditor. No `src/` or `test/` changes. Every script loads `test/helpers/env.js` first (through `audit/29/lib.js`), so state goes to a temp dir. No live API call.

**Machine:** Linux, 4 vCPU, Node 22. Other sessions ran `npm test` throughout (load average 2.4–4.4). Absolute times are about 2–2.5× the AUDIT-29 figures on unchanged code: `audit/22` js table-16 takes 10.4 s on `1fe6399`, which AUDIT-29 measured at 5.3 s. So every finding below compares the current code with a reference copy **in the same process, interleaved**:
- a `git archive` of an older revision, or
- a copy of the current `src/` with one scan bounded (made by the script, which checks that both give the same result).

**How to reproduce:** `bash audit/33/run-all.sh OUT` runs every probe below plus the AUDIT-29 / AUDIT-25 re-runs and the bench, one log each, with the load average. Each `audit/33/*.js` prints `ok` / `FINDING` per check and exits 1 on a reproduced finding.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 new (M1); A29-M2 carried (now load-dependent in JS too); A25 M2–M6 carried |
| Low | 2 new (L1, L2); A29-L1 and A25 L1–L4 carried |

- **SG39 fixes hold.**
  - `audit/29/load-names.js`: all ok. Direct `loadFailed` takes 150 ms at 20k tests / 10k rows (it was 29 s before SG39). A 2,000-row table takes 20 ms.
  - `audit/29/struct-scale.js`: all ok. py 2 MB runs at 1.01× pre-SG37.
- **SG41 test-runner stays linear** (`tap-scale.js`).
  - Each doubling of the test count costs 1.0–2.3× more time.
  - Constant factor: +96 ms per run at 20k flat tests and +265 ms at depth 8 (L2).
- **SG41 `structural()` cost:**
  - JS `;` whole-prefix regex: no measurable cost.
  - Python logical-line walk for `;`: O(`;` × lines of the logical line), new in SG41 (M1).
  - JS / Python `splits()` → `fresh()` cursor: O(commas × inserted ranges) (L1).
- **SG42 random switch values:**
  - Drawing the two values costs 13 µs per edit.
  - Every mutant of an edit shares one value, and the control value differs.
  - Nothing is paid per run: `audit/25/switch-hot.js` is all ok.
- **Bench p95** (loaded machine): ast 2.10 ms (budget 300), difftest 496 ms (2,000), apply 52.0 ms (100), validator 555 ms (2,500). All within budget.

## Prior repros (re-run on `233e66d`)

| item | command | now | status |
|---|---|---|---|
| A29-H1 `loadFailed` O(rows × tests) | `node audit/29/load-names.js` | all ok. Direct: 30 / 79 / 150 ms at 2k / 10k / 20k. Table R=2000: 20 ms. Post-exit e2e: 52 / 224 / 464 ms vs pre-SG38 23 / 108 / 217 ms (under 1 s; the extra is L2 plus load) | fixed (SG39) |
| A29-H1 executor | `node audit/29/load-names.js --sizes '' --table '' --exec 20000,2000` | ok. R=0 and R=2000 **both** end `mutation_budget` on this machine (see the note below) | fixed; the budget miss is caused by load |
| A29-M1 Python `,` prefix scan | `node audit/29/struct-scale.js` | all ok. js 0.89 / 1.32 / 0.95×, py 0.94 / 0.94 / 1.01× pre-SG37 (100 KB / 500 KB / 2 MB) | fixed (SG39) |
| A25-H1 switch re-read | `node audit/25/switch-hot.js` | all ok. js 5M calls `passed`, mutant phase 2,377 ms. py 3M calls `passed`, 18,209 ms (suite 3.1 s on the loaded machine) | holds after SG42 |
| A29-M2 / A25-M1 parse check in one large literal | `node audit/22/sites-scale.js --cases table --reps 2` | js table-4: 3,683 ms. js table-16: 10,381 ms, **`unchecked`**. py table-4: 7,047 ms. py table-16: 10,963 ms, `unchecked` | open; JS is load-dependent again (below) |
| bench | `npm run bench` | p95 ast 2.10 / difftest 496 / apply 52.0 / validator 555 ms | ok |

**`--exec 20000,2000` note:** the plain suite took 13.1–14.2 s here (it took 5.5 s in AUDIT-29).
- With two sites at three runs per kill, the mutant phase needs 6 × ~14 s, more than the 60 s budget. So R=0 ends `mutation_budget` as well.
- R=2000 is not slower than R=0: executor wall 69.2 s vs 72.2 s. The SG39 fix holds.
- This is the documented budget arithmetic (CLAUDE.md: three runs per kill, all inside the same budget), hit at a lower suite time than "about a third" because there are two sites. It is not a regression.

**A29-M2 bisect (`--cases table --lang js --hunks 16 --reps 1 --src <rev>`).**
- On this machine every revision takes 10.4–10.7 s for js table-16, and ends `unchecked` or returns 192 sites depending on the run:
  - `1fe6399`, `1d75f37`, `1a89ad7`, `233e66d`: `unchecked`.
  - `f520acd`: 192 sites at 10.4 s.
- AUDIT-29 measured 5.3 s on `1fe6399`, so the time doubled with machine load, not with SG41 / SG42.
- The JS parse loop's 10 s limit is wall-clock. Under about 2× load, a JS edit inside a large literal flips from judged to `mutation_budget`. Severity stays Medium (carried): it is an untested outcome, not a wrong verdict.

---

## Medium

### M1. SG41 Python `;` logical-line walk is O(`;` × lines of the logical line), with no deadline
- **Where:** `src/rl/bug-injector.js` `uncoveredToken` → `structural(a, ';')` (Python):
  ```js
  let s = code.lastIndexOf('\n', a - 1) + 1;
  while (s > 0 && depth.get(s)) s = code.lastIndexOf('\n', s - 2) + 1;
  ```
  - SG41 (A31-C2) judges the `;` on the whole logical line. For every inserted `;` it walks back one physical line at a time to the logical line's first line.
  - It runs for every separator token, even after the edit has already failed (`uncoveredToken` collects every token, then picks the first bad one).
  - It is synchronous inside `editMutants`. That call has no wall-clock limit on its JS side (only each `python3` spawn has 10 s). So the executor's event loop, and a SIGINT/SIGTERM revert, wait for it.
- **Measured** (`sep-scale.js --cases py-semi`). Fixture: a module-level list literal of L lines (half the file), then K × `; pass` appended to its closing `]` line. The current code is compared, interleaved, with a copy that memoises the walk per physical line start. Results are identical (`uncovered "pass"`).

  | file | literal lines | K (`;`) | current | memoised | Δ |
  |---|---|---|---|---|---|
  | 109 KB | 5,231 | 1,500 | 1,236 ms | 773 ms | +463 ms (1.60×) |
  | 509 KB | 24,283 | 1,500 | 5,848 ms | 3,710 ms | +2.1 s (1.58×) |
  | 2 MB | 94,101 | 10 | 13,828 ms | 13,888 ms | none |
  | 2 MB | 94,101 | 100 | 14,561 ms | 13,151 ms | +1.4 s |
  | 2 MB | 94,101 | 500 | 20,092 ms | 13,628 ms | +6.5 s (1.47×) |
  | 2 MB | 94,101 | 1,500 | **30,557 ms** | 13,457 ms | **+17.1 s (2.27×)** |

  - The cost is about 11.5 ms per `;` on a 94k-line logical line, linear in K × L.
  - The 13.5 s baseline is the carried whole-file work (A25-L2; `pyShape` under load).
- **Realism:**
  - Low for K in the thousands: many `;` on the closing line of a huge bracket.
  - Moderate for K in the tens to hundreds after a data literal (a generated module), where it adds 0.1–1.4 s.
  - No documented budget breaks: the result is an untested outcome (`uncovered_token`), and `spent` is charged before any mutant run. Hence Medium, not High.
- **Expected:**
  - Compute the logical-line start once per physical line: an array filled in the forward bracket pass that already builds `depth`, or a memo as in the repro's copy.
  - Optionally check a single deadline across `editMutants` (A29-M1 "Expected", not taken in SG39).
- **Repro:**
  - `node audit/33/sep-scale.js --cases py-semi` (FINDING at 2 MB)
  - `--k 500 --kb 2000 --reps 1` for the smaller K

## Low

### L1. SG41 `splits()` calls `fresh()`, whose inserted-range cursor restarts at 0: O(commas × inserted ranges)
- **Where:** `uncoveredToken`:
  - `fresh(a, b)` starts `i = 0` and walks `ins` up to `a` on every call.
  - SG41's `splits(a)` calls `fresh` twice for every inserted `,` that is not followed by a closer: in JS for every comma, and in Python before the trailing-comma rules.
  - The bracket rule calls it too (pre-SG41).
- **Measured** (`sep-scale.js --cases js-comma`). 16 hunks, each inserting `function hN(p0, …, p399) {}`: 6,384 commas and about 12.8k inserted ranges, under the 32,000-char cap. Compared with a copy whose cursor starts by binary search; results are identical (`uncovered "function"`):

  | file | current | bounded | Δ |
  |---|---|---|---|
  | 136 KB | 928 ms | 700 ms | +228 ms (1.33×) |
  | 536 KB | 2,488 ms | 2,096 ms | +392 ms (1.19×) |
  | 2 MB | 7,466 ms | 7,510 ms | within noise |

  - The cost is bounded by the 32,000 changed-char cap: about 0.2–0.4 s at most.
- **Expected:** binary-search the start of the cursor in `fresh` (one line), or sweep the separators in offset order with one shared cursor.
- **Repro:** `node audit/33/sep-scale.js --cases js-comma`. It exits 0: the probe flags only more than 2× and 500 ms; the measured deltas are the finding.

### L2. SG41 per-run TAP / caught-load work grows by a constant factor (linear)
- **Where:** `src/runner/test-runner.js`:
  - `tapResults` now runs `untap` on every subtest and test name and records suites.
  - `loadFailed` indexes tests and suites, and rewrites control characters per distinct name.
  - Both run synchronously after every test process exits (main run, each mutant run, control). The mutant runs are charged that wall time.
- **Measured** (`tap-scale.js`; synthetic node:test TAP; N/2 named load rows split across test names, suite names and unknown names that fall back to the process key; pre-SG41 = `1d75f37`, same input; medians of 3):

  | shape, 20k tests | pre-SG41 tapResults + loadFailed | now | Δ per run |
  |---|---|---|---|
  | flat, suites of 10 (2.6 MB TAP) | 166 + 60 ms | 203 + 119 ms | +96 ms |
  | depth 8, 16k suites (8.6 MB TAP) | 282 + 66 ms | 415 + 197 ms | +264 ms |
  | 2 KB names (91 MB TAP) | 742 + 379 ms | 894 + 587 ms | +360 ms |

  - Scaling is linear: each doubling costs 1.0–2.3×.
  - At 6 mutant runs, a 20k-test target spends about 0.6–1.6 s more of the 60 s mutant budget.
  - The main run's post-exit time (outside its 60 s timeout) grows the same way: `load-names` e2e at 20k is 464 ms vs pre-SG38 217 ms.
- **Expected:** acceptable as is. If it matters:
  - Run `untap` only on names containing `\` (`includes('\\')` before the regex).
  - Build `byName` only when a named `T` row exists. Today it is built lazily on the first named row, which is already the case, so the gain is only in `tapResults`.
- **Repro:** `node audit/33/tap-scale.js`. It prints the pre-SG41 vs current times and exits 0: the checks are linearity and under 1 s at 20k for the flat and depth-8 shapes, and the deltas are the finding.

### Carried
- **A29-L1:** node:test wrapper about 4 ms per test-file process. The hook text is unchanged apart from SG41 logging `P` for named rows too (one `process.on('exit')` per process, as before). Not re-run.
- **A25-L1–L4:** not re-run, code paths unchanged.
- **A25-L2** (duplicate whole-file work):
  - Visible again in the M1/L1 baselines. A CPU profile of `sep-scale.js --cases js-semi --kb 2000` puts `lexView` / `jsLex` / `tokensOf` / `changeHunks` at about 60% of `editMutants`.
  - `changeHunks` runs twice per edit (executor and `editMutants`).
- **A25 M2–M6:** not re-run, code paths unchanged by SG39–SG42.

## What holds

- **JS `;` structural regex over the whole prefix** (`/\b(?:else|do)$/` on `code.slice(0, p + 1)`): no measurable cost.
  - Test: 1,920 inserted `;` (16 hunks × 120 lines, the most the line diff takes) in a semicolon-less file.
  - Current vs 16-char-tail copy: 639 / 564 ms (125 KB), 1,683 / 1,711 ms (525 KB), 5,644 / 6,115 ms (2 MB). Same results.
- **SG41 test-runner linearity:** `tapResults` + `loadFailed` at 5k → 10k → 20k tests take 114 → 120 → 322 ms (flat) and 142 → 266 → 613 ms (depth 8). Every test is parsed and unescaped, and every row is excused.
- **SG42 random values** (`switch-value.js`):
  - `token()` costs 6.6 µs, two per edit.
  - Each edit has one value and one different control value (24 mutants, JS and Python).
  - `editMutants` random vs fixed: js 55 / 52 ms, py 213 / 181 ms (Python spawn noise).
  - The switch is still read once per module load: `switch-hot` is all ok.
- **SG39:** see the prior-repro table.
- **Bench:** within all four budgets.

## Scripts (`audit/33/`)

| script | measures |
|---|---|
| `run-all.sh` | every AUDIT-33 probe, the AUDIT-29 / 25 / 22 re-runs and the bench, one log each with the load average |
| `sep-scale.js` | M1 (`py-semi`, `--k`), L1 (`js-comma`) and the JS `;` hold (`js-semi`): `editMutants` now vs a bounded copy of the current src, same result required |
| `tap-scale.js` | L2: `tapResults` + `loadFailed` at 5k / 10k / 20k tests in flat, depth-8 and 2 KB-name shapes, now vs pre-SG41 |
| `switch-value.js` | SG42: one value per edit, control differs, cost of the random values |
