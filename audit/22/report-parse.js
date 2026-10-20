#!/usr/bin/env node
'use strict';

// SG26 per-test results on large suites.
// 1. Parser cost: test-runner.tapResults / junitResults on synthetic reports
//    of N tests, with unique names and with one repeated name (a table-driven
//    suite: `for (const c of cases) test('works', ...)`, or a pytest class
//    repeated in many modules is unique, so pytest gets the `shared` shape:
//    ids differing only past the k-th repeat). Duplicate ids get `#2`, `#3`
//    ... by a linear probe from 2 each time.
// 2. End to end: runTests on a real node:test suite (unique names, and one
//    repeated name: js-dup) / pytest suite (parametrized) of N trivial tests: wall time vs the run's own execution_time_ms (the part
//    the mutant budget charges); the rest is spawn, report read and parse,
//    load-log read and temp-dir removal, all uncharged.
// 1b. Kill intersection: executor.js mutationEvidence keeps the tests that
//    failed in both mutant runs with `a.filter(id => b.includes(id))`
//    (the line is taken from the source and run on N failing tests: a
//    mutant in a core function fails every test).
// FINDING when parsing one report (or one intersection) takes more than --max-ms (default 1,000 ms;
// it runs once per mutant run, up to ~108 times per edit, uncharged), or
// when the uncharged part of one runTests call exceeds 1,000 ms.
//
// usage: node audit/22/report-parse.js [--n 1000,5000,20000] [--e2e 1000,5000]
//          [--lang js,py] [--max-ms 1000]

const L = require('./lib');
const { tapResults, junitResults, runTests } = require(L.src('runner/test-runner'));

const NS = L.nums('--n', '1000,5000,20000');
const E2E = L.nums('--e2e', '1000,5000');
const LANGS = L.list('--lang', 'js,py');
const MAX_MS = Number(L.opt('--max-ms', 1000));

function tap(n, dup) {
  const out = ['TAP version 13'];
  for (let i = 0; i < n; i++) {
    out.push(`# Subtest: ${dup ? 'works' : `case ${i}`}`, `ok ${i + 1} - ${dup ? 'works' : `case ${i}`}`, '  ---', '  duration_ms: 0.1', "  type: 'test'", '  ...');
  }
  out.push(`1..${n}`, `# tests ${n}`, `# pass ${n}`);
  return out.join('\n') + '\n';
}
function junit(n, dup) {
  let s = '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="' + n + '">';
  for (let i = 0; i < n; i++) s += `<testcase classname="tests.test_m" name="${dup ? 'test_works' : `test_case_${i}`}" time="0.001" />`;
  return s + '</testsuite></testsuites>';
}

console.log('1. parser cost (one call; runs after every mutant run)');
const W = [8, 8, 6, 10, 10, 8];
console.log(L.row(['format', 'tests', 'dup', 'KB', 'ms', 'ids'], W));
for (const n of NS) {
  for (const dup of [false, true]) {
    for (const [fmt, gen, parse] of [['tap', tap, tapResults], ['junit', junit, junitResults]]) {
      const text = gen(n, dup);
      const t = L.timeIt(() => parse(text), 2);
      const ids = t.r ? Object.keys(t.r.tests).length : 0;
      console.log(L.row([fmt, n, dup, L.fmt(text.length / 1024), L.fmt(t.ms.max), ids], W));
      L.check(`${fmt} ${n} tests${dup ? ' (one repeated name)' : ''}: parse <= ${MAX_MS} ms`, t.ms.max <= MAX_MS, `${L.fmt(t.ms.max)} ms`);
    }
  }
}

function jsSuite(n, dup) {
  const dir = L.tmpDir('a22-rp-js');
  L.write(dir, 'package.json', JSON.stringify({ name: 'rp', version: '1.0.0', scripts: { test: 'node --test' } }));
  L.write(dir, 'src/m.js', 'exports.f = (x) => x + 1;\n');
  const per = 500;
  for (let f = 0; f * per < n; f++) {
    const body = ["const test = require('node:test');", "const assert = require('assert');", "const { f } = require('../src/m');",
      `for (let i = 0; i < ${Math.min(per, n - f * per)}; i++) test(${dup ? "'works'" : "'works ' + i"}, () => assert.strictEqual(f(i), i + 1));`];
    L.write(dir, `test/t${f}.test.js`, body.join('\n') + '\n');
  }
  return dir;
}
function pySuite(n) {
  const dir = L.tmpDir('a22-rp-py');
  L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\n');
  L.write(dir, 'pkg/__init__.py', '');
  L.write(dir, 'pkg/m.py', 'def f(x):\n    return x + 1\n');
  L.write(dir, 'tests/test_m.py', `import pytest\nfrom pkg.m import f\n\n@pytest.mark.parametrize('i', range(${n}))\ndef test_works(i):\n    assert f(i) == i + 1\n`);
  return dir;
}

const exSrc = L.fs.readFileSync(L.src('agents/executor.js'), 'utf8');
const interLine = exSrc.match(/const tests = a && b \? (a\.filter\([^\n]*\)) : \[\];/)[1];
// eslint-disable-next-line no-new-func
const intersect = new Function('a', 'b', `return ${interLine};`);
console.log(`\n1b. kill intersection (${interLine}) on N tests failing in both runs`);
for (const n of NS) {
  const a = Array.from({ length: n }, (_, i) => `suite > case ${i}`);
  const b = [...a];
  const t = L.timeIt(() => intersect(a, b), 1);
  console.log(L.row(['inter', n, '', '', L.fmt(t.ms.max), t.r.length], W));
  L.check(`intersection of ${n} failing tests <= ${MAX_MS} ms`, t.ms.max <= MAX_MS, `${L.fmt(t.ms.max)} ms`);
}

(async () => {
  if (LANGS.includes('py')) L.pyPath();
  console.log('\n2. runTests on a real suite (no edit, as a mutant run): wall vs charged execution_time_ms');
  const W2 = [7, 7, 9, 10, 11, 10, 9];
  console.log(L.row(['lang', 'tests', 'status', 'wall_ms', 'charged_ms', 'unchgd_ms', 'ids'], W2));
  for (const lang of LANGS) {
    for (const [n, dup] of E2E.flatMap(n => (lang === 'js' ? [[n, false], [n, true]] : [[n, false]]))) {
      const dir = lang === 'js' ? jsSuite(n, dup) : pySuite(n);
      const tag = `${lang}${dup ? '-dup' : ''}`;
      try {
        for (let rep = 0; rep < 2; rep++) {
          const t0 = performance.now();
          const r = await runTests({ repoRoot: dir });
          const wall = performance.now() - t0;
          const ids = r.tests ? Object.keys(r.tests).length : 0;
          console.log(L.row([tag, n, r.status, L.fmt(wall), L.fmt(r.execution_time_ms), L.fmt(wall - r.execution_time_ms), ids], W2));
          if (rep === 1) L.check(`${tag} ${n} tests: uncharged runTests overhead <= 1000 ms`, wall - r.execution_time_ms <= 1000, `${L.fmt(wall - r.execution_time_ms)} ms`);
        }
      } finally { L.rm(dir); }
    }
  }
  L.finish();
})();
