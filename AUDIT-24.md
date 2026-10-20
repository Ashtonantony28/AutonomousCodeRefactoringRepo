# AUDIT-24: API, SDK and contract consistency, round 6

Audited commit `a5df527` (after SG26–SG32). The auditor did not write the code under audit.

Scope: implementations against `src/contracts.js` and CLAUDE.md (session schema, Proposal, TestOutcome statuses and revert reasons, the `mutation.*` outcomes `uncovered_token` / `sham_failed` / `unmutated_ref`, CheckResult, DiffTest, jury fields, learned-gate files, CLI flags and exit codes, resume / reconcile / `inflight.json`, worktree branch names, signal handling with temp dir removal); exported signatures changed by SG27–SG32 (`test-runner` `tapResults` / `junitResults` / `removeLiveDirs` / reporter fallback, `hunks.lexView` / `changeHunks`, `bug-injector.editMutants` sites / use sites / sham, executor `mutation.*`); dashboard and state readers against writers; docs against behaviour. AUDIT-18 and AUDIT-15 repros re-run.

Repros are in `audit/24/`. They drive `runExecutor` or the stub pipeline on temp git repos with a temp `REFACTOR_STATE_DIR` (through `audit/3/lib.js`), make no API calls and do not touch `src/`, `test/`, `state/` or `dashboard/`. Each prints `FINDING` or `ok` and exits 1 on a reproduced finding. Run from the repo root.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 1 new |
| Medium | 8 carried over (AUDIT-18 M1–M8) |
| Low | 3 new, plus AUDIT-18 L1–L3 and older carried-over Lows |

**H1** is new (SG30). The load hooks log every module body that throws, including one a test loads on purpose and expects to throw. Every failing mutant run of that suite then counts as a load failure, so no mutant is ever killed: every edit on such a target ends `reverted` / `tests_insensitive`. At `dd893e9` the same edits were `passed`.

### What holds

- **Contract sweep.** `audit/18/contract-sweep.js`: ok. Every persisted Proposal, JuryVerdict, CheckResult, DiffTest and Sample passes `src/contracts.js`, the session has the CLAUDE.md keys, every `reverted` reason is one of the five, and the learned-gate files are under `stateDirFor(target)`. The run now records `mutation.uncovered_token` (js) and `mutation.unmutated_ref` (py).
- **New mutation outcomes are untested reverts.** `audit/24/untested-outcomes.js`: ok. `sham_failed`, `uncovered_token` and `unmutated_ref` each end `reverted` / `tests_insensitive`, `isLabeled` is false (no sample, reward or Reflexion), and the TestOutcome passes `assertTestOutcome`. The control commits.
- **Executor and `editMutants` agree.** Markers `capped` → `mutation_budget`, `unchecked` → `mutation_budget`, `unmutated_ref` / `uncovered` → `tests_insensitive`, all handled before any suite run. The site key is `${site}r` in `editMutants` / `uncoveredToken` and `r${site}` in the executor's `siteKey`, consistent within each module. `collector.UNTESTED_REASONS` still equals the five reasons the executor emits.
- **Runner exports.** `audit/24/runner-api.js`: ok. `tapResults` / `junitResults` return `{ tests, load }` or null, and number repeated ids `#2`, `#3` the same way. `removeLiveDirs` removes an in-flight run's temp dirs and the run still settles. A delegated `--test-reporter` gives a green run with no `tests`.
- **Signal path.** `node audit/17/leaks.js --cases sigterm-js,sigterm-py`: all ok (exit 0, no process, no temp dir, `inflight.json` cleared).
- **Prior High fixed.** AUDIT-18 H1 (nested reporter): `audit/18/nested-reporter.js` a/b/c ok.
- **AUDIT-15 re-run.** `crash-after-commit-inflight.js` ok; `cli-exit-codes.js` case a ok (exit 2, target untouched).
- **Callers of changed signatures.** `changeHunks(before, after, file)` and `lexView(src, lang)` are called with those arguments by the executor, `bug-injector`, `diff-testing` and `py-diff-testing`. `handleSignal` imports `removeLiveDirs`. CLI flags, exit codes, resume and reconcile code are unchanged since `dd893e9` (orchestrator diff: 2 lines).

---

## High

### H1. A test that expects a module to throw on load turns every mutant run into a load failure

**Affected code**
- `src/runner/test-runner.js` `JS_LOAD_HOOK` / `PY_LOAD_HOOK`: log any module body that throws, caught or not. The JS hook wraps `Module._compile`; the Python hook wraps `__import__`.
- `loadFailed`: any logged non-test module means `loaded = false`.
- `collectionError = status === 'failed' && (… || !loaded)`.
- `src/agents/executor.js`: `if (r.collection_error) { count('collection_errors'); continue; }`.

**How it breaks.** A suite has `assert.throws(() => require('../src/config'))` or `with pytest.raises(RuntimeError): import app.config`. That logs a load failure on every run. Every mutant run that fails, failing on an assertion in another test, is then a `collection_error`. No site is ever killed.

**Contract.** CLAUDE.md: "a run where a module failed to load … is never a kill". Here every module the edit touches loads, and the failure is an assertion. Before SG30 (`dd893e9`) load failures were read from the failing tests' own frames, and these edits were `passed`.

**Impact.**
- Every edit on such a target ends `reverted` / `tests_insensitive` with a wrong status and reason, even though the suite kills the mutants.
- Nothing is committed for that target.
- No sample or Reflexion results (fail-closed).

**Repro:** `node audit/24/caught-load-failure.js`

Observed at `a5df527`:
```
   a js control: status=passed reason=(none) mutation={…"killed":"string_literal","ok":true,…"killed_test":"label",…}
   b js + caught load failure: status=reverted reason=tests_insensitive mutation={…"run":1,"killed":null,"ok":false,"sites":2,"collection_errors":1,…}
   c py control: status=passed reason=(none) mutation={…"killed_test":"tests.test_m::test_label",…}
   d py + caught load failure: status=reverted reason=tests_insensitive mutation={…"run":1,"killed":null,"ok":false,"sites":2,"collection_errors":1,…}
FINDING  b JS: a test that expects a module to throw on load makes every mutant run a load failure (no kill)
FINDING  d Python: pytest.raises around an import makes every mutant run a load failure (no kill)
```
The same script against `dd893e9` sources gives `passed` for all four cases.

**Expected.** A logged load failure should count only when it explains the failure, for example:
- the edited file, or a module that imports it, failed to load in this run but not in the control run; or
- the hook's log is diffed against the control run's.

---

## Medium

### M1–M8. Carried over from AUDIT-18 (AUDIT-15 M1–M8), still reproducing at `a5df527`

| here | repro | now |
|---|---|---|
| M1 untested reverts are failures for every diagnostic consumer | `audit/10/untested-reasons-consumers.js` | unchanged. `mutation.uncovered_token` and `mutation.sham_failed` (SG30) are also read by nothing outside the executor (`audit/24/docs-and-shapes.js` L3: readers `[]`) |
| M2 a red baseline labels every exercised edit | `audit/10/red-baseline-label.js` | unchanged |
| M3 the bar reads `DiffTest.deletions_observed`, not in the contract | `audit/10/deletion-evidence-contract.js` | unchanged |
| M4 infrastructure failures are final verdicts | `audit/7/transient-failure-final.js` | unchanged (M1a, M1b) |
| M5 `--resume` after `--dry-run` executes nothing | `audit/3/resume-scope.js` (M-scope-2) | unchanged |
| M6 status vocabulary (`timeout`) | `audit/3/status-vocabulary.js` | unchanged |
| M7 what-if models only the classifier | `audit/3/whatif-vs-gate.js` | unchanged |
| M8 four of seven contract asserts never run in `src/` | `audit/3/docs-vs-code.js` (M-contract-7) | unchanged |

---

## Low

Repro for L1–L3: `node audit/24/docs-and-shapes.js`.

**L1. Code comments describe the sham as spaces only.**
- Stale comments: `executor.js` ("the edit with as many spaces added at the site") and `bug-injector.js` above `editMutants` ("src with as many spaces added after the mutated code").
- Since SG31 the sham also wraps the site in non-space characters. CLAUDE.md "Sham control" describes this correctly.

Observed: sham line `"  return 'n=' + n + ('!') ;"`, +2 non-space characters.

**L2. `editMutants` element shape and the mutation field names drift from their docs.**
- The documented shape lists `cover?`, which is never set. It omits `span`, which is always set.
- The executor stores an uncovered token's line as `mutation.unmutated_hunk_line`, the field also used for an unmutated reference and for a bare hunk.

Observed: keys `[hunk,line,mutation,sham,site,span,src]`.

**L3. CLAUDE.md's `tests_insensitive` cause list and the contracts lag SG26–SG31.**
- The CLAUDE.md list reads "a site survived, a hunk has no site, or a deleted token is neither observed nor replaced". It omits the uncovered token, the unmutated reference, the sham and load failures, which are described only in the paragraphs above it.
- `src/contracts.js` names none of `uncovered_token`, `sham_failed`, `unmutated_ref`, `collection_errors`, `killed_test`. This extends AUDIT-10 L3.

**Carried over, still reproducing at `a5df527`:**

| finding | repro | now |
|---|---|---|
| AUDIT-18 L1 `.npmrc` `node-options=` silently disables per-test kills (README silent) | `audit/18/docs-and-shapes.js` | unchanged; the SG30 load hook is dropped the same way |
| AUDIT-18 L2 `py-basic` fixture expects `passed` | `audit/18/docs-and-shapes.js` | unchanged (`unmutated_ref=sum`) |
| AUDIT-18 L3 `TestOutcome.test_command` is not the command that ran | `audit/18/docs-and-shapes.js` | unchanged; the load-hook `--require` / `-p refactor_load_hook` are not shown either |
| AUDIT-15 L1 README / CLAUDE.md stale after SG19–SG22 | `audit/15/docs-and-shapes.js` | all 5 statements unchanged |
| AUDIT-15 L2 `DiffTest.counterexample` shape per producer | `audit/15/docs-and-shapes.js` | unchanged |
| AUDIT-15 L3 filesystem failure creating the worktree exits 1 with a stack trace | `audit/15/cli-exit-codes.js` (b) | unchanged (`EEXIST`, exit 1, 10 frames) |
| AUDIT-3 L-doc-1, L-cli-2, L-cli-3, L-doc-4–6, L-test-8, L-status-2–4, L-whatif-2 | `audit/3/docs-vs-code.js`, `status-vocabulary.js`, `whatif-vs-gate.js` | unchanged |

---

## Repro index (`audit/24/`)

| script | covers |
|---|---|
| `caught-load-failure.js` | H1 (JS and pytest, each with a control) |
| `untested-outcomes.js` | `sham_failed` / `uncovered_token` / `unmutated_ref` are untested reverts (ok) |
| `runner-api.js` | `tapResults` / `junitResults` shape, `removeLiveDirs`, reporter fallback (ok) |
| `docs-and-shapes.js` | L1, L2, L3 |
| `lib.js` | `execOn`: one `runExecutor` run on a temp git repo |

Re-run from earlier audits: `audit/18/*.js`, `audit/15/*.js`, `audit/17/leaks.js --cases sigterm-js,sigterm-py`, and the `audit/3/`, `audit/7/` and `audit/10/` scripts named above.
