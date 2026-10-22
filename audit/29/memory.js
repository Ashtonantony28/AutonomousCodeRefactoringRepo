#!/usr/bin/env node
'use strict';

// Memory under many proposals, for the code SG36-SG38 touched: the
// executor's per-proposal work that stays in this process is editMutants
// (whole-file lexing, uncoveredToken's bracket / depth maps, the switch
// copies) and runTests' report parsing + loadFailed. Retained heap after GC
// is sampled every --every proposals over --n proposals (distinct edits on a
// ~100 KB file per language, plus a runTests of a 2,000-test suite with 500
// caught load rows every 10th proposal). FINDING when retained heap grows by
// more than 32 MB from the first sample to the last, or peak RSS passes
// 1 GB.
//
// usage: node --expose-gc audit/29/memory.js [--n 200] [--every 25] [--lang js,py]

const L = require('./lib');
if (!global.gc) { console.log('run with --expose-gc'); process.exit(2); }

const N = Number(L.opt('--n', 200));
const EVERY = Number(L.opt('--every', 25));
const LANGS = L.list('--lang', 'js,py');
const { editMutants } = require(L.src('rl/bug-injector'));
const { runTests } = require(L.src('runner/test-runner'));
if (LANGS.includes('py')) L.pyPath();

function file(lang, k) {
  const js = lang === 'js';
  const fill = [];
  for (let i = 0; i < 2000; i++) fill.push(js ? `function f${i}(a, b) { return a + b * ${i}; }` : `def f${i}(a, b):\n    return a + b * ${i}\n`);
  const cur = js ? 'function g(a, b) {\n  let c = a;\n  return c + b;\n}' : 'def g(a, b):\n    c = a\n    return c + b\n';
  const prop = js ? `function g(a, b) {\n  let c = a;\n  return c + b + ${k + 1};\n}` : `def g(a, b):\n    c = a\n    return c + b + ${k + 1}\n`;
  const head = fill.join('\n') + '\n';
  return { before: head + cur + '\n', edited: head + prop + '\n', file: js ? 'src/m.js' : 'pkg/m.py' };
}

const suite = L.tmpDir('a29-mem');
L.write(suite, 'package.json', JSON.stringify({ name: 'mem', version: '1.0.0', scripts: { test: 'node --test' } }));
L.write(suite, 'src/bad.js', "throw new Error('cfg');\n");
L.write(suite, 'test/a.test.js', "const test = require('node:test');\nconst assert = require('assert');\n" +
  "test('table', () => { for (let i = 0; i < 500; i++) assert.throws(() => require('../src/bad')); });\n" +
  'for (let i = 0; i < 1999; i++) test(`t ${i}`, () => {});\n');

const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed / 2 ** 20; };
(async () => {
  const samples = [];
  let peak = 0, count = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    for (const lang of LANGS) {
      const f = file(lang, i);
      const r = editMutants(f.edited, { file: f.file, before: f.before, max: 3 });
      count += Array.isArray(r) ? r.length : 0;
    }
    if (i % 10 === 0) await runTests({ repoRoot: suite, timeoutMs: 60_000 });
    peak = Math.max(peak, process.memoryUsage().rss / 2 ** 20);
    if (i % EVERY === 0 || i === N - 1) samples.push([i, heap()]);
  }
  console.log(`${N} proposals x ${LANGS.join('+')}, ${count} mutants, ${Math.round((performance.now() - t0) / 1000)} s`);
  console.log('retained heap (MB) by proposal: ' + samples.map(([i, h]) => `${i}:${h.toFixed(1)}`).join(' '));
  console.log(`peak RSS ${peak.toFixed(0)} MB`);
  const growth = samples[samples.length - 1][1] - samples[0][1];
  L.check('retained heap growth <= 32 MB over the run', growth <= 32, `${growth.toFixed(1)} MB`);
  L.check('peak RSS <= 1 GB', peak <= 1024, `${peak.toFixed(0)} MB`);
  L.rm(suite);
  L.finish();
})();
