# AUDIT-15: Contract and API consistency, round 4

Audited commit `d7c4bb5` (after SG18–SG23, with SG24/SG25 not merged). The auditor did not write the code under audit. The audit compares every stage boundary against `src/contracts.js` and the "Interface contracts" section of `PLAN.md`, including the fields and outcomes SG18–SG23 added:
- `DiffTest.deletions_observed` from both producers (JS `diff-testing.js`, Python `py-diff-testing.js` / `py_diff_harness.py`), and the Python DiffTest shape against the JS one;
- `TestOutcome.mutation` (`sites`, `surviving_site_line`, `suite_ms`, `timeouts`, `edit_too_large`, `unobserved_deletion_line`, `killed_line`);
- the reasons `mutation_budget`, `tests_insensitive` and `coverage_timeout`, and every consumer: collector `UNTESTED_REASONS`, calibration, reward, Reflexion, dashboard, probe, clustering, counterfactual, server;
- the SG21 fallback branch names (`refactor-run/<run_id>`, `refactor-run-<run_id>`) against resume, reconcile and the docs;
- the crash snapshot (`inflight.json`) against resume reconciliation;
- `npm run coverage` and `scripts/`;
- CLI exit codes (`EWORKTREE`, exit 2), and `README.md` / `CLAUDE.md` claims against the code.

SG24/SG25 work in flight (executor mutant re-runs, Python harness, bug-injector) is out of scope. So are findings already in AUDIT-11 to AUDIT-14.

All repros use the repo's stub client and a temp `REFACTOR_STATE_DIR` (`test/helpers/env.js`, through `audit/10/lib.js`). They use copies of the fixtures or throw-away repos in `os.tmpdir()`. They make no API calls and do not touch `state/`, `dashboard/`, `src/` or `test/`. Each script prints `FINDING` (with observed and expected) or `ok`, and exits 1 when it reproduces a finding. Run them from the repo root with `node audit/15/<script>.js`. Orchestrator log lines are left out of the outputs below.

At this commit:
- `npm test`: 427/427 pass.
- `npm run coverage`: exit 0. Lines covered: `src/validation` 95.3%, `src/runner` 93.0%, `src/rl` 97.7%, `src/orchestrator.js` 94.2%. This matches the README and the SG23 Log row.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 1 (new) |
| Medium | 8 carried over (AUDIT-10 M1, M3–M9) |
| Low | 3 new (+ 4 carried over from AUDIT-10, + 6 from AUDIT-7, + 10 from AUDIT-3) |

**H1** is new. It is a gap in the "crash after the commit" resume path that CLAUDE.md promises. The executor drops its pre-edit snapshot only *after* the commit. A crash in that window leaves `inflight.json` behind. On the next start, `restoreFromDisk` writes the pre-edit content back over the committed edit. `--resume` then reconciles the proposal as `passed` with its commit. The next commit of the same file silently undoes that edit on the run branch.

### Prior Critical and High findings (`audit/3`, `audit/7`, `audit/10`, re-run at `d7c4bb5`)

| finding | script | now |
|---|---|---|
| AUDIT-10 C1: a fresh run edits a git target in place when `worktree add` fails | `audit/10/branch-namespace-in-place.js` | **fixed**. C1a and C1b are ok. With a user branch `refactor`, the run uses a worktree on the fallback branch: `03a39758:passed@<sha>`, `src/math.js` in the target is unchanged, and the user's concurrent save survives. When both adds fail, the CLI exits 2 with the target untouched (`audit/15/cli-exit-codes.js` a). |
| AUDIT-10 M2: a crash snapshot whose worktree is gone breaks every run | `audit/10/inflight-worktree-gone.js` | **fixed**. The snapshot is discarded with a warning. |
| AUDIT-7 H1: samples keyed by `issue_id` | `audit/7/sample-identity.js` | still fixed |
| AUDIT-7 H2: a red suite that never ran the edit is labelled | `audit/7/untested-failure-label.js` | still fixed |
| AUDIT-7 H3: `--resume` edits a git target in place | `audit/7/resume-worktree-gone.js` | still fixed (both cases) |
| AUDIT-3 H1: gate and fusion read non-contract fields | `audit/3/legacy-alias-dependence.js` | still fixed (H1a, H1b ok) |
| AUDIT-3 H2: global `session.json` | `audit/3/resume-scope.js` (M-scope-1) | still fixed |
| AUDIT-3 M-resume-1: crash after commit | `audit/3/resume-after-commit-crash.js` | ok, but it snapshots `session.json` only and not `inflight.json`, so it cannot see H1 |

**Builders' edits to the audit scripts.** No commit after `0b99c1d` (AUDIT-10) touches `audit/3/`, `audit/7/` or `audit/10/`, so no check was weakened. One weakness is the auditors' own: `audit/10/docs-and-shapes.js` L4 reports `ok` only because its README regex (`at least one of up to 3 bug-injected mutants`) does not match across the wrapped line of the README's architecture block. The stale statement is still there (L1 below).

### What holds

- **Untested outcomes are excluded from learning consistently.** The executor produces five untested reasons: `edit_not_exercised`, `no_coverage_tool`, `coverage_timeout`, `tests_insensitive` and `mutation_budget`. `test-runner.js` produces no other `coverage.reason`, so a red suite can never carry a reason outside the list. `collector.UNTESTED_REASONS` lists all five. Three places use the same `isLabeled`:
  - the orchestrator's early return, so there is no sample, reward, synthetic negative or Reflexion call (`orchestrator.js:229`);
  - `collectSample`;
  - `calibration.executedPoints`.

  An exception inside `mutationEvidence` reverts (`executor.js:190`, `tests_insensitive`).
- **Python and JS DiffTests both satisfy `assertDiffTest`.** Both producers:
  - set `applicable = verdict !== 'inconclusive'`;
  - set `runs` and `duration_ms`;
  - set `deletions_observed` exactly when the snippet deletes tokens, and only as `verdict === 'equivalent' && every probe ran`.

  The gate (`unconfirmedBlock`) treats `.py` like `.js`: a Python `runs = 0` result is rejected. `relaxConditionChange` downgrades only `condition_change`. The per-call binding digests stay inside the sandbox worker and do not reach the DiffTest.
- **Fallback branch names stay consistent.** `setupWorkspace` records the branch that `createWorktree` actually created, and every later step reads `session.worktree.branch`:
  - `resumeWorktree`;
  - `committedIssues` (reconcile);
  - `commitsSinceBase`;
  - the end-of-run line.

  The branch name `refactor/` is hard-coded only as the first choice, and as a fallback label when `rev-parse` fails on an existing worktree.
- **Exit codes.** `EWORKTREE` from `createWorktree` (both adds fail) and from `resumeWorktree` exits 2. A missing `--repo` exits 2. SIGINT/SIGTERM exit 0. Other fatal errors exit 1.
- **`npm run coverage`.** `scripts/coverage.js` runs the same test files as `npm test`. It counts the diff-prep and sandbox worker isolates through `scripts/worker-coverage.js` and fails below 85% per target, as the README says.

---

## High

### H1. A crash right after the executor's commit leaves `inflight.json`; the next start restores the pre-edit content over the committed edit, and resume's next commit of that file undoes it

**Affected code**
- `src/agents/executor.js:206` and `:222`: `commit = await onKept()` (the worktree commit) runs **before** `snap.release()`, which deletes `inflight.json`. Between the two, the snapshot on disk holds the pre-edit content of a file whose edit is already committed.
- `src/orchestrator.js:288`: on every start, `FileSnapshot.restoreFromDisk` writes that pre-edit content into the run worktree (`reverter.js:88-104`). This happens before the worktree is resumed and before `reconcileWithBranch` (`:307`). Nothing checks whether the snapshot's edit (`meta.issue_id`) is already committed on the branch.
- `reconcileWithBranch` (`:412`) then marks the proposal `passed` with the commit sha and collects a label-1 sample.
- `worktree.commitProposal` (`worktree.js:204`) stages the **whole** edited file. The next passing edit of that file therefore commits the revert along with its own change, under a message that names only the new `issue_id`.
- Contract: CLAUDE.md says a proposal committed before a crash "is marked `passed` with that commit, not re-executed". It also says "on crash the next start restores [the snapshot]".

**Impact.** This is exactly the crash that resume reconciliation exists for. A SIGKILL, OOM kill or power loss during `git commit` or the `rev-parse` after it hits the window. Afterwards:
- The session, the dashboard, the calibration point and the sample all say the edit is `passed` at commit X, but the run branch's tip no longer contains it. The edit is reverted by a later commit that claims to be a different refactor, so a reviewer of the branch sees a commit whose diff does not match its message.
- If no later proposal edits that file, the worktree is left with an uncommitted revert of a committed edit. Every later proposal on the same run is validated and tested against code that differs from the branch.

No user work is lost and nothing unvalidated is committed: the revert restores the user's original code. That is why this is High (corrupted run state and resume decision) and not Critical.

**Repro:** `node audit/15/crash-after-commit-inflight.js`. A child process runs `js-basic` plus a second inlinable function `twice` in the same file, and SIGKILLs itself the moment `worktree.commitProposal` returns. The parent then runs `--resume`.

Observed:
```
crash: child signal=SIGKILL; branch=refactor/d7d98a6e-… tip=87e993ad; inflight.json present=true; session outcomes: 03a39758:null, c8e1fc57:null
branch after crash: add's edit committed=true
resume: outcomes 03a39758:passed@87e993ad, c8e1fc57:passed@31c9abce
resume: commits on refactor/d7d98a6e-…:
  31c9abc refactor: src/math.js [c8e1fc575fa6fc8b]
  87e993a refactor: src/math.js [03a39758265507f1]
resume: branch tip src/math.js holds add's edit: false; last commit re-adds 'const result': true
FINDING  H1 a crash after the commit restores the pre-edit snapshot over a committed edit; the next commit of the file undoes it
```

**Expected:** a snapshot whose edit is already committed must never be restored. Any of these would do:
- release the snapshot before (or atomically with) the commit, since after `git commit` succeeds the branch is the source of truth;
- in `restoreFromDisk`, skip the restore when the worktree file equals its content at the branch's `HEAD` and `meta.issue_id` is in `committedIssues`;
- restore only after the worktree is resumed and reconciled, and drop a snapshot whose `issue_id` was reconciled.

`audit/3/resume-after-commit-crash.js` should also snapshot `inflight.json`.

---

## Medium

### M1–M8. Carried over, still reproducing at `d7c4bb5`

| here | was | repro | still observed |
|---|---|---|---|
| M1 | AUDIT-10 M1 / AUDIT-7 M2: untested reverts are failures for every diagnostic consumer | `audit/10/untested-reasons-consumers.js` | unchanged; it now also covers `mutation_budget`, since the consumers match `status === 'reverted'` and never read `reason`. The dashboard shows failed=7 and rl_accuracy=0.46 (n=13) while calibration has n=7; the agreement grid shows fp=7, the probe trains on untested reverts, clustered failures=7, `classifyFailure` returns `logic_error` and the run summary shows failed=7. None of `mutation.*` (`sites`, `surviving_site_line`, `timeouts`, `edit_too_large`, …) is read by the dashboard, the server or Reflexion, so the dashboard cannot say why an edit was untested. |
| M2 | AUDIT-10 M3: a suite that is red before the edit labels every exercised edit | `audit/10/red-baseline-label.js` | `reverted` with no reason: label 0, a −2 false-positive reward, `logic_error`, 1 Reflexion call |
| M3 | AUDIT-10 M4: the commit bar reads `DiffTest.deletions_observed`, which is not in the contract | `audit/10/deletion-evidence-contract.js` | unchanged in the contract and `assertDiffTest`. Both producers now set the field the same way (SG19), so the practical risk is lower. `lang` (Python only) is a second extra. |
| M4 | AUDIT-7 M1: infrastructure failures are final verdicts | `audit/7/transient-failure-final.js` | a critic outage gives `vetoed`; a validator throw gives `critic_rejected` |
| M5 | AUDIT-3 M2: `--resume` after `--dry-run` executes nothing | `audit/3/resume-scope.js` (M-scope-2) | `[dry_run, vetoed]`, 0 commits |
| M6 | AUDIT-3 M3: status vocabulary | `audit/3/status-vocabulary.js` | `timeout` has no label but is scored by reward, clustering and the dashboard as a failure |
| M7 | AUDIT-3 M4: what-if models only the classifier | `audit/3/whatif-vs-gate.js` | unchanged |
| M8 | AUDIT-3 M5: four of seven contract asserts never run in `src/` | `audit/3/docs-vs-code.js` (M-contract-7) | unchanged; `assertProposal` / `assertTestOutcome` / `assertSample` / `assertVerdict` still never run on a resumed session |

---

## Low

**L1. README and CLAUDE.md statements are stale after SG19–SG22.**
- README architecture: kept only if the tests "fail on at least one of up to 3 bug-injected mutants of the edit". The real rule is per site, plus deleted-token observation (SG18/SG22).
- README: "non-JS edits (runs=0) need every check passed". Since SG19 a Python edit with `runs = 0` is rejected like a JS one.
- README describes differential testing as JS-only ("oracle for JS function refactors", "when a JS proposal touches a callable"). The Python harness is not described.
- README `--resume` row: "marks proposals already committed on `refactor/<run_id>`". The branch may be `refactor-run/<run_id>` or `refactor-run-<run_id>`. The row also does not say that a lost branch stops the run with exit 2.
- CLAUDE.md coordination rules: resume "reconciles with the `refactor/<run_id>` branch" and "re-created from `refactor/<run_id>`". The code uses the recorded branch.

Repro: `node audit/15/docs-and-shapes.js` (L1).

**L2. `DiffTest.counterexample` has a different shape per producer, and Python vetoes name inputs badly.**
- JS keys: `[args, current, index, input, proposed, self, target, ti]`.
- Python keys: `[args, current, index, init, kwargs, proposed, run, target]`. Python `args` are reprs, so the veto reads `differs on input ["None"]`.
- A Python load-phase divergence has only `[current, phase, proposed]` and `function_name: ""`, so the veto reason reads `function differs on input n/a`.

`vetoReasons` reads `function_name` and `counterexample.args`, neither of which is in the contract. This extends AUDIT-7 L3 to the Python producer.

Repro: `docs-and-shapes.js` (L2).

**L3. When the worktree cannot be created for a filesystem reason, the CLI exits 1 with a stack trace.**
- `createWorktree` creates the worktrees dir (`worktree.js:127`) outside its `EWORKTREE` handling.
- An `EEXIST` or `ENOTDIR` there, or a permission error, ends as `fatal` with 10 stack frames and exit 1. README says "If no worktree can be created the run stops (exit 2)".
- The same applies to a dirty-sync failure on a fresh run: a plain `Error`, so exit 1. On resume the same failure is `EWORKTREE`, so exit 2.
- The target is untouched in all cases.

Repro: `node audit/15/cli-exit-codes.js` (b).

**Carried over, still reproducing at `d7c4bb5`:**

| finding | repro |
|---|---|
| AUDIT-10 L1: `passed_tests` / `failed_tests` are 0 for `node:test` | `audit/10/docs-and-shapes.js` |
| AUDIT-10 L2 (narrowed): SG20 split out `mutation_budget`, but `tests_insensitive` is still recorded when no mutant exists (a rename: 0 mutants, 0 runs, `unmutated_hunk_line`) and when `mutationEvidence` throws | `audit/10/docs-and-shapes.js`; `audit/15/docs-and-shapes.js` |
| AUDIT-10 L3: contracts lag the load-bearing fields (`Sample.edit_id`, `DiffTest.deletions_observed`, `Proposal.validated_region`, `TestOutcome.reason/coverage/mutation/commit`) | `audit/10/docs-and-shapes.js` |
| AUDIT-10 L4: partly fixed. CLAUDE.md now has the per-site and deletion rules and the README has exit 2. The README mutant sentence remains (L1); the audit/10 regex misses it. | `audit/15/docs-and-shapes.js` |
| AUDIT-7 L1–L6 | `audit/7/docs-and-shapes.js` |
| AUDIT-3 L-doc-1, L-cli-2, L-cli-3, L-doc-4, L-doc-5, L-doc-6, L-test-8, L-legacy-1, L-legacy-2, L-status-2–4, L-whatif-2, L7 (Reflexion step has no span) | `audit/3/docs-vs-code.js`, `resume-legacy-session.js`, `status-vocabulary.js`, `whatif-vs-gate.js`, `boundaries.js` |

**Open items from PLAN, confirmed but not counted:**
- Worktrees are never cleaned up.
- Reconciled proposals get a sample but no reward and no synthetic negatives.
- Synthetic negatives are re-scored against the target's file, not the worktree's validated region.

---

## Repro index (`audit/15/`)

| script | covers |
|---|---|
| `crash-after-commit-inflight.js` | H1 (real SIGKILL after the commit, then `--resume`) |
| `docs-and-shapes.js` | L1, L2, AUDIT-10 L2 (narrowed) |
| `cli-exit-codes.js` | SG21 recheck (a: exit 2 when both adds fail, target clean); L3 (b) |

M1–M8 and the carried-over Lows use the scripts in `audit/3/`, `audit/7/` and `audit/10/`.
