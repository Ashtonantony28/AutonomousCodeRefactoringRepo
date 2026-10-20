# AUDIT-8: Validation soundness, round 3 (no false negatives)

Audited commit `eb29324` (SG17, after SG14–SG17). The auditor did not write the
code under audit. All repros use the repo's stub Claude client and a temp
`REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js` and
`audit/5/lib.js`). None call the live API, and none touch `state/`,
`dashboard/`, `src/` or `test/`. Each script is run from the repo root with
`node audit/8/<script>.js`; it prints `FINDING` or `ok` and exits 1 on a
reproduced finding. Orchestrator `[orch] …` log lines are omitted below.

The critic used for every scenario is **U (unanimous):** 3/3 personas approve
with `p_preserves` 0.9 and no `edge_cases` — the most favourable jury, which
clears the SG14 gate on its own. A real `node`/`python3` witness confirms that
every corpus mutant changes observable behaviour.

## Summary

**All round-1 and round-2 soundness repros stay fixed, and the builders' edits
to the audit scripts did not weaken them** (`node audit/8/prior-recheck.js`:
9/9 ok). In particular `audit/5/e2e-commit.js` still commits 0 of E1–E8, and
the builder-edited `audit/7/sample-identity.js` and `resume-worktree-gone.js`
still verify their fixes (their assertions were tightened, not loosened; the
SG14/SG15 fixture change to `js-failing-after-edit` is a unit fixture, not an
audit repro).

**The commit bar is still unsound.** On a fresh corpus of 83 witnessed
semantics changes (59 JS + 24 Python; `audit/8/corpus.js`):

- **Gate escape with the unanimous critic: 58 / 83 = 69.9 %** (JS 35/59 via a
  diff-test `equivalent` verdict, Python 23/24 via the lexical checks passing).
  `node audit/8/mutation-corpus.js`.
- Escapes by category: console/log-only 9/9, host-global/clock 7/7,
  value-shape 9/12, realm/builtin 4/4, out-of-domain 6/8, Python 23/24.
  Caught in full: async ordering 0/3, dependency 0/4, guards 0/8, module/closure
  state 0/4.

**End to end, 4 semantics-changing edits are committed** on `refactor/<run_id>`
with plausible suites that call the edited code and pass (`node
audit/8/e2e-commit.js`): a removed audit log (X1), a changed JSON key order
(X3), a dropped `Object.freeze` (X4), and a removed Python audit `print` (X5).
Each clears every layer of the bar; the mutation-sensitivity layer is satisfied
by a mutant unrelated to the actual change (X1/X5: a mutant of an *unedited*
line; X3/X4: a different token on the edited line). Two control edits whose only
mutable tokens are the changed ones are correctly reverted `tests_insensitive`
(X2, X6).

**Benign corpus:** 7 / 34 safe refactors are rejected at the gate, a **20.6 %
false-rejection rate** (JS 2/22, Python 5/12) (M1).

| severity | count |
|---|---|
| Critical | 2 |
| High | 3 |
| Medium | 1 |
| Low | 1 |

---

## Critical

### C1. Deletions: the mutation-sensitivity layer mutates *unedited* lines, so a removed side effect commits

**Affected code**
- `src/runner/test-runner.js` `changedSpan`: a pure deletion yields an empty
  span at the deletion point.
- `src/rl/bug-injector.js` `editMutants`: with no operator in `[start,end)` it
  mutates "the rest of the lines holding them" — for an empty span, the line
  that now sits at that offset, which the edit did not change.
- `src/agents/executor.js` `mutationEvidence` / the SG14 bar step d.

**Impact.** When an edit deletes a line (a `console.log`, a `print`, a guard),
the changed span is empty and `editMutants` produces mutants of the adjacent,
unchanged line. A suite that asserts that neighbour kills such a mutant, so the
bar's "tests fail on a mutant of the edited lines" is satisfied by a line the
edit never touched. The diff test calls the log removal `equivalent` (sandbox
`console` is a no-op; Python has no diff test), coverage is per-function and
green, and the edit commits though no test observes the removed effect.

**Repro:** `node audit/8/e2e-commit.js X1 X5`

Observed:
```
== X1 audit log line removed; the killed mutant is drop_return on the adjacent, tested return
   status=passed combined=0.95 dt=equivalent
   mutation: mutants=1 run=1 killed=drop_return (line 4)   # line 4 = the unedited `return d;`
   committed … -  console.log('discount applied', price);
   on the committed branch: discount(50) logged [] (was ["discount applied 50"])
== X5 Python: audit print removed; killed mutant is numeric_off_by_one on the adjacent tested line
   status=passed dt=inconclusive (non-JS file)
   mutation: mutants=1 run=1 killed=numeric_off_by_one (line 2)   # line 2 = the unedited `fee = amt // 10`
   committed … -    print("charge", user, amt)
```
Expected: the mutation-sensitivity evidence must come from the lines the edit
actually changed (for a deletion, the removed content, or the edit is treated as
untested). A mutant of an unedited line proves nothing about the edit.

### C2. The mutation layer is satisfied by an unrelated token on the edited line, so diff-test-blind changes commit

**Affected code**
- `src/agents/executor.js` `mutationEvidence`: any killed mutant of the edited
  lines passes the step, regardless of whether it touches the changed token.
- `src/validation/diff-sandbox-worker.js`: the `equivalent` oracle compares only
  JSON-serialised return values, so object metadata changes read as equivalent
  (H1).

**Impact.** An edit that changes behaviour the diff test cannot see (object key
order, `Object.freeze`/`seal`, prototype, getter laziness, …) commits when the
edited line also carries an unrelated mutable token that the suite asserts. The
mutant that is killed changes that other token; the actual change is never
exercised.

**Repro:** `node audit/8/e2e-commit.js X3 X4`

Observed:
```
== X3 JSON key order changed; killed mutant is a string-literal mutation of the same returned object
   status=passed dt=equivalent   mutation: killed=string_literal (line 3)
   committed … -  return { id: u.id, name: u.name, kind: 'user' };
                +  return { name: u.name, id: u.id, kind: 'user' };
   on the committed branch: JSON.stringify(toRow) = {"name":"a","id":1,"kind":"user"} (was {"id":1,...})
== X4 frozen result no longer frozen; killed mutant mutates an adjacent tested numeric field
   status=passed dt=equivalent   mutation: killed=numeric_off_by_one (line 3)
   committed … -  return Object.freeze({ retries: 3, timeout: 5000 });
                +  return { retries: 3, timeout: 5000 };
   on the committed branch: Object.isFrozen(defaults()) = false (was true)
```
Expected: the mutation step must demonstrate sensitivity to the *change* (e.g.
test against a mutant that reverts or perturbs the changed token), not merely to
some token on the line; and the diff test should not report `equivalent` for
these shapes (H1).

---

## High

Each is a deterministic layer reporting `equivalent`/pass for a semantics change
on a plausible refactor shape, with a witness, under a favourable jury. C1/C2
show such edits actually committing; the rest escape the gate (`dry_run`).

### H1. The diff-test `equivalent` oracle only compares JSON-serialised return values

**Affected code:** `src/validation/diff-sandbox-worker.js` (`ser`, `exportsState`,
`stateEq`), `src/validation/diff-testing.js` (input generation, `MIN_VALUE_RUNS`).

**Impact.** `equivalent` is returned for changes the serializer flattens away:
- **Side effects** the sandbox stubs to no-ops — `console.*` lines added,
  removed, re-levelled, moved into a loop, or given new content (LG1–LG7, LG9,
  LG10).
- **Object identity / metadata** — key order (VS1, VS2), `Object.freeze`/`seal`
  (VS3, VS6, VS8), null-prototype vs plain (VS4), read-only descriptors (VS7),
  `Symbol.for` vs `Symbol` (VS10), lazy getter vs eager field (VS11).
- **Realm mutation** — patching `Array.prototype`, `JSON.stringify`, `Math.round`,
  or leaking a `globalThis` global (BI1–BI4).
- **Inputs outside the generated domain** — thresholds above 2²⁰, string/array
  length caps, nesting depth caps, `-0`, astral code points, BigInt (DM1, DM3,
  DM5–DM8).

**Repro:** `node audit/8/mutation-corpus.js --only LG1,LG5,VS1,VS3,VS8,VS11,BI1,BI3,DM1,DM7`
Observed: each `dry_run/equivalent` with a witness, e.g. VS3 `{"cur":"true","prop":"false"}` (`Object.isFrozen`), LG5 leaks the token into the log line.
Expected: a changed statement whose only effect is a side effect, object
metadata, or realm state makes the verdict at best `inconclusive`; differences
confined to un-mined boundary inputs are not grounds for `equivalent`.

### H2. Host-global and wall-clock sniffs are reported `equivalent`

**Affected code:** `src/validation/diff-testing.js:415` `hostGlobals` — the regex
`(?<![\w$.])<g>(?![\w$])` excludes any dotted or bracketed access, and
`HOST_GLOBALS` omits `globalThis`/`Date`; the sandbox fixes the clock
(`diff-sandbox-worker.js:40` `FIXED_NOW`, Date proxy).

**Impact.** The "references to host globals the sandbox does not provide" cap
never fires when the edit reaches a global through `globalThis.process`,
`globalThis['setTimeout']`, or a local alias `g.process` (count 0 both sides —
confirmed: `globalThis.process` → `process`-count 0). Behaviour that branches on
`process`/`Buffer`/`setTimeout` presence, or on `Date.now()`/`new Date()`, is
`equivalent` in the sandbox and differs in production (HG1–HG7).

**Repro:** `node audit/8/mutation-corpus.js --only HG1,HG3,HG5,HG6,HG7`
Observed: `HG1 dry_run/equivalent witness {"cur":"browser","prop":"node"}`;
`HG6 … {"cur":"beta","prop":"ga"}` (Date.now threshold); `HG7 … {"cur":"[2023] x","prop":"[2026] x"}`.
Expected: count host-global references through member/computed access and
aliases of `globalThis`; treat a changed `Date`/`Date.now` reference as
`inconclusive` (the fixed clock cannot witness it).

### H3. The Python "deterministic check" covers only guards and comparisons, so other changes pass

**Affected code:** `src/validation/polyglot-ast.js` `pyLexicalChecks`
(`checkPyGuardRemoval`, `checkPyConditionChange`); `hybrid-validator.js`
`unconfirmedBlock` accepts a non-JS `runs=0` edit when the jury is unanimous and
every check passes.

**Impact.** For Python there is no diff test; the bar's "a deterministic check
covers it" is the two lexical checks. They only inspect removed
`raise`/`assert`/guard-return and changed comparison operators/literals/defaults.
Changes with none of those pass vacuously: arithmetic operator swaps, slice
bounds, `min`/`max`, `any`/`all`, `break`/`continue`, exception *type* changes,
`append`/`extend`, `round` digits, dict-key renames, encoding, `sorted(reverse=)`,
dropped `print`/`logging`, dropped global updates, and call-site keyword defaults
(PA1–PA23; 23/24 escape, only the `is None`→`not` case is caught).

**Repro:** `node audit/8/mutation-corpus.js --only PA1,PA3,PA6,PA10,PA13,PA16,PA18,PA23`
Observed: each `dry_run/inconclusive(runs=0) failed_checks=[]` with a witness,
e.g. PA1 `{"cur":"9","prop":"11"}` (`-`→`+`), PA10 `{"cur":"throw:ValueError","prop":"throw:TypeError"}`.
Expected: either a real executable oracle for Python, or lexical checks for
arithmetic/builtin/slice/collection/side-effect shapes; failing that, a `runs=0`
non-JS edit should not commit on the jury plus two narrow checks alone.

---

## Medium

### M1. 7 of 34 benign refactors are rejected at the gate (20.6 %)

`node audit/8/mutation-corpus.js --benign`. JS (2/22): N06 string-concat loop →
`join` and N10 extract local helper are `divergent` on inputs the original never
accepted (`[""]`, a float) — the AUDIT-5 M1 shape, still open. Python (5/12):
NP2 `if/else`→conditional expression, NP3 `== None`→`is None`, NP4 `len==0`→`not`,
NP8 guard extraction, NP10 chained comparison are all vetoed by
`condition_change`, which treats a *reworded* comparison as a lost one. These are
common, safe Python refactors. Expected: the condition/guard lexical checks
should compare semantics, not token multisets, and the JS domain rule from
AUDIT-5 M1 should land.

## Low

### L1. `equivalent` on as few as 3 value-returning runs

Host-global and value-shape shapes return `equivalent` at `runs=3` (HG1, VS3,
VS4, VS7, VS10, VS11, BI1–BI3): the callables return immediately, so
`MIN_VALUE_RUNS` is reached with three inputs and the oracle never explores the
input space that might separate the versions. AUDIT-5 L1, still a contributing
factor. Expected: a higher per-target floor before `equivalent`, independent of
how fast the callable returns.

## What holds

- All round-1/round-2 soundness repros stay fixed and the builder-edited audit
  scripts still verify their fixes (`node audit/8/prior-recheck.js`, 9/9 ok):
  `audit/5/e2e-commit.js` commits 0 of E1–E8; `sample-identity.js` and
  `resume-worktree-gone.js` reproduce nothing (assertions tightened, not loosened).
- Async ordering, dependency side effects (fs/event/path/crypto), guard/boundary
  shapes, and module/closure/class state are all caught (0 escapes in those
  categories): diff test `divergent`, or `critic_rejected` when it cannot run
  but sees a changed module-scope write or a stubbed dependency interaction.
- Coverage is per changed function: an edit no test calls, or whose only mutable
  tokens are the changed ones, is reverted (`edit_not_exercised` /
  `tests_insensitive`; controls X2, X6).
- The four AST anti-pattern checks and the Python guard/condition vetoes fire on
  their own shapes (e.g. PA24 vetoed; guard removals vetoed).

## Repro index (`audit/8/`)

| script | what it shows |
|---|---|
| `prior-recheck.js` | round-1/2 soundness repros + builder-edited audit/7 scripts: 9/9 stay fixed |
| `corpus.js` | 59 JS + 24 Python witnessed mutants (console, host-global, value-shape, builtin, out-of-domain, arithmetic/side-effect) + 34 benign refactors; shared `CAP`/`PYCAP` capture helpers |
| `mutation-corpus.js` | the corpus through `processProposal` (dry run), unanimous critic; per-category escape table; `--only ID,…`, `--benign` |
| `e2e-commit.js` | X1–X6: real worktree, real `node --test`/pytest, commit on `refactor/<run_id>` (C1: X1/X5; C2: X3/X4; controls X2/X6) |

Shared helpers (`makeRepo`, `throughGate`, `e2e`, stub juries, witness runners,
temp state) are reused from `audit/5/lib.js` and `audit/1/lib.js`.
