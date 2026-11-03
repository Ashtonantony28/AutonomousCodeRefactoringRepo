# AUDIT-44: API, SDK and contract consistency, round 14

Audited commit `96a06d0` (after SG48–SG51, merged as PR #5). The auditor did not write the code under audit.

Scope: the code against CLAUDE.md, README "Known limits" and `src/contracts.js`. Areas:
- Every rule SG48–SG51 changed:
  - the hook directory first on `PYTHONPATH`, chaining to the operator's `sitecustomize`, and the `sys.excepthook` wrap after it;
  - the `exec_module` wrapper (`importlib.import_module`, `reload`);
  - CommonJS compiled by the ES module loader (`import()`): completion marks and the `node:test` wrapper module;
  - `REFACTOR_LOAD_ROOT` (only the root `node --test` logs `R`);
  - the `U` row on a Node without `module.registerHooks`;
  - `continued`, `droppedKeyword`, `shifts` and the Python slice `:`;
  - the kill-control wording;
  - `maxRetries: 0` and the 300 s request timeout.
- `src/contracts.js` shapes against what the agents, orchestrator, session JSON and dashboard produce and consume.
- Anthropic SDK usage: model, `max_tokens` 4000, one retry on rate limit with a 10 s backoff, and token accounting.
- CLI flags and exit codes (`EWORKTREE` exit 2, `SIGINT` / `SIGTERM` exit 0).
- The `test_outcome` reasons CLAUDE.md lists against the reasons the code emits.
- `engines` (`>=18`) against the features the code needs.

Since `e641183` (AUDIT-40), `src/` changed in three files:
- `claude-client.js`: `new Ctor({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS })`, where `REQUEST_TIMEOUT_MS = 300_000`.
- `test-runner.js`:
  - `pycDir` now comes first on `PYTHONPATH`;
  - `PY_SITE` runs the chained `sitecustomize` first, then wraps `sys.excepthook` in `finally`;
  - `PY_LOAD_CORE` wraps `_LoaderBasics.exec_module`;
  - the JS hook adds a `resolve` hook, the `node-test.cjs` wrapper module, CommonJS completion marks, `REFACTOR_LOAD_ROOT`, and `loader || !M.registerHooks` → `U`.
- `bug-injector.js`: `droppedKeyword`, `continued`, `shifts`, and a `colonAt` slice check.

`src/contracts.js`, `src/orchestrator.js`, `src/agents/*`, the rest of `src/utils/*` and `src/interpretability/*` are unchanged since `e641183`.

Repros are in `audit/44/` (`sh audit/44/run-all.sh`). They make no API calls. They load `test/helpers/env.js` (temp `REFACTOR_STATE_DIR`) and stub the SDK module. Each prints `ok` or `FINDING` and exits 1 when a finding reproduces. Run them from the repo root.

## Summary

| severity | count |
|---|---|
| Critical | 1 (an operator `usercustomize.py` on `PYTHONPATH` that sets `sys.excepthook` replaces the hook's main-module logger; a child load failure kills and the edit commits) |
| High | 0 |
| Medium | 1 new (`engines` `>=18` admits Nodes on which no JS edit can ever commit), plus the AUDIT-18 M1–M8 carried over |
| Low | 2 new (300 s request timeout undocumented; Python `shifts` reaches parameter and import lists, outside the documented scope), plus A40-L1 / A40-L2 (open, still reproduce), A28-L1 (open), A32-L1b (known) and the carried-over Lows |

### What holds

- **AUDIT-40 / AUDIT-42 fixes hold.**
  - `audit/40/py-site-shadow.js` a, b: ok (L03 stops with an operator `sitecustomize` on `PYTHONPATH`).
  - `audit/40/sdk-retries.js` a–c: ok. A 200 is 1 request, a persistent 429 is 2 requests with a 10 s backoff, and a 500 is 1 request.
  - `audit/42/py-excepthook.js` a, b: ok.
  - `audit/37/py-site-nest.js` and `audit/37/async-loader.js`: ok.
- **SDK call shape** (`audit/44/sdk-timeout.js` a, b).
  - The client is built with `maxRetries: 0` and `timeout: 300000`.
  - Each call is one `messages.create` with `model: 'claude-sonnet-4-20250514'`, `max_tokens: 4000`, `system` and a single user message (stateless).
  - `callClaude` keeps its single 429 retry after `RATE_LIMIT_BACKOFF_MS = 10_000`.
  - The key comes from `ANTHROPIC_API_KEY`.
  - `TokenTracker` is unchanged: `input_tokens + output_tokens` per agent, with saturation capped at 1 against 80,000 and a warning at 0.70.
  - No other module constructs an SDK client.
- **SG49 token rules match CLAUDE.md.** I probed 23 shapes outside the pinned rows. These all stop as documented:
  - a continuation `;` before `-`, `??`, `**`, `?:`, `instanceof` and a template;
  - `droppedKeyword` for `do … while` → `&&`, `for … of` → `forEach`, `try` → `||`, and Python `for` → `max(...) >`, `try` → `or`, `while` → `and`;
  - `shifts` in a second call position, a nested array, an arrow parameter list, a Python tuple and a Python subscript tuple;
  - the slice `:` for `s[k::1]`, `s[:k]`, `o.s[k:k + 1]` and a multi-line subscript.

  The spelling `s[k]` → `s[slice(k, k + 1)]` is judged on its sites (no `:` is inserted). It is the A39-M1 behaviour change, but the Python diff test reports it `divergent` (`IndexError` vs `''` on `([], 0)`), so the Critic vetoes it. This is no finding.
- **SG50 JS hook.** Six shapes outside the audit/39 rows stop with a collection error; none is a kill:
  - an ES module test and a CommonJS test that `import()` a CommonJS wrapper which `require`s the throwing module;
  - `createRequire(import.meta.url)` in an ES module test;
  - `require()` of an ES module (`require(esm)`) in a CommonJS test;
  - an ES module test importing a CommonJS helper that defines its tests through `require('node:test')` (the wrapper module);
  - the same helper using `describe` / `it` / `before` / `mock.fn` / `t.run`, which all work through the wrapper (the clean run passes).

  `audit/39/load-probes.js` (H3–H6 and controls), `audit/39/h3-py-importlib.js` and `audit/39/h5-nested-runner.js`: ok. `REFACTOR_LOAD_ROOT` is deleted by the root runner before it spawns file processes, so a nested `node --test` logs no `R`.
- **Python `exec_module` rows** log the module's absolute `__file__`. `loadFailed` makes those paths relative to the repo before `isTestFile` and the `conftest.py` check, so test modules stay excluded. An `ImportError` is still not logged, as documented.
- **`PYTHONPYCACHEPREFIX = pycDir`.** With `pycDir` first on `sys.path`, its mirrored bytecode directories (`tmp/`, `home/`, …) are at most namespace portions, and a regular package later on the path wins. No target module is shadowed.
- **Kill-control wording.** CLAUDE.md now says "the same test fails a second mutant run and passes in a third run with the switch off, the control, whatever other tests do there". The executor matches it:
  - `failedTests(r, control)` keeps the tests that passed in the control and failed in a run with the same test set;
  - the kill is the intersection over both mutant runs;
  - an empty intersection counts as `control_failed` / `unconfirmed` / `test_set_changed`.
- **Untested outcomes.** `audit/24/untested-outcomes.js` a–d: ok. `collector.UNTESTED_REASONS` still lists exactly the five reasons in CLAUDE.md. No reason was added or renamed.
- **Contracts.** `audit/18/contract-sweep.js`: ok. `audit/28/contract-shapes.js` a, M1, M2: ok.
- **CLI.** `audit/15/cli-exit-codes.js` a: ok (exit 2, `EWORKTREE`, target untouched). No flag changed.

---

## Critical

### C1. An operator `usercustomize.py` on `PYTHONPATH` that sets `sys.excepthook` replaces the hook's main-module logger: a child load failure kills, and the edit is committed

**Affected code.** `PY_SITE` (`src/runner/test-runner.js` ~592). The hook's `sitecustomize` runs the next `sitecustomize` on the path, then, in `finally`, saves `sys.excepthook` and installs `_main_raised`. `site.main()` then calls `execusercustomize()` whenever the user site is enabled. That is Python's default, and it holds for root too, since the uid equals the euid. `import usercustomize` searches `sys.path`, and `PYTHONPATH` is on it. A `usercustomize` that assigns `sys.excepthook` (an error reporter, chaining to `sys.__excepthook__`) runs after the wrap and replaces it. So:
- no `T` row is logged for a main module that raises in a child interpreter;
- the child's failure counts as a kill.

This is the A42-C1 shape, moved one module later in Python's startup.

**Contract.**
- CLAUDE.md: a run where a module failed to load is never a kill, including one "logged by the load hooks every run installs, children that keep the environment included: … a sitecustomize … logging a main module that raises".
- README: the hook "first runs the next sitecustomize on the path, e.g. the operator's, then wraps the `sys.excepthook` that one set".

README's "Not seen" list names a child that sets its *own* `sys.excepthook`, not the operator's startup customisation.

**Effect.** This is the audit/42 case (AUDIT-35 L03 family) through the real executor, with the diff test `equivalent`: `app/m.py` changes `normalize('NFC')` to `'NFKC'`. The only test that sees the string mutant runs `python app/m.py ab` as a child, whose main module raises at load.
- With the operator `sitecustomize` (the SG51 fix), the run stops: `collection_errors=1`.
- With the same reporter as `usercustomize.py`, the child's load failure is the kill (`killed=string_literal by=tests.test_m::test_cli`), and the semantics-changing edit is committed.

**Precondition.** The orchestrator's environment carries a `PYTHONPATH` entry with a `usercustomize.py` that sets `sys.excepthook`, and the user site is enabled (no `-s`, no `PYTHONNOUSERSITE`).

**Repro:** `node audit/44/py-usercustomize.js` (it skips when the user site is disabled)
```
   a: reverted tests_insensitive killed=null by=null collection_errors=1
   b: passed  killed=string_literal by=tests.test_m::test_cli collection_errors=null
ok       a control: an operator sitecustomize excepthook is wrapped (SG51)
FINDING  C1 b an operator usercustomize that sets sys.excepthook replaces the hook's; the child main-module load failure kills and the edit commits
```

**Expected.** One of these, with README updated:
- Install the main-module logger so a later assignment cannot drop it. For example:
  - set `sys.excepthook` again from a `usercustomize` the hook also chains (put a chaining `usercustomize.py` in `pycDir`, as with `sitecustomize`);
  - or log from an `atexit` / `sys.exit`-path check of `sys.last_value` rather than through the excepthook.
- Or fail closed: no kill in a run whose children could not keep the hook, for example when a `usercustomize` resolves on `PYTHONPATH`.

---

## Medium

### M1. `engines` admits Node 18 – 22.14, on which no JS edit can ever commit

**Affected code.** `package.json` has `"engines": { "node": ">=18" }`. Since SG50, the JS load hook logs `U <key>` in every process on a Node without `module.registerHooks` (`if (loader || !M.registerHooks)`). A `U` row is a load failure unless its key passes, and the failing file process of a mutant run never passes. Nothing at startup checks the Node version (`src/orchestrator.js` has no such check), and the target's tests run on whatever `node` the test command resolves.

**Contract.** CLAUDE.md and README both state the per-process rule: "on a node without `module.registerHooks` … gets none and counts as a load failure"; README adds "before 22.15 / 23.5". Neither says that this makes every JS edit untestable, and `engines` still advertises 18. AUDIT-39's `old-node.js` preload already noted "package.json allows >= 18".

**Effect.** On Node 18, 20 or 22.0–22.14, every JS edit that reaches the Executor ends `reverted` / `tests_insensitive` with `mutation.collection_errors`. So there is no commit, no RL sample and no calibration point, and the run looks like a run of weak tests. This fails closed: no wrong result, but the pipeline does nothing useful for JS targets on Node versions `engines` accepts.

**Repro:** `node audit/44/old-node-engines.js` (the audit/40 value-tested insertion; b hides `registerHooks` with `audit/39/old-node.js`)
```
   a: status=passed … "killed":"string_literal" … "killed_test":"label"
   b: status=reverted reason=tests_insensitive … "killed":null … "collection_errors":1
ok       a control: the edit commits on this node
FINDING  M1 b engines ">=18" admits a node on which no JS edit can commit (no module.registerHooks: every failing mutant run is a load failure)
```
**Expected.** Either of these:
- `engines.node` `>=22.15` (Node 23.0–23.4 also lacks the API).
- Or a startup warning when the test runner's `node` has no `module.registerHooks`, plus a sentence in CLAUDE.md that JS targets need it for any commit.

---

## Low

### L1. The 300 s per-request timeout SG48 added is in no doc

**Affected code.** `getClient` (`src/utils/claude-client.js`) passes `timeout: REQUEST_TIMEOUT_MS` (300,000 ms) with `maxRetries: 0`.

**Contract.** CLAUDE.md "Model & token budgets" and "Error handling rules" give the model, `max_tokens` 4000 and "retry once on rate limit (10 s backoff), then fail gracefully". README repeats the retry rule. Neither names a request timeout. PLAN's SG48 entry is the only place it appears.

**Effect.** A hung call now fails after 300 s (an `APIConnectionTimeoutError`, no retry) into the graceful path. This is the intended behaviour, but it is undocumented, and it bounds the worst-case time per proposal (Analyzer, three critic personas, Reflexion).

**Repro:** `node audit/44/sdk-timeout.js` (c)
```
ok       a client: SDK retries off and a bounded per-request timeout (SG48)
         maxRetries=0 timeout=300000
ok       b request: model, max_tokens 4000, one stateless user message
FINDING  c L1 the 300 s per-request timeout is documented
         CLAUDE.md and README name no Claude request timeout
```
**Expected.** CLAUDE.md "Error handling rules" says the SDK's own retries are off and each request times out after 300 s, without a retry.

### L2. Python `shifts` reaches `def` parameter lists and parenthesised import lists, outside the scope CLAUDE.md gives

**Affected code.** `shifts` (`src/rl/bug-injector.js` ~1095) treats a `,` as structural in any kept `(` / `[` that has kept code after it. In Python, `structural` applies it to every enclosing bracket.

**Contract.** CLAUDE.md: "a `,` in a kept call, array, pattern or parameter list (Python: call, list, tuple) with kept elements after it".

**Effect.** Two shapes newly stop on the `,` (`uncovered_token`). Both were judged on their sites at `e641183`:
- `def f(a, b=2)` → `def f(a, c=1, b=2)`. Rejecting it is right, because a new positional parameter shifts callers' arguments. But CLAUDE.md lists no Python parameter list.
- `from os.path import (join)` → `(basename, join)`. Nothing shifts here, so this is an over-rejection. It fails closed: no sample, no commit.

The documented call and list rows (controls) stop as before.

**Repro:** `node audit/44/shift-reach.js`
```
FINDING [L2] Py def parameter list `def f(a, b=2)` -> `def f(a, c=1, b=2)` (…)
        stops on ","
FINDING [L2] Py import list `from os.path import (join)` -> `(basename, join)` (nothing shifts)
        stops on ","
ok      [ctl] Py call `t.replace(a, b)` -> `t.replace('x', a, b)` (documented: call)
ok      [ctl] Py list `[a, b]` -> `['x', a, b]` (documented: list)
```
**Expected.** CLAUDE.md says "Python: call, list, tuple, parameter list", and either exempts import lists in `shifts` or names them as an over-rejection.

### Known and carried over

- **A40-L1 (open, still reproduces).** Any `--import` counts as an async loader (`audit/40/esm-hook-overreach.js` b: `tests_insensitive`, `collection_errors=1`).
- **A40-L2 (open, still reproduces).** A spawned ES module CLI that ends in `process.exit()` is a load failure in every run (`audit/40/esm-hook-overreach.js` c; d, the CommonJS control, commits).
- **A28-L1 (open).** `src/contracts.js` names no `TestOutcome.mutation` field (`audit/28/contract-shapes.js` L1).
- **A32-L1b (known).** `audit/32/structural-scope.js` L1b.
- **AUDIT-15 L1–L3.**
  - `audit/15/docs-and-shapes.js` L1, L2.
  - `audit/15/cli-exit-codes.js` L3: a filesystem worktree failure exits 1 with a stack trace.
- **AUDIT-18 L1–L3** (`audit/18/docs-and-shapes.js`) and **AUDIT-18 M1–M8**. No change in the code paths.
- **AUDIT-24 docs L3** is the contracts part of A28-L1.
- **audit/23 F01 F02 G01 G03 G04 (accepted).** Not re-run. The SG49 rules only add stops.

---

## Repro index (`audit/44/`)

| script | covers | result at `96a06d0` |
|---|---|---|
| `py-usercustomize.js` | C1 (executor on the audit/42 NFC → NFKC case with an operator `sitecustomize` (control) vs `usercustomize` that sets `sys.excepthook`) | a ok; b FINDING (committed) |
| `old-node-engines.js` | M1 (value-tested insertion with and without `module.registerHooks`; `engines`) | a ok; b FINDING |
| `sdk-timeout.js` | L1 (client options and request shape with the SDK stubbed; docs) | a, b ok; c FINDING |
| `shift-reach.js` | L2 (Python parameter / import lists vs documented call / list controls) | controls ok; 2 FINDING |
| `run-all.sh` | runs the four above | exit 1 |

Re-run from earlier audits at `96a06d0`:
- ok:
  - `audit/40/py-site-shadow.js` a, b
  - `audit/40/sdk-retries.js` a–c
  - `audit/42/py-excepthook.js` a, b
  - `audit/39/token-sites.js`
  - `audit/39/load-probes.js`
  - `audit/39/control-status.js`
  - `audit/39/h3-py-importlib.js`
  - `audit/39/h5-nested-runner.js`
  - `audit/39/run.js` (0 of 12 committed: ctl 0/5, sep 0/2, semi 0/1, load 0/4)
  - `audit/37/py-site-nest.js`
  - `audit/37/async-loader.js`
  - `audit/36/doc-drift.js`
  - `audit/32/structural-scope.js` a / M1 / L1a
  - `audit/28/contract-shapes.js` a / M1 / M2
  - `audit/24/untested-outcomes.js` a–d
  - `audit/24/docs-and-shapes.js` L1 / L2
  - `audit/18/contract-sweep.js`
  - `audit/15/cli-exit-codes.js` a
- FINDING, known or carried over:
  - `audit/40/esm-hook-overreach.js` L1, L2 (a, d ok)
  - `audit/32/structural-scope.js` L1b
  - `audit/28/contract-shapes.js` L1
  - `audit/15/cli-exit-codes.js` L3
  - `audit/15/docs-and-shapes.js` L1 / L2
  - `audit/18/docs-and-shapes.js` L1–L3
  - `audit/24/docs-and-shapes.js` L3
