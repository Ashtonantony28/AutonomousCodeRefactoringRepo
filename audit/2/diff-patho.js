#!/usr/bin/env node
'use strict';

// Pathological inputs for src/validation/diff-testing.js (budget p95 2000 ms,
// hard kill 3000 ms). Each case runs in a fresh child process so peak RSS
// (VmHWM) is per case. run() is synchronous (Atomics.wait), so its duration
// is also how long the host event loop -- and the --serve dashboard -- is
// blocked.
//
// usage: node audit/2/diff-patho.js            # all cases
//        node audit/2/diff-patho.js --case NAME [--loop 20]

const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lib');

const same = (body, params = 'a') => ({ cur: `function f(${params}) {\n${body}\n}`, prop: `function f(${params}) {\n${body}\n  // refactored\n}` });

const CASES = {
  baseline: same('  return a;'),
  'cpu-100ms-per-call': same('  let s = 0; for (let i = 0; i < 6e7; i++) s += i % 7; return s + (a ? 1 : 0);'),
  'cpu-150ms-per-call': same('  let s = 0; for (let i = 0; i < 9e7; i++) s += i % 7; return s + (a ? 1 : 0);'),
  'cpu-200ms-per-call': same('  let s = 0; for (let i = 0; i < 1.2e8; i++) s += i % 7; return s + (a ? 1 : 0);'),
  'infinite-loop-both': same('  for (;;) {}'),
  'load-time-900ms': {
    // top-level code that runs when the file is evaluated (both sides)
    file: "const T0 = Date.now(); while (Date.now() - T0 < 900) {}\nfunction f(a) {\n  return a;\n}\n",
    cur: 'function f(a) {\n  return a;\n}', prop: 'function f(a) {\n  return a; // same\n}'
  },
  'huge-string-4MB': same("  return 'x'.repeat(4e6) + String(a);"),
  'huge-string-16MB': same("  return 'x'.repeat(16e6) + String(a);"),
  'huge-array-1e6': same('  return Array.from({ length: 1e6 }, (_, i) => i + (a ? 1 : 0));'),
  'object-2e5-keys': same('  const o = {}; for (let i = 0; i < 2e5; i++) o["k" + i] = i; return o;'),
  'deep-recursion': same('  return a === -999 ? 0 : f(a);'),
  'memory-hog-oom': same('  const xs = []; for (;;) xs.push(new Array(1e5).fill(a));'),
  'big-file-199KB': (() => {
    let file = "'use strict';\n"; let j = 0;
    while (file.length + 200 < 199_000) file += L.fnText(0, j++);
    const k = Math.floor(j / 2);
    return { file, cur: `function f0_${k}(a, b) {\n  const t${k} = a * ${k} + b;\n  return t${k};\n}`, prop: `function f0_${k}(a, b) {\n  return a * ${k} + b;\n}` };
  })()
};

function runCase(name, loop) {
  L.isolateState('dt');
  const diff = require(L.src('validation/diff-testing'));
  const c = CASES[name];
  const fileSrc = c.file;
  const durs = [];
  let res;
  const threads = [];
  for (let i = 0; i < loop; i++) {
    const t = performance.now();
    res = diff.run({ currentSrc: c.cur, proposedSrc: c.prop, fileSrc });
    durs.push(performance.now() - t);
    threads.push(L.procStatus().Threads);
  }
  const st = L.procStatus();
  // let terminated workers be reaped, then count threads again
  return new Promise((resolve) => setTimeout(() => {
    const later = L.procStatus();
    const s = L.summarize(durs);
    resolve({ name, loop, p50: s.p50, max: s.max, verdict: res.verdict, runs: res.runs, reason: (res.reason || '').slice(0, 90), peak_rss_mb: st.VmHWM / 1024, threads_during_max: Math.max(...threads), threads_after_2s: later.Threads });
  }, 2000));
}

// --flaky NAME [--repeat 10] [--contend N]: repeat one case in fresh children,
// optionally with N busy-loop processes competing for the CPUs (e.g. the
// target's test suite or a parallel build), and count verdicts.
function flaky(name, repeat, contend) {
  const { spawn } = require('child_process');
  const hogs = [];
  for (let i = 0; i < contend; i++) hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  const counts = {};
  const durs = [];
  try {
    for (let i = 0; i < repeat; i++) {
      const out = execFileSync(process.execPath, [__filename, '--case', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      const r = JSON.parse(out.trim().split('\n').pop());
      counts[r.verdict + (r.verdict === 'divergent' ? ` (${r.reason.slice(0, 40)})` : '')] = (counts[r.verdict + (r.verdict === 'divergent' ? ` (${r.reason.slice(0, 40)})` : '')] || 0) + 1;
      durs.push(r.max);
    }
  } finally { for (const h of hogs) h.kill('SIGKILL'); }
  const s = L.summarize(durs);
  console.log(`${name} x${repeat}, ${contend} competing busy processes on ${require('os').cpus().length} CPUs: ${JSON.stringify(counts)}; duration p50 ${L.fmt(s.p50, 0)} max ${L.fmt(s.max, 0)} ms`);
}

async function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--flaky');
  if (fi !== -1) {
    const rep = args.indexOf('--repeat') === -1 ? 10 : Number(args[args.indexOf('--repeat') + 1]);
    const con = args.indexOf('--contend') === -1 ? 0 : Number(args[args.indexOf('--contend') + 1]);
    flaky(args[fi + 1], rep, con);
    process.exit(0);
  }
  const ci = args.indexOf('--case');
  const loop = Number(args[args.indexOf('--loop') + 1]) || 1;
  if (ci !== -1) {
    const r = await runCase(args[ci + 1], args.includes('--loop') ? loop : 1);
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(0);
  }
  console.log('case                    loop   p50_ms   max_ms  verdict       runs  peakRSS_MB  thr_max thr_after  reason');
  const plan = Object.keys(CASES).map(n => [n, 1]).concat([['infinite-loop-both', 10], ['memory-hog-oom', 10], ['load-time-900ms', 10]]);
  for (const [name, n] of plan) {
    let r;
    try {
      const out = execFileSync(process.execPath, [__filename, '--case', name, ...(n > 1 ? ['--loop', String(n)] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 });
      r = JSON.parse(out.trim().split('\n').pop());
    } catch (e) {
      console.log(`${name.padEnd(22)} ${String(n).padStart(5)}  CHILD FAILED: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    console.log(`${name.padEnd(22)} ${String(n).padStart(5)} ${L.fmt(r.p50, 0).padStart(8)} ${L.fmt(r.max, 0).padStart(8)}  ${r.verdict.padEnd(12)} ${String(r.runs).padStart(5)} ${L.fmt(r.peak_rss_mb, 0).padStart(11)} ${String(r.threads_during_max).padStart(8)} ${String(r.threads_after_2s).padStart(9)}  ${r.reason}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
