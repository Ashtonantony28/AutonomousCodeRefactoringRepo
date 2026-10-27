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
  group killed, its coverage and bytecode temp dirs removed), state is
  flushed and the process exits 0. The pre-edit
  snapshot is also persisted (`<state>/targets/<sha256(repo)>/inflight.json`)
  so after a crash the next start restores it before doing anything else
  (a snapshot whose worktree no longer exists, or whose edit is already the
  worktree's `HEAD` commit, is discarded with a warning).
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
  comments, whitespace and docstrings are no evidence), and the change has
  per-token evidence (`utils/hunks.changeHunks`: line diff, then token diff
  per hunk, comments ignored):
  - **Inserted tokens — relevance rule.** Tokens come from a whole-file
    `utils/hunks.lexView` mapped to the changed lines, so a line inside or
    closing a multi-line template / triple-quoted string gets the literal's
    tokens: a template literal or f-string is its text parts and the tokens
    of its `${}` / `{}` interpolations; a JS regex literal is its body atoms
    and flags; any other string (backslash-continued ones too; a `\` +
    CRLF continuation is mis-lexed and fails closed) is exactly one
    `lexView` literal, a quote that starts none is no evidence, and a
    literal respelled to the same value (`'a'` → `"a"`, `120` → `0x78`) is
    no change (a number with no computable value, `0x1e+6000`,
    `6e3.toFixed`, compares by its text). A pure insertion or deletion slides to its leftmost
    bracket-balanced place, preferring one that starts with an operator or
    separator (`.f(x)` inserted, not `f(x).`; `, g(x)` after `g(x)`, not
    `g(x), `). A *site* is one
    inserted/changed token a mutation operator applies to (any numeric
    spelling, decimal/hex/octal/binary/exponent/`_`/BigInt/complex → value
    + 1; comparison, equality, `&&`/`||`/`??`/`and`/`or` swapped; an
    arithmetic, bitwise, shift, power or floor-division operator (or its
    compound assignment, `++`/`--`, unary `-`/`+`) → another of the same
    arity; `!`/`~`/`not`/`await` dropped; `in`/`instanceof` (JS) and a
    ternary test negated; `in` ↔ `not in`, `is` ↔ `is not`; `null`/`None` →
    `0`; boolean, `return`, `if`/`while` condition; a string, or a template /
    f-string text part → `x` added; a regex flag dropped, a quantifier bound
    + 1, any other regex atom dropped; `bug-injector.editMutants`,
    parse-valid on the smallest statement around it that parses alone,
    Python in one `python3` batch, up to 3 per site). Every site needs its
    own failing mutant run (a confirmed kill, below), and a kill counts only
    for the site it mutates: in `slice(0, 1000)` a kill of `0 → 1` covers
    `0`, never `1000`. **Fail closed per token:** every inserted or changed
    token except brackets, commas, semicolons, colons, regex delimiters and
    whitespace (a `;` or `,` that changes structure is not exempt: JS `;`
    as the empty body of an `if` / `else` / `for` (`for await`) / `while` /
    `with` / `do` head or before code the expression would continue into
    (`(`, `[`, template, `+`, `-`, `/`, same line or next; not `++` /
    `--`); a `,` or `;` with kept code of its own level on both sides, past
    inserted tokens (it splits an operand or a statement: `6000 - 1` →
    `6000 | 0, - 1`, `a && b` → `a; log(b) && b`); a JS comma operator next
    to kept code (`return a` → `return a, b`) or array elision (`[x,,]`);
    a Python `,` next to kept code that makes a tuple of a statement, a
    grouping paren, a subscript or an f-string field that held no kept comma
    (`if (c)` → `if (c, log(n))`, `{x}` → `{x,}`); Python `;` on a
    compound statement's logical line (a multi-line header included), a
    trailing comma at statement level, in a grouping paren (after any
    keyword: `if`, `elif`, `while`, `for`, …) or a subscript that holds no
    other comma of its own (a lambda's commas are not)) must lie inside the span every mutant of one site changes
    (the operator match, the literal token, the expression a use-site
    mutant perturbs); a name with no read of its own (a binding, key,
    keyword argument) needs a covered read of the same name, and `=` /
    `const` / `let` / `var` a covered token right after them. A token with
    no mutant of its own is covered by a use site only when that read is
    inside the token's own expression (its operand), never by a wrapper
    around it. A changed bracket or line indentation (one that does not just
    frame inserted code) is covered only by the call whose use site ends at
    it or a dropped prefix operator right before it; a sibling site inside
    the bracket pair or line never stands in. An inserted token nothing covers (an operator or
    keyword with no mutant: `typeof`, `=>`, `@`, a Python ternary, a new
    `def`, a moved bracket or indentation; an `if` / `elif` / `while` whose
    stretch deletes another keyword (`while`, `else`, `with`, `switch`,
    `try`, `match`, `async for` → `if`), which its own condition site does
    not cover) is no evidence
    (`tests_insensitive`, `mutation.uncovered_token`), whatever kills its
    siblings. More than 12 sites in one hunk is not judged
    (`mutation_budget`).
  - **Use sites.** Every inserted identifier or member the edit reads (not a
    keyword, declaration, parameter, assignment target, key, label, import
    name or type annotation) is a site of the hunk too, whatever binds it
    (local, destructured, tuple, conditional, imported, `this.`/`self.`
    attribute, nested default): one mutant perturbs the value where the
    edit uses it (the identifier with its member chain: number + 1,
    string + `~`, boolean negated, list/dict minus its last entry,
    null/`None` → 0, function result perturbed). A called name is that call,
    and the call is skipped: a value receiver takes its place, else (a plain
    function, `this`/`self`, a module, imported or capitalised namespace) its
    first non-literal argument, else the call's value is perturbed; a
    namespace or callee is never the replacement. A call or read in
    statement position is dropped. So `slice(0, MAX)` needs a kill of
    `MAX` at this use, and a kill through another consumer of `MAX` never
    stands in. A name that replaced another in its stretch (and is not
    deleted elsewhere in the hunk) also needs a kill of the old name put
    back (`revert_reference`) when every stretch of the hunk only swaps
    names; inside changed code (`includes` → `indexOf(x) !== -1`) it is no
    evidence. A read with no parse-valid use-site mutant is no evidence
    (`tests_insensitive`, `mutation.unmutated_ref`).
  - **Same-text switch.** Each mutant is written into the file as a
    runtime switch on an environment variable around the smallest
    expression (or a `return` statement) holding the site:
    `(_k === 'v' ? (mutant) : (original))`, Python `((mutant) if _k ==
    'v' else (original))`, where `_k` (a name the file does not use) is
    bound once per module load to the variable's raw value: JS `var _k =
    globalThis.process.env.K;` before the first statement (after a shebang
    / directive prologue, no line added), Python `_k =
    __import__('os').environ.get('K')` after the docstring and
    `__future__` imports (a string in mutant and control runs alike, so
    module state shows no flag); a site with no such place (a
    key, a pattern, a class-member name, code before the binding) has no
    mutant. `v` and the control's value are random 16-letter strings, new
    per edit. Mutant runs set `K=v`; the kill's third run (the control) is
    the same text with `K` set to the other value, so a test that reads the
    source (size, word count, layout, a grep) or the environment (its keys,
    flag-like values) fails or passes alike in both and is no kill
    (`mutation.control_failed` when no test is left).
  - **Deleted tokens (every hunk, also those that insert).** Each needs the
    diff test to be `equivalent` with `deletions_observed: true`: the
    current version is probed where the deleted token is evaluated (its
    statement, or the braceless branch / loop body, right of `&&`/`||`/`??`,
    ternary branch, default value, arrow body, parameter entry holding it;
    Python: its statement, if-expression branch, later `and`/`or` operand,
    chained-comparison tail (`<= b` in `a < n <= b`), lambda body,
    comprehension element/condition/later iterable, `match` guard), and
    every probe must run.
    Otherwise only a stretch whose deleted tokens are replaced by at least as
    many inserted tokens holding a site stands, on that site's kill.
  Mutant and control runs use the main run's command, interpreter, import
  path and env minus coverage (pytest always runs as `<pytest's python> -m
  pytest`, so the repo root is on `sys.path`). Kills are per test: each run
  reports per-test results (node:test TAP to a temp file through
  `NODE_OPTIONS`, unless the suite picks its own `--test-reporter`, or node
  refuses the added reporter, e.g. a delegated script sets one, and the run
  is repeated without it; pytest
  `--junitxml` with `--tb=short`), and a mutant is killed only when a test
  that passed in the switch-off control run fails in both mutant runs, each
  of which ran the same set of tests as the control. A run where a module
  failed to load (a test file process crashed, a failure raised from a
  module body — `Module._compile` / `in <module>`, or logged by the load
  hooks every run installs, children that keep the environment included:
  a preloaded `Module._compile` wrapper, an ES module load hook (a module,
  or a CommonJS one `import()` loads, loaded but not completed at exit; a
  process with an async loader, or on a node without `module.registerHooks`,
  gets none and counts as a load failure unless it is a node:test file
  process that exits 0), a sitecustomize wrapping `__import__` and the
  source loaders' `exec_module` (`importlib.import_module`, `reload`)
  (not `ImportError`) and logging a main module that raises, keyed by a
  pytest plugin; test files and
  `conftest.py` excluded, and a throw caught on purpose is none: logged
  inside a node:test test or suite callback (CJS `require('node:test')`, a
  subtest counting as its parent; names compared as TAP ids: `\#` / `\\`
  unescaped, control characters as TAP writes them) that
  passed (with no reported test or suite of that name, as below), elsewhere in a node:test
  file process that exits 0 (not a child it spawns, though that inherits
  `NODE_TEST_CONTEXT`, nor a file process of a `node --test` it spawns),
  or in a pytest test or collected
  module that passed — or a pytest collection error, whatever the exit
  code), a run without per-test results (other
  runners), a missing, crashed or added test is never a kill.
  Mutant runs re-run the whole suite without coverage and
  have their own 60 s budget, charged with each run's whole wall time
  (report parsing included): each gets at most 2× the plain suite time + 1 s
  (the main run's time until a surviving mutant run measures it), none after
  the first starts with less than that time + 0.5 s left. Only a failing run
  kills a mutant; a timed-out run is re-run once and counts only if that run
  fails. A kill must reproduce: the same test fails a second mutant run and
  passes in a third run with the switch off, the control, whatever other
  tests do there (three runs per kill, all inside the same budget, so
  suites over about a third of it end `mutation_budget`); a
  mutant passing its second run is no kill, and a test failing in the
  control is none either (a flaky suite). Otherwise `reverted`
  with reason `edit_not_exercised` / `no_coverage_tool` (no test ran the
  edit, whether the suite passed or failed), `coverage_timeout` (coverage
  post-processing overran the test budget), `tests_insensitive` (a site
  survived, its failing runs being load failures, `collection_errors`, or
  failing the switch-off control, `control_failed`; a hunk has no site; an inserted token no
  mutant covers, `uncovered_token`; a read with no use-site mutant,
  `unmutated_ref`; or a deleted token is neither observed nor replaced) or `mutation_budget` (the mutant runs did not fit their budget,
  the edit is over 16 change hunks / 32,000 changed characters, or the
  mutants' parse check did not finish in 10 s, JS or Python). These five reasons are untested
  outcomes: no sample, calibration point, reward or Reflexion repair.
- If `git worktree add` fails (e.g. a user branch named `refactor` blocks
  the `refactor/` ref namespace), it is retried once on `refactor-run/<run_id>`
  (`refactor-run-<run_id>` when a `refactor-run` branch exists); if that fails
  too the run stops with `EWORKTREE` (exit 2), target untouched. A git target
  with commits is never edited in place.
- Only a target that is not a git repo (or has no commits) is edited in
  place, with a warning.
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
defines them as inputs on which the edit behaves differently). The diff
test always also tries boundary values: integers past 2 ** 30, 2 ** 31,
2 ** 32 and 2 ** 53, prototype keys (`constructor`, `toString`), a tab, a
5,000-character string whose head differs from its tail and (Python) a
150-element list. Without an
`equivalent` diff test the gate fails closed: an `inconclusive` diff test
that ran inputs (`runs > 0`) is rejected, so is a JS or Python edit the diff
test ran no input on (Python runs in an isolated `python3 -I` harness,
`src/validation/py_diff_harness.py`), and an edit in another language
(`runs = 0`) proceeds only with every check passed. Python's
`condition_change` check drops from veto to a score penalty when the Python
diff test is `equivalent`, unless the edit deletes a comparison
(`deletes_condition`); `guard_removal` always vetoes. The gate and fusion
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
  `coverage_timeout` / `tests_insensitive` / `mutation_budget`, are not
  samples).
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
- `SIGINT`/`SIGTERM`: revert the in-flight edit, remove its temp dirs, flush state, exit 0.

---

## CLI

```
node src/orchestrator.js --repo <path> [--resume] [--dry-run]
```

- `--repo` (required): target Git repo
- `--resume`: continue from the target's existing session;
  no re-analysis when it already has proposals
- `--dry-run`: run Analyzer + Critic, skip Executor (no file changes)
