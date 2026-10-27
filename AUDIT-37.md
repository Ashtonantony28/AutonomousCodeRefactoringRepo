# AUDIT-37 — Performance under load, round 12 (after SG44–SG45)

Commit audited: `c14887e` (SG44 separator `reach()` / `semiReach()` / `seqs` / `tupleNew()` in bug-injector `structural()`; SG45 load hooks: ESM `module.registerHooks` completion marks, Python `sitecustomize` + `__import__` wrapper + excepthook, `R` / `C` rows). Independent auditor. No `src/` or `test/` changes. Every script loads `test/helpers/env.js` first (through `audit/29/lib.js`), so state goes to a temp dir. No live API call.

**Machine:** Linux, 4 vCPU, Node v22.22.0, Python 3.13.16, pytest 9.1.1. Other sessions ran test suites part of the time (load average 1.4–6.8). Every timing compares the current code with a reference **in the same process, interleaved**: the pre-SG45 hook / src (`f70c1ef`) or a copy of the current `src/` with one scan bounded (the script checks that both give the same result).

**How to reproduce:** `bash audit/37/run-all.sh OUT` runs every probe below plus the AUDIT-33 / 29 / 25 re-runs and the bench, one log each, with the load average. Each `audit/37/*.js` prints `ok` / `FINDING` per check and exits 1 on a reproduced finding.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 1 new (H1) |
| Medium | 0 new; A33-M1 carried (re-anchored, still reproduces), A29-M2 and A25 M2–M6 carried |
| Low | 4 new (L1–L4); A33-L1 widened by SG44 (in L2), A33-L2, A29-L1 and A25 L1–L4 carried |

- **H1:** the SG45 ESM hook (`module.registerHooks`) crashes every test process of a target that also registers async loader hooks (`--import` + `module.register`, `--experimental-loader` / `--loader`: tsx, ts-node/esm, esmock). On Node 22.22 the crash is `TypeError: this[#customizations].loadSync is not a function`. Every proposal on such a target ends `reverted` / `edit_not_exercised`. The pre-SG45 hook passes the same suites.
- **SG45 hook overhead is small when no loader is used.**
  - JS: ESM fan-out of 3,000 modules +8 ms, 20 × 512 KB modules +10 ms, 3,000 CJS requires −3 ms, 200 ESM test files −81 ms, 100 spawned node children −47 ms (all within noise).
  - Python: +0.65–2.2 ms per spawned child (sitecustomize). Imports and hot function-level imports are unchanged.
  - Hooks run in the main run and in mutant runs alike, so the 2× plain + 1 s per-run bound does not move. `load-exec` keeps the edit with 6 mutant runs in 28.3 s against the 60 s budget.
- **No hook hangs a run.**
  - The ~600 s BI-pyflag subset in audit/11 is the spawnSync timeout. It kills an unbounded loop in the test helper `plainMutant()`, which spins on the mutant's switch shape (L3). No load hook is involved.
  - Nested Python hook dirs recurse until RecursionError, which ends in about 15 ms (L4).
- **SG44 `structural()`:** no new quadratic step as large as A33-M1. Two scans that exist today:
  - `tupleNew()` scans every top-level comma of the file (L1).
  - `reach()` calls `fresh()` once per character it walks, so A33-L1 now costs about 6× in `uncoveredToken` (L2).
  - Both are bounded by the 32,000-char cap and stay under 1 s.
- **Bench p95:** ast 0.86 ms (budget 300), difftest 220 ms (2,000), apply 14.4 ms (100), validator 421 ms (2,500). All within budget.

## Prior repros (re-run on `c14887e`)

| item | command | now | status |
|---|---|---|---|
| A33-M1 Python `;` logical-line walk | `node audit/33/sep-scale.js --reps 2` | **The script throws** `patch for py-semi does not apply`, because SG44 moved the walk into `lineStart()`. js-semi ok (277 / 627 / 3,210 ms vs 274 / 726 / 2,216 ms bounded). js-comma never runs. | repro stale; re-anchored as `audit/37/sg44-scale.js --cases py-semi` |
| A33-M1 (re-anchored) | `node audit/37/sg44-scale.js --cases py-semi` | **FINDING.** 2 MB, literal of 94,101 lines, K=500: `uncoveredToken` 2,191 ms vs 135 ms memoised. `editMutants` 8,067 vs 5,962 ms. | open (carried) |
| A33-L1 `fresh()` cursor | `node audit/33/sep-scale.js --cases js-comma --reps 2` | all ok. 528 / 1,097 / 3,570 ms vs 302 / 951 / 3,383 ms bounded (136 KB / 536 KB / 2 MB) | open, widened (L2) |
| A33-L2 TAP / caught-load linear | `node audit/33/tap-scale.js` | all ok. At 20k tests, `tapResults` + `loadFailed` take 74 + 58 ms (flat), 143 + 85 ms (depth 8) and 409 + 300 ms (2 KB names). Linear. | holds |
| A29-H1 `loadFailed` | `node audit/29/load-names.js` | all ok. Direct: 11 / 41 / 68 ms. Table R=2000: 11 ms. Post-exit e2e: 20 / 76 / 138 ms (pre-SG38: 16 / 50 / 93) | fixed (SG39), holds with the SG45 hook |
| A29-H1 executor | `node audit/29/load-names.js --sizes '' --table '' --exec 20000,2000` | ok. R=0 and R=2000 both `passed`. 6 mutant runs, suite 4.5 / 4.7 s, mutant phase 28.3 / 28.4 s, executor wall 33.4 / 33.2 s | holds (the machine was quieter than in AUDIT-33) |
| A25-H1 switch re-read | `node audit/25/switch-hot.js` | all ok. js 5M calls `passed`, mutant phase 1,177 ms. py 3M calls `passed`, 7,677 ms | holds after SG45 (`_k === 'v'` compare) |
| bench | `npm run bench` | p95 ast 0.86 / difftest 220 / apply 14.4 / validator 421 ms | ok |

---

## High

### H1. SG45's `module.registerHooks` crashes every test process that also uses an async loader (tsx, ts-node/esm, esmock, `--experimental-loader`)
- **Where:** `src/runner/test-runner.js` `JS_LOAD_HOOK`. runTests preloads it into every test process with `NODE_OPTIONS --require`:
  ```js
  if (M.registerHooks) {
    ...
    M.registerHooks({ load(url, ctx, next) {
      const r = next(url, ctx);
  ```
  - On Node 22, once a process has registered async hooks (`module.register(...)`, which `--import tsx`, `--loader ts-node/esm`, `--loader esmock` and `--experimental-loader` all do), the next ES module load goes through this synchronous hook. Its `next()` then reaches the async loader's chain, which has no synchronous path:
    ```
    TypeError: this[#customizations].loadSync is not a function
        at #loadAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:827:35)
        at nextStep (node:internal/modules/customization_hooks:189:26)
        at load (<pycDir>/load-hook.js:31:15)
    ```
  - The test file process dies before any test runs. The `--import` module never completes, so the hook's own exit handler logs it as a load failure (`T` row) with a key that never passes.
  - runTests then returns `failed` with `collection_error`. The executor reverts the edit as `edit_not_exercised` (no test ran it).
  - This happens on every proposal, in every run, for such a target. The pipeline can never judge an edit there.
- **Measured** (`async-loader.js`). Target: `src/calc.js` plus one node:test file. The loader is a pass-through (`load` / `resolve` just call `next`).

  | test script | pre-SG45 src (`f70c1ef`) | current src |
  |---|---|---|
  | `node --test` (control, ESM) | passed; executor `tests_insensitive` | passed; executor `tests_insensitive` |
  | `node --import ./register.mjs --test` (ESM) | passed; executor `tests_insensitive` (judged) | **failed (collection_error)**; executor **`edit_not_exercised`** |
  | `node --experimental-loader ./loader.mjs --test` | passed | **failed (collection_error)** |
  | `node --import ./register.mjs --test`, CommonJS tests | passed | **failed (collection_error)** |

  The same crash occurs with a bare `node --test` run under the hook (no runTests).
- **Realism:** high for TypeScript or ESM-mocking targets: `node --import tsx --test`, `node --loader ts-node/esm --test`, `--loader=esmock`. Nothing documents the limit. README's "Not seen" list covers only a Node *without* `module.registerHooks`.
- **Severity:** High. A realistic target makes the pipeline fail: every edit is an untested outcome. No wrong commit results (fail closed), so it is not Critical.
- **Expected:** do not call `registerHooks` when the process has async customization hooks.
  - For example, skip it when `process.execArgv` / `NODE_OPTIONS` hold `--import`, `--loader` or `--experimental-loader`, and fall back to the CJS-only behaviour (ES modules not seen, as on a Node without `registerHooks`).
  - Or wrap the `next()` call: on this TypeError, return `next`'s result unmarked and stop marking.
  - Either way, add the async-loader case to README's "Not seen" list, and add a test with a `module.register` loader.
- **Repro:** `node audit/37/async-loader.js` (FINDING ×4; the `plain` control stays ok).

## Medium

None new. A33-M1 is carried: re-anchored and still reproduces (see the prior-repro table).

## Low

### L1. SG44 `tupleNew()` scans every top-level comma of the file for each inserted comma beside kept code
- **Where:** `uncoveredToken` → `structural(a, ',')` (Python) → `beside(a) && tupleNew(a, o)`:
  ```js
  const s = o < 0 ? lineStart(a) : o + 1, e = o < 0 ? lineEnd(a) : code.length;
  if ((commaAt.get(o) || []).some(i => i !== a && s <= i && i < e && !fresh(i, i + 1))) return false;
  ```
  - At statement level (`o = -1`), `commaAt.get(-1)` holds every top-level comma in the file, but only those on the logical line `[s, e)` matter.
  - The cost is O(inserted commas × top-level commas of the file). It is paid for every such comma, even after the edit has already failed (`uncoveredToken` collects every token first).
- **Measured** (`sg44-scale.js --cases py-tuple`). Fixture: 16 hunks × 120 lines of `v = w` → `v = w,` below N lines of `aN, bN = N, 1`. The comparison is a copy that binary-searches the line's slice of the sorted `commaAt` list. Results are identical (`uncovered ","`).

  | file | top-level commas | `uncoveredToken` current | bounded |
  |---|---|---|---|
  | 0.6 MB | 50,000 | 469 ms | 28 ms |
  | 1.2 MB | 100,000 | 211–870 ms | 50–53 ms |
  | 2.1 MB | 170,000 | 390 ms | 129 ms |

  - The total `editMutants` time is dominated by the carried whole-file work (2.9–9.9 s, A25-L2). The scan adds 0.2–0.9 s, with JIT and GC noise.
  - The probe flags only more than 2× and 500 ms, so it exits 0 on most runs. The measured deltas are the finding.
- **Expected:** binary-search `s` in `commaAt.get(o)` (the list is in offset order) and stop at `e`, as in the repro's copy.
- **Repro:** `node audit/37/sg44-scale.js --cases py-tuple`

### L2. SG44 `reach()` calls `fresh(i, i + 1)` for every character it walks (A33-L1 widened)
- **Where:** in `reach()`, for each non-space character on the walk:
  ```js
  if (!fresh(i, i + 1)) return ...
  ```
  - `fresh()` still starts its inserted-range cursor at 0 (A33-L1), so each call costs O(inserted ranges before `i`).
  - SG44 calls `reach()` for every `,` (JS and Python) and every `;` (`splits`, `beside`, `semiReach`). The walks cross inserted tokens and wholly inserted bracket pairs, which brings `fresh()` over the pair.
  - Walks stop at separators, so the total walk is about 2× the inserted characters. That makes the cost O(inserted chars × inserted ranges), bounded by the 32,000-char cap.
- **Measured:**
  - `sg44-scale.js --cases js-reach` (16 × 400-parameter functions): `uncoveredToken` 238 ms vs 38 ms with a binary-searched cursor. `editMutants` 347 vs 160 ms. Same result.
  - `audit/33/sep-scale.js --cases js-comma`: 528 vs 302 ms at 136 KB. In AUDIT-33 it was 928 vs 700 ms on a busier machine. The ratio rose from 1.33× to 1.75×.
  - Nested bracket fixtures are capped earlier by the parser: about 400 levels, after which the result is `unchecked`.
- **Expected:** the A33-L1 one-line fix (binary-search the cursor start in `fresh`). It now also covers `reach()`.
- **Repro:** `node audit/37/sg44-scale.js --cases js-reach`. It exits 0, because the deltas stay under 500 ms.

### L3. audit/11 BI-pyflag "≈600 s" is an unbounded loop in the test helper `plainMutant()`, not a hook hang
- **Where:** `test/helpers/factories.js` `plainMutant()`:
  ```js
  const close = (i) => { for (let d = 0; ; i++) { if ('([{'.includes(code[i])) d++; else if (')]}'.includes(code[i]) && !--d) return i; } };
  ```
  - Under BI-pyflag, the binding reads `... == 'v'` and each switch reads `_k`. So `plainMutant` does not find the Python binding text and takes the JS branch.
  - There, `close()` runs past the end of the string and never returns.
  - A CDP stack of the spinning `test/bug-injector.test.js` process (98% CPU after 139 s) shows `plainMutant :82`, called from a node:test callback. `test/executor.test.js` spins the same way.
  - `audit/11/mutants.js` ends it only by its 600 s `spawnSync` timeout, and then counts the non-zero status as a kill. So the mutant is "killed" by a hang, and every `audit/11` run that includes BI-pyflag (or any future switch-shape mutant) pays about 600 s.
- **Measured:**
  - The unmutated subset (4 test files, 134 tests) takes 76 s.
  - Under BI-pyflag, both test processes were still CPU-bound at 280 s (killed there).
  - `plain-mutant-hang.js`: `plainMutant` on the current switch shape returns in 1 ms. On the BI-pyflag shape it is still running after 5,000 ms and is terminated.
  - No load hook takes part: no child process exists while it spins.
- **Expected:** bound `close()` at `code.length` (throw), so the mutant fails in milliseconds with an assertion, not after 600 s. This is a `test/` change, outside this audit's remit.
- **Repro:** `node audit/37/plain-mutant-hang.js`

### L4. Two SG45 sitecustomize directories on PYTHONPATH recurse until RecursionError ("Error in sitecustomize" in every Python process)
- **Where:** `PY_SITE`. It finds "the sitecustomize it shadows" with `PathFinder.find_spec('sitecustomize', <sys.path minus its own directory>)`.
  - With two such directories `a` and `b` on PYTHONPATH, `a` runs `b`, `b` runs `a` (it only excludes `b`), and so on.
  - This happens when the inner PYTHONPATH is the outer one plus the inner temp dir: a pytest target whose tests run runTests (or this pipeline) on another pytest repo.
  - Python's recursion limit ends it. `site.py` then prints `Error in sitecustomize; set PYTHONVERBOSE for traceback:` / `RecursionError` on stderr of **every** Python process.
  - Each level wraps `sys.excepthook` again, so a main module that raises logs 328 `T` rows and walks the whole hook chain.
- **Measured** (`py-site-nest.js`):

  | dirs | `python3 -c pass` | raising main |
  |---|---|---|
  | one | 15 ms, clean stderr | 28 ms, 1 `T` row |
  | two | 30 ms, "Error in sitecustomize" | 40 ms, **328 `T` rows** |

  It does not hang. A test that asserts empty stderr from a Python child fails in both mutant and control runs, so this is no kill (fail closed).
- **Expected:** mark the chain as visited, for example with `sys.modules`/`os.environ` sentinel such as `REFACTOR_SITE_CHAINED`, or exclude every directory that holds a `refactor_load_core.py`.
- **Repro:** `node audit/37/py-site-nest.js`

### Carried
- **A33-M1** (Medium): see the prior-repro table. The `audit/33/sep-scale.js` py-semi patch is stale since SG44; use `audit/37/sg44-scale.js --cases py-semi`.
- **A33-L1:** widened, see L2.
- **A33-L2:** holds as measured above (linear).
- **A29-M2:** the 10 s parse check is wall-clock and load-dependent. Not re-run; the code path is unchanged.
- **A29-L1:** node:test wrapper. The SG45 additions measured in `hook-load.js` are noise-level.
- **A25 M2–M6, L1–L4:** not re-run; code paths unchanged by SG44 / SG45.
- **A17-M1** (fresh `PYTHONPYCACHEPREFIX` per run): when the environment sets `PYTHONDONTWRITEBYTECODE=1` (common in CI images), every spawned child recompiles its imports too.
  - `py-hook.js --nobytecode` takes 13.0–13.6 s for 200 children with any hook, vs 3.7–4.0 s with bytecode written.
  - This is independent of SG45 (the `none` column is the same).

## What holds

- **SG45 JS hook overhead** (`hook-load.js --reps 3`, medians; none / pre-SG45 / current):

  | suite | none | pre-SG45 | current | Δ |
  |---|---|---|---|---|
  | `esm-fan` (3,000 ES modules) | 371 ms | 371 ms | 379 ms | +8 ms |
  | `esm-big` (20 × 512 KB) | 152 ms | 158 ms | 168 ms | +10 ms |
  | `cjs-fan` (3,000 requires) | 331 ms | 332 ms | 329 ms | −3 ms |
  | `esm-files` (200 files × 20 imports, 1,000 tests) | 3,354 ms | 3,485 ms | 3,404 ms | −81 ms |
  | `spawn` (100 node children) | 1,833 ms | 1,992 ms | 1,945 ms | −47 ms |

  - The source-to-string conversion and the appended mark are not measurable.
  - `registerHooks` does not slow `require()`.
  - Only the `R` row is logged on a clean run.
- **SG45 Python hook overhead** (`py-hook.js --reps 3`, two runs):
  - `spawn`, 200 `python3` children: +131 to +261 ms (0.65–1.3 ms per child).
  - `spawn-path`, 100 extra `sys.path` dirs: +241 to +437 ms (1.2–2.2 ms per child).
  - `imports`, 2,000 modules: −2 / +10 ms.
  - `hot-import`, 300k function-level imports: +2 / +40 ms.
  - The wrapper was already in the pytest process before SG45. Only children are new.
- **Mutant-run budget:** the hooks run in the main run and in mutant / control runs alike, so the per-run bound (2× plain + 1 s) is unaffected. The fixed 60 s budget loses at most the per-child figures above. `load-exec`: 6 runs, 28.3 s.
- **No hook can hang:**
  - The ESM exit handler is O(incomplete modules), with one `appendFileSync` each.
  - The Python hooks have no loops. The nested chain ends by RecursionError (L4).
  - The only hang found is the test helper (L3).
- **SG44 JS `;` path** (`semiReach`, whole-prefix `/\b(?:else|do)$/`): js-semi at 2 MB is 3,210 vs 2,216 ms, within the probe's bound and noisy. `seqs` holds only SequenceExpressions in the hunk lines (`jsShape` region filter), so the per-comma `seqs.some` stays small.
- **Bench:** within all four budgets.

## Scripts (`audit/37/`)

| script | measures |
|---|---|
| `run-all.sh` | every AUDIT-37 probe, the AUDIT-33 / 29 / 25 re-runs and the bench, one log each with the load average |
| `async-loader.js` | H1: runTests current vs `f70c1ef` on `node --test` (control), `--import` + `module.register` (ESM / CJS) and `--experimental-loader` targets; runExecutor on a covered edit |
| `sg44-scale.js` | L1 (`py-tuple`), A33-M1 re-anchored (`py-semi`), L2 (`js-reach`): `uncoveredToken` time on the current src vs a bounded copy, same result required |
| `plain-mutant-hang.js` | L3: `plainMutant` on the current vs the BI-pyflag switch shape, in a worker with a deadline |
| `py-site-nest.js` | L4: one vs two sitecustomize hook dirs on PYTHONPATH (stderr, `T` rows) |
| `hook-load.js` | SG45 JS hook overhead: ESM fan-out, big ESM, CJS fan-out, many ESM test files, spawned children; none / pre-SG45 / current |
| `py-hook.js` | SG45 Python hook overhead: spawned children (with extra path dirs, `--nobytecode`), many imports, hot imports; none / pre-SG45 / current |
