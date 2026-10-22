# AUDIT-30: Test coverage and test quality, round 10 (after SG36–SG38)

Audited commit `1fe6399` (SG36 + SG37 + SG38 merged). The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed. Mutants are applied only to temp copies. No API calls were made. Scripts print `FINDING` or `ok` and exit 1 on a reproduced finding.

SG39 (`bd0df2e`) landed during the audit. Its effect on the findings was checked by reading the diff, not by re-running (see "SG39" below).

Environment: Node v22.22.0, 4 CPUs, other sessions' load 1–8. pytest 9.1.1 was installed for the Python repros (`pip install --user pytest`). coverage.py 7.16.2 was already present.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 4 |
| Medium | 2 |
| Low | 4 |

- **Mutation testing.** 23 new SG37/SG38 mutants were run, plus TR-caught (re-anchored) and the six AUDIT-26 survivors.
  - The AUDIT-26 survivors are now all killed: EX-bare, BI-applied, BI-prefix, HK-bigint, HK-octal and S-kill. SG36 holds.
  - 9 safety mutants survive the full suite. Of these, 7 are load-bearing: a mutated copy commits an edit that the real code reverts (H1–H3). TR-dupprefix is shown to matter only at the `runTests` level (M1), and BI-elsedo is equivalent in practice (L1).
- **Flakiness.**
  - `npm test` passed 505/505 in 6 sequential runs (3 quiet, 3 at load 5.6–8.0).
  - The `refactor-cov-` tmpdir test (`test-runner.test.js:223`) fails whenever another run creates a `refactor-cov-*` dir in the same tmpdir. The repro script shows this deterministically (H4). In 4 runs of two concurrent suites, it failed in 2.
  - The same harness run also saw this test give a false kill (TR-hookany).
- **Coverage.** All targets are at or above the SG37 figures. The `hunks.js` drop to 98.22% comes from SG37's NaN line, which made `valueKey`'s fallthrough and its `/j$/` test dead (L2).

### Mutation tally

Command: `node audit/11/mutants.js <ids>`, one run of 30 ids, 05:03–06:40 UTC. The baseline was 505/505.

| kind | killed | survived |
|---|---|---|
| safety | 16: S-kill, EX-bare, TR-caught, BI-applied, BI-prefix, HK-octal, HK-bigint, HK-nanjs, HK-nanpy, BI-structoff, BI-pysub, BI-inside, TR-noname, TR-testkey, TR-nowrap, BI-pybom3 | 9: BI-while, BI-elsedo, BI-asichar, BI-pykw, BI-pyeq, BI-pykwapp, BI-insideind, TR-dupname, TR-dupprefix |
| redundant | 0 | 2: TR-lastfn, TR-hookany |
| label | 1: EX-killclr | 2: BI-pybom1, BI-pybom2 |

All 23 new mutants were added to `audit/11/mutants.js`. TR-caught was re-anchored. `--check` reports 223/223 patterns.

## Coverage (`npm run coverage -- --files`, at `1fe6399`)

The run was made at load 3–4 while the harness was running.

**Per target:**

| target | AUDIT-26 / SG37 log | now |
|---|---|---|
| src/validation | 94.21 | 95.28 |
| src/runner | 93.74 | 93.82 |
| src/rl | 98.98 | 98.98 |
| src/orchestrator.js | 94.25 | 94.25 |

- `validation` goes up by about 1 point in runs where no diff-test overruns its budget. PLAN SG26/SG27 records the same 94.2 / 95.27 swing.

**Per file (safety modules):**

| file | AUDIT-26 | now | notes |
|---|---|---|---|
| `agents/executor.js` | 98.70 | 100.00 | |
| `rl/bug-injector.js` | 99.88 | 99.88 | |
| `utils/hunks.js` | 98.81 | **98.22** | `:221-222` newly uncovered (L2); `:81-82`, `:152-153` as before |
| `runner/test-runner.js` | 98.19 | 98.26 | |
| `runner/reverter.js` | 92.86 | 92.86 | |

No other safety file dropped.

---

## High

### H1. Five arms of SG37's structural `;` / `,` rule are unpinned, and each lets an unjudged structure change commit

**Where:** `src/rl/bug-injector.js` `uncoveredToken` → `structural()`.

**What is tested.** The SG37 test (`bug-injector.test.js`, "a `;` or `,` that changes statement or value structure…") pins one example per arm:
- JS `if`, `else`, `for`, and ASI before `(`;
- Python `if` line, newline trailing comma, `return (t,)` and `xs[n,]`.

**What is not tested.** The other members of each arm can be dropped with all 505 tests green. Each such mutant commits an edit that the real code reverts as `tests_insensitive` / `uncovered_token`.

| mutant | weakening | load-bearing edit (`audit/30/unpinned.js`) |
|---|---|---|
| BI-while | `while (...)` heads exempt | `while (n-- > 0) t += 1` → `while (n-- > 0); t += 2`: the loop body is emptied. Tests use n = 1 only, and the kill is on `2`. |
| BI-asichar | only a `(` line counts as ASI-joined; `[`, template, `+`, `-`, `/` do not | `const v = s\n  -n` → `const v = s * 2;\n  -n`: `s - n` becomes `s * 2`. Tests use n = 0, and the kill is on `* 2`. |
| BI-pykw | Python `;` only on `if` / `elif` / `else` lines | `for x in xs: t += x; t = t + 2`: the next statement moves into the loop. Tests use one-element lists. |
| BI-pyeq | statement-level trailing comma before `=` / `;` exempt | `x = xs` → `x, = xs[:1]`: this unpacks. Tests use strings only, where the two forms are equal. |
| BI-pykwapp | paren after `in` / `not` / `and` / … read as a call | `s in (t)` → `s in (t,)`: a substring test becomes an equality test. Tests use s == t. |

**Backstop:** partial. The gate's diff test must say `equivalent`. The repros pass the gate's verdict, as `test/executor.test.js` does.

**Repro:** `node audit/30/unpinned.js BI-while BI-asichar BI-pykw BI-pyeq BI-pykwapp`. Each case prints a line of this form:
```
[BI-while] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":";"}
[BI-while] mutated copy: {"status":"passed","commit":"commit","sites":1,"killed":"numeric_off_by_one",...}
[BI-while] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=99 fail=0
FINDING H1 BI-while: rule is load-bearing (mutated copy commits) and the tests stay green with it
```
The output was the same for BI-asichar, BI-pykw, BI-pyeq and BI-pykwapp. For the full suite, `node audit/11/mutants.js BI-while BI-asichar BI-pykw BI-pyeq BI-pykwapp` reported `FINDING SURVIVED` ×5.

### H2. "A re-indented line is never covered by a sibling site on it" is unpinned

**Where:** same function, indentation arm (`push(false)`). SG37 removed `inside()` for both brackets and indentation.
- The bracket half is pinned: BI-inside is killed.
- The indentation test (`pyInside`) puts the sibling site on another line. So the SG34 rule "a site on the re-indented line covers it" (mutant BI-insideind) survives.

**Example:** `t = t.strip()` moved into `if n > 1:` with `+ '!'` added on the same line. Tests use n = 2 only. The `'!'` kill then stands in for the move.

**Repro:** `node audit/30/unpinned.js BI-insideind`
```
[BI-insideind] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":"        "}
[BI-insideind] mutated copy: {"status":"passed","commit":"commit","sites":2,"killed":"string_literal",...}
[BI-insideind] tests on the mutated copy: ...: pass=99 fail=0
FINDING H2 BI-insideind: rule is load-bearing (mutated copy commits) and the tests stay green with it
```

### H3. SG38 duplicate test names: "every test of that name passed" is unpinned at `1fe6399`

**Where:** `src/runner/test-runner.js` `loadFailed` → `testPassed` (`ids.every`).

**Mutant TR-dupname** (`ids.some`) survives the full suite.

**Example:** two node:test tests are named `x`.
- The first catches the module's load throw on purpose.
- The second hits the throw and fails. A wrapper rethrows the error, so the TAP stack has no load frame.
- The 4 → 5 mutant makes the module throw at load, which is a load failure and never a kill.

The real code reports `collection_errors: 1` and reverts. The mutated copy counts `x#2` as a kill and commits an edit whose value nothing asserts.

**Repro:** `node audit/30/unpinned.js TR-dupname`
```
[TR-dupname] real code:    {"status":"reverted","reason":"tests_insensitive","sites":1,...,"collection_errors":1}
[TR-dupname] mutated copy: {"status":"passed","commit":"commit","killed":"numeric_off_by_one","killed_test":"x#2",...}
[TR-dupname] tests on the mutated copy: test/executor.test.js test/test-runner.test.js: pass=101 fail=0
FINDING H3 TR-dupname: ...
```

**SG39:** the SG39 test (`loadFailed: 10,000 caught-load rows…`) asserts `check(['a'], { a: 'pass', 'a#2': 'fail' }) === true`, which pins this rule. Not re-run at `bd0df2e`.

### H4. Flaky main-suite test: `test-runner.test.js:223` races on the shared `os.tmpdir()`

**Where:** "V8 coverage: a file the tests never load is not exercised; coverage goes to a removed temp dir". The test lists `os.tmpdir()` for `refactor-cov-*` before and after one `runTests` call and requires no new entry.

**Cause:** any concurrent `runTests` in the same tmpdir creates such dirs, including:
- other test files of the same `node --test` run;
- a second checkout's suite;
- the AUDIT-11 harness;
- a real pipeline run.

**Evidence:**
- `audit/30/tmpdir-race.js --reps=5` (quiet host):
  ```
  control 1/5 … 5/5: pass=1 fail=0
  with concurrent runTests-like dirs 1/5 … 5/5: pass=0 fail=1 left: refactor-cov-Ljt9lN left: refactor-cov-zjOhRn …
  control failures 0/5, churned failures 5/5
  FINDING tmpdir-race
  ```
- Two `npm test` suites run concurrently, 2 rounds (load 8–11): the test failed in 2 of 4 runs (`par1a`, `par2b`). The assertion was `+ [ 'refactor-cov-kWJ50I' ] - []`.
- In an earlier `tmpdir-race.js` run, made while the harness was running, the control itself failed 1/4.
- During the harness run, it gave a false kill of TR-hookany. The harness's `FLAKY` regex already lists this test.

The race is not seen in single sequential runs (0/6).

---

## Medium

### M1. TR-dupprefix: a caught-load throw in a failing suite is excused by any passing test whose name it prefixes

**Mutant TR-dupprefix** (`id.startsWith(name)`) survives the full suite.

**Example:** a `describe('s')` body's load throw. Suites have no per-test result, so the real code sees no ids and does not excuse the throw. With the mutant, an unrelated passing test named `set` excuses it, and `collection_error` is lost.

No executor-level commit was built for this case: the suite's children vanish, which changes the test set.

**Repro:** `node audit/30/dupprefix.js`
```
real code:    {"status":"failed","collection_error":true,"tests":{"set":"pass","f":"fail"}}
mutated copy: {"status":"failed","collection_error":null,"tests":{"set":"pass","f":"fail"}}
FINDING M1 TR-dupprefix
```

**SG39:** pinned by `check(['a'], { 'a#x': 'pass' }) === true` and by the exact `#n` index. Not re-run.

### M2. Diff-testing and CLI-signal tests fail under contention (AUDIT-26 M1, carried and widened)

With two concurrent suites at load 8–11, 4 runs out of 4 failed with 1–5 tests each. The failures were:
- `diff-testing.test.js`, with `'equivalent'` expected and `'inconclusive'` actual: tests 164, 170–173, 198, 211, 224, 227, 228;
- H4;
- once, `SIGINT to the CLI mid-test…`, with `waitFor timed out` after 20 s.

All of these fail closed. They do give false mutant kills on a loaded host.

---

## Low

- **L1. Equivalent or fail-closed survivors:**
  - **BI-elsedo.** A `;` inserted right after `do` is parse-invalid unless the body is deleted too, and the deletion rules then apply.
  - **TR-lastfn.** node:test always takes the callback last.
  - **TR-hookany.** `JSON.stringify(undefined)` never parses to a passing name, so this fails closed.
  - **BI-pybom1 / BI-pybom2** (label). Without the BOM strip, the Python shape and parse checks yield fewer or no mutants, so the result is `tests_insensitive` (fail closed).
- **L2. `hunks.js` 98.81 → 98.22% is dead code, not a lost test.**
  - SG37's `if (Number.isNaN(Number(n))) return t;` (Python branch) catches every complex literal. Every `j`-suffixed number is NaN.
  - As a result, `if (!/j$/i.test(n))` is always true, and `:221-222` (`catch` / `return t`) is reached only by a throwing `BigInt` of a malformed JS `…n` token.
  - Behaviour is unchanged: complex literals were already keyed by their text, through the fallthrough.
- **L3. Harness drift.** TR-caught (`' && !passed.has(key) && '`) no longer matched after SG38: `--check` failed 1/200. It is re-anchored on `!(name ? testPassed(name) : passed.has(key))` and killed.
- **L4. Temp-dir litter.** `/tmp` holds about 1,400 `refactor-cov-*` and about 1,300 `refactor-pyc-*` dirs.
  - All but 2 predate this audit. The 2 that do not were left by mutated-copy runs (S-kill) at 05:11.
  - No unmutated run in this audit leaked one.
  - The litter does not affect H4, because H4's test diffs the tmpdir listing.

## SG39 (`bd0df2e`, read, not re-run)

- `loadFailed` now indexes names once (`byName`). TR-dupname, TR-noname and TR-dupprefix no longer match their patterns, so they need re-anchoring. Its new test pins duplicates and exact `#n` (H3, M1).
- `structural()`'s comma scan uses a precomputed enclosing bracket and a 16-character `head`. The BI-pyeq, BI-pykwapp and BI-pysub patterns still match.

## Repro index

| command | checks | result at `1fe6399` |
|---|---|---|
| `node audit/30/unpinned.js [BI-while BI-asichar BI-pykw BI-pyeq BI-pykwapp BI-insideind TR-dupname] [--no-tests]` | H1–H3: the real executor reverts, the mutated copy commits, and the named test files stay green (Python cases need pytest + coverage.py) | FINDING ×7 |
| `node audit/30/dupprefix.js` | M1 | FINDING |
| `node audit/30/tmpdir-race.js [--reps=5]` | H4 | FINDING (control 0/5, churned 5/5) |
| `node audit/11/mutants.js --check` | every pattern matches once | ok, 223 |
| `node audit/11/mutants.js <30 ids above>` | tally above | FINDING (9 safety survivors) |
| `npm test` ×6 sequential | flakiness | 505/505 ×6 |
| two concurrent `node --test test/*.test.js` ×2 | flakiness under contention | 4/4 runs fail (H4, M2) |
