# AUDIT-32: API, SDK and contract consistency, round 11

Audited commit `c06fb7f` (after SG36–SG40). The auditor did not write the code under audit.

Scope: the code against CLAUDE.md, README "Known limits" and `src/contracts.js`. Areas:
- TestOutcome statuses and reasons, and the `mutation.*` fields (`killed`, `killed_test`, `killed_line`, `uncovered_token`, `unmutated_ref`, `control_failed`, `collection_errors`).
- session and `inflight.json` JSON, CLI flags and exit codes.
- Exports used across modules: `test-runner.loadFailed` (newly exported), `bug-injector.editMutants` and its `structural` rule, `hunks.valueKey`.
- Whether the same-text switch or the hoisted binding leaks.
- Whether untested outcomes stay untested.
- Doc drift from SG36–SG40.

Since `c20f64d` (AUDIT-28), `src/` changed in four files:
- `executor.js`: kill fields are cleared when a site survives.
- `bug-injector.js`: the structural `;` / `,` rule and the Python BOM handling.
- `test-runner.js`: the per-test JS load hook and `loadFailed(log, repoRoot, tests)`.
- `hunks.js`: `valueKey` handles NaN.

Repros are in `audit/32/`. They make no API calls and drive `runExecutor` / `runTests` / `editMutants` on temp repos through `audit/28/lib.js` (temp `REFACTOR_STATE_DIR`). Each prints `ok` or `FINDING` and exits 1 when a finding reproduces. Run them from the repo root.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 3 (H1 and H2 are SG38 regressions; H3 comes from SG37) |
| Medium | 1 new (an SG37 regression), plus the carried-over AUDIT-18 M1–M8 |
| Low | 1 new, plus A28-L1 (open) and the carried-over Lows |

### What holds

- **No switch leak.** `node audit/28/switch-leak.js` passes a–h. JS and Python edits, whether kept or reverted: no switch text in the committed blob, the history, the working file, `process.env` or synthetic negatives. A SIGKILL or SIGTERM in the middle of a mutant run restores the pre-edit text.
- **Untested outcomes.** `audit/24/untested-outcomes.js` passes a–d: `control_failed`, `uncovered_token` and `unmutated_ref` end `reverted` / `tests_insensitive`.
  - `collector.isLabeled` excludes all five untested reasons.
  - `orchestrator.processProposal` returns before sample, reward, synthetic negatives and Reflexion (line 229).
  - `calibration.js` skips unlabeled outcomes.
  - An exception inside `mutationEvidence` also ends `tests_insensitive`.
- **Contract sweep.** `audit/18/contract-sweep.js`: ok. Every persisted record satisfies `src/contracts.js`.
- **AUDIT-28 fixes hold.**
  - `audit/28/contract-shapes.js`: a, M1 and M2 ok. `killed_test` / `killed_line` are cleared beside `killed: null`, and a BOM module no longer reads as `mutation_budget`.
  - `audit/28/caught-load-same-file.js` a–d: ok.
  - `audit/24/caught-load-failure.js` a–d: ok.
- **`editMutants` shape.** Keys stay within `{ mutation, src, env, line, hunk, site, span, ref?, revert? }`, and the executor markers are unchanged.
- **`valueKey`.** A NaN number keys by its text in both languages. BigInt and legacy octal are unchanged, and Python `j` falls to text through NaN. No drift from CLAUDE.md. `valueKey` is not exported: it is reached through `changeHunks` / `lexView`.
- **Unchanged since AUDIT-24/28.** No diff in `orchestrator.js`, `collector.js`, `reward.js`, `contracts.js`, `worktree.js`, `reverter.js`, `checkpoint.js`, `src/validation/` or `src/interpretability/`. CLI flags, exit codes (`audit/15/cli-exit-codes.js` a ok), resume, reconcile, `inflight.json` and worktree names are as audited before.

---

## High

### H1. A caught load throw inside a passing `describe()` callback blocks every kill (SG38 regression)

**Affected code**
- `src/runner/test-runner.js` `JS_LOAD_HOOK` logs a throw inside a test *or suite* callback as `T <key> <file> <json fullName>`.
- `loadFailed` excuses a named row only when `tests[fullName] === 'pass'`.
- `tapResults` never records suites (`if (cur.type !== 'suite') add(...)`). A suite's name is therefore never a passed id, and the row counts as a load failure.

A named row also ignores the process key. So the layout that AUDIT-24 H1 / SG33 fixed now fails again when the throw sits in a suite callback: the throw test in its own file, whose process exits 0.

**Contract.** CLAUDE.md: "a throw caught on purpose is none: logged inside a node:test test or suite callback … that passed, elsewhere in a node:test file process that exits 0". README "Known limits" says the same: "while a node:test test or suite callback runs … is ignored when that test passed".

**Effect.** Every failing mutant run is a `collection_error`. No site is killed, and an edit the suite tests ends `reverted` / `tests_insensitive`. It passed at `c20f64d`.

**Repro:** `node audit/32/caught-load-names.js` (b; the same script at `c20f64d` src prints ok for a–d)
```
   b: status=reverted reason=tests_insensitive collection_errors=1 killed_test=-
   e.b: status=failed collection_error=true tests={"s > a":"pass","label":"fail"}
FINDING  b H1: a caught throw inside a passing describe() callback blocks every kill (suites are not in tapResults)
```
**Expected.** Record suite results, or fall back to the process key (`P`) when the name is not a test id.

### H2. Test names containing `#`, `\` or a newline never match: the caught throw blocks every kill (SG38 regression)

**Affected code.** The hook logs `t.fullName` (`issue #12`). `tapResults` keys tests by the TAP line, and node's TAP reporter escapes `#`, `\` and control characters there (`issue \#12`, `x \\ y`, `a\nb`). `byName.get(fullName)` is undefined, so the row is not excused. The same applies under `--experimental-test-isolation=none`.

A side effect on the same contract: `tests` ids and `mutation.killed_test` carry the TAP escapes, not the test's name.

**Contract and effect.** Same contract and effect as H1. Names such as `issue #12` or `handles \\ paths` are common. These layouts passed at `c20f64d`.

**Repro:** `node audit/32/caught-load-names.js` (c, d; a is the control)
```
   c: status=reverted reason=tests_insensitive collection_errors=1 killed_test=-
   e.c: status=failed collection_error=true tests={"issue \\#12":"pass","label":"fail"}
   d: status=reverted reason=tests_insensitive collection_errors=1 killed_test=-
FINDING  c H2: a caught throw inside a passing test named with `#` blocks every kill (TAP id is escaped `\#`)
FINDING  d H2: a caught throw inside a passing nested test named with `\` blocks every kill
```
**Expected.** Unescape TAP names in `tapResults` (`\#` → `#`, `\\` → `\`, `\n` …), or escape `fullName` the same way before the lookup.

### H3. Python `elif (c,):` / `while (c,):`: the comma that makes the condition an always-true tuple is exempt, and the executor commits the edit

**Affected code.** `bug-injector.uncoveredToken` `structural` decides that a paren is a call (`applied`) when the word before it is not in `return|in|not|and|or|is|if|else|yield|await|lambda|del|assert`. `elif` and `while` are missing from that list. So `elif (c,):` and `while (c,):` read as calls, and their trailing comma is exempt punctuation. `if (c,):` is caught.

**Contract.** CLAUDE.md: "a trailing comma at statement level, in a grouping paren or a subscript" is not exempt. README: "a trailing comma that makes a tuple … needs the same". The paren after `elif` / `while` is a grouping paren.

**Effect.** The executor bar, which CLAUDE.md and README name as the only backstop for diff-test blind spots, keeps an edit that makes a branch always taken (or a loop endless). In the repro the hunk also holds `'mid'` → `'mi' + 'd'`. Those sites are killed, the bare comma needs no cover, and the edit is committed.

The Python lexical checks do not fire: nothing is removed from the condition. A real diff test that tries `n <= 1` should see the divergence and veto, so in the full pipeline this needs a diff-test miss. Severity is High, not Critical, for that reason.

**Repro:** `node audit/32/structural-elif.js`
```
   a: if uncovered=","  b: elif uncovered=null  c: while uncovered=null
   d: status=passed reason=(none) killed=string_literal killed_test=tests.test_m::test_size uncovered_token=undefined commit=…
   d: committed app/m.py holds `elif (n > 1,):` (size(0) is now 'mid', was 'small')
FINDING  b `elif (c,):` comma (always-true tuple condition) is exempt punctuation
FINDING  c `while (c,):` comma (always-true tuple condition) is exempt punctuation
FINDING  d executor keeps an edit whose inserted comma makes an `elif` condition always true
```
**Expected.** Add `elif` and `while` to the grouping keywords. Better: classify the paren from the Python AST instead of the preceding word.

---

## Medium

### M1. A new element of a multi-line Python tuple display is always `tests_insensitive` (SG37 regression)

**Affected code.** `structural` treats every comma before `)` in a paren that is not applied as tuple-making. A tuple display such as `ALLOWED = (\n 'a',\n 'b',\n)` is already a tuple, and its trailing comma changes nothing. Adding `'c',` still reports `uncovered_token ','`. A one-line tuple or a multi-line list with the same change is fine.

**Contract.** CLAUDE.md names only a trailing comma "at statement level, in a grouping paren or a subscript". A display paren holding several elements is none of those.

**Effect.** It fails closed: an untested reason, so no sample and no wrong commit. But a common Python edit (extending a constant tuple) can never be kept, though a test kills `'c'`. It was kept before SG37.

**Repro:** `node audit/32/structural-scope.js` (a, M1)
```
   M1: multi-line tuple uncovered=","
   M1 e2e: status=reverted reason=tests_insensitive uncovered_token="," line=4
FINDING  M1 the trailing comma of a multi-line tuple display is "structural" (not a grouping paren, no tuple made)
```

### M2–M9. AUDIT-18 M1–M8 (AUDIT-24 M1–M8), carried over

The code paths are unchanged since `a5df527`.

---

## Low

**L1. The structural `;` rule is wider than documented.** Both parts fail closed.
- **(a)** A JS `;` before a line starting `++` / `--` is treated as "a line ASI would join". These are restricted productions: ASI always ends the statement before them.
- **(b)** A Python `;` on a line starting with the soft keyword `match` or `case` used as a name (`match = s; t = n + 1`) is treated as a compound statement's line. The keyword test is textual.

Repro: `node audit/32/structural-scope.js` (L1a, L1b): `FINDING` ×2.

**A28-L1 (open, known).** `src/contracts.js` still names no `TestOutcome.mutation` field. `audit/28/contract-shapes.js` L1 prints FINDING (`named=[]`), as does `audit/24/docs-and-shapes.js` L3 (its contracts part).

**Carried over, still reproducing at `c06fb7f`:**
- AUDIT-18 L1–L3 (`audit/18/docs-and-shapes.js`: 3 FINDING).
- AUDIT-15 L1/L2 (`audit/15/docs-and-shapes.js`).
- AUDIT-15 L3 (`audit/15/cli-exit-codes.js`: a filesystem worktree failure exits 1 with a stack trace).

---

## Repro index (`audit/32/`)

| script | covers | result at `c06fb7f` |
|---|---|---|
| `caught-load-names.js` | H1 (suite callback), H2 (`#`, `\` names), a control; executor and `runTests` level | a ok; b, c, d FINDING |
| `structural-elif.js` | H3 (`elif` / `while` comma exempt; real commit end to end), `if` control | a ok; b, c, d FINDING |
| `structural-scope.js` | M1 (multi-line tuple), L1a (`;` before `++`), L1b (`match` name), controls | a ok; M1, L1a, L1b FINDING |

Re-run from earlier audits:
- ok: `audit/28/switch-leak.js`, `audit/28/caught-load-same-file.js`, `audit/24/untested-outcomes.js`, `audit/24/caught-load-failure.js`, `audit/18/contract-sweep.js`, and `audit/28/contract-shapes.js` a/M1/M2.
- Carried-over FINDINGs, as listed above: `audit/28/contract-shapes.js` L1, `audit/24/docs-and-shapes.js` L3, `audit/18/docs-and-shapes.js`, `audit/15/docs-and-shapes.js` L1/L2, `audit/15/cli-exit-codes.js` L3.
