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
- After every agent call, the Orchestrator persists `state/session.json`.
- On `SIGINT`/`SIGTERM` the in-flight edit is reverted (its test process
  group killed), state is flushed and the process exits 0. The pre-edit
  snapshot is also persisted (`<state>/targets/<sha256(repo)>/inflight.json`)
  so after a crash the next start restores it before doing anything else.
- `--resume` with proposals in the session skips the Analyzer and processes
  every proposal without a `test_outcome`, including pending Reflexion repairs.

## Executor isolation

- Non-dry runs create a git worktree of the target on branch
  `refactor/<run_id>` under `<state>/targets/<sha256(repo)>/worktrees/<run_id>`.
  The Analyzer reads the target; validation, edits, tests and coverage output
  (`.refactor-coverage`) happen in the worktree. The target's working tree is
  never modified. Uncommitted target changes are copied into the worktree
  (uncommitted); the target's `node_modules` is symlinked in.
- Each passing proposal is one commit (only the edited file is staged; the
  message carries `issue_id` and `file`). Failing edits are reverted. The
  branch and worktree path are printed at the end of the run.
- If the target is not a git repo (or has no commits) the Executor falls back
  to editing the target in place, with a warning.
- No test runner detected → `skipped_no_tests`, edit reverted, no RL sample.
- Test commands run detached in their own process group; the 60 s timeout
  kills the whole group.

---

## Session state schema (`state/session.json`)

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

Proposals are rejected before Executor (`critic_rejected`) when
`combined_confidence < 0.5`, OR the jury does not approve on its own: the
majority `preserves_semantics` must be true AND `jury.p_preserves >= 0.5`
(`MIN_CRITIC_P`), so AST + diff-test terms can never outvote the critic. Independently of the score, a proposal is **vetoed**
(`test_outcome.status = 'vetoed'`, never reaches the RL gate or Executor) when
the differential test is `divergent`, any check has `severity: 'veto'` (parse
errors introduced by the proposal), or every persona says
`preserves_semantics: false` (malformed verdicts count as false).

---

## Reward function

```
reward = log(p_correct + 1e-9) - 2.0 * false_positive_penalty
```

- `p_correct` = combined_confidence when test_passed, else `1 - combined_confidence`
- `false_positive_penalty = 1` iff the Critic approved (`combined_confidence >= 0.5`)
  but tests failed; else `0`.

If the rolling average reward over the last 10 samples decreases vs the prior
window, log a warning to stdout.

---

## RL gate

When >= 10 RL samples exist, the Orchestrator trains the logistic-regression
classifier and uses it as a pre-Executor gate:

- Features: `[critic_confidence, pattern_score, proposal_complexity, files_changed, risk_estimate]`
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
- `--resume`: continue from existing `state/session.json` (same target only);
  no re-analysis when it already has proposals
- `--dry-run`: run Analyzer + Critic, skip Executor (no file changes)
