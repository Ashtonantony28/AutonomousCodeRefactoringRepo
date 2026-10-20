# AUDIT-18: API, SDK and contract consistency, round 5

Audited commit `dd893e9` (after SG26; SG27 not merged). The auditor did not write the code under audit.

Scope:
- implementations against `src/contracts.js` and CLAUDE.md: session schema, Proposal shape, TestOutcome statuses and revert reasons, CheckResult, DiffTest, jury fields, learned-gate files, CLI flags and exit codes, resume / reconcile / `inflight.json`, worktree branch names;
- exported signatures and return shapes changed by SG24–SG26:
  - `test-runner`: `tapResults` / `junitResults` / `tests` / `collection_error`;
  - executor reasons and `mutation.*`;
  - `bug-injector.editMutants` use-site mutants (`capped` / `unchecked` / `unmutated_ref`);
  - `FileSnapshot.restoreFromDisk(path, { committed })`;
  - `worktree.headCommitOf`;
- dashboard and state readers against writers, and docs against behaviour;
- AUDIT-15 repros re-run.

Repros use the stub client, a temp `REFACTOR_STATE_DIR` (through `audit/10/lib.js`) and repos in `os.tmpdir()`. They make no API calls and do not touch `src/`, `test/`, `state/` or `dashboard/`. Each prints `FINDING` or `ok` and exits 1 on a reproduced finding. Run them from the repo root with `node audit/18/<script>.js`. Orchestrator log lines are left out of the outputs below.

At this commit, `npm test` passed 455 of 457 tests. The two failures were the timing-bound mutant-budget tests (`test/executor.test.js:392` and `:401`), run while other sessions kept the host load average around 5. Both pass when re-run on their own (`node --test --test-name-pattern="mutant budget|own budget" test/executor.test.js`: 2/2). They are not counted as findings.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 1 new |
| Medium | 8 carried over (AUDIT-15 M1–M8) |
| Low | 3 new, plus 3 carried over from AUDIT-15 and the older carried-over Lows |

**H1** is new (SG26). The per-test reporters go into `NODE_OPTIONS`. They are skipped only when `--test-reporter` appears in `scripts.test` itself or in the inherited `NODE_OPTIONS`. Suppose `scripts.test` delegates (`npm run unit`) to a script that picks its own reporter. Node then refuses to start the test run, so every run of that suite is red with no test executed, including the main run. The README says such suites "get no kill and end `tests_insensitive`". What actually happens:
- The edit is `reverted` with `edit_not_exercised`.
- If any step before the test run loads the edited code, the edit is `reverted` with no reason. That is a labelled failure: a label-0 sample, a false-positive reward and a Reflexion call. The same suite passes when run by hand.

### What holds

- **Contract shapes.** Two real runs, `js-basic` (ADD passed; a rename gave `tests_insensitive`) and `py-basic` (pytest, JUnit), were checked. Every persisted Proposal, JuryVerdict, CheckResult, DiffTest and Sample passes the asserts in `src/contracts.js`. The session has the keys in CLAUDE.md. Every `reverted` reason is one of CLAUDE.md's five. The learned-gate files are under `stateDirFor(target)`. Repro: `audit/18/contract-sweep.js`, ok.
- **Executor reasons against docs (SG24–SG26).** CLAUDE.md describes each mapping below, and `collector.UNTESTED_REASONS` still lists exactly the five reasons the executor emits:

  | `mutationEvidence` result | reason |
  |---|---|
  | `unchecked` (parse or use check did not finish) | `mutation_budget` |
  | `capped` | `mutation_budget` |
  | `flaky` (the unmutated control failed) | `tests_insensitive` |
  | `unmutated_ref` | `tests_insensitive` |
  | `collection_errors` / `no_failed_test` / `test_set_changed` / `unconfirmed` (no kill) | `tests_insensitive` |

- **`editMutants` and the executor agree.** Every marker that `editMutants` sets (`capped`, `unchecked`, `unmutated_ref`) is handled before any suite run. Revert mutants are their own site in both modules: the key is `${site}r` in `editMutants` and `r${site}` in the executor's `siteKey`.
- **`runTests` shape.** `tests` and `collection_error` are set only when present. The executor reads them only from mutant and control runs (`failedTests`). Neither field reaches the TestOutcome, so nothing in the session changes shape.
- **Crash after the commit (AUDIT-15 H1): fixed.**
  - `restoreFromDisk(path, { committed })` drops a snapshot when `worktree.headCommitOf` finds the `issue_id` trailer on `HEAD` and the files equal `HEAD`. `headCommitOf` parses the trailer exactly as `committedIssues` does.
  - `audit/15/crash-after-commit-inflight.js` (real SIGKILL, then `--resume`) is ok: the branch tip holds the edit and the worktree is clean.
  - `audit/16/snapshot-discard.js` is ok in all four cases, so an uncommitted edit is never dropped.
  - Signal path: SIGINT/SIGTERM cannot land in the same window. `onKept` is synchronous, so `snap.release()` runs in the same microtask as the commit.
- **Prior Critical and High findings, re-run at `dd893e9`:**
  - still fixed: AUDIT-10 C1a/C1b (`audit/10/branch-namespace-in-place.js`) and M2 (`inflight-worktree-gone.js`);
  - still fixed: AUDIT-7 H1–H3 (`sample-identity.js`, `untested-failure-label.js`, `resume-worktree-gone.js`, both cases);
  - still fixed: AUDIT-3 H1a/H1b (`legacy-alias-dependence.js`), H2 / M-scope-1 and M-resume-1;
  - exit codes: `audit/15/cli-exit-codes.js` case a (both worktree adds fail) still exits 2 with the target untouched.

---

## High

### H1. A delegated test script with its own `--test-reporter` breaks every run of the suite; an exercised edit becomes a labelled failure

**Affected code**
- `src/runner/test-runner.js:437` `ownsReporters` reads only `NODE_OPTIONS` and package.json `scripts.test`.
- `:486` appends `--test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=<file>` to `NODE_OPTIONS` for every non-pytest run, the main run included.

**How it breaks.** A suite reached through `npm run unit` (or `make test`) that passes its own `--test-reporter=dot` ends up with three reporters and two destinations. Node exits with `ERR_INVALID_ARG_VALUE` before running any test.

**Contract.** README "Per-test kills": "node:test suites that set their own `--test-reporter`, get no kill and end `tests_insensitive`". CLAUDE.md: "unless the suite picks its own `--test-reporter`".

**Impact.**
- Every edit on such a target is reverted with the wrong reason (`edit_not_exercised`, not `tests_insensitive`), and the recorded main run is red although the suite is green.
- When a step before the test run loads the edited module (a smoke or build script), coverage shows the edit as exercised. The red run then becomes `reverted` with no reason, which means:
  - a label-0 sample and calibration point for an edit that broke nothing;
  - a −2 false-positive reward;
  - a Reflexion repair call.

**Repro:** `node audit/18/nested-reporter.js`

Observed:
```
   a control: status=passed reason=(none) exercised=true labels=[1] reflexion_calls=0 fp_penalty=0 by_hand_exit=0
   b nested own reporter: status=reverted reason=edit_not_exercised exercised=false labels=[] reflexion_calls=0 fp_penalty=- by_hand_exit=0
   c smoke step + nested reporter: status=reverted reason=(none) exercised=true labels=[0] reflexion_calls=1 fp_penalty=-2 by_hand_exit=0
   b stderr tail:     at node:internal/main/test_runner:22:17 { |   code: 'ERR_INVALID_ARG_VALUE' | } | Node.js v22.22.0
ok       control
FINDING  H1b a delegated test script with its own --test-reporter: every run is red, no test runs
FINDING  H1c as b, after a step that loads the edited module: a passing edit becomes a labelled failure
```

**Expected.** The harness's reporters never change whether the suite passes. Either of these would do:
- pass the reporters only where they cannot conflict, e.g. detect the conflict (a run that fails before any TAP is written, then re-run without them) and treat that run as "no per-test results";
- give the reporters only to the mutant and control runs, and judge the main run without them.

---

## Medium

### M1–M8. Carried over from AUDIT-15, still reproducing at `dd893e9`

| here | was | repro | still observed |
|---|---|---|---|
| M1 | AUDIT-15 M1: untested reverts are failures for every diagnostic consumer | `audit/10/untested-reasons-consumers.js` | unchanged: dashboard failed=7, rl_accuracy=0.46 (n=13), agreement grid fp=7, `classifyFailure` = `logic_error`. The new `mutation.*` fields are read by nothing in `src/` either: `killed_test`, `unmutated_ref`, `surviving_ref`, `collection_errors`, `flaky`, `parse_check_failed`. |
| M2 | AUDIT-15 M2: a red baseline labels every exercised edit | `audit/10/red-baseline-label.js` | unchanged |
| M3 | AUDIT-15 M3: the bar reads `DiffTest.deletions_observed`, which is not in the contract | `audit/10/deletion-evidence-contract.js` | unchanged; `contracts.js` has not changed since `d7c4bb5` |
| M4 | AUDIT-15 M4: infrastructure failures are final verdicts | `audit/7/transient-failure-final.js` | unchanged (M1a, M1b) |
| M5 | AUDIT-15 M5: `--resume` after `--dry-run` executes nothing | `audit/3/resume-scope.js` (M-scope-2) | unchanged |
| M6 | AUDIT-15 M6: status vocabulary (`timeout`) | `audit/3/status-vocabulary.js` | unchanged |
| M7 | AUDIT-15 M7: what-if models only the classifier | `audit/3/whatif-vs-gate.js` | unchanged |
| M8 | AUDIT-15 M8: four of seven contract asserts never run in `src/` | `audit/3/docs-vs-code.js` (M-contract-7) | unchanged |

---

## Low

**L1. An `.npmrc` `node-options=` silently disables per-test kills.**
- npm replaces `NODE_OPTIONS` with its `node-options` config for scripts, so the harness reporters never reach node:test.
- `runTests` then has no `tests`, and every edit ends `tests_insensitive`.
- README "Per-test kills" lists other runners and own `--test-reporter`, but not this case.

Repro: `node audit/18/docs-and-shapes.js` (L1). Observed: `plain={"one":"pass"}`, with `.npmrc` `tests=undefined` and status `passed`.

**L2. The `py-basic` fixture expectation is stale after SG26.**
- `test/fixtures/py-basic/proposals.json` expects `passed` for `total` → `return sum(values)`.
- It is now `reverted` / `tests_insensitive` with `mutation.unmutated_ref=sum`: `sum` replaces a loop, and a name inside changed code is no evidence, as CLAUDE.md says.
- No test reads that fixture's `expected_status`. The e2e test checks only `js-basic`.

Repro: `docs-and-shapes.js` (L2).

**L3. `TestOutcome.test_command` is not the command that ran.**
- The JS outcome records `npm test --silent`, without the `NODE_OPTIONS` reporters.
- The pytest outcome records `…python -m coverage run -m pytest -q`, without `--junitxml=… --tb=short`.
- H1 cannot be diagnosed from the session.

Repro: `docs-and-shapes.js` (L3).

**Carried over, still reproducing at `dd893e9`:**

| finding | repro | now |
|---|---|---|
| AUDIT-15 L1: README / CLAUDE.md stale after SG19–SG22 | `audit/15/docs-and-shapes.js` | all 5 statements unchanged: the README mutant sentence, `runs=0`, JS-only diff test, and the `--resume` row and CLAUDE.md naming only `refactor/<run_id>` |
| AUDIT-15 L2: `DiffTest.counterexample` shape per producer | `audit/15/docs-and-shapes.js` | unchanged; Python vetoes read `input ["None"]` / `n/a` |
| AUDIT-15 L3: a filesystem failure creating the worktree exits 1 with a stack trace | `audit/15/cli-exit-codes.js` (b) | unchanged: `EEXIST`, exit 1, 10 frames |
| AUDIT-10 L1: `passed_tests` / `failed_tests` are 0 for node:test | `audit/10/docs-and-shapes.js` | unchanged. SG26 now puts TAP on stdout for every node:test run, but the `# pass N` summary is still not parsed, and the per-test `tests` map is not used for the counts. |
| AUDIT-10 L2 (narrowed): `tests_insensitive` when no mutant ran | `audit/10/docs-and-shapes.js` | still reproduces there (rename, 0 runs). The `audit/15` rename case is now judged by use-site mutants and passes. |
| AUDIT-10 L3: contracts lag load-bearing fields | `audit/10/docs-and-shapes.js` | unchanged; `TestOutcome.mutation` also gained `killed_test`, `unmutated_ref`, `surviving_ref`, `collection_errors`, `no_failed_test`, `test_set_changed`, `unconfirmed`, `flaky`, `parse_check_failed` with no contract entry |
| AUDIT-7 L1–L6 | `audit/7/docs-and-shapes.js` | unchanged |
| AUDIT-3 L-doc-1, L-cli-2, L-cli-3, L-doc-4, L-doc-5, L-doc-6, L-test-8, L-status-2–4, L-whatif-2 | `audit/3/docs-vs-code.js`, `status-vocabulary.js`, `whatif-vs-gate.js` | unchanged |

**Open items from PLAN, confirmed but not counted:**
- Worktrees are never cleaned up.
- Reconciled proposals get a sample but no reward and no synthetic negatives.
- Synthetic negatives are re-scored against the target's file, not the worktree's validated region.
- SG27 (temp dirs on signal, Python scaled constants) is in progress.

---

## Repro index (`audit/18/`)

| script | covers |
|---|---|
| `nested-reporter.js` | H1 (full pipeline: control, delegated reporter, smoke step plus delegated reporter) |
| `contract-sweep.js` | contract asserts, session keys, reasons and learned-gate files on real js / py runs (ok) |
| `docs-and-shapes.js` | L1, L2, L3 |

Re-run from earlier audits: `audit/15/*.js`, `audit/16/snapshot-discard.js`, and the `audit/3/`, `audit/7/` and `audit/10/` scripts named above.
