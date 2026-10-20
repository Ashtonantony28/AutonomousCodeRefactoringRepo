#!/usr/bin/env node
'use strict';

// SG24 x SG25 cost of mutation evidence: a kill now takes three suite runs
// (fail, fail again, unmutated control), and an edit whose change is carried
// by a reference to an in-file helper needs a kill at every site of that
// helper as well. Both share the 60 s mutant budget, so the number of suite
// runs is ~3 x sites. 200-file repo (the suite requires every module), a
// helper `h_9` with 7 operator sites, two behaviour-preserving edits of
// `target`:
//   inline: `return h_9(a);` -> `return a > 9 ? a - 5 : a;`   (4 sites)
//   ref:    the reverse (`h_9` is a carried reference: 7 sites)
// The suite sleeps --suite-s first (a failing run costs as much as a passing
// one, as in a real suite) and then kills every mutant (exhaustive asserts).
// Reports outcome, mutant runs and the executor's wall time.
//
// FINDING when a `ref` edit ends `mutation_budget` at a suite time where the
// same suite judges the `inline` edit (the reference expansion turns a
// testable edit into an untested one after spending the whole budget), or
// when the mutant phase overruns its 60 s budget by more than one run.
//
// usage: node audit/17/executor-refs.js [--lang js,py] [--suite-s 0.5,2,4] [--files 200]

const L = require('./lib');
const { runExecutor } = require(L.src('agents/executor'));
const diffTesting = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const LANGS = opt('--lang', 'js,py').split(',');
const SUITE_S = opt('--suite-s', '0.5,2,4').split(',').map(Number);
const FILES = Number(opt('--files', 200));

if (LANGS.includes('py')) {
  const d = L.pytestWithCoverageDir();
  if (d) process.env.PATH = `${d}:${process.env.PATH}`;
}

const INLINE = { js: 'return a > 9 ? a - 5 : a;', py: 'return a - 5 if a > 9 else a' };
const CALL = { js: 'return h_9(a);', py: 'return h_9(a)' };

function gen(lang, suiteS, kind) {
  const dir = L.tmpDir(`a17-exref-${lang}`);
  const js = lang === 'js';
  let helpers = '';
  for (let i = 0; i < 40; i++) {
    helpers += js
      ? `function h_${i}(a) {\n  if (a > ${i}) {\n    return a - ${(i % 5) + 1};\n  }\n  return a;\n}\n`
      : `def h_${i}(a):\n    if a > ${i}:\n        return a - ${(i % 5) + 1}\n    return a\n\n\n`;
  }
  // h_9: if, >, 9, return, -, 5, return -> 7 sites
  const tgt = (body) => js ? `function target(a) {\n  ${body}\n}\n` : `def target(a):\n    ${body}\n`;
  const [b0, b1] = kind === 'inline' ? [CALL[lang], INLINE[lang]] : [INLINE[lang], CALL[lang]];
  const file = js ? 'src/m.js' : 'pkg/m.py';
  const before = (js ? "'use strict';\n" : '') + helpers + tgt(b0) + (js ? 'module.exports = { target, h_9 };\n' : '');
  L.write(dir, file, before);
  for (let i = 0; i < FILES; i++) {
    L.write(dir, js ? `src/f${i}.js` : `pkg/f${i}.py`, js
      ? `'use strict';\nfunction f${i}(x) { return x * ${i % 7} + ${i}; }\nmodule.exports = { f${i} };\n`
      : `def f${i}(x):\n    return x * ${i % 7} + ${i}\n`);
  }
  const exp = (a) => (a > 9 ? a - 5 : a);
  const cases = Array.from({ length: 41 }, (_, k) => k - 20).map(a => [a, exp(a)]);
  if (js) {
    L.write(dir, 'package.json', JSON.stringify({ name: 'exref', version: '1.0.0', scripts: { test: 'node test/run.js' } }));
    L.write(dir, 'test/run.js', [
      "const assert = require('assert');",
      `for (let i = 0; i < ${FILES}; i++) require('../src/f' + i);`,
      "const m = require('../src/m');",
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Math.round(suiteS * 1000)});`,
      `for (const [a, e] of ${JSON.stringify(cases)}) { assert.strictEqual(m.target(a), e); assert.strictEqual(m.h_9(a), e); }`,
      "console.log('1 passing');"
    ].join('\n'));
  } else {
    L.write(dir, 'pkg/__init__.py', '');
    L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\n');
    L.write(dir, 'tests/test_m.py', [
      'import importlib, time',
      'from pkg import m',
      'def test_all():',
      `    for i in range(${FILES}):`,
      "        importlib.import_module('pkg.f%d' % i)",
      `    time.sleep(${suiteS})`,
      `    for a, e in ${JSON.stringify(cases)}:`,
      '        assert m.target(a) == e',
      '        assert m.h_9(a) == e',
      ''
    ].join('\n'));
  }
  L.gitInit(dir);
  const proposal = { issue_id: `exref-${lang}-${kind}-${suiteS}`, file, current_code: tgt(b0), proposed_code: tgt(b1) };
  proposal.diff_test = diffTesting.run({ currentSrc: proposal.current_code, proposedSrc: proposal.proposed_code, fileSrc: before, file });
  return { dir, proposal };
}

(async () => {
  console.log(`runExecutor, ${FILES}-file repo, suite kills every mutant; mutant budget 60 s`);
  console.log(L.row(['lang', 'suite_s', 'edit', 'diff_test', 'outcome', 'sites', 'mut_runs', 'mut_ms', 'exec_wall_ms'], [5, 8, 7, 11, 30, 6, 9, 8, 12]));
  const res = {};
  for (const lang of LANGS) {
    for (const s of SUITE_S) {
      for (const kind of ['inline', 'ref']) {
        const { dir, proposal } = gen(lang, s, kind);
        const t0 = performance.now();
        let r;
        try { r = await runExecutor({ proposal, repoRoot: dir }); } finally { /* */ }
        const wall = performance.now() - t0;
        const m = r.mutation || {};
        const outcome = `${r.status}${r.reason ? ' ' + r.reason : ''}`;
        res[`${lang}:${s}:${kind}`] = r.reason || r.status;
        console.log(L.row([lang, s, kind, proposal.diff_test.verdict, outcome, m.sites || '-', m.run || 0, L.fmt(m.duration_ms), L.fmt(wall)], [5, 8, 7, 11, 30, 6, 9, 8, 12]));
        if (m.duration_ms != null) {
          const runMax = 2 * (m.suite_ms || 0) + 1000;
          L.check(`${lang} suite ${s}s ${kind}: mutant phase within 60 s budget (+1 run)`, m.duration_ms <= 60_000 + runMax + 2000, `${L.fmt(m.duration_ms)} ms`);
        }
        L.rm(dir);
      }
      const a = res[`${lang}:${s}:inline`], b = res[`${lang}:${s}:ref`];
      if (a === 'passed') L.check(`${lang} suite ${s}s: helper-reference edit judged where the inlined edit is`, b !== 'mutation_budget', `inline ${a}, ref ${b}`);
    }
  }
  L.finish();
})();
