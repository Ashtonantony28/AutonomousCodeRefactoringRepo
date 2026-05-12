# Autonomous Code Refactoring System

A multi-agent pipeline that points Claude at a Git repo, finds tech debt, validates
refactoring proposals with hybrid AI + AST + execution-equivalence logic, applies the
safe ones, runs the test suite, learns from outcomes, and explains every decision.

## Architecture

```
Orchestrator
  ├── Analyzer  ─► (hierarchical: file shortlist → function shortlist → edit window)
  │
  ├── Critic JURY  ─► three personas (strict / permissive / security)
  │                   produce verdicts + agreement / disagreement signal
  │
  ├── AST checker  ─► Babel (JS/TS) + polyglot regex (Python / Go / Ruby)
  │                   four anti-patterns: signature drift, error-handling
  │                   removal, new-dep, return-path regression
  │
  ├── Differential testing ─► fast-check + vm isolation: input-equivalence
  │                           oracle for JS function refactors
  │
  ├── Hybrid validator  ─► adaptive weights: claude 0.5 + ast 0.3 + diff 0.2
  │                       when differential testing is applicable,
  │                       claude 0.6 + ast 0.4 otherwise
  │
  ├── RL gate  ─► dependency-free logistic regression with counterfactual
  │              "what-if" attribution; isotonic-calibrated combined_confidence
  │
  ├── Executor  ─► 4-tier anchor matching (exact → whitespace → indent → fuzzy);
  │               snapshot revert on test failure; c8 coverage capture
  │
  ├── Reflexion loop  ─► up to 2 repair attempts using CRITIC-style
  │                       grounded-in-stderr re-prompting
  │
  └── Tracer + Dashboard ─► OpenTelemetry GenAI span schema; reliability
                            diagram + ECE; SSE live updates; failure clustering
```

See [`CLAUDE.md`](./CLAUDE.md) for conventions, budgets, and the reward function.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
# Standard run with the live SSE dashboard
node src/orchestrator.js --repo /path/to/target/repo --serve

# Skip Executor (no file changes)
node src/orchestrator.js --repo /path/to/target/repo --dry-run

# Continue from a previous session
node src/orchestrator.js --repo /path/to/target/repo --resume

# Replay an earlier run from cached responses (no API calls)
node src/orchestrator.js --repo /path/to/target/repo --cache replay

# Disable Agentless-style hierarchical localization
node src/orchestrator.js --repo /path/to/target/repo --no-hierarchical
```

After every run, open `dashboard/dashboard.html` (or `http://127.0.0.1:4173/` when
`--serve` is on) for the reliability diagram, agreement grid, what-if RL sliders,
failure clusters, and per-proposal decision traces.

## CLI flags

| flag                | default      | description                                                  |
|---------------------|--------------|--------------------------------------------------------------|
| `--repo <path>`     | (required)   | Target Git repo                                              |
| `--resume`          | off          | Continue from `state/session.json`                            |
| `--dry-run`         | off          | Run Analyzer + Critic, skip Executor                         |
| `--cache <mode>`    | `read-write` | `off` · `read-write` · `replay` (sha256-keyed API responses) |
| `--no-hierarchical` | off          | Disable file→function shortlisting                            |
| `--serve`           | off          | Start the live SSE dashboard                                  |
| `--port <n>`        | `4173`       | Dashboard server port                                         |

## Layout

```
src/
  orchestrator.js
  agents/      analyzer.js · critic.js · executor.js · reflexion.js
  validation/  ast-checker.js · polyglot-ast.js · hybrid-validator.js · diff-testing.js
  rl/          collector.js · classifier.js · reward.js · calibration.js
               counterfactual.js · bug-injector.js
  interpretability/  tracer.js · probe.js · clustering.js · dashboard.js · server.js
  runner/      anchor-matcher.js · reverter.js · test-runner.js
  utils/       file-discovery.js · token-tracker.js · checkpoint.js
               api-cache.js · claude-client.js
state/         session.json · rl-weights.json · rl-samples.json
               calibration.json · cache/<hash>.json · runs/<run_id>/spans.ndjson
dashboard/     dashboard.html
test/          smoke.js (50 module-level checks, no API calls)
```

## Features in detail

- **4-tier anchor matching** (`src/runner/anchor-matcher.js`): exact → whitespace-
  normalized → indent-shifted → difflib-style fuzzy. Inspired by Aider's
  SEARCH/REPLACE fallback chain — significantly reduces silent edit failures.

- **Differential testing** (`src/validation/diff-testing.js`): when a JS proposal
  touches a callable function, both versions are loaded into isolated `vm`
  contexts and exercised with `fast-check`-generated random inputs. Divergence
  produces a counterexample that gets recorded on the proposal. EMI-style
  equivalence-modulo-inputs (Le et al., PLDI '14; Mokav, 2024).

- **Polyglot AST checks** (`src/validation/polyglot-ast.js`): regex-based
  extractors for Python / Go / Ruby covering the four anti-patterns when
  `@babel/parser` doesn't apply.

- **Multi-persona Critic jury** (`src/agents/critic.js`): three Claude calls
  per proposal — strict / permissive / security — producing per-persona
  confidences plus an `agreement` summary (std-dev, unanimous-approval flag,
  verbal entropy via char-trigram cosine). DiverseAgentEntropy (EMNLP 2025);
  SE-Jury (2025).

- **Reflexion repair loop** (`src/agents/reflexion.js`): on test failure, feed
  stderr+stdout back into a new Analyzer call for up to 2 retries. The repair
  proposal is linked to its parent via `parent_issue_id` and re-runs the
  full pipeline. Reflexion (Shinn et al., NeurIPS 2023) + CRITIC (Gou et al.,
  ICLR 2024).

- **Isotonic calibration** (`src/rl/calibration.js`): PAVA-based monotone
  calibration of `combined_confidence`. Produces reliability bins and ECE
  for the dashboard. Niculescu-Mizil & Caruana.

- **Richer reward function** (`src/rl/reward.js`):
  ```
  reward = log(calibrated(p_correct))
         - 2.0 * false_positive_penalty
         + 0.3 * stage_signals          (ORPS, Yu et al. 2024)
         - 0.5 * (1 - coverage_pct)
         - 1.0 * disagreement_penalty
  ```

- **Counterfactual attribution** (`src/rl/counterfactual.js`): closed-form
  feature contributions and counterfactual feature values that would flip
  the gate decision — used by the dashboard's what-if sliders.

- **Bug injector** (`src/rl/bug-injector.js`): CriticGPT-style synthetic
  negatives (off-by-one, `==`/`===` swap, drop `await`, flip boolean,
  drop `return`, remove null guard) emitted for every passing proposal
  to enlarge the negative class without paying for real test failures.

- **API response cache** (`src/utils/api-cache.js`): sha256-keyed cache of
  Claude responses. `--cache replay` enables deterministic regression runs
  with zero API spend.

- **OpenTelemetry GenAI schema** (`src/interpretability/tracer.js`): every
  decision_trace step also emits a `gen_ai.*`-attributed span. Persisted
  per-run as `state/runs/<run_id>/spans.ndjson`, ingestible by any OTel
  backend.

- **SSE live dashboard** (`src/interpretability/server.js`): stdlib HTTP
  server with Server-Sent Events for live state updates and JSON endpoints
  for the what-if sliders, calibration model, and failure clusters.

- **Failure clustering** (`src/interpretability/clustering.js`): TF-IDF
  vectorizer + spherical k-means over failed proposals; pure-JS, no
  embedding API needed. Surfaces "what kinds of refactors are failing".

- **Hierarchical Analyzer** (`src/agents/analyzer.js`): Agentless-style
  three-pass localization — repo summary → file shortlist → function
  shortlist → proposal generation. Cuts token usage and grounds proposals
  in pre-identified hotspots.
