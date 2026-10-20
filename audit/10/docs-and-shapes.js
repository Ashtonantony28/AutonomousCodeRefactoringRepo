'use strict';

// AUDIT-10 Low findings: shapes and docs after SG14-SG18. Each check prints
// FINDING or ok.
//
//   node audit/10/docs-and-shapes.js

const { makeRepo, noTestCtx, quiet, report, exitCode } = require('./lib');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseCounts } = require('../../src/runner/test-runner');
const { runExecutor } = require('../../src/agents/executor');
const { SHAPES } = require('../../src/contracts');

const ROOT = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  // L1: node:test (the fixtures' runner) prints TAP counts that parseCounts does not read.
  {
    const tap = '# tests 2\n# suites 0\n# pass 1\n# fail 1\n# cancelled 0\n';
    const c = parseCounts(tap, 'npm');
    report('L1 passed_tests / failed_tests are 0 for node:test output',
      c.passed === 1 && c.failed === 1,
      `parseCounts("# pass 1 / # fail 1") = ${JSON.stringify(c)}; a red node:test suite is reported as failed_tests=0 in TestOutcome, the dashboard and the Reflexion prompt ("failed_tests: 0")`,
      'parse the TAP "# pass N" / "# fail N" summary (node:test, tap)');
  }

  // L2: `tests_insensitive` is also the reason when no mutant ran at all.
  {
    const cur = 'function area(w, h) {\n  const product = w * h;\n  return product;\n}';
    const nxt = 'function area(w, h) {\n  const size = w * h;\n  return size;\n}';
    const src = `'use strict';\n${cur}\nmodule.exports = { area };\n`;
    const repo = makeRepo({
      'src/area.js': src,
      'test/area.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { area } = require('../src/area');\ntest('area', () => assert.strictEqual(area(2, 3), 6));\n"
    }, { pkg: { name: 'a10l', version: '0.0.0', private: true, scripts: { test: 'node --test test/area.test.js' } } });
    const out = await quiet(() => noTestCtx(() => runExecutor({
      proposal: { issue_id: 'ren', file: 'src/area.js', current_code: cur, proposed_code: nxt,
        diff_test: { applicable: true, verdict: 'equivalent', runs: 20, duration_ms: 1 } },
      repoRoot: repo
    })));
    const m = out.mutation || {};
    console.log(`   rename edit: status=${out.status} reason=${out.reason} mutation=${JSON.stringify({ hunks: m.hunks, mutants: m.mutants, run: m.run, unmutated_hunk_line: m.unmutated_hunk_line })}`);
    report('L2 `tests_insensitive` is recorded when no mutant was generated or run',
      !(out.reason === 'tests_insensitive' && m.run === 0),
      `reason=tests_insensitive with ${m.mutants} mutants and ${m.run} suite runs; the same code is used for budget_exhausted and for a mutationEvidence exception`,
      'distinct reason codes (e.g. no_mutant, mutation_budget, mutation_error) for "nothing could be tested" vs "a mutant survived"; all in UNTESTED_REASONS');
  }

  // L3: contracts and the CLAUDE.md shapes lag the fields SG14-SG18 made load-bearing.
  {
    const claude = read('CLAUDE.md');
    const gaps = [];
    if (!SHAPES.Sample.some(k => k.startsWith('edit_id'))) gaps.push('Sample contract: no `edit_id` (the de-duplication key of samples and calibration points since SG17; CLAUDE.md documents it)');
    if (!SHAPES.DiffTest.some(k => k.startsWith('deletions_observed'))) gaps.push('DiffTest contract: no `deletions_observed` (read by the executor commit bar, M4)');
    if (!SHAPES.Proposal.some(k => k.startsWith('validated_region'))) gaps.push('Proposal contract: no `validated_region` (required by the executor; AUDIT-7 L6)');
    if (SHAPES.TestOutcome.join() === 'status,...') gaps.push('TestOutcome contract: still {status, ...}: `reason` (read by isLabeled), `coverage{exercised,functions,functions_missed,duration_ms,...}`, `mutation{hunks,mutants,run,killed,ok,...}`, `commit` have no shape');
    if (!/edit_id/.test(claude.split('### Proposal shape')[1].split('---')[0]) && !/validated_region/.test(claude)) gaps.push('CLAUDE.md Proposal shape: no validated_region, diff_test, veto; TestOutcome fields undocumented');
    for (const g of gaps) console.log(`   - ${g}`);
    report('L3 contracts lag the fields SG14-SG18 made load-bearing', gaps.length === 0, `${gaps.length} gaps (listed above)`, 'contracts.js SHAPES/asserts and CLAUDE.md list every field a gate, the executor or learning reads');
  }

  // L4: docs of the commit bar and the exit codes after SG17/SG18.
  {
    const claude = read('CLAUDE.md');
    const readme = read('README.md');
    const stale = [];
    if (/or, when no\s+operator applies to them, of the edited lines/.test(claude)) stale.push('CLAUDE.md: mutants fall back to "the edited lines" (SG18 removed the line fallback; every change hunk needs its own killed mutant)');
    if (!/deletion/i.test(claude)) stale.push('CLAUDE.md: no word on deletion-only hunks (kept only with an `equivalent` diff test whose deletion probes ran, else `tests_insensitive`)');
    if (/at least one of up to 3 bug-injected mutants/.test(readme)) stale.push('README: "fail on at least one of up to 3 bug-injected mutants of the edit" (per change hunk since SG18)');
    if (!/EWORKTREE|exit 2|exit code/i.test(readme)) stale.push('README: exit codes undocumented (2 = missing --repo target or EWORKTREE on --resume, 1 = fatal, 0 = done or SIGINT/SIGTERM); the --resume row does not say a lost run branch stops the run');
    for (const s of stale) console.log(`   - ${s}`);
    report('L4 commit-bar and exit-code docs are stale after SG17/SG18', stale.length === 0, `${stale.length} stale statements (listed above)`, 'CLAUDE.md and README describe the per-hunk mutant rule, the deletion rule and the exit codes');
  }

  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
