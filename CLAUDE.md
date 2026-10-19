# CLAUDE.md — Autonomous Code Refactoring System

Conventions, architecture, and budgets for the multi-agent refactoring pipeline.
This file is the source of truth for any agent (human or AI) working on this codebase.

---

## System summary

A self-improving pipeline that points at any Git repo and:

1. Analyzes it for tech debt (Analyzer agent)
2. Validates proposed fixes with hybrid AI + AST logic (Critic agent)
3. Applies approved fixes and runs the test suite (Executor agent)
4. Trains a lightweight classifier on outcomes to improve future validation (RL loop)
5. Logs every decision and renders it in an HTML interpretability dashboard

---

## Model & token budgets

- **Model**: `claude-sonnet-4-20250514` for the Analyzer, Critic and Reflexion
  calls. The Executor makes no Claude call: it applies the edit and runs tests.
- **Max tokens per agent call**: 4000 (`max_tokens` in API call)
- **Context window budget**: 80,000 tokens per agent (warn at 70% saturation)
- **API key**: read from `ANTHROPIC_API_KEY` env var

Token accounting is cumulative per agent: `TokenTracker.record` adds each
call's input + output tokens to `token_usage[agent]` and sets
`context_saturation[agent] = tokens / 80,000` (capped at 1). Every call is
stateless (no conversation history is resent), so nothing is pruned; the
saturation figures are reported on the dashboard as a spend indicator only.

---

## Coordination rules

- **The Orchestrator is the only thing that calls agents.** Agents never call
  each other directly and never share state except through the session JSON.
- The pipeline runs strictly: Analyzer → Critic (+ AST) → RL gate → Executor.
- After every agent call, the Orchestrator persists the target's session
  (`<state>/targets/<sha256(repo)>/session.json`). A legacy global
  `<state>/session.json` is moved there on first read, only for its own target.
- On `SIGINT`/`SIGTERM` the in-flight edit is reverted (its test process
  group killed), state is flushed and the process exits 0. The pre-edit
  snapshot is also persisted (`<state>/targets/<sha256(repo)>/inflight.json`)
  so after a crash the next start restores it before doing anything else.
- `--resume` with proposals in the session skips the Analyzer and processes
  every proposal without a `test_outcome`, including pending Reflexion repairs.
  It first reconciles with the `refactor/<run_id>` branch: a proposal whose
  `issue_id` is in a commit message but has no `test_outcome` (crash after the
  commit) is marked `passed` with that commit, not re-executed. A run worktree
  that is gone is re-created from `refactor/<run_id>` (stale registration
  pruned, uncommitted target changes synced again except files the branch
  changed); if the branch is gone or the worktree cannot be re-attached the
  run stops with an error (`EWORKTREE`, exit 2) and `session.worktree` is left
  as it was. Resume never edits a git target in place.

## Executor isolation

- Non-dry runs create a git worktree of the target on branch
  `refactor/<run_id>` under `<state>/targets/<sha256(repo)>/worktrees/<run_id>`.
  The Analyzer reads the target; validation, edits and tests happen in the
  worktree (coverage data goes to a removed temp dir). The target's working tree is
  never modified. Uncommitted target changes are copied into the worktree
  (uncommitted); the target's `node_modules` is symlinked in.
- Each passing proposal is one commit (only the edited file is staged; the
  message carries `issue_id` and `file`). Failing edits are reverted. The
  branch and worktree path are printed at the end of the run.
- An edit is kept only when the suite passes, executed every changed
  function (V8 coverage / coverage.py, grouped by innermost function;
  comments, whitespace and docstrings are no evidence), and fails on at least
  one of up to 3 bug-injected mutants of the changed characters (or, when no
  operator applies to them, of the edited lines; `bug-injector.editMutants`,
  parse-valid only). Mutant runs re-run the whole suite and share the main
  run's 60 s budget: each gets at most 2× the main run's time + 1 s, none
  starts with less than the main run's time + 0.5 s left; a run that fails,
  or times out on its full slice, kills the mutant. Otherwise `reverted` with
  reason `edit_not_exercised` / `no_coverage_tool` (no test ran the edit,
  whether the suite passed or failed), `coverage_timeout` (coverage
  post-processing overran the test budget) or `tests_insensitive` (no mutant
  failed). These four reasons are untested outcomes: no sample, calibration
  point, reward or Reflexion repair.
- If the target is not a git repo (or has no commits) a fresh run falls back
  to editing the target in place, with a warning.
- No test runner detected → `skipped_no_tests`, edit reverted, no RL sample.
- Test commands run detached in their own process group; the 60 s timeout
  kills the whole group.

---

## Session state schema (`<state>/targets/<sha256(repo)>/session.json`)

```json
{
  "run_id": "uuid",
  "target_repo": "/abs/path",
  "started_at": "ISO timestamp",
  "updated_at": "ISO timestamp",
  "proposals": [/* Proposal[] */],
  "test_results": [/* TestResult[] */],
  "rl_samples": [/* RLSample[] */],
  "token_usage": { "analyzer": 0, "critic": 0, "executor": 0 },
  "context_saturation": { "analyzer": 0.0, "critic": 0.0, "executor": 0.0 }
}
```

### Proposal shape

```json
{
  "issue_id": "sha256(file + '\0' + current_code)[:16]",  // -2, -3 on collision
  "file": "relative/path.js",
  "current_code": "...",
  "proposed_code": "...",
  "reasoning": "...",
  "risk_estimate": 0.3,
  "critic_verdict": null,
  "pattern_check_results": [],
  "combined_confidence": null,
  "test_outcome": null,
  "decision_trace": []
}
```

---

## Anti-patterns the Critic must always check (AST-side)

1. **Signature drift** — proposed code changes a function's parameter count
   without matching call-site updates in the same repo.
2. **Error handling removal** — current code has `try/catch` or `.catch()`,
   proposed code drops it.
3. **New dependency introduced** — proposed code imports a module not in the
   current code AND not in `package.json`.
4. **Return-type change** — current function always returns a value; proposed
   version has at least one missing return path.

`pattern_score = (checks passed) / (checks run)`. Each Critic persona returns
`p_preserves` = P(proposed code preserves the current code's observable
behaviour); `jury.p_preserves` is the panel mean. Combined:

```
combined_confidence = 0.6 * jury.p_preserves + 0.4 * pattern_score
# when the differential test is applicable (verdict equivalent|divergent):
combined_confidence = 0.5 * jury.p_preserves + 0.3 * pattern_score + 0.2 * diff_score
```

Python adds two lexical checks (`polyglot-ast`, edited region only, veto on
failure): `guard_removal` (fewer `raise` / `assert` / `if …: return|raise|
continue|break` guards, or an `except` type gone) and `condition_change` (a
comparison operator or compared number gone anywhere, an operator or literal
gone from an `if`/`elif`/`while`/`assert` condition, or a changed default
parameter value).

Proposals to test files (`test/`, `tests/`, `__tests__/`, `spec/`,
`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `*_test.go`) are never
proposed by the Analyzer and are `critic_rejected` before any critic call.
Other proposals are rejected before Executor (`critic_rejected`) unless they
clear the commit bar: `combined_confidence >= 0.5`; a majority of `panel[]`
says `preserves_semantics: true` AND `jury.p_preserves >= 0.5`
(`MIN_CRITIC_P`), so AST + diff-test terms can never outvote the critic; the
approval is unanimous; every persona has `p_preserves >= 0.2`
(`MIN_PERSONA_P`); and no persona lists an `edge_cases` entry (the prompt
defines them as inputs on which the edit behaves differently). Without an
`equivalent` diff test the gate fails closed: an `inconclusive` diff test
that ran inputs (`runs > 0`) is rejected, so is a JS edit the diff test ran
no input on (unlocatable shapes: the AST checks only catch their four
anti-patterns), and a non-JS edit (`runs = 0`) proceeds only with every
check passed (for Python including the lexical checks). The gate and fusion
read only contract fields (`panel`, `p_preserves`, `agreement`, verdict
`edge_cases`; `applicable`, `verdict`, `runs`); the diff score is derived
from `verdict`. Independently of the score, a proposal is **vetoed**
(`test_outcome.status = 'vetoed'`, never reaches the RL gate or Executor) when
the differential test is `divergent`, any check has `severity: 'veto'` (any
failed anti-pattern or Python lexical check above, or parse errors
introduced by the proposal), or every persona says
`preserves_semantics: false` (malformed verdicts count as false).

`signature_drift` scans only repo files that name the function on a word
boundary and stops at the first call site; over a cap the check passes with a
`detail` saying so. JS: a plain function is matched only in files that import
the edited module (importers scanned first), a file is parsed only when the
name appears in a call shape, at most 200 files / 2 MB are parsed, and parses
are cached per run. Polyglot: files that also name the edited module first,
at most 200 scanned, stripped sources cached per run.

---

## Reward function (diagnostic)

```
reward = log(p_correct + 1e-9) - 2.0 * false_positive_penalty
         (+ stage-signal, coverage and disagreement terms, see src/rl/reward.js)
```

- `p_correct` = c when test_passed, else `1 - c`, where `c` is the target's
  isotonic-calibrated `combined_confidence` once calibration is trained
  (raw `combined_confidence` before that)
- `false_positive_penalty = 1` iff the Critic approved (`combined_confidence >= 0.5`)
  but tests failed; else `0`.

The reward is a **diagnostic**: it is logged, charted and checked for trend,
but nothing is trained on it. If the rolling average reward over the last 10
samples decreases vs the prior window, log a warning to stdout.

---

## Learned gate ("RL gate" in code and flags)

The gate is supervised learning on test outcomes, not reinforcement learning.
All learning state is **per target repo**, under
`stateDirFor(target) = <state>/targets/<sha256(abs repo path)>/`:
`rl-samples.json`, `rl-weights.json`, `calibration.json`,
`calibration-points.json`. Samples and calibration points accumulate across
runs, de-duplicated by the edit: `edit_id` = `issue_id` + hash of
`proposed_code` (mutants: that + the mutation), so a different edit of the
same snippet in a later run adds a sample/point. Entries stored without
`edit_id` keep their `proposal_id` key. Training always uses all of them.

- **Samples**: one per executed proposal with a label (`passed` = 1,
  `reverted`/`failed` = 0; environment errors, apply failures and untested
  edits, i.e. `reverted` with `edit_not_exercised` / `no_coverage_tool` /
  `coverage_timeout` / `tests_insensitive`, are not samples).
- **Features** (`FEATURE_NAMES` in `src/rl/features.js`):
  `[p_preserves, pattern_score, proposal_complexity, risk_estimate]`
  (`p_preserves` = jury mean). Weights saved under a different feature list
  are ignored and retrained, never applied.
- **Synthetic negatives**: for each passing proposal, up to 3 bug-injected
  mutants of `proposed_code`, re-scored with `ast-checker.runChecks` and the
  differential test (no Claude calls). Mutants the diff test shows
  `equivalent` are dropped. Features = parent critic features + the mutant's
  real AST/complexity features; `synthetic: true`, weight 0.5 in training.
- **Classifier**: weighted logistic regression, trained after each run when
  >= 10 samples with both labels exist for the target.
- **Calibration**: isotonic regression of `combined_confidence` → pass, fitted
  on all executed proposals for the target (needs >= 20).
- **Gate** (pre-Executor): `p_pass` = min of the classifier's prediction and
  the calibrated `combined_confidence`, over whichever is trained (no gate
  when neither is).
  - `p_pass < 0.4` → skip Executor, log as `rl_rejected`
  - `p_pass >= 0.4` → proceed

---

## Error handling rules

- Every Claude API call: retry once on rate limit (10 s backoff), then fail
  gracefully — never let one bad proposal crash the pipeline.
- File ops: wrap in try/catch, log, continue.
- `SIGINT`/`SIGTERM`: revert the in-flight edit, flush state, exit 0.

---

## CLI

```
node src/orchestrator.js --repo <path> [--resume] [--dry-run]
```

- `--repo` (required): target Git repo
- `--resume`: continue from the target's existing session;
  no re-analysis when it already has proposals
- `--dry-run`: run Analyzer + Critic, skip Executor (no file changes)
