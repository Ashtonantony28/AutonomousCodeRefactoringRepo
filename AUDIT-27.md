# AUDIT-27: Validation soundness, round 10 (no false negatives)

Audited commit `ce63bc7` (SG33 caught-load keys, SG34 same-text mutant
switch + structural-token rule + literal fixes, SG35 hoisted switch binding).
The auditor did not write the code under audit. Every repro uses the repo's
stub client and a temp `REFACTOR_STATE_DIR` (via `audit/1/lib.js` and
`audit/5/lib.js`). None call the live API. None touch `src/`, `test/`,
`state/` or `dashboard/`. Scripts run from the repo root, print `FINDING` or
`ok`, and exit 1 on a reproduced finding.

The critic in every end-to-end scenario is **unanimous**: 3/3 approve,
`p_preserves` 0.9, no `edge_cases`. `audit/27/run.js` checks each corpus entry
with a real `node` / `python3` witness and runs its suite on the current
version: 0 `BADWITNESS`, 0 `BADSUITE`.

## Summary

**Prior repros.**

| repro | result | expected / classification |
|---|---|---|
| `node audit/23/run.js` (full) | 5 of 41: F01 F02 G01 G03 G04 | SG34 subset 0: holds. Remaining are A23-M2 (range past diff-test lengths) and A23-M4 (default value on its string site) |
| `node audit/21/run.js` | 2 of 42: T02, T07 | holds (string / f-string part is one site, README) |
| `node audit/20/run.js` | 1 of 54: D09 | holds (string site, README) |
| `node audit/16/run.js` | 3 of 52: N12, N15, N18 | holds (deletions `obs=true`; N18 killed on the changed token) |
| `node audit/13/run.js` | 6 of 81: T02 D02 U05 G12 P03 P01 | ≤ 6: holds (pure deletions `obs=true`, README blind spots) |
| `audit/5`, `audit/8`, `audit/12` `e2e-commit.js` | 0 committed | holds |
| `node audit/23/token-sites.js` | ok | holds |
| `node audit/12/executor-benign.js` | 8 of 18 rejected (B02 B03 B06 B07 B10 B12 B13 B14) | unchanged (M3) |

**Fresh corpus** (`audit/27/corpus.js`): 41 witnessed semantics changes (22
JS, 19 Python), none of them shapes from earlier corpora. 33 reached the
executor; **18 were committed**, every one with an `equivalent` diff test.

| category | committed | |
|---|---|---|
| nan (numeric token keyed as NaN) | 4/5 | C1 |
| inside (bracket / indent covered by a sibling inside it) | 9/10 | H1 |
| sep (`;` / `,` carry the change) | 5/6 | H2 |
| lit (value-changing respellings, controls) | 0/5 | holds |
| own (no-mutant token next to its own operand, controls) | 0/4 | holds |
| sw (SG34/SG35 switch placement, controls) | 0/11 | holds |

| severity | count |
|---|---|
| Critical | 1 |
| High | 2 |
| Medium | 4 |
| Low | 1 |

---

## Critical

### C1. A numeric token that is not a plain number is keyed as NaN: a changed value reads as a respelling

**Affected code.** `src/utils/hunks.js` `valueKey`. `NUM` matches
`(?:\d|\.\d)(?:[\w.]|(?<=\d[eE])[+-])*`, so it also takes `0x1e+6000` (hex
`0x1e`, then `+ 6000`: the lookbehind sees `1e`), `6e3.toFixed` and
`6e3.real`. `Number()` of each is `NaN` (no throw), so every such token gets
the key `\u0005NaN` (Python `\u0005NaN.0`). Two different values compare equal
and the token is no change: no range, no site, no fail-closed check.

**Rule as written (CLAUDE.md):** "a literal respelled to the same value
(`'a'` → `"a"`, `120` → `0x78`) is no change". These are different values.
Alone, the edit has no hunk and ends `tests_insensitive`. With any killable
change in the same edit (here a constant read `SUFFIX` on the next line), the
hunk stands on that kill and the value change is committed.

**Repro:** `node audit/27/run.js --only N01,N02,N03,N04` and
`node audit/27/token-sites.js`.
```
N01 COMMITTED passed dt=equivalent(runs=84 obs=true) mut(h=1 sites=1 mutants=1 run=3 killed=use_site@5 by="cap")
    - const out = String(s).slice(0, 0x1e+6000); | + const out = String(s).slice(0, 0x2e+6000);   (6030 -> 6046)
N02 COMMITTED ... killed=use_site@5   +6e3.toFixed() -> +7e3.toFixed()
N03 COMMITTED ... killed=use_site@5   int(6e3.real) -> int(7e3.real)            (Python)
N04 COMMITTED ... killed=use_site@5   str(s)[:0x1e+6000] -> str(s)[:0x3e+6000]   (Python)
token-sites.js:
FINDING nan JS 0x1e+6000 -> 0x2e+6000 (N01)   hunks=1 inserted=["SUFFIX"]  judged on ["use_site(SUFFIX):SUFFIX"]
FINDING nan JS 6e3.toFixed -> 7e3.toFixed     hunks=0 inserted=[]
ok      control: 6000 -> 7000                 hunks=1 inserted=["7000"]
```
N05 (array cap, same token shape) stopped only because its sibling
(`.concat(EXTRA)`) survived.

**Expected:** `valueKey` keys a number only when the whole token is a valid
numeric literal of the language (else its text), and the token regex stops a
hex literal before `+` / `-`.

---

## High

### H1. A structural bracket or re-indented line is covered by any sibling site inside it

**Affected code.** `src/rl/bug-injector.js` `uncoveredToken`: a bracket that
frames kept code, or a re-indented line, is ok when `inside(o, c + 1)` /
`inside(a, le)` finds any site span inside the pair or line. SG34 closed
A23-H1 for siblings outside the structure; a sibling inside it still carries
the hunk. In the corpus the sibling is an identity (`+ ''`) or a constant
extracted from a literal (`4096` → `LIMIT`, `'NFKC'` → `FORM`, a translate
table → `ZW`). Its kill says nothing about the block's extent or the operand's
scope.

**Why High:** the rule is enforced as written (CLAUDE.md: "needs a site span
inside that bracket pair or line"), but the evidence is a kill of an
unrelated token, and the scope change is committed.

**Repro:** `node audit/27/run.js --only X01,X02,X03,X04,X06,X07,X08,X09,X10`
and `node audit/27/token-sites.js`.
```
X01 COMMITTED ... mut(h=1 sites=2 mutants=2 run=6 killed=string_literal@5 by="clean")
    + if (out.length > 4096) { out = out.slice(0, 4096); | + out = out.normalize('NFC') + ''; }   clean('é').length 1 -> 2
X02 COMMITTED ... killed=use_site@5    same move, sibling slice(0, LIMIT) inside the braces
X03 COMMITTED ... killed=string_literal@3   (String(p) + String(s) + '').normalize('NFC')        prefix normalised too
X07 COMMITTED ... killed=use_site@9    NFKC indented into the cap block, 'NFKC' -> FORM           m.clip('Ａ') 'A' -> 'Ａ'
X08 COMMITTED ... killed=use_site@7    zero-width strip indented into the cap block, table -> ZW
token-sites.js:
FINDING inside JS braces + identity (X01)   change carried by ["{","}"]; hunk judged only on ["swap_arith:+","string_literal:''"]
ok      control: braces with no sibling inside   uncovered="{"
```
X05 stopped (its `ZW` sibling survived).

**Expected:** a bracket pair or line whose structure changed is covered only
by evidence that the structure matters (the diff test observing the moved
code, or a mutant that undoes the structural change), not by a sibling site.

### H2. A semicolon or comma that changes control flow or type has no mutant; the hunk stands on a sibling

**Affected code.** `uncoveredToken` skips `SEP` (`,` `;` `:`), and no
`EDIT_OPS` operator matches them. An inserted `;` after `if (c)` / `else`
makes an empty statement (the next statement always runs); a Python `;`
joins a line into a one-line `if` suite; a Python trailing comma makes a
tuple. With a sibling site in the same hunk the edit is committed on the
sibling's kill.

**Why High:** CLAUDE.md exempts commas and semicolons ("every inserted or
changed token except brackets, commas, semicolons, colons …"), so the rule is
enforced as written; the evidence is unrelated to the token that changes
behaviour.

**Repro:** `node audit/27/run.js --only Q01,Q02,Q03,Q04,Q05`.
```
Q01 COMMITTED ... killed=string_literal@5 by="show"
    + if (out.includes('​')); out = out.normalize('NFKC'); | + return out + '';     show('Ａ') 'Ａ' -> 'A'
Q02 COMMITTED ... killed=string_literal@6   else; out = out.normalize('NFKC');           fit('Ａ'x6001)[0] 'Ａ' -> 'A'
Q03 COMMITTED ... killed=use_site@6         if (out.length > 6000); out = out.replace(/​/g, '')
Q04 COMMITTED ... killed=string_literal@5   s = s[:6000],   (tuple; head('a'*7000) -> TypeError)   (Python)
Q05 COMMITTED ... killed=string_literal@6   if chr(8203) in s: ...; s = unicodedata.normalize('NFKC', s)  (Python)
token-sites.js:
FINDING sep JS `if (c);` (Q01)   change carried by [";"]; hunk judged only on ["swap_arith:+","string_literal:''"]
ok      control: `if (c);` alone   (no site: bare hunk, tests_insensitive)
```
Q06 (trailing comma on a list cap) is vetoed by the diff test.

**Expected:** an inserted `;` that ends an `if` / `else` / loop head, or that
joins a statement into a suite, and an inserted comma that creates a tuple or
sequence expression, are structural tokens (no evidence unless observed), as
brackets are.

---

## Medium

### M1. Carried commits re-verified (README "Known limits")

- audit/23 G01 G03 G04 (A23-M2, range past diff-test lengths, killed on the
  inserted `-`) and F01 F02 (A23-M4, `=` on its string site).
- audit/21 T02 T07, audit/20 D09: string / f-string part is one site.
- audit/16 N12 N15 N18, audit/13 T02 D02 U05 G12 P03 P01: deletions with
  `obs=true`, each a README blind spot (N18 killed on the changed token).

### M2. CRLF backslash continuations are mis-lexed (fail closed)

`lexView` skips one character after `\`, so `\` + CRLF ends a JS or Python
string at the `\n`; the next line's closing quote opens a pseudo-literal that
holds the inserted code. SG34's "a quote that starts no string" / uncovered
bracket rule stops all four shapes (`uncovered_token`), so nothing commits;
the edit is over-rejected. `node audit/27/token-sites.js`, rows `crlf …`: ok.

### M3. Over-rejection (carried)

`audit/12/executor-benign.js` rejects 8 of 18 (B02 B03 B06 B07 B10 B12 B13
B14), as at a5df527.

### M4. Controls that stopped (holds)

- **lit:** int → float (`6000` → `6e3`), BigInt → Number, legacy octal
  `010` → `10`, str → bytes, float → int: all changes (L01–L03
  `tests_insensitive`, L04 not exercised, L05 vetoed).
- **own:** `void` (O01 `uncovered_token=void`), spread, walrus (vetoed),
  `lambda` (not exercised).
- **sw:** generator, async, arrow concise body, getter, default parameter,
  decorated class, docstring module, braceless `if`/`else` statement: the
  switch placement produced no spurious kill (W02–W11 all
  `tests_insensitive` or vetoed); W01 (class-body comprehension) gets
  `critic_rejected` (diff test ran no input).

## Low

### L1. Docs drift

- `hunks.js` header and CLAUDE.md: "a literal respelled to the same value is
  no change": tokens keyed as NaN compare equal across different values (C1).
- CLAUDE.md: "any other string (backslash-continued ones too) is exactly one
  `lexView` literal": not for `\` + CRLF (M2).
- README "Fail closed per token": "A bracket or indentation that changes
  structure … needs a kill inside that bracket pair or line": any sibling
  kill inside satisfies it (H1); commas and semicolons that change structure
  are not mentioned (H2).

## Open

- Observation channels other than the mutated value (anything a test can
  read that differs between switch-on and switch-off runs besides the
  value itself) were not examined in this round.

## Repro index (`audit/27/`)

| script | what it shows |
|---|---|
| `corpus.js` | 22 JS + 19 Python witnessed semantics changes: nan, inside, sep, lit, own, sw |
| `run.js` | corpus end to end (worktree, real `node --test` / pytest + coverage.py, switch mutants with per-test kills, commit). `--only ID,…`, `--json out`. FINDING on any commit |
| `token-sites.js` | C1, H1, H2 and M2 at unit level: what `changeHunks` marks changed and what `editMutants` asks the suite to kill, with controls |
