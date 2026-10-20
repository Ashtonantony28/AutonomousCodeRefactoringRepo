# AUDIT-21: Validation soundness, round 8 (no false negatives)

Audited commit `ed7597b` (SG30: fail closed per inserted token through
`hunks.lexView`, numeric / regex / interpolation sites, sham-mutant control
for text-adding mutants, call use-site rule, load hooks). The auditor did not
write the code under audit. Every repro uses the repo's stub client and a
temp `REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js`
and `audit/5/lib.js`). None call the live API. None touch `src/`, `test/`,
`state/` or `dashboard/`. Each script runs from the repo root as
`node audit/21/<script>.js`, prints `FINDING` or `ok`, and exits 1 on a
reproduced finding.

The critic in every end-to-end scenario is **unanimous**: 3/3 personas
approve with `p_preserves` 0.9 and no `edge_cases`. Each corpus entry is
checked in `run.js` by a real `node`/`python3` witness (the edit changes
observable behaviour) and by running its suite on the **current** version
(it passes). The corpus has 0 `BADWITNESS` and 0 `BADSUITE`.

## Summary

**Prior repros hold.**
- `node audit/20/run.js`: 1 of 54 committed, D09 (string site, README limit).
  `token-sites.js` and `load-detect.js` are ok (AUDIT-20 C1, C2, H1, M5 fixed).
- `node audit/16/run.js`: 3 of 52 committed, N12, N15, N18 (M1).
- `node audit/13/run.js`: 8 of 81 committed, T02 D02 D03 U05 G12 U02 P03
  P01 (M1).
- `audit/5`, `audit/8` and `audit/12` `e2e-commit.js` commit nothing.
- `audit/12/executor-benign.js` rejects 9 of 18 (was 10; M6).

**SG30 closes the AUDIT-20 shapes. Two of its own assumptions do not hold.**
The fail-closed list covers names, numbers, strings and literal parts, but
not operators or keywords. And `tokensOf` starts at the changed line, not at
the literal that holds it. The fresh corpus has 42 witnessed semantics
changes (24 JS, 18 Python), none of them shapes from
`audit/{5,8,12,13,16,20}`. `node audit/21/run.js` runs them end to end, and
**25 are committed**:

| category | committed | |
|---|---|---|
| op (operator / keyword carries the change) | 14/14 | H1 |
| mlit (line inside or closing a multi-line literal) | 4/8 | C1 |
| sham (source-reading tests) | 4/6 | H2 (S01 S02), M4 (S03 S04) |
| tmpl (format spec, conversion, bytes regex; nested / tagged / commented `${}`, regex flag) | 3/8 | M3 |
| jsx (`.jsx`: no diff test) | 0/3 | holds: `no_coverage_tool` |
| delins (`.jsx`) | 0/3 | holds: `no_coverage_tool` |

| severity | count |
|---|---|
| Critical | 1 |
| High | 2 |
| Medium | 6 |
| Low | 1 |

### SG30 changes probed

| change | result |
|---|---|
| `${}` / f-string `{}` tokens, nested and tagged templates, comment holding `}` in `${}` (T03 T04 T05) | holds: inner reads get use sites, the cap's `String` survives |
| regex flag site (T06) | vetoed by the diff test before the executor |
| fail closed per token: names, numbers, strings, parts, atoms, flags | holds for those. Operators and keywords are not in the list (H1) |
| tokens via `lexView` | only for a literal that starts inside the changed lines. A line inside or closing a multi-line literal is tokenised from the line start (C1) |
| `lexView` itself | never returns on a Python string right after a word character (M2) |
| sham control | stops whitespace-counting size tests (S06). Not a size test that strips whitespace (H2), nor a grep (M4, documented) |
| call use site | a module call skips to its argument (S05 stops, `surviving_ref`) |
| same-name rule for keys / keyword arguments | an unrelated read of the same name covers a keyword argument (M5, unit level) |
| load hooks | `audit/20/load-detect.js` ok (deep and wrapped load failures flagged) |

---

## Critical

### C1. A changed line inside or closing a multi-line literal is tokenised from the line start: code becomes one "string" token, and a mutant anywhere in it covers all of it

**Affected code.** `src/utils/hunks.js`:
- `tokenHunk` calls `tokensOf(v, lo, hi)` with `lo` = start of the first
  changed line.
- `tokensOf` uses `v.at` (template, f-string and regex literals by **start**
  offset) only when a match begins at a literal's start. When `lo` is inside
  a multi-line template or triple-quoted string, the literal is never
  looked up, and the plain `JS_TOKEN` / `PY_TOKEN` regex runs on the text.
- Quotes in the literal text then pair up with code:
  - `href="${…}"` or `It's ${…} o'clock` becomes one `'…'` / `"…"` token
    around the interpolation.
  - The closing `` ` `` or `"""` of the literal opens a token that runs to the
    next backtick, `"` or `"""` and is cut at the line end.

In `bug-injector.editMutants`, every operator match inside that range has
the pseudo-token's start as its site. The token starts with a quote, so
`uncoveredToken` needs only one mutant at that site, and the executor needs
one kill per site. Names inside are not tokens, so they get no use site.
Numbers inside share the one site. In M08 the kill is `swap_arith` on an
**unchanged** `+`.

**Rule as written (CLAUDE.md, Inserted tokens):** "Tokens come from
`utils/hunks.lexView` … A *site* is one inserted/changed token … every
inserted name …, number, string … must be covered by a mutant of its own
site or lie inside the expression a use-site mutant perturbs." The controls
show the rule working when the same change sits on one line: `slice` gets a
use site and `0x800` its own site.

**Repro:** `node audit/21/run.js --only M01,M02,M03,M08` and
`node audit/21/token-sites.js`.
```
M01 COMMITTED passed dt=equivalent(runs=74 obs=true) mut(h=1 sites=1 mutants=2 run=3 killed=numeric_off_by_one@4 by="link")
    -<a href="${String(u)}">${t}</a> | +<a href="${String(u).slice(0, 0x800)}">${t}</a>            witness 5017 -> 2064
M02 COMMITTED passed dt=equivalent(runs=70) mut(h=1 sites=1 mutants=3 run=3 killed=numeric_off_by_one@5 by="card")
    -`.trim() + "!"; | +`.trim().slice(0, 0x1000) + "!";                                           witness 5008 -> 4097
M03 COMMITTED passed dt=equivalent(runs=71 obs=true) mut(h=1 sites=1 mutants=1 run=3 killed=string_literal@4 by="clock")
    -It's ${String(n)} o'clock | +It's ${String(n).normalize("NFKC")} o'clock                         witness "It's ５ o'clock" -> "It's 5 o'clock"
M08 COMMITTED passed dt=equivalent(runs=78) mut(h=1 sites=1 mutants=3 run=4 killed=swap_arith@4 by="tests.test_m08::test_note")
    -""".strip() + " " + str(s).expandtabs(4) | +""".strip() + " " + str(s).expandtabs(-4)            witness 'note: a   b' -> 'note: ab'

token-sites.js:
FINDING mlit JS href="${}" line (M01)       inserted=["\"${String(u).slice(0, 0x800)}\""]  no own site: slice, 0x800
FINDING mlit JS template closing line (M02) inserted=["`.trim().slice(0, 0x1000) + \"!\";"]  no own site: slice, 0x1000
FINDING mlit JS apostrophes in text (M03)   inserted=["'s ${String(n).normalize(\"NFKC\")} o'"]  no own site: normalize
FINDING mlit Py triple-quote closing (M08)  inserted=["\"\"\".strip() + \" \" + str(s).expandtabs(-4)"] mutants=[numeric_off_by_one, swap_arith, swap_arith]  no own site: -
ok      control: M01 change on one line     inserted=[".","slice","(","0",",","0x800",")"] mutants=[use_site, numeric_off_by_one@0, numeric_off_by_one@0x800]
```
In M01 the kill is `0 → 1` on `slice(0, …)`; `0x800` is never mutated.
In M03, the kill is `"NFKC"` → `"NFKCx"` (a `RangeError`); `normalize` has
no use site. M04, the same shape with a regex, has a part after `${}` that
no mutant covers and is stopped (`uncovered_token`).

Python's M05, M06 and M07 are stopped before the bar (`edit_not_exercised`).
coverage.py reports no executable line inside a multi-line string. M08's
closing line is a statement line, and it commits.

**Expected:** a hunk's token range starts at the start of any literal that
contains the hunk start. The literal is then split the way `lexView` splits
it (text parts, interpolation tokens, atoms). Failing that, a hunk that
starts inside a literal is no evidence.

---

## High

### H1. An operator or keyword that carries the change has no site, and is not in the fail-closed list; the hunk stands on a sibling's kill

**Affected code.** `bug-injector.js` `uncoveredToken`:
`must = literal part || name || /^(?:\d|\.\d)/ || /^[rRbBuUfF]{0,2}['"`]/`.
- Operators are not in it: unary `-`, `|`, `>>`, `>>>`, `<<`, `//`, `**`,
  `**=`, `??`, `!`.
- Neither are keywords: `in`, `not`, `is`, `None`, `null`. `KEYWORDS` keeps
  them out of `insertedNames`.

`EDIT_OPS` has no operator for any of these. So such a token needs no
coverage, and the hunk is judged on its other sites: a re-quoted string, or
a literal next to the operator (`| 0`, `>> 1`, `>>> 0`).

**Why High:** the kill is on another token, and it says nothing about the
operator. PLAN SG30 asks for "every inserted or changed non-punctuation
token" to be covered. CLAUDE.md lists only names, numbers, strings, parts,
atoms and flags.

**Repro:** `node audit/21/run.js --only O01,O02,O03,O04,O05,O06,O07,O08,O09,O10,O11,O12,O13,O14`
and `node audit/21/token-sites.js`.
```
O01 COMMITTED passed dt=equivalent(runs=63 obs=true) mut(h=1 sites=1 run=3 killed=string_literal@3 by="head")
    -  return 'head:' + String(s).slice(0, 0x1000); | +  return "head:" + String(s).slice(-0x1000);          witness "head:a" -> "head:x"
O03 typeof T[k] === 'number' -> k in TABLE     killed=use_site       witness has('toString') false -> true
O04 hasOwnProperty.call(ROLES, r) -> r in ROLES killed=use_site       witness known('constructor') false -> true
O05 Math.trunc(x) -> x | 0                     killed=numeric_off_by_one (`| 0` -> `| 1`)   witness 2**31: 2147483648 -> -2147483648
O06 Math.floor(x / 2) -> x >> 1                killed=numeric_off_by_one (`>> 1` -> `>> 2`) witness 2**31: 1073741824 -> -1073741824
O07 Math.trunc(abs) -> x >>> 0                 killed=numeric_off_by_one                   witness 2**32+1: 4294967297 -> 1
O08 x * 2 -> x << 1                            killed=numeric_off_by_one                   witness 2**30: 2147483648 -> -2147483648
O09 int(a / 2) -> a // 2 (Py)                  killed=string_literal                       witness 2**53+3
O10 math.ceil(a / b) -> -(-a // b)             killed=string_literal                       witness 2**53+1
O11 expandtabs(4) -> expandtabs(-4)            killed=string_literal                       witness 'a\tb': '> a   b' -> '> ab'
O12 xs[:100] -> xs[-100:]                      killed=string_literal                       witness range(150): f=0 -> f=50
O13 int((a+b)/2) -> (a+b) // 2                 killed=string_literal
O14 int(math.pow(n, 2)) -> n ** 2              killed=string_literal                       witness 2**30+1
token-sites.js: FINDING for `-` `in` `|` `>>` `>>>` `??` `!` `**=` `null` (JS); `//` `-` `**` `not` `is` `None` (Py): "no own site"
```
Every one has a diff-test blind input: values past 2\*\*30 / 2\*\*31 /
2\*\*53, prototype keys, tabs, lists over 100, strings over 4096.

**Expected:** every inserted operator and keyword is a site with its own
mutant: the operator swapped for its counterpart, unary `-` / `!` / `not`
dropped, `in` ↔ `not in`, `is` ↔ `==`, `None` / `null` → `0`. An inserted
operator or keyword that no mutant covers is no evidence.

### H2. A source-size test that ignores whitespace kills every use-site mutant; the sham (spaces) passes it

**Affected code.** `executor.js` `mutationEvidence`: the control of a
text-adding mutant is `m.sham`, the edit with `grow` spaces at `pad`. A test
that measures the source **without whitespace** fails on the mutant and
passes on the sham, so the kill counts. `JS_PERTURB` / `PY_PERTURB` add
about 400 non-space characters. A whitespace-stripped length check is a
common "minified size budget" check, and it never calls the code.

**Why High:** the kill is on source size, not on the use site's value.
README says the sham "stops tests that read source length or layout". The
controls show that the behavioural test alone is not enough: S06 has the
same edit with a size test that counts whitespace, and it is stopped
(`sham_failed=1`, `surviving_ref=SKIP`), as was AUDIT-20 F03 with no style
test.

**Repro:** `node audit/21/run.js --only S01,S02,S06`
```
S01 COMMITTED passed dt=equivalent(runs=57) mut(h=1 sites=3 mutants=3 run=9 killed=use_site@5 by="size: src/ stays within its minified budget")
    -  return String(s).slice(SKIP); | +  return String(s).slice(SKIP, SKIP + MAX_LEN);          witness 4999 -> 4096
S02 COMMITTED ... killed=use_site@5 by="tests.test_size::test_size_budget"   str(s)[SKIP:SKIP + MAX_LEN]   4999 -> 4096
S06 stopped   reverted(tests_insensitive) ... surviving_ref=SKIP sham_failed=1   (control: size test counts whitespace)
```
**Expected:** a kill counts only from a test that executed the mutated use
site, using per-test coverage of the mutant line. Failing that, use a sham
that adds the same characters in a form that never runs, for example the
perturbation text in a dead branch or a comment-free string literal.

---

## Medium

### M1. Carried commits re-verified: generator blind spots in README "Known limits"

- **audit/20 D09:** `r'\t'` → `r'\t+'`, killed on the changed string token
  (`string_literal@4`). README: "a change inside it (`r'\t'` → `r'\t+'`)
  stands on any test that checks the string's output".
- **audit/16 N12, N15:** deletions (`sites=0 mutants=0`, `obs=true`) of a
  `match` alternative and the `isascii()` guard operand. Inputs never built.
- **audit/16 N18:** `<=` → `!=` past 2\*\*53. The kill `negate_equality@2` is
  on the changed token, and the deleted `<=` is in the same stretch.
- **audit/13 T02 D02 D03 U05 G12 U02 P03 P01:** all deletions
  (`sites=0 mutants=0 obs=true`): tabs, zero-width, list cap, dropped
  `await`, nesting, list cap, NFKC, `global`. Each matches a README blind
  spot. None stands on unrelated code.

### M2. `lexView` never returns on a Python string right after a word character

**Affected code:** `hunks.js` `pyLex`. It treats `"` / `'` as a string start
only when `!isWord(src[i - 1])`. Otherwise it runs
`while (isWord(src[i])) i++` from the quote, which matches nothing, and
`continue`s with `i` unchanged. `return"x"`, `else"y"` and `in"abc"` are
valid Python. `changeHunks` lexes the whole file, synchronously, on the main
thread: once in the executor, and in the diff test when the snippet holds
the string. So any edit of such a file hangs the run. The documented
`SIGINT`/`SIGTERM` revert cannot run during a synchronous loop. No commit
results.

**Repro:** `node audit/21/lex-hang.js` (exit 1).
```
FINDING a) changeHunks(before, after) on app/x.py: no result after 10017 ms (killed)
FINDING b) end to end (gate + executor) on the same edit: no result after 120058 ms (killed)
ok      c) control: b) with `return "text" if s else "empty"`: status=reverted reason=tests_insensitive in 5937 ms
```

### M3. A change inside an f-string format spec or conversion is one text-part site

- **T01:** `{str(s)}` → `{str(s):.4096}` truncates at 4096.
- **T02:** `!r` → `!a` escapes non-ASCII.
- **T07:** `rb'\t'` → `rb'\t+'` (D09 with a bytes prefix).

`lexView` makes the spec or conversion part of the next text part (`:.4096}]"`,
`!a}]"`). Its only mutant appends `x`, and an exact-output test kills that.
README documents this ("a template / f-string text part, is one site").
But `.4096` is a number in effect, and CLAUDE.md says "any numeric spelling"
is a site.

`node audit/21/run.js --only T01,T02,T07`: all COMMITTED, `killed=string_literal`
(witnesses 5002 → 4098; `<'é'>` → `<'\xe9'>`; `'a  b'` → `'a b'`).

### M4. A source grep kills use-site mutants (README limit)

- **S03:** a lint test that `src/` has no `=>`.
- **S04:** a test that `app/` has no `lambda`.

Both fail on every `JS_PERTURB` / `PY_PERTURB` mutant and pass the sham.
README: "A test that greps the source for a name … has no sham."
`node audit/21/run.js --only S03,S04`: both COMMITTED
(`killed=use_site@5 by="lint: no arrow functions in src (ES5 target)"` /
`tests.test_lint::test_no_lambda`).

### M5. A keyword argument is covered by an unrelated read of the same name (unit level, no commit found)

`uncoveredToken` adds a covered name's text to `read`. Then any loose name
(a binding, key or keyword argument) with that text passes.

In this edit, `tabsize=` in `textwrap.fill(…, tabsize=2)` is covered by the
use site of a parameter `tabsize` read in another statement
(`pad = ' ' * tabsize`):
```python
def f(s, tabsize):
    pad = ' ' * tabsize                                  # was ' ' * 2
    return pad + textwrap.fill(str(s), 20, tabsize=2)   # kwarg added
```
With no such read, `tabsize` is `uncovered`. No end-to-end commit was built:
the keyword's value `2` is its own site and survives on tab-free tests.

### M6. Over-rejection (carried) and closed paths

- `audit/12/executor-benign.js` rejects 9 of 18 (B02 B03 B06 B07 B09 B10
  B12 B13 B14). B05 now commits.
- `.jsx` sources (X01–X03, Y01–Y03) never reach the bar. The diff test does
  not run on them ("another language"), and the edit ends `no_coverage_tool`.
- M04 (a template part after `${}` with no mutant) ends `uncovered_token`.

## Low

### L1. Docs drift

- **CLAUDE.md** says "Tokens come from `utils/hunks.lexView`". `tokensOf`
  uses `lexView` only for literals that start inside the hunk (C1).
- **PLAN SG30** says "every inserted or changed non-punctuation token". The
  CLAUDE.md list omits operators and keywords (H1).
- **README** says the sham "stops tests that read source length". A length
  without whitespace is not stopped (H2).

## What holds

- **SG30 closes AUDIT-20.** C1, C2, H1, H2 (`audit/20` F01/F02: the style
  test now fails the sham) and H3 are fixed: `audit/20/run.js` commits only
  D09, and `token-sites.js` and `load-detect.js` are ok.
- **Template tokenisation inside one line.** Nested templates, tagged
  templates and a comment holding `}` in `${}` give the inner reads use
  sites, and the cap's `String` survives (T03, T04, T05).
- **Sham control.** A size test that counts whitespace fails the sham, and
  the kill is dropped (S06 `sham_failed=1`).
- **Call use site.** A module call is skipped to its argument, not to the
  module (S05, and AUDIT-20 E01/E03, stopped with `surviving_ref`).
- **Prior repros.** `audit/5`, `8` and `12` e2e commit nothing.

## Repro index (`audit/21/`)

| script | what it shows |
|---|---|
| `corpus.js` | 24 JS + 18 Python witnessed semantics changes: op, jsx, delins, mlit, sham, tmpl |
| `run.js` | corpus end to end (worktree, real `node --test` / pytest + coverage.py, per-site mutants with sham controls, per-test kills, commit); checks witness and suite on current. `--only ID,…`, `--json out`. FINDING on any commit |
| `token-sites.js` | H1 and C1 at unit level: which inserted tokens have a mutant of their own in `editMutants`, with one-line controls |
| `lex-hang.js` | M2: `changeHunks` and the end-to-end run do not return on `return"x"`; child processes with time limits and their own `TMPDIR` |
