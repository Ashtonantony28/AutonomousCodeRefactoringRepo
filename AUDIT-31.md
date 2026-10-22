# AUDIT-31: Validation soundness, round 11 (no false negatives)

Audited commit `c06fb7f`, after SG36–SG40: numbers that cannot be parsed now fail closed, a moved bracket or re-indented line needs its own coverage, a structural `;` / `,` needs its own coverage, caught module-load throws are attributed per test, `loadFailed` runs in linear time, and Python files with a BOM get mutants.
The auditor did not write the code under audit.

Every repro uses the repo's stub client and a temp `REFACTOR_STATE_DIR` (through `audit/1/lib.js` and `audit/5/lib.js`). None of them call the live API, and none touch `src/`, `test/`, `state/` or `dashboard/`. Scripts run from the repo root, print `FINDING` or `ok`, and exit 1 when a finding reproduces.

In every end-to-end scenario the critic is **unanimous**: 3 of 3 approve, `p_preserves` 0.9, no `edge_cases`.
`audit/31/run.js` (the `audit/27/run.js` harness with an optional `noRequire`) does two checks on each corpus entry:
- It checks a real `node` / `python3` witness.
- It runs the suite on the current version.

Result: 0 `BADWITNESS`, 0 `BADSUITE`. Every committed entry has an `equivalent` diff test.

## Summary

**Prior repros.**

| repro | result | expected |
|---|---|---|
| `node audit/27/run.js` (full) | 0 of 41 committed | holds (SG37) |
| `node audit/27/token-sites.js` | ok (17 rows) | holds |
| `node audit/23/run.js` (full) | 5 of 41: F01 F02 G01 G03 G04 | holds (accepted A23-M2 / A23-M4) |

**Fresh corpus** (`audit/31/corpus.js`): 17 entries, 10 JS and 7 Python. All 17 reached the executor and **12 were committed**.

| category | committed | finding |
|---|---|---|
| sep (`;` / `,` structure that SG37 does not list) | 6/6 | C1, C2, H3 |
| env (the suite reads the environment) | 3/3 | H1 |
| kw (block keyword swapped) | 3/3 | H2 |
| call (wrapper call around kept code) | 0/3 | holds |
| ctl (controls) | 0/2 | holds |

| severity | count |
|---|---|
| Critical | 2 |
| High | 3 |
| Medium | 3 |
| Low | 1 |

---

## Critical

### C1. `for await (...);` is not treated as an empty loop body

**Where:** `src/rl/bug-injector.js`, `uncoveredToken` → `structural`. The head test is ``code[p] === ')' && /\b(?:if|for|while)\s*$/.test(code.slice(0, pair.get(p)))``. For `for await (c of x);` the text before `(` ends in `for await `, so the regex does not match. The `;` stays exempt.

**Rule (CLAUDE.md):** "JS `;` as the empty body of an `if` / `else` / `for` / `while` / `do` head" is not exempt. `for await` is a `for` head.

**Effect:** the loop body runs once after the loop instead of once per item, so only the last chunk is counted. The edit is committed on the kill of a sibling `+ ''`.

```
S01 COMMITTED passed dt=equivalent(runs=75) mut(h=1 sites=2 mutants=2 run=6 killed=string_literal@6 by="countZw")
    + for await (c of chunks); if (String(c).length > 6000) zw++; | + return String(zw) + '';
    witness countZw(['a'.repeat(6001), 'a']): cur "1" prop "0"
S07 (control, the same shape with a plain `for`): stopped, uncovered_token=;
```

**Repro:** `node audit/31/c1-for-await.js` and `node audit/31/token-sites.js` (row `sep JS for await`).

**Expected:** the head regex allows `for\s+await`, and preferably any keyword head (see H3 `with`).

### C2. A Python `;` after a multi-line compound header is not structural

**Where:** `structural`, Python branch. It tests only the physical line that holds the `;`: ``/^[ \t]*(?:if|elif|…)\b/.test(code.slice(code.lastIndexOf('\n', a - 1) + 1, a))``. When the header spans several lines (a parenthesised condition, or a backslash continuation), the `;` sits on a continuation line that starts with `len(s) > 0):`. The test fails and the `;` stays exempt.

**Rule (CLAUDE.md):** "Python `;` on a compound statement's line" is not exempt. Here the `;` is on that statement's logical line and joins the next statement into the `if` suite.

**Effect:** NFKC now runs only when a zero-width character is present. The edit is committed on the kill of the sibling `+ ''`.

```
S05 COMMITTED passed dt=equivalent(runs=86 obs=true) mut(... killed=string_literal@7 by="tests.test_s05::test_show")
    +            len(s) > 0): s = s.replace(chr(8203), ""); s = unicodedata.normalize('NFKC', s)
    witness show('Ａ'): cur 'A' prop 'Ａ'
S06 COMMITTED  (the same shape, with a backslash-continued header)
```

The one-line header (AUDIT-27 Q05) still stops; see the token-sites control row.

**Repro:** `node audit/31/c2-py-header-semicolon.js` and `node audit/31/token-sites.js`.

**Expected:** find the start of the logical line. Walk back over open brackets (depth from the forward bracket pass) and over `\`-continued lines before applying the keyword test.

---

## High

### H1. A test that reads the environment kills every switch mutant

**Where:** `editMutants` and the executor kill loop. Mutant runs set `REFACTOR_MUTANT=1`. The control run leaves it unset, and the source text is the same in both. A test whose result depends on the set of environment variables therefore passes in the control and fails in both mutant runs, whatever the mutant changes. An example is a config loader that rejects unknown `REFACTOR_*` (or any prefix-scanned) variables. Every site of any edit counts as "killed" by that test.

**Rule:** the kill protocol is enforced as written: two failing mutant runs, a passing control, and the same test set. CLAUDE.md and README ("Switch control stops source readers, not value-blind tests") describe the control as removing every observation channel except the mutated value. The environment is a second channel. The evidence is unrelated to the edit.

```
E01 COMMITTED ... killed=numeric_off_by_one@4 by="config accepts the environment"   cap 6000 -> 7000 (JS)
E03 COMMITTED ... killed=numeric_off_by_one@3 by="tests.test_e03::test_config_accepts_environment"   (Python)
E02 COMMITTED ... NFKC inserted (last reported kill: 'NFKCx' throws in `show`; see M2)
E04 control (E01 without the env test): stopped, tests_insensitive
```

**Repro:** `node audit/31/h1-env-switch.js`.

**Expected:** make the control differ from the mutant only in the switch value, with no externally visible environment difference. For example, pass the switch through a channel the suite cannot enumerate: a per-run random variable name that is set to `'0'` in the control and `'1'` in the mutant runs, so the key set is the same. Alternatively, also set the variable in the control with a value that turns the switch off. Then a test that reads the environment fails or passes alike in both runs (`control_failed`).

### H2. A swapped block keyword is covered by its own condition site

**Where:** `EDIT_OPS` `negate_condition`. Its match covers the keyword: JS `if (`; Python `^[ \t]*(?:if|elif|while)[ \t]+`. So when `while` becomes `if`, or `elif` becomes `if`, the new keyword counts as covered by the kill of `!(cond)`. That kill shows the condition matters. It does not show the loop or the `elif` chain matters: the condition is unchanged.

```
K01 COMMITTED ... killed=negate_condition@4 by="cut"      while -> if: cut once, not until <= 6000   7500 chars: 5500 -> 6500
K02 COMMITTED ... killed=negate_condition@5               elif -> if: zero-width strip now also after the cap
K03 COMMITTED ... killed=negate_condition@3               while -> if (Python): one trailing zero-width char stripped, not all
```

**Repro:** `node audit/31/h2-keyword-swap.js` and `node audit/31/token-sites.js` (rows `kw`).

**Expected:** a changed block keyword is a structural token. Its kill needs a mutant that restores the old keyword, in the way `revert_reference` handles a swapped name. Failing that, it is `uncovered_token` unless the diff test observes it.

### H3. JS `;` and `,` that change structure, outside the SG37 list

**Where:** `structural`, JS branch. A `;` counts as structural only after `else` / `do`, after an `if` / `for` / `while` head, or before a line that ASI would join. A JS `,` is never structural. These shapes stay exempt and are committed on a sibling `+ ''`:

| id | shape | witness |
|---|---|---|
| S02 | `with (o || {}); t = …` (sloppy mode): the empty `with` body means the option `maxLen` is ignored | `title('abc', {maxLen: 1})` "a" → "abc" |
| S03 | same-line `return a + ''; + (cond ? '…' : '')`: the binary `+` becomes a dead unary statement | 7000 chars: 6001 → 6000 |
| S04 | `slice(0, 6000 - 1)` → `slice(0, 6000, - 1)`: the comma splits the operand into an ignored third argument | 7000 chars: 5999 → 6000 |

CLAUDE.md states the principle "a `;` or `,` that changes structure is not exempt", then lists cases. These shapes are outside the list, so this is High (the rule is enforced as listed) rather than Critical.

**Repro:** `node audit/31/h3-js-separators.js` and `node audit/31/token-sites.js`.

**Expected:**
- An inserted JS `;` is structural whenever the tokens on both sides would otherwise parse as one expression, on the same line or across a newline.
- An inserted JS `,` is structural unless it only separates inserted items.
- A `;` after any `)` that closes a statement head (`with` included) is structural.

---

## Medium

### M1. Carried commits re-verified

`audit/23` F01 F02 G01 G03 G04 (A23-M2 / A23-M4), as accepted. The other accepted carries were not re-run in this round: audit/21 T02 T07, audit/20 D09, audit/16 N12 N15 N18, and audit/13 (six).

### M2. A perturbation that throws is killed by any test that runs it (E02)

`'NFKC'` → `'NFKCx'` throws `RangeError`, so `typeof show('ab') === 'string'` kills it. This is a README known limit ("a perturbation that throws … is killed by any test that runs it"). It is listed because E02 combines it with H1.

### M3. Not covered this round

- Per-test caught-load attribution by name. TAP id escaping (`#`, `\`, newline) differs from `fullName`: node:test escapes names in TAP, and the hook logs `JSON.stringify(t.fullName)`. Whether a name collision can excuse a failing test's load throw was not driven end to end.
- An ESM (`.mjs`) module-body throw caught by `import().catch()` is not logged by the `_compile` hook. The one probe (M01, removed) was vetoed by the diff test before the executor.
- Python BOM files and hook (`before` / `beforeEach`) throws were not exercised.

## Low

### L1. Docs drift

- README "Switch control stops source readers, not value-blind tests": it does not say that a test reading the environment sees the switch (H1).
- CLAUDE.md / README `;` / `,` list: it gives `for` without `for await`, gives no `with`, no same-line ASI-hazard `;` and no JS comma (C1, H3). "Python `;` on a compound statement's line" is implemented as the physical line (C2).

## Holds

- **call:** C01–C03 insert a wrapper call around kept code: JS local helper, Python module call, Python local helper. All three stop with `surviving_ref`: the argument perturbation alone does not stand in for the callee.
- **Controls:** E04 (no env test) ends `tests_insensitive`. S07 (`for (...);`) ends `uncovered_token=;`.

## Repro index (`audit/31/`)

| script | what it shows |
|---|---|
| `corpus.js` | 10 JS + 7 Python witnessed semantics changes: env, kw, sep, call, ctl |
| `run.js` | the corpus end to end: worktree, real `node --test` / pytest with coverage.py, switch mutants with per-test kills and controls, commit. Options: `--only ID,…`, `--json out`. Prints FINDING on any commit |
| `token-sites.js` | C1, C2, H2 and H3 at unit level: which sites `editMutants` judges each hunk on, with SG37 controls |
| `c1-for-await.js` | S01 (and the S07 control) |
| `c2-py-header-semicolon.js` | S05, S06 |
| `h1-env-switch.js` | E01–E03 (and the E04 control) |
| `h2-keyword-swap.js` | K01–K03 |
| `h3-js-separators.js` | S02–S04 |
