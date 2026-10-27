# AUDIT-40: API, SDK and contract consistency, round 13

Audited commit `e641183` (after SG44–SG47, merged as PR #4). The auditor did not write the code under audit.

Scope: the code against CLAUDE.md, README "Known limits" and `src/contracts.js`. Areas:
- Every rule SG44–SG47 changed:
  - the separator and tuple rules;
  - keyword swaps (any deleted keyword);
  - the `R` / `C` / `U` process rows of the JS load hook;
  - the ES module hook beside async loaders;
  - the raw-value switch binding;
  - the nested and chained Python sitecustomize.
- `src/contracts.js` shapes against what the agents, orchestrator, session JSON and dashboard produce and consume.
- Anthropic SDK usage: model, `max_tokens` 4000, one retry on rate limit with a 10 s backoff, and token accounting.
- CLI flags and exit codes (`EWORKTREE` exit 2, `SIGINT` / `SIGTERM` exit 0).
- The `test_outcome` reasons CLAUDE.md lists against the reasons the code emits.

Since `62dee97` (AUDIT-36), `src/` changed in two files:
- `bug-injector.js`: `structural` / `reach` / `seqs` / `tupleNew` / `semiReach`, and any deleted keyword now leaves a guard uncovered.
- `test-runner.js`:
  - `R` / `C` / `U` rows and the ES module `registerHooks` load hook;
  - the async-loader fallback;
  - the Python hook split into `refactor_load_core` and a `sitecustomize` that chains to the next one;
  - duplicate test ids are now `<id>\t#<n>`.

SG47 changed tests only. `src/contracts.js`, `src/orchestrator.js`, `src/agents/*`, `src/utils/*` and `src/interpretability/*` are unchanged since `62dee97`.

Repros are in `audit/40/`. They make no API calls. They load `test/helpers/env.js` (temp `REFACTOR_STATE_DIR`) and stub the SDK's transport. Each prints `ok` or `FINDING` and exits 1 when a finding reproduces. Run them from the repo root.

## Summary

| severity | count |
|---|---|
| Critical | 1 (a `sitecustomize.py` already on the operator's `PYTHONPATH` shadows the Python load hook; a child import error kills again and the edit commits) |
| High | 0 |
| Medium | 1 new (the SDK's own retries under `callClaude`'s one retry), plus the AUDIT-18 M1–M8 carried over |
| Low | 2 new, plus A28-L1 (open), A32-L1b (known) and the carried-over Lows |

### What holds

- **AUDIT-36 fixes hold.**
  - `audit/36/comma-demotes-operand.js` a–f: ok.
  - `audit/36/tap-ids.js` a, L1a, L1b, L2: ok.
  - `audit/36/doc-drift.js` a–d: ok.
- **SG44 separator and tuple rules match CLAUDE.md.** A probe of about 50 shapes outside the pinned tests found no gap. Every shape below is `uncovered_token`:
  - JS comma operator positions: a template `${a, b}`, a computed member `o[a, b]`, `if (a, b)`, `while (a, b)`, `switch (a, b)`, `case a, b:`, `throw a, b`, `return b, a`, `(a, b)`, `for (… in a, b)`, `a ? b : c, d` and `o.x = a, b`.
  - A JS `;` cutting `a + b` or `a || b`.
  - Python tuples:
    - of `return`, `yield`, `await` and assignment statements (`x = a, b`, `o[k] = a, b`, `o.x = a, b`, `n += a, b`);
    - of a lambda body (`g = lambda: a, b`), a `for` iterable and a ternary;
    - in a subscript, an f-string field, a `(a)` after `return` / `in`.
  - The empty-body `;` / `,` heads with a comment or long whitespace between keyword and paren, and multi-line / commented Python grouping parens.

  The genuine separators stay exempt: call arguments, array / object / set displays, `assert a, b` and `with a, b`. The probe scripts are not committed: every result matched the docs.
- **SG45 keyword rule.** Each of these leaves the new keyword uncovered:
  - `for` / `if` / `do` / `try` / `delete` → `while` / `if`;
  - Python `if` / `with` / `del` / `pass` / `not` → `while` / `if`;
  - `let` → `var`, `new` and `yield` inserted, and `of` → `in`.

  This is the rule CLAUDE.md gives: a guard keyword "whose stretch deletes another keyword". A `void` deleted in a different stretch than the inserted `if` stays on the deletion rule, as documented.
- **Raw-value switch binding.**
  - The emitted sources match CLAUDE.md. JS: `var _refactor_mutant = globalThis.process.env.REFACTOR_MUTANT;` on the line after `'use strict';`, with `(_k === 'v' ? (m) : (o))`. Python: `…environ.get('REFACTOR_MUTANT')` joined to the `__future__` line, with `((m) if _k == 'v' else (o))`.
  - `env` / `control` are distinct 16-letter values.
  - `audit/28/switch-leak.js` a–h: ok.
- **Async loaders and nesting.**
  - `audit/37/async-loader.js` all ok, and `audit/37/py-site-nest.js` ok.
  - `module.register` after the `registerHooks` hook crashes the process (`loadSync is not a function`), as README says.
- **Caught loads.** These are all ok:
  - `audit/32/caught-load-names.js` a–d;
  - `audit/28/caught-load-same-file.js` a–d;
  - `audit/24/caught-load-failure.js` a–d.
- **Untested outcomes.** `audit/24/untested-outcomes.js` a–d: ok. `collector.UNTESTED_REASONS` still lists exactly the five reasons in CLAUDE.md. Every other `reason` the executor emits is either a labelled failure (`tests timed out …`, `test command failed to run …`, `commit failed: …`) or a status of its own.
- **Contracts.**
  - `audit/18/contract-sweep.js`: ok.
  - `audit/28/contract-shapes.js` a, M1, M2: ok.

  No shape in `src/contracts.js` changed and no producer or consumer of one changed. The new `mutation.collection_errors` / `surviving_*` fields fall under A28-L1.
- **SDK call shape.**
  - `MODEL = 'claude-sonnet-4-20250514'` and `max_tokens` default 4000.
  - One `messages.create` with `system` plus a single user message (stateless).
  - `callClaude` retries once on a 429 after `RATE_LIMIT_BACKOFF_MS = 10_000`.
  - The key is read from `ANTHROPIC_API_KEY`.
  - `TokenTracker.record` adds `input_tokens + output_tokens` per agent and caps saturation at 1 against 80,000.
  - Except for M1, all of this is unchanged since AUDIT-36.
- **CLI.**
  - `audit/15/cli-exit-codes.js` a: ok (exit 2, `EWORKTREE`, target untouched).
  - `audit/28/switch-leak.js` h: `SIGTERM` exits 0 with the pre-edit text restored.
  - No flag changed since AUDIT-32.

---

## Critical

### C1. A `sitecustomize.py` already on the operator's `PYTHONPATH` shadows the Python load hook: a module that fails to load in a Python child kills again, and the edit is committed

**Affected code.** `runTests` (`src/runner/test-runner.js` ~689) writes the hook's `sitecustomize.py` into `pycDir` and *appends* that directory: `env.PYTHONPATH = [env.PYTHONPATH, pycDir]`. Python imports only the first `sitecustomize` on `sys.path`. When a directory the operator's `PYTHONPATH` already names holds one, that file is imported and the hook's copy never runs. SG46's chaining only works in the other direction, from the hook's copy to a later one. In every child interpreter:
- `__import__` is not wrapped;
- there is no main-module excepthook;
- no `T` row is logged.

The pytest process itself keeps its hook, because `-p refactor_load_hook` imports `refactor_load_core`. So only children are blind, which is exactly the A35-C2 L03 shape.

**Contract.** CLAUDE.md: a run where a module failed to load is never a kill, including when it is "logged by the load hooks every run installs, children that keep the environment included: … a sitecustomize wrapping `__import__` … and logging a main module that raises". The child here keeps the environment, `PYTHONPATH` included. README's "Not seen" list names a child whose `PYTHONPATH` is *replaced*, `-I` / `-E` / `-S`, and a child's own excepthook. It does not name a `sitecustomize` that precedes the hook's.

**Effect.** This is the AUDIT-35 corpus entry L03, NFC → NFKC, run end to end through the real orchestrator with a stub critic:
- The diff test is `equivalent` (it never builds compatibility characters).
- The only failing test is a `subprocess.run([sys.executable, '-c', 'import app.l03 …'])` whose child fails to import the mutated module.
- With the operator's environment as is, the run stops (`collection_errors=1`).
- With `PYTHONPATH` naming a directory that holds a one-line `sitecustomize.py`, the child's import error is a kill (`killed=string_literal by=tests.test_l03::test_cli`), and the semantics-changing edit is committed (witness: `show('Ａ')` was `'Ａ'`, is now `'A'`).

**Precondition.** The orchestrator's environment carries a `PYTHONPATH` entry with a `sitecustomize.py`. Site-wide customizations in the standard library or `site-packages` come after `PYTHONPATH`, so they are chained correctly and are not affected.

**Repro:** `node audit/40/py-site-shadow.js` (runs `audit/35/run.js --only L03` twice)
```
   a: L03  stopped    reverted(tests_insensitive) dt=equivalent(runs=94 obs=true) mut(h=1 sites=1 mutants=1 run=1 killed=null collection_errors=1) -- …
   b: L03  COMMITTED  passed dt=equivalent(runs=94 obs=true) mut(h=1 sites=1 mutants=1 run=3 killed=string_literal@4 by="tests.test_l03::test_cli") -- …
ok       a control: L03 stops with the operator PYTHONPATH as is
FINDING  C1 b a sitecustomize already on PYTHONPATH shadows the load hook: a child import error kills and the edit commits
```
**Expected.** Either of these, and CLAUDE.md / README updated with the precedence rule:
- Put `pycDir` *first* on `PYTHONPATH`. It holds only the `refactor_load_*` modules and the chaining `sitecustomize.py`, which already runs the next one.
- Or fail closed: no kill in a run whose children could not take the hook, for example when `PYTHONPATH` before `pycDir` resolves a `sitecustomize`.

---

## Medium

### M1. The SDK's own retries run under `callClaude`'s single rate-limit retry: up to 6 requests per call on a 429, and 3 on a 5xx or a connection error

**Affected code.** `getClient` (`src/utils/claude-client.js`) builds the client with `new Ctor({ apiKey })`, which takes the SDK's defaults (`@anthropic-ai/sdk` 0.30.1 `core.js`: `maxRetries = 2`, `timeout = 600000`). The SDK retries 408, 409, 429, every 5xx and connection errors twice, with its own backoff (it honours `retry-after`). Only after that does `callClaude` see the 429, sleep 10 s and call again, and that call gets two more SDK retries.

**Contract.** CLAUDE.md: "Every Claude API call: retry once on rate limit (10 s backoff), then fail gracefully". The module's own constant (`RATE_LIMIT_BACKOFF_MS`) and the `attempt === 0` loop implement exactly that. The SDK layer underneath multiplies it.

**Effect.** For a persistent 429:
- 6 requests;
- the 10 s backoff plus up to four SDK backoffs, each as long as the server's `retry-after`.

For a 500 or a dropped connection:
- 3 requests, where the docs say no retry;
- with a 10-minute SDK timeout per attempt, a hung call can take up to 30 minutes, or 60 when it ends in a 429.

There are no wrong results: the call still fails into the documented graceful path. But the retry budget, the latency and the API spend per proposal differ from the documented rule.

**Repro:** `node audit/40/sdk-retries.js`. This stubs `APIClient.prototype.fetchWithTimeout`, sets a dummy key and makes no network calls. It takes about 10 s.
```
   a: requests=1 err=null  b: requests=6 err=429 RateLimitError ms=10009  c: requests=3 err=500 InternalServerError
ok       a control: a 200 is one request
FINDING  b a persistent 429 is sent more than twice (SDK maxRetries 2 under callClaude's one retry)
FINDING  c a persistent 500 is retried by the SDK (CLAUDE.md: fail gracefully, retry only on rate limit)
```
**Expected.** Either of these:
- `new Ctor({ apiKey, maxRetries: 0 })`, with a bounded `timeout`, so `callClaude`'s loop is the whole policy.
- Or CLAUDE.md states the SDK's retries.

---

## Low

### L1. Every `--import` counts as an async loader: a suite with a plain `--import` setup module gets no kill (fails closed)

**Affected code.** The JS hook decides `loader` on the flag alone: `/^--(?:import|(?:experimental-)?loader)(?:=|$)/` in `execArgv`, or the same flag in `NODE_OPTIONS`. It then skips `registerHooks` and logs `U <key>`.

`module.registerHooks` works beside a `--import` module that registers no hooks. Checked on Node 22.22: a `--require` preload with `registerHooks` and `--import ./setup.mjs` loads ES modules normally.

**Contract.** CLAUDE.md: "a process with an async loader gets none". README lists `--import` among the async-loader flags (tsx, ts-node/esm, esmock), but a plain `--import ./test/setup.mjs` sets globals and registers no loader.

**Effect.** For `node --import ./test/setup.mjs --test`:
- Every failing mutant run is a load failure, because the failing file process's `U` row never passes.
- Every edit ends `reverted` / `tests_insensitive` with `collection_errors`.

The same edit and suite without `--import` commits. This fails closed: no sample and no commit.

**Repro:** `node audit/40/esm-hook-overreach.js` (a control, b)
```
   b: status=reverted reason=tests_insensitive mutation={…"killed":null,…"collection_errors":1,…}
FINDING  L1 b a plain `--import` setup module (no async loader) makes every failing mutant run a load failure
```
**Expected.** Either of these:
- Take the `registerHooks` hook and log `U` only once a loader is actually registered. For example, check `module.register` use, or detect the conflict at the first ES module load.
- Or CLAUDE.md says "any `--import` / `--loader`" rather than "an async loader".

### L2. A spawned ES module CLI that ends in `process.exit()` is a load failure in every run (fails closed, undocumented)

**Affected code.** The ES module hook appends a completion mark to every `format: 'module'` source and logs every module still unmarked at exit as `T`. An ES module CLI whose body calls `process.exit(0)` never reaches its mark (`console.log(usage); process.exit(0);` at top level, or `process.exit(await main())`). Its process is a child a test spawned, so its key never passes.

**Contract.** CLAUDE.md / README describe these as modules "loaded but not completed at exit" in the context of module-load failures. A body that exits on purpose is not a load failure. The same CLI as CommonJS is not logged, because the `_compile` wrapper sees no throw.

**Effect.** Every failing mutant run of a suite that spawns such a CLI is a load failure. Every edit ends `tests_insensitive` (`collection_errors`), while the identical CommonJS CLI commits. This fails closed.

**Repro:** `node audit/40/esm-hook-overreach.js` (c; d is the CommonJS control)
```
   c: status=reverted reason=tests_insensitive mutation={…"killed":null,…"collection_errors":1,…}
   d: status=passed reason=(none) mutation={…"killed":"string_literal",…"killed_test":"label",…}
FINDING  L2 c a spawned ES module CLI that ends in process.exit() makes every failing mutant run a load failure
```
**Expected.** Either of these:
- Treat an unmarked module as a load failure only when the process exits non-zero or through an uncaught exception, which an `exit` listener (exit code) plus an `uncaughtException` listener can tell apart.
- Or README "Caught module-load throws" names a top-level `process.exit()` in an ES module as "not completed".

### Known and carried over (still reproducing at `e641183`)

- **A28-L1 (open).** `src/contracts.js` names no `TestOutcome.mutation` field (`audit/28/contract-shapes.js` L1). This now also covers `collection_errors`, `surviving_hunk_line` and `surviving_site_line`.
- **A32-L1b (known).** The repro expectation conflicts with the binding rule (`audit/32/structural-scope.js` L1b).
- **AUDIT-15 L1–L3.**
  - `audit/15/docs-and-shapes.js` L1, L2.
  - `audit/15/cli-exit-codes.js` L3: a filesystem worktree failure exits 1 with a stack trace.
- **AUDIT-18 L1–L3** (`audit/18/docs-and-shapes.js`) and **AUDIT-18 M1–M8**. No change in the code paths.
- **AUDIT-24 docs L3** is the contracts part of A28-L1.
- **audit/23 F01 F02 G01 G03 G04 (accepted).** Not re-run. `bug-injector.js` changed only in the SG44 / SG45 structural and keyword rules, which those entries do not reach.

---

## Repro index (`audit/40/`)

| script | covers | result at `e641183` |
|---|---|---|
| `py-site-shadow.js` | C1 (`audit/35/run.js --only L03` with and without a `sitecustomize.py` on `PYTHONPATH`) | a ok; b FINDING (committed) |
| `sdk-retries.js` | M1 (requests per `callClaude` on 200 / persistent 429 / persistent 500; stubbed transport) | a ok; b, c FINDING |
| `esm-hook-overreach.js` | L1 (plain `--import` setup), L2 (ES module CLI ending in `process.exit`), controls a and d | a ok, d ok; L1, L2 FINDING |

Re-run from earlier audits at `e641183`:
- ok:
  - `audit/36/comma-demotes-operand.js` a–f
  - `audit/36/tap-ids.js`
  - `audit/36/doc-drift.js`
  - `audit/32/caught-load-names.js` a–d
  - `audit/32/structural-elif.js` a–d
  - `audit/32/structural-scope.js` a / M1 / L1a
  - `audit/28/switch-leak.js` a–h
  - `audit/28/caught-load-same-file.js` a–d
  - `audit/28/contract-shapes.js` a / M1 / M2
  - `audit/24/untested-outcomes.js` a–d
  - `audit/24/caught-load-failure.js` a–d
  - `audit/18/contract-sweep.js`
  - `audit/15/cli-exit-codes.js` a
  - `audit/37/async-loader.js`
  - `audit/37/py-site-nest.js`
  - `audit/35/run.js --only L02,L03` (0 committed)
- FINDING, known or carried over:
  - `audit/32/structural-scope.js` L1b
  - `audit/28/contract-shapes.js` L1
  - `audit/15/cli-exit-codes.js` L3
  - `audit/15/docs-and-shapes.js` L1 / L2
  - `audit/18/docs-and-shapes.js` L1–L3
  - `audit/24/docs-and-shapes.js` L3
