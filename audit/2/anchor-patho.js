#!/usr/bin/env node
'use strict';

// Pathological anchors for src/runner/anchor-matcher.js via applyEdit
// (budget p95 100 ms for files <= 200 KB). Every haystack is ~199 KB.
// Anchors are made to miss tiers 1-3 (one token differs or whitespace is
// re-flowed) so the fuzzy tier runs, which is the expensive one.
//
// usage: node audit/2/anchor-patho.js [--reps 3]

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const REPS = Number(process.argv[process.argv.indexOf('--reps') + 1]) || 3;
L.isolateState('anchor');
const { applyEdit } = require(L.src('runner/reverter'));
const { findAnchor } = require(L.src('runner/anchor-matcher'));

const SIZE = 199_000;
const dir = L.tmpDir('anchor');

function fill(unit) {
  let s = '';
  let i = 0;
  while (s.length + unit(i).length <= SIZE) s += unit(i++);
  return { src: s, n: i };
}

// Near-duplicate function blocks of `lines` lines each; block i differs from
// block j only in its numeric suffix.
const block = (lines) => (i) => {
  let b = `function g${i}(a, b) {\n`;
  for (let k = 0; k < lines - 2; k++) b += `  const v${k} = a + b * ${k} - ${i % 10};\n`;
  return b + '}\n';
};

const CASES = [];
function add(name, src, anchor, expect) { CASES.push({ name, src, anchor, expect }); }

{ // 1. control: exact match of a short anchor
  const { src, n } = fill(block(4));
  const k = Math.floor(n / 2);
  add('exact short (control)', src, block(4)(k).trimEnd(), 'ok');
}
for (const lines of [10, 50, 200, 1000]) {
  // 2. long anchor, whitespace reflowed + one token changed -> fuzzy tier,
  //    199 KB of near-duplicate blocks (each scores close to the anchor)
  const { src, n } = fill(block(lines));
  const k = Math.max(0, n - 2);
  const anchor = block(lines)(k).replace(/  const v0 = a \+ b/, '  const v0 = a - b').replace(/\n {2}/g, '\n    ');
  add(`fuzzy near-dup ${lines}-line anchor (${(anchor.length / 1000).toFixed(1)} KB, ${n} blocks)`, src, anchor, 'throw');
}
{ // 3. anchor longer than half the file, re-indented (indent-shift misses because one line differs)
  const { src } = fill(block(20));
  const half = src.slice(0, Math.floor(src.length / 2));
  const anchor = half.slice(0, half.lastIndexOf('\n}\n') + 2).replace(/\n {2}/g, '\n\t').replace('a + b * 3', 'a + b * 4');
  add(`fuzzy anchor = half the file (${(anchor.length / 1000).toFixed(0)} KB)`, src, anchor, 'throw');
}
{ // 4. highly repetitive single-line haystack, overlapping exact matches
  const src = 'a'.repeat(SIZE);
  add('exact, 1 KB "aaaa" anchor in 199 KB "aaaa" (overlapping)', src, 'a'.repeat(1000), 'throw');
}
{ // 5. many identical lines, anchor of identical lines with one changed line
  const src = 'x = x + 1;\n'.repeat(Math.floor(SIZE / 11));
  const lines = Array(300).fill('x = x + 1;');
  lines[150] = 'x = x + 2;';
  add('fuzzy 300 identical lines, 1 changed, in 18k identical lines', src, lines.join('\n'), 'throw');
}

console.log('case                                                              p50_ms   max_ms  result   budget');
const only = process.argv.includes("--case") ? Number(process.argv[process.argv.indexOf("--case") + 1]) : null;
for (const [ci, c] of CASES.entries()) {
  if (only != null && ci !== only) continue;
  const f = path.join(dir, 'big.js');
  const xs = [];
  let result = '';
  for (let r = 0; r < REPS; r++) {
    fs.writeFileSync(f, c.src);
    const t = performance.now();
    try {
      const e = applyEdit({ repoRoot: dir, relPath: 'big.js', currentCode: c.anchor, proposedCode: 'function replaced() {}' });
      result = `ok:${e.matchTier}`;
    } catch (err) { result = `throw:${err.tier || '?'}`; }
    xs.push(performance.now() - t);
  }
  const s = L.summarize(xs);
  console.log(`${c.name.padEnd(64)} ${L.fmt(s.p50).padStart(8)} ${L.fmt(s.max).padStart(8)}  ${result.padEnd(16)} 100`);
}
void findAnchor;
