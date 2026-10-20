#!/usr/bin/env node
'use strict';

// SG22 per-call state digests (diff-sandbox-worker.js smallDigest): after
// every call, on both sides, every module-scope binding present in both
// versions is looked up with a direct `eval(name)` (functions included; they
// are skipped only after the lookup), before SMALL_TOTAL stops the
// serialisation. Cost ~ bindings x calls. Module: N top-level bindings
// (`const K_i = i;` or `function g_i`) plus a small function under a
// behaviour-preserving edit. Anything but `equivalent` is a false rejection.
//
// usage: node audit/14/diff-bindings.js [--n 500,2000,5000,9000] [--kind const,function] [--contend 0] [--reps 3]

const L = require('./lib');
const diffTesting = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const NS = opt('--n', '500,2000,5000,9000').split(',').map(Number);
const KINDS = opt('--kind', 'const,function').split(',');
const CONTEND = Number(opt('--contend', 0));
const REPS = Number(opt('--reps', 3));

const CUR = 'function target(a, b) {\n  const t = a * 7 + b;\n  if (t > 100) {\n    return t - 100;\n  }\n  return t;\n}\n';
const PROP = 'function target(a, b) {\n  const t = a * 7 + b;\n  if (t > 100) return t - 100;\n  return t;\n}\n';

const stop = CONTEND ? L.contend(CONTEND) : () => {};
console.log(`diffTesting.run, edit in a small function of a module with N top-level bindings; ${CONTEND} busy processes`);
console.log(L.row(['kind', 'N', 'KB', 'p50_ms', 'max_ms', 'verdicts', 'runs', 'reason (last)'], [9, 6, 5, 8, 8, 30, 5, 80]));
try {
  for (const kind of KINDS) {
    for (const n of NS) {
      let s = "'use strict';\n";
      for (let i = 0; i < n; i++) s += kind === 'const' ? `const K_${i} = ${i % 101};\n` : `function g_${i}(x) { return x + ${i % 7}; }\n`;
      const fileSrc = s + CUR + 'module.exports = { target };\n';
      const ms = [];
      const verdicts = {};
      let runs = 0, reason = '';
      for (let r = 0; r < REPS; r++) {
        const t0 = performance.now();
        const res = diffTesting.run({ currentSrc: CUR, proposedSrc: PROP, fileSrc, file: 'src/b.js' });
        ms.push(performance.now() - t0);
        verdicts[res.verdict] = (verdicts[res.verdict] || 0) + 1;
        runs = res.runs;
        reason = String(res.reason || '').slice(0, 80);
      }
      const st = L.stats(ms);
      console.log(L.row([kind, n, (fileSrc.length / 1024).toFixed(0), L.fmt(st.p50), L.fmt(st.max), JSON.stringify(verdicts), runs, reason], [9, 6, 5, 8, 8, 30, 5, 80]));
    }
  }
} finally {
  stop();
}
