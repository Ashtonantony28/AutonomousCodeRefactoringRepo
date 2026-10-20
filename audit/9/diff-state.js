#!/usr/bin/env node
'use strict';

// SG15 module-state comparison cost. After every call the worker serialises
// args, `this`, every non-function export (<= 20,000 nodes each) and the
// module-scope bindings (<= 5,000 nodes) on both sides. This script puts
// growing data next to a small edited function and reports the verdict,
// runs, duration and main-thread time of diffTesting.run, for a
// behaviour-preserving edit (`x * 2` -> `x + x`).
//
// usage: node audit/9/diff-state.js [--case PREFIX] [--repeat 3] [--contend N]

const L = require('./lib');
const dt = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const only = opt('--case', '');
const REPEAT = Number(opt('--repeat', 3));
const CONTEND = Number(opt('--contend', 0));

const FN = 'function twice(x) {\n  if (typeof x !== \'number\') return 0;\n  return x * 2;\n}\n';
const nums = (n) => `[${Array.from({ length: n }, (_, i) => i).join(',')}]`;
const objs = (n) => `{${Array.from({ length: n }, (_, i) => `k${i}: { id: ${i}, name: 'n${i}' }`).join(',')}}`;

const CASES = [
  ['control: no data', FN + 'module.exports = { twice };\n'],
  ['exported array 1,000 numbers', FN + `const TABLE = ${nums(1000)};\nmodule.exports = { twice, TABLE };\n`],
  ['exported array 5,000 numbers', FN + `const TABLE = ${nums(5000)};\nmodule.exports = { twice, TABLE };\n`],
  ['exported array 19,000 numbers', FN + `const TABLE = ${nums(19000)};\nmodule.exports = { twice, TABLE };\n`],
  ['exported array 25,000 numbers', FN + `const TABLE = ${nums(25000)};\nmodule.exports = { twice, TABLE };\n`],
  ['exported object 2,000 records', FN + `const BY_ID = ${objs(2000)};\nmodule.exports = { twice, BY_ID };\n`],
  ['exported object 7,000 records', FN + `const BY_ID = ${objs(7000)};\nmodule.exports = { twice, BY_ID };\n`],
  ['module binding 1,000 records', FN + `const CACHE = ${objs(1000)};\nmodule.exports = { twice, size: () => Object.keys(CACHE).length };\n`],
  ['module binding 2,000 records', FN + `const CACHE = ${objs(2000)};\nmodule.exports = { twice, size: () => Object.keys(CACHE).length };\n`],
  ['module Map 50,000 entries', FN + `const M = new Map(); for (let i = 0; i < 50000; i++) M.set(i, i);\nmodule.exports = { twice, get: (k) => M.get(k) };\n`]
];

const W = [34, 9, 14, 6, 9, 60];
const row = (c) => c.map((x, i) => String(x).padEnd(W[i] || 10)).join(' ');
console.log(`diffTesting.run, edit \`x * 2\` -> \`x + x\` in a small function next to module data; ${CONTEND} busy processes`);
console.log(row(['case', 'KB', 'verdicts', 'runs', 'p50_ms', 'reason (last)']));
const stop = CONTEND ? L.contend(CONTEND) : () => {};
try {
  for (const [name, file] of CASES) {
    if (only && !name.startsWith(only)) continue;
    const cur = 'function twice(x) {\n  if (typeof x !== \'number\') return 0;\n  return x * 2;\n}\n';
    const prop = cur.replace('x * 2', 'x + x');
    const verdicts = {};
    const ms = [];
    let last = null;
    for (let i = 0; i < REPEAT; i++) {
      const t0 = performance.now();
      last = dt.run({ currentSrc: cur, proposedSrc: prop, fileSrc: file, functionName: 'twice' });
      ms.push(performance.now() - t0);
      verdicts[last.verdict] = (verdicts[last.verdict] || 0) + 1;
    }
    const s = L.stats(ms);
    console.log(row([name, (file.length / 1024).toFixed(0), Object.entries(verdicts).map(([k, v]) => `${k.slice(0, 5)}:${v}`).join(','), last.runs, L.fmt(s.p50), String(last.reason || '').slice(0, 110)]));
  }
} finally {
  stop();
}
