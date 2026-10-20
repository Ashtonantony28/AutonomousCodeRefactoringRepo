#!/usr/bin/env node
'use strict';

// SG14 mutant re-runs vs suite duration, through runExecutor (the path the
// orchestrator takes; it passes no testTimeoutMs, so the budget is 60 s).
// The fixture is a tiny JS (npm test) or Python (pytest) repo whose suite
// asserts on the edited function, so every mutant of the edited line is
// killed by the suite when it runs, plus a configurable slow part:
//   js:    the test sleeps S ms (Atomics.wait) before asserting;
//   py:    the test burns CPU in pure Python for P ms (plain run); under
//          `coverage run` (the main run) this is several times slower.
// Mutant budget (src/agents/executor.js): mutant k runs only while
// left >= suite + 500 ms, so for a 60 s budget a suite of ~29.8 s or more
// gets no mutant run and the edit is reverted `tests_insensitive`.
//
// usage: node audit/9/mutant-budget.js [--lang js|py] [--suite-s 5,15,25,31,45]
//          [--sensitive 1|0] [--budget-ms 60000]

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { runExecutor } = require(L.src('agents/executor'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const LANG = opt('--lang', 'js');
const SUITES = opt('--suite-s', LANG === 'js' ? '5,15,25,31,45' : '1,3,5').split(',').map(Number);
const SENSITIVE = opt('--sensitive', '1') === '1';
const BUDGET = Number(opt('--budget-ms', 60000));

const CUR_JS = "'use strict';\nfunction add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
const PROP_JS_BODY = '  const sum = a + b;\n  return sum;\n';
const CUR_PY = 'def add(a, b):\n    return a + b\n';
const PROP_PY_BODY = '    total = a + b\n    return total\n';

function genJs(suiteMs) {
  const dir = L.tmpDir('mut-js');
  L.write(dir, 'package.json', JSON.stringify({ name: 'mut', version: '1.0.0', scripts: { test: 'node test/run.js' } }));
  L.write(dir, 'src/add.js', CUR_JS);
  L.write(dir, 'test/run.js', [
    "const assert = require('assert');",
    "const { add } = require('../src/add');",
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${suiteMs});`,
    SENSITIVE ? 'assert.strictEqual(add(2, 3), 5); assert.strictEqual(add(-1, 1), 0);' : 'add(2, 3);',
    "console.log('1 passing');"
  ].join('\n'));
  L.gitInit(dir);
  return { dir, file: 'src/add.js', cur: '  return a + b;\n', prop: PROP_JS_BODY };
}

function genPy(cpuMs) {
  const dir = L.tmpDir('mut-py');
  L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\n');
  L.write(dir, 'pkg/__init__.py', '');
  L.write(dir, 'pkg/add.py', CUR_PY);
  // Calibrated busy loop: ~cpuMs of pure-Python work in a plain run.
  L.write(dir, 'tests/test_add.py', [
    'from pkg.add import add',
    '',
    '',
    'def burn(n):',
    '    s = 0',
    '    for i in range(n):',
    '        s += i % 7',
    '    return s',
    '',
    '',
    'def test_add():',
    `    burn(${Math.round(cpuMs * 9000)})`,
    SENSITIVE ? '    assert add(2, 3) == 5\n    assert add(-1, 1) == 0' : '    add(2, 3)',
    ''
  ].join('\n'));
  L.gitInit(dir);
  return { dir, file: 'pkg/add.py', cur: '    return a + b\n', prop: PROP_PY_BODY };
}

(async () => {
  console.log(`runExecutor, ${LANG} repo, suite ${SENSITIVE ? 'asserts on the edited function (kills every mutant)' : 'calls the edited function without asserting'}; budget ${BUDGET} ms`);
  const W = [10, 12, 9, 18, 11, 9, 32];
  const row = (c) => c.map((x, i) => String(x).padEnd(W[i] || 10)).join(' ');
  console.log(row(['slow_s', 'main_run_ms', 'cov_ms', 'outcome', 'mutants', 'wall_ms', 'mutation evidence']));
  for (const s of SUITES) {
    const fx = LANG === 'js' ? genJs(s * 1000) : genPy(s * 1000);
    const proposal = { issue_id: `mut-${s}`, file: fx.file, current_code: fx.cur, proposed_code: fx.prop };
    const t0 = performance.now();
    const r = await runExecutor({ proposal, repoRoot: fx.dir, testTimeoutMs: BUDGET });
    const wall = performance.now() - t0;
    const m = r.mutation || {};
    const ev = m.killed ? `killed by ${m.killed} after ${m.run} run(s)` : `${m.run || 0} of ${m.mutants || 0} run${m.budget_exhausted ? ', budget_exhausted' : ''}`;
    console.log(row([s, r.execution_time_ms, r.coverage && r.coverage.duration_ms, `${r.status}${r.reason ? ' ' + r.reason : ''}`, `${m.run || 0}/${m.mutants || 0}`, Math.round(wall), ev]));
    L.rm(fx.dir);
  }
})();
