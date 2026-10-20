# AUDIT-20: Validation soundness, round 7 (no false negatives)

Audited commit `ac11f28` (after SG26 per-test kills and use-site relevance,
SG27 Python numeric-constant inputs, SG28 reporter fallback). The auditor did
not write the code under audit. Every repro uses the repo's stub client and a
temp `REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js`
and `audit/5/lib.js`). None call the live API. None touch `src/`, `test/`,
`state/` or `dashboard/`. Each script runs from the repo root as
`node audit/20/<script>.js`, prints `FINDING` or `ok`, and exits 1 on a
reproduced finding.

The critic in every end-to-end scenario is **unanimous**: 3/3 personas
approve with `p_preserves` 0.9 and no `edge_cases`. Each corpus entry is
checked in `run.js` by a real `node`/`python3` witness (the edit changes
observable behaviour) and by running its suite on the **current** version
(it passes). The corpus has 0 `BADWITNESS` and 0 `BADSUITE`.

## Summary

**Prior repros hold.**
- `node audit/16/run.js`: 3 of 52 committed, N12, N15 and N18, as expected.
  These are re-verified below (M1).
- `node audit/13/run.js`: 8 of 81 committed (T02 D02 D03 U05 G12 U02 P03
  P01), the known-limit deletions (M1).
- `audit/5`, `audit/8` and `audit/12` `e2e-commit.js` commit nothing.
- `audit/16/carried-refs.js`, `collection-error.js` and `snapshot-discard.js`
  are ok.
- `audit/12/executor-benign.js` rejects 10 of 18, unchanged since SG26 (M4).

**SG26 holds for the shapes it names. Inserted code it never tokenises, and
kills from tests that never call the code, still commit.** The fresh corpus
has 54 witnessed semantics changes (29 JS, 25 Python), none of them shapes
from `audit/{5,8,12,13,16}`. `node audit/20/run.js` runs them end to end, and
**24 are committed**:

| category | committed | |
|---|---|---|
| tmpl (JS `${…}`) | 4/7 | C1 |
| fstr (Python f-string `{…}`) | 6/7 | C1 |
| kwid (`Infinity`) | 2/3 | C2 |
| lit (hex / exponent / `_` / regex) | 8/9 | H1, M2 |
| modcall (module-function call) | 2/6 | H3 |
| pertest | 2/8 | H2 |
| use (SG26 shapes) | 0/10 | holds |
| pyconst (SG27) | 0/2 | M3 (diff test only) |
| reporter (SG28) | 0/2 | holds |

| severity | count |
|---|---|
| Critical | 2 |
| High | 3 |
| Medium | 5 |
| Low | 1 |

### SG26–SG28 changes probed

| change | result |
|---|---|
| per-test kill: test-id matching, duplicate names (F04), duplicate parametrized ids and same-named class tests (F05), todo/skip (F06), non-strict xfail (F08) | no false kill. A kill needs a control `pass` → mutant `fail`, so `#n` suffixes, `skip` and `xfail` never make one |
| per-test kill: which test fails | any test counts. A style test that only reads source text kills the long use-site perturbation (H2) |
| load failure is no kill | holds for a module-body frame in the stack and `in <module>`. Missed for a throw more than 10 calls deep, or when the test wraps the import (M5, no commit found) |
| use sites: optional chaining, computed member, closure, getter, default parameter, spread, walrus, keyword argument, decorator, property (G01–G10) | all stopped (`unmutated_ref`, surviving use site, or vetoed) |
| use sites: reads inside template literals and f-strings | never tokenised, so no site at all (C1) |
| use sites: `Infinity` / `undefined` / `NaN` | treated as keywords, so no site (C2) |
| use sites: module-function call | the skip mutant is the module object. It is always killed (H3) |
| SG27 `module_nums` | a module name bound once to a number makes `x == NAME` build only numbers, which hides a bool-only divergence (M3). A name rebound through `globals().update` was not hidden (`py-num-hint.js` b) |
| SG28 reporter fallback | no per-test results means no kill: R01 (delegated `--test-reporter`) and R02 (own reporter) end `tests_insensitive` (`no_failed_test=1`) |
| tests that pass by throwing (F07), lru_cache decorator (G09), closure swap (G03) | vetoed by the diff test before the executor |

---

## Critical

### C1. Reads inside a JS template literal or a Python f-string get no use site; the commit stands on the kill of a string

**Affected code.**
- `src/utils/hunks.js`: `JS_TOKEN` and `PY_TOKEN` read a whole template
  literal or f-string as one token.
- `src/rl/bug-injector.js` `insertedNames`: never sees the identifiers
  inside that token, so `jsUses` / `pyUses` never perturb them.
- `polyglot.stripCode` blanks the template, including its `${}`, so no
  operator matches inside it either.

So:
- **JS:** the hunk's only sites are other tokens. The corpus uses a
  re-quoted string (`' ('` → `" ("`), a formatter-style change.
- **Python:** the only site is the f-string itself. Its `string_literal`
  mutant appends `x` to the text, and any exact-output test kills it.

**Rule as written (CLAUDE.md, Use sites):** "Every inserted identifier or
member the edit reads … is a site of the hunk too … So `slice(0, MAX)` needs
a kill of `MAX` at this use." The control (`str.format`, B06) shows the rule
working once the same reads are tokens: `str` and `4096` get sites, they
survive, and the edit ends `tests_insensitive`.

**Repro:** `node audit/20/run.js --only A01,A03,A04,A06,B01,B02,B03,B04,B05,B07`
and `node audit/20/token-sites.js`.
```
A01 COMMITTED passed dt=equivalent(runs=69 obs=true) mut(h=1 sites=2 mutants=2 run=6 killed=string_literal@3 by="label")
    -  return `${title}` + ' (' + n + ')'; | +  return `${String(title).slice(0, 4096)}` + " (" + n + ")";   witness 5004 -> 4100
A03 COMMITTED ... killed=string_literal by="tag"      `[${String(t).replace(/​/g, '')}]`   witness "[a​b] t" -> "[ab] t"
A04 COMMITTED ... killed=string_literal by="count"    `${xs.flat(Infinity).length}`             witness n=3 -> n=4
A06 COMMITTED ... killed=string_literal by="key"      `${String(name).normalize('NFKC')...}`    witness "k:ａｂ" -> "k:ab"
B01 COMMITTED passed dt=equivalent(runs=80 obs=true) mut(h=1 sites=1 mutants=1 run=3 killed=string_literal@2 by="tests.test_b01::test_label")
    -    return f"{title} ({n})" | +    return f"{str(title)[:4096]} ({n})"                                         witness 5004 -> 4100
B02 expandtabs(4) | B03 list(xs)[:100] | B04 unicodedata.normalize('NFKC', …) | B05 replace(chr(0x200B), '') | B07 conditional
    truncation: all COMMITTED, killed=string_literal (the f-string + "x")
A02 (control: template change, no sibling) reverted(tests_insensitive) mutants=0
B06 (control: same change via str.format)   reverted(tests_insensitive) surviving use site

token-sites.js:
FINDING JS `${}` truncation (A01)      sites=2 [string_literal:" (", string_literal:")"]  no own site: String, 4096
ok      JS same, outside `${}`         sites=3 [use_site:String, numeric_off_by_one:0, numeric_off_by_one:4096]
FINDING Py f-string truncation (B01)   sites=1 [string_literal:"{str(t)[:4096]} ({n})"]  no own site: str, 4096
ok      Py same, str.format            sites=2 [use_site:str, numeric_off_by_one:4096]
```
**Expected:** inserted code inside `${…}` and f-string `{…}` is tokenised and
mutated like any other code, including use sites and literals. Until then, a
changed template or f-string with inserted expressions is no evidence.

### C2. `Infinity`, `undefined` and `NaN` are treated as keywords, so an inserted read of them has no use site

**Affected code:** `bug-injector.js:359`. `KEYWORDS.javascript` lists
`undefined NaN Infinity arguments`. In JS these are identifiers (global
bindings), not keywords, so `insertedNames` skips them. The hunk stands on a
sibling's kill (here, a re-quoted `"n="`).

**Rule as written (CLAUDE.md):** "Every inserted identifier or member the
edit reads (not a keyword, …) is a site". The control C03 spells the same
value as a member, `Number.POSITIVE_INFINITY`. It gets a use site, which
survives, and the edit is `tests_insensitive`.

**Repro:** `node audit/20/run.js --only C01,C02,C03`
```
C01 COMMITTED passed dt=equivalent(runs=67 obs=true) mut(h=1 sites=1 mutants=1 run=3 killed=string_literal@3 by="count")
    -  return 'n=' + xs.flat().length; | +  return "n=" + xs.flat(Infinity).length;          witness count([1,[2,[3,[4]]]]) n=3 -> n=4
C02 COMMITTED ... killed=string_literal by="count"   function count(xs, depth = 1) -> depth = Infinity   n=3 -> n=4
C03 stopped   reverted(tests_insensitive) ... surviving_ref=Number   (control)
```
**Expected:** a read of `Infinity`, `undefined`, `NaN` or `arguments` is a
use site. A value with no perturbation that differs (`Infinity + 1`) is no
evidence (`unmutated_ref`).

---

## High

### H1. Literals no operator applies to (hex, exponent, `_` separators, regex flags and classes) carry the change; the kill is on a sibling token

**Affected code:** `bug-injector.js:167/178`. `numeric_off_by_one` matches
only decimal `\d+(\.\d+)?` that has no word character next to it, so
`0x1000`, `4e3`, `4_096` and `0o…` are not sites. Regex literal flags and
classes are not sites either: the `g` token is skipped as a name with no
Identifier, and nothing mutates regex content. The hunk needs some site, and
a re-quoted string on the same line is one.

**Why High:** the hunk passes on a kill of `"id:"`, which says nothing about
the cap or the flag. It is the slice-start-`0` pattern of AUDIT-13 H1 with a
literal the operators cannot see.

**Repro:** `node audit/20/run.js --only D01,D02,D03,D05,D06,D07` and
`node audit/20/token-sites.js`.
```
D01 COMMITTED passed dt=equivalent(runs=64 obs=true) mut(h=1 sites=1 run=3 killed=string_literal@3 by="tail")
    -  return 'id:' + String(s).slice(1); | +  return "id:" + String(s).slice(1, 0x1000);       witness 5002 -> 4098
D02 slice(1, 4e3) 5002 -> 4002 | D03 slice(1, 4_096) | D06 Py str(s)[1:0x1000] | D07 Py str(s)[1:4_096]: COMMITTED, killed=string_literal
D05 COMMITTED  -  split(/,/).join('|') | +  split(/[,、]/).join("|")                       witness "a、b" -> "a|b"
token-sites.js: FINDING JS hex / exponent / separator / regex flag g, Py hex / separator: no own site
                ok JS decimal literal (control): numeric_off_by_one:4096
```
**Expected:** every numeric literal spelling is a site, and a changed regex
literal (flags or body) is a site with its own mutant. Otherwise the hunk
has no evidence.

### H2. A kill can come from a test that never runs the code: a source-text style test kills every JS/Python use-site mutant

**Affected code:** `executor.js` `failedTests` / `mutationEvidence`. Any test
that passed in the control and fails in both mutant runs counts.
`JS_PERTURB` and `PY_PERTURB` (`bug-injector.js`) insert roughly 400
characters on the edited line. A line-length test that reads `src/*.js` or
`app/*.py` fails on every use-site mutant and never calls the code.

**Why High:** the rule is met by evidence unrelated to the use site's value.
`SKIP` (the slice end) and `MAX_LEN` both survive on the behavioural test.
The control F03 is the same edit without the style test, and it is
`tests_insensitive`.

**Repro:** `node audit/20/run.js --only F01,F02,F03`
```
F01 COMMITTED passed dt=equivalent(runs=57) mut(h=1 sites=3 mutants=3 run=9 killed=use_site@5 by="style: no source line over 120 characters")
    -  return String(s).slice(SKIP); | +  return String(s).slice(SKIP, SKIP + MAX_LEN);          witness 4999 -> 4096
F02 COMMITTED ... killed=use_site@5 by="tests.test_style::test_style_line_length"  str(s)[SKIP:SKIP + MAX_LEN]  4999 -> 4096
F03 stopped   reverted(tests_insensitive) ... surviving_ref=SKIP   (control: no style test)
```
**Expected:** a kill counts only when the failing test executed the mutated
use site. Per-test coverage of the mutant line would give this; so would a
perturbation that keeps the line length, such as a helper call.

### H3. An inserted module-function call is "skipped" to the module object, which any test kills

**Affected code:** `bug-injector.js:432` (JS `ns` is only for a capitalised
receiver) and `:493` (Python skips to `f.value` unless it is `self`/`cls` or
capitalised). For `textwrap.dedent(x)`, `unicodedata.normalize('NFKC', x)` or
`path.basename(p)`, the receiver is a lowercase module. The use-site mutant
replaces the call's value with the module, and every test that runs it fails
(`AttributeError` / `TypeError`). The pass-through skip, `(x)`, would
survive.

**Why High:** the evidence for the inserted call does not depend on what the
call does. README lists "a perturbation that throws is killed by any test
that runs it", but this skip throws for every module-function call, whatever
its effect. In E01 the other site, `'NFKC'` → `'NFKCx'`, also throws
(`ValueError`).

**Repro:** `node audit/20/run.js --only E01,E03`
```
E01 COMMITTED passed dt=equivalent(runs=78) mut(h=1 sites=2 mutants=2 run=6 killed=string_literal@4 by="tests.test_e01::test_key")
    -    return str(s).strip().lower() | +    return unicodedata.normalize('NFKC', str(s)).strip().lower()   witness 'ａｂ' -> 'ab'
E03 COMMITTED passed dt=equivalent(runs=78) mut(h=1 sites=1 mutants=1 run=3 killed=use_site@4 by="tests.test_e03::test_body")
    -    return str(s).strip() | +    return textwrap.dedent(str(s)).strip()                    witness 'a\n  b' -> 'a\nb'
```
**Expected:** when the receiver is a module, or any non-value namespace, the
skip passes the first argument through, as for a capitalised namespace.

---

## Medium

### M1. Carried commits re-verified: generator blind spots in README "Known limits"

- `node audit/16/run.js --only N12,N15,N18`: all 3 COMMITTED, as in
  AUDIT-16 M2.
  - N12 and N15 are deletions (`sites=0`, `obs=true`): a `match` alternative
    `"head"` and the guard operand `isascii()`. The probe is on the deleted
    code. The inputs (`"head"`, non-ASCII) are never built.
  - N18 (`<=` → `!=` past `2**53`): the kill `negate_equality@2` is on the
    changed token. Big integers are never built.
- `node audit/13/run.js`: the 8 commits are the README deletions (tabs,
  zero-width, list cap, dropped await, nesting, compatibility chars, list
  cap, `global`). Each has `sites=0 mutants=0` and `obs=true`, and none is
  on unrelated code.

### M2. A whole-string kill stands for a change inside the string; a throwing skip stands for a cap

- **D09.** `re.sub(r'\t', …)` → `r'\t+'`. The string site's mutant
  `r'\t+x'` breaks the single-tab test, so the changed token is killed, and
  the commit is within the rule as written. Multi-tab input is never tested
  or built.
- **D08.** `str(s)[1:]` → `str(s)[1:int(4e3)]`. The `int` skip mutant
  slices with a float (`TypeError`), which is README's "perturbation that
  throws".

`node audit/20/run.js --only D08,D09`: both COMMITTED (witness 4999 → 3999;
`'a  b'` → `'a b'`).

### M3. SG27 `module_nums`: `x == NAME` with a numeric constant builds only numbers

`node audit/20/py-num-hint.js` (exit 1):
```
FINDING a flag == ENABLED (bool input)   module_nums: equivalent(runs=30)  twin (bound twice): divergent(runs=27)
ok      b ch * WIDTH, WIDTH rebound via globals().update   divergent / divergent
ok      c fmt % COUNT (format-string input)                equivalent / equivalent (format strings never built either way)
```
`use()` adds `num` and `any` for `==`, and `pools_from` drops `any` when
another kind is present. So bools are never built once the constant is
known. End to end, H01 is stopped by the executor (`surviving_ref=flag`), so
no commit results. The non-constant case (b) is not hidden.

### M4. Over-rejection (carried)

`audit/12/executor-benign.js` rejects 10 of 18 (B02 B03 B05 B06 B07 B09 B10
B12 B13 B14), unchanged since SG26. In the new corpus, A02 (a template-only
edit) has no site and every G entry ends `tests_insensitive`. These are
correct for semantics changes, but a safe template edit can never commit.

### M5. Load-failure detection misses deep and wrapped load errors (no commit found)

`node audit/20/load-detect.js` (exit 1):
```
ok      js-a control: module body throws, require inside the test     collection_error=true
FINDING js-b module body throws 12 calls deep                         collection_error=false failing=[body] -> kill-eligible
FINDING js-c test wraps require, assert.fail(message)                 collection_error=false failing=[body] -> kill-eligible
ok      py-d control: import inside the test function                 collection_error=true
FINDING py-e test wraps import, pytest.fail(pytrace=False)            collection_error=false failing=[tests.test_mod::test_body]
```
`LOAD_FRAME` (`test-runner.js:392`) needs a `Module._compile` frame within
V8's 10-frame stack. The JUnit check (`:433`) needs `in <module>` in the
report. This contradicts the CLAUDE.md line "a failure raised from a module
body … whatever the exit code … is never a kill". No end-to-end commit was
built on it: the mutated use site must run at load and throw.

## Low

### L1. CLAUDE.md's site list says "literal" and "empty string"; neither matches the code

"literal" excludes hex, exponent, `_` and regex literals (H1). "empty
string" is carried from A16-L1: every string literal is mutated, and an
f-string is one string token (C1).

## What holds

- **SG26 per-test kills.** Duplicate test names, duplicate parametrized ids,
  todo, skip and non-strict xfail tests produce no false kill (F04, F05,
  F06, F08 `tests_insensitive`). Load failures in the plain forms are no
  kill (`audit/16/collection-error.js` a/b/c, `load-detect.js` js-a, py-d).
- **SG26 use sites.** Optional chaining, computed members, getters, default
  parameters, spread, walrus, keyword arguments and properties are all
  stopped (G01, G02, G04–G08, G10).
- **SG28.** Reporter fallback never yields a kill (R01, R02:
  `no_failed_test=1`).
- **Prior repros.** `audit/16/carried-refs.js`, `collection-error.js` and
  `snapshot-discard.js` are ok. `audit/5`, `8` and `12` e2e commit nothing.

## Repro index (`audit/20/`)

| script | what it shows |
|---|---|
| `corpus.js` | 29 JS + 25 Python witnessed semantics changes: tmpl, fstr, kwid, lit, modcall, pertest, use, pyconst, reporter |
| `run.js` | corpus end to end (worktree, real `node --test` / pytest + coverage.py, per-site mutants, per-test kills, commit); checks witness and suite on current. `--only ID,…`, `--json out`. FINDING on any commit |
| `token-sites.js` | C1, C2, H1 at unit level: `editMutants` sites for 13 one-line edits, with controls |
| `load-detect.js` | M5: `runTests` labelling of deep / wrapped load failures |
| `py-num-hint.js` | M3: Python diff-test verdict with and without the `module_nums` hint |
