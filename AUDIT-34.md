# AUDIT-34: Test coverage and test quality, round 11 (after SG39–SG42)

Audited commit `233e66d` (SG41 + SG42 merged). The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed. Mutants are applied only to temp copies. No API calls were made. Scripts print `FINDING` or `ok` and exit 1 on a reproduced finding.

Environment: Node v22.22.0, 4 CPUs, pytest 9.1.1, coverage.py 7.16.2. Host load 1–8 (other sessions).

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 2 |
| Low | 3 |

- **Mutation testing.** 24 new mutants of rules added or changed in SG41/SG42 (`audit/11/mutants.js`, block "AUDIT-34"). The full suite kills 14 of them and 10 survive:
  - 8 are safety mutants: TR-lastwins, BI-pytry, BI-pyasync, BI-pycase, BI-pysplits, BI-kwelse, BI-kwfor and BI-kwdo.
  - 2 are label mutants that fail closed: TR-ctrltab and TR-hookP.
  - For 7 of the 8 safety survivors, a mutated copy commits an edit that the real code reverts (H1–H3). For BI-kwdo this is shown at `editMutants` level only (M1).
- **Pinned well.** The following SG41/SG42 rules are pinned: TAP unescaping (`\#`, `\\`, Subtest names), suite recording and passing to `loadFailed`, the failing-suite / process-key fallback, the `++`/`--` exclusion, backslash logical lines, the SG41 keyword list, own-paren comma counting, and every switch-value rule (same key, non-empty, random, distinct, executor control env).
- **Flakiness.**
  - `npm test` passed 516/516 in 3 sequential runs.
  - With two concurrent suites (×2, load 2.5–8.1), 1 of 4 runs failed one test: the py-diff-testing deletion-mapping test returned `inconclusive` (M2).
  - The CLI-signal `waitFor` and the tmpdir race were not seen.
- **Coverage.**
  - runner, rl and orchestrator match the SG41 log.
  - validation measured 94.21 in 2 of 2 runs, against the SG41 log's 95.28 (L3). Validation code is unchanged since SG31.
  - No safety file dropped.

### Mutation tally

Commands: `node audit/11/mutants.js <ids>` in two runs. The baseline was 516/516 both times.
- The first run, 14:35–15:49 UTC, was killed externally (exit 137) after 18 verdicts.
- The remaining 6 ids were re-run from 15:49–16:09.

| kind | killed | survived |
|---|---|---|
| safety | 10: TR-suitepass, TR-fbor, BI-pybs, BI-pykwold, BI-owncomma, BI-ctrlkey, BI-ctrlempty, BI-fixedval, EX-ctrlnone, (control) BI-ctrlsame | 8: TR-lastwins, BI-pytry, BI-pyasync, BI-pycase, BI-pysplits, BI-kwelse, BI-kwfor, BI-kwdo |
| redundant | 1: BI-plusplus | 0 |
| label | 3: TR-suiteargs, TR-subuntap, TR-untaphash | 2: TR-ctrltab, TR-hookP |

`node audit/11/mutants.js --check`: `ok: 260 mutants, every pattern matches once`.

## Coverage (`npm run coverage -- --files`, at `233e66d`, load 3.9–5.2)

**Per target:**

| target | SG41 log | now |
|---|---|---|
| src/validation | 95.28 | 94.21 |
| src/runner | 93.88 | 93.88 |
| src/rl | 98.99 | 98.99 |
| src/orchestrator.js | 94.25 | 94.25 |

- `validation`: two runs (load 3.9–5.2 and 1.8–3.9) both gave 94.21% (3350/3556), with identical per-file lists.
  - That is 38 lines below the SG41 log's 95.28%.
  - `src/validation` has not changed since SG31 (`b4f5d91`), so SG41/SG42 cannot have caused the drop.
  - The same 94.21 ↔ 95.28 swing is recorded in the SG39 log, SG26/SG27 and AUDIT-30.
  - Among the lines uncovered in both runs are `diff-testing.js` 316–325 and 336–339 (`pureExpr` cases, `declNames`). They run in the diff-test workers, so the swing looks like worker-coverage collection rather than lost tests (Low; see L3).

**Per file (safety modules):**

| file | AUDIT-30 | now |
|---|---|---|
| `agents/executor.js` | 100.00 | 100.00 |
| `rl/bug-injector.js` | 99.88 | 99.89 |
| `utils/hunks.js` | 98.22 | 98.81 (SG40 removed the dead line) |
| `runner/test-runner.js` | 98.26 | 98.30 |
| `runner/reverter.js` | 92.86 | 92.86 |

No safety file dropped.

---

## High

The backstop for H1–H3 is partial in every case: the gate's diff test must say `equivalent` with deletions observed. The repros pass that verdict, as `test/executor.test.js` does, because the executor bar exists for the diff test's blind spots.

### H1. SG42 swapped block keywords: only the `while`↔`if` and `elif`→`if` arms are pinned

**Where:** `src/rl/bug-injector.js`, `BLOCK_KW = /^(?:if|elif|else|while|for|do)$/`, used by `swappedKeyword`.

**Rule (CLAUDE.md):** "an `if` / `elif` / `while` that replaced another block keyword, which its own condition site does not cover".

**What is tested.** The SG42 tests use only these swaps:
- `while`→`if` and `if`→`while` (JS);
- `while`→`if` and `elif`→`if` (Python).

Dropping `for` or `else` from `BLOCK_KW` leaves all 516 tests green.

| mutant | load-bearing edit (`audit/34/unpinned.js`) |
|---|---|
| BI-kwfor | `for (; n > 0;) { n--; t += 1; }` → `if (n > 0) { … }`: the body runs once instead of n times. Tests use n = 0 and 1. The `if`'s negate_condition kill stands in for the loop. |
| BI-kwelse | Python `else:` → `elif n:`: the branch is dropped for n = 0. Tests use n = 6, 1 and −1. The negate_condition kill and the use-site kill of `n` both stand. |

**Repro:** `node audit/34/unpinned.js BI-kwfor BI-kwelse`
```
[BI-kwfor] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":"if"}
[BI-kwfor] mutated copy: {"status":"passed","commit":"commit","sites":1,"killed":"negate_condition","killed_test":"f"}
[BI-kwfor] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=107 fail=0
FINDING H1 BI-kwfor: rule is load-bearing (mutated copy commits) and the tests stay green with it
[BI-kwelse] real code:    {...,"uncovered_token":"elif"}
[BI-kwelse] mutated copy: {"status":"passed","commit":"commit","sites":2,"killed":"use_site",...}
FINDING H1 BI-kwelse: ...
```

Full suite: `node audit/11/mutants.js BI-kwfor BI-kwelse` reports `FINDING SURVIVED` ×2.

### H2. Structural `;` / `,` (SG37/SG41), Python arms: try / except / finally, async and case heads, and the operand-splitting comma are unpinned

**Where:** `structural()` in `uncoveredToken`.

**What is tested.**
- The SG40/SG41 tests pin `;` on `if` / `for` / `while` / `with` / `def` / `class` lines, on logical-line headers and on backslash continuations.
- The operand-splitting comma is pinned in JS only.

**What is not tested.** Each of the following mutants survives the full suite, and each mutated copy commits an edit the real code reverts as `uncovered_token`:

| mutant | weakening | load-bearing edit |
|---|---|---|
| BI-pytry | `try` / `except` / `finally` dropped from the `;` head list | `except ValueError: t = 0; t = t + 2`: the next statement moves into the handler. Tests pass only non-numbers. |
| BI-pyasync | `async` dropped | `async for x in xs: t += x; t = t + 2`: the statement moves into the loop. Tests use one-element iterables. |
| BI-pycase | `case` clause lines exempt | `case 1: t = t * 3; t = t + 2`: the statement runs only for n == 1. Tests use n = 1. |
| BI-pysplits | Python skips `splits()` (JS keeps it) | `max(n - 1, 0)` → `max(n, - 1, 2)`: `n` becomes its own argument. Tests use n = 0 and 1. |

**Repro:** `node audit/34/unpinned.js BI-pytry BI-pyasync BI-pycase BI-pysplits`. Each case ends with:
```
[BI-…] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":";"}   (BI-pysplits: ",")
[BI-…] mutated copy: {"status":"passed","commit":"commit","sites":1,"killed":"numeric_off_by_one",...}
[BI-…] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=107 fail=0
FINDING H2 BI-…: rule is load-bearing (mutated copy commits) and the tests stay green with it
```

### H3. "Every test and suite of that name must pass": only one order of duplicates is pinned

**Where:** `src/runner/test-runner.js` `loadFailed`, `byName.set(k, byName.get(k) !== false && state === 'pass')`.

**What is tested.** The SG39 test and AUDIT-30's TR-dupname case both put the passing duplicate first. The mutant TR-lastwins (`byName.set(k, state === 'pass')`, so the last entry of a name decides) is therefore never seen by the suite. The same ordering gap applies to a failing test followed by a passing suite of the same name, because `[tests, suites]` puts suites last.

**Example:** two node:test tests are named `x`.
- The first hits the module's load throw and fails. Its wrapper rethrows, so no load frame appears.
- The second catches the throw on purpose.
- The 4 → 5 mutant makes the module throw at load.
- The real code reports `collection_errors: 1` and reverts. The mutated copy counts `x` as a kill and commits an edit whose value nothing asserts.

**Repro:** `node audit/34/unpinned.js TR-lastwins`
```
[TR-lastwins] real code:    {"status":"reverted","reason":"tests_insensitive","sites":1,...,"collection_errors":1}
[TR-lastwins] mutated copy: {"status":"passed","commit":"commit","sites":1,"killed":"numeric_off_by_one","killed_test":"x",...}
[TR-lastwins] tests on the mutated copy: test/executor.test.js test/test-runner.test.js: pass=107 fail=0
FINDING H3 TR-lastwins: rule is load-bearing (mutated copy commits) and the tests stay green with it
```

Full suite: `node audit/11/mutants.js TR-lastwins` reports `FINDING SURVIVED`.

---

## Medium

### M1. BI-kwdo: `do` → `if` is unpinned

**Mutant:** `do` is removed from `BLOCK_KW`. It survives the full suite.

**Example:** `do { t += 1; } while (t < n);` → `if (t < n) { t += 1; } while (t < n);`.
- The real code leaves the `if` uncovered.
- In the mutated copy, the `if` stands on its four condition and use sites.

No executor-level commit was built, because killing every site of `t < n` needs inputs that reveal t ≥ n. The case is narrower than H1 (a JS `do` body turned into a guard).

**Repro:** `node audit/34/kwdo.js`
```
real code:    {"uncovered":"if","sites":[]}
mutated copy: {"uncovered":null,"sites":["negate_condition","use_site","flip_comparison","use_site"]}
FINDING M1 BI-kwdo: …
```

### M2. Diff-testing timing test fails under contention (AUDIT-26 M1 / AUDIT-30 M2, carried)

Two concurrent `npm test` runs were made twice, at load 2.5–8.1. One of the four runs failed with:
```
not ok 406 - a deletion of many tokens deep in a module is mapped in one pass and probed where it runs (AUDIT-14 H1)
  location: test/py-diff-testing.test.js:252:1
  error: target: time budget reached after 18 of 100 runs
  + 'inconclusive'  - 'equivalent'
```
The other three runs passed 516/516.

- The failure fails closed.
- The CLI-signal `waitFor` timeout and the SG40 tmpdir race (AUDIT-30 H4) were not seen. H4 is fixed.
- Sequential runs (3 of 3) were green, so this is not High.

---

## Low

- **L1. Fail-closed label survivors.**
  - **TR-ctrltab** writes only `\n` as TAP does, not tab, CR, `\b`, `\f` or `\v`. A test named with a tab never matches its logged name, falls back to its process key and blocks the kill, so this fails closed. The `loadFailed` / runTests tests use only `\n`.
  - **TR-hookP** logs the exit-0 `P` row only for unnamed rows. A named row with no matching test then never passes, so this also fails closed. No test has a named row whose name is in no TAP result in a process that exits 0.
- **L3. `src/validation` coverage figure is not reproducible across environments.**
  - This audit measured 94.21% in 2 of 2 runs; the SG41 log reports 95.28% on the same code.
  - Both figures are above the 85% budget.
  - The figure should be measured on a quiet host before a per-file drop in validation is called a regression.
- **L2. Harness note.** The first `mutants.js` run was killed with exit 137 (not by the harness) and left its copy `/tmp/audit11-mut-laW5cS` behind. That copy was removed. `/tmp` still holds older `audit11-mut-*` copies from 10:34 and 19:28 that were not made by this audit.

## Repro index

| command | checks | result at `233e66d` |
|---|---|---|
| `node audit/34/unpinned.js [BI-kwfor BI-kwelse BI-pytry BI-pyasync BI-pycase BI-pysplits TR-lastwins] [--no-tests]` | H1–H3: the real executor reverts, the mutated copy commits, and the named test files stay green (Python cases need pytest + coverage.py) | FINDING ×7, exit 1 |
| `node audit/34/kwdo.js` | M1 | FINDING, exit 1 |
| `node audit/11/mutants.js --check` | every pattern matches once | ok, 260 |
| `node audit/11/mutants.js <24 AUDIT-34 ids>` | tally above | 8 safety survivors |
| `npm test` ×3 sequential | flakiness | 516/516 ×3 |
| two concurrent `npm test` ×2 | flakiness under contention | 3 of 4 runs green, 1 failed one test (M2) |
| `npm run coverage -- --files` ×2 | coverage | validation 94.21 / runner 93.88 / rl 98.99 / orchestrator 94.25 |
