# AUDIT-16: Validation soundness, round 6 (no false negatives)

Audited commit `d728205` (after SG25). The auditor did not write the code
under audit. Every repro uses the repo's stub client and a temp
`REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js` and
`audit/5/lib.js`). None call the live API. None touch `src/`, `test/`,
`state/` or `dashboard/`. Each script runs from the repo root as
`node audit/16/<script>.js`. It prints `FINDING` or `ok`, and exits 1 on a
reproduced finding. Orchestrator `[orch] …` log lines are left out below.

The critic in every end-to-end scenario is **unanimous**: 3/3 personas
approve with `p_preserves` 0.9 and no `edge_cases`. Each corpus entry has two
checks in `run.js`:
- a real `node`/`python3` witness confirms that it changes observable
  behaviour (otherwise `BADWITNESS`);
- its suite passes on the **current** version (otherwise `BADSUITE`).

The final corpus has 0 of either.

## Summary

**The prior repros mostly hold, and SG25 closed what it targeted.**
- `audit/5`, `audit/8` and `audit/12` `e2e-commit.js` commit nothing.
- `audit/15/crash-after-commit-inflight.js` and
  `audit/13/py-mutant-import.js` are ok.
- `node audit/13/run.js` commits 8 of 81 (was 16 of 81). All 8 are the
  known-limit deletions, and all 8 are Medium (M1).

**The commit bar is still unsound for changes carried by a reference.** The
fresh corpus has 52 witnessed semantics changes (23 JS + 29 Python, with
shapes that are not in `audit/{5,8,12,13}`). `node audit/16/run.js` runs them
end to end, and **19 are committed**:

| category | committed |
|---|---|
| ref-local | 11/13 |
| ref-shared | 2/3 |
| ref-load | 3/4 |
| del-probe | 2/8 |
| cond | 1/5 |
| ref-ctl | 0/3 |
| domain | 0/16 |

The SG25 carried-reference rule (`moduleBindings` / `carriedReferences`)
does fire for a plain `NAME = value` / `const NAME = value`. It misses other
top-level bindings that CLAUDE.md says it covers (C1), and a load crash
counts as a kill (C2). It also cannot see references that are not top-level
(H1), and it accepts a kill that comes from a different consumer of the same
binding (H2).

| severity | count |
|---|---|
| Critical | 2 |
| High | 2 |
| Medium | 3 |
| Low | 1 |

### SG25 changes probed

| change | result |
|---|---|
| carried references (`moduleBindings` / `carriedReferences`) | fires for `NAME = v`; misses destructured, tuple, indented and import bindings (C1), locals and attributes (H1); a cross-consumer kill satisfies it (H2) |
| `unmutated_ref` | works: `K21`, `N23` (replaced member) end `tests_insensitive` |
| `collection_error` | exit 2 is not a kill (`N09` reverted); an import failure with exit 1 is a kill (C2) |
| `python -m pytest` for mutant runs | fixed (`audit/13/py-mutant-import.js` ok) |
| chained-comparison tail / match-guard / later-iterable probes | U01 stopped; N14, N16, N17, N19, N20 stopped; deleted match-pattern alternative N12 committed on a generator gap (M2) |
| `condition_change` `deletes_condition` | vetoes deletions (N14, N17, N20); a replaced comparator is still relaxed (N18, M2) |
| committed-snapshot discard on startup | `audit/16/snapshot-discard.js` ok: discards only when the `HEAD` trailer matches and the files equal `HEAD`, so it never keeps an uncommitted edit |

---

## Critical

### C1. Top-level bindings that CLAUDE.md calls carried references are not detected; the commit stands on the unrelated slice start `0`

**Affected code:** `src/rl/bug-injector.js` `moduleBindings`.
- JS: it reads only `VariableDeclaration` declarators whose `id` is an
  `Identifier` and that have an `init`, plus function and class
  declarations. Destructured bindings are skipped, and so are bindings
  assigned later.
- Python: it reads only column-0 `NAME =`, `def` and `class` lines.

So `carriedReferences` returns nothing for these names. The hunk's only site
is the slice start `0`, which off-by-one kills on the common path.

**Rule as written (CLAUDE.md, Carried references):** "an inserted identifier
… that names a top-level binding of the file defined outside the edit … every
site of that binding's definition … needs its own kill … A reference with no
definition in the file … or no parse-valid mutant of it is no evidence
(`tests_insensitive`)." Every name below is a top-level binding of the file.

**Repro:** `node audit/16/run.js --only K02,K03,N02,N03` (end to end) and
`node audit/16/carried-refs.js` (unit level, 9 shapes).
```
K02 COMMITTED passed dt=equivalent(runs=57) mut(h=1 sites=1 mutants=1 run=3 killed=numeric_off_by_one@5)
    const { maxLen } = LIMITS;   -  return String(s); | +  return String(s).slice(0, maxLen);   witness 5000 -> 4096
K03 COMMITTED  ... const [MIN_LEN, MAX_LEN] = [1, 4096];  + .slice(0, MAX_LEN)                     witness 5000 -> 4096
N02 COMMITTED  ... MIN_LEN, MAX_LEN = 1, 4096            + str(s)[0:MAX_LEN]                      witness 5000 -> 4096
N03 COMMITTED  ... try: MAX_LEN = 4096 / except: MAX_LEN = 1024  + str(s)[0:MAX_LEN]               witness 5000 -> 4096

carried-refs.js:
ok      JS const X = 4096 (control)          sites=2 ref-mutants=1
FINDING JS const { maxLen } = LIMITS         sites=1 ref-mutants=0 [numeric_off_by_one@5]
FINDING JS const [MIN, MAX] = [1, 4096]      sites=1 ref-mutants=0
FINDING JS let X; X = 4096                   sites=1 ref-mutants=0
FINDING JS const { MAX } = require(...)      sites=1 ref-mutants=0
ok      Py X = 4096 (control)                sites=2 ref-mutants=1
FINDING Py MIN, MAX = 1, 4096 / try: X = … / if/else X = … / from app.limits import X / for X in …: ref-mutants=0
```
**Expected:** every top-level binding (destructuring, tuple targets, bindings
assigned inside a top-level `if`, `try` or `for`, import bindings) is either
mutated at its definition or reported as `unmutated_ref`.

### C2. A mutant that breaks module import counts as a kill

**Affected code**
- `src/runner/test-runner.js`: `collection_error` is set only for
  `framework === 'pytest'` with exit 2–5.
- `src/agents/executor.js` `mutationEvidence`: every other failed run counts
  as a kill.

When a carried reference's definition is a module-level expression, the
mutant of its only site can crash the load. The SG25 rule then reads that
crash as a kill of the reference. No test checked the value.

**Rule as written (CLAUDE.md):** "a run that fails at collection or import
(pytest exit 2–5) is never a kill". The three runs below fail at collection
or import, and each counts as a kill:
- `--continue-on-collection-errors` in `pytest.ini` makes the exit code 1.
- A test that imports the module inside the test function fails with exit 1.
- A JS test file whose `require` throws fails the run.

The control N09 (default pytest config, exit 2) is correctly not a kill and
is reverted.

**Repro:** `node audit/16/run.js --only K09,N08,N09,N10` and
`node audit/16/collection-error.js`.
```
K09 COMMITTED passed mut(h=1 sites=2 mutants=2 run=6 killed=numeric_off_by_one@5)   PROFILES[1].max -> PROFILES[2].max throws at require
N08 COMMITTED passed mut(h=1 sites=2 mutants=2 run=6 killed=numeric_off_by_one@6)   pytest.ini addopts=--continue-on-collection-errors
N09 stopped   reverted(tests_insensitive) mut(... killed=null surviving_ref=MAX_LEN collection_errors=1)   (control)
N10 COMMITTED passed mut(h=1 sites=2 mutants=2 run=6 killed=numeric_off_by_one@6)   import inside the test function
    all three: + str(s)[0:MAX_LEN] / .slice(0, MAX_LEN), witness 5000 -> 4096

collection-error.js:
a default config, import at module level: status=failed exit=2 collection_error=true -> not a kill
b --continue-on-collection-errors in pytest.ini: status=failed exit=1 collection_error=false -> scored as a KILL
c default config, import inside the test function: status=failed exit=1 collection_error=false -> scored as a KILL
```
**Expected:** a mutant run where the mutated module fails to load (JS
`require` or Python import: an ImportError or any exception raised from the
module body, whatever the exit code) is never a kill. For example, load the
mutated module once on its own first: if the load throws, there is no kill.

---

## High

### H1. A reference outside the documented definition carries the change; the only kill is the unrelated slice start

**Affected code:** `bug-injector.js` `carriedReferences`. A reference counts
only when it is a top-level binding or replaces another identifier. These
references carry the cap but are not counted:
- a function-local constant;
- a destructured local;
- a local dict key;
- a class attribute read through `this.` / `self.` (members are skipped);
- a nested helper's default parameter.

The relevance rule is met, as written, by a kill of the inserted `0`. Same
class as AUDIT-13 H1, which SG25 fixed only for top-level names.

**Repro:** `node audit/16/run.js --only K01,K04,K06,N01,N04,N06,N29`. All 7
are committed; witness `len(body("x" * 5000))` changes from 5000 to 4096.
```
K01 COMMITTED mut(h=1 sites=1 run=3 killed=numeric_off_by_one@5)  const max = 4096 (local);  + out.slice(0, max)
K04 COMMITTED mut(h=1 sites=1 run=3 killed=numeric_off_by_one@5)  static MAX = 4096;          + .slice(0, this.MAX)
K06 COMMITTED                                                     const { max } = CONFIG.body (local)
N01 COMMITTED mut(h=1 sites=1 run=3 killed=numeric_off_by_one@4)  limit = 4096 (local);        + out[0:limit]
N04 COMMITTED                                                     class attr MAX;              + str(s)[0:self.MAX]
N06 COMMITTED mut(h=1 sites=2 run=6 killed=string_literal@3)      cfg = {"max": 4096};        + str(s)[0:cfg["max"]]
N29 COMMITTED mut(h=1 sites=2 run=6 killed=string_literal@4)      def cut(x, n=4096) nested;  + cut(str(s)) + ""
```
**Expected:** an inserted identifier or member that resolves to a binding
defined outside the hunk is a carried reference. Its definition sites need
kills, or the hunk is `unmutated_ref`. This covers local and enclosing
scopes, `this.`/`self.`/class attributes, and nested functions.

### H2. A carried reference's definition is killed by a different, tested consumer of the same binding

**Affected code:** `executor.js` `mutationEvidence`. A kill at a definition
site is accepted whichever test fails. `MAX = 4096` is shared with `title()`,
whose own test feeds a 5000-character string. That test kills `4096 → 4097`.
The new truncation in `summary()` is never tested beyond 3 characters.

**Repro:** `node audit/16/run.js --only K07,N07`
```
K07 COMMITTED passed mut(h=1 sites=2 mutants=2 run=6 killed=numeric_off_by_one@7)  + String(s).slice(0, MAX)  witness 5000 -> 4096
N07 COMMITTED passed mut(h=1 sites=2 mutants=2 run=6 killed=numeric_off_by_one@9)  + str(s)[0:MAX]           witness 5000 -> 4096
```
**Expected:** a definition-site kill counts for the edit only when a failing
test executed the edited hunk. Coverage per test, or failing tests filtered
by the coverage of the edited function, would give this.

---

## Medium

### M1. The 8 remaining AUDIT-13 commits are diff-test blind spots that README "Known limits" lists (verified)

`node audit/13/run.js` reports `outcomes: committed 8, vetoed 52,
reverted:tests_insensitive 14, critic_rejected 6, edit_not_exercised 1`. All
8 are pure deletions (`sites=0 mutants=0`) committed on `equivalent` +
`deletions_observed: true`. The source was checked, not taken from the
report. In each case the deleted token sits in an unconditional statement
(or, for P01, the function's head declaration), so it really runs on every
call. The probe is therefore on the deleted code, not on unrelated code, so
none of them is High. Only the input or the effect is missing:

| id | deleted | why equivalent | README class |
|---|---|---|---|
| T02 | `.replace(/\t/g,'    ')` | no tab strings built | inputs: tabs |
| D02 | `.replace(/​/g,'')` | U+200B never built | zero-width chars |
| D03 | `.slice(0, CAP)` | arrays shorter than 100 | list past a cap |
| U02 | `del tags[:-MAX_TAGS]` | lists shorter than 100 | list past a cap |
| P03 | `unicodedata.normalize("NFKC", …)` | no compatibility chars | compatibility chars |
| G12 | `flat(Infinity)` → `flat()` | nesting depth < 2 | deeper nesting |
| U05 | `await db.save(rec)` → `db.save(rec)` | stub never rejects | dropped await |
| P01 | `global _cache` | calls never chained | module state across calls |

The suite is the only backstop: each one passes on both versions.

### M2. New committed generator blind spots: a mined literal past the `any` pool slice, non-ASCII, big integers

`node audit/16/run.js --only N12,N15,N18`
```
N12 COMMITTED passed dt=equivalent(runs=78 obs=true) mut(sites=0)   case "get" | "head": -> case "get":       kind("head") 'read' -> 'other'
N15 COMMITTED passed dt=equivalent(runs=78 obs=true) mut(sites=0)   case str(s) if s and s.isascii(): -> if s:  word("é") 'other' -> 'ascii'
N18 COMMITTED passed dt=equivalent(runs=46) checks=[condition_change] killed=negate_equality@2   2**53 < n <= 2**64 -> 2**53 < n != 2**64
```
- **N12.** The deleted alternative does run: it is tried for every non-`get`
  input, so `obs=true` is correct. But `"head"` is never built.
  `py_diff_harness.py` `pools_from` / `pool` uses only `S[:14]` for an
  `any`-hinted argument. Breadth-first `literals()` puts the `return`
  strings `read`/`other` first, so the pattern literal falls outside the
  slice. A direct run of `case "get" | "head"` → `case "get" | "hea"` is
  `equivalent` (78 runs); the `if … or cmd == "head"` form is `divergent`.
- **N15.** Non-ASCII strings are not built for a match-subject argument.
- **N18.** A replaced (not deleted) comparator has no `deletes_condition`,
  so `condition_change` is relaxed as documented. The kill is on the changed
  token.

All three meet the bar as written, with evidence on the changed code. These
are inputs the generator never builds.

### M3. Executor over-rejection of safe refactors: 13 of 18

`node audit/12/executor-benign.js` (exit 1): B01 B02 B03 B05 B06 B09 B10 B12
B16 B17 end `reverted tests_insensitive` with `mutants=0`. B13 ends
`edit_not_exercised`, and B07 and B14 are `vetoed`. This matches the SG25
log (10 → 13 since SG24). No soundness impact.

## Low

### L1. CLAUDE.md says the string mutation applies to the "empty string"; it mutates every string literal

`bug-injector.js` `EDIT_OPS.string_literal` (`/(['"]) *\1/`) runs on the
blanked source, where every string body is spaces. So `"max"` in N06 is a
site, and its mutant was the killing one (`killed=string_literal@3`). The
CLAUDE.md site list says "empty string".

## What holds

- **Prior repros:**
  - `audit/5/e2e-commit.js`: E1–E8 and E5c are not committed.
  - `audit/8/e2e-commit.js`: X1–X6 are not committed.
  - `audit/12/e2e-commit.js`: Y1–Y9 are not committed, and the Y5 control
    is reverted.
  - `audit/15/crash-after-commit-inflight.js`: ok (A15-H1 fixed).
  - `audit/13/py-mutant-import.js`: ok (A13-C2 fixed).
  - `audit/13/run.js`: U01, Q15, Q21, T06, U04, R05 and G05 are all stopped
    (A13-C1/H1 fixed for top-level names).
- **Carried references the rule does see:**
  - top-level `const`, annotated Python constant, frozen config object,
    swapped top-level limit: K10, K11, N11 end `tests_insensitive` with
    `surviving_ref`;
  - replaced member or global: K21 `isSafeInteger`, N23 `lower` end
    `unmutated_ref`.
- **`deletes_condition`:** keeps the veto for a deleted tail in a match
  guard, a comprehension filter or an `any()` operand (N14, N17, N20). The
  three-way chain N19 is divergent.
- **Deletion probes:**
  - `||=` right-hand side: K16 `obs=false` → `tests_insensitive`.
  - optional-call argument (K15) and `??=` (K17): `divergent`.
- **Gate (domain):** 16 domain entries, none committed (`>>> 0`, `??`→`||`,
  `2**53` boundary, astral `length`, NaN dedupe, `encodeURI`, cents
  rounding, byte length, `round`, `isfinite` guard (`guard_removal`),
  `sorted(set)`, NFC).
- **Snapshot discard:** `audit/16/snapshot-discard.js` ok in all four cases
  (after the commit → discard; mid-test with another issue, a same-issue
  trailer, or the issue named only in the reasoning → restore).

## Repro index (`audit/16/`)

| script | what it shows |
|---|---|
| `corpus.js` | 23 JS + 29 Python witnessed semantics changes in these categories: ref-local, ref-shared, ref-load, ref-ctl, del-probe, cond, domain |
| `run.js` | the corpus end to end: worktree, real `node --test` / pytest + coverage.py, per-site mutants, commit. Also checks the suite on the current version. `--only ID,…`, `--json out`. FINDING on any commit |
| `carried-refs.js` | C1 at unit level: `editMutants` output for 11 top-level binding forms |
| `collection-error.js` | C2 at runner level: how an import failure of the mutated module is labelled |
| `snapshot-discard.js` | SG25 startup discard: never drops an uncommitted edit |
