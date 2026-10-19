# PLAN.md — completing the refactoring pipeline

Source of truth for the completion work. Every worker reads this first and updates its own entry (status, verification result, open issues) when done.

## Status at plan time

**Partial.** The pipeline runs end to end and `npm test` passes (50/50 structural checks), but the validators have unsound paths, edits can land in the wrong place, the learning loop trains on fabricated features, and several `README.md`/`CLAUDE.md` features are unwired. Evidence and repros: `project-analysis/refactoring-system.md` (§7) in the project files.

## Rules

- **Interfaces first.** SG0 merges and is green before any other SG starts. A fix that needs an SG0 contract changed stops and is reported; no silent workarounds.
- **Fixtures before live API.** Every SG proves its behaviour on fixture repos under `test/fixtures/` with a stub Claude client. No live `ANTHROPIC_API_KEY` run until SG8.
- **Concurrency:** at most 2 SGs in flight; SGs that touch the same file never run together (see "Conflicts").
- **Workers return only:** files changed, tests added, verification command + result, open issues.
- **Three strikes:** a task that fails its verification 3 times stops and is reported.
- **Standards:** match existing CommonJS style, minimal comments, no new runtime deps unless listed here. Tests use `node:test` + `node:assert`; coverage via `node --test --experimental-test-coverage` (Node ≥ 22).

## Latency budget (set now, enforced from SG0)

Measured per proposal, excluding Claude calls, on `test/fixtures/` (reported by `npm run bench`):

| stage | p95 budget |
|---|---|
| AST checks (`runChecks`) | 300 ms |
| Differential test (`diffTesting.run`, incl. worker startup) | 2,000 ms, hard kill at 3,000 ms |
| Anchor match + apply (`applyEdit`) | 100 ms for files ≤ 200 KB |
| Whole non-LLM validation (`runHybridValidator` with stub critic) | 2,500 ms |

Each stage records `duration_ms` on its trace step so the budget is observable in real runs.

## Interface contracts (owned by SG0)

`src/contracts.js` exports the shapes below plus `assertProposal`, `assertVerdict`, `assertCheckResult`, `assertDiffTest`, `assertSample` (throw on violation; used in tests and at stage boundaries).

```
Proposal       { issue_id, file, current_code, proposed_code, reasoning, risk_estimate,
                 parent_issue_id?, attempt?, critic_verdict, pattern_check_results[],
                 diff_test, combined_confidence, veto?, test_outcome, decision_trace[] }
Verdict        { persona, preserves_semantics, p_preserves /*0..1, P(semantics preserved)*/,
                 edge_cases[], hallucination_flags[], reasoning }
JuryVerdict    { panel: Verdict[], p_preserves /*mean*/, agreement{ std, unanimous, approval_rate, verbal_entropy } }
CheckResult    { check_name, passed, detail, severity: 'veto'|'score' }
DiffTest       { applicable, verdict: 'equivalent'|'divergent'|'inconclusive', runs, counterexample?, reason?, duration_ms }
Sample         { proposal_id, target_repo, features: number[] /*FEATURE_NAMES order*/, label: 0|1,
                 synthetic, mutation?, timestamp }
FEATURE_NAMES  single export from src/rl/features.js; extractFeatures(proposal) is the only feature code
TestOutcome    { status: 'passed'|'reverted'|'timeout'|'environment_error'|'apply_failed'|
                 'critic_rejected'|'vetoed'|'rl_rejected'|'dry_run'|'skipped_no_tests'|'error', ... }
State dir      REFACTOR_STATE_DIR env var, default <tool>/state; per-target subdir keyed by sha256(abs repo path)
Claude client  callClaude({system,user,cacheTag}) unchanged; tests inject a stub via setClient(fn)
```

## Sub-goals

| id | title | depends on | owner | status |
|---|---|---|---|---|
| SG0 | Contracts, test harness, fixtures, bench | — | thread worker | done |
| SG1 | Sound score fusion and vetoes | SG0 | thread worker | proposed |
| SG2 | Isolated, time-bounded differential testing | SG0 | thread worker | done |
| SG3 | AST and polyglot check precision | SG0 | thread worker | proposed |
| SG4 | Safe anchor matching and edit application | SG0 | thread worker | done |
| SG5 | Executor and session robustness | SG0, SG4 | thread worker | proposed |
| SG6 | Learning loop on real features | SG0, SG1 | thread worker | proposed |
| SG7 | Live dashboard, safe rendering, real spans | SG0 | thread worker | proposed |
| SG8 | Live end-to-end run on a sample repo | SG1–SG7 | thread worker | proposed |

Conflicts (never concurrent): SG1/SG2/SG3 share `hybrid-validator.js` wiring (each touches only its own module; SG1 alone edits `hybrid-validator.js`); SG4/SG5 share `reverter.js`.
Planned order: SG0 → (SG2 ∥ SG4) → (SG3 ∥ SG7) → SG1 → (SG5 ∥ SG6) → SG8 → audits.

### SG0 — Contracts, test harness, fixtures, bench
- `src/contracts.js`, `src/rl/features.js` (replaces `featuresFor`, `buildSample` feature code, `featuresOf`).
- `REFACTOR_STATE_DIR` honoured by every module that reads `STATE_DIR`; tests always use a temp dir.
- Stub client (`setClient`) + fixture repos: `test/fixtures/js-basic` (npm test passes), `js-failing-after-edit`, `py-basic` (pytest), `no-tests`.
- Migrate `test/smoke.js` checks into `test/*.test.js`; `npm test` = `node --test`.
- `npm run bench` prints p50/p95 per stage against the budget table.
- **Accept:** all existing smoke assertions still pass; contract asserts run at stage boundaries in the e2e test; `runPipeline` e2e on `js-basic` with stub client ends with expected statuses; running tests leaves `state/` untouched.
- **Verify:** `npm test && npm run bench && git status --porcelain state/ | wc -l` → tests pass, bench prints, `0`.

### SG1 — Sound score fusion and vetoes
- Critic prompt asks for `p_preserves` (probability semantics are preserved); `combined` uses jury mean `p_preserves`, not the "closest to mean" persona.
- Vetoes (→ `vetoed`, never executed): diff-test `divergent`; `parse` failure; unanimous `preserves_semantics: false`; any check with `severity: 'veto'`.
- **Accept:** a verdict `{preserves_semantics:false, p_preserves:0.1}` cannot pass the gate; each veto has a test; clean proposal still passes.
- **Verify:** `node --test test/hybrid-validator.test.js test/critic.test.js`

### SG2 — Isolated, time-bounded differential testing
- Run each side in a `worker_thread` with `resourceLimits` and a wall-clock kill; no host `process`/`require` reachable.
- Deep-clone inputs per call; compare thrown error type + message; await promises with timeout.
- Evaluate the whole file with the edit spliced in so helpers resolve; support `const`/`let`/arrow and class methods.
- Proposed side fails to load → `divergent`. Both sides throw `ReferenceError` on every input → `inconclusive`.
- **Accept:** the four repros from the analysis (infinite loop, input mutation, `this.constructor.constructor` escape, undefined helper) are tests that pass; p95 within budget.
- **Verify:** `node --test test/diff-testing.test.js && npm run bench -- --stage diff`

### SG3 — AST and polyglot check precision
- Return check flags any lost return path, including removing all returns; handles `switch`, `try`, brace-less `if`.
- Signature drift ignores the definition site and only counts call sites outside the edited function; reports renamed functions.
- Splice with a function replacer (no `$&` expansion); use `ast.errors` from `errorRecovery` as a `parse` veto.
- Error-handling count ignores strings/comments (token-based for JS); not appended twice for polyglot files.
- Polyglot: `async def`, multi-line signatures, Python stdlib allow-list, Go body-level returns.
- **Accept:** each analysis repro (§7.1 items 7–10) is a passing test; no regression on existing check tests.
- **Verify:** `node --test test/ast-checker.test.js test/polyglot-ast.test.js`

### SG4 — Safe anchor matching and edit application
- Uniqueness at every tier: fuzzy rejects when the runner-up is within 0.02 of the best; no 200-char truncation (bounded banded Levenshtein instead).
- Fuzzy matches must be token-identical after whitespace normalization, otherwise `apply_failed` with the closest window in `detail`.
- Re-indent replacement for whitespace and fuzzy tiers; tab-aware indent shift.
- **Accept:** `<` vs `>` anchor fails; 254-char shared-prefix tie fails as ambiguous; Python whitespace-tier edit keeps valid indentation (fixture `py-basic` tests pass after edit).
- **Verify:** `node --test test/anchor-matcher.test.js test/reverter.test.js`

### SG5 — Executor and session robustness
- Work in a git worktree on branch `refactor/<run_id>`; one commit per passing proposal; target's working tree never touched. Coverage output stays in the worktree.
- SIGINT/SIGTERM: revert in-flight edit before exit (snapshot persisted to state dir).
- Test runner spawned in its own process group; timeout kills the group.
- No test runner → `skipped_no_tests`, edit reverted (opt-in `--allow-untested` keeps it).
- Remove the decorative Executor Claude call.
- `--resume`: no re-analysis when proposals exist; pending repairs are processed. Deterministic `issue_id = sha256(file + current_code)[:16]` so replay cache keys are stable.
- Either call `pruneContext` per `CLAUDE.md` or update `CLAUDE.md` to the implemented behaviour (decide in SG5, record here).
- **Accept:** e2e on `js-failing-after-edit` leaves target unchanged and branch has only passing commits; SIGINT test mid-run leaves target clean; `--resume` test produces no duplicates; `--cache replay` rerun of the e2e makes zero client calls.
- **Verify:** `node --test test/executor.test.js test/orchestrator.e2e.test.js`

### SG6 — Learning loop on real features
- Samples accumulate per target repo across runs; training reads all of them.
- Synthetic negatives are re-scored through AST + diff-test (no Claude calls) and use the critic features of the parent with `synthetic: true` weighting 0.5.
- Gate on calibrated `p_pass`; calibration fitted on all executed proposals; drop the constant `files_changed` feature.
- Reward stays a diagnostic; README/CLAUDE.md wording changed from "RL" to "learned gate" where it claims training on reward.
- **Accept:** on a fixture sample set, adding synthetic negatives does not flip the sign of the `p_preserves` weight (the analysis repro); gate uses calibrated value (test); samples from two runs both feed training.
- **Verify:** `node --test test/classifier.test.js test/bug-injector.test.js test/calibration.test.js`

### SG7 — Live dashboard, safe rendering, real spans
- Render HTML on each `saveSession` (debounced) or server-side per request; SSE triggers re-render, not reload of stale HTML.
- Escape `<`, `>`, `&`, U+2028/2029 in the inlined JSON.
- Agreement grid counts critic/veto-rejected proposals; `rl_accuracy` uses the gate threshold.
- Spans get `trace_id` (= run_id), `parent_id` (= proposal span), `start`/`end`; remove or wire `probe.js`.
- **Accept:** proposal containing `</script>` renders inert (test); `/` reflects a proposal within 2 s of `saveSession` (test with server on ephemeral port); spans validate against the contract.
- **Verify:** `node --test test/dashboard.test.js test/server.test.js test/tracer.test.js`

### SG8 — Live end-to-end run
- One live run (`--dry-run` first, then real) against a small public JS repo cloned into the scratch area; record results and the replay cache.
- **Accept:** run completes, no budget violations, every applied edit is a commit on the run branch with tests green; findings logged as new SGs if anything breaks.
- **Verify:** `node src/orchestrator.js --repo <sample> --dry-run && node src/orchestrator.js --repo <sample>`

## Audits (after SG8)

Separate sessions, none run by a worker that wrote the code under audit. Each writes `AUDIT-<n>.md`, findings ranked by severity, each with a repro or failing test. Critical/high findings become new SGs here. Repeat until a full round has no critical/high.

1. **Validation soundness (no false negatives):** can any semantics-changing edit reach the executor? Mutation corpus through the validators.
2. **Performance under load:** 500-file fixture, large files, slow tests; budget table.
3. **Contract/API consistency:** every stage boundary vs `src/contracts.js`; CLI flags vs README.
4. **Test coverage:** ≥ 85% lines on `src/validation`, `src/runner`, `src/rl`, `src/orchestrator.js`; untested branches listed.

## Log

| date | SG | result | notes |
|---|---|---|---|
| 2026-10-19 | — | plan drafted | awaiting approval |
| 2026-10-19 | SG0 | green | `npm test` 91/91 (50 smoke assertions migrated), bench all stages within budget, `state/` untouched. Open: RL samples/weights still at the global state dir (`stateDirFor` exists, SG6 switches); `no-tests` fixture's `expected_status` is the SG5 target `skipped_no_tests` (executor still returns `applied_no_tests`). |
| 2026-10-19 | SG2 | green | `node --test test/diff-testing.test.js` 23/23, `npm test` 112/112, bench difftest p50 78 ms / p95 119 ms (budget 2000). Sync API kept (worker + `Atomics.wait`). Open: `hybrid-validator.js` does not pass `fileSrc` yet (SG1 wiring); edits to non-callables (e.g. a constant) are `inconclusive`; `run` blocks the event loop up to the 3 s hard kill. |
| 2026-10-19 | SG4 | green | anchor/reverter tests 20/20, `npm test` 126/126 after merging with SG2, bench apply p95 37 ms (budget 100) incl. 200 KB cases. Tier order now exact → indent-shift → whitespace → fuzzy; fuzzy requires token identity and a runner-up gap ≥ 0.02. Open for SG5: executor's `apply_failed` drops `err.tier`/`err.detail.closest`. |
