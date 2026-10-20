#!/usr/bin/env node
'use strict';

// SG30 cost at realistic sizes: hunks.lexView (templates / f-strings /
// regexes tokenised), changeHunks and editMutants (per-token sites, use
// sites, parse checks, uncovered-token scan) on ~5,000-line files. Every call
// is synchronous in the executor: its wall time blocks the main thread and is
// charged to the 60 s mutant budget before any suite run.
//
// Files: N functions with a template literal / f-string and a regex each.
// Edits:
// Edited functions / rows are every other one in the middle of the file (one
// proposal's region).
//   uses-H:    H hunks, each `return t;` -> `return clamp(t, LO, HI) + K;` (use sites + operator sites)
//   nums12-H:  H hunks, each inserting 12 numbers (12 sites, the per-hunk cap)
//   block-N:   one hunk rewriting N consecutive lines (a reformat of a long function)
//   table-H:   a 199 KB object / dict literal (one statement, ~2,000 rows) with H
//              hunks of 12 changed numbers each: each mutant's parse check
//              falls back to that whole statement
// FINDING when one editMutants call blocks the main thread for more than
// --max-ms (default 2,500 ms, the validator budget: the longest documented
// synchronous step per proposal; the Python check stops at 10 s, JS has no bound), or
// when lexView of a 5,000-line file takes more than 300 ms (the AST budget).
//
// usage: node audit/22/sites-scale.js [--lang js,py] [--lines 5000] [--hunks 1,4,16]
//          [--block 200,1000] [--reps 3] [--max-ms 2500] [--cases uses,nums12,block,table]

const L = require('./lib');
const { editMutants } = require(L.src('rl/bug-injector'));
const { changeHunks, lexView } = require(L.src('utils/hunks'));

const LANGS = L.list('--lang', 'js,py');
const LINES = Number(L.opt('--lines', 5000));
const HUNKS = L.nums('--hunks', '1,4,16');
const BLOCK = L.nums('--block', '200,1000');
const REPS = Number(L.opt('--reps', 3));
const MAX_MS = Number(L.opt("--max-ms", 2500));
const CASES = L.list('--cases', 'uses,nums12,block,table');

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

function head(lang) { return lang === 'js' ? "'use strict';\nconst LO = 0, HI = 100;\nconst clamp = (v, a, b) => Math.min(b, Math.max(a, v));\n" : 'import re\nLO, HI = 0, 100\ndef clamp(v, a, b):\n    return min(b, max(a, v))\n\n\n'; }
const fnOf = (lang) => (lang === 'js' ? JS_FN : PY_FN);
const per = 7; // lines per function (JS 7, Python 8: close enough)

// H edited functions (every other function, one proposal's region) in the
// middle of a LINES-line file.
function spread(lang, h, edit) {
  const fn = fnOf(lang);
  const n = Math.ceil(LINES / per);
  const at = Math.floor(n / 2);
  let before = head(lang), after = before;
  for (let i = 0; i < n; i++) {
    const s = fn(i);
    before += s;
    after += (i >= at && i < at + 2 * h && (i - at) % 2 === 0) ? fn(i, edit(i)) : s;
  }
  return { before, after };
}

function block(lang, n) {
  // One function whose body is n lines; the edit rewrites every line.
  const fn = fnOf(lang);
  const fill = Math.ceil(LINES / per);
  let before = head(lang), after = before;
  for (let i = 0; i < fill / 2; i++) { const s = fn(i); before += s; after += s; }
  if (lang === 'js') {
    before += 'function big(a) {\n  let x = 0;\n'; after += 'function big(a) {\n  let x = 0;\n';
    for (let k = 0; k < n; k++) { before += `  x = x + a * ${k};\n`; after += `  x += a * ${k};\n`; }
    before += '  return x;\n}\n'; after += '  return x;\n}\n';
  } else {
    before += 'def big(a):\n    x = 0\n'; after += 'def big(a):\n    x = 0\n';
    for (let k = 0; k < n; k++) { before += `    x = x + a * ${k}\n`; after += `    x += a * ${k}\n`; }
    before += '    return x\n\n\n'; after += '    return x\n\n\n';
  }
  for (let i = Math.ceil(fill / 2); i < fill; i++) { const s = fn(i); before += s; after += s; }
  return { before, after };
}

function table(lang, h) {
  // Rows of 12 numbers, as many as fit file-discovery's 200,000-byte cap.
  const rows = Math.min(LINES, Math.floor(199_000 / (lang === 'js' ? 95 : 100)));
  const at = Math.floor(rows / 2);
  const row = (i, alt) => {
    const v = Array.from({ length: 12 }, (_, k) => (alt ? i * 13 + k + 7 : i * 13 + k));
    return lang === 'js' ? `  k${i}: [${v.join(', ')}],\n` : `    'k${i}': [${v.join(', ')}],\n`;
  };
  let before = lang === 'js' ? "'use strict';\nconst TABLE = {\n" : 'TABLE = {\n', after = before;
  for (let i = 0; i < rows; i++) {
    before += row(i, false);
    after += row(i, i >= at && i < at + 2 * h && (i - at) % 2 === 0);
  }
  const tail = lang === 'js' ? '};\nmodule.exports = { TABLE };\n' : '}\n';
  return { before: before + tail, after: after + tail };
}

console.log(`lexView / changeHunks / editMutants, ~${LINES}-line files, ${REPS} reps (main thread blocked for each call)`);
const W = [4, 12, 8, 11, 11, 11, 9, 7, 9, 22];
console.log(L.row(['lang', 'case', 'KB', 'lexView_ms', 'hunks_ms', 'mutants_p50', 'max_ms', 'hunks', 'mutants', 'result'], W));
for (const lang of LANGS) {
  const file = lang === 'js' ? 'src/m.js' : 'pkg/m.py';
  const plang = lang === 'js' ? 'javascript' : 'python';
  const run = (name, { before, after }) => {
    const lv = L.timeIt(() => lexView(after, plang), REPS);
    const ch = L.timeIt(() => changeHunks(before, after, file), REPS);
    const em = L.timeIt(() => editMutants(after, { start: 0, end: after.length, file, max: 3, before, timeoutMs: 10_000 }), REPS);
    const r = em.r;
    const res = r.capped ? 'capped' : r.unchecked ? 'unchecked' : r.uncovered ? `uncovered ${r.uncovered.text}` : r.unmutated_ref ? `unmutated_ref ${r.unmutated_ref.name}` : `${new Set(r.map(m => `${m.site}${m.revert ? 'r' : ''}`)).size} sites`;
    console.log(L.row([lang, name, L.fmt(after.length / 1024), L.fmt(lv.ms.p50), L.fmt(ch.ms.p50), L.fmt(em.ms.p50), L.fmt(em.ms.max), ch.r.length, r.length, res], W));
    L.check(`${lang} ${name}: editMutants blocks <= ${MAX_MS} ms`, em.ms.max <= MAX_MS, `${L.fmt(em.ms.max)} ms`);
    if (name === 'uses-1') L.check(`${lang}: lexView of a ${LINES}-line file <= 300 ms`, lv.ms.max <= 300, `${L.fmt(lv.ms.max)} ms`);
  };
  if (CASES.includes('uses')) {
    for (const h of HUNKS) run(`uses-${h}`, spread(lang, h, (i) => (lang === 'js' ? `return clamp(t, LO, HI) + ${i};` : `return clamp(t, LO, HI) + ${i}`)));
  }
  if (CASES.includes('nums12')) {
    for (const h of HUNKS) run(`nums12-${h}`, spread(lang, h, (i) => `return [${Array.from({ length: 12 }, (_, k) => i + k + 1).join(', ')}]${lang === 'js' ? ';' : ''}`));
  }
  if (CASES.includes('block')) for (const n of BLOCK) run(`block-${n}`, block(lang, n));
  if (CASES.includes('table')) for (const h of HUNKS) run(`table-${h}`, table(lang, h));
}
L.finish();
