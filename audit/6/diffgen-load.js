#!/usr/bin/env node
'use strict';

// Diff-test input generation and loading after SG11
// (src/validation/diff-testing.js run(): parse both file versions, collect
// targets, mine literals, build up to 51 inputs per changed callable, then a
// worker evaluates both versions and calls every target). Measured per case:
// total run() (budget p95 2,000 ms, hard kill 3,000 ms), the main-thread part
// before the worker starts (not covered by the hard kill: it is subtracted
// from it), the size of the input literals shipped to the worker, verdict and
// peak RSS. Each case runs in a fresh child process.
//
// usage: node audit/6/diffgen-load.js [--case NAME] [--contend N] [--repeat N]

const path = require('path');
const { execFileSync, spawn } = require('child_process');
const L = require('./lib');

function fnFile(n, body = (i) => `  const t = a * ${i} + b;\n  return t;`) {
  let s = "'use strict';\n";
  for (let i = 0; i < n; i++) s += `function f${i}(a, b) {\n${body(i)}\n}\n`;
  return s;
}

const CASES = {
  'baseline-small': () => {
    const file = fnFile(5);
    return { file, cur: 'function f2(a, b) {\n  const t = a * 2 + b;\n  return t;\n}', prop: 'function f2(a, b) {\n  return a * 2 + b;\n}' };
  },
  'file-199KB-one-fn': () => {
    let file = fnFile(2600);
    file = file.slice(0, 199_000).slice(0, file.slice(0, 199_000).lastIndexOf('}\n') + 2);
    return { file, cur: 'function f1300(a, b) {\n  const t = a * 1300 + b;\n  return t;\n}', prop: 'function f1300(a, b) {\n  return a * 1300 + b;\n}' };
  },
  'many-callables-200-changed': () => {
    // one proposal rewrites 200 adjacent functions (only 8 are tested)
    const file = fnFile(400);
    const cur = fnFile(200).replace("'use strict';\n", '').trimEnd();
    const prop = cur.replace(/const t = (a \* \d+ \+ b);\n {2}return t;/g, 'return $1;');
    return { file, cur, prop };
  },
  'class-2000-methods': () => {
    let file = "'use strict';\nclass Big {\n  constructor() { this.k = 1; }\n";
    for (let i = 0; i < 2000; i++) file += `  m${i}(a, b) {\n    const t = this.k * a * ${i} + b;\n    return t;\n  }\n`;
    file += '}\nmodule.exports = { Big };\n';
    return { file, cur: '  m1000(a, b) {\n    const t = this.k * a * 1000 + b;\n    return t;\n  }', prop: '  m1000(a, b) {\n    return this.k * a * 1000 + b;\n  }' };
  },
  'deep-object-30x30-indexed': () => {
    // reads cfg.k<i>[j].v<m> for 30 keys, with mined lengths up to 64
    const reads = [];
    for (let i = 0; i < 30; i++) reads.push(`  for (let j = 0; j < cfg.k${i}.length; j++) s += cfg.k${i}[j].v${i % 30} || 0;`);
    const lits = Array.from({ length: 60 }, (_, i) => i + 5).join(', ');
    const body = `  let s = 0;\n  const lens = [${lits}];\n${reads.join('\n')}\n  return s + lens.length;`;
    const cur = `function deep(cfg) {\n${body}\n}`;
    const prop = `function deep(cfg) {\n${body.replace('return s + lens.length;', 'return lens.length + s;')}\n}`;
    return { file: `'use strict';\n${cur}\nmodule.exports = { deep };\n`, cur, prop };
  },
  'deep-object-3-levels-20-keys': () => {
    const reads = [];
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) reads.push(`o.a${i}.b${j}.c${(i + j) % 20}`);
    const body = `  return [${reads.join(', ')}].filter(Boolean).length;`;
    const cur = `function deep3(o) {\n${body}\n}`;
    const prop = `function deep3(o) {\n${body.replace('.length;', '.length + 0;')}\n}`;
    return { file: `'use strict';\n${cur}\n`, cur, prop };
  },
  'mined-literals-20k': () => {
    const lits = Array.from({ length: 20_000 }, (_, i) => `'lit${i}'`).join(', ');
    const nums = Array.from({ length: 20_000 }, (_, i) => i * 3).join(', ');
    const cur = `function pick(a) {\n  const S = [${lits}];\n  const N = [${nums}];\n  return S.indexOf(a) + N.indexOf(a);\n}`;
    const prop = cur.replace('return S.indexOf(a) + N.indexOf(a);', 'return N.indexOf(a) + S.indexOf(a);');
    return { file: `'use strict';\n${cur}\n`, cur, prop };
  },
  'require-stubs-500': () => {
    let head = "'use strict';\n";
    for (let i = 0; i < 500; i++) head += `const dep${i} = require('dep${i}');\n`;
    const calls = Array.from({ length: 500 }, (_, i) => `dep${i}.run(a).value`).join(', ');
    const cur = `function useDeps(a) {\n  return [${calls}].length;\n}`;
    const prop = cur.replace('.length;', '.length + 0;');
    return { file: `${head}${cur}\n`, cur, prop };
  },
  'stub-chain-walk': () => {
    const cur = "function walk(a) {\n  let x = dep;\n  for (let i = 0; i < 20000; i++) x = x.next;\n  return typeof x + a;\n}";
    const prop = cur.replace('return typeof x + a;', 'return typeof x + a; // same');
    return { file: `'use strict';\nconst dep = require('dep');\n${cur}\n`, cur, prop };
  }
};

function runCase(name, repeat) {
  L.isolateState('dg');
  const wt = require('worker_threads');
  let tWorker = null, litBytes = 0;
  const Orig = wt.Worker;
  wt.Worker = class extends Orig {
    constructor(file, opts) {
      tWorker = performance.now();
      litBytes = JSON.stringify(opts.workerData.targets || []).length;
      super(file, opts);
    }
  };
  const diff = require(L.src('validation/diff-testing'));
  const c = CASES[name]();
  const rows = [];
  for (let i = 0; i < repeat; i++) {
    tWorker = null;
    const t = performance.now();
    const r = diff.run({ currentSrc: c.cur, proposedSrc: c.prop, fileSrc: c.file });
    const total = performance.now() - t;
    rows.push({ total, prep: tWorker == null ? total : tWorker - t, verdict: r.verdict, runs: r.runs, reason: (r.reason || '').slice(0, 70) });
  }
  const s = L.summarize(rows.map(x => x.total));
  const verdicts = {};
  for (const x of rows) verdicts[x.verdict] = (verdicts[x.verdict] || 0) + 1;
  return { name, p50: s.p50, max: s.max, prep: L.summarize(rows.map(x => x.prep)).max, lit_kb: litBytes / 1000, verdicts, runs: rows[rows.length - 1].runs, reason: rows[rows.length - 1].reason, rss_mb: L.procStatus().VmHWM / 1024 };
}

async function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--case');
  const repeat = args.includes('--repeat') ? Number(args[args.indexOf('--repeat') + 1]) : 3;
  if (ci !== -1 && args.includes('--child')) {
    process.stdout.write(JSON.stringify(runCase(args[ci + 1], repeat)));
    return;
  }
  const contend = args.includes('--contend') ? Number(args[args.indexOf('--contend') + 1]) : 0;
  const busy = [];
  for (let i = 0; i < contend; i++) busy.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  const names = ci === -1 ? Object.keys(CASES) : [args[ci + 1]];
  console.log(`${contend} competing busy processes on ${require('os').cpus().length} CPUs, ${repeat} runs per case`);
  console.log(L.row(['case', 'p50_ms', 'max_ms', 'prep_ms', 'inputs_KB', 'rss_MB', 'verdicts', 'reason'], [30, 8, 8, 8, 10, 7, 26, 60]));
  try {
    for (const n of names) {
      const out = execFileSync(process.execPath, [__filename, '--case', n, '--child', '--repeat', String(repeat)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 });
      const r = JSON.parse(out);
      console.log(L.row([n, L.fmt(r.p50, 0), L.fmt(r.max, 0), L.fmt(r.prep, 0), L.fmt(r.lit_kb, 0), L.fmt(r.rss_mb, 0), JSON.stringify(r.verdicts), `${r.runs} runs ${r.reason}`], [30, 8, 8, 8, 10, 7, 26, 60]));
    }
  } finally {
    for (const b of busy) b.kill('SIGKILL');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
void path;
