# AUDIT-23: Validation soundness, round 9 (no false negatives)

Audited commit `a5df527` (SG31: whole-file `lexView` per hunk, operator and
keyword sites, fail closed on every non-punctuation token, space + non-space
sham, diff-test boundary inputs; SG32). The auditor did not write the code
under audit. Every repro uses the repo's stub client and a temp
`REFACTOR_STATE_DIR` (via `test/helpers/env.js`, through `audit/1/lib.js` and
`audit/5/lib.js`). None call the live API. None touch `src/`, `test/`,
`state/` or `dashboard/`. Scripts run from the repo root, print `FINDING` or
`ok`, and exit 1 on a reproduced finding.

The critic in every end-to-end scenario is **unanimous**: 3/3 approve,
`p_preserves` 0.9, no `edge_cases`. `audit/23/run.js` checks each corpus entry
with a real `node` / `python3` witness (the edit changes observable behaviour)
and runs its suite on the **current** version (it passes): 0 `BADWITNESS`,
0 `BADSUITE`.

## Summary

**Prior repros.**

| repro | result | expected |
|---|---|---|
| `node audit/21/run.js` | 2 of 42 committed: T02, T07 (M1) | SG31 subset 0: holds (T01 now vetoed) |
| `node audit/20/run.js` | 1 of 54: D09 | D09 only: holds |
| `node audit/16/run.js` | 3 of 52: N12, N15, N18 | holds |
| `node audit/13/run.js` | 6 of 81: T02 D02 U05 G12 P03 P01 (D03, U02 now vetoed) | ≤ 8: holds |
| `audit/5`, `audit/8`, `audit/12` `e2e-commit.js` | 0 committed | holds |
| `audit/21/token-sites.js`, `audit/21/lex-hang.js` | ok, ok | holds |
| `audit/12/executor-benign.js` | 8 of 18 rejected (was 10) | M6 |

**Fresh corpus.** 41 witnessed semantics changes (22 JS, 19 Python), none of
them shapes from `audit/{5,8,12,13,16,20,21}`. Most change behaviour only on
inputs the diff test never builds (decomposed / compatibility characters,
zero-width, NBSP, CR, NaN, strings past 5,000 or arrays past 2,000), so the
diff test reads `equivalent` and the **executor bar decides**: 32 reached the
executor with an `equivalent` diff test, and **26 were committed**.

| category | committed | |
|---|---|---|
| cont (backslash-continued string) | 5/6 | C1 |
| punct (braces / parens carry the change) | 7/9 | H1 |
| indent (Python indentation carries the change) | 4/7 | H1 |
| sham (source-reading budget tests) | 4/6 | H2 (S01 S02), M3 (S03 S05) |
| wrap (no-mutant token in a wrapper's span) | 1/3 | H3 |
| bound (`=` after a default value) | 2/3 | M4 |
| range (past diff-test lengths) | 3/5 | M2 |
| slide | 0/2 | vetoed by the diff test (M5) |

Executor-only soundness: of the 32 entries the diff test passed, the executor
stopped 6 (I05 W02 W03 S04 S06 G05), all of them controls or fail-closed
shapes. It committed every other one.

| severity | count |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 6 |
| Low | 1 |

---

## Critical

### C1. A backslash-continued string hides inserted reads: the code after the closing quote is one "string" token, and its names get no use site

**Affected code.** `src/utils/hunks.js`:
- `tokensOf` looks up only template, f-string and regex literals (`v.at`).
  Plain strings go through `JS_TOKEN` / `PY_TOKEN`.
- `'(?:[^'\\\n]|\\.)*'` does not follow `\` + newline (`.` excludes `\n`).
  So the token regex never matches a continued string such as
  `'ID:\` + newline + `'`.
- On the next line, the closing quote opens a new match that runs to the
  next quote on the line. In `' + String(s).normalize('NFKC'));`, the text
  `' + String(s).normalize('` becomes one token.

`lexView` itself has the literal right: it follows the backslash. So the
token list and the lexer disagree. In `editMutants`, the names inside the
pseudo-token are not tokens, so `insertedNames` never sees them and they get
no use site. The operator matches inside the token (the **unchanged** `+`,
the `'NFKC'` string) have the token's start as their site. One kill at that
site covers the token. The token's span is covered by the use site of the
moved helper `up(…)`.

**Rule as written (CLAUDE.md, Use sites):** "Every inserted identifier or
member the edit reads … is a site of the hunk too … one mutant perturbs the
value where the edit uses it". Also: "Tokens come from a whole-file
`utils/hunks.lexView` mapped to the changed lines". The control shows the rule
working when the same edit is on one line: `normalize` and `String` are
tokens, and the edit is stopped with `unmutated_ref`.

**Repro:** `node audit/23/run.js --only C01,C02,C03,C05,C06` and
`node audit/23/token-sites.js`.
```
C01 COMMITTED passed dt=equivalent(runs=76 obs=true) mut(h=1 sites=2 mutants=3 run=6 killed=swap_arith@5 by="badge")
    -  return 'ID:\ | -' + up(s); | +  return up('ID:\ | +' + String(s).normalize('NFKC'));     witness "ID:Ｆ" -> "ID:F"
C02 COMMITTED ... sites=3 run=9 killed=swap_arith@10   + unicodedata.normalize('NFKC', str(s)) + ''   (Python)   'ID:Ｆ' -> 'ID:F'
C03 COMMITTED ... sites=2 run=6 killed=swap_arith@5    + String(s).replace(/​/g, '')               "ID:A​B" -> "ID:AB"
C05 COMMITTED ... sites=2 run=6 killed=swap_arith@5    + String(s).replace(/ /g, ' ')              NBSP kept -> replaced
C06 COMMITTED ... sites=2 run=6 killed=swap_arith@5    + String(s).normalize('NFC')                     length 5 -> 4

token-sites.js:
FINDING cont JS continued string (C01)  inserted=["up","(","' + String(s).normalize('","NFKC",")"]
        inserted read `normalize` has no use site; mutants ["use_site@\"up('ID:\\\\\"","swap_arith@\"' + Stri\"","string_literal@\"' + Stri\""]
FINDING cont Py continued string (C02)  inserted=["up","(","' + unicodedata.normalize('","NFKC","', str(s)) + '"]  inserted read `normalize` has no use site
ok      control: C01 on one line         inserted=["up","(","String",".","normalize","(","'NFKC'",")",")"] unmutated_ref=String
```
Here `swap_arith` is `+` → `-` on the `+` that was already in the current
code. C04 (Python, with a `'​'` literal) is vetoed: the diff test mines
the literal.

**Expected:** `tokensOf` takes string literals from `lexView` (as it already
does for templates). Failing that, any token that starts with a quote but is
not a `lexView` literal is no evidence.

---

## High

### H1. Braces, parentheses and Python indentation carry the change and need no coverage; the hunk stands on a sibling's kill

**Affected code.** `bug-injector.js` `uncoveredToken` skips `PUNCT`
(`()[]{},;:`) and any token whose text is blank. That includes the Python
indentation token `hunks.tokensOf` emits per line. No `EDIT_OPS` operator
matches these tokens. So an edit that only moves a brace, a parenthesis or an
indentation level adds nothing to judge. With one other changed token in the
same hunk (a re-quoted string, a respelled number), it is judged on that
token's kill alone.

Shapes that commit:
- A statement moved into an `if` body with `{ … }` (P01, P02, P04).
- A method's receiver widened with `( … )` (P03, P09; Python P05, P08).
- A Python statement indented into an `if` / `except` block (I01, I03, I06,
  I07).

The kill is `"NFC"` → `"NFCx"` (a `RangeError`), `120` → `121` or `"-"` →
`"-x"`: never the scope change.

**Why High:** each kill is on a token unrelated to what changed behaviour
(the block or the scope). CLAUDE.md exempts brackets and whitespace from the
fail-closed rule, so the rule is enforced as written. But "every site needs
its own kill" says nothing about the structure that carries these edits.

**Repro:** `node audit/23/run.js --only P01,P02,P03,P04,P05,P08,P09,I01,I03,I06,I07`
and `node audit/23/token-sites.js`.
```
P01 COMMITTED passed dt=equivalent(runs=74 obs=true) mut(h=1 sites=1 mutants=1 run=3 killed=string_literal@5 by="clean")
    -  if (out.length > 4096) out = out.slice(0, 4096); | -  out = out.normalize('NFC');
    +  if (out.length > 4096) { out = out.slice(0, 4096); | +  out = out.normalize("NFC"); }       witness clean('é').length 1 -> 2
P04 COMMITTED ... killed=numeric_off_by_one@4 (0x78)   NBSP replacement moved into `if (len > 120) { … }`
P03 COMMITTED ... killed=string_literal@3   String(prefix) + String(s).normalize('NFC') -> (String(prefix) + String(s)).normalize("NFC")
P05 COMMITTED ... killed=string_literal@4   normalize('NFC', str(prefix)) + str(s) -> normalize("NFC", str(prefix) + str(s))
I01 COMMITTED ... killed=string_literal@7   -    out = unicodedata.normalize('NFC', out) | +        out = unicodedata.normalize("NFC", out)
I07 COMMITTED ... killed=numeric_off_by_one@4   out[:4096] -> out[:0x1000]; replace(chr(8203), '') indented into the cap block
token-sites.js:
FINDING punct JS braces (P01)   inserted=["{","\"NFC\"","}"]   change carried by ["{","}"] (no mutant); hunk judged on [string_literal]
FINDING indent Py block (I01)   inserted=["        ","\"NFC\""]   change carried by ["        "] (no mutant)
```
P06 (`assert c, msg` → `assert (c, msg)`), P07, I02 and I04 are vetoed: the
diff test mines their `'​'` / `'\r'` literals. I05 is stopped: the moved
line is a separate insertion whose `replace` use site survives.

**Expected:** a hunk whose inserted or deleted tokens include a bracket,
brace or indentation change that alters statement or expression structure
(a block's extent, an operand's scope) is no evidence unless the diff test
observed the moved code. A cheaper fix: a re-quoted string or a respelled
number is no site at all (it has no behavioural change to kill), so such a
hunk ends `tests_insensitive`.

### H2. A word-count (token) size budget kills use-site mutants; the sham passes it

**Affected code.** `executor.js` `mutationEvidence` uses `m.sham` as the
control. `bug-injector.js` `shamOf` wraps the site in parentheses. Past 16
characters it uses one long number (`(10…0, x)`), plus spaces.
`JS_PERTURB` / `PY_PERTURB` add about 60 words. The sham adds one (the
number). A test that bounds the number of `\w+` tokens in `src/` fails on
every use-site mutant and passes the sham, so the kill counts. In S01 and
S02, the cap's `SKIP` and `MAX_LEN` use sites are "killed" only by that test.

**Why High:** the kill comes from the source's size, not from the value at
the use site. README: "Sham control covers size only … it stops tests that
read source length, length without whitespace, or layout." A token count is a
size. The controls show the sham works for a whitespace-stripped length:
S04 and S06 are stopped with `sham_failed=1`.

**Repro:** `node audit/23/run.js --only S01,S02,S04,S06`
```
S01 COMMITTED passed dt=equivalent(runs=66) mut(h=1 sites=3 mutants=3 run=9 killed=use_site@5 by="size: src/ stays within its token budget")
    -  return String(s).slice(SKIP); | +  return String(s).slice(SKIP, SKIP + MAX_LEN);   (MAX_LEN = 10000)   witness 20000 -> 10000
S02 COMMITTED ... killed=use_site@5 by="tests.test_size::test_token_budget"    str(s)[SKIP:] -> str(s)[SKIP:SKIP + MAX_LEN]
S04 stopped   reverted(tests_insensitive) ... surviving_ref=SKIP sham_failed=1   (control: whitespace-stripped length)
S06 stopped   reverted(tests_insensitive) ... surviving_ref=SKIP sham_failed=1
```
**Expected:** a kill counts only from a test that executed the mutated use
site (per-test coverage of the mutant line), or a sham that adds the
perturbation's own text where it cannot run (the same text in a dead branch).

### H3. A token with no mutant (`typeof`) is covered by an unrelated wrapper's use-site span

**Affected code.** `uncoveredToken`: a token is covered when it lies inside
the span of any site's mutants. For a use-site mutant, that span is the whole
perturbed expression. A wrapper call moved outward (`.toUpperCase()` around
the whole expression) has a use site whose span holds every token of the new
inner code. One of them is `typeof`, which README lists as a shape with no
mutant that "is rejected, not carried". The wrapper's kill (lower-case
output) says nothing about `typeof`.

**Why High:** the rule is enforced as written (CLAUDE.md: "must lie inside
the span every mutant of one site changes (… the expression a use-site
mutant perturbs)"). But the evidence for `typeof` is the wrapper's kill. The
deleted `Number.isFinite` is judged only by the diff test, which never builds
NaN or Infinity. W03, the same change inside a plain helper, and W02, a
comprehension `if`, are stopped (`uncovered_token`): the helper call was not
an inserted token there.

**Repro:** `node audit/23/run.js --only W01,W02,W03` and
`node audit/23/token-sites.js`.
```
W01 COMMITTED passed dt=equivalent(runs=92 obs=true) mut(h=1 sites=7 mutants=7 run=21 killed=use_site@3 by="kind")
    -  return 'KIND:' + (Number.isFinite(x) ? 'NUM' : 'OTHER');
    +  return ('kind:' + (typeof x === 'number' ? 'num' : 'other')).toUpperCase();      witness kind(NaN) "KIND:OTHER" -> "KIND:NUM"
token-sites.js:
FINDING wrap JS typeof in toUpperCase span (W01)  `typeof` has no mutant; covered only by ["use_site(toUpperCase)"]
ok      control: typeof without the wrapper        uncovered="typeof"
```
**Expected:** a token with no mutant of its own is covered only by a
use-site mutant of a name **inside** that token's own expression (an operand
it applies to), never by an enclosing wrapper's use site.

---

## Medium

### M1. Carried commits re-verified (README "Known limits")

- **audit/21 T02** (`!r` → `!a`) and **T07** (`rb'\t'` → `rb'\t+'`): an
  f-string text part or string is one site (README). T01 is now vetoed.
- **audit/20 D09:** string site (README).
- **audit/16 N12, N15, N18:** deletions with `obs=true`, and N18's `<=` →
  `!=` past 2\*\*53 killed on the changed token.
- **audit/13 T02 D02 U05 G12 P03 P01:** pure deletions with `obs=true` that
  each match a README blind spot. D03 and U02 are now vetoed (the 150-element
  list and the 5,000-character string are tried).

### M2. Range changes past the lengths the diff test tries

- **G01:** `slice(0, 10000)` → `slice(-10000)`.
- **G03:** array `slice(0, 3000)` → `slice(-3000)`.
- **G04:** Python `[:8000]` → `[-8000:]`.

Each stands on its inserted `-` (`swap_arith` → `+`, killed on short
inputs). README documents this ("a range change … stands on the executor bar
only if the diff test misses it"). The diff test forces strings up to 5,000
characters and arrays up to 2,000. G02 (a Python list `[:200]`) is vetoed.
`node audit/23/run.js --only G01,G03,G04`: all COMMITTED, `killed=swap_arith`.

### M3. Branch-count complexity budgets kill use-site mutants (README: grep, no sham)

- **S03:** counts `?` / `&&` / `||` in `src/`.
- **S05:** counts `if` / `and` / `or` in `app/`.

The perturbation text is full of both. README: "A test that greps the source
for a name or a character … has no sham."
`node audit/23/run.js --only S03,S05`: both COMMITTED
(`by="complexity: src/ branch budget"`, `tests.test_size::test_branch_budget`).

### M4. An added default value stands on its string site

- **F01:** `form` → `form = 'NFKC'`.
- **F02:** `form=None` → `form='NFKC'`.

The kill is `'NFKC'` → `'NFKCx'` (a throw on any call without `form`). `=`
stands on that string, as CLAUDE.md says. The kill is on the changed token,
and README documents a string as one site.
`node audit/23/run.js --only F01,F02`: both COMMITTED (`killed=string_literal`).

### M5. A slid insertion's use site perturbs the old argument (unit level, no commit)

`lastIndexOf(String(t))` → `lastIndexOf(String(t), String(t))`: the slide
puts the inserted run at the left, so `String(t),` is argument 0. The
use-site mutants perturb the argument that was already there, never the new
`fromIndex`. `node audit/23/token-sites.js`, row `slide JS duplicated argument
(H01)`: FINDING. End to end, H01 and H02 are vetoed by the diff test.

### M6. Over-rejection (carried)

- `audit/12/executor-benign.js` rejects 8 of 18 (B02 B03 B06 B07 B10 B12 B13
  B14).
  - B07 (`loop → some()`) and B14 (`clamp`) are now vetoed: the diff test
    finds outputs that differ on `""` / `null`. Those inputs are outside the
    suite's domain.
- Fail-closed stops in this corpus are all correct:
  - W02 and W03: `uncovered_token`.
  - G05: `unmutated_ref=slice`.
  - I05: `surviving_ref=replace`.

## Low

### L1. Docs drift

- **CLAUDE.md** says "a line inside or closing a multi-line template /
  triple-quoted string gets the literal's tokens". Single-quoted strings
  continued with a backslash are not lexed that way (C1).
- **README** "Fail closed per token" lists `typeof` as rejected. It is
  admitted inside an enclosing use site's span (H3). The same section's
  exemption for "punctuation and whitespace" covers block and scope changes
  (H1).
- **README** "Sham control" says it stops tests that "read source length".
  A token-count length is not stopped (H2).
- **PLAN** SG31 log says `executor-benign` rejects 10/18. It now rejects 8/18.

## What holds

- **SG31 subset.** `audit/21` M01–M08, O01–O14 and S01/S02/S06 commit 0.
  `token-sites.js` and `lex-hang.js` are ok.
- **Sham.** It stops whitespace-stripped length budgets (S04, S06).
- **Fail closed.**
  - `typeof` and a comprehension `if` with no enclosing inserted use site
    are rejected (W02, W03).
  - A name replaced inside changed code is rejected (G05).
- **Diff test.** It mines literal special characters (`'​'`, `'\r'`).
  So P06, P07, I02, I04 and C04 are vetoed, and so are the `let` → `var`
  closure change (F03), the 200-element list cap (G02) and both slides.

## Repro index (`audit/23/`)

| script | what it shows |
|---|---|
| `corpus.js` | 22 JS + 19 Python witnessed semantics changes: punct, indent, cont, wrap, sham, bound, range, slide |
| `run.js` | corpus end to end (worktree, real `node --test` / pytest + coverage.py, per-site mutants with sham controls, per-test kills, commit). Checks each witness, and the suite on the current version. `--only ID,…`, `--json out`. FINDING on any commit |
| `token-sites.js` | C1, H1, H3 and M5 at unit level: which tokens carry the change and which mutants `editMutants` asks the suite to kill, with controls |
