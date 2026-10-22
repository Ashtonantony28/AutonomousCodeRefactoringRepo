# AUDIT-26: Test coverage and test quality, round 4

Audited commit `4102e99` (after SG27–SG34). The auditor did not write the code under audit. As asked by the coordinator, `origin/claude/completion-plan` (`74dafcf`, SG35) was then merged into this branch. The pattern check and the new mutants were run again on the merged code. Both results are reported below.

Scope:
- coverage of the safety-critical code, with the SG27–SG34 additions first;
- the AUDIT-11 mutation harness, run in full, plus 24 new mutants for SG27–SG34 rules;
- test reliability: `npm test` ×3, `audit/19/load-flaky.js`, and the diff-testing file under contention.

Environment: Node v22.22.0, 4 CPUs. Load from other sessions was 2–7. The host rebooted once mid-run, and the interrupted mutant batches were re-run. Nothing under `src/`, `test/`, `state/` or `dashboard/` was changed. Mutants are applied only to temp copies. No API calls were made. Scripts print `FINDING` or `ok` and exit 1 on a reproduced finding.

## Summary

| severity | count |
|---|---|
| Critical | 1 |
| High | 4 |
| Medium | 3 |
| Low | 4 |

- **Coverage meets the bar.** `npm run coverage`: validation 94.21%, runner 93.74%, rl 98.95%, orchestrator 94.25% lines. These match the SG34 log.
  - `executor.js` is at 98.70%. Its only uncovered lines are `:85-87`, the bare-hunk arm (C1).
  - `bug-injector.js` is at 99.88% and `hunks.js` at 98.81%.
- **Mutation testing (198 mutants at `4102e99`): 14 safety mutants survive.**
  - 3 are the known AUDIT-11 leftovers: T-grace, G-reconcile2 and W-readd.
  - 6 survivors are load-bearing: a mutated copy commits an edit that the real code reverts, and the tests stay green. They are EX-bare, BI-applied, BI-prefix, HK-bigint, HK-octal and S-kill (S-kill only in some runs).
  - 5 are equivalent or not shown to matter: BI-union, BI-revkey, TR-covreset, TR-pyoutside and PH-numboth.
  - All 3 controls are killed.
- **Merged code (`74dafcf` + AUDIT-26).**
  - `--check`: 200/200 patterns match once.
  - The 24 new mutants plus EX-bare, S-kill and BI-revkey give the same verdicts as at `4102e99`, except S-kill, which is killed in that run (H4: its kill is timing-dependent).
  - `audit/26/unpinned.js` reproduces C1 and H1–H3 on the merged code.
- **Reliability:**
  - `npm test` passed 493/493 three times (122 / 129 / 136 s, load 4.7–7.4).
  - `load-flaky.js` reported 0/5 failures.
  - Under contention, the diff-testing tests fail as `inconclusive` and give false mutant kills (M1).

### Mutation tally (`node audit/11/mutants.js`, 198 mutants at `4102e99`)

| kind | killed | survived |
|---|---|---|
| safety | 142 | 14 (EX-bare, BI-applied, BI-prefix, HK-bigint, HK-octal, S-kill, BI-union, BI-revkey, TR-covreset, TR-pyoutside, PH-numboth, T-grace, G-reconcile2, W-readd) |
| redundant | 14 | 6 (X-tokill, HV-relax, TR-load, EX-again, TR-pyexit, BI-pyparse) |
| label | 9 | 2 (T-covto, BI-sitecap) |
| perf | 7 | 1 (TR-sticky) |
| control | 3 | 0 |

How the tally was run:
- The new mutants ran alone.
- The 174 existing mutants ran in two parallel batches.
- Every safety survivor was re-run alone on a quiet host, and all of them survived again.
- TR-pyoutside and TR-sticky were "killed" in the first loaded batch only by unrelated diff-testing tests (M1). Both survive when re-run.

### New mutants (24, added to `audit/11/mutants.js`)

| result | ids |
|---|---|
| killed (safety) | EX-uncov, BI-nameread, HK-holes, HK-atoms, HK-indent, HK-pyfloat, HK-bytes, DT-strs, PH-numonce |
| survived (safety) | BI-applied (H1), BI-prefix (H2), HK-bigint and HK-octal (H3), BI-union, TR-covreset, TR-pyoutside (L1), PH-numboth (M2) |
| killed (redundant / label / perf) | BI-lits, BI-jsparse, TR-fallback, TR-livedirs, S-rmdirs |
| survived (redundant / perf) | BI-pyparse (backed by load hooks), TR-sticky (L3) |

## Coverage of the SG27–SG34 code

Lines are from `npm run coverage -- --files`. Untaken branches are from `node audit/19/branches.js` (Node lcov).

| file | lines | branches | untaken branches in SG27–SG34 code |
|---|---|---|---|
| `agents/executor.js` | 98.70% | 94.29% | `:84` bare hunk (`:85-87` never run; C1); `:123`, `:131` out of budget before the confirmation / switch-off control run |
| `rl/bug-injector.js` | 99.88% | 91.43% | `:926` second mutant of a site (span intersection, L1 BI-union); `:862` `REFACTOR_MUTANT` name already in the file; `:964` quote that starts no `lexView` string; `:808`, `:813`, `:814` operator-match skips |
| `utils/hunks.js` | 98.81% | 93.27% | `:86` lexer progress guard (SG31); `:110` nested `{` inside `${}`; `:70` template escape; `:79-80`, `:150-151` unterminated template / f-string; `:121`, `:142` Python string / f-string edges |
| `runner/test-runner.js` | 98.19% | 90.03% | `:85` `removeLiveDirs` rm failure; `:527` reporters in `NODE_OPTIONS`; `:583`, `:588` empty `NODE_OPTIONS` arms |
| `runner/reverter.js` | 92.86% | 76.47% | none new (`restoreFromDisk` corrupt / unlink arms, as at AUDIT-19) |
| `orchestrator.js` | 94.25% | 88.51% | `:47`, `:51-52` signal-handler error arms |
| `validation/*` | 94.21% | — | none in SG27/SG31 code (`module_nums`, boundary inputs covered) |

---

## Critical

### C1. A hunk with no site is never run through the executor: dropping the bare-hunk rule commits an edit with zero evidence

**Where:** `src/agents/executor.js:83-87`. A hunk that inserts tokens but has no mutant is reverted. `:85-87` is never executed by any test (coverage). SG30's fail-closed token rule now reports most such hunks as `uncovered` before this point. The tests that used to reach the rule stop earlier, so the rule itself is now untested.

**Mutant EX-bare** (`const bare = -1;`) survives the full suite, both alone and on the merged code. Tokens exempt from the fail-closed rule (`;`, `,`, `:`, brackets around inserted code) can make up a whole hunk. Example: an inserted `;` ends a statement that ASI continued (`const v = a\n(b)` calls `a(b)`; with `;`, `v` is `a`). Such an edit has no mutant at all, so `sites` is empty, the loop does nothing, `ok = true`, and the edit is committed.

**Backstop:** partial. The gate's diff test must say `equivalent` with the deletions observed.

**Repro:**
```
$ node audit/26/unpinned.js EX-bare
[EX-bare] real code:    {"status":"reverted","reason":"tests_insensitive","commit":null,"killed":null,"uncovered_token":null}
[EX-bare] mutated copy: {"status":"passed","reason":null,"commit":"commit","sites":0,"killed":null,"uncovered_token":null}
[EX-bare] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=88 fail=0
FINDING C1 EX-bare: rule is load-bearing (mutated copy commits) and the tests stay green with it
$ node audit/11/mutants.js EX-bare
FINDING SURVIVED EX-bare        [safety] a hunk with inserted tokens but no site no longer blocks  (full, 183761 ms)
```

## High

### H1. A moved argument-list bracket is covered only by its own call: nothing pins "own call"

**Where:** `src/rl/bug-injector.js`, `uncoveredToken` → `applied`. A use site covers a changed bracket pair only when its span ends at that pair's close (`x.e === c + 1`). SG34's tests pin the bracket rule as a whole (BI-struct is killed), but not this exception.

**Mutant BI-applied** (`x.e >= c + 1`: any enclosing use site covers it) survives. Example: `g(a) + b` → `h(g(a + b))`. The `)` of `g` moves past `+ b`. The only kill is the new wrapper `h`'s use site, and the edit is committed although no test passes `b ≠ 0`.

**Backstop:** partial (the diff test).

**Repro:** `node audit/26/unpinned.js BI-applied`
```
[BI-applied] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":")"}
[BI-applied] mutated copy: {"status":"passed","reason":null,"commit":"commit","sites":1,"killed":"use_site",...}
[BI-applied] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=88 fail=0
FINDING H1 BI-applied: rule is load-bearing (mutated copy commits) and the tests stay green with it
```

### H2. A dropped-prefix site covers a bracket pair only when it is applied to that pair: untested

**Where:** same function, `applied`. The prefix arm is `x.prefix && x.e <= o && !src.slice(x.e, o).trim()`.

**Mutant BI-prefix** (`x.prefix`: a `!` / `~` / `not` anywhere before the pair covers it) survives. Example: `g(a) + b` → `~g(a + b)`. The `~` site is killed and stands for `g`'s moved `)`.

**Backstop:** partial (the diff test).

**Repro:** `node audit/26/unpinned.js BI-prefix`
```
[BI-prefix] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":")"}
[BI-prefix] mutated copy: {"status":"passed",...,"commit":"commit","sites":1,"killed":"drop_unary",...}
FINDING H2 BI-prefix: rule is load-bearing (mutated copy commits) and the tests stay green with it
```

### H3. BigInt and legacy-octal respelling rules in `valueKey` are untested

**Where:** `src/utils/hunks.js` `valueKey`. Since SG34, a literal respelled to the same value is no change. The hex / float / bytes cases are tested (`bug-injector.test.js:491`; HK-pyfloat and HK-bytes are killed). The BigInt branch and the `0\d` legacy-octal guard are not tested.

Mutants:
- **HK-bigint** (drop the BigInt branch) survives. Every BigInt then keys as `NaN`, so `1000n` → `2000n` is no change.
- **HK-octal** (drop the `0\d` guard) survives. `10` → `010` (8, sloppy mode) is then no change.

In both cases the changed number gets no site, and the hunk stands on a sibling's kill.

**Backstop:** partial (the diff test). The octal case is limited to sloppy-mode files.

**Repro:** `node audit/26/unpinned.js HK-bigint HK-octal`
```
[HK-bigint] real code:    {"status":"reverted","reason":"tests_insensitive","commit":null,"sites":2,...}
[HK-bigint] mutated copy: {"status":"passed",...,"commit":"commit","sites":1,"killed":"numeric_off_by_one",...}
FINDING H3 HK-bigint: rule is load-bearing (mutated copy commits) and the tests stay green with it
[HK-octal] real code:    {"status":"reverted","reason":"tests_insensitive","commit":null,"sites":2,...}
[HK-octal] mutated copy: {"status":"passed",...,"commit":"commit","sites":1,"killed":"numeric_off_by_one",...}
FINDING H3 HK-octal: rule is load-bearing (mutated copy commits) and the tests stay green with it
```

### H4. "The signal handler kills the in-flight test group" is pinned only by a race

**Where:** `src/orchestrator.js:46` (`killActive()` in `handleSignal`).
- The unit test `executor.test.js:160` calls `handleSignal` with a live run but never checks that the run's group died; `await run` simply waits for it.
- The CLI test (`:193`, `waitFor(procs === 0, 3000)`) notices the surviving group only sometimes.

**Mutant S-kill** (no `killActive()`) results:
- survived the full suite in a parallel batch and again alone;
- was killed in the merged-code run;
- the CLI signal tests on the mutated copy were green in 2 of 3 runs.

With the mutant, the test command keeps running and writing into the worktree after the edit was reverted and the process exited.

**Backstop:** none in `src/` (no exit hook kills the group).

**Repro:**
```
$ node audit/26/signal-kill.js
real code:    {"late_write":false}
mutated copy: {"late_write":true}
CLI signal tests on the mutated copy, run 1/3: pass=2 fail=0
CLI signal tests on the mutated copy, run 2/3: pass=1 fail=1
CLI signal tests on the mutated copy, run 3/3: pass=2 fail=0
FINDING H4 S-kill: the test group keeps running after the signal handler, and the CLI signal tests stay green in 2/3 runs
```

## Medium

### M1. Diff-testing tests fail `inconclusive` under contention and give false mutant kills

Three full-suite copies running in parallel (host load 14) failed every harness baseline with 4–9 tests out of 493. Most were in `diff-testing.test.js`: the sandbox escape test, Math.random seeding, module-state, deletion-probe and AUDIT-9/12/14 budget tests.

`audit/26/load-verdicts.js --pattern . --busy 12 --reps 3` (diff-testing.test.js) gave 3 failures. All of them were `expected: 'equivalent' | actual: 'inconclusive'`, which fails closed, so none can hide a safety regression. They do give false kills: TR-pyoutside and TR-sticky were "killed" by `this.constructor.constructor escape…` and `each call gets a fresh copy of the inputs`, and both survive when re-run. The harness's `FLAKY` list covers only the executor timing tests.

The AUDIT-23 escape test passed in 5/5 runs alone under busy 8.

### M2. PH-numboth survives: the "numeric on both sides" intersection is untested

`py_diff_harness.py:1340` takes `module_nums(cur) & module_nums(prop)`. Mutant PH-numboth (`|`) survives. Hints only shape the inputs, and no load-bearing example was found (not shown to commit). PH-numonce (bound once) is killed.

### M3. Untaken SG27–SG34 branches (see the coverage table)

- executor `:123` / `:131`: out of budget before the confirmation run or the switch-off control;
- hunks `:86` lexer progress guard and `:110` nested braces in `${}`;
- bug-injector `:862`: the switch-variable name already present in the file;
- test-runner `:527`: reporters set through `NODE_OPTIONS`.

All of these fail closed or are defensive, but none is pinned.

## Low

- **L1. Equivalent or effectively equivalent safety survivors:**
  - **BI-union.** Span union instead of intersection. `bug-injector.js:926`'s second-mutant arm is never taken: no operator yields two mutants for one site. `node audit/26/static-diff.js BI-union` shows 0 of 270 corpus edits differ (BI-applied and BI-prefix are also 0 of 270, which is why they needed the hand-made H1/H2 cases).
  - **BI-revkey.** A revert of a pure name swap restores text that parsed before, so it is never lost while its use site is kept. The executor's `siteKey` still separates the two.
  - **TR-covreset.** The re-run repeats the same pre-step, so the coverage reset is redundant.
  - **TR-pyoutside.** An empty-key throw is caught in a hook. The module then throws again under a test key, which is never excused.
- **L2. Carried from AUDIT-11/19, unchanged:** T-grace, G-reconcile2, W-readd. All survive alone.
- **L3. Label / perf / redundant survivors:**
  - T-covto and BI-sitecap (as at AUDIT-19);
  - TR-sticky: a reporter conflict is re-detected on every run, which only doubles that run's start-up;
  - redundant: X-tokill, HV-relax, TR-load, EX-again, TR-pyexit, BI-pyparse (backed by the load hooks / per-test intersection).
- **L4. Harness timing.** A full sequential harness run now takes about 6 h (198 mutants, about 110 s per killed mutant and 180–230 s per survivor). The parallel batches cannot be trusted without re-running survivors and kills by unrelated tests alone (M1).

## Repro index

| command | checks | at `4102e99` | merged (`74dafcf` + AUDIT-26) |
|---|---|---|---|
| `node audit/26/unpinned.js [EX-bare] [BI-applied] [BI-prefix] [HK-bigint] [HK-octal]` | C1, H1–H3: real executor reverts, mutated copy commits, executor and bug-injector tests green | FINDING ×5 | FINDING ×5 |
| `node audit/26/signal-kill.js [--reps=3]` | H4: group left running after the handler; CLI signal tests green in some runs | — | FINDING (2/3 green) |
| `node audit/26/static-diff.js BI-union\|BI-applied\|BI-prefix` | L1: does the mutant change any corpus verdict | ok (0/270 each) | ok (BI-union) |
| `node audit/26/load-verdicts.js [--pattern re] [--busy n] [--reps n]` | M1: what load failures report | ok (3/3 fail closed) | — |
| `node audit/11/mutants.js --check` | every pattern matches once | ok, 198 | ok, 200 |
| `node audit/11/mutants.js <new ids> EX-bare S-kill BI-revkey` | tally above | FINDING (S-kill survives) | FINDING (10 safety; S-kill killed) |
| `node audit/19/load-flaky.js` | SG20 budget pair under busy 8 | ok (0/5) | — |
