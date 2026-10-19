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

- **Model**: `claude-sonnet-4-20250514` for all three agents
- **Max tokens per agent call**: 4000 (`max_tokens` in API call)
- **Context window budget**: 80,000 tokens per agent (warn at 70% saturation)
- **API key**: read from `ANTHROPIC_API_KEY` env var

When any agent's cumulative input tokens cross **70%** of its budget, the
Orchestrator MUST call `pruneContext(agentName, proposals)` to swap full
proposal payloads for summaries.

---

## Coordination rules

- **The Orchestrator is the only thing that calls agents.** Agents never call
  each other directly and never share state except through the session JSON.
- The pipeline runs strictly: Analyzer → Critic (+ AST) → RL gate → Executor.
- After every agent call, the Orchestrator persists `state/session.json`.
- On `SIGINT` or crash, state is flushed to disk and the run can be resumed
  with `--resume`.

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
  "issue_id": "uuid",
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

Proposals with `combined_confidence < 0.5` are rejected before Executor
(`critic_rejected`). Independently of the score, a proposal is **vetoed**
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
- `SIGINT`: flush state, exit 0.

---

## CLI

```
node src/orchestrator.js --repo <path> [--resume] [--dry-run]
```

- `--repo` (required): target Git repo
- `--resume`: continue from existing `state/session.json`
- `--dry-run`: run Analyzer + Critic, skip Executor (no file changes)
