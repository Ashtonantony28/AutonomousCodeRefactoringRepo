#!/usr/bin/env node
'use strict';

// Adversarial anchors against the bounded matcher (SG10) in
// src/runner/anchor-matcher.js, via applyEdit (budget p95 100 ms, files
// <= 200 KB; SG10 accept: worst case < 1 s). Each case targets one piece of
// the pruning:
//   gram-collide-*  q-gram bound uses 16-bit hashed 3-grams; a large anchor
//                   fills most buckets, so every window passes pass 1, then
//                   each candidate is rejected by the bag bound in evaluate()
//                   after O(window) key/window/bag work that the cell cap
//                   does not count -> O(lines x anchor) uncapped
//   indent-dup-*    indent-shift tier: identical lines, anchor indented
//                   differently -> every start line is checked over the whole
//                   anchor (no occurrence cap at this tier)
//   ws-region-*     whitespace tier + regionHazard lexing a 199 KB region
//   regex-scan      regionHazard's regex scan restarts at every '/' after
//                   punctuation inside an unterminated class (invalid JS)
//   fuzzy-cap       many distinct near-identical windows: Levenshtein cell cap
//
// usage: node audit/6/anchor-adversarial.js [--case NAME] [--reps 3]

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const args = process.argv.slice(2);
const REPS = Number(args[args.indexOf('--reps') + 1]) || 3;
const ONLY = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;

L.isolateState('anchor6');
const { applyEdit } = require(L.src('runner/reverter'));

const SIZE = 199_000;
const r = L.rng(11);
const word = (alpha, n) => Array.from({ length: n }, () => alpha[Math.floor(r() * alpha.length)]).join('');
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function linesOf(alpha, lineLen, bytes) {
  const out = [];
  let n = 0;
  while (n + lineLen + 1 <= bytes) { const l = `  x_${word(alpha, lineLen - 6)};`; out.push(l); n += l.length + 1; }
  return out;
}

const CASES = [];
const add = (name, src, anchor, note = '') => CASES.push({ name, src, anchor, note });

for (const [anchorKB, lineLen] of [[30, 60], [60, 60], [100, 60], [60, 16], [100, 16]]) {
  const anchor = linesOf(LOWER, lineLen, anchorKB * 1000).join('\n');
  const hay = linesOf(UPPER, lineLen, SIZE).join('\n') + '\n';
  add(`gram-collide-${anchorKB}KB-anchor-${lineLen}ch-lines`, hay, anchor);
}
for (const n of [100, 500, 2000, 6000, 9000]) {
  const hay = '    x = x + 1;\n'.repeat(Math.floor(SIZE / 15));
  add(`indent-dup-${n}-lines`, hay, 'x = x + 1;\n'.repeat(n).trimEnd());
}
{
  // 199 KB of ordinary code; anchor = the whole file with every line break
  // turned into a space (one long line) -> whitespace tier + regionHazard
  let src = "'use strict';\n"; let j = 0;
  while (src.length + 200 < SIZE) src += L.fnText(0, j++);
  add('ws-region-199KB', src, src.trim().replace(/\n\s*/g, ' '));
  add('ws-region-100KB', src, src.slice(0, 100_000).slice(0, src.slice(0, 100_000).lastIndexOf('}\n') + 1).trim().replace(/\n\s*/g, '  '));
}
{
  const unit = '(/[';
  const line = 'x = ' + unit.repeat(Math.floor((SIZE / 2 - 10) / unit.length));
  add(`regex-scan-${Math.round(line.length / 1000)}KB-line`, line + '\n', line.replace('x = ', 'x  =  '));
}
{
  let src = ''; let i = 0;
  while (src.length < SIZE - 40) src += `  total = total + item${i++} * 3;\n`;
  const lines = src.split('\n');
  const anchor = lines.slice(3000, 3200).map(l => l.replace('* 3', '* 4')).join('\n');
  add('fuzzy-cap-200-lines-distinct-near-dups', src, anchor);
}

const dir = L.tmpDir('anchor6');
console.log(L.row(['case', 'p50_ms', 'max_ms', 'result', 'budget'], [44, 10, 10, 40, 8]));
for (const c of CASES) {
  if (ONLY && !c.name.startsWith(ONLY)) continue;
  const f = path.join(dir, 'big.js');
  const xs = [];
  let result = '';
  for (let k = 0; k < REPS; k++) {
    fs.writeFileSync(f, c.src);
    const t = performance.now();
    try {
      const e = applyEdit({ repoRoot: dir, relPath: 'big.js', currentCode: c.anchor, proposedCode: 'function replaced() {}' });
      result = `ok:${e.matchTier}`;
    } catch (err) { result = `throw:${err.tier || '?'}:${(err.detail && err.detail.reason) || err.message.slice(0, 24)}`; }
    xs.push(performance.now() - t);
  }
  const s = L.summarize(xs);
  console.log(L.row([c.name, L.fmt(s.p50), L.fmt(s.max), result.slice(0, 40), 100], [44, 10, 10, 40, 8]));
}
L.rm(dir);
