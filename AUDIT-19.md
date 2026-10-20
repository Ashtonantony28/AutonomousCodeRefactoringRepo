# AUDIT-19: Test coverage and test quality, round 3

Audited commit `3a2365d` (after SG26; SG27 and SG28 not merged). The auditor did not write the code under audit.

Scope:
- coverage of the safety-critical code: `src/agents/executor.js`, `src/runner/*`, `src/validation/*`, the orchestrator's gate / reconcile / in-flight paths and `src/rl/bug-injector.js`, with the SG24–SG26 additions first (per-test kills through `tapResults` / `junitResults`, `collection_error`, use-site mutants, `revert_reference`, `unmutated_ref`, committed-snapshot discard);
- the AUDIT-11 mutation harness, extended with 25 mutants for SG24–SG26 rules;
- test reliability: `npm test` ×3, and the timing-bound tests under CPU contention.

Node v22.22.0, 4 CPUs, host load average 4–8 from other sessions during most runs. Nothing under `src/`, `test/`, `state/` or `dashboard/` was changed; mutants are applied only to temp copies outside the repo. No API calls. Scripts print `FINDING` or `ok` and exit 1 on a reproduced finding.

## Summary

| severity | count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 6 |
| Low | 4 |

- **Coverage meets the bar.** `npm run coverage`: validation 94.20%, runner 93.39%, rl 98.18%, orchestrator 94.25% lines (all ≥ 85%, unchanged from the SG26 log). `executor.js`, `hybrid-validator.js`, `diff-prep-worker.js` and `utils/hunks.js` are at 100% lines.
- **Mutation testing: 9 of 110 safety mutants survive the full suite**; 3 of them are the known AUDIT-11 leftovers (T-grace, W-readd, G-reconcile2). Of the 25 new SG24–SG26 mutants, 13 are killed. Two survivors let an edit the suite cannot judge be committed (H1, H2). All 3 controls are killed.
- **Reliability:** `npm test` passed 457/457, 456/457, 457/457. The one failure is the known timing-bound test (`executor.test.js:392`). Its sibling (`:401`) fails 1 time in 5 under 8 busy processes. Both fail closed. Under parallel load they also produce false mutant kills: the unchanged AUDIT-11 harness would have reported T-grace and W-readd as killed (M1).

### Mutation tally (`node audit/11/mutants.js`, 140 mutants)

| kind | killed | survived |
|---|---|---|
| safety | 101 | 9 (EX-sitekey, BI-default, TR-juerr, TR-dup, W-headtrailer, R-committhrow, T-grace, W-readd, G-reconcile2) |
| redundant (backed by another rule) | 8 | 8 (X-tokill, X-mutleft, HV-relax, EX-again, EX-ctrlpass, TR-pyexit, W-headdiff, W-headid) |
| label | 7 | 2 (T-covto, BI-sitecap) |
| perf | 2 | 0 |
| control | 3 | 0 |

The tally comes from three batches: ids 99–140, then 1–49 and 50–98 run in parallel. Seven kills in the parallel batches came only from timing-bound tests (see M1). Those seven were re-run alone: T-grace, W-readd and X-mutleft survived, and the other four stayed killed. The table uses the re-run results.

## Coverage of the SG24–SG26 code

Line coverage is from `npm run coverage -- --files` (all isolates). Untaken branches are from Node's lcov BRDA data (`node audit/19/branches.js`, main thread and child processes, not workers).

| file | lines | branches (Node) | untaken branches in SG24–SG26 code |
|---|---|---|---|
| `agents/executor.js` | 100% | 94.57% | `:15` revert `siteKey` never reached by an executor run (H1); `:21` `r.collection_error` arm of `failedTests` (pre-filtered at `:109`); `:116` out of budget before the control run |
| `runner/test-runner.js` | 97.86% | 88.75% | `:388`, `:429` duplicate test ids (`#2` suffix) in TAP and JUnit (M3); `:487` node `--test-reporter` already in `NODE_OPTIONS` (SG28 area) |
| `runner/reverter.js` | 92.86% | 72.92% | `:105` `committed()` throwing (M5); `:94-95` corrupt `inflight.json`; `:107`, `:113` unlink failures |
| `runner/worktree.js` | 96.84% | 87.85% | `:239` HEAD carries another issue_id; `:240` HEAD's issue matches but the file differs (both `headCommitOf`, M4) |
| `rl/bug-injector.js` | 98.72% | 87.87% | `:410` reference in a default value (H2); `:418` `#private` member; `:426` shorthand property; `:505` Python statement-position / skipped-call forms; `:570` Python use check not finishing (`unchecked`) |
| `orchestrator.js` | 94.25% | 88.51% | `:47-52` signal handler error arms; `:421` reconcile of a proposal that has an outcome (L2) |
| `validation/*` | 94.20% | — | no SG24–SG26 code; uncovered lines as at SG26 (`ast-checker` 87.33%, `polyglot-ast` 91.07%) |

---

## High

### H1. The `revert_reference` site is not pinned at the executor: a name swap the tests cannot tell apart is committed when the site is merged

**Where:** `src/agents/executor.js:15`:

```js
const siteKey = (m) => (m.revert ? `r${m.site}` : m.site);
```

SG26 requires a separate kill for putting the old name back. The `bug-injector` tests check that the revert mutant is generated (`test/executor.test.js:806`). No executor test runs one, and `:15` has an untaken branch.

**Mutant EX-sitekey** (`siteKey = m => m.site`) survives all 457 tests. With it, a kill of the use-site perturbation also counts for the revert site. For example, `s.trim()` → `s.trimStart()` with a suite that never passes trailing whitespace is committed.

**Backstop:** only partial. The gate's diff test must say `equivalent`. The executor bar exists for the diff test's blind spots.

**Repro:**
```
$ node audit/19/unpinned.js EX-sitekey
[EX-sitekey] real code:   {"status":"reverted","reason":"tests_insensitive","commit":null,"sites":2,"killed":null,"surviving_ref":"trimStart"}
[EX-sitekey] mutated copy: {"status":"passed","reason":null,"commit":"commit","sites":1,"killed":"use_site","surviving_ref":null}
[EX-sitekey] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=65 fail=0
FINDING H1 EX-sitekey: rule is load-bearing (mutated copy commits) and the tests stay green with it
$ node audit/11/mutants.js EX-sitekey
FINDING SURVIVED EX-sitekey     [safety] SG26: revert_reference mutant shares its site with the use-site perturbation (one kill covers both)  (full, 166804 ms)
```

### H2. A reference inside a default value is a use site with no test: removing that rule commits an untested default

**Where:** `src/rl/bug-injector.js:410`. The `AssignmentPattern` `right` arm makes a default value a read, not a binding. Its branch is untaken. AUDIT-16 named nested defaults as one of the binding shapes SG25 missed.

**Mutant BI-default** (`const b = noRef || bind`) survives all 457 tests. With it, an inserted `k = LIMIT` gets no use-site mutant. A kill of another token in the same hunk then keeps the edit, although no test calls `f` without `k`.

**Backstop:** partial, as in H1: the diff test, plus the deletion rule when the default replaces a deleted token.

**Repro:**
```
$ node audit/19/unpinned.js BI-default
[BI-default] real code:   {"status":"reverted","reason":"tests_insensitive","commit":null,"sites":3,"killed":null,"surviving_ref":"LIMIT"}
[BI-default] mutated copy: {"status":"passed","reason":null,"commit":"commit","sites":2,"killed":"numeric_off_by_one","surviving_ref":null}
[BI-default] tests on the mutated copy: test/bug-injector.test.js test/executor.test.js: pass=65 fail=0
FINDING H2 BI-default: rule is load-bearing (mutated copy commits) and the tests stay green with it
$ node audit/11/mutants.js BI-default
FINDING SURVIVED BI-default     [safety] SG26: a reference in a default value inside a binding pattern is not a use  (full, 164401 ms)
```

## Medium

### M1. The timing-bound mutant-budget tests fail under load and give false mutant kills

These are `test/executor.test.js:392` ("mutant runs have their own budget") and `:401` ("out of mutant budget").
- `npm test` ×3 at load 4.9–6.4: 457/457, **456/457** (`:392`: status `reverted`, `budget_exhausted`, `suite_ms` 2517 of a 4000 ms budget), 457/457.
- Both failed in both baselines of the parallel mutant batches.
- Under 8 busy processes, `:401` failed 1 time in 5.
- Once each, under full-suite load only: `diff-testing.test.js:828` (prep hard kill at 3000 ms → `inconclusive`, under `npm run coverage`), and an unnamed failure in one coverage run. Neither reproduces in isolation (`load-flaky.js` 0/5 each).

**Impact:**
- Every one of these fails closed (`mutation_budget` / `inconclusive`), so none can hide a safety regression in CI.
- They do make CI red at random. They also make a loaded mutation run report false kills: the unchanged harness reported T-grace, W-readd and X-mutleft as killed, and they survive when re-run alone.
- `audit/11/mutants.js` now retries the baseline and re-checks kills that come only from these tests.

**Repro:**
```
$ node audit/19/load-flaky.js --reps 5 --busy 8
unloaded: pass=2 failed=0 (6582 ms)
loaded run 3/5 (busy 8): pass=1 failed=1 (6948 ms)
FINDING flaky under load: 1/5 failed: out of mutant budget: reverted mutation_budget, not tests_insensitive, and not a label (AUDIT-9 C2)
```

### M2. A pytest `<error>` counts as a test failure with no test noticing (TR-juerr)

`test-runner.js:424` maps `<error>` (a fixture or setup error) to `'error'`, so it is never a kill. Mutant TR-juerr (`state = 'fail'`) survives. The `<error>` fixture in `test-runner.test.js:505` is a collection failure, which is also flagged by `load`. Impact is limited: an error raised while a module loads also carries `in <module>` and sets `load`.

Repro: `node audit/11/mutants.js TR-juerr` → `FINDING SURVIVED TR-juerr`.

### M3. Duplicate test ids are untested (TR-dup)

`test-runner.js:388` and `:429` suffix repeated ids with `#n`. Both branches are untaken, and mutant TR-dup (overwrite instead) survives. Two files with a same-named top-level test then collapse to one id. A failure in one copy can be overwritten by the other, and the set check (`executor.js:23`) cannot see one of them go missing.

Repro: `node audit/11/mutants.js TR-dup`.

### M4. `headCommitOf` trailer parsing is untested (W-headtrailer)

`worktree.js:238` takes the last `issue_id:` line, the trailer. The reasoning above it is free model text. Mutant W-headtrailer (`[0]`) survives, and `:239` and `:240` are untaken branches. With the mutant, a reasoning line that names another issue makes a committed edit read as uncommitted. Its snapshot is then restored over the commit. That is the crash-after-commit case SG25 fixed; the commit itself is kept on the branch. The `committedIssues` twin (W-trailer) is killed.

Repro: `node audit/11/mutants.js W-headtrailer`.

### M5. A throwing `committed()` check is untested (R-committhrow)

`reverter.js:105` treats a throw from `committed()` as "not committed" and restores the snapshot. Mutant R-committhrow (a throw means committed: discard the snapshot) survives. The crashed, unvalidated edit would then stay uncommitted in the worktree. If a later proposal edits the same file, its `git add -- <file>` would commit it. `headCommitOf` uses `tryGit` and does not throw in practice, so this is a defensive path.

Repro: `node audit/11/mutants.js R-committhrow`.

### M6. Untested SG26 use-site shapes

The following bug-injector branches are untaken:
- `:418` a `#private` member;
- `:426` a shorthand property `{ MAX }`;
- `:505` Python statement-position and skipped-call forms (BI-skip pins only the skip form);
- `:570` a Python use check that times out (`unchecked` → `mutation_budget`).

Each is a fail-open shape of the H2 kind. No mutant was written for each one. Adding tests for them would close the H2 class.

## Low

- **L1. Harness drift.** At `3a2365d` the AUDIT-11 W-trailer pattern (`.filter(Boolean).pop();`) matches twice in `worktree.js` since SG25 added `headCommitOf`. The harness therefore reported W-trailer as `pattern` and never ran it. It is re-anchored now and killed. `node audit/11/mutants.js --check` (new) verifies that every pattern matches once: 140/140.
- **L2. Carried from AUDIT-11 (no change):**
  - T-grace (M2 there): the 1.5 s hard bound after the timeout kill;
  - W-readd (M5 there): effectively equivalent, because the HEAD check at `worktree.js:192` still throws;
  - G-reconcile2 (L1 there): `orchestrator.js:421`, reconcile overwriting an existing outcome.
  All three survive when run alone.
- **L3. Label mutants survive:**
  - T-covto: a coverage-json overrun is reported as `edit_not_exercised` instead of `coverage_timeout`. Both are untested outcomes, so no sample is affected.
  - BI-sitecap: use sites are not counted toward the 12-site cap. The only effect is more mutant runs.
- **L4. Redundant survivors, checked to be backed:**
  - EX-again and EX-ctrlpass: the per-test intersection and `control.status === 'passed'`;
  - TR-pyexit: exit 2–5 runs have no per-test failure or a changed test set;
  - W-headdiff and W-headid: issue_ids are unique per session and a reconciled proposal is never re-executed. Each check backs the other.

## Repro index (`audit/19/`, plus `audit/11/mutants.js`)

| command | checks | result at `3a2365d` |
|---|---|---|
| `node audit/19/unpinned.js [EX-sitekey] [BI-default]` | H1, H2: real executor reverts; the mutated copy commits; the executor and bug-injector tests stay green | FINDING ×2 |
| `node audit/19/load-flaky.js [--reps 5] [--busy 8] [--file f] [--pattern re]` | M1: timing-bound tests under CPU contention | FINDING (1/5) |
| `node audit/19/branches.js [--json out]` | untaken branches per safety file (Node lcov) | ok (listing) |
| `node audit/11/mutants.js --check` | every mutant pattern matches exactly once | ok, 140 |
| `node audit/11/mutants.js <ids>` | survivors above; new ids `EX-*`, `TR-*`, `BI-revkey/default/pyattr/sitecap`, `W-head*`, `R-committhrow`, `O-committed` | FINDING (9 safety) |

Changes to `audit/11/mutants.js`:
- 25 mutants added;
- W-trailer re-anchored;
- `--check` added;
- baseline retried up to 3 times, with the failing test names printed;
- a kill that comes only from a known timing-bound test is re-checked once on the full suite.
