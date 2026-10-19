# AUDIT-3: Contract and API consistency

Audited commit `a50ffc6`. The audit compares every stage boundary against `src/contracts.js` and the "Interface contracts" section of `PLAN.md`. It also compares the CLI and the claims in `README.md`, `CLAUDE.md` and `PLAN.md` with the code. Findings already in `AUDIT-1.md` are not repeated.

All repros use the repo's stub client, its temp state dir (`test/helpers/env.js`) and copies of the fixtures. They make no API calls and do not touch `state/`, `dashboard/` or `src/`. Each script prints `FINDING` (with observed and expected) or `ok`, and exits 1 when it reproduces a finding.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 5 |
| Low | 12 (+3 suspected) |

### What holds

`node audit/3/boundaries.js` runs the real `runPipeline` in non-dry mode, using git worktrees, on five fixture runs: `js-basic`, `js-failing-after-edit`, `js-failing-after-edit` with a passing Reflexion repair, `no-tests` and `py-basic`. It wraps each producer before the orchestrator binds it and asserts the matching contract on every object:

- analyzer → `Proposal`
- critic → `JuryVerdict` and each `Verdict`
- ast → `CheckResult`
- diff-testing → `DiffTest`
- executor → `TestOutcome`
- reflexion → `Proposal`
- collector and bug-injector → `Sample`
- the final `session.proposals[]`, `session.rl_samples[]` and the per-target `rl-samples.json`
- the `session.json` keys listed in CLAUDE.md
- every span in `runs/<run_id>/spans.ndjson`: `trace_id` equals `run_id`, `parent_id` resolves, and `start <= end`

**Every producer output satisfies its contract.** The only violation is L7: a trace step with no span.

The problems are on the consumer side. Consumers read fields the contracts do not define. They disagree on what each status means. And run state is split between global and per-target paths.

Fields seen beyond the contract shapes (output of `boundaries.js`):

- **Proposal:** `run_id`, `confidence_weights`, `reward`, `reward_breakdown`, `failure_class`, plus `rl_prediction` when the gate fired.
- **JuryVerdict:** `proposal_id`, `persona`, `claude_confidence`, `preserves_semantics`, `edge_cases`, `hallucination_flags`, `reasoning`.
- **DiffTest:** `compared`, `function_name`, `arity`, `mode`, `score`, `mismatches`.
- **session.json:** `worktree`, which is missing from the CLAUDE.md schema.

---

## High

### H1. The gate and the score fusion depend on fields outside the JuryVerdict and DiffTest contracts

**Affected code**
- `src/orchestrator.js:96`: `criticOk` requires `jury.preserves_semantics === true`. That field is not in `JuryVerdict` (`src/contracts.js:16`, `PLAN.md` "Interface contracts"). It exists only as a "legacy alias" that `aggregateJury` adds (`src/agents/critic.js:130-152`).
- `src/validation/hybrid-validator.js:90`: `combined += DT_WEIGHT * dt.score`. `score` is not in `DiffTest`. It is a "legacy field for hybrid-validator.js" (`src/validation/diff-testing.js:14`, `:272`). `reward.stageSignals` (`src/rl/reward.js:45`) reads it too.
- Other consumers that read jury aliases outside the contract:
  - `tracer.classifyFailure` reads `critic_verdict.edge_cases` (`src/interpretability/tracer.js:104`).
  - `probe.probeFeatures` reads `reasoning`, `edge_cases` and `hallucination_flags` (`src/interpretability/probe.js:15-17`).
  - `clustering.docOfProposal` reads `reasoning` (`src/interpretability/clustering.js:139`).
  - `dashboard.criticConfidence` falls back to `claude_confidence` (`src/interpretability/dashboard.js:33-36`).
- `rl_prediction` and `failure_class` are read by the dashboard and by `classifyFailure`, but `Proposal` does not list them.

**Impact.** The field that decides the critic half of the gate is not part of the interface the project treats as authoritative. Tests and the hybrid validator assert the contract, so those checks cannot catch a regression here. A producer that emits exactly the contract shape passes `assertJuryVerdict` and `assertDiffTest`, yet:

- every proposal is `critic_rejected`;
- `combined_confidence` becomes `NaN`, which is serialised as `null` in `session.json`.

Today `aggregateJury` always adds the aliases, so the pipeline works by coincidence. PLAN.md's rule ("a fix that needs an SG0 contract changed stops and is reported; no silent workarounds") was bypassed. The fault fails closed (it rejects rather than approves), which is why this is High and not Critical.

**Repro:** `node audit/3/legacy-alias-dependence.js`

| case | observed | expected |
|---|---|---|
| baseline (real producers) | `dry_run`, combined 0.975 | |
| JuryVerdict stripped to the contract fields (3/3 approve, p 0.95), `assertJuryVerdict` ok | `critic_rejected: critic jury does not approve (majority preserves_semantics=false, p_preserves=0.95 …)` | `dry_run` |
| DiffTest stripped to the contract fields (`equivalent`), `assertDiffTest` ok | `combined_confidence=NaN`, `critic_rejected` | combined 0.975, `dry_run` |

**Fix direction:**
1. Derive the majority from `panel[]` and the diff score from `verdict`.
2. Or add `preserves_semantics` (majority) and `score` to the contracts and their asserts.
3. Then drop `claude_confidence` and the merged `reasoning` / `edge_cases` aliases, or contract them too.

### H2. `session.json` is global, while all other run state is per target: a run on another repo discards the resumable session

**Affected code**
- `src/utils/checkpoint.js:14-16`: `sessionPath()` is `<state>/session.json`, with no target key.
- `src/utils/checkpoint.js:73-82`: `loadOrInit` writes a fresh session whenever `--resume` is off, or when the stored session belongs to another target. That includes a `--dry-run`, and a `--resume` with the wrong `--repo`.
- In contrast, these are all per target under `stateDirFor(target)`, as PLAN's "State dir … per-target subdir keyed by sha256(abs repo path)" requires:
  - `inflight.json` and `worktrees/` (`checkpoint.js:25-31`)
  - samples, weights and calibration (`collector.js:12-14`, `classifier.js:17`, `calibration.js:16-17`)
- The server's `/`, `/session.json`, `/clusters.json`, `/calibration.json` and `/rl-weights.json` all follow whichever target wrote `session.json` last (`src/interpretability/server.js:88`, `:124-128`).

**Impact.** Running the tool on repo B, even with `--dry-run`, wipes repo A's unfinished session:

- its unprocessed proposals,
- the Claude spend already made on them,
- the `worktree` record that ties A to its run branch.

`--resume --repo A` then starts a new `run_id`, calls the Analyzer again and opens a second `refactor/<run_id>` branch. The old branch is orphaned with its commits. Two concurrent runs on different targets would also overwrite each other's `session.json` and dashboard (suspected; not run).

**Repro:** `node audit/3/resume-scope.js`, scenario A.

- Observed: after `--dry-run --resume --repo B`, `--resume --repo A` reports `resumed run_id=<new>`, `analyzer calls on resume=1`, and A now has two `refactor/*` branches. The pending proposal is never resumed.
- Expected: `--resume --repo A` finds A's session under `stateDirFor(A)`, with the same `run_id` and 0 Analyzer calls.

---

## Medium

### M1. A crash after the commit, before the next `saveSession`, leaves the session contradicting the branch, and `--resume` acts on it

**Affected code:** `src/orchestrator.js:140-208`.

- `runExecutor` commits through `onKept`.
- The next `saveSession` is at `:208`. Before it run `collectSample`, `computeReward`, `rewardBreakdown`, and `syntheticNegatives`. The last runs up to three synchronous diff tests, each with a 3 s hard kill.
- CLAUDE.md says "After every agent call, the Orchestrator persists `state/session.json`".
- On resume, `test_outcome == null` means "unprocessed" (`:278`).

**Impact.** A SIGKILL, OOM or power loss in that window leaves a commit on `refactor/<run_id>` while `session.json` says the proposal never ran. On `--resume`:

1. The proposal is validated again against the worktree, which already holds the edit.
2. The executor reports `apply_failed` ("anchor not found").
3. Reflexion is triggered.
4. `test_results` and the decision trace get duplicate entries.

The session then misreports a committed edit as failed, and a repair is attempted on top of it.

**Repro:** `node audit/3/resume-after-commit-crash.js`. It copies `session.json` the instant `worktree.commitProposal` returns, restores that copy, and resumes.

- Observed: `session.json at the moment of the commit: add.test_outcome=null`, then `resume: add -> apply_failed (anchor match failed … not found at any tier)`, `repairs emitted for add: <id>:vetoed`, and `commits on branch: 1`.
- Expected: the status is saved right after the executor returns. Or resume reconciles with the branch log, since commit messages carry `issue_id`.

### M2. `--resume` after `--dry-run` executes nothing

**Affected code:**
- `src/orchestrator.js:278` treats any `test_outcome`, including `{status:'dry_run'}`, as final.
- `setupWorkspace` (`:318-331`) still creates a worktree and branch.

**Impact.** The obvious "validate, review, then apply" workflow (`--dry-run`, then `--resume`) applies nothing and prints no warning. README describes `--resume` as finishing "unprocessed proposals". A `dry_run` proposal has been validated but not processed.

**Repro:** `node audit/3/resume-scope.js`, scenario B.

- Observed: dry run gives `dry_run, vetoed`. The non-dry `--resume` gives the same `dry_run, vetoed`, 0 commits and 0 critic calls, and creates an empty run branch.
- Expected: the approved proposals go to the RL gate and executor (re-validated if needed), or the CLI refuses with a message.

### M3. `TestOutcome.status` has no single meaning: each consumer maps it differently

**Affected code:**
- `collector.LABELED_STATUSES` (`src/rl/collector.js:10`), which `calibration.executedPoints` reuses.
- `reward.pCorrect`, `falsePositive` and `stageSignals` (`src/rl/reward.js:18-53`).
- `clustering` (`:143`), `classifyFailure` (`tracer.js:100-111`), `dashboard.rowClass` (`:38-44`) and `summarizeRun` (`orchestrator.js:332-346`).

**Impact.** The same outcome is a failure for some consumers and ignored by others. For example, `timeout` (possibly an infinite loop the edit introduced):

- produces no sample and no calibration point;
- is scored as a failed prediction by the reward (`p_correct = 1 - c`), but not as a false positive;
- has `tests_ran = 0`;
- is clustered as a failure, classed `environment_issue`, and drawn red on the dashboard;
- is not counted at all in the run summary.

`apply_failed` and `environment_error` are also rewarded as failed predictions, while the learning loop excludes them.

**Repro:** `node audit/3/status-vocabulary.js` prints the full status × consumer table. The `timeout` row is: `sample_label=- calib_point=- reward_pcorrect=0.20 reward_fp=0 tests_ran=0 cluster=fail failure_class=environment_issue dash_row=row-fail run_summary=(not counted)`.

**Expected:** one documented mapping from status to {label 1, label 0, excluded}, kept next to `TEST_OUTCOME_STATUSES` and imported by every consumer.

### M4. The what-if panel labelled "What-if · RL gate" (and `counterfactual.js`) model only the classifier, not the gate

**Affected code:**
- `src/interpretability/dashboard.js:351-357` and `:424-449`: the in-page `predictPpass` uses `/rl-weights.json` only.
- `src/rl/counterfactual.js:200-260`: classifier only.
- `src/rl/classifier.js:269-279`: the gate's `p_pass` is `min(classifier, calibrated(combined))`, as CLAUDE.md "Learned gate" also states.

**Impact.** The panel can show a green `p_pass` for features the gate rejects. Operators would misread why a proposal was `rl_rejected`.

**Repro:** `node audit/3/whatif-vs-gate.js` (optimistic classifier, pessimistic calibration).

- Observed: `gate: classifier_p=0.881 calibrated_p=0.050 -> p_pass=0.050 (calibration); proposal status=rl_rejected`, while the dashboard what-if shows `0.881 (green = would pass)` for the same features.
- Expected: the what-if and counterfactuals apply the same `min(...)` (they need `combined_confidence` as an input), or are labelled "classifier term".

### M5. Four of the seven contract asserts never run in `src/`

**Affected code:**
- Only `assertJuryVerdict`, `assertCheckResult` and `assertDiffTest` run, all in `src/validation/hybrid-validator.js:54-80`.
- `assertProposal` (analyzer and reflexion output, resumed sessions), `assertVerdict`, `assertTestOutcome` (executor output) and `assertSample` (before `appendSamples` persists) are used only in tests.
- PLAN.md: "used in tests and at stage boundaries".

**Impact.** Nothing stops a malformed proposal, outcome or sample from being persisted:

- a resumed legacy session (L11);
- a dead status (L1);
- a `NaN` `combined_confidence` (H1).

The e2e test's check on persisted samples is vacuous (L8).

**Repro:** `node audit/3/docs-vs-code.js`, line `M-contract-7`.

- Observed: `never: assertProposal, assertVerdict, assertSample, assertTestOutcome`.
- Expected: asserts at the analyzer, reflexion, executor and collector boundaries, and on load for `--resume`. `audit/3/boundaries.js` shows the asserts would pass today.

---

## Low

**L1. Dead statuses still matched in `src/`.**
- The executor maps `failed` to `reverted` (`src/agents/executor.js:62-65`). `applied_no_tests` was replaced by `skipped_no_tests`. Neither is in `TEST_OUTCOME_STATUSES`.
- `'failed'` is still matched by consumers at:
  - `src/orchestrator.js:186,191,337`
  - `src/rl/reward.js:28,48,115`
  - `src/rl/collector.js:10`
  - `src/interpretability/dashboard.js:40,58,63,83,100,259`
  - `src/interpretability/clustering.js:143`
  - `src/interpretability/probe.js:24`
  - `src/interpretability/tracer.js:101`
- `'applied_no_tests'` is matched at `src/rl/reward.js:48`, `src/interpretability/dashboard.js:39,261`, and in CLAUDE.md "Samples: `reverted`/`failed` = 0".
- The `test-runner`/`executor` uses of `'failed'` are legitimate, because there it is `runTests` output.
- Repro: `node audit/3/status-vocabulary.js` (`L-status-2`).

**L2. The run summary drops statuses.** `summarizeRun` (`src/orchestrator.js:332-346`) never counts `timeout`, `environment_error`, `apply_failed` or `skipped_no_tests`. So the `done.` line can read `passed=0 failed=0 …` after every edit was skipped or failed to apply. Repro: `status-vocabulary.js` (`L-status-3`).

**L3. The dashboard has no style for `vetoed`, `skipped_no_tests` or `error`.** These statuses have no `.status-*` CSS. `skipped_no_tests` and `error` render as `row-other`. `aggregateStats` has no vetoed KPI, and its `pass_rate` denominator counts critic/veto/dry-run rows. Repro: `status-vocabulary.js` (`L-status-4`).

**L4. `counterfactual.js` has no caller.** `attribute` and `counterfactuals` are referenced nowhere in `src/` or `bench/`. README says it is "used by the dashboard's what-if sliders". Other exports unused in production:
- `orchestrator.featuresFor` (a wrapper);
- `api-cache.getMode`;
- the deprecated getters `STATE_DIR`, `SESSION_PATH`, `SAMPLES_PATH`, `WEIGHTS_PATH`, `MODEL_PATH`, `CACHE_DIR` and `DASHBOARD_PATH`;
- `@babel/traverse` is still a dependency in `package.json` but unused.

Repro: `node audit/3/whatif-vs-gate.js` (`L-whatif-2`) and `node audit/3/dead-exports.js`.

**L5. CLAUDE.md, the stated source of truth, documents only `--repo`, `--resume` and `--dry-run`.**
- Commander and the README also define `--cache` (default `read-write`, so Claude responses are reused across runs by default), `--no-hierarchical`, `--serve` and `--port`.
- CLAUDE.md's session schema also omits `worktree`.
- Repro: `node audit/3/docs-vs-code.js` (`L-doc-1`).

**L6. Invalid CLI values.**
- `--cache bogus` reaches `apiCache.setMode` and dies with `[orch] fatal: Error: unknown cache mode` and a 10-frame stack trace (exit 1).
- `--port abc` and `--port 0` silently become 4173 (`src/orchestrator.js:373`).
- Expected: commander `.choices()` and argument parsers.
- Repro: `docs-vs-code.js` (`L-cli-2`, `L-cli-3`).

**L7. The Reflexion "repair_proposed" trace step has no span.** `src/agents/reflexion.js:94-100` builds the step by hand, without `tracer.trace`. It therefore has no `otel` field, and `runSpans` drops it from `spans.ndjson`. README says "every decision_trace step also emits a `gen_ai.*`-attributed span". Repro: `node audit/3/boundaries.js`, the only violation: `trace step -> span: <id>-2 step stage=analyzer outcome=repair_proposed has no otel span`.

**L8. A vacuous e2e contract check.** `test/orchestrator.e2e.test.js:69` runs `for (const s of loadSamples()) assertSample(s)`. That reads the global `rl-samples.json`, which nothing writes since SG6, instead of `loadSamples(repo)`. Repro: `docs-vs-code.js` (`L-test-8`). Related: `test/fixtures/*/responses.json` still carry an `executor` response for the removed Executor Claude call.

**L9. Docs and code disagree.**
- README gives the anchor tier order as "exact → whitespace → indent → fuzzy". The code order is exact → indent-shift → whitespace → fuzzy (`src/runner/anchor-matcher.js:368-397`).
- CLAUDE.md says "warn at 70% saturation". `TokenTracker.record` returns `exceeded`, but nothing reads it or logs it (`shouldPrune` is unused).
- The `server.js` header says `/calibration.json` returns "model + reliability bins". It returns only `{xs, ys, fitted_at, n}`, and `/rl-weights.json` is undocumented.
- README still describes differential testing as "`vm` contexts" (it is a `worker_thread` since SG2).
- CLAUDE.md lists `token_usage.executor`, which is always 0. Reflexion tokens are booked under `analyzer`.
- Repro: `docs-vs-code.js` (`L-doc-4`, `L-doc-5`, `L-doc-6`).

**L10. The same thresholds and status sets are defined in several places.**
- The 0.5 approval threshold appears as:
  - `REJECT_THRESHOLD` and `MIN_CRITIC_P` (`src/orchestrator.js:34-35`);
  - `APPROVAL_THRESHOLD` (`src/rl/reward.js:5`, reused by `dashboard.criticApproved`, which ignores `MIN_CRITIC_P` and the majority rule);
  - a literal `0.5` cap in `critic.normalizeVerdict` (`:90`).
- The labelled set `['passed','failed','reverted']` is repeated in `reward.js:115`, `dashboard.js:63,83` and `probe.js:24`, instead of importing `LABELED_STATUSES`.
- The failure set is repeated in `orchestrator.js:186`, `clustering.js:143` and `dashboard.js:40`.
- The dashboard's what-if hard-codes four sliders instead of using `FEATURE_NAMES`. `predictPpass` silently returns `null` on a feature-count mismatch.
- The values agree today. M3 shows they have already drifted in meaning.

**L11. Resume of a pre-SG1/SG5 `session.json`.** It completes without a crash, but:
- (a) The legacy `combined_confidence` was computed with the old closest-persona formula, and is merged unmarked into the per-target `calibration-points.json`.
- (b) The dashboard shows a legacy reject's `claude_confidence = 0.9` as "critic" 0.90. `critic.normalizeVerdict` maps the same verdict to `p_preserves = 0.1`.
- (c) Legacy `applied_no_tests` edits, which were kept in place, untested, by the pre-SG5 executor, are rendered as passes with no warning.
- Repro: `node audit/3/resume-legacy-session.js` (`L-legacy-1`, `L-legacy-2`).

**L12. The Verdict contract has no consistency invariant.** The critic prompt requires `preserves_semantics: true ⇒ p_preserves > 0.5` (`src/agents/critic.js:41-42`). `normalizeVerdict` enforces only the reject side (`:90`), and `assertVerdict` enforces neither. So `{preserves_semantics: true, p_preserves: 0.05}` counts as an approval vote in the majority used by `criticOk`. This is code-level; AUDIT-1 M3 covers the aggregation outcome, not the contract gap.

### Suspected (not reproduced)

- **S1. Concurrent runs on two targets** overwrite each other's `session.json`. Each `saveSession` is a whole-file replace of a different session object. Follows from H2; not run.
- **S2. `test_results` grows duplicate entries** for the same `proposal_id` whenever a proposal is re-executed after resume (M1 path). No consumer de-duplicates. `test_results` has no contract (CLAUDE.md "TestResult[]" is undefined).
- **S3. The legacy global `rl-samples.json` and `rl-weights.json`** (5-feature, pre-SG6) are never migrated or flagged. PLAN SG6 notes this as open. The per-target classifier silently starts from zero for targets that had history.

---

## Repro index (`audit/3/`)

| script | covers |
|---|---|
| `boundaries.js` | Full pipeline on 5 fixture runs with contract asserts at every boundary, plus spans and session schema (L7, extra-field inventory) |
| `legacy-alias-dependence.js` | H1 |
| `resume-scope.js` | H2 (scenario A), M2 (scenario B) |
| `resume-after-commit-crash.js` | M1 |
| `status-vocabulary.js` | M3, L1, L2, L3 |
| `whatif-vs-gate.js` | M4, L4 |
| `docs-vs-code.js` | M5, L5, L6, L8, L9 |
| `resume-legacy-session.js` | L11 |
| `dead-exports.js` | L4 (inventory) |
| `lib.js` | shared harness (temp state dir, git, quiet, report) |
