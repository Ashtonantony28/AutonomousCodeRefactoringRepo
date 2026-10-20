# AUDIT-12: Validation soundness, round 4 (no false negatives)

Audited commit `cd596ab` (SG20, after SG18–SG21). The auditor did not write the
code under audit. All repros use the repo's stub Claude client and a temp
`REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js` and
`audit/5/lib.js`). None call the live API, and none touch `state/`,
`dashboard/`, `src/` or `test/`. Each script is run from the repo root with
`node audit/12/<script>.js`; it prints `FINDING` or `ok` and exits 1 on a
reproduced finding. Orchestrator `[orch] …` log lines are omitted below.

The critic used for every scenario is **U (unanimous):** 3/3 personas approve
with `p_preserves` 0.9 and no `edge_cases`, which clears the jury part of the
bar on its own. A real `node`/`python3` witness confirms that every corpus
mutant and every e2e scenario changes observable behaviour.

## Summary

**All round-1/2/3 soundness repros stay fixed, and the builders' edits since
round 3 did not weaken them** (`node audit/12/prior-recheck.js`): rounds 1–2
9/9 ok, `audit/8/e2e-commit.js` commits 0 of X1–X6 (all now diff-test
`divergent`), the SG18 and SG19 `--only` accept lists have 0 escapes, and
`audit/5/mutation-corpus.js` has 0/97 escapes. The only builder edits to audit
material since `901007d` are `audit/7/sample-identity.js` run 1 and the
`js-failing-after-edit` fixture, both moved to a BigInt-only log change that
the suite catches; both still test what they claim. **AUDIT-8 DM3, DM5 and DM8
still escape** (string > 1000 chars, nesting > 5, BigInt), and DM3 commits end
to end (Y8 below).

**The commit bar is still unsound.** Fresh corpus, 95 witnessed semantics
changes (60 JS + 35 Python, new shapes; `audit/12/corpus.js`):

- **Gate escape with the unanimous critic: 40 / 95 = 42.1 %** (JS 21/60,
  Python 19/35), every one through a diff-test `equivalent` verdict.
  `node audit/12/mutation-corpus.js`.
- Escapes by category: JS input domain 12/38, JS oracle 3/7, JS deletions 4/9,
  JS large-module state 2/6; Python input domain 9/19, Python oracle 9/13,
  Python deletions 1/3.

**End to end, 8 semantics-changing edits are committed** on `refactor/<run_id>`
with suites that call the edited code and pass (`node audit/12/e2e-commit.js`).
Five of them commit **with zero mutant runs**: a pure deletion stands on
`deletions_observed`, which is set when the statement *containing* the deleted
code ran, not the deleted code itself (C1), or when the deleted effect ran but
the oracle cannot see it (H1). A sixth bypasses the deletion rule by putting
the deletion in the same hunk as one inserted token (C2).

**Benign corpus:** 12 / 48 safe refactors are rejected at the gate (25.0 %; JS
8/32, Python 4/16) (M1). **Executor:** 8 of 16 gate-passing safe refactors with
thorough suites are reverted, 7 as `tests_insensitive` with 0 mutants (M2).

| severity | count |
|---|---|
| Critical | 2 |
| High | 4 |
| Medium | 2 |
| Low | 2 |

---

## Critical

### C1. A deletion counts as "observed" when its enclosing statement runs, so unexecuted deleted code commits with no test evidence

**Affected code**
- `src/validation/diff-testing.js` `listStatementAt` / `probeDeletions`: the
  `__dt.hit(k)` probe goes before the innermost statement *of a statement
  list* (`body`/`consequent` arrays) holding the deleted token. A braceless
  `if` consequent, the right side of `&&`, and a ternary branch are not list
  statements, so the probe lands before the whole `if`/expression statement.
- `src/validation/py_diff_harness.py` `probe`: the innermost `ast.stmt`; a
  conditional expression or `and` operand inside an assignment is probed at the
  assignment.
- `src/agents/executor.js` `mutationEvidence`: a deletion-only hunk stands on
  `diffTest.verdict === 'equivalent' && deletions_observed === true` and needs
  no killed mutant; with no other hunk the loop is empty and `ok = true`.

**Impact.** The bar's "pure deletions need an `equivalent` diff test that
observed the deleted code" is not enforced: deleting a guard or branch whose
body never ran in the sandbox (because the generator never builds the input
that reaches it) is reported `deletions_observed: true`, and the edit commits
with 0 mutants, so the target's tests only have to call the function. The
braced form of the same deletion is correctly `deletions_observed: false` and
reverted (control Y5).

**Repro:** `node audit/12/e2e-commit.js Y1 Y2 Y3`

Observed:
```
== Y1 braceless BigInt branch deleted
   status=passed combined=0.95 dt=equivalent deletions_observed=true
   mutation: hunks=1 mutants=0 run=0 killed=null
   witness (real node): current="2000" proposed="throw:TypeError:Cannot mix BigInt and other types…"
   committed … -  if (typeof n === 'bigint') return n * 1000n;
== Y2 short-circuit __proto__ key guard deleted
   status=passed dt=equivalent deletions_observed=true   mutation: mutants=0 run=0
   witness: current=["_proto"] proposed=[]
   committed … -  k === '__proto__' && (k = '_proto');
== Y3 Python: conditional-expression truncation deleted
   status=passed dt=equivalent failed_checks=[condition_change] deletions_observed=true   mutants=0 run=0
   witness: current=3000 proposed=4000
   committed … -    s = s[:3000] if len(s) > 3000 else s
```
Corpus: J08, J09, J50, J51, J55, J59, P42 (`node audit/12/mutation-corpus.js --only J08,J09,J50,J51,J55,J59,P42`).
Expected: a deletion is observed only when the deleted tokens themselves were
evaluated (probe the consequent/operand/branch, or count it unobserved);
otherwise `reverted` `tests_insensitive`.

### C2. Deleted tokens in a hunk that also inserts a token need neither observation nor a killed mutant

**Affected code**
- `src/utils/hunks.js` `tokenHunk`: `deletion: !ranges.length`; a hunk with at
  least one inserted token is not a deletion, and its `deleted` tokens are not
  used by anyone.
- `src/validation/diff-testing.js` (`changeHunks(...).filter(h => h.deletion)`):
  no probe is placed for them, so `deletions_observed` is absent.
- `src/agents/executor.js` `mutationEvidence`: such a hunk needs only a killed
  mutant of its inserted tokens.

**Impact.** The SG18 deletion rule is bypassed whenever the deletion shares a
hunk with any inserted token: removing a braced branch (unobserved, reverted
on its own) while reordering an operand on the next line commits, because the
mutant of the reordered literal (`1000` → `1001`) is killed by any test.

**Repro:** `node audit/12/e2e-commit.js Y4 Y5`

Observed:
```
== Y4 braced BigInt branch deleted in the same hunk as a reordered operand
   status=passed dt=equivalent deletions_observed=undefined
   mutation: hunks=1 mutants=1 run=1 killed=numeric_off_by_one (line 3)
   committed … -  if (typeof n === 'bigint') {  -    return n * 1000n;  -  }  -  return n * 1000;  +  return 1000 * n;
== Y5 control: the same braced deletion alone
   status=reverted reason=tests_insensitive deletions_observed=false
```
Expected: the deleted tokens of every hunk get the deletion treatment
(observed + `equivalent`, or a mutant/kill that covers them), in addition to
the inserted tokens' kill.

---

## High

Each is a deterministic layer reporting `equivalent` for a semantics change on
a plausible refactor shape, with a witness, under the unanimous jury. Corpus
rows are `dry_run` (would reach the executor); Y6–Y9 show commits.

### H1. Oracle blind spots; for pure deletions they commit with no killed mutant

**Affected code:** `src/validation/diff-sandbox-worker.js` `ser` (JS),
`src/validation/py_diff_harness.py` `Norm`, `module_state`, `side_main`.

**Impact.** `equivalent` for changes the comparison cannot see:
- JS private state: `#fields` and `WeakMap`-held state set in a constructor
  (J41, J42); generators compared on their first 64 items only (J40).
- Python: returned closures are compared as `['fn', qualname]` and never
  called (P20 closure arithmetic, P21 decorator factory); generators drained
  to 200 items (P24); async generators compared by repr (P30); `logging` below
  WARNING and `DeprecationWarning` produce no output in the sandbox (P25
  removed `log.info`, P28 password added to a `log.debug`, P26); function
  attributes are skipped by `module_state` (P27); `__slots__` instances are
  compared by address-stripped repr (P32 logout no longer clears the token).
- For a pure deletion the diff test is the only evidence (C1 path), so these
  commit with 0 mutant runs once a test calls the function.

**Repro:** `node audit/12/e2e-commit.js Y6 Y7` and
`node audit/12/mutation-corpus.js --only J40,J41,J42,P20,P21,P24,P25,P26,P27,P28,P30,P32`
Observed: Y6 `#max = Math.max(1, max)` → `#max = max` committed (`mutants=0`,
`new Pool(0).capacity()` 1 → 0); Y7 `log.info(...)` removal committed
(`mutants=0`); corpus rows `dry_run/equivalent`, e.g. P20 `{"cur":"12","prop":"8"}`,
P32 `{"cur":"None","prop":"'t'"}`.
Expected: probe returned callables (Python), compare generators to the bound
used for inputs or call it `inconclusive`, capture all log levels and
warnings, include function attributes and slot values; a deletion whose effect
the oracle cannot represent should not stand without a killed mutant.

### H2. Input-domain gaps: shapes the generators never build (incl. AUDIT-8 DM3/DM5/DM8)

**Affected code:** `src/validation/diff-testing.js` input construction;
`src/validation/py_diff_harness.py` `pools_from` / `pool` (`L` lengths ≤ 60,
fixed string set, small ints, no bools for numeric params).

**Impact.** Differences confined to these inputs read as `equivalent`:
- JS: sparse arrays (J04), `NaN` array elements (J05), explicit `undefined`
  arguments (J31), `Map`/`Set` arguments (J09, J32), tabs/newlines/`ß` in
  strings (J12, J13, J38), nesting depth ≥ 3 (J23), length guards above the
  mined bound (J07), strings > 1000 / nesting > 5 / BigInt (DM3, DM5, DM8,
  J08, J50, J59).
- Python: `\n`/`\t` (P01), `ß` (P02), superscript digits (P03), integers above
  2⁵³ (P05), `bool` for an `int` parameter (P06), `-0.0` (P10), strings and
  lists longer than 60 (P11, P12), nesting depth ≥ 3 (P13).

**Repro:** `node audit/12/mutation-corpus.js --only J04,J05,J07,J12,J13,J23,J31,J32,J38,P01,P02,P03,P05,P06,P10,P11,P12,P13`
and `node audit/8/mutation-corpus.js --only DM3,DM5,DM8`
Observed: each `dry_run/equivalent`, e.g. J12 `{"cur":"false","prop":"true"}`,
P05 `{"cur":"12345678901234567891","prop":"12345678901234567168"}`, DM3
`{"cur":"1500","prop":"1000"}`.
Expected: generate these shapes (at least from type sniffs and literals in
either version: `instanceof Map`, `typeof … 'bigint'`, `isinstance(…, bool)`,
length literals above the cap), or make edits whose literals exceed the
generator's bounds `inconclusive`.

### H3. The mutation step is satisfied by a mutant of a changed token that is unrelated to the semantic change

**Affected code:** `src/agents/executor.js` `mutationEvidence` (any killed
mutant of a hunk's inserted tokens), `src/rl/bug-injector.js` `editMutants`.

**Impact.** When the inserted tokens carry both the semantic change and a
mutable literal or condition, the suite kills a mutant that breaks every input
while never exercising the change. DM3 (`String(s)` → `String(s).slice(0,
1000)`) commits because `slice(1, 1000)` fails `body('abc') === 'abc'`; Y9's
`if (i) lastSeen = i` commits because `if (!(i))` fails a test of a truthy key.

**Repro:** `node audit/12/e2e-commit.js Y8 Y9`
Observed: `Y8 status=passed … mutation: mutants=2 run=1 killed=numeric_off_by_one (line 3)`,
committed; witness `body('x'.repeat(1500)).length` 1500 → 1000.
Expected: per-hunk evidence that targets the behaviour the diff introduces
(e.g. require the suite to fail on the reverted hunk, i.e. on `current_code`
for that hunk), or treat the bar as unmet when only unrelated mutants die.

### H4. SG20's once-per-target state comparison misses state that differs mid-run

**Affected code:** `src/validation/diff-sandbox-worker.js` `main`: when either
side's load-time state exceeds `STATE_NODES` (2,000 nodes), `__dt.defer()`
stops per-call state capture in `take()` and `stateOf` compares state once
after the target's runs.

**Impact.** A module with a large table plus a small mutable binding is
compared only at the end of each target. A change whose state effect differs
on some calls but coincides after the last one (a guarded `lastSeen`, a
toggle made idempotent after an even number of calls) is `equivalent`. The
SG20 log already noted "deferred state misses a state change a later call
undoes"; Y9 shows it commits.

**Repro:** `node audit/12/mutation-corpus.js --only J60,J61` and `node audit/12/e2e-commit.js Y9`
Observed: `J60 dry_run/equivalent(runs=57)` witness `{"cur":"0","prop":"5"}`;
`J61 … {"cur":"false","prop":"true"}`; Y9 committed.
Expected: compare per-call state digests of the small mutable bindings
(hash, not full serialisation) even in deferred mode, or treat deferred
comparison as `inconclusive` when any binding written by the target differs
between versions statically.

---

## Medium

### M1. 12 of 48 benign refactors are rejected at the gate (25.0 %)

`node audit/12/mutation-corpus.js --benign`. Strictly equivalent edits
rejected (4): K22 (`Array.from(map.values())` → spread, too few value runs),
Q05 (loop → `any()`, `guard_removal` veto although the diff test is
`equivalent`), Q13 (dict comprehension, too few value runs), Q16 (Python
comment-only edit: "no callable function located", `runs=0` → rejected).
Edits that differ only outside the evident domain (8): K05, K13, K16
(`undefined`/`NaN` arguments), K07, K14, K18, K25 (a string where an array is
expected), Q03 (a list where a dict is expected). AUDIT-8 corpus benign: 3/34
(JS N06, N10; Python NP2), unchanged.

### M2. 8 of 16 gate-passing safe refactors with thorough suites are reverted by the executor

`node audit/12/executor-benign.js`. `tests_insensitive` with `mutants=0`
(the changed tokens have no mutation operator): parameter rename (B01),
`let` → `const` (B02), `for` → `for…of` (B03), concat → template literal (B05),
`Object.assign` → spread (B06), `Math.pow` → `**` (B09), Python local rename
(B16); comment-only edit → `edit_not_exercised` (B13). Two more are vetoed at
the gate (B07, B14, out-of-domain inputs). 8/18 committed overall.

## Low

### L1. Regex-literal edits are diffed character by character

`src/utils/hunks.js` `JS_TOKEN` has no regex-literal rule, so `/\s+/g` →
`/ +/g` deletes `\`, `s` and inserts only a space (not a token): the hunk is
a pure deletion and needs no mutant (J38, `obs=true`). Expected: tokenize
regex literals whole.

### L2. `condition_change` stops being a veto exactly where the diff test is weakest

`hybrid-validator.js` `relaxConditionChange` downgrades the Python
`condition_change` veto to a score whenever the diff test is `equivalent`, so
it never backstops the H2 domain gaps (Y3 commits with `failed_checks=[condition_change]`).

## What holds

- Round-1/2/3 Critical/High repros stay fixed (`node audit/12/prior-recheck.js`,
  5/5 ok); `audit/5/e2e-commit.js` and `audit/8/e2e-commit.js` commit nothing.
- Console/log side effects (JS), key order, frozenness, descriptors,
  prototypes, host-global sniffs, realm mutation and Python arithmetic/
  builtin/exception changes from AUDIT-8 are all caught.
- Fresh shapes caught: int32 wrap (J01, J02), `NaN`/string domain (J06, J15),
  array/string caps that were mined (J16, J17), recursion depth (J18), float
  order (J19), aliasing and shared references (J43, J44), braced and `while`
  deletions (J52–J58 except the braceless/short-circuit ones), cache/flag state
  that differs at the end (J63, J64), static/function-property writes (J65,
  J66 inconclusive), Python tuples/bytes/dicts (P04, P14, P15, P19), async
  results (P29), bound methods (P31).
- Per-hunk mutation: hunks with no mutable inserted token are reverted
  (`tests_insensitive`), and a braced pure deletion that the sandbox did not
  reach is reverted (Y5).

## Repro index (`audit/12/`)

| script | what it shows |
|---|---|
| `prior-recheck.js` | rounds 1–3 repros and accept lists (5/5 ok); AUDIT-8 DM3/DM5/DM8 still escape |
| `corpus.js` | 60 JS + 35 Python witnessed mutants (domain, oracle, deletion, large-module state) + 32 JS / 16 Python benign refactors |
| `mutation-corpus.js` | the corpus through `processProposal` (dry run), unanimous critic; per-category table; `--only ID,…`, `--benign` |
| `e2e-commit.js` | Y1–Y9: real worktree, real `node --test`/pytest, commit on `refactor/<run_id>` (C1: Y1–Y3; C2: Y4 with control Y5; H1: Y6, Y7; H3: Y8, Y9; H4: Y9) |
| `executor-benign.js` | 18 safe refactors with thorough suites end to end; executor over-revert rate (M2) |

Shared helpers (`makeRepo`, `throughGate`, `e2e`, stub juries, witness
runners, temp state) are reused from `audit/5/lib.js` and `audit/1/lib.js`.
