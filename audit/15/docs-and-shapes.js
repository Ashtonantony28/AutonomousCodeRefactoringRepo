'use strict';

// AUDIT-15 Lows: docs vs code after SG19-SG23, and the DiffTest /
// TestOutcome shapes the Python path and the executor now produce.
//   L1 README / CLAUDE.md stale after SG19 / SG21 / SG22
//   L2 DiffTest counterexample: JS and Python shapes differ; a Python veto
//      names inputs as Python reprs, a load-phase one as "n/a"
//   AUDIT-10 L2 (narrowed): `tests_insensitive` still covers "no mutant could be generated" and
//      "mutationEvidence threw" (budget was split out by SG20)
//
//   node audit/15/docs-and-shapes.js

const { report, exitCode } = require('../10/lib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// README's architecture block wraps lines inside a box drawing; read it flat.
const flat = (s) => s.replace(/[│├└─►]/g, ' ').replace(/\s+/g, ' ');

(async () => {
  // L1
  {
    const readme = flat(read('README.md'));
    const claude = flat(read('CLAUDE.md'));
    const stale = [];
    if (/fail on at least one of up to 3 bug-injected mutants of the edit/.test(readme)) {
      stale.push('README architecture: "fail on at least one of up to 3 bug-injected mutants of the edit" (every site needs its own kill, deleted tokens need observation; SG18/SG22). audit/10 L4 misses it: its regex does not match across the wrapped line');
    }
    if (/non-JS edits \(runs=0\) need every check passed/.test(readme)) {
      stale.push('README architecture: "non-JS edits (runs=0) need every check passed" (since SG19 a Python edit with runs=0 is rejected like JS; only other languages take the all-checks path)');
    }
    if (/oracle for JS function refactors/.test(readme) && !/py_diff_harness|python3 -I/.test(readme.replace(/py_diff_harness\.py` is not included/, ''))) {
      stale.push('README: differential testing described as JS-only ("oracle for JS function refactors", "when a JS proposal touches a callable"); the Python harness (SG19) is not described');
    }
    if (/marks proposals already committed on `refactor\/<run_id>` as passed/.test(readme) && !/refactor-run/.test((read('README.md').split('\n').find(l => l.startsWith('| `--resume`')) || ''))) {
      stale.push('README --resume row: reconciles only "refactor/<run_id>"; since SG21 the run branch may be refactor-run/<run_id> or refactor-run-<run_id> (the code uses session.worktree.branch), and a lost branch stops the run (EWORKTREE, exit 2), not documented there');
    }
    if (/reconciles with the `refactor\/<run_id>` branch/.test(claude) || /re-created from `refactor\/<run_id>`/.test(claude)) {
      stale.push('CLAUDE.md coordination rules: resume "reconciles with the `refactor/<run_id>` branch" / "re-created from `refactor/<run_id>`" (the recorded branch, possibly refactor-run/…)');
    }
    for (const s of stale) console.log(`   - ${s}`);
    report('L1 README / CLAUDE.md statements stale after SG19-SG22', stale.length === 0,
      `${stale.length} stale statements (listed above)`, 'docs describe the Python diff test, the per-site / deletion bar and the fallback branch names');
  }

  // L2
  {
    const dt = require('../../src/validation/diff-testing');
    const { vetoReasons } = require('../../src/validation/hybrid-validator');
    const jury = { panel: [{ persona: 'p', preserves_semantics: true }] };
    const js = dt.run({ currentSrc: 'function f(a) { return a + "x"; }', proposedSrc: 'function f(a) { return a + "y"; }' });
    const py = dt.run({ currentSrc: 'def f(a):\n    return str(a) + "x"\n', proposedSrc: 'def f(a):\n    return str(a) + "y"\n', file: 'm.py' });
    const pyLoad = dt.run({ currentSrc: 'X = 1\n', proposedSrc: 'X = 2\n', file: 'm.py' });
    const keys = (r) => r.counterexample ? Object.keys(r.counterexample).sort().join(',') : '-';
    const why = (r) => vetoReasons({ jury, checks: [], dt: r })[0] || '-';
    console.log(`   JS     verdict=${js.verdict} counterexample keys=[${keys(js)}] veto: ${why(js)}`);
    console.log(`   Python verdict=${py.verdict} counterexample keys=[${keys(py)}] veto: ${why(py)}`);
    console.log(`   Python load-phase verdict=${pyLoad.verdict} function_name=${JSON.stringify(pyLoad.function_name)} keys=[${keys(pyLoad)}] veto: ${why(pyLoad)}`);
    console.log(`   extras beyond the DiffTest contract: JS [${Object.keys(js).filter(k => !['applicable', 'verdict', 'runs', 'counterexample', 'reason', 'duration_ms'].includes(k)).join(',')}], Python [${Object.keys(py).filter(k => !['applicable', 'verdict', 'runs', 'counterexample', 'reason', 'duration_ms'].includes(k)).join(',')}]`);
    const same = keys(js) === keys(py) && pyLoad.counterexample && pyLoad.counterexample.args !== undefined;
    report('L2 DiffTest.counterexample: Python and JS shapes differ; Python vetoes name inputs as reprs or "n/a"', same,
      `JS keys [${keys(js)}], Python [${keys(py)}], Python load-phase [${keys(pyLoad)}] -> "${why(pyLoad)}"`,
      'one counterexample shape in the DiffTest contract (target, phase, args as JSON-safe values, current/proposed outcome), used by both producers and by vetoReasons');
  }

  // AUDIT-10 L2, narrowed
  {
    const { runExecutor } = require('../../src/agents/executor');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit15-ins-'));
    fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: 'node --test test/a.test.js' } }));
    const cur = 'function label(x) {\n  const name = String(x);\n  return name;\n}';
    const prop = 'function label(x) {\n  const text = String(x);\n  return text;\n}';
    fs.writeFileSync(path.join(dir, 'src/a.js'), `'use strict';\n${cur}\nmodule.exports = { label };\n`);
    fs.writeFileSync(path.join(dir, 'test/a.test.js'), "const t = require('node:test'); const a = require('node:assert'); const { label } = require('../src/a');\nt('l', () => a.strictEqual(label(3), '3'));\n");
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const prev = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
    const o = await runExecutor({ proposal: { issue_id: 'r', file: 'src/a.js', current_code: cur, proposed_code: prop, diff_test: { applicable: true, verdict: 'equivalent', runs: 20, duration_ms: 1, deletions_observed: true } }, repoRoot: dir });
    if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev;
    const m = o.mutation || {};
    console.log(`   rename: status=${o.status} reason=${o.reason} mutation={hunks:${m.hunks}, mutants:${m.mutants}, run:${m.run}, unmutated_hunk_line:${m.unmutated_hunk_line}}`);
    report('AUDIT-10 L2 (narrowed) `tests_insensitive` recorded when no mutant exists or none ran', !(o.reason === 'tests_insensitive' && !m.run),
      `reason=tests_insensitive with ${m.mutants} mutants and ${m.run} suite runs (a rename has no mutable site); a mutationEvidence exception also maps to tests_insensitive`,
      'a distinct untested reason (e.g. `no_mutable_site`, `mutation_error`) for "the suite was never asked", in UNTESTED_REASONS');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
