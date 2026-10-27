# AUDIT-39: Encoding soundness, round 13 (no false negatives)

Audited commit `e641183` (PR #4 merged: SG44–SG47). SG44 added separator rules (`reach()`, `semiReach`, `seqs`, array elisions, Python tuple-creating commas). SG45 added the "any deleted keyword" swap rule and load hooks for children, ES modules and Python subprocesses. SG46 added the `U` row beside async loaders and bounded scans. SG47 added pinning tests.
The auditor did not write the code under audit. Nothing under `src/` or `test/` was changed.

Every repro loads `test/helpers/env.js` first (through `audit/39/lib.js` or `audit/5/lib.js`), so state goes to a temp dir. Repros use the stub client and make no API calls. Scripts run from the repo root, print `FINDING` or `ok`, and exit 1 when a finding reproduces.

In every end-to-end scenario the critic is **unanimous**: 3 of 3 approve, `p_preserves` 0.9, no `edge_cases`. `audit/39/run.js` is `audit/35/run.js` plus a per-entry `env`. For each corpus entry it:
- checks a real `node` / `python3` witness;
- runs the suite on the current version.

Result: 0 `BADWITNESS`, 0 `BADSUITE`. Every committed entry has an `equivalent` diff test (deletions observed where the edit deletes).

Environment: Node v22.22.0 (has `module.registerHooks`), Python 3.13.16, pytest with coverage.py, 4 CPUs, other sessions running.

## Summary

**Prior repros.**

| repro | result | expected |
|---|---|---|
| `node audit/35/run.js` (full) | 0 of 12 committed | holds (SG44, SG45) |
| `node audit/38/unpinned.js` | 11/11 ok (every mutant killed) | holds (SG47) |
| `node audit/36/comma-demotes-operand.js` | a–f ok | holds (SG44) |
| `node audit/37/async-loader.js` | ok | holds (SG46) |
| `node audit/31/run.js` (full) | 0 of 17 committed | holds |
| `node audit/11/mutants.js BI-seminlr` | killed | holds (SG47) |

**Fresh corpus** (`audit/39/corpus.js`): 14 entries, 12 JS and 2 Python. All 14 reached the executor and **9 were committed**. Every control stopped.

| category | committed | finding |
|---|---|---|
| semi (`;` at the start of a continuation line) | 1/1 | C1 |
| kw (loop turned into one `?:` / `&&` step) | 2/2 | H1 |
| sep (`,` inserted before kept arguments / elements) | 2/2 | H2 |
| load (the only kill is a module-load failure) | 4/4 | H3, H4, H5, H6 |
| ctl (C02, K03, S03, P02, E02) | 0/5 | holds |

Unit and runner level:
- `node audit/39/token-sites.js` (`editMutants` only): 14 FINDING rows and 8 control rows that stop.
- `node audit/39/load-probes.js` (real `runTests` and load hooks): 11 FINDING rows and 8 rows that stop.

| severity | count |
|---|---|
| Critical | 1 |
| High | 6 |
| Medium | 1 |
| Low | 2 |

---

## Critical

### C1. A JS `;` at the start of a continuation line cuts the kept operand and is exempt

**Where:** `src/rl/bug-injector.js`, `uncoveredToken` → `structural` → `semiReach(a, -1)`:

```js
if (r.nl && /[\w$)\]}'"`]/.test(c)) return null;
```

Looking left across a line break, a kept token that ends the previous line (a name, `)`, `]`, `}` or a quote) is taken as a statement end that ASI already made, so it is "no operand". That holds only when the line after it cannot continue the expression. Here it can: the kept code after the inserted statement starts with `+` / `.`, and in the original it continued the line above. The only other `;` test looks at the code right after the `;` (`[([`/]`, `+`, `-`). That code is inserted, so the test never sees the kept `+`.

**Rule (CLAUDE.md):** a `;` "with kept code of its own level on both sides, past inserted tokens (it splits an operand or a statement: … `a && b` → `a; log(b) && b`)" is not exempt.

```
C01 COMMITTED passed dt=equivalent(runs=71) mut(h=1 sites=1 mutants=1 run=3 killed=use_site@6 by="size")
    -    + Math.max(0, t.length - 6000);
    +    ; r = r + Math.max(0, t.length - 6000);
    witness size('a'.repeat(7000)): cur 7000  prop -1
C02 (control: the same `;` at the end of the line above) stopped, uncovered_token=;
```

`const n = Math.min(t.length, 6000)\n    + Math.max(…)` becomes `const n = Math.min(t.length, 6000)\n    ; r = r + Math.max(…)`. `n` loses its second operand, and the `+ Math.max(…)` moves into the inserted statement. The only evidence is the kill of the inserted read `r`.

At unit level, the same holds with a name ending the line above (`a\n + b` → `a\n ; out.push(a) + b`) and with a `]` before a `.trim()` member line. The controls stop with `uncovered=";"`: the `;` at the end of the upper line, before a `.member` line, and on the same line (`a + b` → `a; !c + c`).

**Repro:** `node audit/39/c1-semi-continuation.js` (also `token-sites.js` rows `C1`).

**Expected:** a line break on the left is a statement end only when the kept code on the right (`semiReach(a, 1)`'s token) cannot continue it. That means it does not start with a binary or assignment operator, `.`, `?.`, `(`, `[`, a template, `,`, `?` or `:`, `in` or `instanceof`. The simplest rule is to apply the existing continuation test to the first **kept** token right of the `;`, not to the first token after it. Failing that, treat a `;` whose kept left and right tokens were in one statement in `before` as structural.

---

## High

### H1. A JS loop turned into one conditional step commits on the new operator's own site

**Where:** `editMutants` → `swappedKeyword`, applied only to `negate_condition` (an inserted `if` / `while` / `elif`). When a stretch deletes `while` / `for` and inserts a `?` (`negate_ternary`) or `&&` / `||` (`swap_logical`), that operator's own kill covers it.

**Rule (CLAUDE.md / SG45):** a guard keyword "whose stretch deletes another keyword … which its own condition site does not cover" is no evidence. The README gives the reason: "the condition's kill shows only that the condition matters". A `?:` or `&&` that replaces a loop is the same swap without the keyword, so the case falls outside the documented list.

```
K01 COMMITTED dt=equivalent(obs=true) killed=use_site by="fit"     while (t.length > 6000) t = t.slice(1000);  ->  t.length > 6000 ? t = t.slice(1000) : t = t;
    witness fit('a'.repeat(9000)).length: cur 6000  prop 8000
K02 COMMITTED dt=equivalent(obs=true) killed=swap_logical by="trim"  while (xs.length > 6000) xs.pop();  ->  xs.length > 6000 && xs.pop();
    witness trim(Array(7000)).length: cur 6000  prop 6999
K03 (control: while -> if) stopped, uncovered_token=if
```

The deleted `while ( )` stands on the diff test (`equivalent`, deletions observed), which never builds inputs past 5,000 elements. At unit level, `for (; xs.length > 6000;) xs.pop();` → `xs.length <= 6000 || xs.pop();` is judged the same way. A Python `while` turned into a ternary stops, because a Python ternary has no mutant.

**Repro:** `node audit/39/h1-loop-step.js` (unit: `token-sites.js` rows `H1`).

**Expected:** extend `swappedKeyword` to every site whose token is inserted in a stretch that deletes a keyword, so `negate_ternary` and `swap_logical` are included as well as `negate_condition`. Equivalently, a deleted loop keyword (`while`, `for`, `do`) needs its own evidence whatever replaces it.

### H2. A `,` inserted before kept arguments or elements shifts them and commits on the sibling's kill

**Where:** `uncoveredToken` → `structural`. A JS `,` is structural only as an elision, a comma operator (`seqs`) or a split with kept code on **both** sides (`splits`). A Python `,` is structural only when it splits or makes a tuple (`tupleNew`). A comma inserted right after an opening bracket, with only inserted code to its left, matches none of these.

In that position the comma moves every kept argument or element one place: `slice(e)` → `slice(0, e)` makes the start the end, and `[a, b]` → `[a, '', b]` moves `b` to index 2.

**Rule:** the principle is that "a `;` or `,` that changes structure is not exempt". The list names splits, comma operators, elisions and tuples, so this shape is outside the list. That makes it High rather than Critical, as A35-H2 was.

```
S01 COMMITTED dt=equivalent killed=numeric_off_by_one by="tail"   t.slice(t.length - 6000) -> t.slice(0, t.length - 6000)    witness cur 6000  prop 1000
S02 COMMITTED dt=equivalent killed=string_literal by="parts"      [t.slice(0, 6000), t.slice(6000)] -> [t.slice(0, 6000), '', t.slice(6000)]    witness [1].length cur 1000  prop 0
S03 (control: split between kept tokens) stopped, uncovered_token=,
```

The following unit rows are judged only on the inserted sibling:
- `['x', a, b]`;
- `new Array(0, n)`;
- the pattern `const [h, a] = xs`;
- Python `t.replace('x', a, b)` and `['x', a, b]`.

The rule is also inconsistent. Python `return a, b` → `return 'x', a, b` stops (`reach` finds the kept `return`), but the same insertion inside `[…]` or a call does not.

**Repro:** `node audit/39/h2-leading-comma.js` (unit: `token-sites.js` rows `H2`).

**Expected:** an inserted `,` with kept code of its level on its right, past inserted tokens, is structural inside a call, `new`, array literal or pattern, or a Python call, list or set. Additions after the last kept element (kept code on the left only) stay exempt.

### H3. Python module loads through `importlib` are not logged: a load failure counts as a kill

**Where:** `src/runner/test-runner.js`, `PY_LOAD_CORE` wraps only `builtins.__import__`. Three APIs run a module body without calling `__import__`, so a body that raises there logs no `T` row:
- `importlib.import_module`;
- `importlib.reload`;
- `importlib.util.spec_from_file_location` + `exec_module`.

This applies in the test process and in a child interpreter.

**Rule (CLAUDE.md):** "a run where a module failed to load (… a failure raised from a module body …) … is never a kill". The `__import__` wrapper is the mechanism, not the scope of the rule.

```
P01 COMMITTED dt=equivalent killed=string_literal by="tests.test_p01::test_show"   NFC -> NFKC; witness show('Ａ'): cur 'Ａ'  prop 'A'
    test: try: m = importlib.import_module('app.p01') / except Exception: m = None / assert m is not None
P02 (control: the same with an `import` statement) stopped, collection_errors=1
```

The string mutant (`'NFKC'` + `x`) makes `show('a')`, which runs at import, raise `ValueError`. The test catches the failed import and fails on `m is None`. Nothing is logged, so the run counts as a kill.

At runner level (`load-probes.js` rows `H3`), `reload`, `exec_module` and a child doing `importlib.import_module` all count as kills. The `import` statement control is a collection error.

`audit/35` L03's own `show('')` never raised, because CPython returns an empty string before it checks the form. Its L03 kill was a plain call, not a load failure.

**Repro:** `node audit/39/h3-py-importlib.js`.

**Expected:** log at the loader, not at `__import__`. For example, wrap `importlib._bootstrap_external._LoaderBasics.exec_module` (and `SourceFileLoader`'s) in the sitecustomize, logging `T <key> <origin>` when it raises. Failing that, add a `sys.meta_path` finder that wraps each spec's loader.

### H4. `import()` of a CommonJS source is not seen once `module.registerHooks` is in use

**Where:** `JS_LOAD_HOOK`. With the SG45 `registerHooks` load hook installed, Node 22.22 loads a CommonJS module imported from the ESM loader through `translators` `loadCJSModule`. This applies to `import()` from an ES module test and from a CJS test. That path compiles the module without `Module.prototype._compile`, so the `_compile` wrapper never sees the throw. The `registerHooks` hook appends its completion mark only for `format === 'module'`.

```
caught Error: bad | at Object.<anonymous> (src/m.cjs:1:32) | at loadCJSModule (node:internal/modules/esm/translators:166:3) | ... | at ModuleJob.run
LOG: R <pid>                      <- no C / T row
(same suite, registerHooks deleted: ... at M._compile (hook.js) ...  LOG: R, C, T src/m.cjs)
```

This is a regression from SG45: before the `registerHooks` hook, the same import went through `_compile` and was logged.

**Rule:** as in H3. SG45/README: "An ES module that loads but does not complete is logged too". CommonJS sources are assumed seen through `_compile`.

```
E01 COMMITTED dt=equivalent killed=string_literal by="show"   CJS src/e01.js, ESM test: try { m = await import('../src/e01.js') } catch { m = null }; assert.ok(m)
E02 (control: the same with an ES module source) stopped, collection_errors=1
```

At runner level (`load-probes.js` rows `H4`):
- `.cjs` and `.js` sources from an ESM test, and `import()` from a CJS test, all count as kills.
- An ESM CLI child catching the same import is still a load failure, but only by chance: its `process.exit(0)` in the catch leaves the CLI's own ES module incomplete.

**Repro:** `node audit/39/h4-esm-imports-cjs.js`.

**Expected:** in the `registerHooks` load hook, track `commonjs` (and `commonjs-typescript`) results with a source the same way as ES modules, by appending the completion mark. Alternatively, return `source: null` for `commonjs` so that node falls back to `Module._load` / `_compile`. A pinning test should use an ESM test that imports a CJS source and catches the throw.

### H5. A nested `node --test` that a test spawns is treated as a runner: its caught load failure is excused

**Where:** `JS_LOAD_HOOK` logs `R <pid>` for any process with `--test` in `execArgv`. `loadFailed` treats a `C` row as spawned only when its parent is no runner.

A test can spawn `node --test sub/inner.js` itself. Node runs no files when `NODE_TEST_CONTEXT` is set, so such tests strip it, as this repo's own tests do. That nested runner logs `R`. Its file process then logs `C <key> <nested runner pid>`, which is not marked spawned, and `P` on exit 0. Its `T` row carries the inner test's name. No outer test has that name, so the row falls back to the passed key.

**Rule (CLAUDE.md):** a caught throw is excused "elsewhere in a node:test file process that exits 0 (not a child it spawns, though that inherits `NODE_TEST_CONTEXT`)", and "children that keep the environment" are included. The nested file process is a descendant of the test, and the outer test fails only because the module did not load.

```
N01 COMMITTED dt=equivalent killed=string_literal by="nested"
    test: spawnSync(node, ['--test', 'sub/inner.js'], { env: without NODE_TEST_CONTEXT }); assert.match(stdout, /OUT=ab/)
    sub/inner.js: test('inner', () => { try { out = require('../src/n01').show('ab') } catch { out = 'error' } console.log('OUT=' + out) })
```

At runner level, the nested file's top-level catch is excused the same way. A plain CLI child under the same environment (the SG45/SG47 case) stays a load failure.

**Repro:** `node audit/39/h5-nested-runner.js`.

**Expected:** only the root runner may log `R`. For example, `runTests` sets a one-shot variable such as `REFACTOR_ROOT=<nonce>`. The hook logs `R` only when that variable is present and deletes it from `process.env`, so no descendant inherits it. Any other `--test` process is then a spawned child.

### H6. On Node without `module.registerHooks`, ES module load failures count as kills (confirmed)

**Where:** `JS_LOAD_HOOK`: `if (loader) { … U … } else if (M.registerHooks) { … }`. There is no `else` branch. Without `registerHooks` (Node < 22.15 / 23.5), ES module loads are not tracked and no `U` row is logged, so the run does not fail closed. `package.json` allows `"node": ">=18"`.

**Rule:**
- CLAUDE.md lists the ES module load hook among the load-failure sources and carves out only async-loader processes ("counts as a load failure unless …").
- README "Not seen" lists "ES modules on a Node without `module.registerHooks`". The limit is documented there, but CLAUDE.md says such a run is never a kill.
- SG46's acceptance asked that where ES module loads "can no longer be observed the run fails closed".

```
O01 COMMITTED dt=equivalent killed=string_literal by="show"   (NODE_OPTIONS=--require=audit/39/old-node.js deletes module.registerHooks)
    ESM src/o01.mjs, ESM test: try { m = await import(...) } catch { m = null }; assert.ok(m)
```

Simulated: `audit/39/old-node.js` is a user preload that runs before the hook and deletes `registerHooks`. No older node binary was available. In `load-probes.js` rows `H6`, `import()` from an ESM test and from a CJS test both count as kills. A CJS source is still seen through `_compile`.

**Repro:** `node audit/39/h6-no-registerhooks.js`.

**Expected:** an `else` branch that logs `U <key>`, as in the async-loader branch. A file process that exits 0 still passes, so suites still run. Alternatively, raise `engines` to a node with `registerHooks` and refuse to run below it.

---

## Medium

### M1. An exempt `:` turns a Python subscript into a slice

`s[k]` → `s[k:k + 1]` is judged only on `k`, `+` and `1` (`token-sites.js` row `M1`). The inserted `:` changes an index (an element, `IndexError` out of range) into a slice (a list, `''` out of range). Colons are exempt by CLAUDE.md, so this is a documented exemption, not an unenforced rule.

It was not driven end to end. The diff test sees most index/slice differences (ints past the length, lists), so the window is the diff test's blind spots.

**Repro:** `node audit/39/token-sites.js` (row `M1`).

**Expected:** a `:` inserted directly inside a subscript that held no `:` is structural.

---

## Low

### L1. The documented "suite then passes with the switch off" is not enforced

**Where:** `mutationEvidence`: the kill needs the killing test to pass in the control run (`failedTests`). `control.status` is read only when no test is left (`control_failed`).

**Rule (CLAUDE.md):** "A kill must reproduce: the same test fails a second mutant run and the suite then passes with the switch off."

In `audit/39/control-status.js`, one test fails whenever a `REFACTOR_MUTANT*` variable is set, so every control run fails. The edit `n * 2` → `2 * n` is still committed (`killed=use_site by="twice"`). The kill itself is genuine, because mutant and control differ only in the switch value, so this is drift in the documentation, not a false negative.

**Repro:** `node audit/39/control-status.js` → `FINDING L1`.

**Expected:** reword CLAUDE.md ("the killing test passes with the switch off"), or require `control.status === 'passed'`.

### L2. Docs drift

- README "Not seen" lists worker threads, but a worker's `require` throw **is** seen: the `--require` preload runs in workers (`load-probes.js` control row).
- README / CLAUDE.md do not mention `importlib` loads (H3), CommonJS loaded through `import()` (H4) or nested `node --test` runs (H5).
- CLAUDE.md does not carve out a node without `registerHooks` (H6), and `engines` says `>=18`.
- CLAUDE.md's guard-keyword rule names `if` / `elif` / `while` only. The same swap through `?:` / `&&` (H1) is not addressed.

---

## Holds

- **BI-seminlr:** SG47's test kills it (`node audit/11/mutants.js BI-seminlr`). `audit/39/seminlr.js` adds two more load-bearing cases, `let x = a + b;` → `let x = a; ++b;` and `const x = t * s.v;` → `const x = t; await s.v;`. The real code stops on both (`uncovered ';'`) and the BI-seminlr copy judges them on `swap_arith` / `drop_await`.
- **SG44 separators:**
  - a `;` at the end of the line before a kept `+` / `.member` line stops;
  - the split between kept tokens stops (S03, C02);
  - a leading hole stops;
  - a Python statement-level leading tuple insertion stops.
- **SG45 keyword swap:** `while` → `if` stops (K03), and a Python loop turned into a ternary stops.
- **Load hooks:**
  - an ES module source caught in `import()` (E02) is a load failure;
  - a syntax-detected ES `.js` source is a load failure;
  - a worker's `require` and a plain CLI child with `NODE_TEST_CONTEXT` stripped are load failures;
  - a Python `import` statement (P02) is a load failure;
  - with `registerHooks` deleted, a CJS source is seen through `_compile`.
- **Same-text switch / control:** no new channel found. Mutant and control runs bind the same names and types (`audit/35` F01/F02 still stop), and per-test kills need an identical test set.

## Not covered this round

- Python `__import__` hook versus `ImportError` raised by a module body: documented as a missing optional module and excluded by design.
- Custom loaders that run source through `vm.runInThisContext` (no `Module._compile`, no ES module load) are not seen. They are not a module load in Node's sense, so this is not graded.
- Node 18 / 20 binaries: H6 was simulated by deleting `registerHooks`.
- An async loader process (`U` row) under a nested runner. It is likely excused as in H5 (same `R` logic), but this was not driven.

## Repro index (`audit/39/`)

| script | what it shows |
|---|---|
| `lib.js` | helpers: `loadProbe` (good / bad `runTests` pair through the real hooks), `sites` (`editMutants` verdict), `report` |
| `corpus.js` | 12 JS + 2 Python witnessed semantics changes: semi, kw, sep, load, ctl |
| `run.js` | the corpus end to end (`audit/35/run.js` + per-entry `env`). Options: `--only ID,…`, `--json out`. Prints FINDING on any commit |
| `token-sites.js` | C1, H1, H2, M1 at unit level, with controls |
| `load-probes.js` | H3–H6 at runner level, with controls. Option: finding ids, e.g. `H3 H4` |
| `seminlr.js` | BI-seminlr load-bearing cases (real code stops, mutated copy judges) |
| `control-status.js` | L1 |
| `c1-semi-continuation.js` | C01, C02 + token-sites |
| `h1-loop-step.js` | K01, K02, K03 |
| `h2-leading-comma.js` | S01, S02, S03 |
| `h3-py-importlib.js` | load-probes H3 + P01, P02 |
| `h4-esm-imports-cjs.js` | load-probes H4 + E01, E02 |
| `h5-nested-runner.js` | load-probes H5 + N01 |
| `h6-no-registerhooks.js` | load-probes H6 + O01 |
| `old-node.js` | preload that deletes `module.registerHooks` (H6) |
| `run-all.sh` | every repro, one log each: `bash audit/39/run-all.sh [OUT]` |
