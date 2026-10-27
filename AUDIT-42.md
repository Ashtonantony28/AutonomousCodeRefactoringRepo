# AUDIT-42: Test coverage and test quality, round 13 (after SG48–SG50)

Audited commit `401278b` (SG48, SG49 and SG50 merged). The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed. Mutants are applied only to temp copies. No API calls were made: the repros load `test/helpers/env.js` and run children without `ANTHROPIC_API_KEY`. Scripts print `FINDING` or `ok` and exit 1 on a reproduced finding.

Environment: Node v22.22.0, 4 CPUs, pytest + coverage.py installed. Host load 0.1–5.1.

## Summary

| severity | count |
|---|---|
| Critical | 1 |
| High | 4 |
| Medium | 1 |
| Low | 3 |

- **Real-code finding (C1).** SG48 runs the operator's `sitecustomize` after the hook's. If that sitecustomize sets `sys.excepthook`, it replaces the hook's main-module logger. A Python child whose main module raises while loading then logs nothing, its failure counts as a kill, and the edit commits (`audit/42/py-excepthook.js`).
- **Mutation testing.** 27 new mutants cover the rules SG48–SG50 added or changed (`audit/11/mutants.js`, block "AUDIT-42"). The 10 existing SG49/SG50 mutants (plus TR-pychain) were re-run as well. Of the 37:
  - 24 killed.
  - 9 safety survivors: BI-contcall, BI-contin, BI-contq, BI-contop, BI-kwdropjs, BI-kwdroppy, BI-sliceapplied, TR-pyexecname, TR-upfile.
  - 4 label survivors.
  - For 8 of the 9 safety survivors, a mutated copy turns a safe outcome into an unsafe one (`audit/42/unpinned.js`). Either the executor commits an edit the real code reverts as `uncovered_token`, or a load failure the real code reports is excused (H1–H4).
  - TR-upfile has no load-bearing case: the root runner's exit status backs it up (M1).
- **Pinned well.**
  - SG48: PYTHONPATH order (TR-pypathorder, TR-pypathkeep), chaining to the operator sitecustomize (TR-pychain, an AUDIT-38 L1 survivor, is now killed), `maxRetries: 0` and the 300 s timeout (CC-retries, CC-timeout).
  - SG49:
    - the `continued` test as a whole (BI-semicont) and its `.` and `+`/`-` arms (BI-contdot);
    - the `while` arm of `droppedKeyword` (BI-kwdrop) and its count (BI-kwdroptwice);
    - `shifts` in JS and Python, for both `(` and `[` (BI-shifts, BI-shiftsarr, BI-shiftspy);
    - the new-slice `:` on a name (BI-slicecolon).
  - SG50:
    - `exec_module` wrapped (TR-pyexec), the CJS-through-`import()` mark (TR-cjsesm) and the `node:test` wrapper module (TR-esmtest, TR-esmtestsrc, TR-esmtestall);
    - `REFACTOR_LOAD_ROOT` set, checked and deleted (TR-rootany, TR-rootkeep, TR-rootunset);
    - the `U` row (TR-oldnode, TR-ulog).
- **Flakiness.** `npm test` passed 538/538 in 7 of 7 runs: 3 sequential (99–101 s, load 2.1–2.5) and 2 × 2 concurrent (134–135 s, load up to 5.1). The mutation harness baselines (2) were 538/538 first time. One false kill was seen under mutation load (L2).
- **Coverage.** runner and rl are at or above the SG47 log. orchestrator is unchanged. validation is 94.21, against 95.28 in the SG47 log: the AUDIT-34 L3 swing came back (L3). bug-injector.js is 99.90 (line 101 only), so every SG49 line is run. The SG48 and SG50 log entries record no coverage.

### Mutation tally

Commands: `node audit/11/mutants.js <37 ids>` (10:20–11:29 UTC) and `node audit/11/mutants.js BI-contq` (re-check). Baselines 538/538.

| kind | killed | survived |
|---|---|---|
| safety | 17: BI-semicont, BI-kwdrop, BI-shifts, BI-slicecolon, TR-rootany, TR-cjsesm, TR-esmtest, TR-oldnode, TR-pyexec, TR-pypathorder, TR-pypathkeep, BI-contdot, BI-kwdroptwice, BI-shiftsarr, BI-shiftspy, TR-rootkeep, TR-ulog | 9: BI-contcall, BI-contin, BI-contq, BI-contop, BI-kwdropjs, BI-kwdroppy, BI-sliceapplied, TR-pyexecname, TR-upfile |
| label | 5: TR-pychain, BI-shiftsfresh, TR-esmtestsrc, TR-esmtestall, TR-rootunset | 4: BI-contpp, BI-kwdropnet, BI-slicekept, TR-cjsreq |
| perf | 2: CC-retries, CC-timeout | 0 |

BI-contq was first reported killed, but only by `infinite promise chain is bounded by the per-call timeout` (a timing-bound test). The re-check run on the full suite let it survive (L2).

`node audit/11/mutants.js --check`: `ok: 354 mutants, every pattern matches once` (327 + 27).

## Coverage (`npm run coverage -- --files`, at `401278b`, after the flakiness runs)

| target | SG47 log | `401278b` now |
|---|---|---|
| src/validation | 95.28 | 94.21 (3350/3556) |
| src/runner | 94.03 | 94.11 (1614/1715) |
| src/rl | 99.03 | 99.05 (1571/1586) |
| src/orchestrator.js | 94.25 | 94.25 (377/400) |

| file | now | uncovered |
|---|---|---|
| `rl/bug-injector.js` | 99.90 | 101 |
| `runner/test-runner.js` | 98.47 | 107-108 245-247 313-315 369-370 |
| `utils/claude-client.js` | 81.91 | 7-8 28-29 32-33 45-47 79-82 98-99 103-104 (no SG48 line: 35 runs) |
| `agents/executor.js` | 100.00 | |

All of the SG49 `bug-injector.js` lines (`droppedKeyword`, `continued`, `shifts`, the slice `:`) and the SG50 `test-runner.js` lines are run. Several are run without being pinned (H1–H4).

---

## Critical

### C1. An operator `sitecustomize` that sets `sys.excepthook` disables main-module load logging, and the edit commits

**Where:** `PY_SITE` in `src/runner/test-runner.js`. It installs `_main_raised` as `sys.excepthook` first, then (SG48) runs the next sitecustomize on PYTHONPATH.

**Rule:** CLAUDE.md says a run where a module failed to load is never a kill, "children that keep the environment included: … a sitecustomize … logging a main module that raises". README says the hook "then runs the next sitecustomize on the path, e.g. the operator's".

The operator's sitecustomize runs last, so an error reporter there that sets `sys.excepthook` replaces the hook's. A child `python app/m.py` whose module body raises then logs no `T` row. Its test fails in both mutant runs and passes in the control, so the failure is a kill. The README limit "a child that sets its own `sys.excepthook`" names the child's code, not the operator's site setup that SG48 explicitly chains to.

**Case** (real code, executor, gate diff test `equivalent` as in `test/executor.test.js`): `app/m.py` changes `normalize('NFC', s)` to `normalize('NFKC', s)`, with a module-level `show('')`.
- `test_import_smoke` catches the in-process import error. It passes, so its throw is excused.
- `test_cli` runs `python app/m.py ab`.
- The string mutant `'NFKCx'` raises at load, so the only kill is the child's main-module load failure.

**Repro:** `node audit/42/py-excepthook.js`
```
a no operator sitecustomize:     {"status":"reverted","reason":"tests_insensitive",...,"collection_errors":1}
b operator sitecustomize hooks:  {"status":"passed","commit":"commit","sites":1,"killed":"string_literal","killed_test":"tests.test_m::test_cli",...}
FINDING b: an operator sitecustomize that sets sys.excepthook replaces the load hook's; the child main-module load failure kills and the edit commits
```
An operator hook that chains to the previous `sys.excepthook` (not `sys.__excepthook__`) is safe; the script's first draft showed that. Fix direction: install the excepthook after the chained sitecustomize has run, wrapping whatever it set. Another option is a `sys.excepthook`-independent record, such as an `atexit` / `threading.excepthook` check of the main module's completion.

## High

The backstop for H1–H3 is partial: the gate's diff test must say `equivalent` with deletions observed. The repros pass that verdict, as `test/executor.test.js` does, because the executor bar exists for the diff test's blind spots. H4 has no gate backstop: it decides whether a failing mutant run is a kill.

All repros: `node audit/42/unpinned.js <id>` (real code, mutated copy, then the test files naming the module on the mutated copy). Full-suite survival: `node audit/11/mutants.js <id>`.

### H1. SG49 `continued`: only the `.` and `+`/`-` arms are pinned

**Where:** `continued` in `uncoveredToken` (`src/rl/bug-injector.js`). It is the regex `[.,?:*%<>=&|^/([`]|\+(?!\+)|-(?!-)|!=|in|instanceof`.

**Rule (CLAUDE.md / SG49):** a JS `;` "before code the expression would continue into (`(`, `[`, template, `+`, `-`, `/`, same line or next)" is structural. A line end left of a `;` ends a statement only when the kept code right of it cannot continue the line.

The SG49 test uses `+ Math.max(…)` and `.trim()` only. Each mutant below survives the full suite. Each mutated copy commits an edit the real code reverts as `uncovered_token ';'`:

| mutant | weakening | load-bearing edit (use site killed) |
|---|---|---|
| BI-contcall | `(` `[` template are no continuation | `const v = g\n (x);` → `const v = g\n ; log(x)(x);` (v becomes the function) |
| BI-contin | `in` / `instanceof` are no continuation | `const ok = k\n in o;` → `const ok = k\n ; log(k) in o;` |
| BI-contq | `?` / `:` are no continuation | `const v = c\n ? s : t;` → `const v = c\n ; log(s) ? s : t;` |
| BI-contop | `* % < > = & \| ^ /` are no continuation | `const v = n\n * 2;` → `const v = n\n ; log(n) * 2;` |

**Repro:** `node audit/42/unpinned.js BI-contcall BI-contin BI-contq BI-contop`
```
[BI-contcall] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":";"}
[BI-contcall] mutated copy: {"status":"passed","commit":"commit","sites":2,"killed":"use_site","killed_test":"f",...}
[BI-contcall] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=115 fail=0
FINDING H1 BI-contcall: rule is load-bearing (mutated copy unsafe) and the tests stay green with it
(same for BI-contin, BI-contq, BI-contop)
```

### H2. SG49 `droppedKeyword`: only `while` is pinned, in both languages

**Where:** `BLOCK_KW` / `droppedKeyword`.

**Rule (SG49):** a hunk that deletes a block keyword (JS `do else for switch try catch finally while with`, Python `else for while with try except finally match`) more often than it inserts it is `uncovered_token`.

The SG49 test drops `while` only (JS `&&` / `?:`, Python). BI-kwdropjs and BI-kwdroppy reduce each set to `while` and both survive:

| mutant | load-bearing edit |
|---|---|
| BI-kwdropjs | `for (; xs.length > 9;) xs.pop();` → `xs.length > 9 && xs.pop();` (one pop, not a loop). `&&` → `||` is killed |
| BI-kwdroppy | `for _ in range(len(xs) - 9): xs.pop()` → `len(xs) > 9 and xs.pop()`. `and` → `or` is killed |

Real code: `uncovered_token` (`&&` / `>`). Mutated copies: committed on `swap_logical`. `try`/`except` cases were not used as repros because the Critic's error-handling check vetoes them before the executor.

**Repro:** `node audit/42/unpinned.js BI-kwdropjs BI-kwdroppy` → `FINDING H2` ×2 (tests on the mutated copy: pass=115 fail=0).

### H3. SG49 slice `:`: only a subscript of a name is pinned

**Where:** `structural`, `text === ':'` (`pyApplied(o)`).

**Rule (CLAUDE.md):** a Python `:` that "makes a slice of a kept subscript with no kept `:`" is structural.

The SG49 test uses `s[n]` only. BI-sliceapplied (only a `[` after a word character counts) survives. Then `s.split()[n]` → `s.split()[n:n + 1]` (a list, not an item) commits on `numeric_off_by_one` / `n` / `+`. Real code: `uncovered_token ':'`.

**Repro:** `node audit/42/unpinned.js BI-sliceapplied` → `FINDING H3` (pass=115 fail=0).

### H4. SG50 `exec_module` wrapper: the logged path is unpinned

**Where:** `_exec_hook` in `PY_LOAD_CORE` (it logs `getattr(module, '__file__', None) or <name>.py`).

**Rule:** a load failure in a source module is never a kill. Test files and `conftest.py` are excluded by path.

TR-pyexecname logs the module name instead of `__file__`, and it survives. A test that loads `app/m.py` with `spec_from_file_location('test_helper', …)` and catches the throw then logs `test_helper.py`, a test-file path, so the failure is excused. Real: `collection_error: true`. Mutated: `collection_error: false`, so a mutant that breaks loading counts as a kill. The case is narrow (it needs a test-like module name), but nothing checks which path the SG50 row carries.

**Repro:** `node audit/42/unpinned.js TR-pyexecname`
```
[TR-pyexecname] real code:    {...,"bad":{"status":"failed","collection_error":true,"tests":{"tests.test_a::test_a":"fail"}}}
[TR-pyexecname] mutated copy: {...,"bad":{"status":"failed","collection_error":false,"tests":{"tests.test_a::test_a":"fail"}}}
[TR-pyexecname] tests on the mutated copy: test/executor.test.js test/test-runner.test.js: pass=120 fail=0
FINDING H4 TR-pyexecname: rule is load-bearing (mutated copy unsafe) and the tests stay green with it
```

## Medium

### M1. TR-upfile survives: the file-process check on `P` in the `U` branch is unpinned

Mutant: in the async-loader / no-`registerHooks` branch, `P` is logged on exit 0 for every process, not only node:test file processes. It survives the full suite.

No load-bearing case was found. The case tried: on a simulated old Node, an env-stripped ESM CLI child catches a failed `import()` and exits 0. The mutated copy also reports `collection_error: true`. The reason is that the root `node --test` (and `npm`) process logs its own `U` row and exits non-zero whenever a test fails, so a failing run is a load failure anyway. The rule is backed up by the root process's exit status only. A runner that exits 0 with failing tests would expose it. Reported so the rule gets a test.

**Repro:** `node audit/11/mutants.js TR-upfile` → `FINDING SURVIVED`. `node audit/42/unpinned.js TR-upfile` → `ok TR-upfile: the mutated copy is also safe`.

## Low

### L1. Over-rejection guards of SG49/SG50 are unpinned (fail closed)

BI-contpp (a `++`/`--` line reads as a continuation), BI-kwdropnet (re-inserted keywords not netted out), BI-slicekept (a step `:` added to a kept slice is structural) and TR-cjsreq (CommonJS loaded by `require` also takes the completion mark and the wrapper) all survive. Each only makes the code reject more, or is behaviour-neutral (TR-cjsreq). None lets an edit commit.

**Repro:** `node audit/11/mutants.js BI-contpp BI-kwdropnet BI-slicekept TR-cjsreq` → 4 × `SURVIVED` (label kind, no FINDING).

### L2. A timing-bound test gives a false kill under mutation load

In the 37-mutant run, BI-contq was killed only by `infinite promise chain is bounded by the per-call timeout` (`test/diff-testing.test.js`). The mutant cannot affect that test, and the full-suite re-check let BI-contq survive. That test name is not in `FLAKY` in `audit/11/mutants.js`, so the harness does not re-check such a kill by itself. The test did not fail in the 7 `npm test` runs (load up to 5.1).

### L3. src/validation coverage 95.28 → 94.21 (the AUDIT-34 L3 swing came back)

That is 3350/3556 against 3388/3556 in the SG47 log, with no `src/validation` change since. AUDIT-38 had seen 95.28 in both checkouts. AUDIT-34 L3 put this swing down to worker-thread coverage collection in the diff-test workers (`diff-testing.js` 316–325, 336–339 among the lines it moves), not to lost tests. The figure is not reproducible from run to run, so it cannot gate.

**Repro:** `npm run coverage -- --files | tail -5`.

## Open issues

- C1 needs a fix in `PY_SITE` and a test with a non-chaining operator excepthook. `audit/42/py-excepthook.js` is ready-made.
- H1–H4 need pinning tests; the cases in `audit/42/unpinned.js` are ready-made. M1 and L1 need tests that state the rule.
- Add `infinite promise chain is bounded by the per-call timeout` to the `FLAKY` re-check list of `audit/11/mutants.js` (L2). Not changed here.
- Not checked: a real Node without `module.registerHooks` (simulated by deleting it, as SG50's test does); Python sitecustomize chaining for an operator file that itself imports the code under test.
