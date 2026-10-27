# AUDIT-36: API, SDK and contract consistency, round 12

Audited commit `62dee97` (after SG41–SG43). The auditor did not write the code under audit.

Scope: the code against CLAUDE.md, README "Known limits" and `src/contracts.js`. Areas:
- TestOutcome statuses and reasons, and the `mutation.*` fields (`killed`, `killed_test`, `killed_line`, `uncovered_token`, `unmutated_ref`, `control_failed`, `collection_errors`).
- The new `suites` key from `tapResults`, and `killed_test` now carrying unescaped TAP names.
- The mutant objects' `env` / `control` fields, and `loadFailed(log, root, tests, suites)` and its callers.
- Whether the random switch values leak.
- Whether untested outcomes stay untested.
- CLI flags and exit codes, and doc drift from SG41–SG43.

Since `c06fb7f` (AUDIT-32), `src/` changed in three files:
- `test-runner.js`: `untap`, `suites`, the process-key fallback, and the `T` row that always carries `key`.
- `bug-injector.js`: random `env` / `control` values, `swappedKeyword`, and the `structural` rewrite (`splits`, the logical-line `;`, grouping keywords, the multi-comma display).
- `executor.js`: the control run uses `m.control`.

SG43 changed tests only.

Repros are in `audit/36/`. They make no API calls and drive `runExecutor` / `editMutants` / `tapResults` / `loadFailed` on temp repos through `audit/28/lib.js` (temp `REFACTOR_STATE_DIR`). Each prints `ok` or `FINDING` and exits 1 when a finding reproduces. Run them from the repo root.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 2 (the SG41 separator rule misses a separator after a kept token followed by inserted code) |
| Medium | 0 new; the AUDIT-18 M1–M8 carried over |
| Low | 3 new, plus A28-L1 (open), A32-L1b (known) and the carried-over Lows |

### What holds

- **AUDIT-32 fixes hold.**
  - `audit/32/caught-load-names.js` a–d: ok. Suites are recorded, `#` / `\` names match, and `killed_test=label`.
  - `audit/32/structural-elif.js` a–d: ok.
  - `audit/32/structural-scope.js` a, M1, L1a: ok. L1b is the known binding-rule conflict (`uncovered="t"`).
- **No switch leak.** `audit/28/switch-leak.js` passes a–h. The random value appears only in the mutant source, which is written over during the run and restored. It is not in `TestOutcome.mutation`, the session, samples, the dashboard, Reflexion input or logs.
  - `withEnv` snapshots and restores the variable.
  - `runTests` copies `process.env` before its first `await`.
  - Mutant and control runs use the same text. The env key set is the same in both, and the values have the same shape (16 lowercase letters, `token()`).
- **Untested outcomes.** `audit/24/untested-outcomes.js` a–d: ok.
  - `collector.UNTESTED_REASONS` still lists all five reasons.
  - `orchestrator.processProposal` returns before sample, reward, synthetic negatives and Reflexion. This code is unchanged since AUDIT-24.
- **Contracts.**
  - `audit/18/contract-sweep.js`: ok.
  - `audit/28/contract-shapes.js` a, M1, M2: ok. `editMutants` keys are `control, env, hunk, line, mutation, site, span, src`, which is within the documented shape.
- **`loadFailed` callers.** The only production caller is `runTests`, which passes `perTest.suites`. The process-key fallback is safe: a `P` row is written only when the file process exits 0, so a failing test is never excused through it. `suites` is internal: `runTests` emits `tests`, never `suites`.
- **Caught loads.** `audit/28/caught-load-same-file.js` a–d and `audit/24/caught-load-failure.js` a–d: ok.
- **CLI.** `audit/15/cli-exit-codes.js` a: ok (exit 2, target untouched). No flag changed since AUDIT-32.

---

## High

### H1. A `,` after a kept operand, followed by inserted code, is exempt punctuation: a JS comma operator that discards the kept value, or a Python tuple that makes a condition always true, is committed

**Affected code.** `bug-injector.uncoveredToken` → `structural`:
- `splits(a)` holds only when the tokens on *both* sides of the comma are kept.
- A non-trailing comma inside a paren returns `false` (`if (!')]}'.includes(q)) return false`).
- At statement level, only a trailing comma is checked.

So in `return a;` → `return a, b;` (JS) or `if (n > 1):` → `if (n > 1, log(n)):` (Python), the inserted comma is exempt. The only sites are the use sites of the inserted `b` / `log(n)`, and their kill carries the comma.

**Contract.** CLAUDE.md: "a `;` or `,` that changes structure is not exempt". This comma changes structure:
- In JS, the comma operator evaluates `a` and returns `b`.
- In Python, the condition becomes a two-element tuple, which is always truthy.

The SG41 list names a comma that splits an operand between two kept tokens, and a trailing comma. This shape, a comma between a kept token and an inserted one, demotes the kept operand the same way, and no rule covers it.

**Effect.** The executor keeps an edit that changes behaviour. A kill shows only that the inserted code is read:
- JS: `pick(1, 2)` returns 2 (it returned 1).
- Python: `size(0)` returns `'big'` (it returned `'small'`).

As with A32-H3, a real diff test should see the divergence and veto, so the full pipeline needs a diff-test miss. Severity is High, not Critical, for that reason. CLAUDE.md names the executor bar as the backstop for what the diff test misses.

**Repro:** `node audit/36/comma-demotes-operand.js` (b–e; a is the control)
```
   a: uncovered=","  b: uncovered=null mutants=use_site:b  c: uncovered=null mutants=use_site:log,use_site:n
   d: status=passed reason=(none) killed=use_site killed_test=label uncovered_token=undefined commit=…
   d: committed src/m.js holds `return a, b;` (pick(1, 2) is now 2, was 1)
   e: status=passed reason=(none) killed=use_site killed_test=tests.test_m::test_size uncovered_token=undefined commit=…
   e: committed app/m.py holds `if (n > 1, log(n)):` (size(0) is now 'big', was 'small')
FINDING  b JS `return a;` -> `return a, b;`: the comma operator that discards `a` is exempt punctuation
FINDING  c Python `if (c):` -> `if (c, log(n)):`: the comma that makes an always-true tuple is exempt punctuation
FINDING  d executor commits a JS edit whose inserted comma operator discards the returned value
FINDING  e executor commits a Python edit whose inserted comma makes an `if` condition always true
```
**Expected.** A comma whose left neighbour is kept is structural unless it is an argument, parameter, element or key separator of an applied call, a display or a declaration list:
- JS: any comma-operator position (statement level, `return`, a grouping paren after `if` / `while` / `for` / `(`).
- Python: statement level, `return`, or a grouping paren after a keyword.

At minimum, CLAUDE.md should state the gap.

### H2. A JS `;` after a kept operand, followed by inserted code, cuts the kept expression short and is committed

**Affected code.** `structural` treats a JS `;` as structural only in two cases:
- the empty body of a head;
- before a continue-into character (`(`, `[`, template, `+`, `-`, `/`).

`const x = a && b;` → `const x = a; log(b) && b;` inserts `;` between kept `a` and inserted `log`, so it is exempt. The kept `&& b` becomes a separate expression statement, and `x` is `a`. `log(b)` runs, so a test that checks its side effect kills the use-site mutant.

**Contract.** Same as H1: "a `;` … that changes structure is not exempt". This `;` ends a kept expression early.

**Effect.** The edit is committed: `both(true, false)` returns `true` (it returned `false`). As in H1, a real diff test should catch this, and the executor is the documented backstop.

**Repro:** `node audit/36/comma-demotes-operand.js` (f)
```
   f: uncovered=null mutants=use_site:log,use_site:b; status=passed reason=(none) killed=use_site killed_test=label commit=…
   f: committed src/m.js holds `const x = a; log(b) && b;` (both(true, false) is now true, was false)
FINDING  f executor commits a JS edit whose inserted `;` cuts a kept expression short
```
**Expected.** A JS `;` whose left neighbour is a kept token that is not already a statement end is structural. More precisely, a `;` that splits one statement of `before` into two. Python has the same shape (`return a and b` → `return a; log(b) and b`), but there the inserted code after `return` is dead, so its mutants survive and the edit fails closed.

---

## Low

### L1. SG41 unescaping lets a test name collide with the duplicate marker `#<n>` (SG41 regression; fails closed or misnames)

**Affected code.** `tapResults` now unescapes `\#`, and `adder` marks a repeated id `id#<n>`. A test literally named `dup#2` beside two tests `dup` gets id `dup#2#2`. `dup#2`, and so `mutation.killed_test`, names the second `dup`.

`loadFailed` indexes every `X#<digits>` id under `X` too. So a failing test literally named `parse#1` makes a caught load throw inside the passing test `parse` a load failure, and the run kills nothing.

Before SG41 the literal name read `dup\#2` / `parse\#1` and collided with neither.

**Effect.** `killed_test` is ambiguous, and a run fails closed (no kill). It is never a wrong kill: the excuse requires every id of the name to pass.

**Repro:** `node audit/36/tap-ids.js` (L1a, L1b; a is the control)
```
   ids=["issue #12","dup","dup#2","dup#2#2"," > inner"] suites={}
   L1b: loadFailed(parse passed)=false  with a failing test literally named "parse#1"=true
FINDING  L1a a test literally named `dup#2` collides with the duplicate marker of `dup` (killed_test ambiguous)
FINDING  L1b a failing test named `parse#1` makes a caught throw in passing `parse` a load failure
```
**Expected.** A duplicate marker no name can contain (for example a control character, which TAP always escapes), or keep a separate duplicate index.

### L2. Test and suite names that contain U+2028 / U+2029 drop out of `tests` / `suites`

**Affected code.** The TAP line regexes in `tapResults` (`# Subtest: (.*)$`, `ok \d+ - (.*?)…$`) use `.`, which does not match JS line terminators. Node's TAP reporter writes these characters raw. As a result:
- such a test is missing from `tests`;
- such a suite is missing from `suites`;
- its children's ids lose the suite name (`" > inner"`).

This predates SG41. It is reported now because SG41 made `tests` / `suites` the name contract for `killed_test` and `loadFailed`.

**Effect.** It fails closed:
- The test can never be a kill.
- A caught throw inside it falls back to the process key, which passes only when the file exits 0.

**Repro:** `node audit/36/tap-ids.js` (L2): `ids with a separator: 0; "inner" id: " > inner"`.

**Expected.** Use `[^]` / the `s` flag, or split TAP lines on `\n` only and match with `[\s\S]`.

### L3. SG41 / SG42 doc drift in in-code contracts and CLAUDE.md

- **(b)** The `editMutants` header (`src/rl/bug-injector.js` ~775) still says the switch variable is "set to '1'" and the control is "the same text with it unset". Since SG42 the value is random, and the control sets the variable to another random value (`control`). The shape line beneath it is updated.
- **(c)** The `tapResults` header (`src/runner/test-runner.js` ~386) still documents `{ tests, load } or null`. It also returns `suites` (only when any), which `runTests` passes to `loadFailed`.
- **(d)** CLAUDE.md says caught-load names are "compared as TAP writes them". The ids are TAP names with `\#` / `\\` unescaped, and only control characters stay as TAP writes them.

**Repro:** `node audit/36/doc-drift.js`: a ok; b, c, d FINDING.

### Known and carried over (still reproducing at `62dee97`)

- **A28-L1 (open).** `src/contracts.js` names no `TestOutcome.mutation` field (`audit/28/contract-shapes.js` L1: `named=[]`).
- **A32-L1b (known).** The repro expectation conflicts with the binding rule: `uncovered="t"` (`audit/32/structural-scope.js` L1b).
- **AUDIT-15 L3.** A filesystem worktree failure exits 1 with a stack trace (`audit/15/cli-exit-codes.js` L3).
- **AUDIT-18 L1–L3, AUDIT-15 L1/L2.** No change in the code paths.
- **AUDIT-18 M1–M8.** No change in the code paths.

---

## Repro index (`audit/36/`)

| script | covers | result at `62dee97` |
|---|---|---|
| `comma-demotes-operand.js` | H1 (JS comma operator, Python tuple condition; editMutants and an executor commit), H2 (JS `;` cuts an expression; executor commit), a control | a ok; b, c, d, e, f FINDING |
| `tap-ids.js` | L1 (duplicate-marker collision, `loadFailed` over-match), L2 (U+2028 / U+2029 names), a control | a ok; L1a, L1b, L2 FINDING |
| `doc-drift.js` | L3 (b) `editMutants` header, (c) `tapResults` header, (d) CLAUDE.md wording; a control (live random values) | a ok; b, c, d FINDING |

Re-run from earlier audits at `62dee97`:
- ok:
  - `audit/32/caught-load-names.js` a–d
  - `audit/32/structural-elif.js` a–d
  - `audit/32/structural-scope.js` a / M1 / L1a
  - `audit/28/switch-leak.js` a–h
  - `audit/24/untested-outcomes.js` a–d
  - `audit/18/contract-sweep.js`
  - `audit/28/contract-shapes.js` a / M1 / M2
  - `audit/28/caught-load-same-file.js` a–d
  - `audit/24/caught-load-failure.js` a–d
  - `audit/15/cli-exit-codes.js` a
- FINDING, known or carried over: `audit/32/structural-scope.js` L1b, `audit/28/contract-shapes.js` L1, `audit/15/cli-exit-codes.js` L3.
