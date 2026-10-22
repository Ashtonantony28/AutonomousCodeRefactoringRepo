#!/usr/bin/env node
'use strict';

// SG37 added `structural(a, text)` to bug-injector uncoveredToken: for every
// inserted `;` / `,` token it inspects the code before the token.
//   JS `;`:  /\b(?:else|do)$/ on code.slice(0, p + 1) and
//            /\b(?:if|for|while)\s*$/ on code.slice(0, open paren): an
//            unanchored-start regex over the whole prefix of the file.
//   Python `,`: a backward character scan to the enclosing open bracket (to
//            offset 0 at statement level), then the head regexes on the
//            whole prefix.
// So each separator costs O(offset in file): O(separators x file size) per
// mutant phase (synchronous, on the executor's event loop).
// SG37 also dropped `inside()` from bracket / indentation cover.
//
// Fixture: a file of filler functions (--kb sizes) ending in a function with
// 16 inserted hunks of statements (JS `c = d;` x6 per hunk, Python
// `c, d = d, c` x5 per hunk: one separator or two per statement, every
// statement with use sites, under the 12-site cap). editMutants is timed on
// the current src and on the pre-SG37 src (--old-rev, default 3ea49df).
// FINDING when the current editMutants is more than 2x and 500 ms slower
// than pre-SG37, or over 10 s (its parse-check limit) for a file the old
// code checks in less.
//
// usage: node audit/29/struct-scale.js [--lang js,py] [--kb 100,500,2000] [--hunks 16] [--reps 2] [--old-rev 3ea49df]

const L = require('./lib');

const LANGS = L.list('--lang', 'js,py');
const KB = L.nums('--kb', '100,500,2000');
const HUNKS = Number(L.opt('--hunks', 16));
const REPS = Number(L.opt('--reps', 2));
const REV = L.opt('--old-rev', '3ea49df');

function fixture(lang, kb) {
  const js = lang === 'js';
  const fill = [];
  let size = 0;
  for (let i = 0; size < kb * 1024; i++) {
    const f = js ? `function f${i}(a, b) {\n  const t = [a, b, ${i}];\n  return t[0] + t[1] * ${i};\n}\n` : `def f${i}(a, b):\n    t = [a, b, ${i}]\n    return t[0] + t[1] * ${i}\n\n`;
    fill.push(f);
    size += f.length;
  }
  const body = [], edited = [];
  if (js) {
    body.push('function g(a, b) {', '  let c = a, d = b, e = 0;');
    edited.push(...body);
    for (let h = 0; h < HUNKS; h++) {
      body.push(`  // h${h}`, '  e += 1;');
      edited.push(`  // h${h}`, '  c = d; d = c; c = d; d = c; c = d; d = c;', '  e += 1;');
    }
    body.push('  return c + d + e;', '}', 'module.exports = { g };');
    edited.push('  return c + d + e;', '}', 'module.exports = { g };');
  } else {
    body.push('def g(a, b):', '    c, d, e = a, b, 0');
    edited.push(...body);
    for (let h = 0; h < HUNKS; h++) {
      body.push(`    # h${h}`, '    e += 1');
      edited.push(`    # h${h}`, ...Array(5).fill('    c, d = d, c'), '    e += 1');
    }
    body.push('    return c + d + e');
    edited.push('    return c + d + e');
  }
  const head = fill.join('');
  return { before: head + body.join('\n') + '\n', edited: head + edited.join('\n') + '\n', file: js ? 'src/big.js' : 'pkg/big.py' };
}

const oldDir = L.srcAt(REV);
const impl = {
  old: require(L.path.join(oldDir, 'src/rl/bug-injector')).editMutants,
  cur: require(L.src('rl/bug-injector')).editMutants
};
const shape = (r) => (Array.isArray(r) ? (r.capped ? 'capped' : r.unchecked ? 'unchecked' : r.uncovered ? 'uncovered' : r.unmutated_ref ? 'unmutated_ref' : `${r.length} mutants`) : String(r));

console.log(`editMutants, ${HUNKS} inserted hunks at the end of the file; pre-SG37 = ${REV}`);
console.log('lang  size      old            cur            cur/old');
for (const lang of LANGS) {
  if (lang === 'py') L.pyPath();
  for (const kb of KB) {
    const f = fixture(lang, kb);
    const t = { old: [], cur: [] }, res = {};
    for (let i = 0; i < REPS; i++) {
      for (const k of ['old', 'cur']) {
        const t0 = performance.now();
        res[k] = impl[k](f.edited, { file: f.file, before: f.before, max: 3 });
        t[k].push(performance.now() - t0);
      }
    }
    const o = L.median(t.old), c = L.median(t.cur);
    console.log(`${lang.padEnd(5)} ${String(Math.round(f.edited.length / 1024)).padStart(5)} KB  ${L.ms(o).padEnd(9)} ${shape(res.old).slice(0, 14).padEnd(14)} ${L.ms(c).padEnd(9)} ${shape(res.cur).slice(0, 14).padEnd(14)} ${(c / o).toFixed(2)}`);
    L.check(`${lang} ${kb} KB: editMutants within 2x / 500 ms of pre-SG37`, !(c > 2 * o && c - o > 500), `${Math.round(o)} -> ${Math.round(c)} ms`);
    L.check(`${lang} ${kb} KB: editMutants under its 10 s limit where pre-SG37 is`, !(c > 10_000 && o <= 10_000), `${Math.round(o)} -> ${Math.round(c)} ms`);
  }
}
L.rm(oldDir);
L.finish();
