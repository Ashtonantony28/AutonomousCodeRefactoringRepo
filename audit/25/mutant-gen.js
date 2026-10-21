#!/usr/bin/env node
'use strict';

// SG31-SG34 cost of building the mutants of one edit (editMutants, plus the
// executor's own changeHunks), on ~5,000-line files:
//   * whole-file lexing: hunks.lexView calls (exported, and the two inside
//     every changeHunks), counted against hunk and mutant counts: a re-lex per
//     hunk or per mutant would grow with them;
//   * whole-file JS parses (ast-checker.parseJs) and python3 spawns;
//   * SG34 switch mutants: every mutant carries a full copy of the file with
//     its switch (`src`), so memory is mutants x file size;
//   * SG34 structural-token cover (uncoveredToken) on edits that wrap or
//     re-indent a large block.
// Edits:
//   uses-H:  H hunks (every third function), each `return t;` ->
//            `return clamp(t, LO, HI) + K;`
//   wrap-N:  an N-line function body wrapped in `if (on) { ... }` / `if on:`
//            with every body line re-indented (one structural change)
// FINDING when lexView runs more often than a constant per call (grows with
// hunks or mutants), when one editMutants call blocks the main thread for
// more than --max-ms (2,500 ms, the validator budget), or when the mutants'
// file copies exceed --max-mb (64 MB) for a file <= 200 KB.
//
// usage: node audit/25/mutant-gen.js [--lang js,py] [--lines 5000] [--hunks 1,4,16]
//          [--wrap 300,1000] [--reps 3] [--max-ms 2500] [--max-mb 64] [--src DIR]

// test/helpers/env.js first (temp REFACTOR_STATE_DIR), then the counters,
// then bug-injector: it binds lexView / changeHunks / spawnSync at load, so
// they are wrapped before it loads (./lib would load it through the
// orchestrator first). Whole-file lexes per call = lexView + 2 x changeHunks
// (changeHunks lexes before and after once each, hunks.js viewOf).
require('../../test/helpers/env');
const cp = require('child_process');
const path = require('path');
const ARGS = process.argv.slice(2);
const SRC = (() => { const i = ARGS.indexOf('--src'); return i < 0 ? path.resolve(__dirname, '..', '..') : path.resolve(ARGS[i + 1]); })();
const srcPath = (p) => path.join(SRC, 'src', p);
const hunksMod = require(srcPath('utils/hunks'));
const astMod = require(srcPath('validation/ast-checker'));

const counts = { lexView: 0, changeHunks: 0, parseJs: 0, parsedKB: 0, spawn: 0 };
const wrapFn = (mod, k, f) => { const o = mod[k]; mod[k] = function (...a) { f(a); return o.apply(this, a); }; };
wrapFn(hunksMod, 'lexView', () => counts.lexView++);
wrapFn(hunksMod, 'changeHunks', () => counts.changeHunks++);
wrapFn(astMod, 'parseJs', (a) => { counts.parseJs++; counts.parsedKB += (a[0] || '').length / 1024; });
wrapFn(cp, 'spawnSync', () => counts.spawn++);
const { editMutants } = require(srcPath('rl/bug-injector'));
const { changeHunks } = hunksMod;
const L = require('./lib');

const LANGS = L.list('--lang', 'js,py');
const LINES = Number(L.opt('--lines', 5000));
const HUNKS = L.nums('--hunks', '1,4,16');
const WRAP = L.nums('--wrap', '300,1000');
const REPS = Number(L.opt('--reps', 3));
const MAX_MS = Number(L.opt('--max-ms', 2500));
const MAX_MB = Number(L.opt('--max-mb', 64));

const JS_FN = (i, ret = 'return t;') => [
  `function g${i}(a, b) {`,
  `  const t = a * ${i % 9} - b;`,
  '  const s = `item ${a} of ${b}: ${t}`;',
  `  if (/^[a-z]+\\d{2,4}$/i.test(s)) return t + ${i};`,
  `  ${ret}`,
  '}', ''
].join('\n');
const PY_FN = (i, ret = 'return t') => [
  `def g${i}(a, b):`,
  `    t = a * ${i % 9} - b`,
  "    s = f'item {a} of {b}: {t}'",
  `    if re.match(r'^[a-z]+\\d{2,4}$', s):`,
  `        return t + ${i}`,
  `    ${ret}`,
  '', ''
].join('\n');
const HEAD = {
  js: "'use strict';\nconst LO = 0, HI = 100, on = true;\nconst clamp = (v, a, b) => Math.min(b, Math.max(a, v));\n",
  py: 'import re\nLO, HI, on = 0, 100, True\ndef clamp(v, a, b):\n    return min(b, max(a, v))\n\n\n'
};
const FN = { js: JS_FN, py: PY_FN };

function file(lang, n, edit) {
  let out = HEAD[lang];
  for (let i = 0; i < n; i++) out += FN[lang](i, edit && edit(i));
  return out;
}

// One k-line function in the middle of the file whose whole body is wrapped
// in `if (on) { ... }` / `if on:` (every body line re-indented).
function wrapped(lang, n, k) {
  const js = lang === 'js';
  const body = (ind) => Array.from({ length: k }, (_, i) => `${ind}y = y * ${(i % 7) + 2} + ${i % 11}${js ? ';' : ''}`).join('\n');
  const big = (wrap) => (js
    ? `function big(x) {\n  let y = x;\n${wrap ? '  if (on) {\n' + body('    ') + '\n  }' : body('  ')}\n  return y;\n}\n`
    : `def big(x):\n    y = x\n${wrap ? '    if on:\n' + body('        ') : body('    ')}\n    return y\n\n\n`);
  const half = file(lang, n >> 1);
  const rest = file(lang, n >> 1).slice(HEAD[lang].length);
  return { before: half + big(false) + rest, after: half + big(true) + rest };
}

function measure(lang, label, before, after) {
  const f = lang === 'js' ? 'src/big.js' : 'pkg/big.py';
  let res = null;
  const ms = [];
  let c = null, heap = 0;
  for (let r = 0; r < REPS; r++) {
    Object.keys(counts).forEach(k => { counts[k] = 0; });
    if (global.gc) global.gc();
    const h0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const hk = changeHunks(before, after, f); // the executor's own call
    res = editMutants(after, { file: f, before, max: 3 });
    ms.push(performance.now() - t0);
    heap = Math.max(heap, (process.memoryUsage().heapUsed - h0) / 1048576);
    c = { ...counts, hunks: hk.length };
  }
  const st = L.stats(ms);
  const bytes = Array.isArray(res) ? res.reduce((n, m) => n + (m.src ? m.src.length : 0), 0) : 0;
  const marker = Array.isArray(res) ? ['capped', 'unchecked', 'uncovered', 'unmutated_ref'].find(k => res[k]) || '' : '';
  const outcome = `${Array.isArray(res) ? res.length : 0}${marker ? ' ' + marker : ''}`;
  console.log(L.row([lang, label, `${(after.length / 1024).toFixed(0)}KB`, c.hunks, outcome, L.fmt(st.p50), L.fmt(st.max), c.lexView + 2 * c.changeHunks, c.changeHunks, c.parseJs, L.fmt(c.parsedKB), c.spawn, L.fmt(bytes / 1048576, 1), L.fmt(heap, 1)], W));
  return { st, c, bytes, n: Array.isArray(res) ? res.length : 0 };
}

const W = [5, 10, 7, 6, 18, 8, 8, 7, 8, 7, 9, 6, 9, 8];
console.log(L.row(['lang', 'edit', 'size', 'hunks', 'mutants', 'p50_ms', 'max_ms', 'lexes', 'chHunks', 'parseJs', 'parsedKB', 'spawn', 'copiesMB', 'heapMB'], W));
const n = Math.round(LINES / 7);
for (const lang of LANGS) {
  const lex = [];
  for (const h of HUNKS) {
    const before = file(lang, n);
    const step = 3; // one proposal region: every third function
    const lo = Math.floor(n / 4);
    const pick = new Set(Array.from({ length: h }, (_, k) => lo + k * step));
    const ret = lang === 'js' ? (i) => (pick.has(i) ? `return clamp(t, LO, HI) + ${i % 7};` : 'return t;') : (i) => (pick.has(i) ? `return clamp(t, LO, HI) + ${i % 7}` : 'return t');
    const after = file(lang, n, ret);
    const m = measure(lang, `uses-${h}`, before, after);
    lex.push([h, m.c.lexView + 2 * m.c.changeHunks, m.n]);
    L.check(`${lang} uses-${h}: editMutants <= ${MAX_MS} ms`, m.st.max <= MAX_MS, `${L.fmt(m.st.max)} ms`);
    L.check(`${lang} uses-${h}: mutant file copies <= ${MAX_MB} MB`, m.bytes / 1048576 <= MAX_MB, `${m.n} mutants x ${(after.length / 1024).toFixed(0)} KB = ${L.fmt(m.bytes / 1048576, 1)} MB`);
  }
  L.check(`${lang}: lexView calls constant in hunks and mutants`, new Set(lex.map(x => x[1])).size === 1, lex.map(([h, c, k]) => `${h} hunks/${k} mutants: ${c}`).join(', '));
  for (const k of WRAP) {
    const { before, after } = wrapped(lang, n, k);
    const m = measure(lang, `wrap-${k}`, before, after);
    L.check(`${lang} wrap-${k}: editMutants <= ${MAX_MS} ms`, m.st.max <= MAX_MS, `${L.fmt(m.st.max)} ms`);
  }
}
L.finish();
