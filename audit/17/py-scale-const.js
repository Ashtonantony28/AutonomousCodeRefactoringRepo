#!/usr/bin/env node
'use strict';

// Python diff test on unit-conversion code: `s * 10 ** 9` (seconds -> ns),
// `n * 2 ** 30` (GiB), `x * 1024 ** 3`, `s * NS_PER_S` (module constant). The generated inputs include strings
// and lists, so `str * 10 ** 9` builds a gigabyte per call; each such call
// runs into the 250 ms per-call timeout and the 1,500 ms budget, and the
// verdict is `inconclusive` (gate: critic_rejected). The same function with
// the folded literal (`s * 1000000000`) is judged in ~130 ms.
// Edit: "inline the temporary" (behaviour-preserving) in a 2-line function.
// FINDING when a case exceeds the 2,000 ms budget, or is not `equivalent`
// while its folded-literal twin is.
//
// usage: node audit/17/py-scale-const.js [--reps 5] [--contend 0]

const L = require('./lib');
const diffTesting = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const REPS = Number(opt('--reps', 5));
const CONTEND = Number(opt('--contend', 0));

const edit = (expr) => [`def conv(s):\n    t = ${expr}\n    return t\n`, `def conv(s):\n    return ${expr}\n`];
const CASES = [
  ['s * 10 ** 9', 's * 1000000000'],
  ['s * 2 ** 30', 's * 1073741824'],
  ['s * 1024 ** 3', 's * 1073741824'],
  ['s * 10 ** 6', 's * 1000000'],
  ['s * 1000 * 1000 * 1000', null],
  ['s * NS_PER_S', 's * 1000000000']
];
const PRELUDE = { 's * NS_PER_S': 'NS_PER_S = 1000000000\n' };

const stop = CONTEND ? L.contend(CONTEND) : () => {};
console.log(`Python diffTesting.run, inline-the-temporary edit; ${CONTEND} busy processes; budget 2,000 ms`);
console.log(L.row(['expr', 'p50_ms', 'max_ms', 'verdicts', 'reason (last)'], [26, 8, 8, 34, 70]));
try {
  const res = {};
  for (const pair of CASES) {
    for (const expr of pair.filter(Boolean)) {
      if (res[expr]) continue;
      const [cur, prop] = edit(expr);
      const ms = [], verdicts = {};
      let r;
      for (let i = 0; i < REPS; i++) {
        const t0 = performance.now();
        r = diffTesting.run({ currentSrc: cur, proposedSrc: prop, fileSrc: '"""m"""\n' + (PRELUDE[expr] || '') + cur, file: 'pkg/m.py' });
        ms.push(performance.now() - t0);
        verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
      }
      res[expr] = { max: Math.max(...ms), eq: verdicts.equivalent === REPS };
      console.log(L.row([expr, L.fmt(L.median(ms)), L.fmt(Math.max(...ms)), JSON.stringify(verdicts), String(r.reason || '').slice(0, 70)], [26, 8, 8, 34, 70]));
    }
    const [a, b] = pair;
    L.check(`${a}: diff test within 2,000 ms`, res[a].max <= 2000, `${L.fmt(res[a].max)} ms`);
    if (b) L.check(`${a}: same verdict as folded '${b}'`, res[a].eq || !res[b].eq, `${res[a].eq ? 'equivalent' : 'not equivalent'} vs ${res[b].eq ? 'equivalent' : 'not equivalent'}`);
  }
} finally {
  stop();
}
L.finish();
