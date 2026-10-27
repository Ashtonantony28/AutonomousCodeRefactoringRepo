# AUDIT-35: Encoding soundness, round 12 (no false negatives)

Audited commit `62dee97`, after SG41–SG43: suite and unescaped-name caught-load attribution with a process-key fallback, structural `;` / `,` rules, random switch values in mutant and control runs, and swapped block keywords that need their own evidence.
The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed.

Every repro uses the repo's stub client and a temp `REFACTOR_STATE_DIR` (through `audit/1/lib.js` and `audit/5/lib.js`). None of them call the live API, and none touch `src/`, `test/`, `state/` or `dashboard/`. Scripts run from the repo root, print `FINDING` or `ok`, and exit 1 when a finding reproduces.

In every end-to-end scenario the critic is **unanimous**: 3 of 3 approve, `p_preserves` 0.9, no `edge_cases`.
`audit/35/run.js` is the `audit/31/run.js` harness plus `ownTests`: the entry's own files are the whole suite. For each corpus entry it:
- checks a real `node` / `python3` witness;
- runs the suite on the current version.

Result: 0 `BADWITNESS`, 0 `BADSUITE`. Every committed entry has an `equivalent` diff test.

Environment: Node v22.22.0, pytest with coverage.py, 4 CPUs, other sessions running.

## Summary

**Prior repros.**

| repro | result | expected |
|---|---|---|
| `node audit/31/run.js` (full) | 0 of 17 committed (all `tests_insensitive`) | holds (SG41, SG42) |
| `node audit/27/run.js` (full) | 0 of 41 committed | holds |
| `node audit/23/run.js` (full) | 5 of 41: F01 F02 G01 G03 G04 | holds (accepted A23-M2 / A23-M4) |

**Fresh corpus** (`audit/35/corpus.js`): 12 entries, 7 JS and 5 Python. All 12 reached the executor and **10 were committed**.

| category | committed | finding |
|---|---|---|
| kw (`with` swapped for `if`) | 2/2 | C1 |
| load (the only kill is a module-load failure) | 3/3 | C2 |
| flag (the test sees the switch binding) | 1/1 | H1 |
| sep (structural `,` outside the documented list) | 4/4 | H2 |
| ctl (controls L02, F02) | 0/2 | holds |

`node audit/35/token-sites.js` (unit level, `editMutants` only): 11 FINDING rows and 10 ok rows.

| severity | count |
|---|---|
| Critical | 2 |
| High | 2 |
| Medium | 2 |
| Low | 1 |

---

## Critical

### C1. A `with` (or `switch`, Python `try`) swapped for `if` is covered by the new `if`'s own condition site

**Where:** `src/rl/bug-injector.js`, `BLOCK_KW = /^(?:if|elif|else|while|for|do)$/` and `swappedKeyword`. A keyword counts as swapped only when the deleted keyword is in `BLOCK_KW`. When `with`, `switch` or `try` is replaced by `if`, the `negate_condition` span keeps the new `if`. The kill of `!(cond)` then covers it.

**Rule (CLAUDE.md):** an inserted "`if` / `elif` / `while` that replaced another block keyword, which its own condition site does not cover" is no evidence. `with`, `switch` and `try` are block statements, but the list leaves them out.

```
K01 COMMITTED ... killed=negate_condition@4 by="fit"     JS (sloppy) with (o || {}) t = t.slice(0, maxLen) -> if (o || {}) ...
    witness fit('abc', {maxLen: 1}): cur "a"  prop "abc"
K02 COMMITTED ... killed=negate_condition@6              Python `with _LOCK:` -> `if _LOCK:` (the body no longer holds the lock)
    witness len(tag('a' * 7000)): cur 6000  prop 7000
```

At unit level (`token-sites.js`), `switch (c) { default: … }` → `if (c) { … }` and Python `try: … finally: pass` → `if s:` are both judged only on `negate_condition`. These two were not driven end to end, because their deleted tokens also need the diff test.

The controls stop with `uncovered="if"` / `"while"` / `"in"`: JS `while` → `if` (A31 K01), Python `for` → `while`, and JS `for…of` → `for…in`.

**Repro:** `node audit/35/c1-keyword-with.js` and `node audit/35/token-sites.js` (rows `kw`).

**Expected:** treat any deleted statement keyword as a swap: `with`, `switch`, `try`, and also `case`, `default`, `finally`, `except` and `async`. A simpler rule: the new block keyword is never covered by its own condition site whenever its gap deletes any keyword.

### C2. Module-load failures outside the hooked test process count as kills

**Where:** `src/runner/test-runner.js`, `JS_LOAD_HOOK` / `PY_LOAD_HOOK` / `loadFailed`.

**Rule (CLAUDE.md):** "a run where a module failed to load (… a failure raised from a module body …) … is never a kill". A caught throw is excused only "inside a node:test test or suite callback … that passed" or "elsewhere in a node:test file process that exits 0".

In every entry below, the edited function runs once at module load. Its string mutant (`'NFKC'` + `x`) makes the module body throw. The only test that fails is outside the hooked file process, or out of the hook's sight:

| id | how the load failure reaches a test | why it is not seen |
|---|---|---|
| L01 | A test runs a CLI child (`node bin/cli.js`). The child catches the `require` throw, prints `error: …` and exits 0. The parent test fails on the output. | The child inherits `NODE_TEST_CONTEXT` from the test file process, so the hook's `P` exit listener runs there. The child's unnamed `T` row is "caught" under the child's process key. A child is not a node:test file process. |
| L03 | A pytest test runs `python -c 'import app.l03 …'` in a subprocess and asserts on stdout. | The child has no `refactor_load_hook`, so nothing is logged. (`test_import_smoke` catches the in-process import on purpose and passes, as documented.) |
| L04 | An ESM test does `try { m = await import('../src/l04.mjs') } catch { m = null }`, then `assert.ok(m)`. | The ESM module body is never compiled through `Module._compile`, so it is not logged. The rethrown `AssertionError` has no `ModuleJob.run` frame. |

```
L01 COMMITTED ... killed=string_literal@3 by="cli"                     witness show('Ａ'): cur "Ａ" prop "A"
L03 COMMITTED ... killed=string_literal@4 by="tests.test_l03::test_cli"
L04 COMMITTED ... killed=string_literal@3 by="show"
L02 (control: L01's child crashes uncaught) stopped, tests_insensitive, collection_errors=1
```

On evidence quality: the same mutant called in process would be killed under the README known limit "a perturbation that throws is killed by any test that runs it". These kills come only through a module-load failure, which CLAUDE.md excludes by name.

**Repro:** `node audit/35/c2-load-outside-hook.js`.

**Expected:**
- JS: log `P` only from the process that node:test spawned for the file. For example, the hook clears `NODE_TEST_CONTEXT` from `process.env` for descendants and remembers it locally, or records the parent pid. A child's caught throw then stays unexcused.
- ESM: add a `module.register` load hook, or treat an unlogged ESM import failure as a load failure. Failing that, document ESM sources as a known limit.
- Python: install the import hook from a `sitecustomize.py` in the `PYTHONPATH` directory the run already adds, so children log too. Failing that, document subprocess suites as a known limit.

---

## High

### H1. The Python switch binding is a module attribute, True only in mutant runs

**Where:** `editMutants`. The hoisted line is `_refactor_mutant = __import__('os').environ.get('REFACTOR_MUTANT') == '<v>'`. In Python it is a module global: `True` in both mutant runs and `False` in the control. Any test that inspects module state therefore tells the runs apart, whatever the mutant changes. Examples are `vars(m)`, `dir(m)` or `inspect.getmembers`, or a "no debug flag left on" check.

**Rule:** CLAUDE.md and README say the control removes every channel but the mutated value: "only a test whose verdict depends on the exact random value could still tell them apart". Here the evidence is unrelated to the edit, as with A31-H1 (environment readers, fixed in SG42).

```
F01 COMMITTED ... killed=numeric_off_by_one@3 by="tests.test_f01::test_no_debug_flag_left_on"   cap 6000 -> 7000
    test: assert [k for k, v in vars(m).items() if v is True] == []
F02 (control: F01 without that test) stopped, tests_insensitive
```

JS is not affected in CommonJS or ESM, where the hoisted `var` is module-local. A sloppy script run with `vm.runInContext` would show the binding as a context global, but this was not driven.

**Repro:** `node audit/35/h1-switch-flag.js`.

**Expected:** keep no value in module state that differs between mutant and control runs. For example, bind a value that is the same in all runs (the raw environment string, which already has the same shape in all three) and compare it inside each switch (`_k == 'v'`). A module-state reader then sees the same value in mutant and control runs (`control_failed` or no kill).

### H2. Structural commas outside the documented list commit on a sibling site

**Where:** `uncoveredToken` → `structural` / `splits`. A JS `,` is structural only through `splits(a)`, which needs **kept** code on both sides and a next token that is not a closing bracket. A Python `,` inside `{…}` is never structural.

| id | shape | why exempt | witness |
|---|---|---|---|
| S01 | JS trailing hole `[x]` → `[x + '',,]` | the next token is `]` | `.length` 1 → 2 |
| S03 | JS inner hole beside an inserted sibling `[a, b]` → `[a + '', , b]` | the previous token `''` is inserted | `.length` 2 → 3 |
| S02 | JS operand split beside an inserted sibling `6000 - 1` → `6000 \| 0, - 1` (Python `max(6000 \| 0, - 1, 0)` at unit level too) | the previous token `0` is inserted | 7000 chars: 5999 → 6000 |
| S04 | Python f-string `f"{x}"` → `f"{x + '',}"` | `{` is never a tuple bracket | `'aaa'` → `"('a"` |

Each one is committed on the kill of its sibling (`''` → `'x'`, `0` → `1`).

The documented rule names "a `,` between two kept tokens that is not trailing" and the Python tuple brackets, so these shapes are outside the list. That makes this High rather than Critical. The CLAUDE.md principle is that a `,` that changes structure is not exempt. The controls stop with `uncovered=","`: the same holes and splits between kept tokens, a statement-level `return x,`, a `(lambda a, b: a,)` paren, a `(6000,)` lambda default, `{d[k,]}` and `[(a,), b]`.

**Repro:** `node audit/35/h2-commas.js` and `node audit/35/token-sites.js` (rows `sep`).

**Expected:**
- JS: a `,` whose neighbour is a `,`, `[` or `]` inside an array literal or pattern is structural (an elision).
- The operand-split test should look past inserted tokens to the nearest kept operand on each side, and not stop at the first inserted token.
- Python: a trailing comma inside an f-string replacement field is structural.

---

## Medium

### M1. Carried commits re-verified

`audit/23` F01 F02 G01 G03 G04 (A23-M2 / A23-M4), as accepted. audit/21 T02 T07, audit/20 D09, audit/16 N12 N15 N18 and audit/13 (six) were not re-run.

### M2. Not covered this round

- `async for` / `async with` → `for` / `with`. These are deletion-only hunks that stand on `deletions_observed`; the diff test cannot drive async iterables.
- `worker_threads` that load the module. These run in the same pid, but the hook's `P` listener runs per thread.
- `--experimental-test-isolation=none` combined with child processes.
- JS sloppy scripts run in a `vm` context, which see the hoisted `var` (H1).
- C1 `switch` / `try` end to end.

## Low

### L1. Docs drift

- README "Caught module-load throws are judged per test" describes CommonJS only. It says nothing about ESM source modules, which are never logged (C2 L04), or child processes, which inherit `NODE_TEST_CONTEXT` in JS and are unhooked in Python (C2 L01, L03).
- README "Switch control …": "only a test whose verdict depends on the exact random value could still tell them apart" does not hold for Python module state (H1).
- CLAUDE.md / README "a block keyword swapped for another" gives `while` → `if` and `elif` → `if`. The code's list is `if|elif|else|while|for|do` and omits `with`, `switch` and `try` (C1).
- The CLAUDE.md comma rule "between two kept tokens" does not mention elisions or f-string fields (H2).

## Holds

- `for…of` → `for…in` (`in` uncovered), Python `for` → `while`, and JS `while` → `if`.
- Lambda commas: `(lambda a, b: a,)` and `(lambda a=(6000,): a)` both stop.
- Own-paren comma counting: `[(a,), b]` and `{d[k,]}` stop.
- An uncaught child-process load crash (L02) is a load failure.
- `vars(m)` without a flag test (F02) stops.
- The audit/31 env, kw and sep entries all stop.

## Repro index (`audit/35/`)

| script | what it shows |
|---|---|
| `corpus.js` | 7 JS + 5 Python witnessed semantics changes: kw, sep, load, flag, ctl |
| `run.js` | the corpus end to end (`audit/31/run.js` + `ownTests`). Options: `--only ID,…`, `--json out`. Prints FINDING on any commit |
| `token-sites.js` | C1 and H2 at unit level (`editMutants` sites), with controls |
| `c1-keyword-with.js` | K01, K02 |
| `c2-load-outside-hook.js` | L01, L03, L04 (and the L02 control) |
| `h1-switch-flag.js` | F01 (and the F02 control) |
| `h2-commas.js` | S01–S04 |
