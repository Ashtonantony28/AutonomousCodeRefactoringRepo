#!/usr/bin/env node
'use strict';

// SG20 diff-prep worker: the JS diff test now parses, locates targets and
// builds inputs in a worker (512 MB heap) that runs the sandbox worker, all
// inside the 3 s hard kill, while the main thread waits (Atomics.wait).
// Measures (a) fixed cost: a trivial snippet edit, p50/p95; (b) adversarial
// <= 200 KB files: wall time (= main-thread block), verdict, peak RSS;
// (c) leaks over repeated hard kills / timeouts: threads, FDs, RSS before and
// after N runs.
//
// usage: node audit/14/diff-prep.js [--parts a,b,c] [--reps 20] [--kills 30]

const L = require('./lib');
const diffTesting = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const PARTS = opt('--parts', 'a,b,c').split(',');
const REPS = Number(opt('--reps', 20));
const KILLS = Number(opt('--kills', 30));

const EDIT_CUR = 'function target(a, b) {\n  const t = a * 7 + b;\n  return t;\n}\n';
const EDIT_PROP = 'function target(a, b) {\n  return a * 7 + b;\n}\n';
const pad = (s, kb, filler) => { let out = s; while (out.length < kb * 1024) out += filler(out.length); return out; };

function timeRun(o) {
  const t0 = performance.now();
  const r = diffTesting.run(o);
  return { ms: performance.now() - t0, r };
}

if (PARTS.includes('a')) {
  const ms = [];
  let v = '';
  for (let i = 0; i < REPS; i++) { const { ms: m, r } = timeRun({ currentSrc: EDIT_CUR, proposedSrc: EDIT_PROP }); ms.push(m); v = r.verdict; }
  const st = L.stats(ms);
  console.log(`(a) trivial snippet edit x${REPS}: p50 ${L.fmt(st.p50)} p95 ${L.fmt(st.p95)} max ${L.fmt(st.max)} ms, verdict ${v}`);
}

if (PARTS.includes('b')) {
  const cases = [
    ['190 KB string literal next to edit', `const BIG = '${'x'.repeat(190_000)}';\n${EDIT_CUR}module.exports = { target, BIG };\n`],
    ['50k-number array literal (exported)', `const T = [${Array.from({ length: 30000 }, (_, i) => i % 997).join(',')}];\n${EDIT_CUR}module.exports = { target, T };\n`],
    ['nesting depth 2,000 (array literal)', `const D = ${'['.repeat(2000)}1${']'.repeat(2000)};\n${EDIT_CUR}module.exports = { target, D };\n`],
    ['nesting depth 1,000 (if blocks in target)', `function target(a, b) {\n${'if (a > 0) {\n'.repeat(1000)}a = a - 1;\n${'}\n'.repeat(1000)}  const t = a * 7 + b;\n  return t;\n}\nmodule.exports = { target };\n`, `function target(a, b) {\n${'if (a > 0) {\n'.repeat(1000)}a = a - 1;\n${'}\n'.repeat(1000)}  return a * 7 + b;\n}\nmodule.exports = { target };\n`],
    ['5,000 functions, 1 changed', pad(EDIT_CUR, 199, (n) => `function g${n}(a) { return a + ${n % 13}; }\n`) + 'module.exports = { target };\n'],
    ['minified 190 KB single line', EDIT_CUR + pad('', 190, (n) => `function m${n}(a){return a+${n % 7}}`) + '\nmodule.exports = { target };\n'],
    ['3,000 regex literals', pad(EDIT_CUR, 150, (n) => `const r${n} = /a${n % 10}b+c*/g;\n`) + 'module.exports = { target };\n'],
    ['console.log of a 5,000-element array per call (SG18)', 'const ROWS = Array.from({ length: 5000 }, (_, i) => ({ i, s: String(i) }));\nfunction target(a, b) {\n  console.log(ROWS);\n  const t = a * 7 + b;\n  return t;\n}\nmodule.exports = { target };\n', 'const ROWS = Array.from({ length: 5000 }, (_, i) => ({ i, s: String(i) }));\nfunction target(a, b) {\n  console.log(ROWS);\n  return a * 7 + b;\n}\nmodule.exports = { target };\n'],
    ['returns a 5,000-key frozen object (SG18 metadata)', 'function target(a, b) {\n  const o = {};\n  for (let i = 0; i < 5000; i++) Object.defineProperty(o, \'k\' + i, { value: a + i, enumerable: i % 2 === 0 });\n  const t = Object.freeze(o);\n  return t;\n}\nmodule.exports = { target };\n', 'function target(a, b) {\n  const o = {};\n  for (let i = 0; i < 5000; i++) Object.defineProperty(o, \'k\' + i, { value: a + i, enumerable: i % 2 === 0 });\n  return Object.freeze(o);\n}\nmodule.exports = { target };\n'],
    ['8 changed targets, 2,000-literal pool', (() => {
      let s = `const LIT = [${Array.from({ length: 2000 }, (_, i) => i * 3).join(',')}];\n`;
      for (let k = 0; k < 8; k++) s += `function t${k}(a, b, c, d) {\n  const t = a * ${k} + b - c + d;\n  return t;\n}\n`;
      return s + `module.exports = { ${Array.from({ length: 8 }, (_, k) => `t${k}`).join(', ')}, LIT };\n`;
    })(), null, true]
  ];
  console.log('(b) adversarial files (wall = main-thread block)');
  console.log(L.row(['case', 'KB', 'ms', 'verdict', 'runs', 'peakMB', 'reason'], [44, 6, 8, 13, 6, 8, 80]));
  for (const [label, fileSrc, propFile, multi] of cases) {
    let cur = EDIT_CUR, prop = EDIT_PROP;
    if (propFile) { cur = fileSrc; prop = propFile; }
    if (multi) { cur = fileSrc.slice(fileSrc.indexOf('function t0'), fileSrc.indexOf('module.exports')); prop = cur.replace(/const t = (.*);\n  return t;/g, 'return $1;'); }
    const { ms, r } = timeRun({ currentSrc: cur, proposedSrc: prop, fileSrc, file: 'src/adv.js' });
    console.log(L.row([label, (fileSrc.length / 1024).toFixed(0), L.fmt(ms), r.verdict, r.runs, L.fmt(L.hwmMb()), String(r.reason || '').slice(0, 80)], [44, 6, 8, 13, 6, 8, 80]));
  }
}

if (PARTS.includes('c')) (async () => {
  const hang = 'function target(a, b) {\n  for (;;) {}\n}\n';
  const hang2 = 'function target(a, b) {\n  for (;;) { b++; }\n}\n';
  const loadHang = 'for (;;) {}\nfunction target(a) { return a; }\n';
  const b0 = { t: L.threads(), f: L.fds(), rss: L.rssMb() };
  const ms = [];
  const verdicts = {};
  for (let i = 0; i < KILLS; i++) {
    const o = i % 2 ? { currentSrc: hang, proposedSrc: hang2 } : { currentSrc: loadHang, proposedSrc: loadHang.replace('return a', 'return a + 0'), fileSrc: loadHang, file: 'x.js' };
    const { ms: m, r } = timeRun(o);
    ms.push(m);
    const k = `${r.verdict}: ${String(r.reason || '').replace(/\d+/g, 'N').slice(0, 60)}`;
    verdicts[k] = (verdicts[k] || 0) + 1;
  }
  await new Promise(r => setTimeout(r, 2000)); // let terminated workers exit
  const a0 = { t: L.threads(), f: L.fds(), rss: L.rssMb() };
  const st = L.stats(ms);
  console.log(`(c) ${KILLS} timeout/hard-kill runs: p50 ${L.fmt(st.p50)} max ${L.fmt(st.max)} ms; threads ${b0.t} -> ${a0.t}, fds ${b0.f} -> ${a0.f}, rss ${L.fmt(b0.rss)} -> ${L.fmt(a0.rss)} MB`);
  for (const [k, n] of Object.entries(verdicts)) console.log(`    ${n} x ${k}`);
})();
