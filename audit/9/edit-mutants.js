#!/usr/bin/env node
'use strict';

// SG14 mutant generation cost (bug-injector.editMutants), which runs
// synchronously on the main thread for every edit whose suite passed: it
// regex-scans the comment/string-blanked file, builds one full-file string
// per operator match on the edited lines (plus a split of the prefix for the
// line number), then parses up to 12 candidates in full (Babel for JS, one
// python3 process for Python) to keep parse-valid ones.
//
// usage: node audit/9/edit-mutants.js [--reps 3]

const L = require('./lib');
const { editMutants } = require(L.src('rl/bug-injector'));
const { changedSpan } = require(L.src('runner/test-runner'));

const args = process.argv.slice(2);
const REPS = Number(args[args.indexOf('--reps') + 1]) || 3;

const fnJs = (i) => `function f${i}(a, b) {\n  if (a > ${i} && b < ${i + 1}) return a + b;\n  return a - b === ${i} ? 1 : 0;\n}\n`;
const fnPy = (i) => `def f${i}(a, b):\n    if a > ${i} and b < ${i + 1}:\n        return a + b\n    return 1 if a - b == ${i} else 0\n\n\n`;

function fill(gen, bytes) {
  let s = '', i = 0;
  while (s.length < bytes) s += gen(i++);
  return s;
}

const CASES = [];
{
  // 1. 199 KB file of small functions, one-line edit in the middle.
  const before = fill(fnJs, 199_000);
  const at = before.indexOf('return a + b;', before.length / 2);
  CASES.push(['js 199KB, 1-line edit mid-file', 'm.js', before, before.slice(0, at) + 'return b + a;' + before.slice(at + 'return a + b;'.length)]);
}
{
  // 2. Minified: one 190 KB line, small edit on it.
  const before = fill(fnJs, 190_000).replace(/\n\s*/g, ' ');
  const at = before.indexOf('return a + b;', before.length / 2);
  CASES.push(['js 190KB single line (minified), small edit', 'min.js', before, before.slice(0, at) + 'return b + a;' + before.slice(at + 'return a + b;'.length)]);
}
{
  // 3. Edit rewrites 100 KB of the file (every `return a + b` reordered).
  const before = fill(fnJs, 199_000);
  const cut = 100_000;
  const after = before.slice(0, cut).replace(/return a \+ b;/g, 'return b + a;') + before.slice(cut);
  CASES.push(['js 199KB, edit spans first 100 KB', 'm.js', before, after]);
}
{
  const before = fill(fnPy, 199_000);
  const at = before.indexOf('return a + b', before.length / 2);
  CASES.push(['py 199KB, 1-line edit mid-file', 'm.py', before, before.slice(0, at) + 'return b + a' + before.slice(at + 'return a + b'.length)]);
}
{
  const before = fill(fnPy, 199_000);
  const cut = 100_000;
  const after = before.slice(0, cut).replace(/return a \+ b/g, 'return b + a') + before.slice(cut);
  CASES.push(['py 199KB, edit spans first 100 KB', 'm.py', before, after]);
}

const W = [44, 10, 10, 10, 8];
const row = (c) => c.map((x, i) => String(x).padEnd(W[i] || 10)).join(' ');
console.log('editMutants(edited, span): synchronous main-thread time per kept-edit candidate (runs before any mutant test run)');
console.log(row(['case', 'p50_ms', 'max_ms', 'mutants', 'rssMB']));
for (const [name, file, before, after] of CASES) {
  const span = changedSpan(before, after);
  const ms = [];
  let n = 0;
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    n = editMutants(after, { ...span, file, max: 3 }).length;
    ms.push(performance.now() - t0);
  }
  const s = L.stats(ms);
  console.log(row([name, L.fmt(s.p50), L.fmt(s.max), n, L.fmt(L.rssMb())]));
}
