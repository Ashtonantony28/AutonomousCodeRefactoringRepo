#!/usr/bin/env node
'use strict';

// SG25 Python deletion probes: chained-comparison tails, later comprehension
// iterables and `match` guards are now probe sites (py_diff_harness.probe:
// `tail()` scans a Compare's comparators / a comprehension's generators at
// every node of every deleted range's descent). Each case deletes K token
// stretches of that shape in one function of a ~50 KB module and times
// diffTesting.run (budget p95 2,000 ms, hard kill 3,000 ms).
// FINDING when a case exceeds 2,000 ms or ends in a hard kill.
//
// usage: node audit/17/py-probes.js [--k 10,100,300] [--chain 20,200] [--pad-kb 50] [--reps 3] [--contend 0]

const L = require('./lib');
const diffTesting = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const KS = opt('--k', '10,100,300').split(',').map(Number);
const CHAIN = opt('--chain', '20,200').split(',').map(Number);
const PAD_KB = Number(opt('--pad-kb', 50));
const REPS = Number(opt('--reps', 3));
const CONTEND = Number(opt('--contend', 0));

const fn = (name, body) => `def ${name}(a, b):\n    t = 0\n${body}    return t\n`;
const shapes = {
  // `0 <= a < b < 10 ** 9` -> `0 <= a < b` (tail of a chained comparison)
  chained: (k) => [
    fn('target', Array.from({ length: k }, (_, i) => `    if 0 <= a < b + ${i} < 10 ** 9:\n        t += ${i % 7}\n`).join('')),
    fn('target', Array.from({ length: k }, (_, i) => `    if 0 <= a < b + ${i}:\n        t += ${i % 7}\n`).join(''))],
  // second generator's iterable `range(b + 0)` -> `range(b)`
  comprehension: (k) => [
    fn('target', Array.from({ length: k }, (_, i) => `    t += sum([x * y for x in range(a % 4) for y in range(b % 4 + 0) if x != ${i % 3}])\n`).join('')),
    fn('target', Array.from({ length: k }, (_, i) => `    t += sum([x * y for x in range(a % 4) for y in range(b % 4) if x != ${i % 3}])\n`).join(''))],
  // `case n if n > i and True:` -> `case n if n > i:` (match guard)
  match: (k) => [
    `def target(a, b):\n    match a:\n${Array.from({ length: k }, (_, i) => `        case ${i} if b > ${i % 5} and True:\n            return ${i}\n`).join('')}        case _:\n            return -1\n`,
    `def target(a, b):\n    match a:\n${Array.from({ length: k }, (_, i) => `        case ${i} if b > ${i % 5}:\n            return ${i}\n`).join('')}        case _:\n            return -1\n`]
};
// One chained comparison of N comparators, its last tail deleted.
const longChain = (n) => [
  `def target(a, b):\n    if b < ${Array.from({ length: n }, (_, i) => `a + ${i}`).join(' < ')} < a + ${n} + 1:\n        return 1\n    return 0\n`,
  `def target(a, b):\n    if b < ${Array.from({ length: n }, (_, i) => `a + ${i}`).join(' < ')}:\n        return 1\n    return 0\n`];

let pad = '';
for (let i = 0; pad.length < PAD_KB * 1024; i++) pad += `def g${i}(a, b):\n    t = a * ${i % 9} - b\n    if t > ${i % 50}:\n        return t - 1\n    return t\n\n\n`;

const cases = [];
for (const [name, mk] of Object.entries(shapes)) for (const k of KS) cases.push([`${name} x${k}`, ...mk(k)]);
for (const n of CHAIN) cases.push([`one chain of ${n} comparators`, ...longChain(n)]);

const stop = CONTEND ? L.contend(CONTEND) : () => {};
console.log(`Python diffTesting.run, deletions in one function of a ${PAD_KB} KB module; ${CONTEND} busy processes`);
console.log(L.row(['case', 'p50_ms', 'max_ms', 'verdict', 'runs', 'deletions_observed', 'reason'], [30, 8, 8, 13, 5, 19, 70]));
try {
  for (const [label, cur, prop] of cases) {
    const fileSrc = '"""m"""\n' + pad + cur + '\n';
    const ms = [];
    let r;
    for (let i = 0; i < REPS; i++) {
      const t0 = performance.now();
      r = diffTesting.run({ currentSrc: cur, proposedSrc: prop, fileSrc, file: 'pkg/m.py' });
      ms.push(performance.now() - t0);
    }
    const max = Math.max(...ms);
    console.log(L.row([label, L.fmt(L.median(ms)), L.fmt(max), r.verdict, r.runs, String(r.deletions_observed), String(r.reason || '').slice(0, 70)], [30, 8, 8, 13, 5, 19, 70]));
    L.check(`${label}: within 2,000 ms, no hard kill`, max <= 2000 && !/hard kill/.test(r.reason || ''), `${L.fmt(max)} ms ${r.verdict}`);
  }
} finally {
  stop();
}
L.finish();
