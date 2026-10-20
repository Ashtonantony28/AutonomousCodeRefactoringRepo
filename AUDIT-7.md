# AUDIT-7: Contract and API consistency, round 2

Audited commit `a784ce2` (after SG9–SG13 and AUDIT-5). The auditor did not write the code under audit. The audit compares every stage boundary against `src/contracts.js` and the "Interface contracts" section of `PLAN.md`, now including the fields SG9–SG13 added. It also compares the CLI, `README.md` and `CLAUDE.md` with the code. Findings already in `AUDIT-5.md` (validation soundness) are out of scope and not repeated.

All repros use the repo's stub client and a temp `REFACTOR_STATE_DIR` (`test/helpers/env.js`, through `audit/3/lib.js`). They use copies of the fixtures or throw-away repos in `os.tmpdir()`. They make no API calls and do not touch `state/`, `dashboard/`, `src/` or `test/`. Each script prints `FINDING` (with observed and expected) or `ok`, and exits 1 when it reproduces a finding. Run them from the repo root with `node audit/7/<script>.js`. Orchestrator log lines are left out of the outputs below. `npm test` at this commit: 280/280 pass.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 6 (2 new, 4 carried over from AUDIT-3) |
| Low | 6 new (+ 9 carried over from AUDIT-3) |

The three High findings are new, and all three sit in code SG12 and SG13 added or now depend on:

- **H1.** Learning state is keyed by `issue_id`, which identifies the snippet, not the edit. A later run overwrites the label an earlier run recorded for a different edit of the same snippet.
- **H2.** The rule "an edit no test executed is not a label" covers only green suites. A red suite that never ran the edit becomes a label-0 sample, a calibration point, a false-positive reward and a Reflexion repair.
- **H3.** `--resume` with a run worktree that cannot be re-attached falls back to editing the git target **in place**. It also overwrites the branch record that reconciliation needs, so a proposal already committed is run again on the user's working tree.

### Round-1 recheck (`audit/3/*`, re-run at `a784ce2`)

| AUDIT-3 finding | script | now |
|---|---|---|
| H1 gate and fusion read non-contract fields | `legacy-alias-dependence.js` | **fixed** (H1a, H1b ok: contract-only JuryVerdict/DiffTest give `dry_run`, combined 0.975) |
| H2 global `session.json` | `resume-scope.js` (M-scope-1) | **fixed** (same `run_id` on resume, 0 Analyzer calls, one branch) |
| M1 crash after commit | `resume-after-commit-crash.js` | **fixed** (reconciled to `passed` from the branch, no repair, 1 commit) |
| M2 `--resume` after `--dry-run` executes nothing | `resume-scope.js` (M-scope-2) | open → M3 below |
| M3 status vocabulary | `status-vocabulary.js` | open → M4 below (now also `reason`, see M2) |
| M4 what-if models only the classifier | `whatif-vs-gate.js` | open → M5 below |
| M5 four contract asserts never run in `src/` | `docs-vs-code.js` (M-contract-7) | open → M6 below |
| L1–L4, L5, L6, L7, L8, L9, L11 | `status-vocabulary.js`, `whatif-vs-gate.js`, `docs-vs-code.js`, `boundaries.js`, `resume-legacy-session.js`, `dead-exports.js` | all still reproduce (carried over) |

`audit/3/boundaries.js` still passes every producer contract on five fixture runs. Its only violation is still AUDIT-3 L7: the Reflexion step has no span.

### What holds

- **Every producer output still satisfies its contract** (`node audit/3/boundaries.js`): analyzer and reflexion → `Proposal`, critic → `JuryVerdict`/`Verdict`, AST → `CheckResult`, diff test → `DiffTest`, executor → `TestOutcome`, collector and bug-injector → `Sample`, plus the persisted session, samples and spans.
- **The gate reads only contract fields.**
  - `criticGate` (`src/orchestrator.js:66`) derives majority and unanimity from `panel[]` via `juryVotes`, and reads `p_preserves`.
  - `unconfirmedBlock` and fusion read `applicable`, `verdict` and `runs` (`src/validation/hybrid-validator.js:48`, `:137`).
  - `reward.stageSignals` reads `verdict`.
  - Stripping the legacy aliases changes no decision.
- **The session is per target**: `sessionPath(target)` sits under `stateDirFor`. The legacy file moves only for its own target. The `--serve` server is pinned to the run's target.
- **Crash after commit is reconciled.** `reconcileWithBranch` reads `issue_id:` trailers from `base..branch` (the last trailer wins over free-text reasoning). It marks the proposal `passed` with its commit and collects its sample without re-running it, as long as the worktree record is intact (H3 is the case where it is not).
- **The validated region is the applied region.** `regionView` stores `validated_region`, and the executor passes `validated_region.text` as `expectedRegion`. A mismatch is `apply_failed` with tier `region`. A resumed proposal is validated again, because `regionView` deletes and recomputes the stored region.
- **Untested reverts on a green suite are excluded** from samples, calibration, reward and repair (`isLabeled`, `src/orchestrator.js:207`), consistently in the collector, calibration and orchestrator.
- **The new extras do not leak into gate decisions.** `function_name`, `arity`, `mode`, `score`, `mismatches` and `counterexample.args` are read only for trace and veto text. `validated_region` is read only by the executor.

New fields seen beyond the contract shapes since round 1:

- **Proposal:** `validated_region {tier,start,end,text}`
- **TestOutcome:**
  - `coverage {available,tool,exercised,edited_lines,executed_lines,lines_pct,reason?,detail?}`
  - `reason` on `reverted` and on reconciled `passed`
  - `commit`, `tier`/`detail` on `apply_failed`
  - `reasons[]` on `vetoed`
- **DiffTest:** `counterexample` in three shapes (`{phase:'load',proposed}`, `{phase:'resolve',target,proposed}`, `{target,ti,index,input,self,current,proposed,args}`).

---

## High

### H1. Samples and calibration points are keyed by `issue_id`, so a later run overwrites the label of an earlier, different edit of the same snippet

**Affected code**
- `issue_id = sha256(file + '\0' + current_code)[:16]`, unique only within one session (`src/agents/analyzer.js:31`, CLAUDE.md "Proposal shape").
- `collector.sampleKey` is `proposal_id|real|` (`src/rl/collector.js:40`). `appendSamples` replaces an existing sample with the same key (`:62-72`).
- `calibration.fitFromProposals` merges points by `proposal_id` (`src/rl/calibration.js:153-154`).
- Synthetic negatives are keyed `${issue_id}::${mutation}`, so they too outlive or replace their parent's sample.

**Impact.** CLAUDE.md says samples and calibration points "accumulate across runs (de-duplicated by proposal id / mutant); training always uses all of them". The proposal id names the code being replaced, not the replacement, so two different edits of the same snippet are one sample:
- The later run silently replaces the earlier label and features.
- A failing edit is reverted, and the target is never modified in any case. Its snippet therefore stays and is proposed again whenever the prompt or model output differs: after a merge, with `--cache off`, or as a different completion. The labels lost this way are mostly the negatives the gate most needs.
- The same happens to the calibration set the gate's `min(classifier, calibrated)` uses.

This is loss of learning state that changes later gate decisions.

**Repro:** `node audit/7/sample-identity.js` (two fresh runs on `js-failing-after-edit`, `--cache off`).

Observed:
```
run 1: fba883f52be5df0a -> reverted; real samples [["fba883f52be5df0a",0]]; calibration points 1
run 2: fba883f52be5df0a -> passed;   real samples [["fba883f52be5df0a",1]]; calibration points [["fba883f52be5df0a",1]]
FINDING  H1 … rl-samples.json keeps 1 real sample (label 1) and calibration-points.json 1 point; the run-1 label is gone
```

**Expected:** 2 real samples and 2 calibration points. Key both by the edit, e.g. `sha256(file, current_code, proposed_code)`, or by `run_id + issue_id`. Keep `issue_id` for commit trailers and replay.

### H2. A red suite that never executed the edit is labelled as a failed edit

**Affected code**
- `src/agents/executor.js:72-75`: `failed` → `reverted` with no `reason`. Only the green branch (`:83-88`) turns `coverage.exercised === false` into `reason: 'edit_not_exercised'`.
- `src/runner/test-runner.js:282-297` computes `coverage` for failing runs too. The outcome carries `coverage.exercised=false, reason:'edit_not_exercised'`.
- `collector.isLabeled` (`src/rl/collector.js:12-16`) reads only `test_outcome.reason`. The orchestrator then collects the sample, computes the reward (false positive) and requests a Reflexion repair (`src/orchestrator.js:207-247`).

**Impact.** SG12's rule is "a green suite that never ran the edit says nothing about it". A red suite that never ran it says just as little. A pre-existing failure, a flaky test or a broken unrelated test makes **every** proposal on that target:
- a label-0 sample;
- a y=0 calibration point;
- a `-2` false-positive reward;
- a `logic_error` failure class;
- a Reflexion call that spends a Claude call on a repair of an edit no test touched.

After 10 samples and 20 points the learned gate is trained on these labels. The status `reverted` and the field that decides labelling now disagree with the outcome's own coverage evidence.

**Repro:** `node audit/7/untested-failure-label.js` (a repo whose suite has one red test and never loads the edited file; a behaviour-preserving edit).

Observed:
```
status=reverted reason=(none) coverage={"exercised":false,"reason":"edit_not_exercised","detail":"file never loaded by the tests"}
isLabeled=true samples=[0] calibration_points=[0] reward_fp=-2 failure_class=logic_error reflexion_calls=1
```

**Expected:** whenever no test executed the edit, pass or fail, the outcome is untested. Either the executor sets `reason: 'edit_not_exercised'` on the red branch too, or `isLabeled` reads `coverage.exercised`. Such an outcome produces no sample, no calibration point, no reward and no repair. A baseline test run before the first edit would also separate pre-existing failures.

### H3. `--resume` without a re-attachable worktree edits the git target in place and loses the branch record

**Affected code**
- `src/runner/worktree.js:113-121`: `resumeWorktree` runs `git worktree add <path> <branch>`. On any failure it returns `{ mode: 'in-place', root: <target> }`.
- `src/orchestrator.js:359-373`: `setupWorkspace` accepts that result (it logs only a warning) and overwrites `session.worktree` with it.
- `src/orchestrator.js:277`: `reconcileWithBranch` then reads the replaced record. `committedIssues` (`worktree.js:143`) returns an empty map for a non-worktree record.
- CLAUDE.md "Executor isolation": "The target's working tree is never modified". The in-place fallback is only for "not a git repo (or has no commits)".

**Impact.** Two ordinary actions lead here:
- Deleting the state dir's `worktrees/` (or the whole state dir) without `git worktree prune`. Git then refuses to re-add the "missing but already registered" worktree.
- Removing the `refactor/<run_id>` branch.

On the next `--resume`:
1. Every pending proposal is validated, applied and tested **in the user's working tree**. Passing edits are left there uncommitted (`commitProposal` returns null in-place), mixed with any uncommitted user work.
2. The `refactor/<run_id>` record is replaced, so the run's branch and base are no longer in the session.
3. A proposal that was already committed on that branch (crash after commit, AUDIT-3 M1) is no longer reconciled. It is executed a second time, now on the target.

No edit is committed and no file was lost in the repro, which is why this is High and not Critical. But the isolation invariant that SG5 and SG13 rest on silently stops holding, and the run state is corrupted.

**Repro:** `node audit/7/resume-worktree-gone.js` (`js-basic`: a real run, then the AUDIT-3 M1 crash state, then each break, then `--resume`).

Observed:
```
[worktree dir deleted] resumed session.worktree={"mode":"in-place","reason":"worktree …/worktrees/5bd5193d-… is gone and could not be re-added"}
[worktree dir deleted] resumed outcome: passed commit=- reason=-; target git status: "M src/math.js"
FINDING  H3 [worktree dir deleted] … 03a39758265507f1 re-executed -> passed (no commit); target working tree now modified: M src/math.js
[run branch removed]   … the same: in-place, re-executed, target "M src/math.js"
```

**Expected:** resume re-creates the worktree, or stops with an error naming the branch, and never edits a git target in place:
- re-create with `git worktree prune`, then add it again;
- or create a new worktree on the recorded branch;
- or, when the branch is gone, use a new branch from `base`.

`session.worktree` keeps the branch record until reconciliation has read it.

**Suspected (not run).** While tests run in place, the user may be editing the same file. A failing or interrupted edit restores the pre-edit snapshot over it, so that concurrent user work would be lost.

---

## Medium

### M1. Infrastructure failures are recorded as verdicts on the edit and never retried

**Affected code**
- A critic call that throws (after the client's retry) becomes `malformedVerdict` (`src/agents/critic.js:64`, `:104-122`).
- Three malformed verdicts are a unanimous reject, so `vetoReasons` returns `unanimous_reject` (`src/validation/hybrid-validator.js:62-78`) and the status is `vetoed`.
- A validator exception sets `combined_confidence = 0`, giving `critic_rejected` (`src/orchestrator.js:120-126`, `:141-152`).
- `--resume` processes only proposals with no `test_outcome` (`:320-321`).
- The contract has `error` for this case, and the executor already uses it (`:194`).

**Impact.** An API outage or a transient file error turns every affected proposal into a permanent `vetoed` or `critic_rejected`:
- indistinguishable from a real rejection in the run summary, the dashboard and the agreement grid;
- never retried by `--resume`.

This fails closed, so no unsafe edit results. But the resume decision and the reported verdict are wrong.

**Repro:** `node audit/7/transient-failure-final.js`

Observed:
```
a) outage run: 03a39758:vetoed, d24ddf0a:vetoed (unanimous_reject: strict(malformed), permissive(malformed), security(malformed) …)
a) --resume with the critic back: 03a39758:vetoed, d24ddf0a:vetoed; critic calls on resume: 0
b) validator threw: status=critic_rejected reason=combined_confidence < 0.5
```

**Expected:** `status: 'error'` (with the cause) when every verdict is malformed or the validator throws, and `--resume` retries `error` outcomes.

### M2. Untested reverts are learning-excluded but counted as failures by every diagnostic consumer

**Affected code:** these consumers match `status === 'reverted'` and ignore `reason`:
- `dashboard.aggregateStats`, `reliability`, `knownOutcome`/`agreementMatrix` and `rl_accuracy` (`src/interpretability/dashboard.js:49-120`)
- `probe.trainProbe` (`src/interpretability/probe.js:24`)
- `clustering.clusterFailures` (`src/interpretability/clustering.js:143`)
- `tracer.classifyFailure` (`src/interpretability/tracer.js:101`)
- `summarizeRun` (`src/orchestrator.js:401`)

`collector.isLabeled` excludes the same outcomes.

**Impact.** The diagnostics describe a different data set from the one the gate learns from:
- The reliability diagram and ECE on the dashboard are computed over all reverts. The isotonic calibration the gate uses excludes the untested ones.
- The agreement grid counts every untested revert as a critic false positive.
- The `done.` line reports them as `failed`.

On targets with sparse tests, where untested reverts dominate, the dashboard is misleading. PLAN's SG12 log lists this as open. It is the `reason` side of AUDIT-3 M3.

**Repro:** `node audit/7/untested-revert-consumers.js` (6 untested reverts, 6 passes, 1 real failure).

Observed:
```
labelled outcomes (isLabeled) = 7; calibration points = 7
dashboard: failed=7 pass_rate=0.46 rl_accuracy=0.46 (n=13); reliability n=13; agreement fp=7 tp=6
probe trained on untested reverts: true; clustered failures=7; classifyFailure(untested revert)=logic_error; run summary failed=7
```

**Expected:** a single status-and-reason mapping (`isLabeled` plus an "untested" class) shared by every consumer, with untested reverts shown as such.

### M3. `--resume` after `--dry-run` still executes nothing (AUDIT-3 M2, open)

**Repro:** `node audit/3/resume-scope.js` (M-scope-2).

- **Observed:** a non-dry `--resume` leaves `[dry_run, vetoed]` with 0 commits, and still creates a worktree and branch.
- **Expected:** `dry_run` is treated as "validated, not executed", or the CLI refuses with a message.

### M4. `TestOutcome.status` has no single meaning across consumers (AUDIT-3 M3, open)

**Repro:** `node audit/3/status-vocabulary.js`.

The table is unchanged. For example, `timeout` gives:
- no label;
- `reward_pcorrect = 1 - c`;
- `cluster = fail`;
- dashboard `row-fail`;
- not counted in the run summary.

M2 above adds `reason` to the same problem.

### M5. The "What-if · RL gate" panel and `counterfactual.js` model only the classifier term (AUDIT-3 M4, open)

**Repro:** `node audit/3/whatif-vs-gate.js`.

- **Observed:** the gate gives `p_pass = 0.050` from calibration, and the status is `rl_rejected`. The what-if shows `0.881` in green.

### M6. `assertProposal`, `assertVerdict`, `assertTestOutcome` and `assertSample` still never run in `src/` (AUDIT-3 M5, open)

**Repro:** `node audit/3/docs-vs-code.js` (M-contract-7).

**Why it matters more now:** the new fields that decisions depend on are unchecked at every boundary:
- `validated_region`, which the executor requires;
- `test_outcome.reason`, which `isLabeled` reads;
- `coverage`.

Sessions loaded on `--resume` are not asserted either.

---

## Low

**L1. One target can have two state dirs.**
- `stateDirFor` hashes `path.resolve(repo)` (`src/utils/checkpoint.js:14-17`), but `createWorktree` uses `fs.realpathSync`.
- A symlinked or differently spelled `--repo` therefore gets a separate session, `inflight.json`, samples and calibration.
- A crash snapshot written under one spelling is not restored under the other. In the non-git in-place mode, that leaves a half-applied edit in the target.
- Repro: `node audit/7/docs-and-shapes.js` (L1).

**L2. A run without `--resume` discards the target's unfinished session silently.** This includes `--dry-run`.
- `loadOrInit` writes a fresh session over one that still has unprocessed proposals and a `worktree` record (`checkpoint.js:109-115`).
- The old branch is orphaned and the pending proposals are lost, with no warning.
- The behaviour is documented, but now it is per target, so this is the target's own resumable state.
- Repro: `docs-and-shapes.js` (L2).

**L3. `DiffTest.counterexample` is not contracted and has three shapes.**
- Load-phase and resolve-phase counterexamples have no `args`.
- So a `divergent` veto reads `diff_test_divergent: f differs on input n/a`.
- `vetoReasons` and the diff-test trace also read the legacy `function_name` (`hybrid-validator.js:65`, `:157`).
- Repro: `docs-and-shapes.js` (L3).

**L4. `TestOutcome.reason` has no defined vocabulary.**
- On `reverted` it is a machine code that `isLabeled` matches.
- On a reconciled `passed`, and on `apply_failed`, `timeout` and `critic_rejected`, it is prose.
- `vetoed` uses `reasons[]` instead.
- The contract is `{status, ...}`, so `assertTestOutcome` cannot check any of it, and H2 is a direct result.
- Repro: `docs-and-shapes.js` (L4).

**L5. `JuryVerdict.agreement.unanimous` means "all personas agree".** It is `true` for a 3/3 reject (`src/agents/critic.js:147`). `juryVotes().unanimous`, which the gate uses, means "all approve". The hybrid trace (`unanimous=true` on a unanimous reject) and `reward.disagreementPenalty` use the former. Repro: `docs-and-shapes.js` (L5).

**L6. Docs and help are stale after SG9–SG13.** Repro: `docs-and-shapes.js` (L6) lists 8 items:
- `--help` still says `resume from existing state/session.json`.
- CLAUDE.md still names the `.refactor-coverage` output in the worktree; SG12 uses a temp dir.
- README still says the diff test uses `fast-check` inputs in `vm` contexts. `fast-check` is never required, and the sandbox is a worker thread.
- `@babel/traverse` is unused.
- `engines.node` is `>=18`, while PLAN requires Node ≥ 22.
- The CLAUDE.md session schema has no `worktree` key.
- `validated_region` is in neither the Proposal contract nor CLAUDE.md, although the executor requires it.
- CLAUDE.md's Proposal shape omits `diff_test` and `veto`.

**Carried over from AUDIT-3, still reproducing at `a784ce2`:**

| AUDIT-3 | repro |
|---|---|
| L1 dead statuses (`failed` x12, `applied_no_tests` x2) | `status-vocabulary.js` |
| L2 the run summary drops statuses | `status-vocabulary.js` |
| L3 no dashboard style for `vetoed`, `skipped_no_tests`, `error` | `status-vocabulary.js` |
| L4 `counterfactual.js` has no caller; dead exports | `whatif-vs-gate.js`, `dead-exports.js` |
| L5 CLAUDE.md CLI is incomplete | `docs-vs-code.js` |
| L6 `--cache bogus` stack trace; `--port abc` becomes 4173 | `docs-vs-code.js` |
| L7 the Reflexion step has no span | `boundaries.js` |
| L8 the e2e sample assert is vacuous | `docs-vs-code.js` |
| L9 tier order, the 70 % warning and calibration bins in docs | `docs-vs-code.js` |
| L11 legacy session resume | `resume-legacy-session.js` |

**Open items from PLAN, confirmed but not counted:**
- Reconciled proposals get a sample but no reward and no synthetic negatives.
- Worktrees are never cleaned up.
- Synthetic negatives are re-scored against `current_code`, not `validated_region`, when the anchor matched at a non-exact tier.

---

## Repro index (`audit/7/`)

| script | covers |
|---|---|
| `sample-identity.js` | H1 |
| `untested-failure-label.js` | H2 |
| `resume-worktree-gone.js` | H3 (deleted worktree dir; removed run branch) |
| `transient-failure-final.js` | M1 (critic outage; validator exception) |
| `untested-revert-consumers.js` | M2 |
| `docs-and-shapes.js` | L1–L6 |
| `lib.js` | shared harness (AUDIT-3 harness + stub-backed `runWith`, `proposals`) |

M3–M6 and the carried-over Lows use the round-1 scripts in `audit/3/` (see the recheck table).
