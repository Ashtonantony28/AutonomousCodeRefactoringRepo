# AUDIT-43: Encoding soundness, round 14 (no false negatives)

Audited commit `96a06d0` (PR #5 merged: SG48–SG51). SG48 put the Python load hook first on `PYTHONPATH`. SG49 added the continuation `;` test (`continued`), the block-keyword count (`droppedKeyword`), shifting commas (`shifts`) and the new-slice `:` rule. SG50 wrapped `_LoaderBasics.exec_module`, marked CommonJS compiled by the ES module loader, limited the `R` row to the root runner (`REFACTOR_LOAD_ROOT`) and added the fail-closed `U` row without `module.registerHooks`. SG51 wraps the `sys.excepthook` that an operator sitecustomize sets.
The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed.

Every repro loads `test/helpers/env.js` first (through `audit/39/lib.js` or `audit/5/lib.js`), so state goes to a temp dir. Repros use the stub client and make no API calls. Scripts run from the repo root, print `FINDING` or `ok`, and exit 1 when a finding reproduces.

In every end-to-end scenario the critic is **unanimous**: 3 of 3 approve, `p_preserves` 0.9, no `edge_cases`. `audit/43/run.js` is `audit/39/run.js` on the `audit/43` corpus. For each corpus entry it:
- checks a real `node` / `python3` witness;
- runs the suite on the current version.

Result: 0 `BADWITNESS`, 0 `BADSUITE`. Every committed entry has an `equivalent` diff test with deletions observed.

Environment: Node v22.22.0 (has `module.registerHooks`), Python 3.13.16 (user site enabled), pytest with coverage.py, 4 CPUs, other sessions running.

## Summary

**Prior repros.**

| repro | result | expected |
|---|---|---|
| `node audit/39/run.js` (full) | 0 of 14 committed | holds (SG49, SG50) |
| `node audit/39/token-sites.js` | ok | holds (SG49) |
| `node audit/39/load-probes.js` | ok in 4 of 5 runs; its worker control is racy (C2, L2) | holds (SG50) except that row |
| `node audit/39/control-status.js` | ok | holds (SG50 L1 wording) |
| `node audit/39/c1-semi-continuation.js` | ok | holds (SG49) |
| `node audit/42/py-excepthook.js` | ok | holds (SG51) |
| `node audit/40/py-site-shadow.js` | ok | holds (SG48) |

**Fresh corpus** (`audit/43/corpus.js`): 18 entries, 8 JS and 10 Python. 16 reached the executor and **10 were committed**. Every control stopped.

| category | committed | finding |
|---|---|---|
| del (loop head deleted, no inserted token) | 2/3 | H1 (D03 is vetoed by Python `condition_change`) |
| guard (block guard turned into `c && a; b`) | 1/2 | H2 (G02 is vetoed by Python `condition_change`) |
| fmt (precision added to a format spec) | 2/2 | H3 |
| load (the only kill is a module-load failure) | 5/5 | C1, C2, H4, H5 |
| ctl (D04, G03, F03, W02, R02, U02) | 0/6 | holds |

Unit and runner level:
- `node audit/43/token-sites.js` (`editMutants` only): 8 FINDING rows (H2, H3, M1). The 4 control rows stop, or are judged only on the site the change needs.
- `node audit/43/load-probes.js` (real `runTests` and load hooks): 9 FINDING rows (C1, C2, H4, H5), plus 1 racy C2 row (a kill in about half of the runs). The 4 control rows (3 `ctl` and the R1 `python -m` row) stop.

| severity | count |
|---|---|
| Critical | 2 |
| High | 5 |
| Medium | 1 |
| Low | 2 |

---

## Critical

### C1. An operator `usercustomize` that sets `sys.excepthook` hides a child main module that raises

**Where:** `src/runner/test-runner.js`, `PY_SITE`. The hook's sitecustomize runs the operator's sitecustomize first, then wraps whatever `sys.excepthook` that one set (SG51). But `site` imports `usercustomize` **after** `sitecustomize`, from any `sys.path` entry, whenever the user site is enabled (the default). A `usercustomize` that sets `sys.excepthook` therefore replaces `_main_raised`. A child whose main module raises then logs nothing.

**Rule (CLAUDE.md):** load failures include those "logged by the load hooks every run installs, children that keep the environment included: … a sitecustomize wrapping `__import__` … and logging a main module that raises". The README carves out only "a child that sets its own `sys.excepthook`". Here the child sets nothing: the operator's environment does, exactly as in A42-C1.

```
U01 COMMITTED dt=equivalent(obs=true) killed=string_literal by="tests.test_u01::test_cli"   NFC -> NFKC; witness show('Ａ'): cur 'Ａ'  prop 'A'
    env PYTHONPATH=audit/43/usercustomize   (usercustomize.py: sys.excepthook = hook chaining to sys.__excepthook__)
    test_cli: subprocess.run([sys.executable, 'app/u01.py', 'ab']); assert r.stdout.strip() == 'ab'
U02 (control: no usercustomize) stopped, collection_errors=1
```

In the mutant run, `show` raises `ValueError` in the CLI's `__main__` block. The traceback goes to the operator's hook, no `T` row is written, and the failed `test_cli` counts as a kill. At runner level (`load-probes.js` `U1`), the same child counts as a kill. With the excepthook set from an operator **sitecustomize** instead (SG51) it does not.

**Repro:** `node audit/43/c1-usercustomize-excepthook.js`.

**Expected:** log the main module's failure in a way that a later hook cannot remove. `sys.addaudithook` raises a `sys.excepthook` audit event before any excepthook runs (Python 3.8+), and audit hooks cannot be removed. Logging the `T` row from that event covers `usercustomize`, `.pth` files and a child that sets its own hook (the README limit). Failing that, run `usercustomize` from the hook too, as SG51 does for `sitecustomize`, and wrap the excepthook it leaves.

### C2. A worker thread that catches a load throw and exits 0 excuses it, although the file process fails

**Where:** `JS_LOAD_HOOK`. The `--require` preload runs in every worker thread. In a worker:
- `file` (`NODE_TEST_CONTEXT`) is true, because the worker copies the environment.
- `process.ppid` is the root runner, so the worker's `C` row is not marked spawned.
- `process.on('exit')` fires when the **worker** exits, with the worker's exit code.

A worker that catches the throw and ends normally therefore logs `P <worker key>`, and `loadFailed` excuses its `T` row. The test file process itself exits 1.

**Rule (CLAUDE.md):** a caught throw is excused only "elsewhere in a node:test file process that exits 0". Here the file process exits 1. The README says "Worker threads take the same preload", so this is presented as seen.

```
W01 COMMITTED dt=equivalent(obs=true) killed=string_literal by="show in a worker"   NFC -> NFKC (module calls show('a') at load)
    test: new Worker(`try { out = require(workerData).show('ab') } catch { out = 'error' } parentPort.postMessage(out)`, { eval: true });
          await message + exit; assert.strictEqual(v, 'ab')
W02 (control: the same require caught in the failing test itself) stopped, collection_errors=1
```

At runner level (`load-probes.js` `W1`), `require()`, `import()` of the CJS source and `import()` of an ES module source all count as kills. The ES module case is excused through the worker's own exit handler for the `esm` map. The AUDIT-39 control, a worker that is `terminate()`d after its message, is racy. It stops when `terminate()` wins (exit code 1). It counts as a kill when the worker's event loop empties first and the worker exits 0: 4 of 8 runs in an isolated loop, and 1 of 2 runs of `load-probes.js` here. Under `--experimental-test-isolation=none` the worker case also stops: the root runner is not a file process, so its worker's parent is no runner.

**Repro:** `node audit/43/c2-worker-exit-zero.js`.

**Expected:** only the main thread of a file process may log `P`. Gate both exit handlers on `require('worker_threads').isMainThread`. A worker's rows then stay unexcused unless a test name carries them, like any child a test spawns. Alternatively, key worker rows with a `C … <spawned>` marker.

---

## High

### H1. A loop head deleted outright commits on the diff test alone (the A39-H1 shape without an inserted token)

**Where:** `src/rl/bug-injector.js` `droppedKeyword` skips hunks with no inserted range (`if (!h.ranges.length) continue`). `src/agents/executor.js` exempts deletion hunks from the "hunk has a site" check (`!h.deletion`). A pure deletion therefore needs only `deletions_observed`. The diff test observes the deleted `while ( … )` because the condition is evaluated once on every input. It never builds an input on which the loop runs twice.

**Rule:** SG49 made "a hunk that deletes a block keyword (`while`, `for`, `do`, …) more often than it inserts it" no evidence, "whatever replaces it". CLAUDE.md words it as "the first inserted token" of such a hunk, so a deletion that inserts nothing falls outside the wording. The README accepts that pure deletions stand on `deletions_observed`. This turns a loop into one step, which is the case the SG49 rule was written for.

```
D01 COMMITTED dt=equivalent(runs=73 obs=true) mut(h=1 sites=0 mutants=0 run=0)
    -  while (t.length > 6000) t = t.slice(0, Math.max(6000, t.length - 1000));
    +  t = t.slice(0, Math.max(6000, t.length - 1000));
    witness fit('a'.repeat(9000)).length: cur 6000  prop 8000
D02 COMMITTED  do t = t.slice(1000); while (t.length > 6000);  ->  t = t.slice(1000);   witness cur 6000  prop 8000
D03 (Python one-line while, head deleted) vetoed by condition_change  (holds)
D04 (control: while -> if) stopped, uncovered_token=if
```

No mutant runs at all (`run=0`): the commit stands on the diff test and coverage.

**Repro:** `node audit/43/h1-loop-head-deleted.js`.

**Expected:** apply `droppedKeyword` to deletion hunks too. A hunk that deletes a loop keyword (`while`, `for`, `do`) and keeps the loop body is no evidence (`tests_insensitive`, `uncovered_token`). Otherwise, count a deleted loop head as observed only when a probe runs its body at least twice.

### H2. A block guard turned into `c && a; b` commits on the `&&` kill, and `b` silently leaves the guard

**Where:** `editMutants` / `uncoveredToken`. The inserted `&&` (`and`) is a `swap_logical` site, and its kill covers it. The deleted `if ( ) { }` stand on `deletions_observed`. The changed-bracket rule looks only at **inserted** brackets, so deleting the `{ }` that framed two kept statements needs no kill. SG49 keeps `if` / `elif` out of `droppedKeyword` on purpose ("swaps still stand on their operator's kill").

**Rule:** a guard swap stands on its operator's kill because `if (c) a;` → `c && a;` is the same step. When the block held more than one statement, the swap also moves every later statement out of the guard. The `&&` kill shows only that `c` gates `a`.

```
G01 COMMITTED dt=equivalent(obs=true) killed=swap_logical by="collect"
    -  if (t.length < 6000) { out.push(t); out.push('|'); }
    +  t.length < 6000 && out.push(t); out.push('|');
    witness collect('a'.repeat(7000)): cur ""  prop "|"
G02 (Python one-line `if c: a; b` -> `c and a; b`) vetoed by condition_change (unit row still judged on `and`)
G03 (control: `}` moved left of the second push) stopped, uncovered_token=}
```

The unit rows (`token-sites.js` `H2`) judge the multi-line form (block → `c && a;` plus a dedented `b;`) on `&&` alone. The Python block form stops on its changed indentation.

**Repro:** `node audit/43/h2-guard-to-and.js`.

**Expected:** a deleted bracket (or Python suite) that framed kept code needs the same evidence as a changed one. In a hunk that inserts tokens, a deleted `{` / `}` whose pair held kept statements past the first is `uncovered_token`. The simplest version: the guard-swap exemption applies only when the deleted block held a single statement.

### H3. A precision added to a format spec commits on the string's "x added" kill

**Where:** `utils/hunks.lexView` lexes an f-string's format spec (`:.6000`) and conversion (`!r`) as text-part tokens. `editMutants` gives text parts one `string_literal` site, whose mutant appends `x`. Any test that reads the result kills that mutant, so the precision `6000` is never a numeric site. A plain `'%.6000s'` or `'{:.6000}'.format` string is one literal and is judged the same way.

**Rule (CLAUDE.md):** "a template literal or f-string is its text parts and the tokens of its `${}` / `{}` interpolations". The format spec sits inside the `{}` field. Python's own tokenizer emits the spec as `FSTRING_MIDDLE` text, so this is a gap in the evidence rather than an unenforced rule.

```
F01 COMMITTED dt=equivalent(obs=true) killed=string_literal by="tests.test_f01::test_clip"
    -    return f'<{str(s)}>'
    +    return f'<{str(s):.6000}>'
    witness len(clip('a' * 7000)): cur 7002  prop 6002
F02 COMMITTED  '<%s>' % (str(s),)  ->  '<%.6000s>' % (str(s),)   witness cur 7002  prop 6002
F03 (control: `{str(s)}` -> `{str(s)[:6000]}`, the bound is a number site) stopped, survived
```

The unit rows add `'{}'.format(t)` → `'{:.6000}'.format(t)` and `{t}` → `{t!r}`, all judged on `string_literal`.

**Repro:** `node audit/43/h3-format-spec.js`.

**Expected:** lex an f-string format spec as tokens of its field, so a number in it is a numeric site and `!r` / `!s` / `!a` need cover. For a changed plain string, perturb the changed characters, not the end of the literal. One option is to drop or alter the inserted substring, so that the kill shows that the change matters. Another is to require a `revert_reference`-style kill of the old literal.

### H4. Python `runpy` loads are not logged: a load failure counts as a kill

**Where:** `PY_LOAD_CORE` wraps `builtins.__import__` and `_LoaderBasics.exec_module`. `runpy.run_path` and `runpy.run_module` get the code object from the loader and run it with `exec` in `runpy._run_code`. Neither wrapper sees that path. A module body that raises there logs no `T` row, in the test process or in a child.

**Rule (CLAUDE.md):** "a run where a module failed to load (… a failure raised from a module body …) … is never a kill". The README's "Not seen" list names custom loaders and `vm`, but not `runpy`.

```
R01 COMMITTED dt=equivalent(obs=true) killed=string_literal by="tests.test_r01::test_show"   NFC -> NFKC (show('a') at import)
    test: try: ns = runpy.run_path('app/r01.py') / except Exception: ns = {} / assert 'show' in ns
R02 (control: importlib.import_module, SG50) stopped, collection_errors=1
```

At runner level (`load-probes.js` `R1`), `run_path`, `run_module` and a child that calls `run_module` and catches the throw all count as kills. `python -m app.m` with an uncaught throw is still seen, through the excepthook.

**Repro:** `node audit/43/h4-runpy.js`.

**Expected:** wrap `runpy._run_code` (or `_run_module_code`) in the core hook, logging `T <key> <mod_name or path>` when it raises. Alternatively, log from an audit hook on the `exec` event, recording the code object's file and marking it complete once the run returns.

### H5. A load throw caught by a passing test excuses the sibling test that fails because the module is missing

**Where:** `loadFailed` → `testPassed`. A `T` row carrying a test name is excused when that test passed. A memoised loader is a common test helper: `let m; const load = () => m ??= tryRequire(...)`, or a Python list cache. The first test that calls it catches the throw and passes, and every later test fails on the missing module. The row carries the passing test's name.

**Rule (CLAUDE.md):** a throw "logged inside a node:test test … that passed" (pytest: a test that passed) is "caught on purpose" and is no load failure. The carve-out assumes that the catching test is the only one affected. Here the load failure is what makes the killing test fail.

```
M01 COMMITTED killed=string_literal by="show"
    test('optional: empty input', () => { const m = load(); if (m) assert.strictEqual(m.show(''), ''); })   <- catches, passes
    test('show', () => { assert.strictEqual(load().show('ab'), 'ab'); })                                       <- fails: load() is null
M02 COMMITTED (Python, the same with a module-level cache)  killed by="tests.test_m02::test_show"
W02 (control: the throw caught in the failing test itself) stopped
```

**Repro:** `node audit/43/h5-memoised-load.js`.

**Expected:** in a mutant run, a load failure of the **edited file** is a load failure whoever caught it. The mutant is the only difference between the runs, so the throw comes from the mutant. Keep the per-test excuse for other modules. Suites that test the edited file with `assert.throws(() => require(...))` then fail closed (`tests_insensitive`).

---

## Medium

### M1. A deleted block keyword offset by the same keyword inserted elsewhere in the hunk escapes `droppedKeyword`

`droppedKeyword` counts per hunk: a keyword deleted once and inserted once nets to zero. `while (xs.length > 6000) xs.pop();` → `xs.length > 6000 && xs.pop();` stops on its own (SG49). With a new, unrelated `while (a) a = b;` on the next line of the same hunk, it is judged on `swap_logical:&&` plus the new loop's own sites (`token-sites.js` `M1`). This follows the documented wording ("more often than it inserts it"), so it is Medium. It was not driven end to end: the new loop's sites need their own kills.

**Repro:** `node audit/43/m1-balanced-keyword.js`.

**Expected:** match deletions to insertions per stretch (gap), not per hunk. A keyword deleted in one stretch is not offset by the same keyword inserted in another.

---

## Low

### L1. Docs drift

- README: "Worker threads take the same preload" reads as if workers were fully seen. A worker's exit 0 excuses its throws (C2).
- README "Not seen" names neither `runpy` (H4) nor an operator `usercustomize` / `.pth` excepthook (C1).
- CLAUDE.md: the f-string rule ("tokens of its `{}` interpolations") does not say that a format spec is text (H3).
- CLAUDE.md: the block-keyword rule is worded on "the first inserted token", so pure-deletion hunks (H1) are outside it. The net count (M1) is not called out.
- CLAUDE.md: the per-test excuse for caught throws does not say that a sibling test failing on the same missing module still counts as a kill (H5).

### L2. `audit/39/load-probes.js` is flaky: its worker control races (C2)

In 1 of 5 runs, `node audit/39/load-probes.js` reported one FINDING row. 4 reruns were clean, and the row was not captured. Its terminated-worker control row counts as a kill in 4 of 8 isolated runs, because of the C2 race, so that row is the likely cause. AUDIT-39 recorded it as a stopping control ("a worker's `require` … load failures") from a lucky run. Once C2 is fixed the row is deterministic. Until then, AUDIT-39's L2 claim that a worker's throw "**is** seen" holds only when the worker is killed first.

---

## Holds

- **SG49:**
  - a loop turned into `if` stops (D04);
  - a moved `}` stops (G03);
  - the Python block → `and` form stops on its changed indentation;
  - the `&&` loop step without a balancing keyword stops (`token-sites.js` M1 control);
  - a number added inside an f-string field is a numeric site and survives (F03).
- **Python lexical checks:** the deleted-head `while` (D03) and the one-line guard → `and` (G02) are vetoed by `condition_change` before the executor.
- **SG50/SG51 load hooks:**
  - `importlib.import_module` (R02) is a load failure;
  - a caught throw in the failing test (W02) is a load failure;
  - a CLI child with an uncaught main-module throw (U02) is a load failure;
  - an operator sitecustomize excepthook (SG51) is still a load failure;
  - under `--experimental-test-isolation=none`, a top-level catch, an in-test catch and a worker exit 0 are all load failures.
- **Mutation operators** (`token-sites` scratch run, not kept as rows). The following stop with `uncovered_token`:
  - `??=`, `?.`, spread `...`, `new`, `void`, `async`, labels, `(?=` lookahead;
  - a `for` update comma;
  - Python walrus `:=`, `*` unpacking, `yield`, `global`, `del`, `assert`, ternary `if`.

## Not covered this round

- `REFACTOR_LOAD_ROOT` set by a test that spawns a nested `node --test`: adversarial (a test would have to set the hook's private variable), not driven.
- Python `-I` / `-E` / `-S` children, a child that sets its own excepthook, custom loaders with their own `exec_module`, and `vm.Script` loaders: listed in the README's "Not seen", not re-graded.
- Python operator decorators (`@` stops), `async for` / `async with` swaps, and a keyword deleted and re-inserted in the same stretch were checked at unit level only.
- Pure deletion of a block's braces (`if (c) { a; b; }` → `if (c) a; b;`) is the H2 change with no inserted token. It is a pure deletion hunk like H1 and was not driven end to end.

## Repro index (`audit/43/`)

| script | what it shows |
|---|---|
| `corpus.js` | 8 JS + 10 Python witnessed semantics changes: del, guard, fmt, load, ctl |
| `run.js` | the corpus end to end (`audit/39/run.js` on this corpus). Options: `--only ID,…`, `--json out`. Prints FINDING on any commit |
| `token-sites.js` | H2, H3, M1 at unit level, with controls. Option: finding ids |
| `load-probes.js` | C1, C2, H4, H5 at runner level (`W1`, `M1`, `R1`, `U1` rows), with controls. Option: row ids |
| `repro.js` | runs a finding's steps as child processes, exit 1 on any FINDING |
| `c1-usercustomize-excepthook.js` | load-probes U1 + U01, U02 |
| `c2-worker-exit-zero.js` | load-probes W1 + W01, W02 |
| `h1-loop-head-deleted.js` | D01–D04 |
| `h2-guard-to-and.js` | token-sites H2 + G01–G03 |
| `h3-format-spec.js` | token-sites H3 + F01–F03 |
| `h4-runpy.js` | load-probes R1 + R01, R02 |
| `h5-memoised-load.js` | load-probes M1 + M01, M02 |
| `m1-balanced-keyword.js` | token-sites M1 |
| `usercustomize/usercustomize.py` | operator usercustomize that sets `sys.excepthook` (C1) |
| `sitecustomize/sitecustomize.py` | the same as a sitecustomize (SG51 control) |
| `run-all.sh` | token-sites, load-probes, run, one log each: `bash audit/43/run-all.sh [OUT]` |
