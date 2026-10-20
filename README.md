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
  │                   each give p_preserves = P(behaviour preserved);
  │                   jury score = panel mean, plus agreement signal
  │
  ├── AST checker  ─► Babel (JS/TS) + polyglot regex (Python / Go / Ruby)
  │                   four anti-patterns: signature drift, error-handling
  │                   removal, new-dep, return-path regression (each a veto
  │                   when it fails; the call-site scan parses at most 200
  │                   files that name the function, cached per run); Python
  │                   adds lexical vetoes for a removed raise/assert/guard
  │                   or except type and lost comparisons/condition literals
  │
  ├── Differential testing ─► fast-check + vm isolation: input-equivalence
  │                           oracle for JS function refactors
  │
  ├── Hybrid validator  ─► adaptive weights: p_preserves 0.5 + ast 0.3 + diff 0.2
  │                       when differential testing is applicable,
  │                       p_preserves 0.6 + ast 0.4 otherwise; gate (commit
  │                       bar) needs combined >= 0.5, a unanimous approve,
  │                       every persona p_preserves >= 0.2 and no listed
  │                       behaviour-changing edge case, and an `equivalent`
  │                       diff test; a JS edit it could not run, or one it
  │                       ran without confirming, is rejected; non-JS edits
  │                       (runs=0) need every check passed, incl. Python
  │                       lexical guard/condition checks; test files are
  │                       never edited; hard vetoes (divergent diff test,
  │                       failed anti-pattern, Python lexical or parse check,
  │                       unanimous reject)
  │
  ├── Learned gate ("RL gate") ─► supervised logistic regression on test
  │              outcomes, per target repo, plus isotonic-calibrated
  │              combined_confidence; counterfactual "what-if" attribution
  │
  ├── Executor  ─► 4-tier anchor matching (exact → whitespace → indent → fuzzy);
  │               git worktree per run, one commit per passing edit;
  │               snapshot revert on failure or signal; kept only if the
  │               tests executed every changed function (V8 coverage /
  │               coverage.py; comments are no evidence) and fail on at
  │               least one of up to 3 bug-injected mutants of the edit
  │
  ├── Reflexion loop  ─► up to 2 repair attempts using CRITIC-style
  │                       grounded-in-stderr re-prompting
  │
  └── Tracer + Dashboard ─► OpenTelemetry GenAI span schema; reliability
                            diagram + ECE; SSE live updates; failure clustering
```

See [`CLAUDE.md`](./CLAUDE.md) for conventions, budgets, the learned gate, and the
(diagnostic) reward function.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
# Standard run with the live SSE dashboard
node src/orchestrator.js --repo /path/to/target/repo --serve

# Edits land as commits on refactor/<run_id> in a git worktree under the
# state dir (refactor-run/<run_id> if that name is blocked); the target's
# working tree is never touched. If no worktree can be created the run stops
# (exit 2); only non-git / no-commit targets are edited in place, with a warning.

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

## Tests

```bash
npm test                    # node:test suite (stub Claude client, temp dirs, no API calls)
npm run bench               # per-stage p50/p95 vs the PLAN.md latency budgets
npm run coverage            # line coverage of src/ incl. the diff-test worker threads
npm run coverage -- --files # ... plus the uncovered lines of each file
```

`npm run coverage` runs the suite with `NODE_V8_COVERAGE` and merges the V8
dumps of every isolate. `scripts/worker-coverage.js` hands the variable to the
diff-prep and diff-sandbox workers (started with an empty env) and flushes their
coverage before they are terminated; `node --test --experimental-test-coverage`
does not see worker threads and under-reports `src/validation`. It exits 1 when
`src/validation`, `src/runner`, `src/rl` or `src/orchestrator.js` is below 85%
lines. `py_diff_harness.py` is not included.

## CLI flags

| flag                | default      | description                                                  |
|---------------------|--------------|--------------------------------------------------------------|
| `--repo <path>`     | (required)   | Target Git repo                                              |
| `--resume`          | off          | Continue from the target's session (`state/targets/<sha256(repo)>/session.json`): skips the Analyzer when proposals exist, marks proposals already committed on `refactor/<run_id>` as passed, finishes unprocessed proposals and pending repairs |
| `--dry-run`         | off          | Run Analyzer + Critic, skip Executor                         |
| `--cache <mode>`    | `read-write` | `off` · `read-write` · `replay` (sha256-keyed API responses) |
| `--no-hierarchical` | off          | Disable file→function shortlisting                            |
| `--serve`           | off          | Serve the live SSE dashboard while the run is in progress; it stops when the run ends (`node src/interpretability/server.js [--repo <path>]` serves it standalone; without `--repo` it follows the most recently written session) |
| `--port <n>`        | `4173`       | Dashboard server port                                         |

## Layout

```
src/
  orchestrator.js · contracts.js
  agents/      analyzer.js · critic.js · executor.js · reflexion.js
  validation/  ast-checker.js · polyglot-ast.js · hybrid-validator.js · diff-testing.js
  rl/          features.js · collector.js · classifier.js · reward.js · calibration.js
               counterfactual.js · bug-injector.js
  interpretability/  tracer.js · probe.js · clustering.js · dashboard.js · server.js
  runner/      anchor-matcher.js · reverter.js · test-runner.js · worktree.js
  utils/       file-discovery.js · token-tracker.js · checkpoint.js
               api-cache.js · claude-client.js
state/         cache/<hash>.json · runs/<run_id>/spans.ndjson   (override: REFACTOR_STATE_DIR)
               targets/<sha256(repo)>/  session.json · rl-samples.json · rl-weights.json
                                        calibration.json · calibration-points.json
dashboard/     dashboard.html   (override: REFACTOR_DASHBOARD_DIR)
test/          *.test.js (node:test, stub Claude client, no API calls) · fixtures/ · helpers/
bench/         run.js (npm run bench: per-stage p50/p95 vs PLAN.md budgets)
scripts/       coverage.js · worker-coverage.js (npm run coverage)
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
  per proposal — strict / permissive / security — each returning
  `p_preserves` (probability the edit preserves observable behaviour; a
  reject is capped at 0.5, legacy `claude_confidence` is mapped to
  `1 - c` for rejects). The jury score is the panel mean, with an
  `agreement` summary (std-dev, unanimous flag, approval rate, verbal
  entropy via char-trigram cosine). A unanimous reject is a hard veto. DiverseAgentEntropy (EMNLP 2025);
  SE-Jury (2025).

- **Reflexion repair loop** (`src/agents/reflexion.js`): on test failure, feed
  stderr+stdout back into a new Analyzer call for up to 2 retries. The repair
  proposal is linked to its parent via `parent_issue_id` and re-runs the
  full pipeline. Reflexion (Shinn et al., NeurIPS 2023) + CRITIC (Gou et al.,
  ICLR 2024).

- **Learned gate** (`src/rl/classifier.js`): weighted logistic regression on
  `[p_preserves, pattern_score, proposal_complexity, risk_estimate]` with the
  test outcome as label. Supervised learning, not RL (the "RL" names are kept
  in code and flags). Samples accumulate per target repo across runs and every
  training run uses all of them. The gate's `p_pass` is the lower of the
  classifier and the calibrated `combined_confidence`; `p_pass < 0.4` →
  `rl_rejected`.

- **Isotonic calibration** (`src/rl/calibration.js`): PAVA-based monotone
  calibration of `combined_confidence`, fitted on every executed proposal for
  the target. Feeds the gate and the reward; produces reliability bins and
  ECE for the dashboard. Niculescu-Mizil & Caruana.

- **Diagnostic reward** (`src/rl/reward.js`), logged and trend-checked but
  not trained on:
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
  drop `return`, remove null guard), up to 3 per passing proposal. Each
  mutant is re-scored through the AST checks and the differential test (no
  Claude calls); mutants shown equivalent are dropped, and the rest train
  with weight 0.5 using the parent's critic features.

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
  in pre-identified hotspots. Test files (`test/`, `tests/`, `__tests__/`,
  `spec/`, `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `*_test.go`) are
  neither sent nor proposed, and the gate rejects edits to them.

## Known limits

- **Diff-test blind spots.** The differential test only sees inputs its
  generator builds and effects its oracle records. Behaviour confined to
  inputs it never builds (zero-width or compatibility characters,
  lists or strings past the lengths it tries, deeper nesting, `NaN` in
  arrays; integer-width boundaries, prototype keys, a tab, a 5,000-character
  string and a 150-element Python list are always tried) or effects it
  cannot observe (a dropped `await` on a stub that never rejects, module
  state across chained calls such as a missing `global`) reads as
  `equivalent` (AUDIT-12 H1/H2, AUDIT-13 H2/H3). For those edits the only
  backstop is the executor bar: the suite must run the edit and kill a
  mutant of every changed token and of every inserted read at the place the
  edit uses it, and pure deletions stand on `deletions_observed`. A suite
  that never tests such an input can still let a deletion through.
- **Per-test kills need node:test or pytest.** A mutant is killed only by a
  test that passed unmutated and fails in both mutant runs, so the runner
  has to report per-test results: node:test (TAP through `NODE_OPTIONS`) or
  pytest (JUnit XML). Suites on other runners (Jest, Mocha, plain scripts,
  `make`), and node:test suites that set their own `--test-reporter` (also
  through a delegated script: node refusing the added reporters is re-run
  without them), get no kill and end `tests_insensitive`.
- **Use-site perturbations are small value changes.** A read is perturbed
  by number + 1, string + `~`, last list/dict entry dropped, or a skipped
  call (a namespace call passes its first non-literal argument through).
  Values with no such change (class instances, `Map`s, sets, `Infinity`)
  never differ, so an edit that inserts a read of one ends
  `tests_insensitive`; a perturbation that throws (a skip that leaves the
  wrong type) is killed by any test that runs it.
- **Fail closed per token.** Every inserted token but punctuation and
  whitespace needs a kill that covers it, operators and keywords included.
  Shapes with no mutant are rejected, not carried: a renamed or moved
  object key or keyword argument with no inserted read of the same name, a
  regex class bracket, names in type annotations, `typeof`, `=>`, `@`,
  `*args`, a Python ternary or comprehension, a new function definition.
  An operator mutant is a strong change (`>>` → `<<`, `-` → `+`): a test
  on small inputs kills it, so a range change (`x | 0` for `Math.trunc`)
  stands on the executor bar only if the diff test misses it. A string, or a template /
  f-string text part, is one site (`x` added): a change inside it (`r'\t'` →
  `r'\t+'`) stands on any test that checks the string's output.
- **Sham control covers size only.** The sham of a mutant that adds text
  adds as many spaces and wraps the site in at least as many non-space
  characters (parentheses, or a number in a comma expression): it stops
  tests that read source length, length without whitespace, or layout. A
  test that greps the source for a name or a character (`=>`, `lambda`), or
  a mutant that removes text, has no sham. A site whose wrapped sham does
  not parse (a numeric object key) has no mutant and is rejected.
- **Slow suites.** Every mutant kill takes three suite runs (mutant, mutant
  again, unmutated control) inside one 60 s mutant budget, so suites slower
  than about a third of that budget end `reverted` with `mutation_budget`.
