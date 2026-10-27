# AUDIT-38: Test coverage and test quality, round 12 (after SG44–SG45)

Audited commit `c14887e` (SG44 + SG45 merged). The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed. Mutants are applied only to temp copies. No API calls were made. Scripts print `FINDING` or `ok` and exit 1 on a reproduced finding.

Environment: Node v22.22.0, 4 CPUs, pytest + coverage.py installed. Host load 0.6–5.2.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 5 |
| Medium | 1 |
| Low | 2 |

- **Mutation testing.** 48 new mutants of rules added or changed in SG44/SG45 (`audit/11/mutants.js`, block "AUDIT-38"). The full suite kills 31 and 17 survive:
  - 12 safety survivors: BI-reachpair, BI-besideleft, BI-elisionlead, BI-tuplesub, BI-semiinst, BI-semiobj, BI-seminlr, BI-kwblock, TR-esmcrow, TR-esmpfile, TR-cjspfile, TR-dupdotall.
  - For 11 of them a mutated copy turns a safe outcome into an unsafe one (`audit/38/unpinned.js`): the executor commits an edit the real code reverts as `uncovered_token`, or a load failure the real code reports is excused, so a mutant run of a module that cannot load would count as a kill (H1–H5).
  - BI-seminlr has no load-bearing case found (M1).
  - 5 label survivors, all over-rejection guards that fail closed (L1).
- **Pinned well.** `reach()` skipping inserted tokens (BI-reachfresh), the `,`/`;`/closing-bracket/Python-line stops, the JS comma operator (BI-seqs, BI-seqboth), array holes after a comma, Python statement / grouping-paren / f-string tuple commas, the kept-comma and logical-line bounds of `tupleNew` (BI-tuplefresh, BI-tupleline), the JS `;` split and its ASI line-break reading on the left, the Python `;` split, `\t#n` ids and their parsing (TR-dupsep, TR-dupre, TR-dupbase), U+2028/9 TAP lines, the JS raw-value switch binding (BI-jsflag), R / C rows of CJS processes (TR-crow, TR-runnerall, TR-runnerrow, TR-cppid), the ESM completion mark and test attribution, and `python -c` main-module logging.
- **Flakiness.** None. `npm test` passed 526/526 in 7 of 7 runs: 3 sequential (84–87 s) and 2 × 2 concurrent (118–123 s, load up to 5.2). The mutation harness baselines (2 runs) were also 526/526 first time.
- **Coverage.** All targets ≥ the SG44 log. The rl drop 98.99 → 98.76 is 4 new uncovered lines of `bug-injector.js`, all in SG44 `reach` / `semiReach` (L2), the same branches H2 shows are unpinned.

### Mutation tally

Commands: `node audit/11/mutants.js <45 ids>` (04:42–06:28 UTC) and `node audit/11/mutants.js TR-cjspfile TR-runnerall TR-cppid` (06:28–06:31). Baselines 526/526.

| kind | killed | survived |
|---|---|---|
| safety | 22: BI-reachfresh, BI-reachnopair, BI-besideright, BI-seqs, BI-seqboth, BI-elision, BI-tuplestmt, BI-tuplegroup, BI-tuplefield, BI-tuplefresh, BI-tupleline, BI-semistruct, BI-seminll, BI-pysemisplit, BI-jsflag, TR-dupsep, TR-dupre, TR-dupbase, TR-tapok2028, TR-crow, TR-runnerall, TR-pymainname | 12: BI-reachpair, BI-besideleft, BI-elisionlead, BI-tuplesub, BI-semiinst, BI-seminlr, BI-semiobj, BI-kwblock, TR-dupdotall, TR-esmcrow, TR-esmpfile, TR-cjspfile |
| label | 9: BI-reachsep, BI-reachshut, BI-reachpyline, BI-semiasi, TR-tapsub2028, TR-runnerrow, TR-esmmark, TR-esmname, TR-cppid | 5: BI-reachcolon, BI-tuplestmtx, BI-tuplelambda, BI-semicase, TR-pychain |

`node audit/11/mutants.js --check`: `ok: 315 mutants, every pattern matches once`.

## Coverage (`npm run coverage -- --files`)

**Per target** (at `c14887e`, 06:38–06:40, load 2.9–5.2; SG45 column measured at `b8a30a2` the same way):

| target | SG45 log | SG44 log | `b8a30a2` now | `c14887e` now |
|---|---|---|---|---|
| src/validation | 94.21 | 95.28 | 95.28 | 95.28 (3388/3556) |
| src/runner | 94.01 | 94.02 | 94.01 | 94.02 (1587/1688) |
| src/rl | 98.99 | 98.76 | 98.99 (1469/1484) | 98.76 (1514/1533) |
| src/orchestrator.js | 94.25 | 94.25 | 94.25 | 94.25 (377/400) |

**Per file:**

| file | `b8a30a2` | `c14887e` | uncovered at `c14887e` |
|---|---|---|---|
| `rl/bug-injector.js` | 99.89 | 99.46 | 101, **1040, 1052–1054** |
| `runner/test-runner.js` | 98.41 | 98.41 | 107-108 245-247 313-315 369-370 |
| `agents/executor.js` | 100.00 | 100.00 | |
| `utils/hunks.js` | 98.81 | 98.81 | 81-82 152-153 |
| `runner/reverter.js` | 92.86 | 92.86 | |

The rl drop is the only per-file drop: SG44 added 49 counted lines to `bug-injector.js` (1484 → 1533 in rl) and 4 of them are never run (L2). The 94.21 ↔ 95.28 validation swing (AUDIT-34 L3) did not recur: 95.28 in both checkouts.

---

## High

The backstop for H1–H3 is partial: the gate's diff test must say `equivalent` with deletions observed. The repros pass that verdict, as `test/executor.test.js` does, because the executor bar exists for the diff test's blind spots. H4/H5 have no backstop in the gate: they decide whether a failing mutant run is a kill.

All repros: `node audit/38/unpinned.js <id>` (real code, mutated copy, then the test files naming the module on the mutated copy). Full-suite survival: `node audit/11/mutants.js <id>`.

### H1. SG44 separator rule: four arms unpinned (subscript tuple, kept code on the right only, leading hole, inserted pair holding kept code)

**Where:** `uncoveredToken` in `src/rl/bug-injector.js` (`tupleNew`, `beside`, the elision test, `reach`).

**Rule (CLAUDE.md):** a `,` "between two kept tokens" (past inserted tokens) and a Python `,` making a tuple (a subscript among the places) are structural; README/SG44: JS array elision; `reach` stops at "a wholly inserted bracket pair" only.

**What is tested.** The SG44 tests cover the statement-level, grouping-paren and f-string tuple commas, holes after a comma, and kept code on the left of the comma or on both sides. Each of the following mutants survives the full suite, and each mutated copy commits an edit the real code reverts as `uncovered_token ','`:

| mutant | weakening | load-bearing edit |
|---|---|---|
| BI-tuplesub | a subscript comma never makes a new tuple key | Python `return d[n]` → `return d[n, t]` (looks up `(n, t)`); use site of `t` killed |
| BI-besideleft | `beside` looks left only | Python `return (s)` → `return (t, s)` (returns a tuple); use site of `t` killed |
| BI-elisionlead | only holes next to a comma count | JS `return [s];` → `return [, s + ''];` (`s` moves to index 1); `''` and `+` killed |
| BI-reachpair | `reach()` skips any inserted bracket pair, even one holding kept code | JS `s.slice(0, 6000 - 1)` → `s.slice(0, Number(6000), - 1)` (5999 → 6000); the call's use site killed |

**Repro:** `node audit/38/unpinned.js BI-tuplesub BI-besideleft BI-elisionlead BI-reachpair`
```
[BI-tuplesub] real code:    {"status":"reverted","reason":"tests_insensitive",...,"uncovered_token":","}
[BI-tuplesub] mutated copy: {"status":"passed","commit":"commit","sites":1,"killed":"use_site","killed_test":"tests.test_m::test_f"}
[BI-tuplesub] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=112 fail=0
FINDING H1 BI-tuplesub: rule is load-bearing (mutated copy unsafe) and the tests stay green with it
(same pattern for BI-besideleft, BI-elisionlead (killed string_literal), BI-reachpair)
```

### H2. SG44 ASI-aware `semiReach`: the `in` / `instanceof` continuation and the object-literal `}` operand are unpinned

**Where:** `semiReach` in `uncoveredToken`.

**Rule (SG44 header):** across a line break, a statement start ASI separates is no operand, except a line starting `in` / `instanceof`; a block's `}` is no operand, an object literal's is.

| mutant | weakening | load-bearing edit |
|---|---|---|
| BI-semiinst | an `in` / `instanceof` line reads as a new statement | `const ok = k\n    in o;` → `const ok = k; log(k)\n    in o;` (`ok` becomes `k`, not `k in o`); use site of `k` killed |
| BI-semiobj | every `}` before a `;` reads as a block end | `const o = { n: s }.n + 1;` → `const o = { n: s }; log(t).n + 1;` (`o` becomes the object); use site of `t` killed |

Both mutated copies commit; the real code reverts as `uncovered_token ';'`. `bug-injector.js` lines 1052–1054 (the `}` and `case` / label branches) are never run by the suite (L2).

**Repro:** `node audit/38/unpinned.js BI-semiinst BI-semiobj` → `FINDING H2` ×2 (tests on the mutated copy: pass=112 fail=0).

### H3. SG45 keyword swap: only block-statement keywords are pinned

**Where:** `swappedKeyword`, `KEYWORDS[lang].has(...)`.

**Rule (CLAUDE.md):** an `if` / `elif` / `while` "whose stretch deletes another keyword" is not covered by its own condition site; SG45 replaced the list with any keyword.

**What is tested.** The SG45 test uses `with`, `switch`, `try`, `match`, `async for`. BI-kwblock (keyword list = `if|elif|else|while|for|do|with|switch|try|match|async`) survives: a swap of any other keyword (`delete`, `throw`, `return`, `not`, ...) is covered by the new `if`'s condition kill again.

**Load-bearing edit:** `delete o.k;` → `if (n) o.k = 0;` (the key stays; nothing happens for falsy `n`). Real: `uncovered_token "if"`. Mutated copy: committed on `numeric_off_by_one` (`0`), negate_condition and the use of `n`.

**Repro:** `node audit/38/unpinned.js BI-kwblock` → `FINDING H3`.

### H4. SG45 load failures outside the hooked test process: the ES-module `C` row and the file-process check on `P` are unpinned

**Where:** `JS_LOAD_HOOK` in `src/runner/test-runner.js`.

**Rule (CLAUDE.md / SG45):** a load failure in a child that keeps the environment is never a kill; a process whose parent is no runner is a spawned child whose key never passes; only a node:test file process exiting 0 marks `P`.

**What is tested.** The SG45 runTests test covers a CJS child inheriting `NODE_TEST_CONTEXT` (kills TR-crow) and an ES module caught by `import()` in the test process. Not covered: an ES-module child, and a child spawned with `NODE_TEST_CONTEXT` removed (a common pattern; this repo's own tests do it).

| mutant | weakening | case (test spawns a CLI that catches the failed load and exits 0; the test fails on its output) |
|---|---|---|
| TR-esmcrow | the ESM exit handler logs no `C` row | `bin/cli.mjs` catches `await import('../src/m.mjs')` |
| TR-esmpfile | the ESM exit handler logs `P` without the `file` check | same CLI, spawned with `NODE_TEST_CONTEXT` deleted from `env` |
| TR-cjspfile | the CJS exit handler logs `P` without the `file` check | `bin/cli.js` catches `require('../src/m.js')`, spawned with `NODE_TEST_CONTEXT` deleted |

Real code: the failing run is `collection_error: true` (never a kill). Mutated copy: `collection_error: false`, so a mutant that breaks loading counts as a kill.

**Repro:** `node audit/38/unpinned.js TR-esmcrow TR-esmpfile TR-cjspfile`
```
[TR-esmcrow] real code:    {...,"bad":{"status":"failed","collection_error":true,"tests":{"cli":"fail"}}}
[TR-esmcrow] mutated copy: {...,"bad":{"status":"failed","collection_error":false,"tests":{"cli":"fail"}}}
[TR-esmcrow] tests on the mutated copy: test/executor.test.js test/test-runner.test.js: pass=112 fail=0
FINDING H4 TR-esmcrow: ...   (same for TR-esmpfile, TR-cjspfile)
```

### H5. SG44 duplicate-id index: the `s` flag of `/^(.*)\t#\d+$/s` is unpinned

**Where:** `loadFailed`, `byName` indexing.

**Rule:** every test of a logged name must pass; names may hold U+2028 / U+2029 (SG44 kept them in `tapResults`).

TR-dupdotall (no `s` flag) survives. A duplicate whose name holds U+2028 is then not indexed under its base name, so a failing `a b\t#2` is ignored and a caught load throw logged under `a b` is excused by the first, passing one.

**Repro:** `node audit/38/unpinned.js TR-dupdotall` → real `{"load_failed":true}`, mutated `{"load_failed":false}`, tests green, `FINDING H5`. Narrow: needs a duplicated test name with a line/paragraph separator.

## Medium

### M1. BI-seminlr survives: the line-break condition of `semiReach` to the right is unpinned

Mutant: `if (d > 0) return r.nl && /^…/` → `if (d > 0) return /^…/` (a same-line kept name after a `;` reads as a new statement). It survives the full suite. No load-bearing case was found: a kept name right after inserted code on the same line needs an inserted prefix keyword (`void`, `typeof`, `new`, `delete`, `await`), and all but `await` have no mutant, so the token is `uncovered_token` anyway. Reported so the rule gets a pinning test (e.g. `const x = s; await s.v` in an async function).

**Repro:** `node audit/11/mutants.js BI-seminlr` → `FINDING SURVIVED`.

## Low

### L1. Over-rejection guards of SG44/SG45 are unpinned (fail closed)

`BI-reachcolon` (a Python header `:` bounds `reach`), `BI-tuplestmtx` (import / from / global / del / assert / with lines), `BI-tuplelambda` (commas after `lambda`), `BI-semicase` (`case` / `default` / label `:`), `TR-pychain` (the shadowed sitecustomize still runs) all survive. Each only makes the code reject more (or, for TR-pychain, lose a project's own site setup); none lets an edit commit.

**Repro:** `node audit/11/mutants.js BI-reachcolon BI-tuplestmtx BI-tuplelambda BI-semicase TR-pychain` → 5 × `SURVIVED` (no FINDING: label kind).

### L2. rl coverage 98.99 → 98.76: four new `bug-injector.js` lines never run

Lines 1040 (`reach` running off the end of the code), 1052–1054 (`semiReach`: the `}` block-end test and the `case` / `default` / label test). The last two are the branches H2 and L1 show to be unpinned. No other file dropped.

**Repro:** `npm run coverage -- --files | grep bug-injector` → `99.46%  101 1040 1052-1054` (at `b8a30a2`: `99.89%  101`).

## Open issues

- H1–H5 need pinning tests (the cases in `audit/38/unpinned.js` are ready-made); M1 and L1 need tests that state the rule.
- Not checked: Python sitecustomize chaining with a real project sitecustomize (TR-pychain is label-only), `in`/`instanceof` cases in Python (not applicable).
