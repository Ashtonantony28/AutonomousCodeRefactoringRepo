#!/usr/bin/env node
'use strict';

// SG25 carried references: editMutants now parses the whole file for its
// top-level bindings (moduleBindings: Babel for JS, a lexical scan for
// Python) when an inserted identifier may name one, and adds every operator
// site of each referenced definition. All of it runs synchronously in the
// executor, before the first mutant run (main thread blocked).
// Module: ~N lines of helpers (`h_i`, 4 operator sites each), constants
// (`C_i`), a few big helpers (> 12 sites) and a 5,000-entry table; one edit in
// `target` per case. Reports wall time (= main-thread block), mutants, and the
// result marker (capped -> `mutation_budget`, unmutated_ref -> `tests_insensitive`).
//
// FINDING when a case blocks for more than --limit ms (default 1000) or a
// many-reference edit takes super-linear time in the number of references.
//
// usage: node audit/17/edit-refs.js [--lang js,py] [--lines 1000,5000] [--refs 1,10,50,200] [--reps 3] [--limit 1000]

const L = require('./lib');
const { editMutants } = require(L.src('rl/bug-injector'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const LANGS = opt('--lang', 'js,py').split(',');
const LINES = opt('--lines', '1000,5000').split(',').map(Number);
const REFS = opt('--refs', '1,10,50,200').split(',').map(Number);
const REPS = Number(opt('--reps', 3));
const LIMIT = Number(opt('--limit', 1000));

function module_(lang, lines) {
  const js = lang === 'js';
  const parts = [];
  const nh = Math.max(250, Math.floor(lines / 8));
  for (let i = 0; i < nh; i++) {
    parts.push(js
      ? `const C_${i} = ${i % 97};\nfunction h_${i}(a) {\n  if (a > ${i % 13}) {\n    return a - ${i % 7};\n  }\n  return a;\n}\n`
      : `C_${i} = ${i % 97}\ndef h_${i}(a):\n    if a > ${i % 13}:\n        return a - ${i % 7}\n    return a\n\n`);
  }
  const big = js
    ? `function big(a) {\n${Array.from({ length: 20 }, (_, k) => `  if (a === ${k}) return a + ${k + 1};`).join('\n')}\n  return 0;\n}\n`
    : `def big(a):\n${Array.from({ length: 20 }, (_, k) => `    if a == ${k}:\n        return a + ${k + 1}`).join('\n')}\n    return 0\n\n`;
  const table = js
    ? `const TABLE = [${Array.from({ length: 5000 }, (_, k) => k % 251).join(', ')}];\n`
    : `TABLE = [${Array.from({ length: 5000 }, (_, k) => k % 251).join(', ')}]\n`;
  const tgt = (body) => js ? `function target(a) {\n  return ${body};\n}\n` : `def target(a):\n    return ${body}\n\n`;
  const head = js ? "'use strict';\n" : '"""m"""\n';
  const tail = js ? 'module.exports = { target };\n' : '';
  const mk = (body) => head + parts.join('') + big + table + tgt(body) + tail;
  return { before: mk('a + 1'), mk, file: js ? 'src/m.js' : 'pkg/m.py' };
}

const cases = (n) => [
  ['literal (no ref)', 'a + 2'],
  ['1 constant', 'a + C_7'],
  ['1 small helper', 'h_7(a)'],
  ['1 big helper (20 sites)', 'big(a)'],
  ['5,000-entry table', 'TABLE[a % 5000]'],
  ...REFS.filter(k => k > 1).map(k => [`${k} small helpers`, Array.from({ length: k }, (_, i) => `h_${i}(a)`).join(' + ')])
].filter(Boolean);

console.log(L.row(['lang', 'lines', 'KB', 'case', 'p50_ms', 'max_ms', 'result'], [5, 6, 5, 26, 8, 8, 40]));
const perRef = {};
for (const lang of LANGS) {
  for (const lines of LINES) {
    const { before, mk, file } = module_(lang, lines);
    const nl = before.split('\n').length;
    for (const [label, body] of cases(lines)) {
      const after = mk(body);
      const ms = [];
      let res;
      for (let r = 0; r < REPS; r++) {
        const t0 = performance.now();
        res = editMutants(after, { start: 0, end: after.length, file, max: 3, before, timeoutMs: 10_000 });
        ms.push(performance.now() - t0);
      }
      const p50 = L.median(ms), max = Math.max(...ms);
      const result = res.capped ? 'capped (mutation_budget)' : res.unchecked ? 'unchecked' : res.unmutated_ref ? `unmutated_ref ${res.unmutated_ref.name}` : `${res.length} mutants, ${new Set(res.map(m => m.site)).size} sites`;
      console.log(L.row([lang, nl, (after.length / 1024).toFixed(0), label, L.fmt(p50), L.fmt(max), result], [5, 6, 5, 26, 8, 8, 40]));
      L.check(`${lang} ${nl} lines ${label}: main-thread block <= ${LIMIT} ms`, max <= LIMIT, `${L.fmt(max)} ms`);
      const m = /^(\d+) small helpers$/.exec(label);
      if (m) (perRef[`${lang}:${nl}`] = perRef[`${lang}:${nl}`] || []).push([Number(m[1]), p50]);
    }
  }
}
// Super-linear check: time per reference must not grow with the reference count.
for (const [k, pts] of Object.entries(perRef)) {
  if (pts.length < 2) continue;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const ratio = (b[1] / b[0]) / Math.max(1e-9, a[1] / a[0]);
  L.check(`${k} per-reference cost ${a[0]} -> ${b[0]} refs not super-linear`, ratio < 2, `${L.fmt(a[1] / a[0], 2)} -> ${L.fmt(b[1] / b[0], 2)} ms/ref`);
}
L.finish();
