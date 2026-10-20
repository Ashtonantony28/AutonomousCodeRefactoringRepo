# AUDIT-13: Validation soundness, round 5 (no false negatives)

Audited commit `62485b9` (SG23, after SG22). The auditor did not write the
code under audit. All repros use the repo's stub Claude client and a temp
`REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js` and
`audit/5/lib.js`). None call the live API, and none touch `state/`,
`dashboard/`, `src/` or `test/`. Each script runs from the repo root as
`node audit/13/<script>.js`; it prints `FINDING` or `ok` and exits 1 on a
reproduced finding. Orchestrator `[orch] …` log lines are omitted below.

The critic used for every scenario is **unanimous:** 3/3 personas approve with
`p_preserves` 0.9 and no `edge_cases`, which clears the jury part of the bar on
its own. A real `node`/`python3` witness confirms every corpus entry changes
observable behaviour (`run.js` marks any non-differing entry `BADWITNESS` and
drops it; the final corpus has 0).

## Summary

**All prior soundness repros stay fixed, and the builders' edits since round 4
did not weaken them.** `node audit/12/e2e-commit.js` commits 0 of Y1–Y9 (the
round-4 C1/C2/H3/H4 commits are reverted); `node audit/8/e2e-commit.js` 0 of
X1–X6; `node audit/5/e2e-commit.js` 0 of E1–E8; `node audit/12/prior-recheck.js`
rounds 1–3 ok. The only prior escapes still present are AUDIT-8 DM3/DM5/DM8 and
the AUDIT-12 gate-only escapes, both of which the executor still reverts (M1).
No audit script or fixture under `audit/{1,5,8,12}` or `test/fixtures/` changed
since AUDIT-12 (`git diff acd90df..HEAD`).

**The commit bar is still unsound.** Fresh corpus, 81 witnessed semantics
changes (50 JS + 31 Python, new shapes; `audit/13/corpus.js`), each run end to
end with a suite that calls the edited code and passes
(`node audit/13/run.js`):

- **16 are committed** on `refactor/<run_id>` (JS 8, Python 8). By category:
  relevance 3/7, deletion-domain 5/6, deletion-oracle 2/4, oracle 2/10,
  domain 3/52, deletion-observed 1/2.

The commits fall into two bar steps that are **not enforced as documented**
(Critical) and three ways the relevance / deletion-observation rules are
**satisfied by evidence unrelated to the change** (High).

| severity | count |
|---|---|
| Critical | 2 |
| High | 3 |
| Medium | 3 |
| Low | 1 |

---

## Critical

### C1. A deleted chained-comparison operand is reported "observed" though it never executed

**Affected code**
- `src/validation/py_diff_harness.py` `probe` / `site`: `COND_EXPR` has no
  entry for `ast.Compare`, and a chained comparison `a < n <= b` is a single
  `Compare` node, not a `BoolOp`. So the probe for a deleted `<= b` operand
  lands on the enclosing `return` statement, not on the operand.
- `src/agents/executor.js` `mutationEvidence`: a deletion-only hunk stands on
  `diffTest.verdict === 'equivalent' && deletions_observed === true` with no
  killed mutant.

**Impact.** Python evaluates `a < n <= b` as `(a < n) and (n <= b)` with
short-circuit, so `n <= b` runs only when `a < n`. When the generator never
builds an `n` that makes the first comparison true, `n <= b` never executes,
yet the probe (sitting on `return`) runs on every call and reports
`deletions_observed: true`. The documented rule — "a deletion is observed only
if the deleted expression itself executed (probe the deleted sub-expression /
branch)" — is violated. The JS analogue (`n > 100 && n <= 200` → `n > 100`) is
correctly `divergent`, because `&&`'s right operand is a probe site.

**Repro:** `node audit/13/run.js --only U01`

Observed:
```
U01  COMMITTED  passed dt=equivalent(runs=46 obs=true) checks=[condition_change]
     mut(h=1 sites=0 mutants=0 run=0 killed=null)
     witness cur=False prop=True
     committed …: -    return 2 ** 53 < n <= 2 ** 64  |  +    return 2 ** 53 < n
```
Expected: probe the deleted comparator (a `Compare` tail / each `and`-split
operand); if it did not run, `deletions_observed: false` and `tests_insensitive`.

### C2. Every Python mutant run fails to import the package, so the per-site mutation bar is a collection artifact

**Affected code:** `src/runner/test-runner.js` `runTests`: the *edit* run uses
`cmd = pytestPythonWithCoverage(); args = ['-m','coverage','run','-m','pytest', …]`
(`python -m` puts the repo root on `sys.path[0]`), but *mutant* runs call
`runTests` with no `edit`, so `tool = null` and the command is the bare
`pytest` console script, which does **not** add the repo root to `sys.path`.
`mutationEvidence` scores any `status === 'failed'` as a killed mutant.

**Impact.** For the standard layout (a first-party package imported by the
tests: `import app.x`, a `tests/` dir with no `__init__.py`, no root
`conftest.py`), every mutant run fails at **collection**
(`ModuleNotFoundError`, exit ≠ 0) → counted as *killed*, independent of whether
the suite is sensitive to the mutation. A mutant byte-identical to the
committed edit is "killed" too. The per-site rule ("every changed mutation site
has its own killed mutant of that site") is vacuously satisfied for this whole
class of Python repos, so a one-for-one literal/operator replacement whose diff
test is `equivalent` (oracle-blind) commits on a suite that never tests the
change.

**Repro:** `node audit/13/py-mutant-import.js` (self-contained), and
`node audit/13/run.js --only Q15,Q21` (commits).

Observed (`py-mutant-import.js`):
```
edit run   (python -m coverage run -m pytest): status=passed exercised=true
mutant run (bare pytest):                      status=failed passed=0 failed=0
identical-to-edit mutant (bare pytest):        status=failed passed=0 failed=0
FINDING: the mutant run fails only because the bare `pytest` script leaves the
         repo root off sys.path; a behaviourally identical mutant is scored as
         killed, so the per-site mutation bar is an import artifact.
```
Q15 (`x + n * 2` → `x + n * 3`, suite only asserts `callable`) and Q21
(generator item past the drain window) commit with `sites=1 run=1 killed=…`.
Expected: run mutants through the same invocation as the edit (or on a path that
puts the repo root on `sys.path`); a collection error is `environment_error`,
never a kill.

---

## High

Each is a committed semantics change where the relevance or deletion-observation
rule is satisfied by evidence unrelated to the change, with a witness.

### H1. The per-site relevance rule is satisfied by a kill of a token unrelated to the change

**Affected code:** `src/agents/executor.js` `mutationEvidence` /
`src/rl/bug-injector.js` `editMutants`. A site is an inserted token a mutation
operator applies to; the change itself is carried by an un-mutated identifier,
helper call or named constant, while the only killable site is an unrelated
token on the common path (the SG22 log's open note "the relevance rule cannot
see a change carried by an identifier", now reaching commits).

**Impact / repro:** `node audit/13/run.js --only T06,U04,R05,G05`
- T06: `String(s)` → `String(s).slice(0, MAX_BODY)`; only site is the slice
  start `0` (killed by off-by-one, breaks `body('abc')`), the cap `MAX_BODY`
  is never mutated. Witness `body('x'.repeat(5000)).length` 5000 → 4096.
- U04: a guard `if (isSafe(n))` added; the only site is the `if` (negation kills
  the common path), the threshold in `isSafe` is never tested. Witness
  `addPoints(u, 2**60)` unclamped → clamped.
- R05 (Python): `str(s)[0:LIMIT]`; only site is `0`, `LIMIT` untested.
- G05: `includes(x)` → `indexOf(x) !== -1`; the `-1` mutant kills, the NaN
  behaviour is untested.

### H2. A pure deletion is "observed" but the diff test is equivalent on the inputs the generator never builds

**Affected code:** `src/validation/diff-testing.js` input construction and
`src/validation/py_diff_harness.py` `pools`/`pool`. The deleted code runs in
the sandbox (`deletions_observed: true`), but only on inputs where it is
behaviourally inert, so the verdict is `equivalent` and the deletion commits
with 0 mutants.

**Impact / repro:** `node audit/13/run.js --only T02,D02,D03,U02,P03,G12`
- T02: `line.replace(/\t/g,'    ').search(…)` → `line.search(…)` (no tabs built).
- D02: `s.replace(/​/g,'').trim()` → `s.trim()` (U+200B not built, not trimmed).
- D03 / U02: a list-length cap (`slice(0, CAP)` / `del tags[:-MAX_TAGS]`)
  deleted (harness arrays/lists stay under the cap).
- P03: `unicodedata.normalize("NFKC", s)` deleted (no compatibility chars).
- G12: `flat(Infinity)` → `flat()` (nesting depth below the built depth).

### H3. A pure deletion is "observed" but its effect is invisible to the oracle

**Affected code:** `src/validation/diff-sandbox-worker.js` and
`py_diff_harness.py` oracle. The deleted statement runs, but the oracle cannot
represent its effect, so the verdict is `equivalent`.

**Impact / repro:** `node audit/13/run.js --only U05,P01`
- U05: `await db.save(rec)` → `db.save(rec)` (the recording stub resolves and
  never rejects; the dropped await is invisible). Witness: current rejects a
  bad record, proposed resolves `true`.
- P01 (Python): `global _cache` removed from `reset()` (rebinds a local); the
  oracle calls each function on a fresh module and never chains
  `get()` then `reset()`, so the module-state divergence is unseen.

---

## Medium

### M1. The diff test reports `equivalent` for many semantics changes the executor still stops

`node audit/12/mutation-corpus.js`: 32/94 witnessed mutants pass the gate
(`dry_run/equivalent`, JS 16/59, Python 16/35, unchanged from round 4) — input
domain, oracle and state blind spots (P20/P24/P27/P30/P32, J40, large-string /
BigInt / nesting, AUDIT-8 DM3/DM5/DM8). The executor reverts the untested ones;
in this corpus 51 entries are `vetoed`, 7 `reverted tests_insensitive`, 1
`edit_not_exercised`. These are blind spots that do not, by themselves, reach a
commit.

### M2. Benign over-rejection at the gate: 12 of 48 (25.0 %)

`node audit/12/mutation-corpus.js --benign` (32 JS + 16 Python safe refactors):
12 rejected (JS 8/32, Python 4/16), unchanged since round 4 — `undefined`/`NaN`/
out-of-domain argument differences read as inconclusive, a `guard_removal` veto
on an `any()` rewrite, comment-only and too-few-value-run cases.

### M3. Executor over-revert: 10 of 18 safe refactors with thorough suites

`node audit/12/executor-benign.js`: parameter rename, `let`→`const`,
`for`→`for…of`, concat→template, `Object.assign`→spread, `Math.pow`→`**`,
Python local rename all `reverted tests_insensitive` (`mutants=0`, no operator
applies to the changed tokens); a comment edit `edit_not_exercised`; two
`vetoed` out-of-domain. Unchanged since round 4.

## Low

### L1. `condition_change` stops being a veto exactly where C1 lands

`hybrid-validator.js` `relaxConditionChange` downgrades the Python
`condition_change` veto to a score when the diff test is `equivalent`, so it
does not backstop C1: U01 commits with `checks=[condition_change]` still listed.

## What holds

- Round-1/2/3/4 Critical/High repros stay fixed (`audit/12/prior-recheck.js`,
  `audit/{5,8,12}/e2e-commit.js` commit nothing; Y1–Y9 reverted).
- Caught in this corpus: int32 wrap, `parseInt`/`Number`, prototype chain,
  Map/Set branches with a built input, `||` falsy default, sort order, Date
  branch, aliasing/mutation (`reverse`, `splice`), frozen/error-type/key-order
  oracle, Python `//`/`/`, `isdigit`/`isdecimal`, `dict.get` default,
  `startswith` tuple, `max(default=)`, `round` banker, closures/guards with a
  reachable site — all `vetoed`, `critic_rejected` or `reverted`.
- Per-hunk mutation: JS hunks with no mutable inserted token are reverted
  `tests_insensitive`; braceless/short-circuit JS deletions the sandbox reaches
  are `divergent`.

## Repro index (`audit/13/`)

| script | what it shows |
|---|---|
| `corpus.js` | 50 JS + 31 Python witnessed semantics changes (relevance, deletion-domain/oracle/observed, oracle, domain), new shapes |
| `run.js` | the corpus end to end (worktree, real `node --test`/pytest, per-site mutants, commit); `--only ID,…`, `--json out`; FINDING on any commit |
| `py-mutant-import.js` | C2 in isolation: edit passes under `python -m coverage run -m pytest`, a byte-identical mutant "fails" under bare `pytest` and is scored as a kill |

Shared helpers (`e2e`, `throughGate`, `witness`, `pyWitness`, stub juries,
temp state) are reused from `audit/5/lib.js` and `audit/1/lib.js`.
