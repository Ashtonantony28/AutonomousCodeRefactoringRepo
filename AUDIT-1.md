# AUDIT-1: Validation soundness (no false negatives)

Audited commit `e928c06` (after SG0 through SG7). The auditor did not write the code under audit. All repros use the repo's stub Claude client and a temp `REFACTOR_STATE_DIR` (via `test/helpers/env.js`). None call the live API, and none touch `state/`, `src/` or `test/`. Each script is run from the repo root with `node audit/1/<script>.js`. Orchestrator log lines (`[orch] …`) are left out of the outputs below.

## Summary

**Escape rate: 21 / 36 = 58.3 %.** The corpus is 36 semantics-changing JS edits (`audit/1/mutation-corpus.js`). Each one went through the real `processProposal` gate: jury normalisation and aggregation, AST checks, diff test, vetoes, fusion, then the learned gate. The critic was the most favourable stub possible: 3 of 3 personas approve with `p_preserves` 0.9. 21 mutants reached the executor stage (`dry_run`).

- All 15 catches came from a `divergent` diff test.
- The AST layer caught **0** of the 36. It flagged no check at all on any corpus mutant.
- Of the 21 escapees, 16 had a diff-test verdict of `equivalent`, which raises `combined` to 0.95. The other 5 were `inconclusive`, which fails open with `combined` 0.94.

End to end, an edit that removes a path-traversal guard was validated, passed `npm test` and was **committed** on `refactor/<run_id>` (C1).

| severity | count |
|---|---|
| Critical | 1 |
| High | 4 |
| Medium | 5 |
| Low | 3 (+1 suspected, not reproduced) |

### Corpus results (`node audit/1/mutation-corpus.js`)

| id | mutation | diff test | outcome |
|---|---|---|---|
| M01 | off-by-one loop bound | divergent | caught |
| M02 | `>=` → `>` (isAdult) | equivalent | **ESCAPED** |
| M03 | `<` → `<=` in guard | equivalent | **ESCAPED** |
| M04 | off-by-one slice | divergent | caught |
| M05 | dropped `await` inside try/catch | equivalent | **ESCAPED** |
| M06 | dropped `await` before side effect | equivalent | **ESCAPED** |
| M07 | swallowed error (throw → `{}`) | divergent | caught |
| M08 | swallowed error (not-found throw → null) | equivalent | **ESCAPED** |
| M09 | catch rethrow → swallow | divergent | caught |
| M10 | RangeError → Error | divergent | caught |
| M11 | dropped `error.code` | equivalent | **ESCAPED** |
| M12 | changed default (page size 10 → 20) | equivalent | **ESCAPED** |
| M13 | changed default option | divergent | caught |
| M14 | `\|\|` → `??` default | divergent | caught |
| M15 | copy-sort → in-place sort (input mutation) | divergent | caught |
| M16 | mutated input object | divergent | caught |
| M17 | `-x` → `0 - x` (sign of zero) | equivalent | **ESCAPED** |
| M18 | `+1` on epoch-ms value | divergent | caught (via a string input only) |
| M19 | returned closure behaviour | equivalent | **ESCAPED** |
| M20 | class method using instance state | equivalent | **ESCAPED** |
| M21 | object-literal method in `module.exports` | inconclusive | **ESCAPED** |
| M22 | changed module constant | inconclusive | **ESCAPED** |
| M23 | file with a top-level call into a dependency | inconclusive | **ESCAPED** |
| M24 | function calling a required module | inconclusive | **ESCAPED** |
| M25 | dropped write to module state | equivalent | **ESCAPED** |
| M26 | removed path-traversal check | equivalent | **ESCAPED** |
| M27 | weakened e-mail regex | equivalent | **ESCAPED** |
| M28 | `===` → `==` | divergent | caught |
| M29 | `round` → `floor` | divergent | caught |
| M30 | removed divide-by-zero guard | divergent | caught |
| M31 | two functions in region, second one broken | equivalent | **ESCAPED** |
| M32 | `length` → `trim().length` | divergent | caught |
| M33 | class getter changed | inconclusive | **ESCAPED** |
| M34 | async rejection type changed | divergent | caught |
| M35 | array result changed past index 200 | equivalent | **ESCAPED** |
| M36 | result changed deeper than 8 levels | equivalent | **ESCAPED** |

---

## Critical

### C1. An unsafe edit is committed on a single LLM approval: every deterministic layer fails open

**Affected code**
- `src/orchestrator.js:96-97`: the only hard gate is `combined >= 0.5 && jury approves`.
- `src/validation/hybrid-validator.js:30-46`: vetoes come only from `divergent`, `severity:'veto'` (parse) or a unanimous reject.
- `src/validation/hybrid-validator.js:93`: `inconclusive` scores `0.6*p + 0.4*ast`.
- `src/runner/test-runner.js:185`: `passed` means exit code 0.
- `src/agents/executor.js:77`: coverage is measured but never used.

**Impact.** Suppose the diff test is `inconclusive` or blind (H3, H4) and the repo's tests do not exercise the edited function. Then the critic's approval alone decides whether a behaviour change is committed. No AST check can block (H1). The executor treats any zero exit code as proof, and ignores the coverage it measures for the edited file. With the most favourable critic, 58 % of the corpus reaches the executor.

**Repro:** `node audit/1/e2e-commit.js`. It runs the real pipeline in non-dry mode on a git fixture: worktree, `npm test`, commit. The proposal deletes `if (String(p).includes('..')) throw …` from `safePath`.

Observed:
```
status=passed combined=0.94 dt=inconclusive (both sides threw ReferenceError on every input (missing context; pass fileSrc)) failed_checks=[]
commit=a6264c89… branch=refactor/6f5359b9-…
-  if (String(p).includes('..')) throw new Error('bad path');
safePath('../../etc/passwd') on the committed branch -> "/etc/passwd"
```
Expected: the proposal is `vetoed` or `critic_rejected`, or at least not committed while the edited function has 0 % test coverage.

## High

### H1. The four CLAUDE.md anti-pattern checks can never block an approved proposal

**Affected code**
- `src/validation/ast-checker.js:303-576`: every check returns `severity: 'score'`. Only parse errors are a veto.
- `src/validation/hybrid-validator.js:93`.

**Impact.** Without a diff test, `combined = 0.6p + 0.4·pattern_score`, which is ≥ 0.5 whenever `p_preserves ≥ 0.834`, whatever the AST result. With an `equivalent` diff test, `0.5p + 0.2 + 0.3·pattern_score` is ≥ 0.5 for any `p ≥ 0.6`. The four checks that CLAUDE.md says the Critic "must always check" are therefore advisory only.

**Repro:** `node audit/1/ast-checks-cannot-block.js`. The proposal fails all four checks: signature drift with a live call site in `src/app.js`, try/catch removed, undeclared `axios` import, and all returns removed.

Observed:
```
"status": "dry_run", "combined": 0.54, "veto": null
signature_drift: FAIL (score) load: 2→1 args; call sites outside edit: load in src/app.js (1)
new_dependency: FAIL (score) undeclared imports: axios
return_type_change: FAIL (score) missing return path in: load (all returns removed)
error_handling_removal: FAIL (score) try/catch or .catch() count went from 1 to 0 (ast)
```
Expected: rejected. At minimum, `return_type_change` failing with "all returns removed" together with a drifted signature that has live call sites should be a veto.

### H2. The validators judge `current_code`, but the executor replaces a different region

**Affected code**
- `src/runner/anchor-matcher.js:51-77, 383-387`: the whitespace tier collapses all whitespace.
- `src/runner/reverter.js:113-128`.
- `src/validation/diff-testing.js:288`: falls back to snippet mode when `current_code` is not verbatim in the file.
- `src/validation/ast-checker.js:639-644`: snippet-only checks.

**Impact.** If `current_code` is not verbatim in the file, the critic, the AST checks and the diff test all validate the LLM's transcription. The executor then overwrites whatever region the whitespace tier maps it to. Collapsing whitespace is not semantics-preserving in three cases:
- string and template literal contents;
- ASI after `return`;
- Python indentation, which defines block structure.

In each case the gate passes, and the replaced region behaves differently from the code that was validated.

**Repro:** `node audit/1/validated-vs-applied-region.js`.

Observed:
```
== W1 JS string literal whitespace
gate: status=dry_run combined=0.95 dt=equivalent
verbatim in file: false; applied via tier=whitespace
behaviour: before="Total:    5" after="Total: 5"
== W2 JS ASI after return
gate: status=dry_run combined=0.95 dt=equivalent
replaced region: "function total(a, b) {\n  return\n    a + b;\n}"   validated as: "…return a + b;…"
behaviour: before=undefined after=3
== W3 Python block structure
gate: status=dry_run combined=0.94 dt=inconclusive (non-JS file)
replaced region: "for x in xs:\n        total += x\n        count += 1"  (count is inside the loop)
validated as:    "    for x in xs:\n        total += x\n    count += 1"     (count outside the loop)
after: … total += sum(xs)\n    count += 1   → count is now 1 instead of len(xs)
```
Expected:
- The whitespace and fuzzy tiers refuse a match when whitespace differs inside string, template or regex tokens, across a `return`/`throw`/`break`/`continue` line break, or in indentation for indentation-sensitive languages.
- Alternatively, the validators re-run against the *matched* region, using `findAnchor` before validation.

### H3. The diff test says `equivalent` (score 1) for functions it never exercised

**Affected code**
- `src/validation/diff-testing.js:203-221`: inputs are only small ints, floats, strings of 6 characters or fewer, booleans, null/undefined and small int arrays. There are never objects, functions, Dates or longer strings.
- `src/validation/diff-sandbox-worker.js` `compare()`: identical throws count as `equal`.

**Impact.** Any function that takes an object, callback or store throws the same `TypeError` on both sides for every input, and the verdict comes back `equivalent` with `runs=35`. This is positive evidence: it adds 0.2 and lifts `combined` to 0.95. The same applies to boundary-specific changes that random inputs rarely hit: `>=`/`>` at 18, `'..'` checks, e-mail regexes, page size beyond 4 items. These cases are corpus M02, M03, M05, M06, M08, M12, M20, M26 and M27.

**Repro:** `node audit/1/difftest-holes.js` (rows D10 and D11), plus the corpus rows above.

Observed:
```
D10 all calls throw same TypeError -> "equivalent"   verdict=equivalent runs=35  witness [{"items":[]}]: current=0 proposed=1
D11 needs object arg                                  verdict=equivalent runs=35  witness [{"admin":"yes"}]: current="user" proposed="admin"
```
Expected: `divergent`. Failing that, `inconclusive` when no run returned normally. A run that is all throws, or that only ever takes the error path, should not count as equivalence.

### H4. The diff test is silently inapplicable for common CommonJS shapes, and `inconclusive` fails open

**Affected code**
- `src/validation/diff-testing.js:81-122`: `collectTargets` has no object-literal methods, getters/setters or non-function bindings.
- `src/validation/diff-testing.js:177`: only the first changed function in the region is tested.
- `src/validation/diff-sandbox-worker.js:234`: if the current side fails to load, the result is `inconclusive`.
- `src/validation/diff-sandbox-worker.js:274-277`: ReferenceError on every input gives `inconclusive`.
- `src/validation/hybrid-validator.js:93`.

**Impact.** For the following shapes the diff test is skipped. The proposal is then scored only on `0.6p + 0.4·ast`, which always passes for an approving critic:
- `module.exports = { method() {} }` (M21);
- getters (M33);
- constants (M22);
- any file with a top-level call into a dependency, such as `require('debug')('x')` or `express()` (M23);
- any function that calls a required module (M24, C1).

Where the region contains two functions, a refactored first function hides a broken second one (M31).

**Repro:** `node audit/1/mutation-corpus.js` (M21–M24, M31, M33) and `node audit/1/difftest-holes.js` (D12, D13).

Observed:
```
M21 ESCAPED … dt=inconclusive (no callable function located in the edit)
M23 ESCAPED … dt=inconclusive (current failed to load: ReferenceError: module debug is not available in the sandbox)
M24 ESCAPED … dt=inconclusive (both sides threw ReferenceError on every input …)
M31 ESCAPED … dt=equivalent   (inc tested; twice: x*2 → x*3 never called)
```
Expected:
- Test every changed callable in the region.
- Support object-literal methods and accessors.
- Make dependency stubs return inert values instead of throwing at load.
- Make `inconclusive` cost confidence: score below 0.5, or block the gate unless the critic is unanimous and the AST checks are clean.

## Medium

### M1. Diff-test comparison holes

**Affected code**
- `src/validation/diff-sandbox-worker.js:32`: `-0` is normalised to `0`.
- `:36`: functions are compared by name and length only.
- `:37`: anything past depth 8 is replaced by `{t:'deep'}`.
- `:43`, `:61`: only the first 200 elements or keys are compared.
- `:58`: errors are compared by constructor name and message only.
- `:59`: only own enumerable string keys are compared.
- `:202`: numbers are equal within a relative tolerance of 1e-9.

Module-level state is never compared.

**Repro:** `node audit/1/difftest-holes.js`, rows D1–D9. Every row is observably different and every row is reported `equivalent`:
```
D1 -0 vs +0                 equivalent  current=-0 proposed=0
D2 relative tolerance 1e-9  equivalent  current=1700000000000 proposed=1700000000001
D3 returned function        equivalent  current=11 proposed=9
D4 error own props (code)   equivalent  current=throw TypeError code=E_ONE proposed=… code=E_TWO
D5 array tail > 200         equivalent
D6 depth > 8                equivalent
D7 non-enumerable           equivalent  current=1 proposed=2
D8 symbol-keyed result      equivalent  current="a" proposed="b"
D9 module-level side effect equivalent  seen.length current=1 proposed=0
```
Expected: `divergent`.

### M2. In snippet mode a proposed-only ReferenceError (hallucinated helper) is "unresolved", not a mismatch

**Affected code:** `src/validation/diff-sandbox-worker.js:218` (`!fileMode && (refA || refB)` → `unresolved`) and `:274`.

**Impact.** A single `equal` run is also enough for an `equivalent` verdict, even when every other run was unresolved. Snippet mode is used whenever `current_code` is not verbatim (see H2).

**Repro:** `node audit/1/difftest-holes.js`, row D14. Current returns `"a"`; proposed throws `ReferenceError: normalizeSlug is not defined` on every input.

Observed: `inconclusive (no input produced a comparable result (35 unresolved))`, which passes the gate. Expected: `divergent`, at least when the current side returns normally on the same input.

### M3. Jury aggregation outvotes a certain dissent and ignores concrete edge cases

**Affected code**
- `src/agents/critic.js:136`: the jury score is the mean.
- `src/agents/critic.js:152`: approval is a majority vote.
- `src/agents/critic.js:153`: `edge_cases` and `hallucination_flags` are merged but never used by the gate.
- `src/orchestrator.js:96`.

**Repro:** `node audit/1/critic-aggregation.js`.

Observed:
```
J1 strict reviewer certain of change (p=0), outvoted 2-1
  status=dry_run combined=0.8334 jury.p_preserves=0.6667 approval_rate=0.67
J2 unanimous approve but every reviewer lists the breaking edge case
  status=dry_run combined=0.95 edge_cases=["age === 18 now returns false", …]
```
Expected: a reviewer with `p_preserves ≈ 0` and a concrete edge case should block, or force `critic_rejected`. A non-empty `edge_cases` that describes a behaviour change should not be ignored.

### M4. The executor's test gate accepts suites that never touch the edited code

**Affected code:** `src/runner/test-runner.js:185` and `src/agents/executor.js:73-81`. Coverage of the edited file is measured best-effort and recorded, but never compared against anything. A suite that runs 0 tests and exits 0 also counts as `passed`.

**Repro:** `node audit/1/e2e-commit.js`. The only test covers `size()`; `safePath` has 0 % coverage, yet the edit is committed (output under C1).

Expected: treat an edit as untested when the edited function or lines are not covered, or when the passed-test count is 0. Revert it or mark it `skipped_no_tests`.

### M5. `error_handling_removal` ignores removed `throw` guards

**Affected code:** `src/validation/ast-checker.js:321-354`. The check counts only `try` handlers and `.catch()` calls.

**Impact.** Deleting validation guards such as `if (bad) throw …`, or converting `throw` into `return null`, is never flagged. This covers M08, M26, M30 and C1.

**Repro:** `node audit/1/e2e-commit.js` shows `failed_checks=[]` for a diff that only deletes a `throw` guard. The corpus also shows no failed checks for M08 and M26.

Expected: `error_handling_removal`, or a dedicated `guard_removal` check, fails.

## Low

### L1. Oracle evasion by environment sniffing

**Affected code:** `src/validation/diff-sandbox-worker.js` (context global). The sandbox has no `process` or `setTimeout`, so code that branches on them behaves like the original only inside the oracle.

**Repro:** `node audit/1/sandbox-probe.js`, row `env_sniff`. Observed: `verdict=equivalent` for a function that returns `null` whenever `process` exists. Expected: `inconclusive`, or flagged when the proposal introduces environment-dependent branches.

### L2. Host file paths leak into the sandbox via `Error.prepareStackTrace`

**Affected code:** `src/validation/diff-sandbox-worker.js`. The `CallSite.getFileName()` values for host frames are visible.

**Repro:** `node audit/1/sandbox-probe.js`, row `prepare_stack`. Running it with `getFileName()` instead lists `…/src/validation/diff-sandbox-worker.js` and `node:internal/…`. This is information only: `getThis()` and `getFunction()` are `undefined` on every host frame, so it gives no escape.

### L3. Misleading inconclusive reason

**Affected code:** `src/validation/diff-sandbox-worker.js:277`. The reason says "missing context; pass fileSrc" even when `fileSrc` *was* passed and the ReferenceErrors come from dependency stubs.

**Repro:** `node audit/1/e2e-commit.js` (see the `dt=` field).

### Suspected (not reproduced)

- **Sandbox escape to host `process`/`require`: none found.** These attempts were all confined to the context realm (`node audit/1/sandbox-probe.js`): `this.constructor.constructor`, `Function(...)`, `Error.prepareStackTrace` CallSite `getThis`/`getFunction`, and the `require` proxy.
- **Learned gate (`src/rl/classifier.js` `gate`):** it can only reject (`p_pass < 0.4`), never approve, so it introduces no false negatives by itself. It does learn "tests pass", not "semantics preserved". Escapees that pass weak test suites (C1, M4) become positive training labels, so the gate is expected to *reinforce* the escapes above. This was not measured.

## Repro index (`audit/1/`)

| script | findings |
|---|---|
| `lib.js` | shared harness (temp repo, stub critic, real `processProposal`) |
| `mutation-corpus.js` | escape rate, H3, H4 |
| `e2e-commit.js` | C1, M4, M5, L3 |
| `ast-checks-cannot-block.js` | H1 |
| `validated-vs-applied-region.js` | H2 |
| `difftest-holes.js` | H3, H4, M1, M2 |
| `critic-aggregation.js` | M3 |
| `sandbox-probe.js` | L1, L2, suspected |
