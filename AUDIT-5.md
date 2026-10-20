# AUDIT-5: Validation soundness, round 2 (no false negatives)

Audited commit `9420b9a` (SG10, after SG9–SG13). The auditor did not write the code under audit. All repros use the repo's stub Claude client and a temp `REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js`). None call the live API, and none touch `state/`, `dashboard/`, `src/` or `test/`. Each script is run from the repo root with `node audit/5/<script>.js`; it prints `FINDING` or `ok` and exits 1 on a reproduced finding. Orchestrator log lines (`[orch] …`) are left out of the outputs below.

Two stub juries are used:
- **U (unanimous):** 3 of 3 personas approve with `p_preserves` 0.9. This is the most favourable critic, the same one AUDIT-1 used.
- **M (split):** `strict` rejects with p 0.2, while `permissive` and `security` approve with p 0.8. This is the weakest jury `criticGate` accepts (a majority, with mean p 0.6). It passes only when the diff test says `equivalent`.

## Summary

**The round-1 Critical and High findings are fixed as reproduced** (`node audit/5/round1-recheck.js`: 5/5 ok). The round-1 corpus escape rate is 0/36, and the round-1 guard-removal edit is no longer committed.

**The validators are still unsound on a broader corpus:**
- **Escape rate with the unanimous critic: 54 / 97 = 55.7 %** (JS 44/87, Python 10/10). The corpus is `audit/5/mutation-corpus.js`. A real node or python witness confirms that every one of the 97 mutants changes behaviour.
- 34 of the escapees got a diff-test verdict of **`equivalent`**. They therefore also pass with the **split 2/3 jury (34 / 97 = 35.1 %)**.
- The other 20 escapees had a diff test that never ran (`inconclusive`, `runs=0`). For those, a unanimous jury plus clean AST checks is enough.

**End to end, 8 semantics-changing edits are committed** on `refactor/<run_id>` with plausible test suites. Each suite calls the code, or at least loads it, but does not assert the changed input (`node audit/5/e2e-commit.js`):
- four of them with the split jury (C1);
- one where **no test calls the changed function at all**, because editing its doc comment satisfies the coverage-evidence rule (C2);
- three on unanimous approval alone (C3): a JS shape the diff test cannot see, a weakened test assertion, and the round-1 guard removal written in Python.

**Benign corpus:** 6 / 31 safe refactors are rejected, a **19.4 % false-rejection rate** (M1).

| severity | count |
|---|---|
| Critical | 3 |
| High | 6 |
| Medium | 3 |
| Low | 1 |

### Corpus results (`node audit/5/mutation-corpus.js`)

| category | mutants | escaped (U) | escaped (M) | escapees |
|---|---|---|---|---|
| object methods | 9 | 7 | 4 | OM2–OM8 |
| classes | 10 | 6 | 4 | CL1, CL2, CL5, CL7, CL9, CL10 |
| async / promises | 6 | 0 | 0 | |
| closures | 6 | 3 | 3 | CS1–CS3 |
| module state | 6 | 5 | 4 | MS1–MS5 |
| requires / dependencies | 5 | 2 | 2 | RQ2, RQ3 |
| getters | 3 | 0 | 0 | |
| regex | 8 | 5 | 5 | RX1, RX2, RX3, RX9, RX12 |
| strings | 4 | 3 | 3 | RX4, RX5, RX7 |
| error handling | 6 | 0 | 0 | |
| guards | 8 | 3 | 3 | GU1, GU4, GU8 |
| off-by-one | 6 | 0 | 0 | |
| shapes / tester limits | 7 | 7 | 3 | SH1–SH7 |
| environment sniffing | 3 | 3 | 3 | EV1–EV3 |
| Python | 10 | 10 | 0 | PY1–PY10 |
| **total** | **97** | **54** | **34** | |

Of the 43 caught mutants, 37 were `vetoed` by a `divergent` diff test and 6 were `critic_rejected` by the SG9 rule that an `inconclusive` verdict with `runs > 0` blocks the edit. Every one of these 43 has an empty `failed_checks`, so the AST layer flagged none of the corpus.

---

## Critical

### C1. The diff test certifies semantics-changing edits as `equivalent`, and a split jury then commits them

**Affected code**
- `src/validation/hybrid-validator.js:49`: an `equivalent` verdict skips `unconfirmedBlock` entirely.
- `src/orchestrator.js:66` (`criticGate`): the gate needs only a jury majority with mean p ≥ 0.5.
- Root causes in the diff test: H1–H5.

**Impact.** Once the diff test says `equivalent`, fusion gives `0.5·p + 0.3 + 0.2`, and a 2-of-3 jury is enough. In 34 of 97 corpus mutants the diff test's "positive evidence" is false, so the strict reviewer's correct rejection is outvoted. The executor then needs only a green suite that runs the edited line, which is the normal case for a function that is tested but whose changed input is not asserted.

**Repro:** `node audit/5/e2e-commit.js E1 E2 E3 E4` (split jury, real worktree, `node --test`, commit).

Observed:
```
== E1 path sanitiser strips only the first "../" (2/3 jury, diff test equivalent)
   status=passed combined=0.8 dt=equivalent failed_checks=[]
   committed e78aaf0430ee on refactor/012bab05-…:
     -  return String(p).replace(/\.\.\//g, '');
     +  return String(p).replace('../', '');
   on the committed branch: strip('../../etc/passwd') = "../etc/passwd" (was "etc/passwd")
== E2 cache invalidation dropped from set()        … committed; get(k) after set(k,2) = 1 (was 2)
== E3 max-length guard 255 -> 256                   … committed; checkName('x'.repeat(256)) accepted (was RangeError)
== E4 not-found branch on a dependency result 404 -> 410 … committed; exists(0) = true (was false)
```
Expected: the diff test does not report `equivalent` for these edits (see H1–H5). Failing that, `equivalent` is not treated as proof that outvotes a dissenting reviewer.

### C2. The coverage-evidence rule is satisfied by editing a doc comment, so an edit to a function no test calls is committed

**Affected code**
- `src/runner/test-runner.js:137` (`changedSpan`): the span runs from the first changed character to the last.
- `src/runner/test-runner.js:198`: every non-whitespace character in that span is a probe, comments included.
- `src/runner/test-runner.js:185`: `exercised = executed > 0`.
- `src/agents/executor.js:83`.

**Impact.** A JSDoc comment above a function lies in the module's top-level V8 range, whose count is 1 as soon as any test `require`s the file. So a proposal that touches the doc comment as well as the body counts as "exercised" whenever the file is loaded, even if no test calls the function. LLM refactors routinely reword doc comments. This undoes the executor half of the round-1 C1 fix (SG12).

**Repro:** `node audit/5/e2e-commit.js E5 E5c`. The only test calls `size()`. E5c is a control: the same edit with the comment left unchanged.

Observed:
```
== E5 coverage-evidence evasion: doc comment touched, changed function never called by any test
   status=passed combined=0.8 dt=equivalent
   coverage: tool=v8 exercised=true executed_lines=1/3
   committed 86d77d674bf1 …  on the committed branch: strip('../../etc/passwd') = "../etc/passwd"; no test calls strip()
== E5c control for E5: same edit, doc comment untouched
   status=reverted … reason=edit_not_exercised   coverage: exercised=false executed_lines=0/1
```
Expected: comments and whitespace are not probes. The evidence should be per changed hunk or per changed function: every changed statement, or at least each changed function body, must be executed.

### C3. Edits the diff test cannot run commit on unanimous LLM approval alone

**Affected code**
- `src/validation/hybrid-validator.js:55`: with no diff-test run, a unanimous jury plus all AST checks passing is sufficient.
- `src/validation/hybrid-validator.js:109`: every non-JS file is `inconclusive`.
- `src/agents/analyzer.js:197`: test files are editable (see H6).

**Impact.** When `runs=0`, nothing deterministic judges semantics. The four AST checks only catch their four anti-patterns, and the Python checks are lexical. With a unanimous jury the edit then goes straight to the executor. This is the SG9 fallback as designed, but the result is the round-1 C1 failure mode, with "single approval" replaced by "unanimous approval":
- **Python:** 10/10 corpus mutants reach the executor. E8 commits the *same* path-traversal guard removal as round-1 C1.
- **JS:** 10 shapes have no locatable callable (H3a).
- **Test files:** E7.

**Repro:** `node audit/5/e2e-commit.js E6 E7 E8`.

Observed:
```
== E6 anonymous module.exports function   dt=inconclusive (no callable function or constant located in the edit)
   committed …  -  return a - b;  +  return Math.abs(a - b);   sub(1, 3) = 2 (was -2)
== E7 test assertion weakened in a test file   dt=inconclusive (no callable …)
   committed …  -  assert.strictEqual(m.half(3), 1.5);  +  assert.ok(typeof m.half(3) === 'number');
== E8 Python: path-traversal guard removed   dt=inconclusive (non-JS file)   coverage: tool=coverage.py exercised=true
   committed …  -    if ".." in p:  -        raise ValueError("bad path")
```
Expected: a `runs=0` edit is not executed on the jury alone. Options:
- reject the edit unless the change is token-trivial (comments, whitespace, renames);
- add a deterministic check for Python, at least a lexical guard-removal check (`raise` or `if … raise` dropped) and a boundary-operator check;
- require a test that fails on a mutant of the edited lines before trusting a green run.

## High

Each of the following is a deterministic layer that fails open. Given a favourable critic, each lets a semantics-changing edit reach the executor, and C1, C3 and E1–E8 show such edits being committed.

### H1. Module-private state and load-time effects are never compared

**Affected code**
- `src/validation/diff-sandbox-worker.js:211` (`exportsState`) and `:366` (`stateEq`): only exported, non-function data properties are compared.
- `note()` is a no-op while `rec` is null, so stub interactions during load are dropped.
- Object identity is not compared.

**Impact.** The following changes all yield `equivalent`, and so pass with the split jury:
- dropping a write to a private log, cache or counter (MS1 audit log, MS2 cache invalidation, MS3 failed-login counter);
- losing a singleton's identity (MS5);
- dropping a top-level `app.use(…)` that sits next to a tidied function (SH7);
- a proposal that breaks out of a block comment and injects a top-level `require('child_process').execSync(…)` (anchor-placement A6).

**Repro:** `node audit/5/mutation-corpus.js --only MS1,MS2,MS3,MS5,SH7` and `node audit/5/anchor-placement.js` (A6). E2 shows MS2 being committed.

Observed:
```
MS2   ESCAPED(U+M) U=dry_run/equivalent(runs=50)   witness {"cur":"2","prop":"1"}
SH7   ESCAPED(U+M) U=dry_run/equivalent(runs=37)   witness {"cur":"1","prop":"0"}
A6 comment break-out injecting a load-time execSync (2/3 critic): tier=exact status=dry_run combined=0.8 dt=equivalent
```
Expected:
- Compare all module-scope bindings, not just exports, after each call, together with the interactions recorded during load.
- Any top-level statement in the region that differs makes the verdict at best `inconclusive`.

### H2. Functions reached only through a return value are probed with fixed arguments and an undefined `this`

**Affected code:** `src/validation/diff-sandbox-worker.js:30` (`PROBE_ARGS = [0, 1, 'a']`) and `:69` (each returned function is called once per probe with `this` undefined, nested at most 2 levels).

**Impact.** Factory-returned methods, curried functions and returned predicates are compared only on `0`, `1` and `'a'`. Changes that depend on an object or array argument, on `this`, or on a third curried level are never reached: OM5, OM6, OM8, CS1, CS2, CS3 and MS5 are all `equivalent`.

**Repro:** `node audit/5/mutation-corpus.js --only OM5,OM6,OM8,CS1,CS2,CS3,MS5`

Observed: `CS1 ESCAPED(U+M) U=dry_run/equivalent(runs=34)  witness {"cur":"true","prop":"false"}`; `OM8 … equivalent(runs=1)`.
Expected: returned functions get the same shaped-input generation as top-level callables (or the verdict is `inconclusive`).

### H3. Common module shapes have no locatable callable, and the target cap and time budget end testing early with `equivalent`

**Affected code:** callable location in `src/validation/diff-testing.js`; `MAX_TARGETS = 8`; the per-target time slice at `src/validation/diff-sandbox-worker.js:454`.

**Impact.**
- (a) `runs=0` (`inconclusive`) for prototype assignments, `api.x = function`, `Object.defineProperty` getters, class arrow fields, anonymous `module.exports` functions and classes, ESM `export default`, conditional exports and IIFE modules (OM2, OM4, OM7, CL2, CL7, MS4, SH1, SH2, SH5, SH6). These then fall to C3.
- (b) The ninth changed function is never tested (SH3, `runs=260`, `equivalent`).
- (c) A slow function is tested on 11 edge values only, and the verdict is still `equivalent` (SH4, `runs=12`).

**Repro:** `node audit/5/mutation-corpus.js --only OM2,OM4,OM7,CL2,CL7,MS4,SH1,SH2,SH3,SH4,SH5,SH6`
Expected: these shapes are located; when targets are skipped or the budget ends testing, the verdict is `inconclusive`, never `equivalent`.

### H4. Generated inputs miss the boundaries that the edit moves, and dependency stubs return one fixed value

**Affected code:** input generation and literal mining in `src/validation/diff-sandbox-worker.js`; inert `require` stubs.

**Impact.**
- Regex, string and length-boundary edits are not exercised. The mined literals are not turned into the inputs that separate the two versions: a 256-character string, a second `../`, an uppercase variant, a dot replaced by another character, a 6-digit zip. RX1–RX5, RX7, RX9, RX12, GU1, GU4 and GU8 are `equivalent` with 25–35 runs each.
- A branch on a dependency's return value is never taken, because the stub always returns the same value (RQ2, RQ3).

**Repro:** `node audit/5/mutation-corpus.js --only RX1,RX2,RX3,RX4,RX5,RX7,RX9,RX12,GU1,GU4,GU8,RQ2,RQ3`
Expected: numeric literals ±1, string literals repeated, case-flipped and with each regex metacharacter replaced, plus lengths around each mined number; stubs return varied values (or any difference in the branch condition is `inconclusive`).

### H5. Code that branches on host globals behaves differently in the sandbox

**Affected code:** the null-prototype vm global in `src/validation/diff-sandbox-worker.js` has no `process`, `setTimeout` or `Buffer`.

**Impact.** A proposal that changes behaviour only when one of these globals exists is `equivalent` in the sandbox, and differs in production (EV1–EV3; AUDIT-1 L1 is still open and is raised here because the corpus shows it is an easy shape for an LLM edit to take, e.g. `typeof process !== 'undefined'` checks).

**Repro:** `node audit/5/mutation-corpus.js --only EV1,EV2,EV3`
Expected: a diff of a `typeof <global>` test or a reference to a missing global between the two versions makes the verdict `inconclusive`; or the sandbox provides inert versions of these globals.

### H6. Test files can be edited, so a proposal can weaken the assertion that would have caught it

**Affected code:** the Analyzer's file selection does not exclude test files; the executor runs the edited suite.

**Impact.** A proposal that loosens an assertion in a test file is `inconclusive` (no callable), passes C3's unanimous-jury fallback, and commits (E7). The same path lets a single run weaken the safety net for later runs.

**Repro:** `node audit/5/e2e-commit.js E7`
Expected: proposals to test files are rejected (or require a separate, explicit flag).

## Medium

### M1. 6 of 31 benign refactors are vetoed (19.4 %)

`node audit/5/mutation-corpus.js` (benign section). B03 indexed loop → `for…of`, B12 manual max → `Math.max(...)`, B15 extracted class helper, B19 `Array.from` → spread, B20 `substr(1)` → `slice(1)`, B21 `reduce` → loop. Each is vetoed with `divergent` on inputs the original was never meant to accept (e.g. `total differs on input [""]`: string concatenation vs numeric sum). The diff test treats any difference on any generated input, including type-invalid ones, as divergence. Expected: differences only on inputs outside the original's evident domain (non-array to an array function, etc.) are `inconclusive`, not `divergent`.

### M2. The jury outvotes a certain dissent and ignores the edge cases it lists

`node audit/5/critic-edge-cases.js`. K1: the security persona says `p_preserves = 0` and names the regression; 2–1 majority wins (`jury.p = 0.6`). K2: all three approve while each lists the breaking edge case in `edge_cases`. Both reach the executor. This is AUDIT-1 M3, still open; with C1 it becomes part of a committed-edit path. Expected: any persona with `p_preserves` below a floor (e.g. 0.2), or any non-empty `edge_cases` naming a behaviour change, blocks unless the diff test is `divergent`-free on a witness built from that edge case.

### M3. The AST layer flagged none of the 97 corpus mutants

Every caught mutant has `failed_checks=[]`. The four anti-pattern checks are correct for their four patterns (round-1 H1 holds), but they contribute nothing to soundness on real-world mutation shapes. Expected: none required; recorded so the AST layer is not counted as a safety layer when weighing C3.

## Low

### L1. `equivalent` is reported on as few as 1 run

OM8 (`runs=1`), OM5, OM6 and MS5 (`runs=3`) are `equivalent`. `minValueRuns` counts normal returns across all targets, not per changed callable. Expected: a per-target minimum (e.g. 10 value-returning runs) before `equivalent`.

## What holds

- Round-1 Critical/High are fixed as reproduced (`node audit/5/round1-recheck.js`, 5/5 ok); the round-1 corpus escapes 0/36.
- No `divergent`-vetoed or `critic_rejected` proposal reached the executor in any repro.
- The anchor tiers refuse whitespace-sensitive matches (`node audit/5/anchor-placement.js` A1–A3), and indent-shifted or comment-closing edits are validated on the region actually replaced (A4, A5 vetoed).
- async/promise, getter, error-handling and off-by-one mutants were all caught (0 escapes in those categories).
- With the coverage rule intact (E5c), an edit no test touches is reverted with `edit_not_exercised`.

## Repro index (`audit/5/`)

| script | what it shows |
|---|---|
| `round1-recheck.js` | round-1 C/H repros re-run against this commit |
| `mutation-corpus.js` (`corpus.js`) | 97 witnessed mutants + 31 benign refactors through `processProposal`, U and M juries; `--only ID,…` |
| `e2e-commit.js` | E1–E8: real worktree, real `node --test`/pytest, commit on `refactor/<run_id>` (C1–C3, H6) |
| `anchor-placement.js` | A1–A6 anchor/region cases (H1 A6) |
| `critic-edge-cases.js` | K1, K2 jury aggregation (M2) |
| `lib.js` | shared helpers (stub juries, temp state, witness runner) |
