# AUDIT-28: API, SDK and contract consistency, round 7

Audited commit `c20f64d` (after SG33–SG35). The auditor did not write the code under audit.

Scope: implementations against `src/contracts.js` and CLAUDE.md (session schema, Proposal, TestOutcome statuses and revert reasons including `control_failed` / `uncovered_token` / `unmutated_ref` / `collection_errors`, CheckResult, DiffTest, jury fields, learned-gate files, CLI flags and exit codes, resume / reconcile / `inflight.json`, worktree names, signal handling). Also the exports changed by SG33–SG35: the `bug-injector` switch and hoisted binding, the `editMutants` shape, the executor `mutation.*` fields, the `test-runner` load-hook keys, and `hunks.lexView` / `valueKey` / `changeHunks`. The audit asks whether switched mutant source or the hoisted binding can reach a committed file, the worktree, the target, `process.env`, samples or synthetic negatives. It checks docs against behaviour, and re-runs the AUDIT-24, AUDIT-18 and AUDIT-15 repros.

Repros are in `audit/28/`. They drive `runExecutor` on temp git repos with a temp `REFACTOR_STATE_DIR` (through `audit/24/lib.js` → `audit/3/lib.js`). They make no API calls and do not touch `src/`, `test/`, `state/` or `dashboard/`. Each prints `FINDING` or `ok` and exits 1 on a reproduced finding. Run them from the repo root.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 1 (residual of A24-H1) |
| Medium | 2 new, plus AUDIT-18 M1–M8 carried over |
| Low | 2 new, plus A24-L3 (contracts part) and the older carried-over Lows |

### What holds

- **No switch leak.** `node audit/28/switch-leak.js`: all ok (a–h). Checked in each case:
  - JS and Python kept edits: the committed blob is the edited text, with no `REFACTOR_MUTANT` / `_refactor_mutant` in the working file, `git log -p --all` or the tree.
  - Python hoist forms `after` (docstring + `__future__`) and `line` (`def` first) both checked.
  - Reverted edits: the file is back to its pre-edit text.
  - `process.env` holds no `REFACTOR_MUTANT*` after a run (`withEnv` restores synchronously; `runTests` copies `process.env` before its first await).
  - Synthetic negatives of a kept edit carry no switch text.
  - SIGKILL while a switched mutant is in the file: the startup `restoreFromDisk` puts the pre-edit text back.
  - SIGTERM at the same point: `handleSignal` restores it, exits 0 and consumes `inflight.json`.
- **Collision and hoist.** A file that already contains `REFACTOR_MUTANT` gets `REFACTOR_MUTANT_1`. The JS binding goes after a shebang and the directive prologue on the first statement's line (no line added). Python goes after the docstring and `__future__` imports, or gets its own line before a compound first statement.
- **`editMutants` shape.** Keys `[env,hunk,line,mutation,site,span,src]` stay within the documented `{ mutation, src, env, line, hunk, site, span, ref?, revert? }` (`contract-shapes.js` a). Executor markers are unchanged: `capped` / `unchecked` → `mutation_budget`; `unmutated_ref` / `uncovered` → `tests_insensitive`, now stored as `mutation.uncovered_token_line`.
- **Untested outcomes.** `control_failed`, `uncovered_token` and `unmutated_ref` each end `reverted` / `tests_insensitive`, `isLabeled` false (no sample, reward or Reflexion), and the TestOutcome passes `assertTestOutcome`. Repro: `audit/24/untested-outcomes.js`. Its case b now reports `control_failed:1` in place of the removed `sham_failed`. The repro still expects the old name, so it prints FINDING, but the behaviour is correct.
- **Contract sweep.** `audit/18/contract-sweep.js`: ok.
- **Prior High fixed for the documented case.** `audit/24/caught-load-failure.js` a–d: ok (A24-H1 with the throw test in its own file). `audit/18/nested-reporter.js`: ok.
- **AUDIT-15 re-run.**
  - `crash-after-commit-inflight.js`: ok.
  - `cli-exit-codes.js` a: ok (exit 2, target untouched).
  - `node audit/17/leaks.js --cases sigterm-js,sigterm-py`: all ok.
- **Unchanged since `a5df527`.** No diff in `orchestrator.js`, `collector.js`, `reward.js`, `contracts.js`, `worktree.js`, `reverter.js`, `checkpoint.js`, `src/validation/` or `src/interpretability/`. CLI flags, exit codes, resume, reconcile, worktree names and the dashboard readers are as audited in AUDIT-24.
- **Old repro, not a regression.** `audit/24/runner-api.js` b printed FINDING once (`live=2 left=1`): it counts every new `refactor-*` dir in the shared `/tmp`, including other sessions' dirs. Three re-runs: ok.

---

## High

### H1. A caught load throw still blocks every kill when it shares a process with the killing test (JS)

**Affected code**
- `src/runner/test-runner.js` `JS_LOAD_HOOK`: a key is marked passed (`P`) only from `process.on('exit')` with `code === 0`, and only when `NODE_TEST_CONTEXT` is set.
- `loadFailed`: any `T` row whose key has no `P` row means `loaded = false`.
- `collectionError`: `!loaded` on a failed run.
- `src/agents/executor.js`: `count('collection_errors'); continue`.

**How it breaks.** SG33 fixed A24-H1 only when the `assert.throws(() => require('../src/config'))` test runs in a node:test file process with no failing test. Two common layouts still break:
- The throw test sits in the same file as the test that kills the mutant. That file process exits 1 in every mutant run.
- The suite runs in one process (`--experimental-test-isolation=none`, or a plain `node test/all.js`). `NODE_TEST_CONTEXT` is unset there, so no key is ever marked passed.

In both, every failing mutant run is a `collection_error`, no site is killed, and the edit ends `reverted` / `tests_insensitive`. The edited module loads and the run fails on an assertion. pytest is not affected: its key is the test, not the module (case d).

**Contract.** CLAUDE.md now reads "a throw caught on purpose is none: logged in a node:test file process that exits 0". That wording codifies the narrow rule. README "Limitations" does not mention it. The outcome is the same wrong status and reason as A24-H1, whose expected fix was "count a logged load failure only when it explains the failure".

**Repro:** `node audit/28/caught-load-same-file.js`

Observed at `c20f64d`:
```
   a: status=passed reason=(none) collection_errors=0 killed_test=label
   b: status=reverted reason=tests_insensitive collection_errors=1 killed_test=-
   c: status=reverted reason=tests_insensitive collection_errors=1 killed_test=-
   d: status=passed reason=(none) collection_errors=0 killed_test=tests.test_m::test_label
FINDING  b JS: a caught load throw in the killing test's own file makes every mutant run a load failure (no kill)
FINDING  c JS: a caught load throw under --experimental-test-isolation=none makes every mutant run a load failure (no kill)
```

**Expected.** Key the JS hook per test, as the Python hook does: a `T` row inside a node:test test that passed is excused. Or count a load failure only when it is absent from the switch-off control run, since the control loads the same text.

---

## Medium

### M1. `mutation.killed_test` / `killed_line` survive beside `killed: null`

`executor.js`: when a later site survives, `Object.assign(out, { killed: null, surviving_… })` leaves the earlier site's `killed_line` and `killed_test` in place. One TestOutcome then says both "nothing killed" and "killed by test `label`". The code comment says "`killed` / `killed_test` name the last killing mutant". No reader outside the executor uses these fields (M1 of AUDIT-18 still applies), so no outcome changes.

**Repro:** `node audit/28/contract-shapes.js` (M1)
```
   M1 status=reverted reason=tests_insensitive killed=null killed_test=label killed_line=4 surviving_site_line=8
FINDING  M1 a surviving site leaves killed_test / killed_line of an earlier kill beside killed=null
```

### M2. A BOM-prefixed Python module: every edit is `mutation_budget` with a parse check that "did not finish"

`pyShape` passes the source string, BOM included, to `ast.parse`, which rejects U+FEFF. `editMutants` returns `unchecked`, and the executor records `parse_check_failed` and `mutation_budget` after 36 ms. CLAUDE.md defines that reason as "the mutants' parse check did not finish in 10 s". Python compiles the file, and the main run passes and covers the edit. At `a5df527` the same edit ended `tests_insensitive` (`uncovered`), so the outcome does not change; only the reason is wrong. Both are untested reasons (no sample).

**Repro:** `node audit/28/contract-shapes.js` (M2)
```
   M2 python3 compiles the BOM file=true; status=reverted reason=mutation_budget parse_check_failed=true mutants=0 duration_ms=36
FINDING  M2 a BOM-prefixed Python module: every edit ends mutation_budget (parse check "did not finish") in well under 10 s
```

### M3–M10. AUDIT-18 M1–M8 (AUDIT-24 M1–M8), carried over

The code paths are unchanged since `a5df527` (see "What holds"). These were not re-run here. Their repros are listed in AUDIT-24.

---

## Low

**L1. `src/contracts.js` names no `TestOutcome.mutation` field** (A24-L3, contracts part; PLAN SG33 row: "L3 contracts part open"). It names none of `control_failed`, `uncovered_token`, `unmutated_ref`, `collection_errors` or `killed_test`. Repro: `contract-shapes.js` L1 (`named=[]`).

**L2. AUDIT-24 repros and README lag SG33/SG34.**
- `audit/24/untested-outcomes.js` b expects `sham_failed`. `audit/24/docs-and-shapes.js` L3 still lists "sham" as a missing cause. Both are old repros, not code drift.
- README "Limitations" does not state the JS caught-throw rule (H1).

**Carried over, still reproducing at `c20f64d`:** AUDIT-18 L1–L3 (`audit/18/docs-and-shapes.js`: 3 FINDING), AUDIT-15 L1–L3 (`audit/15/docs-and-shapes.js` L1/L2, `cli-exit-codes.js` b: `EEXIST`, exit 1), and the AUDIT-3 Lows listed in AUDIT-24.

---

## Repro index (`audit/28/`)

| script | covers |
|---|---|
| `caught-load-same-file.js` | H1 (JS same file, JS isolation none, with a JS and a pytest control) |
| `switch-leak.js` | switch / hoisted binding never committed or left in files, env or samples; SIGKILL and SIGTERM mid-mutant (ok) |
| `contract-shapes.js` | `editMutants` shape (ok), M1, M2, L1 |
| `lib.js` | `execCommit`: `runExecutor` with a real one-file commit; the switch-text pattern |

Re-run from earlier audits: `audit/24/*.js`, `audit/18/*.js`, `audit/15/*.js`, and `audit/17/leaks.js --cases sigterm-js,sigterm-py`.
