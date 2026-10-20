# AUDIT-10: Contract and API consistency, round 3

Audited commit `ada3a64` (after SG14–SG18 and AUDIT-8/AUDIT-9). The auditor did not write the code under audit. The audit compares every stage boundary against `src/contracts.js` and the "Interface contracts" section of `PLAN.md`, now including the fields SG14–SG18 added:
- `Proposal.validated_region`;
- `TestOutcome.mutation`, `coverage.functions` / `functions_missed` / `duration_ms`, and the reasons `tests_insensitive` / `coverage_timeout` / `edit_not_exercised` / `no_coverage_tool`;
- `DiffTest.deletions_observed`;
- `Sample.edit_id`;
- `EWORKTREE`.

It also compares the CLI, exit codes, env vars, `README.md` and `CLAUDE.md` with the code. Python differential testing (SG19, in progress) is out of scope. So are findings already in AUDIT-8 (validation soundness) and AUDIT-9 (performance), which are not repeated here.

All repros use the repo's stub client and a temp `REFACTOR_STATE_DIR` (`test/helpers/env.js`, through `audit/7/lib.js`). They use copies of the fixtures or throw-away repos in `os.tmpdir()`. They make no API calls and do not touch `state/`, `dashboard/`, `src/` or `test/`. Each script prints `FINDING` (with observed and expected) or `ok`, and exits 1 when it reproduces a finding. Run them from the repo root with `node audit/10/<script>.js`. Orchestrator log lines are left out of the outputs below. `npm test` at this commit: 359/359 pass.

## Summary

| severity | count |
|---|---|
| Critical | 1 |
| High | 0 |
| Medium | 9 (3 new, 1 carried over and wider, 5 carried over) |
| Low | 4 new (+ 6 carried over from AUDIT-7, + 10 from AUDIT-3) |

**C1.** The Critical finding is new. It is the fresh-run counterpart of AUDIT-7 H3, which SG17 fixed only for `--resume`. `createWorktree` still edits a git target **in place** whenever `git worktree add -b refactor/<run_id>` fails. A user branch named `refactor` is enough to cause that. The passing edit is then left in the user's checkout, and a save the user makes while the tests run is overwritten.

### Prior High findings (`audit/3`, `audit/7`, re-run at `ada3a64`)

| finding | script | now |
|---|---|---|
| AUDIT-3 H1: gate and fusion read non-contract fields | `audit/3/legacy-alias-dependence.js` | **fixed** (H1a, H1b ok) |
| AUDIT-3 H2: global `session.json` | `audit/3/resume-scope.js` (M-scope-1) | **fixed** |
| AUDIT-7 H1: samples keyed by `issue_id` | `audit/7/sample-identity.js` | **fixed**. Run 1 `reverted` and run 2 `passed`, both on `566fcac0…`, now keep 2 real samples `[0, 1]` and 2 calibration points. |
| AUDIT-7 H2: a red suite that never ran the edit is labelled | `audit/7/untested-failure-label.js` | **fixed**. The outcome is `reverted` `edit_not_exercised`: no sample, no point, no reward, 0 Reflexion calls. |
| AUDIT-7 H3: `--resume` edits a git target in place | `audit/7/resume-worktree-gone.js` | **fixed**. With the worktree dir deleted, it is re-created, the proposal is reconciled to `passed` from its commit, and the target stays clean. With the run branch removed, the run stops with `EWORKTREE` naming the branch, `session.worktree` is kept, nothing runs and the target stays clean. |

**Builders' edits to the `audit/7` scripts.** Two scripts changed after AUDIT-7, and neither change weakens its check.
- `sample-identity.js` (SG17, SG18): the snippet and the two edits changed, because the old run-1 edit is now `critic_rejected`. The check got stricter: it now also requires `executed === 2`, so a setup that stops reaching the executor can no longer pass trivially.
- `resume-worktree-gone.js` (SG17): it now also accepts stopping with an error. That path is held to a strict bar:
  - `err.code === 'EWORKTREE'`;
  - the message names the branch;
  - `session.worktree` is kept;
  - the proposal is unprocessed;
  - the target is clean.

  This is the outcome PLAN SG17 and AUDIT-7 H3 asked for.
- One caveat for `untested-failure-label.js`, which is unchanged: its suite command `node --test test/` is red under Node 22 because no test file is found. The scenario (a red suite that never ran the edit) still holds. `audit/10/red-baseline-label.js` covers a red suite that does run the edit.

**Other round-1 and round-2 rechecks.**
- `audit/3/boundaries.js` still passes every producer contract on five fixture runs. Its only violation is still AUDIT-3 L7: the Reflexion step has no span.
- Two new extras appear in its key listing:
  - `DiffTest.deletions_observed`;
  - `Proposal.validated_region`, still present.

### What holds

- **Untested outcomes are excluded consistently from learning.** `isLabeled` (`src/rl/collector.js:14-18`) excludes all four untested reasons. The executor produces exactly those four (`src/agents/executor.js:138-173`, `src/runner/test-runner.js:204-240`, `:411-436`), on the red branch too. The orchestrator (`src/orchestrator.js:229`), calibration (`executedPoints`) and the sample collector all use the same predicate.
- **Learning identity follows the edit.** `edit_id = issue_id:sha256(proposed_code)[:16]` is used in three places:
  - for samples (`sampleKey`);
  - for calibration points (`fitFromProposals`);
  - as the base of synthetic negatives (`…::mutation`).

  Legacy entries keep their `proposal_id` key.
- **Resume never edits a git target in place.** It re-creates a missing worktree or stops with `EWORKTREE` (CLI exit 2). `session.worktree` is not overwritten on failure. Reconciliation reads the last `issue_id:` trailer of `base..branch`.
- **The executor's hunks and the mutants' hunks match.** Both come from `changeHunks(before, edited, file)`, so mutant hunk indices match the executor's per-hunk kill rule (`executor.js:27-61`, `bug-injector.js:243-288`).
- **The gate still reads only contract fields** (`criticGate`, `unconfirmedBlock`, `diffScore`, `juryVotes`). Test files are rejected with the same `isTestFile` in the Analyzer and in `processProposal`.
- **Env vars match the docs:** `REFACTOR_STATE_DIR`, `REFACTOR_DASHBOARD_DIR` and `ANTHROPIC_API_KEY` are the only ones the code reads.

---

## Critical

### C1. A fresh run on a git target edits the user's checkout in place when `git worktree add` fails, and overwrites concurrent saves

**Affected code**
- `src/runner/worktree.js:114-118`: `createWorktree` turns **any** `git worktree add -b refactor/<run_id> <path> HEAD` failure into `{ mode: 'in-place', root: <target> }`.
- `src/orchestrator.js:391-404`: `setupWorkspace` accepts that result with only a warning and records it in `session.worktree`.
- The executor then applies, tests, mutates and reverts in the target's own working tree. `commitProposal` returns null in-place, so a passing edit stays uncommitted in the checkout.
- Contract: CLAUDE.md and README say "The target's working tree is never modified". In-place mode is only for a target that "is not a git repo (or has no commits)". SG17 closed this path for `--resume` only, and its Log row lists this case as open.

**Impact.** Ordinary situations make the add fail on a healthy git repo:
- a user branch named `refactor`, so no `refs/heads/refactor/*` ref can be created;
- a locked or stale worktree registration;
- a full disk;
- a ref-lock race.

The run then edits the user's checkout without asking. Every passing edit is left uncommitted in their working tree, mixed with their own uncommitted work. The branch, the per-edit commits and the reviewable diff that the docs promise do not exist.

Because the docs say the target is never touched, a user can reasonably keep working during a run. In that case their saves are lost:
- the mutant loop writes mutants into their file and then restores the edited content (`executor.js:50`, `:65`);
- a failing or interrupted edit restores the pre-edit snapshot (`restoreAll`).

Either write replaces whatever the user saved in between. A rerun or `--resume` takes the same path again, because `createWorktree` is retried with the same branch name.

**Repro:** `node audit/10/branch-namespace-in-place.js` (`js-basic`, plus `git branch refactor` and one uncommitted line in `src/math.js`).

Observed:
```
a) session.worktree={"mode":"in-place","reason":"git worktree add failed: … fatal: cannot lock ref 'refs/heads/refactor/fe771d7b-…': 'refs/heads/refactor' exists; …"}
a) outcomes: 03a39758:passed, d24ddf0a:vetoed; target git status: "M src/math.js"; src/math.js rewritten by the executor
FINDING  C1a a fresh run on a git target edits the target in place when `git worktree add` fails
b) mode=in-place; outcomes: 03a39758:passed, d24ddf0a:vetoed; user saved during the run: true; user's line in src/math.js after the run: false
FINDING  C1b in-place fallback overwrites a save the user makes while the run is in progress
```

**Expected:** a git target with commits is never edited in place. Either:
- stop with an error, as `resumeWorktree` does with `EWORKTREE`; or
- use a ref that cannot collide with a user branch, e.g. `refactor-<run_id>` or a ref under `refs/refactor/`.

Keep the in-place fallback strictly for non-git targets and targets with no commits, the two cases the docs name. A recorded `in-place` session on a git target should also not resume through `createWorktree`'s fallback (SG17 open item).

---

## Medium

### M1. Untested reverts, now including `tests_insensitive` and `coverage_timeout`, are failures for every diagnostic consumer (AUDIT-7 M2, open and wider)

**Affected code.** The consumers below still match `status === 'reverted'` and ignore `reason`:
- `dashboard.aggregateStats`, `reliability`, `agreementMatrix` and `rl_accuracy` (`src/interpretability/dashboard.js:40-120`)
- `probe.trainProbe` (`probe.js:24`)
- `clustering.clusterFailures` (`clustering.js:143`)
- `tracer.classifyFailure` (`tracer.js:101`)
- `summarizeRun` (`orchestrator.js:428-441`)

SG14 and SG16 added `tests_insensitive` and `coverage_timeout` to `UNTESTED_REASONS`.

**Impact.** SG18's Log row states that `tests_insensitive` is now a frequent outcome, for example on renames and reorders, since no operator mutates their tokens. So on most targets the dashboard's failure count, reliability diagram, ECE, agreement-grid false positives, probe and failure clusters are dominated by edits that no test judged. Meanwhile the gate's calibration excludes them.

**Repro:** `node audit/10/untested-reasons-consumers.js` (6 untested reverts with the new reasons, 6 passes, 1 real failure).

Observed:
```
labelled outcomes (isLabeled) = 7; calibration points = 7
dashboard: failed=7 pass_rate=0.46 rl_accuracy=0.46 (n=13); reliability n=13; agreement fp=7 tp=6
probe trained on untested reverts: true; clustered failures=7; classifyFailure(tests_insensitive)=logic_error; run summary failed=7
```

**Expected:** one outcome-class mapping (label 1 / label 0 / untested / not executed), exported next to `isLabeled` and used by every consumer. Untested reverts are shown with their reason.

### M2. A crash snapshot whose worktree is gone makes every later run on the target throw

**Affected code**
- `src/orchestrator.js:288` calls `FileSnapshot.restoreFromDisk(inflightPath(absRepo))` before anything else, and outside any `try`.
- `src/runner/reverter.js:88-101`: `restoreAll()` writes to `repo_root` (the run worktree) and throws `ENOENT` when that directory is gone. `inflight.json` is then never removed.

**Impact.** The snapshot is written for every edit (`executor.js:81`). Deleting a crashed run's worktree is exactly the situation SG17 now handles by re-creating the worktree on `--resume`. But here the run dies before the session or worktree is read:
- every run on that target stops with an `ENOENT` stack trace (CLI exit 1), with or without `--resume`, until the user finds and deletes `<state>/targets/<sha>/inflight.json`;
- the resume path SG17 built for this case is unreachable.

No file is lost: the snapshot belongs to a worktree that no longer exists.

**Repro:** `node audit/10/inflight-worktree-gone.js` (`js-basic`: a real run, then a crash snapshot for a pending proposal, then the worktree dir removed).

Observed:
```
resume=true: threw ENOENT: ENOENT: no such file or directory, open '…/worktrees/<run_id>/src/math.js'
resume=false: threw ENOENT: …
inflight.json still present: true
```

**Expected:** `restoreFromDisk` skips (and reports) a snapshot whose `repo_root` no longer exists, and removes it. Alternatively, resume re-creates the worktree first and then restores.

### M3. A suite that is red before the edit labels every exercised edit as a failed edit

**Affected code**
- The executor never runs the suite before the first edit.
- `executor.js:138-145`: `failed` with `coverage.exercised === true` becomes `reverted` with no reason.
- `isLabeled` (`collector.js:16-18`) treats that as label 0. The orchestrator then:
  - books a false-positive reward;
  - classifies the failure;
  - asks Reflexion for a repair (`orchestrator.js:234-270`).

**Impact.** AUDIT-7 H2 fixed the case of a red suite that never ran the edit. The pre-edit baseline it suggested was not added. On a target with one known-broken test, every edit the suite executes becomes:
- a label-0 sample and a y=0 calibration point;
- a −2 false-positive reward;
- a `logic_error`;
- a Reflexion call, which is a paid Claude call;

even when the edit preserves behaviour and its own tests pass. The edit is reverted, so this fails closed. But after 10 samples and 20 points, the learned gate is trained on these labels. `failed_tests` is also reported as 0 for this suite (L1).

**Repro:** `node audit/10/red-baseline-label.js` (`twice()` is tested and passes; one unrelated test fails with or without the edit).

Observed:
```
status=reverted reason=(none) coverage={"available":true,"tool":"v8","exercised":true,…,"functions":1,"functions_missed":0,…} failed_tests=0
isLabeled=true samples=[0] calibration_points=[0] reward_fp=-2 failure_class=logic_error reflexion_calls=1
```

**Expected:** a baseline run per run in the worktree, before the first edit. Failures that also occur without the edit are not a label. For example, use `reverted` with reason `baseline_red`, add it to `UNTESTED_REASONS`, and request no repair.

### M4. The commit bar reads `DiffTest.deletions_observed`, which the DiffTest contract does not have

**Affected code**
- `src/agents/executor.js:31-35`: a deletion-only change hunk is kept only when `diffTest.verdict === 'equivalent' && diffTest.deletions_observed === true`.
- `DiffTest` in `src/contracts.js` and in PLAN "Interface contracts" is `{ applicable, verdict, runs, counterexample?, reason?, duration_ms }`. `assertDiffTest` does not know the field.
- `diff-testing.js:1151-1152` sets it only when the snippet has deleted statements.

**Impact.** Two DiffTests that are equally valid under the contract give opposite commit decisions for the same edit and suite. Today this fails closed, because the only producer sets the field. But a contract-conforming producer would make every deletion-only edit `tests_insensitive` without any error. One such producer is SG19's Python diff test, which is being written against the contract now. This is the AUDIT-3 H1 pattern (a gate decision that depends on a non-contract field), which is why it is listed. It is Medium because it cannot commit an unsafe edit.

**Repro:** `node audit/10/deletion-evidence-contract.js` (removing a dead `const unused = x * 2;` from a tested function).

Observed:
```
producer (diff-testing.run): verdict=equivalent runs=51 deletions_observed=true
contract-only DiffTest:            reverted tests_insensitive (edit kept: false)
same + deletions_observed: true:   passed (edit kept: true)
```

**Expected:** `deletions_observed` (boolean, present when the snippet deletes statements) is added to the DiffTest contract, `assertDiffTest` and PLAN, so that SG19 must produce it. Alternatively, the executor derives the decision from contract fields only.

### M5–M9. Carried over, still reproducing at `ada3a64`

| here | was | repro | still observed |
|---|---|---|---|
| M5 | AUDIT-7 M1: infrastructure failures are final verdicts | `audit/7/transient-failure-final.js` | a critic outage → `vetoed` (unanimous malformed), 0 critic calls on `--resume`; validator throw → `critic_rejected` |
| M6 | AUDIT-3 M2 / AUDIT-7 M3: `--resume` after `--dry-run` executes nothing | `audit/3/resume-scope.js` (M-scope-2) | `[dry_run, vetoed]`, 0 commits |
| M7 | AUDIT-3 M3 / AUDIT-7 M4: status vocabulary | `audit/3/status-vocabulary.js` | `timeout`: no label, but scored by reward, clustering and the dashboard as a failure |
| M8 | AUDIT-3 M4 / AUDIT-7 M5: what-if models only the classifier | `audit/3/whatif-vs-gate.js` | the gate takes `p_pass` from calibration; the what-if shows the classifier |
| M9 | AUDIT-3 M5 / AUDIT-7 M6: `assertProposal`, `assertVerdict`, `assertSample`, `assertTestOutcome` never run in `src/` | `audit/3/docs-vs-code.js` (M-contract-7) | unchanged; the new fields above are unchecked at every boundary, including sessions loaded on `--resume` |

---

## Low

**L1. `passed_tests` and `failed_tests` are 0 for `node:test`.**
- `parseCounts` (`src/runner/test-runner.js:35-60`) reads Jest, Mocha and pytest summaries, but not the TAP `# pass N` / `# fail N` that `node --test` prints. `node --test` is what the fixtures and many Node repos use.
- The wrong counts reach `TestOutcome`, the dashboard and the Reflexion prompt (`failed_tests: 0` for a red suite).
- Repro: `node audit/10/docs-and-shapes.js` (L1).

**L2. `tests_insensitive` is also recorded when nothing was tested.**
- `executor.js:166-173` maps every `!mutation.ok` to `tests_insensitive`, including three cases where no mutant ran:
  - no operator mutates a hunk (`unmutated_hunk_line`, e.g. a rename: 0 mutants, 0 runs);
  - the budget ran out (`budget_exhausted`);
  - `mutationEvidence` threw (`error`).
- The outcome is still untested, so learning is unaffected. But the reason claims a property of the suite that was never measured, and the dashboard cannot separate the cases. AUDIT-9 asked for `mutation_budget` (SG20).
- Repro: `docs-and-shapes.js` (L2).

**L3. The contracts lag the fields SG14–SG18 made load-bearing:**
- `Sample.edit_id` (the de-duplication key; documented in CLAUDE.md, absent from `SHAPES` and `assertSample`);
- `DiffTest.deletions_observed` (M4);
- `Proposal.validated_region` (AUDIT-7 L6);
- `TestOutcome`, which is still `{status, ...}`: `reason` (read by `isLabeled`), `coverage{…functions, functions_missed, duration_ms}`, `mutation{hunks, mutants, run, killed, ok, …}` and `commit` have no shape;
- CLAUDE.md's Proposal shape, which lists none of them.

Repro: `docs-and-shapes.js` (L3).

**L4. The commit-bar and exit-code docs are stale after SG17 and SG18.**
- CLAUDE.md "Executor isolation" still says mutants fall back to "the edited lines". SG18 removed that fallback: each change hunk needs its own killed mutant.
- CLAUDE.md says nothing about deletion-only hunks.
- README still says "at least one of up to 3 … mutants of the edit".
- README does not document exit codes:
  - 2 for a missing target or `EWORKTREE`;
  - 1 for fatal errors;
  - 0 for done or SIGINT/SIGTERM.

  Its `--resume` row does not say that a lost run branch stops the run.

Repro: `docs-and-shapes.js` (L4).

**Carried over, still reproducing at `ada3a64`:**

| finding | repro |
|---|---|
| AUDIT-7 L1 one target, two state dirs (symlinked `--repo`) | `audit/7/docs-and-shapes.js` |
| AUDIT-7 L2 a run without `--resume` silently discards the unfinished session | `audit/7/docs-and-shapes.js` |
| AUDIT-7 L3 three `counterexample` shapes; veto text reads `args` / `function_name` | `audit/7/docs-and-shapes.js` |
| AUDIT-7 L4 `TestOutcome.reason` vocabulary undefined (now 4 untested codes + prose) | `audit/7/docs-and-shapes.js` |
| AUDIT-7 L5 `agreement.unanimous` vs `juryVotes().unanimous` | `audit/7/docs-and-shapes.js` |
| AUDIT-7 L6 docs and help after SG9–SG13: 7 of the 8 items remain. The `.refactor-coverage` item is fixed. | `audit/7/docs-and-shapes.js` |
| AUDIT-3 L1–L4, L5, L6, L7, L8, L9, L11 | `audit/3/status-vocabulary.js`, `whatif-vs-gate.js`, `docs-vs-code.js`, `boundaries.js`, `resume-legacy-session.js`, `dead-exports.js` |

**Open items from PLAN, confirmed but not counted:**
- Reconciled proposals get a sample but no reward and no synthetic negatives.
- Worktrees are never cleaned up.
- Synthetic negatives are re-scored against `current_code`, not `validated_region`.
- A recorded in-place session on a git target resumes through `createWorktree`. C1 is the general form of this item.

---

## Repro index (`audit/10/`)

| script | covers |
|---|---|
| `branch-namespace-in-place.js` | C1 (a: edit left in the user's checkout; b: concurrent save overwritten) |
| `untested-reasons-consumers.js` | M1 |
| `inflight-worktree-gone.js` | M2 |
| `red-baseline-label.js` | M3 |
| `deletion-evidence-contract.js` | M4 |
| `docs-and-shapes.js` | L1–L4 |
| `lib.js` | shared harness (re-exports `audit/7/lib.js`) |

M5–M9 and the carried-over Lows use the round-1 and round-2 scripts in `audit/3/` and `audit/7/`.
