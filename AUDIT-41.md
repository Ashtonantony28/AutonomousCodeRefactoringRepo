# AUDIT-41 — Performance under load, round 13 (after SG44–SG47)

Commit audited: `e641183` (SG46: the ES module hook is skipped beside an async loader, which logs a `U` row instead; `fresh()` / `tupleNew()` binary-search their cursors; logical line bounds are memoised; `plainMutant()` throws at the end of the string; the sitecustomize chain skips every copy of itself. SG47: tests only). Independent auditor. No `src/` or `test/` changes. Every script loads `test/helpers/env.js` first (through `audit/29/lib.js`), so state goes to a temp dir. No live API call.

**Machine:** Linux, 4 vCPU, Node v22.22.0, Python 3.13.16. Other sessions ran part of the time (load average 0.37–3.53). Every comparison runs the current code and a reference **in the same process, interleaved**. The reference is the pre-SG45 src (`f70c1ef`, no ES module hook), the pre-SG46 src (`c14887e`), or a bounded copy of the current `src/`.

**How to reproduce:** `bash audit/41/run-all.sh OUT` runs the new probes, the AUDIT-37 probes, the AUDIT-33 / 29 / 25 re-runs and the bench, one log each, with the load average. Each `audit/41/*.js` prints `ok` / `FINDING` per check and exits 1 on a reproduced finding.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 0 (A37-H1 fixed for flagged loaders) |
| Medium | 2 new (M1, M2). Carried and still reproducing: A29-M2, A25 M2–M6. A33-M1 fixed. |
| Low | 0 new. A37-L1–L4 fixed. |

- **M1:** SG46 detects an async loader by the flag, not by an actual registration. Any `--import` in the test command or in the environment's `NODE_OPTIONS` turns off every kill for that target, including an `--import` that registers no loader (a setup module, an APM / OpenTelemetry preload). The `node --test` runner process logs a `U` row whose key can never pass, so every mutant run is a load failure. The pre-SG46 src keeps the edit; the current src ends `tests_insensitive`. With `NODE_OPTIONS=--import …` set on the machine running the pipeline, no JS target can ever commit.
- **M2:** a loader registered from code (`module.register()` in a test file or a `--require` preload) still crashes the test process under the SG45 `registerHooks` hook (`loadSync is not a function`). The suite fails with `collection_error` and every edit ends `edit_not_exercised`. The pre-SG45 src passes and keeps the edit. README documents the crash. It is the residue of A37-H1.
- **No new super-linear scan or hang in SG44–SG47 code.**
  - `sg44-scale` passes on every case: py-tuple at 170,000 top-level commas takes 63 ms for `uncoveredToken` (AUDIT-37: 390 ms).
  - py-semi at 94,101 literal lines takes 130 ms (AUDIT-37: 2,191 ms). A33-M1 is fixed.
  - js-reach takes 15 ms. js-semi at 2 MB is 2,165 vs 2,155 ms bounded.
  - `plainMutant` throws in 1 ms on the BI-pyflag shape.
  - Two sitecustomize dirs give clean stderr and one `T` row.
- **No leak.**
  - Six executor rounds each on JS, Python and loader targets, and on a timed-out suite that spawns a grandchild, leave no temp dir and no process.
  - Heap growth is ≤ 0.3 MB.
- **Budgets hold.**
  - `load-exec` (20,000 tests) keeps the edit with 6 mutant runs in 28.9 / 29.7 s against the 60 s budget.
  - Loader targets stop after 1 mutant run (about 0.4 s), not the whole budget.
- **Bench p95:** ast 0.63 ms (budget 300), difftest 201 ms (2,000), apply 14.9 ms (100), validator 196 ms (2,500).

## Prior repros (re-run on `e641183`)

| item | command | now | status |
|---|---|---|---|
| A37-H1 async loader crash | `node audit/37/async-loader.js` | all ok. plain / import / loader / cjs suites pass like `f70c1ef`. The executor ends `tests_insensitive` on both (that fixture has a surviving site; see M1 for a kept edit) | fixed for flagged loaders; residue M2 |
| A37-L1 `tupleNew` comma scan | `node audit/37/sg44-scale.js --reps 2` | ok. 22 / 37 / 63 ms vs 21 / 36 / 86 ms bounded | fixed (SG46) |
| A37-L2 `reach()` / `fresh()` cursor | same, js-reach | ok. 15 vs 16 ms | fixed (SG46) |
| A33-M1 Python `;` logical-line walk | same, py-semi | ok. 2 MB, K=500: 130 vs 138 ms (AUDIT-37: 2,191 vs 135) | **fixed** (SG46 memo) |
| A33 sep-scale | `node audit/33/sep-scale.js` | js-semi ok: 250 / 625 / 2,165 ms vs 225 / 614 / 2,155 ms. The py-semi and js-comma patches no longer apply, because their bounds are now in src (stale repro). `run-all.sh` runs `--cases js-semi` only | ok |
| A37-L3 `plainMutant` spin | `node audit/37/plain-mutant-hang.js` | ok: throws `switch not found` in 1 ms | fixed |
| A37-L4 nested sitecustomize | `node audit/37/py-site-nest.js` | ok: a:b gives 13 ms, clean stderr, 1 `T` row | fixed |
| SG45 JS hook overhead | `node audit/37/hook-load.js --reps 3` | ok. cur−old: esm-fan +9, esm-big +9, cjs-fan +13, esm-files +79, spawn −30 ms | holds |
| SG45/46 Python hook overhead | `node audit/37/py-hook.js --reps 3` | ok. spawn +1.16 ms / child, spawn-path (100 dirs, now one `isfile` per entry) +1.93 ms / child, imports −28 ms, hot-import +10 ms | holds |
| A33-L2 TAP / caught-load | `node audit/33/tap-scale.js` | ok, linear. At 20k tests: 124 ms flat, 211 ms at depth 8, 685 ms with 2 KB names | holds |
| A29-H1 `loadFailed` | `node audit/29/load-names.js` | ok. Direct: 12 / 33 / 65 ms. Post-exit e2e: 21 / 83 / 137 ms | holds |
| A29-H1 executor | `… --exec 20000,2000` | ok. Both `passed`, 6 runs, suite 4.6 / 4.8 s, mutant phase 28.9 / 29.7 s | holds |
| A25-H1 switch re-read | `node audit/25/switch-hot.js` | ok. JS 5M calls `passed` (1,139 ms phase). Python 3M calls `passed` (8,206 ms) | holds |
| **A29-M2** Python parse check in a large literal | `node audit/22/sites-scale.js --cases table --reps 2` | **FINDING.** py table-16 blocks 7,222 ms (was 10,476 and `unchecked`). js table-16 blocks 3,814 ms. Both are above the probe's 2,500 ms | open (carried) |
| **A25-M2** (A17-M1) per-run bytecode cache | `node audit/37/py-hook.js --cases spawn --nobytecode` | 200 children take 13.6 s with `PYTHONDONTWRITEBYTECODE=1`, vs 4.1 s with bytecode | open (carried) |
| **A25-M3** reporter-fallback budget | `node audit/22/reporter-fallback.js --pre-s 3 --timeout-ms 6500` | **FINDING.** First call: `timeout` at 6,512 ms | open (carried) |
| **A25-M4** mutant run without per-test results | same | **FINDING.** 1 wasted mutant run (4,284 ms) | open (carried) |
| **A25-M5** 12-site cap | `node audit/22/site-budget.js` | **FINDING.** B14 (5 lines) and R4 (8 lines) are `capped` | open (carried) |
| **A25-M6** (A17-M3) Python diff test under 8× contention | `node audit/14/diff-size.js --lang py --kb 50,75,100,150 --contend 8 --reps 3` | 150 KB: 1 of 3 `inconclusive` (41 of 100 runs, p95 1,796 ms). 50–100 KB: all `equivalent` | open (carried) |
| bench | `npm run bench` | p95: ast 0.63, difftest 201, apply 14.9, validator 196 ms | ok |

---

## Medium

### M1. SG46's flag-based loader detection turns off every kill for any `--import`, including preloads that register no loader
- **Where:** `src/runner/test-runner.js` `JS_LOAD_HOOK`:
  ```js
  const loader = process.execArgv.some(a => /^--(?:import|(?:experimental-)?loader)(?:=|$)/.test(a)) ||
    /(?:^|\\s)"?--(?:import|(?:experimental-)?loader)(?:[=\\s"]|$)/.test(process.env.NODE_OPTIONS || '');
  if (loader) {
    if (file) { ... P on exit 0 ... }
    log('U\\t' + key);
  }
  ```
  and `loadFailed`: `(k === 'U' && !passed.has(key))`.
  - The `node --test` runner process inherits the flag but is never a file process (`NODE_TEST_CONTEXT` is unset), so its `U` key never passes.
  - Every failing mutant run is therefore a load failure (`collection_error`), never a kill, and every edit ends `tests_insensitive`. The main run still passes: its load failure counts only when it fails.
  - The check matches the flag, not an async customization hook. `--import ./setup.mjs` (globals, polyfills), `--import dotenv/config`, and APM / OpenTelemetry preloads (`NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register`, `dd-trace/initialize.mjs`) register no loader. The `registerHooks` hook works beside them, as the pre-SG46 src shows.
  - An `--import` in the environment's `NODE_OPTIONS` (CI images, developer shells with an APM agent) reaches every test process of every target. On such a machine no JS edit can commit.
- **Measured** (`import-flag.js`). The AUDIT-29 kept edit: `return x + 1;` → `return x + 2 - 1;`, on a CommonJS node:test target.

  | case | `c14887e` (pre-SG46) | current |
  |---|---|---|
  | `plain`: `node --test` | passed (6 mutant runs, 1.3 s) | passed (6 runs, 1.3 s) |
  | `setup`: `node --import ./setup.mjs --test` (sets a global) | **passed** (6 runs) | **reverted `tests_insensitive`** (1 run) |
  | `envopt`: `node --test`, `NODE_OPTIONS=--import <setup.mjs>` | **passed** (6 runs) | **reverted `tests_insensitive`** (1 run) |
  | `loader`: `--import ./register.mjs` (`module.register`) | `edit_not_exercised` (crash, A37-H1) | `tests_insensitive` (documented fail-closed) |

- **Severity:** Medium. This is fail-closed over-rejection, so no wrong commit results. But it covers whole targets and, through `NODE_OPTIONS`, whole machines. README documents the fail-closed behaviour only for processes with an async loader, and names only loaders (tsx, ts-node/esm, esmock).
- **Expected:** detect an actual async registration, not the flag. For example, wrap `module.register` in the preloaded hook so that the first call turns off `registerHooks` marking for that process and logs `U` from then on. A runner process that loads no test file should log no `U` row. At minimum, document that any `--import` / `NODE_OPTIONS --import` disables kills.
- **Repro:** `node audit/41/import-flag.js` (FINDING on setup and envopt; plain stays ok).

### M2. A loader registered from code still crashes the test process (`edit_not_exercised` on every edit), A37-H1 residue
- **Where:** the same hook. Without a flag, `loader` is false and `M.registerHooks` is installed. A later `require('node:module').register(...)` in a test file (or a `--require` preload) adds async customization hooks. The next `import()` goes through the synchronous hook's `next()` and throws `TypeError: this[#customizations].loadSync is not a function`.
- **Measured** (`mock-module.js`). Same kept edit, `f70c1ef` vs current:

  | case | `f70c1ef` | current |
  |---|---|---|
  | `plain` | passed / executor passed | passed / executor passed |
  | `mock-cjs`: `--experimental-test-module-mocks`, `mock.module()` on a CJS dependency | passed / passed | passed / passed |
  | `mock-esm`: the same, with ESM and `import()` | passed / passed | passed / passed |
  | `register`: the test calls `module.register()`, then `import()` | **passed / executor passed** | **failed (`collection_error`, loadSync TypeError) / `edit_not_exercised`** |

  - node:test module mocking does not trigger it on Node 22.22.
  - `c14887e` gives the same `edit_not_exercised` (`import-flag.js` runtime row).
- **Severity:** Medium, not High. README states the limit ("A loader registered later from code … crashes that process"). No library that does this was found among realistic fixtures here. The outcome is fail-closed.
  - README's wording ("a load failure, no kill") understates the effect: the main run fails, so nothing is judged, and every edit ends `edit_not_exercised`.
  - It would be High for a target whose test helpers register a loader at run time.
- **Expected:** the M1 fix (wrap `module.register`: on the first call, stop marking and switch the process to `U`) covers this as well. Or catch this TypeError around `next()` and return `next`'s result through the default path.
- **Repro:** `node audit/41/mock-module.js` (FINDING ×2 on `register`).

## Low

None new.

## What holds

- **SG46 scans:** bounded as above. The Python `;` head regex and the `tupleNew` `lambda` head regex are O(logical line) per comma or `;`. Only one top-level comma per logical line reaches them beside kept code, so the total is linear. No new quadratic case was found within the 16-hunk / 32,000-char caps.
- **Loader targets** (`--import` + `module.register`, `--experimental-loader`) now run. The executor stops after 1 mutant run (≈0.4 s), so the 60 s budget is not consumed.
- **Python sitecustomize:** the per-entry `isfile` adds no measurable cost (spawn-path +1.93 ms / child, as in AUDIT-37). There is no recursion with nested hook dirs.
- **Leaks** (`leak.js`, 4–6 rounds each):
  - Executor runs on JS, Python and loader targets, and a timed-out suite whose test spawns a grandchild, leave no `refactor-cov-`, `refactor-pyc-` or `pydt-` dir and no process.
  - Heap growth after gc is 0.0–0.3 MB.
  - Node's own shared `node-compile-cache` dir (one per TMPDIR, reused) is excluded.
- **Budgets:** load-exec 28.9 / 29.7 s mutant phase at 20,000 tests (60 s budget). The per-run 2× + 1 s bound is unchanged by SG46: the hook text is the same in main and mutant runs.

## Scripts (`audit/41/`)

| script | measures |
|---|---|
| `run-all.sh` | the new probes, the AUDIT-37 probes, the AUDIT-33 / 29 / 25 re-runs (A29-M2, A25 M2–M6) and the bench, one log each with the load average |
| `import-flag.js` | M1: runExecutor current vs `c14887e` on `node --test`, `--import ./setup.mjs`, `NODE_OPTIONS=--import`, a `module.register` loader and a run-time register |
| `mock-module.js` | M2: runTests / runExecutor current vs `f70c1ef` with node:test `mock.module()` (CJS, ESM) and a run-time `module.register()` |
| `leak.js` | temp dirs, processes and heap across repeated executor runs (JS, Python, loader) and timed-out suites (`node --expose-gc`) |
