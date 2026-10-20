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
| SG1 | Sound score fusion and vetoes | SG0 | thread worker | done |
| SG2 | Isolated, time-bounded differential testing | SG0 | thread worker | done |
| SG3 | AST and polyglot check precision | SG0 | thread worker | done |
| SG4 | Safe anchor matching and edit application | SG0 | thread worker | done |
| SG5 | Executor and session robustness | SG0, SG4 | thread worker | done |
| SG6 | Learning loop on real features | SG0, SG1 | thread worker | done |
| SG7 | Live dashboard, safe rendering, real spans | SG0 | thread worker | done |
| SG8 | Live end-to-end run on a sample repo | SG1–SG7 | thread worker | proposed |
| SG9 | Fail-closed gate | SG11 | thread worker | done |
| SG10 | Anchors validate the region they replace | SG9 | thread worker | done |
| SG11 | Diff test that exercises the code | — | thread worker | done |
| SG12 | Test-execution evidence and bounded runner | — | thread worker | done |
| SG13 | Per-target session and worktree sync | SG12 | thread worker | done |
| SG14 | Test-backed commit bar | SG13 | thread worker | done |
| SG15 | Diff-test reach, round 2 | SG11 | thread worker | done |
| SG16 | Performance, round 2 | SG14 | thread worker | done |
| SG17 | Learning identity and safe resume | SG16 | thread worker | done |
| SG18 | Mutation evidence on the change; richer JS oracle | SG17 | thread worker | done |
| SG19 | Python differential test | SG17 | thread worker | done |
| SG20 | Performance, round 3 | SG19 | thread worker | done |
| SG21 | Never edit a git target in place | SG17 | thread worker | done |
| SG22 | Enforce the commit bar on deletions and per-hunk evidence | SG20 | thread worker | done |
| SG23 | Pin every safety rule with a test | SG22 | thread worker | done |
| SG24 | Performance, round 4 | SG23 | thread worker | done |

Conflicts (never concurrent): SG1/SG2/SG3 share `hybrid-validator.js` wiring (each touches only its own module; SG1 alone edits `hybrid-validator.js`); SG4/SG5 share `reverter.js`.
Planned order: SG0 → (SG2 ∥ SG4) → (SG3 ∥ SG7) → SG1 → (SG5 ∥ SG6) → SG8 → audits.
Audit round 1 fixes: (SG11 ∥ SG12) → (SG9 ∥ SG13) → SG10 → audit round 2. No contract changes: CheckResult `severity:'veto'`, DiffTest `inconclusive` and TestOutcome `reverted` + reason already cover these.

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
- No test runner → `skipped_no_tests`, edit reverted. (`--allow-untested` dropped 2026-10-19: it needed a new contract status and keeping untested edits contradicts the safety goal.)
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

### SG9 — Fail-closed gate (A1-C1 gate part, A1-H1, A2-H1, A3-H1)
- The four CLAUDE.md anti-pattern checks return `severity:'veto'` on failure; `runChecks` result shape unchanged.
- `inconclusive` / inapplicable diff test adds no confidence: fusion falls back to 0.6/0.4, and the proposal proceeds only with a unanimous jury approve and every AST check passed.
- Gate and fusion read only `JuryVerdict` / `DiffTest` contract fields (`p_preserves`, `agreement`, `verdict`, `applicable`); drop reads of `jury.preserves_semantics` and `diff_test.score`.
- `signature_drift` scans only files whose text matches the name with a word-boundary regex, caps parsed files (e.g. 200) and caches parses per run; over the cap → check passes with `detail` saying it was capped.
- **Accept:** `node audit/1/ast-checks-cannot-block.js` reports every case blocked; `node audit/1/mutation-corpus.js` escape count drops vs 21/36 with no new rejections of the safe corpus; `node audit/3/whatif-vs-gate.js` and `node audit/3/boundaries.js` show no non-contract reads; `node audit/2/ast-scale.js` p95 ≤ 300 ms on the 500-file fixture.
- **Verify:** `node --test test/hybrid-validator.test.js test/ast-checker.test.js test/orchestrator.test.js && npm test && npm run bench`

### SG10 — Anchors validate the region they replace (A1-H2, A2-C2, A4-H3)
- `applyEdit` returns the matched region; validators run on that region (re-run when it differs from `current_code`).
- Whitespace and fuzzy tiers refuse a match that changes whitespace inside string/template literals, crosses an ASI boundary, or alters Python indentation → `apply_failed` with tier/detail.
- Fuzzy tier bounded: candidate windows pre-filtered by line-hash/token anchors, total work O(n·k); hard cap → `apply_failed` reason `fuzzy_budget`.
- Tests for whitespace-tier uniqueness (two copies → refuse).
- **Accept:** `node audit/1/validated-vs-applied-region.js` all cases refused or validated on the applied region; `node audit/2/anchor-patho.js` p95 ≤ 100 ms on ≤ 200 KB files, worst case < 1 s; new uniqueness test fails on the old code.
- **Verify:** `node --test test/anchor-matcher.test.js test/reverter.test.js && npm test && npm run bench`

### SG11 — Diff test that exercises the code (A1-H3, A1-H4, A2-H2)
- Input generation: objects/arrays/callbacks plus literals mined from both versions; arity-aware.
- All-throw (both sides throw on every input) or < N non-throwing runs → `inconclusive`, never `equivalent`.
- Every changed callable is tested (incl. object-literal methods, getters, class methods); top-level `require` of non-builtin modules gets inert stubs; changed constants compared by value.
- Per-call timeout on one side only, or on both, → `inconclusive` with reason; only value/throw mismatches are `divergent`.
- **Accept:** `node audit/1/difftest-holes.js` has no `equivalent` on a semantics-changing case; `node audit/2/diff-patho.js` under load shows 0 divergent verdicts for identical code; bench diff p95 ≤ 2000 ms.
- **Verify:** `node --test test/diff-testing.test.js && npm test && npm run bench`

### SG12 — Test-execution evidence and bounded runner (A1-C1 executor part, A1-M4, A2-C1, A4-H1)
- JS: run tests with `NODE_V8_COVERAGE` into a temp dir; the edit is kept only if a test executed at least one edited line. Otherwise `reverted` with reason `edit_not_exercised`. Python: `coverage run` when available, else `reverted` reason `no_coverage_tool`.
- `runTests` resolves on child `exit` + timeout, not stdio `close`; kills the process group; held stdio no longer delays the result.
- Tests for revert paths: timeout, environment error, commit failure, spawn failure.
- **Accept:** `node audit/1/e2e-commit.js` no longer commits the guard-removal edit; `node audit/2/tests-load.js` setsid case returns in < timeout + 2 s with the real status; the four revert-path tests fail on the old code.
- **Verify:** `node --test test/test-runner.test.js test/executor.test.js && npm test`

### SG13 — Per-target session and worktree sync (A3-H2, A4-H2, A3-M1)
- `session.json` lives under `stateDirFor(repo)`; legacy global session is read once for its own `target_repo` only.
- Worktree dirty-file sync parses `git status -z` without trimming entries (rename entries handled).
- Resume reconciles the session with `refactor/<run_id>` commits (proposal ids in commit trailers) before acting.
- **Accept:** `node audit/3/resume-scope.js`, `node audit/4/worktree-dirty-sync.js`, `node audit/3/resume-after-commit-crash.js` all pass; dashboard server watches the per-target session.
- **Verify:** `node --test test/state-dir.test.js test/worktree.test.js test/orchestrator.test.js` (`worktree.test.js` new)
- **Verify (all):** `npm test`

### SG14 — Test-backed commit bar (A5-C1, A5-C2, A5-C3, A5-H6, A5-M2, A7-H2)
- Commit bar: an edit is kept only if (a) the jury approves unanimously, (b) no persona has `p_preserves` < 0.2, (c) the diff test is `equivalent`, or for `runs=0` edits a deterministic check covers it (below), and (d) the tests kill at least one bug-injected mutant of the edited lines (reuse `rl/bug-injector`), so the suite is shown to be sensitive to them. Otherwise `critic_rejected` / `reverted` with a reason; no new status.
- Coverage evidence ignores comments and whitespace; every changed function body (or hunk) must execute. A failing suite that never executed the edit is also an untested revert (not a label-0 sample, no reward, no Reflexion repair) (A7-H2, `node audit/7/untested-failure-label.js`).
- Proposals to test files (`test/`, `__tests__`, `*.test.*`, `*_test.py`, `test_*.py`) are rejected by the Analyzer and the gate.
- Python: lexical checks for removed `raise`/guard and changed comparison operators/literals as vetoes.
- **Accept:** `node audit/5/e2e-commit.js` commits none of E1–E8; `node audit/5/critic-edge-cases.js` ok; benign corpus false rejection reported in the Log row.
- **Verify:** `node --test test/executor.test.js test/test-runner.test.js test/hybrid-validator.test.js test/orchestrator.test.js && npm test && npm run bench`

### SG15 — Diff-test reach, round 2 (A5-H1–H5, A5-L1, A5-M1)
- Compare all module-scope bindings and interactions recorded during load; any differing top-level statement → at best `inconclusive`.
- Returned functions get shaped inputs and `this`; locate prototype/assigned/defineProperty/arrow-field/anonymous-export/ESM-default/IIFE callables.
- Skipped targets (cap) or an exhausted time budget → `inconclusive`; per-target minimum of value-returning runs before `equivalent`.
- Boundary inputs from mined literals (±1, repeats, case flips, metacharacter swaps, lengths around mined numbers); stubs return varied values; inert `process`/`setTimeout`/`Buffer` globals or `inconclusive` when the edit references them.
- Differences only on inputs outside the original's evident domain → `inconclusive`, not `divergent`.
- **Accept:** `node audit/5/mutation-corpus.js` escapes with the split jury 0/97 and with the unanimous jury reduced to the Python/`runs=0` cases that SG14 covers; benign false rejection ≤ 2/31; bench diff p95 ≤ 2000 ms.
- **Verify:** `node --test test/diff-testing.test.js && npm test && npm run bench`

### SG16 — Performance, round 2 (A6-C1, A6-C2, A6-C3, A6-H1, A6-H2)
- V8 coverage post-processing is linear (sorted ranges, interval sweep), runs off the main thread or incrementally, and counts toward the test timeout; a budget overrun → `reverted` reason `coverage_timeout`, not `edit_not_exercised`.
- coverage.py: report only the edited file (`coverage json --include`), within the test timeout; same reason on overrun.
- Dirty-file sync never silently skips: no fixed 1 MB output cap (stream or large `maxBuffer`); on failure the run stops with an error instead of validating HEAD.
- Polyglot `signature_drift` gets the JS bounds (word-boundary filter, file cap, parse cache, early stop); JS scan prefers files that `require`/`import` the edited module and stays ≤ 300 ms p95 with common names.
- **Accept:** `node audit/6/coverage-load.js --quick`, `node audit/6/coverage-py.js --files 50`, `node audit/6/session-resume-scale.js --parts d`, `node audit/6/drift-scan.js` all within budget / ok.
- **Verify:** `node --test test/test-runner.test.js test/worktree.test.js test/ast-checker.test.js test/polyglot-ast.test.js && npm test && npm run bench`

### SG17 — Learning identity and safe resume (A7-H1, A7-H3)
- Samples and calibration points are de-duplicated by the edit (issue_id + hash of `proposed_code`, or the mutant id), not by `issue_id` alone; a different edit of the same snippet in a later run adds a sample instead of replacing one. Sample contract fields unchanged.
- `--resume` on a git target never falls back to in-place editing: if the run worktree or `refactor/<run_id>` branch can't be re-attached, recreate the worktree from the branch, or stop with an error; `session.worktree` is not overwritten by a fallback.
- **Accept:** `node audit/7/sample-identity.js` and `node audit/7/resume-worktree-gone.js` ok; target working tree untouched in both.
- **Verify:** `node --test test/collector.test.js test/calibration.test.js test/orchestrator.test.js && npm test`

### SG18 — Mutation evidence on the change; richer JS oracle (A8-C1, A8-C2, A8-H1, A8-H2, A8-L1)
- Mutation evidence must target the change itself: mutants only of tokens/statements that differ between `current_code` and `proposed_code`, and every changed hunk needs its own killed mutant. A pure deletion has no mutable text: it commits only with an `equivalent` diff test that observes the deleted effect; otherwise `reverted` reason `tests_insensitive`.
- Diff-test oracle compares observable effects, not just JSON return values: console/stdout calls, property descriptors/frozenness/prototype, key order, mutation of arguments and globals, thrown error types; host-global sniffs (dotted/bracketed/`globalThis`, `Date`/clock) make the verdict `inconclusive`. Per-target minimum of value runs raised (≥ 10 where inputs allow).
- **Accept:** `node audit/8/e2e-commit.js` commits none of X1–X5; `node audit/8/mutation-corpus.js --only LG1,LG5,VS1,VS3,VS8,VS11,BI1,BI3,DM1,DM7,HG1,HG3,HG5,HG6,HG7` no escapes; `node audit/5/e2e-commit.js`, `node audit/5/mutation-corpus.js` no regressions; benign JS false rejection reported.
- **Verify:** `node --test test/diff-testing.test.js test/executor.test.js && npm test && npm run bench`

### SG19 — Python differential test (A8-H3, A8-M1)
- Run current vs proposed Python callables in an isolated `python3 -I` subprocess (no network, temp cwd, time and memory bounded), with literal-mined and boundary inputs, comparing return values, exceptions, argument mutation and stdout; verdicts use the DiffTest contract (`equivalent`/`divergent`/`inconclusive`). The gate then treats `.py` like JS. Relax `condition_change` to not veto when the Python diff test says `equivalent`.
- **Accept:** `node audit/8/mutation-corpus.js --only PA1,PA3,PA6,PA10,PA13,PA16,PA18,PA23` no escapes; Python benign false rejection ≤ 2/12 (`--benign`); diff p95 ≤ 2000 ms for Python fixtures.
- **Verify:** `node --test test/diff-testing.test.js test/polyglot-ast.test.js && npm test && npm run bench`

### SG20 — Performance, round 3 (A9-C1, A9-C2, A9-H1, A9-H2, A9-H3, A9-H4)
Audited at eb29324 (before SG18/SG19): re-run each repro on the current head first.
- Diff-test input construction is size-bounded (cap elements/bytes per input and per run) and counted inside the time budget/hard kill, in the worker, not on the main thread.
- Mutant budget is based on an uninstrumented timing of the suite (or the main run minus coverage cost), so suites up to the 60 s timeout get mutant runs; if no mutant can run, the reason is `mutation_budget`, not `tests_insensitive`.
- `editMutants`/`changeHunks` linear in edit size (token diff bounded, cap input size; over cap → no mutants → `mutation_budget`).
- A mutant counts as killed only on a test failure, not on a timeout; a timed-out mutant is re-run once or ignored.
- Module-state snapshots are incremental/bounded (hash or size cap; over the cap → compare once at the end, not after every call).
- Python drift scan gets a byte cap like JS (2 MB).
- **Accept:** `node audit/9/diff-explosion.js`, `node audit/9/validator-explosion.js`, `node audit/9/mutant-budget.js --suite-s 29,31,45`, `node audit/9/mutant-budget.js --lang py --suite-s 30,40`, `node audit/9/edit-mutants.js`, `node audit/9/mutant-timing.js --mode jitter --repeat 20`, `node audit/9/diff-state.js`, `node audit/9/drift-caps.js --cases c` all within budget / ok.
- **Verify:** `node --test test/diff-testing.test.js test/executor.test.js test/bug-injector.test.js test/polyglot-ast.test.js && npm test && npm run bench`

### SG21 — Never edit a git target in place (A10-C1, A10-M2)
- A git repo with commits never falls back to in-place editing: if `git worktree add` fails, retry with a non-colliding branch name (e.g. `refactor-run/<run_id>` when a `refactor` ref blocks the namespace), else stop with `EWORKTREE` and leave the target untouched. In-place stays only for non-git / no-commit targets.
- A crash snapshot (`inflight.json`) pointing at a missing worktree is discarded with a warning instead of failing every later run.
- **Accept:** `node audit/10/branch-namespace-in-place.js` and `node audit/10/inflight-worktree-gone.js` ok; target working tree untouched.
- **Verify:** `node --test test/worktree.test.js test/orchestrator.test.js test/executor.test.js && npm test`

### SG22 — Enforce the commit bar on deletions and per-hunk evidence (A12-C1, A12-C2, A12-H3, A12-H4)
- A deletion is "observed" only if the deleted expression itself executed (probe the deleted sub-expression / branch, not the enclosing statement), in JS and Python.
- Every deleted token, including in hunks that also insert, needs observation or a killed mutant that touches it; a hunk is covered only if each changed token run is covered.
- Mutation evidence must be relevant: a killed mutant counts for a hunk only if it mutates the token run that carries the behaviour change (operators/literals/calls actually differing between current and proposed), not any changed token in the hunk.
- Module-state comparison catches mid-run differences again without the SG20 cost (rolling hash per call, full compare only on hash mismatch).
- **Accept:** `node audit/12/e2e-commit.js` commits none of Y1–Y9; `node audit/12/mutation-corpus.js --only J60,J61` no escapes; audit/5, audit/8 e2e still commit nothing; `node audit/9/diff-state.js` still within budget.
- **Verify:** `node --test test/diff-testing.test.js test/py-diff-testing.test.js test/executor.test.js test/bug-injector.test.js && npm test && npm run bench`

### SG23 — Pin every safety rule with a test (A11-C1–C6, A11-H1–H3, A11-M1)
- Add tests so that each surviving safety mutant in `audit/11/mutants.js` (C1–C6, H1–H3 lists) is killed by `npm test`; fix the real defects they expose (two timed-out mutant runs must not count as a kill; an exception during mutation evidence must revert, not pass; dirty-sync / re-sync copy failures must stop the run; resume on a target that is no longer a git repo must not edit in place; `git add` stages only the edited file).
- Coverage tooling counts worker threads (diff-prep / sandbox workers) so `src/validation` is measured correctly (≥ 85% lines by Node's report or a documented `npm run coverage` that includes workers).
- **Accept:** `node audit/11/mutants.js` on SG22's head: every listed C/H mutant killed (mutant ids may need re-anchoring after SG22; keep their intent); audit/5, audit/8, audit/12 e2e commit nothing.
- **Verify:** `npm test && npm run bench && node audit/11/mutants.js`

### SG24 — Performance, round 4 (A14-C1, A14-H1–H4)
- A mutant kill must reproduce: a failing mutant run counts only if a second run of that mutant also fails and an unmutated re-run passes (flaky/timing suites can no longer provide evidence); budget accordingly.
- Python diff test: linear offset mapping for deletion probes (no per-token rescans); work on ≤ 200 KB modules finishes inside the budget (only parse/probe what the edit touches); reasons name the real cause.
- Per-site mutant generation is async/bounded (no synchronous multi-second parse loop); Python mutants parsed in one batch; over budget → `mutation_budget`, not `tests_insensitive`.
- Per-call module-binding digests are bounded like SG20's export state (incremental hash, size cap).
- **Accept:** `node audit/14/mutant-flaky.js --mode timing --repeat 20 --busy 8` keeps 0; `node audit/14/py-deletion.js`, `node audit/14/diff-size.js --lang py --kb 100,150,199`, `node audit/14/edit-sites.js --lang py --hunks 4,16 --sites 6,12 --contend 8`, `node audit/14/diff-bindings.js --kind const` within budget / ok; audit/5, audit/8, audit/12 e2e commit nothing.
- **Verify:** `npm test && npm run bench`

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
| 2026-10-19 | SG7 | green | SG7 tests 17/17, `npm test` 133/133, `state/`+`dashboard/` untouched. Per-request render + in-place swap on SSE; inline JSON in `application/json` script with escaping; spans carry trace/parent/start/end; probe wired in; `--serve` server now unref'd (stops at run end). Open for SG1/SG5: orchestrator should import `RL_GATE_THRESHOLD` from `rl/classifier.js` and pass `trace_id` to `trace()`; confirm veto object shape; server watches global `sessionPath()`. |
| 2026-10-19 | SG3 | green | ast/polyglot tests 26/26, `npm test` after merge with SG7 green, bench ast p95 ~1 ms. `runChecks` adds `splice{ok,reason,occurrences}`; `severity:'veto'` only for parse errors introduced by the proposal. Open for SG1: treat `severity:'veto'` as hard veto. Python/Go remain lexical; Python return check only flags losing all value returns. `@babel/traverse` now unused. |
| 2026-10-19 | SG1 | green | critic/validator tests 24/24, `npm test` 172/172, bench all stages within budget. Jury `p_preserves` (mean) drives fusion; vetoes (divergent diff test, `severity:'veto'` check, unanimous reject) → `vetoed`; gate also requires jury majority approve AND `p_preserves >= MIN_CRITIC_P` (0.5) so AST+diff can't outvote the critic; `fileSrc` wired; `RL_GATE_THRESHOLD` shared; `run_id`/`trace_id` on traces. Fixture `js-basic-safeparse` now `vetoed` (intended). Malformed critic output counts as reject. Open for SG6: features/bug-injector/classifyFailure still read the `claude_confidence` alias. |
| 2026-10-19 | SG5 | green | executor+e2e 12/12, `npm test` 184/184, bench within budget. Edits run in a git worktree on `refactor/<run_id>` with one commit per passing proposal (non-git targets fall back in-place with a warning); SIGINT/crash restore via on-disk snapshot; process-group kill; Executor Claude call removed; `apply_failed` carries tier/detail; deterministic issue_id; `--resume` skips Analyzer and runs pending repairs; replay rerun makes 0 calls. `pruneContext` removed, CLAUDE.md updated. `--allow-untested` dropped (would need a contract change). Open: worktrees not cleaned up after runs; dashboard/reward still mention dead `applied_no_tests`. |
| 2026-10-19 | SG6 | green | SG6 tests 30/30, `npm test` 204/204 after merging with SG5, bench within budget. Per-target samples/weights/calibration accumulate across runs; features `[p_preserves, pattern_score, proposal_complexity, risk_estimate]` (legacy 5-feature weights ignored); synthetic negatives re-scored via AST + diff test, equivalent mutants dropped, ≤3 per pass, weight 0.5; gate p_pass = min(classifier, calibrated combined) when trained; reward documented as diagnostic. Open: calibration still only sees combined ≥ 0.5 (selection bias); old global RL files not migrated; dashboard label still says "RL gate". |
| 2026-10-19 | audits r1 | 4 audits done | AUDIT-1 1C/4H, AUDIT-2 2C/2H, AUDIT-3 0C/2H, AUDIT-4 0C/3H (coverage ≥ 85% all dirs). C/H → SG9–SG13. SG8 waits on `ANTHROPIC_API_KEY`. |
| 2026-10-19 | SG12 | green | runner+executor tests 33/33, `npm test` 225/225, bench within budget. JS edits kept only if a test executed a changed character (V8 innermost-range count via `NODE_V8_COVERAGE` temp dir); Python via `coverage run` in pytest's interpreter, else `reverted` reason `no_coverage_tool`; `runTests` resolves on `exit` (+250 ms drain, hard bound timeout+1.5 s). `audit/1/e2e-commit.js` → `reverted` (`edit_not_exercised`), no commit; `audit/2/tests-load.js` hang-escape 0.5 s `passed`. 4 revert-path tests fail on old code; mutants E1/E2/T1 killed. Commit failure now also unstages the file. Untested reverts are not samples/calibration points and get no Reflexion repair (`collector.isLabeled`). Open: setsid daemons are not killed; Jest/babel/TS-transpiled sources fall outside V8 offsets (fail closed); non-JS/Python edits always `no_coverage_tool`; dashboard counts untested reverts as failed; CLAUDE.md still names `.refactor-coverage`. |
| 2026-10-19 | SG13 | green | state-dir+worktree+orchestrator tests 17/17, `npm test` 235/235 (10 new + 1 rewritten test, all 11 fail on old code). `session.json` under `stateDirFor(repo)` (`sessionPath(target?)`; no-arg = latest written, for the standalone server); legacy global session moved into its own target on first read only; `--serve` server pinned to the run's target (`start({targetRepo})`, standalone `--repo`). `syncDirtyFiles` parses untrimmed `git status -z`; rename/copy sync both paths. Resume reconciles with `refactor/<run_id>` commit `issue_id` trailers → `passed` + commit, sample collected, no re-run. `audit/3/resume-scope.js` M-scope-1 ok, `audit/4/worktree-dirty-sync.js` 3/3 ok, `audit/3/resume-after-commit-crash.js` ok. Open: M-scope-2 (AUDIT-3 M2, `--resume` after `--dry-run` executes nothing) still FINDING, out of SG13 scope; reconciled proposals get no synthetic negatives/reward; old global session of another target stays in `<state>/session.json` until that target runs. |
| 2026-10-19 | SG11 | green | diff tests 41/41 (18 new + 3 updated fail on old code, 2 adapted), `npm test` 222/222, bench difftest p95 126 ms; `difftest-holes` 13/14 divergent, D14 (snippet, no fileSrc) inconclusive, none equivalent; `diff-patho` 0 divergent incl. `--flaky` x10 with/without load (was 7/10, 5/10); mutation corpus escapes 21/36 -> 1/36. Inputs: code-shaped objects/arrays/recording callbacks (incl. promise), mined literals, omitted defaulted args, max arity of both sides; every changed callable (object methods, getters/setters, class methods/accessors/ctor) plus removed exports tested; changed constants compared by value; inert recording stubs for every `require` (builtins too); timeouts and hard kill -> inconclusive; < 3 normal returns or any stub-only difference -> inconclusive. `js-failing-after-edit` fixture proposal changed (the old `'hi'` edit is now vetoed). Open: inconclusive still fails open in the gate (M24, SG9); memory hog peak RSS ~440 MB (A2-M4); env sniffing (A1-L1). |
| 2026-10-19 | SG9 | green | hybrid/ast/orchestrator tests 47/47 (10 new, all fail on old code), `npm test` 263/263, bench ast p95 0.9 ms / validator p95 143 ms. Four anti-pattern checks (JS + polyglot) veto on failure; gate reads only contract fields (majority/unanimity from `panel[]`, diff score from `verdict`; `reward.js` too); unconfirmed edits fail closed: `inconclusive` with `runs > 0` → `critic_rejected` (closes M24), otherwise unanimous approve + all checks passed; `signature_drift` word-boundary filter, 200-file cap (detail says capped), stop at first call site, per-run parse cache. `ast-checks-cannot-block` vetoed (4 check vetoes); mutation corpus escapes 1/36 → 0/36; ad-hoc 25-case benign corpus 2 → 4 rejected (new: stub-only diff `fs.readFileSync(p,'utf8')`→`{encoding}`, and a both-sides-ReferenceError function); `ast-scale` (b) K=500 p95 7 ms (was 6.7 s), (c) validator 124 ms. `js-failing-after-edit` fixture proposal changed (old edit now `critic_rejected`); `audit/3/boundaries.js` reads the per-target session (stale since SG13). Open: what-if/counterfactual model only the classifier term (AUDIT-3 M-whatif-1, L-whatif-2); reflexion step has no span (A3-L7); critic/diff-test still emit legacy aliases (unread); ast-scale (a) 199 KB no-drift file p95 ~300–560 ms (A2, pre-existing); B24-style all-throw benign edits now rejected. |
| 2026-10-19 | SG10 | green | anchor+reverter tests 34/34 (14 new), `npm test` 280/280 (17 new: 15 fail on old code, the 2 whitespace-uniqueness tests kill mutant A1), bench apply p95 37 ms. `applyEdit` returns `matchedRegion` and takes `expectedRegion` (mismatch → `apply_failed` tier `region`); orchestrator resolves the anchor before validation (`proposal.validated_region`) and, unless verbatim, runs critic/AST/diff test on the matched region + re-indented replacement; executor requires the same region. Whitespace/fuzzy tiers lex region vs anchor and refuse `literal_whitespace` (string/template/regex), `comment_boundary`, `asi_boundary` (JS restricted productions), `line_structure` (non-JS/Python), `indentation` (Python). Fuzzy: q-gram bound pass O(n), best-bound-first scoring with memo/overlap pruning, 1e7-cell cap → `fuzzy_budget`; indent-shift KMP prefilter; exact/whitespace count capped at 100. `validated-vs-applied-region` W1/W2/W3 refused; `anchor-patho` all 8 cases p50 ≤ 70 ms, max 86 ms (was 45.8 s / >25 min). Open: anchor refusals are only reported at execution (dry run still says `dry_run`); a legitimately ambiguous large near-dup anchor can now end in `fuzzy_budget` instead of `ambiguous`; `audit/4/mutants.js` not run here (worktree has no local `node_modules`, so its temp-copy baseline is red; A1 pattern updated and A1 checked by hand). |
| 2026-10-19 | audits r2 | AUDIT-5 | round-1 C/H fixed (5/5); new corpus 54/97 escape (unanimous), 34/97 (split), 8 committed e2e, benign false rejection 6/31. 3C/6H/3M/1L → SG14, SG15. Commit bar for SG14 asked of the user; proceeding on the test-backed bar. |
| 2026-10-19 | audits r2 | AUDIT-6 | round-1 setsid hang and fuzzy blowup fixed; 3C/2H/5M/7L (coverage post-processing up to 110 s, coverage.py 30 s cap, dirty sync skipped over 1 MB, polyglot/common-name drift scan 1–3 s) → SG16. Order: (SG14 ∥ SG15) → SG16. |
| 2026-10-19 | audits r2 | AUDIT-7 | round-1 highs fixed; 0C/3H/6M/6L new (labels overwritten across runs, failing untested suite labelled 0, resume edits target in place) → SG17 (H1, H3), SG14 (H2). Order: (SG14 ∥ SG15) → SG16 → SG17 → audit round 3. Coverage audit (round 2) folded into round 3 since SG14–SG17 change the covered code. |
| 2026-10-19 | SG14 | green | executor+runner+hybrid+orchestrator tests 82/82, `npm test` 305/305 (25 new, all fail on old code), bench ast p95 1.0 / difftest 118 / validator 113 ms. Gate: unanimous approve, persona p ≥ 0.2, no listed edge case, `equivalent` diff test; JS `runs=0` → `critic_rejected` (stricter than "AST checks": E6 passes them); non-JS `runs=0` needs every check incl. new Python lexical vetoes (`guard_removal`, `condition_change`); test files rejected by Analyzer and before the critic. Executor: per-function coverage, comments/docstrings no evidence; red suite without the edit → `edit_not_exercised`; ≤3 parse-valid mutants of the changed chars (else edited lines, `bug-injector.editMutants`) re-run the whole suite in the shared 60 s budget (each ≤ 2× main + 1 s), none killed → `reverted` `tests_insensitive` (untested). Fresh `PYTHONPYCACHEPREFIX` per run. `e2e-commit` 0/9 committed (E1–E5 split jury, E6 runs=0, E7 test file, E8 Python veto); `critic-edge-cases` ok; `untested-failure-label` ok; corpus escapes U 54→38/97 (JS 34/87 diff-test `equivalent`, Python 4/10: PY5/6/8/10), M 34→0/97; benign false rejection 6/31 (unchanged, all divergent: B03/B12/B15/B19/B20/B21). No fixture status changed. Open: with a unanimous wrong jury E1 still commits (string mutant killed); E2–E5 are caught by the executor (`tests_insensitive` / `edit_not_exercised`); corpus measures the gate only, so executor false rejections (`tests_insensitive` on benign edits with weak suites) are unmeasured; mutants re-run the whole suite, not just the files that ran the edit; edge-case rule depends on the critic honouring the prompt. |
| 2026-10-19 | SG15 | green | diff tests 53/53 (12 new, all fail on old code; 1 adapted), `npm test` 292/292, bench difftest p95 125 ms; AUDIT-5 corpus escapes U 54/97 → 10/97 (Python only, runs=0), M 34/97 → 0/97, benign false rejection 6/31 → 1/31 (B12: mixed-type arrays are in its evident domain); `audit/1/mutation-corpus.js` 0/36; `diff-patho` no divergent on identical code. Module-scope bindings + exports compared after load and every call, load-time stub interactions compared, returned-object identity, changed module-state writes / uncovered top-level statements / host-global references / target cap / unrun inputs → inconclusive; per-target min value runs = min(10, max(⌈inputs/5⌉, 3)); callables located in prototype/assigned/defineProperty/class fields/computed keys/anonymous + ESM default/nested namespaces/if blocks/IIFEs; returned functions probed with shaped + boundary args and owner `this`; boundary sweep from mined literals and regex samples; stubs vary call-result properties and numeric coercions; Date fixed. Fixture `js-failing-after-edit` now reads `process.env` at load (diff test runs=0) and proposes `'hi'`, since env sniffing is no longer equivalent. Open: inputs outside the original's static domain are not generated, so differences confined to them go unseen; no inert `process`/`setTimeout`/`Buffer` (modules touching them at load stay runs=0); SH4-style slow functions take ~1.6 s. |
| 2026-10-19 | SG14+SG15 integration | green | `npm test` 317/317 (x2), bench ast p95 0.96 / difftest 134 / validator 133 ms; `audit/5/e2e-commit.js` 0 committed (E1/E3–E6 now diff-test `divergent`); mutation corpus escapes U 4/97 (Python PY5/6/8/10, JS 0/87), M 0/97, benign false rejection 1/31 (B12). No src change: SG15 now catches the old fixtures, so C1/K2 use a console-only edit (sandbox console is a no-op → `equivalent`), E6 reads `process` at load (runs=0), `js-failing-after-edit` proposes a log-message change its suite catches via a mocked `console.log` (passes the gate, reverted, 1 Reflexion). Open: the sandbox never sees console/host-global side effects, only the suite or jury can. |
| 2026-10-19 | SG16 | green | runner+worktree+ast+polyglot tests 82/82, `npm test` 324/324 (19 new, all fail on old code; 2 drift tests adapted to importer files), bench ast p95 1.5 / difftest 106 / apply 37 / validator 107 ms. V8 coverage: line starts once + binary search, one sorted interval sweep per script (innermost range/function), async with a turn between coverage files, deadline = test budget → `reverted` `coverage_timeout` (untested, no label); `coverage-load --cases span` post-exit 64–170 ms for 2–190 KB spans (was 1.1–49.6 s), `--quick` 50 procs × 20 KB 238 ms (was 28.8 s), max stall 146 ms. coverage.py: `coverage json --include <edited file>` async in the remaining budget; `coverage-py --files 50` exercised `true`, post-exit 968 ms (was 30,036 ms, false `edit_not_exercised`). Test runs set `NODE_V8_COVERAGE=''` unless evaluated, so mutant runs collect nothing; mutant budget counts the main run's coverage time. Dirty sync: no `maxBuffer` cap, status/copy failure throws (worktree + branch removed, run stops), directory entries (submodules) skipped; `session-resume-scale --parts d` 25k untracked → 25,001 synced, modified file reached (was 0). Drift: JS plain functions scan only lexical importers (quoted `.`-specifiers), importers first, parse only on a call-shape match, ≤200 files and ≤2 MB parsed; polyglot word-boundary filter, module-naming files first, 200-file cap, strip cache, early stop; walk cap 500 → 2000. `drift-scan` (a) cold 51 / warm 36 ms (was 2,729), (b) Python 27 / 22 ms (was 1,145), (d) caller after the cap now found (AUDIT-6 M2). `e2e-commit` 0/9 committed. Open: comment-mask Babel parse of a multi-MB edited file still blocks ~0.25 s/MB; method drift with common names is a capped pass after 2 MB; CLAUDE.md not updated (cap wording, `coverage_timeout`). |
| 2026-10-19 | SG17 | green | collector+calibration+orchestrator+worktree tests 41/41 (9 new, all fail on old code; 1 calibration test adapted to the extra field), `npm test` 345/345, bench ast p95 0.95 / difftest 133 / apply 23 / validator 130 ms. Samples and calibration points keyed by optional `edit_id` = `issue_id:sha256(proposed_code)[:16]` (mutants `+::mutation`); stored entries without it keep their `proposal_id` key; contract fields unchanged. `resumeWorktree` re-creates a missing worktree from `refactor/<run_id>` (prune, re-sync dirty files except branch-changed ones), else throws `EWORKTREE` (CLI exit 2), `session.worktree` untouched; in-place fallback only via `createWorktree` (fresh run / non-git). `sample-identity` ok (repro moved to the log-message edit; old one is now `critic_rejected`), `resume-worktree-gone` ok both cases (repro accepts the documented stop-with-error), target clean; `e2e-commit` 0 committed. CLAUDE.md: SG16 drift-scan bounds, `coverage_timeout`, resume/learning identity. Open: a legacy (pre-`edit_id`) sample and a re-collection of the same edit count twice; a recorded in-place session on a git target resumes via `createWorktree`, whose `worktree add -b` failure still falls back in place. |
| 2026-10-20 | audits r3 | AUDIT-8 | prior C/H repros 9/9 still fixed; 2C/3H/1M/1L new (mutants on unedited lines / unrelated tokens; JSON-only oracle; host sniffs; Python lexical-only) → SG18, SG19. |
| 2026-10-20 | SG18 | green | diff+executor+bug-injector tests 95/95 (14 new, all fail on old code; 2 adapted), `npm test` 359/359, bench ast p95 1.2 / difftest 172 / apply 27 / validator 172 ms. Mutation evidence per change hunk (`src/utils/hunks.js`: line diff, then token diff, comments ignored): mutants only of inserted/changed tokens, each hunk needs its own kill; a deletion-only hunk stands only on an `equivalent` diff test whose probes (`__dt.hit` before the deleted statements) ran (`deletions_observed`), else `reverted` `tests_insensitive`; no line fallback. Oracle: console recorded (load + calls), builtins/global object diffed against a setup snapshot, objects carry key order, attribute prefixes (non-enumerable/read-only/non-configurable/getter/setter), frozen/sealed/non-extensible, null prototype; registered symbols; thrown `e.name`; `globalThis`/aliases/`Date`/`Function` reference counts → inconclusive; constant-folded numeric literals, astral strings, -0; ≥ 10 value runs per callable target (value-returning inputs re-run, one in five distinct inputs still required). `audit/8/e2e-commit` 0/6 committed (X1–X4 vetoed by the diff test, X5/X6 `tests_insensitive`); `--only` list 0/15 escapes; full AUDIT-8 corpus JS 35/59 → 3/59 (DM3/DM5/DM8), Python 23/24 (SG19); benign JS 2/22 (N06, N10, unchanged), Python 5/12; `audit/5/e2e-commit` 0 committed, `audit/5/mutation-corpus` U 4/97 (Python only), M 0/97, benign 1/31 (unchanged). Fixtures: `js-failing-after-edit` now proposes a BigInt-only log change its suite catches (console edits are divergent now); hybrid C1/K2 use a >1000-char truncation; `audit/7/sample-identity.js` run 1 moved to the same edit. Open: executor false rejections rise for edits whose changed tokens no operator mutates (renames, reorders) and for JS deletions in unprobeable places; inputs past 1000 chars, deep nesting and BigInt still unseen. |
| 2026-10-20 | audits r3 | AUDIT-9 | prior perf C/H all fixed; 2C/4H/6M/6L new (diff-test input explosion, mutant budget from instrumented run, quadratic mutant generation, slow mutant counts as kill, state snapshots, Python drift byte cap) → SG20 after SG19. |
| 2026-10-20 | audits r3 | AUDIT-10 | prior contract highs fixed; 1C/0H/9M new (in-place fallback when `worktree add` fails on a git repo) → SG21. |
| 2026-10-20 | SG21 | green | worktree+orchestrator+executor tests 55/55 (4 new, all fail on old code), `npm test` 363/363. `createWorktree` on a git repo with commits retries a failed `worktree add` once on `refactor-run/<run_id>` (`refactor-run-<run_id>` when a `refactor-run` branch exists), cleaning up the half-finished add, else throws `EWORKTREE` (CLI exit 2, session.worktree not set); in-place only for non-git / no-commit targets, so a recorded in-place session on a git target now resumes into a worktree. `restoreFromDisk` discards (warns, deletes) a snapshot whose `repo_root` is gone. `branch-namespace-in-place` C1a/C1b ok, `inflight-worktree-gone` ok, `audit/7/resume-worktree-gone` ok both cases, targets clean. CLAUDE.md/README fallback lines updated. Open: worktrees still never cleaned up. |
| 2026-10-20 | SG19 | green | diff+polyglot+hybrid+py-diff tests 121/121, `npm test` 378/378 (19 new, all fail on old code; 1 adapted: the no-oracle gate test now uses Go), bench ast p95 1.0 / difftest 175 / validator 179 ms, py-basic diff p95 127 ms. `diffTesting.run` routes `file: *.py` (or `lang: 'python'`) to `py-diff-testing.js` → `py_diff_harness.py` in `python3 -I -B` (temp cwd, empty env, RLIMIT_AS 1 GB / CPU / FSIZE, audit hook refusing network/process/ctypes/writes outside cwd, non-stdlib imports as recording stubs, per-call 250 ms timer, SIGKILL at 3 s, children die with the parent); each side in a forked child, current twice (nondeterminism → inconclusive); inputs shaped by parameter use/defaults with mined + boundary literals; compares values (floats rel 1e-9), exception types (+args when raised explicitly), args/self after call, returned identity, stdout/stderr, module state, cwd files, stub calls; Python deletions probed (`deletions_observed`). Gate: `.py` like JS (`runs=0` → rejected); `condition_change` veto → score when the diff test is `equivalent` (`guard_removal` kept); synthetic mutants of `.py` re-scored by the diff test. `--only PA1,PA3,PA6,PA10,PA13,PA16,PA18,PA23` 0/8; full AUDIT-8 corpus Python 0/24 (JS 3/59 unchanged: DM3/DM5/DM8); benign Python 1/12 (NP2, `guard_removal`), JS 2/22 unchanged; `audit/5/mutation-corpus` U 0/97, M 0/97, benign 1/31; `audit/5/e2e-commit` and `audit/8/e2e-commit` 0 committed. No fixture changed. Open: Python inputs never include tuples unless subscripted, deep nesting or very long strings; returned closures are not probed; user code can write to the result pipe fd; CLAUDE.md gate text still says non-JS. |
| 2026-10-20 | SG20 | green | Re-run at 4286334: C1, C2 (JS+py), H1 (wide spans; minified already fast after SG18), H2 (1/20), H3, H4 all still reproduced. diff+py-diff+executor+bug-injector+polyglot+collector+hybrid tests green, `npm test` 395/395 (13 new, all fail on old code; 1 replaced: budget test now asserts `mutation_budget`), bench ast p95 0.9 / difftest 282 (was ~175: prep worker) / apply 26 / validator 287 ms. JS diff test: parsing, targets and input construction run in `diff-prep-worker.js` (512 MB heap) which runs the sandbox worker, all inside the hard kill (reason names preparation vs sandbox, whole limit, never negative); a forced array length applies to one nesting level (outer, plus an `inner` variant when array elements are indexed), inputs capped at 64 KB each / 1 MB per target. Module state over 2,000 nodes is compared once per target (per-key hashes, 500k nodes) instead of per call. Mutant runs: own budget (test timeout), slices from plain suite time (main run until a surviving mutant run measures it), timeout re-run once and never a kill, out of budget → `reverted` `mutation_budget` (untested reason). `changeHunks` trims common tokens before the LCS (`capped` when over the cell cap); `editMutants` lazy/linear, > 16 hunks / 32,000 changed chars / capped → no mutants → `mutation_budget`. Python drift scan 2 MB byte cap (oversize files skipped, scan continues). Python harness checked: inputs already bounded (lists ≤ 60, built in the killed subprocess); unchanged. Measured: diff-explosion 9 cases 327–1,047 ms all equivalent (was 19,365 ms → 172 s); validator-explosion 455 ms, proceeds (was 19,225, rejected); mutant-budget JS 29/31/45 s all passed (58/62/90 s wall), py 30/40 passed; edit-mutants max 201 ms, wide spans 0 mutants in 0 ms (was 3–11 s, 3.6 GB); mutant-timing jitter 20/20 tests_insensitive (was 1/20 kept, audit 7/20); diff-state 10/10 cases equivalent 277–772 ms; drift-caps c cold 194/222 ms, warm 65/104 ms (was 6,152/6,189). `audit/5/e2e-commit`, `audit/8/e2e-commit` 0 committed; `audit/8/mutation-corpus` JS 3/59 (DM3/DM5/DM8, unchanged), Python 0/24, benign JS 2/22, Python 1/12 (unchanged). Open: deferred state misses a state change a later call undoes; JS drift first-file exemption (M1) and regexSamples (M2) untouched; executor worst case now ~2× test timeout per proposal. |
| 2026-10-20 | audits r4 | AUDIT-12 | prior repros fixed; 2C/4H/2M/2L new; fresh corpus 40/95 pass the gate, 8 committed e2e; benign gate rejection 12/48, executor over-revert 8/16. C1, C2, H3, H4 → SG22; oracle blind spots (H1, H2) pending the user's call on the bar. |
| 2026-10-20 | SG22 | green | diff+py-diff+executor+bug-injector tests green, `npm test` 405/405 (10 new + 2 adapted, all fail on old code; executor tests now carry the gate's `equivalent` diff test), bench ast p95 3.1 / difftest 367 / apply 26 / validator 396 ms. Deletion probes at each deleted token's own evaluation site (JS: braceless branch/loop body, right of &&/\|\|/??, ternary branch, default, arrow body, param entry; Python: if-expression branch, later and/or operand, lambda, comprehension, assert msg), deleted tokens of every hunk probed; executor needs them observed, or a one-for-one replacing stretch with a killed site. Relevance rule: a kill counts only for the token (site) it mutates, every site needs a kill, > 12 sites/hunk → `mutation_budget` (CLAUDE.md). Deferred state: per-call digest of small bindings/exports/owner (large objects marked once). Oracle (needed for Y2/Y6/Y7): named array props, user-prototype methods/getters of returned objects probed, Python log records of every level + warnings captured. `audit/12/e2e-commit` 0/9 committed; `--only J60,J61` 0/2; corpus gate escapes 40→32/95 (J50/J55/J59/J08/J09/P42 escape the gate with obs=false, reverted by the executor), benign gate 12/48 unchanged; `executor-benign` 8/18 committed (unchanged set); audit/5, audit/8 e2e 0 committed; diff-state 10/10 equivalent 359–1,114 ms (old code 367–1,142). Open: H1/H2 oracle and domain gaps otherwise untouched (P20/P21/P24/P27/P30/P32, J40); the relevance rule cannot see a change carried by an identifier (`slice(0, LIMIT)`). |
| 2026-10-20 | audits r4 | AUDIT-11 | AUDIT-4 highs fixed; coverage ≥ 85% in all dirs counting workers (Node's report misses diff-prep worker: validation 65.5%); 30/80 safety mutants survive → 6C/3H → SG23. |
| 2026-10-20 | SG23 | green | Tests only, no src change: every pinned rule already held at c2ea37f (26/27 C/H mutants survived there, PJ-del already killed by SG22). 22 new tests (worktree 4, executor 3 + SIGINT test now also SIGTERM, orchestrator 1, test-runner 1, hybrid 2, diff-testing 6, py-diff 4), each fails on its mutant; `npm test` 427/427 ×2, bench ast p95 2.3 / difftest 318 / apply 24 / validator 370 ms. `node audit/11/mutants.js`: all 27 C/H killed, safety 77/80 (left: T-grace M2, G-reconcile2 L1, W-readd M5), label 6/7, redundant 5/6, control 3/3; X-hunk/X-del/X-delobs re-anchored to SG22's per-site / `observed` / `unseen` code. `npm run coverage` (new, `scripts/`, counts diff-test workers): validation 94.2%, runner 93.0%, rl 97.7%, orchestrator 94.2% lines. audit/5, 8, 12 e2e 0 committed. Open: Python harness counts a run missing from the second current side as "differs through stubs" (budget cut downgrades with a misleading reason); diff-test `arity: 1e9` OOM-kills the host process (internal option only). |
| 2026-10-20 | audits r5 | AUDIT-14 | prior perf C/H fixed; 1C/4H/4M/5L new (flaky test failure counts as mutant kill, Python harness stalls/size limits, sync per-site mutants, per-call binding state) → SG24. |
| 2026-10-20 | SG24 | green | Mutant kill reproduces: fail, fail again, unmutated control passes, inside the existing 60 s mutant budget (unmutated failure = flaky = `tests_insensitive`; parse check not finished = `mutation_budget`). mutant-flaky timing busy 8: 0/20 kept (was 10/10). py-deletion 199 KB: 2–60 KB deletions 239–254 ms with the real reason (was 6.2–29.7 s hard kill at 10–60 KB), rewrites ~1.6 s "time budget reached". diff-size py 100/150/199 KB p50 434/560/736 ms, all equivalent (199 KB was inconclusive). edit-sites py contend 8: 387–521 ms, every hunk hit (JS was up to 6–10 s). diff-bindings const 500/2000/5000/9000: 295/409/701/1259 ms, all equivalent (9000 was inconclusive). Binding digests/values sent as per-call deltas (unchanged primitives skipped, one batched reader). `npm test` 438/438 ×2 (11 new + 3 adapted, each new one fails on old code); bench ast p95 1.0 / difftest 273 / apply 27 / validator 257 ms; coverage validation 94.2%, runner 93.0%, rl 97.3%, orchestrator 94.2%. audit/11: no new C/H survivors (safety leftovers T-grace, G-reconcile2, W-readd as at SG23); X-mutleft now redundant (control run writes the edit back), PH-nondet re-anchored. audit/5, 8, 12 e2e 0 committed. Open: suites over ~1/3 of the mutant budget now end `mutation_budget`; JS diff-test prep ~0.9 s at 165 KB; ~2000-binding modules load-sensitive under contention; Python per-call module_state still O(module dict); Python probes ~1 s per 20k deleted tokens. |
