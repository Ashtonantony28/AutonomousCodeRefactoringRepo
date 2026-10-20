#!/usr/bin/env node
'use strict';

// Differential test time and verdict vs module size, for the 500-file
// fixture's edit shape ("inline the temporary" in one small function of a
// module made of many such functions), JS (diff-prep worker + sandbox worker)
// and Python (py_diff_harness.py: parse, plan, three forked sides sharing a
// 1,500 ms budget). The edit preserves behaviour, so anything but
// `equivalent` is a false rejection at the gate (inconclusive -> critic_rejected).
// The function under edit has a branch on a mined literal, as real code does.
//
// usage: node audit/14/diff-size.js [--lang js,py] [--kb 5,25,50,100,150,199]
//          [--reps 5] [--contend 0]

const L = require('./lib');
const diffTesting = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const LANGS = opt('--lang', 'js,py').split(',');
const KBS = opt('--kb', '5,25,50,100,150,199').split(',').map(Number);
const REPS = Number(opt('--reps', 5));
const CONTEND = Number(opt('--contend', 0));

const SHAPES = {
  js: {
    file: 'src/mod.js',
    fn: (j) => `function f_${j}(a, b) {\n  const t${j} = a * ${j % 50} + b;\n  return t${j};\n}\n`,
    head: "'use strict';\n",
    tail: (n) => `module.exports = { ${Array.from({ length: Math.min(n, 50) }, (_, j) => `f_${j}`).join(', ')} };\n`,
    cur: "function target(a, b) {\n  const t = a * 7 + b;\n  if (t > 100) {\n    return t - 100;\n  }\n  return t;\n}\n",
    prop: "function target(a, b) {\n  const t = a * 7 + b;\n  if (t > 100) return t - 100;\n  return t;\n}\n"
  },
  py: {
    file: 'pkg/mod.py',
    fn: (j) => `def f_${j}(a, b):\n    t${j} = a * ${j % 50} + b\n    return t${j}\n\n\n`,
    head: '"""generated"""\n\n\n',
    tail: () => '',
    cur: 'def target(a, b):\n    t = a * 7 + b\n    if t > 100:\n        return t - 100\n    return t\n',
    prop: 'def target(a, b):\n    t = a * 7 + b\n    return t - 100 if t > 100 else t\n'
  }
};

function module(lang, kb) {
  const s = SHAPES[lang];
  let body = s.head;
  let j = 0;
  const half = Math.floor(kb * 1024 / 2);
  while (body.length < half) body += s.fn(j++);
  body += s.cur + (lang === 'py' ? '\n\n' : '');
  while (body.length < kb * 1024) body += s.fn(j++);
  return body + s.tail(j);
}

let stop = () => {};
if (CONTEND) stop = L.contend(CONTEND);
console.log(`diffTesting.run, behaviour-preserving edit in a module of K KB; ${CONTEND} busy processes; budget p95 2,000 ms, hard kill 3,000 ms`);
console.log(L.row(['lang', 'KB', 'p50_ms', 'p95_ms', 'max_ms', 'verdicts', 'runs', 'reason (last non-equivalent)'], [5, 5, 8, 8, 8, 24, 6, 80]));
try {
  for (const lang of LANGS) {
    for (const kb of KBS) {
      const fileSrc = module(lang, kb);
      const ms = [];
      const verdicts = {};
      let runs = 0, reason = '';
      for (let r = 0; r < REPS; r++) {
        const t0 = performance.now();
        const res = diffTesting.run({ currentSrc: SHAPES[lang].cur, proposedSrc: SHAPES[lang].prop, fileSrc, file: SHAPES[lang].file });
        ms.push(performance.now() - t0);
        verdicts[res.verdict] = (verdicts[res.verdict] || 0) + 1;
        runs = res.runs;
        if (res.verdict !== 'equivalent') reason = String(res.reason || '').slice(0, 80);
      }
      const st = L.stats(ms);
      console.log(L.row([lang, kb, L.fmt(st.p50), L.fmt(st.p95), L.fmt(st.max), JSON.stringify(verdicts), runs, reason], [5, 5, 8, 8, 8, 24, 6, 80]));
    }
  }
} finally {
  stop();
}
