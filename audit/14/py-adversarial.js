#!/usr/bin/env node
'use strict';

// SG19 Python harness against adversarial modules, unloaded and under CPU
// load: per-call timer (SIGALRM, catchable by user code), uninterruptible C
// work, memory/CPU/file limits, output floods, crashes. Each case is a
// behaviour-changing or behaviour-preserving edit with the verdict that would
// be correct; reports diffTesting.run's wall time (the Node main thread is
// blocked for all of it: spawnSync), the verdict, and harness processes left
// alive afterwards. Anything but `inconclusive`/the expected verdict, or a
// wall time far over the 3,000 ms hard kill, is a finding.
//
// usage: node audit/14/py-adversarial.js [--contend 0,8] [--case name] [--reps 3]

const { execFileSync } = require('child_process');
const L = require('./lib');
const diffTesting = require(L.src('validation/diff-testing'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const CONTEND = opt('--contend', '0,8').split(',').map(Number);
const ONLY = opt('--case', null);
const REPS = Number(opt('--reps', 3));

const fnFile = (body, extra = '') => `${extra}def f(s, n):\n${body}\n`;
const CASES = [
  { name: 'control: equivalent edit', expect: 'equivalent',
    cur: fnFile('    t = len(s) + n\n    return t'), prop: fnFile('    return len(s) + n') },
  { name: 'control: divergent edit', expect: 'divergent',
    cur: fnFile('    return len(s) + n'), prop: fnFile('    return len(s) - n') },
  { name: 'module load burns 0.8 s CPU', expect: 'inconclusive|equivalent',
    cur: fnFile('    t = len(s) + n\n    return t', 'X = 0\nfor _i in range(12_000_000):\n    X += _i % 3\n\n\n'), prop: fnFile('    return len(s) + n', 'X = 0\nfor _i in range(12_000_000):\n    X += _i % 3\n\n\n') },
  { name: 'catastrophic regex in C (changed fn)', expect: 'inconclusive',
    cur: fnFile("    import re\n    return bool(re.match(r'(a+)+$', 'a' * 40 + '!')) or n", ''), prop: fnFile("    import re\n    return bool(re.match(r'(a+)+$', 'a' * 40 + '!')) and n", '') },
  { name: 'huge int power in C', expect: 'inconclusive',
    cur: fnFile('    return (7 ** 50_000_000) % 10 + n'), prop: fnFile('    return (7 ** 50_000_000) % 10 - n') },
  { name: 'timer swallowed: bare except loop', expect: 'inconclusive',
    cur: fnFile('    while True:\n        try:\n            pass\n        except:\n            pass'), prop: fnFile('    while True:\n        try:\n            n += 0\n        except:\n            pass') },
  { name: 'timer swallowed: fallback value', expect: 'inconclusive|divergent',
    cur: fnFile('    try:\n        x = 0\n        for i in range(10 ** 9):\n            x += i\n        return x\n    except:\n        return -1'), prop: fnFile('    try:\n        x = 0\n        for i in range(10 ** 9):\n            x -= i\n        return x\n    except:\n        return -1') },
  { name: 'memory bomb (RLIMIT_AS)', expect: 'inconclusive|equivalent',
    cur: fnFile('    x = [0] * (10 ** 9)\n    return len(x) + n'), prop: fnFile('    x = [1] * (10 ** 9)\n    return len(x) + n') },
  { name: 'output flood 50 MB per call', expect: 'inconclusive|divergent',
    cur: fnFile("    print('x' * 50_000_000)\n    return n"), prop: fnFile("    print('y' * 50_000_000)\n    return n") },
  { name: 'file flood in cwd (RLIMIT_FSIZE)', expect: 'inconclusive|divergent|equivalent',
    cur: fnFile("    open('big.bin', 'wb').write(b'0' * (8 << 20))\n    return n"), prop: fnFile("    open('big.bin', 'wb').write(b'1' * (8 << 20))\n    return n") },
  { name: 'deep recursion crash', expect: 'inconclusive',
    cur: fnFile('    import sys\n    sys.setrecursionlimit(10 ** 7)\n    def g(k):\n        return g(k + 1) + 1\n    return g(0)'), prop: fnFile('    import sys\n    sys.setrecursionlimit(10 ** 7)\n    def g(k):\n        return g(k + 1) + 2\n    return g(0)') },
  { name: 'sleep 10 s per call', expect: 'inconclusive',
    cur: fnFile('    import time\n    time.sleep(10)\n    return n'), prop: fnFile('    import time\n    time.sleep(10)\n    return -n') },
  { name: 'returns 1M-element list', expect: 'inconclusive|divergent',
    cur: fnFile('    return list(range(1_000_000 + n))'), prop: fnFile('    return list(range(1_000_000 - n))') }
];

function harnessLeft() {
  try {
    return execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n').filter(l => l.includes('py_diff_harness.py') && !l.includes(' ps ')).length;
  } catch { return -1; }
}

console.log(`Python diffTesting.run on adversarial modules (snippet = whole module); hard kill 3,000 ms; ${REPS} reps`);
console.log(L.row(['busy', 'case', 'expected', 'verdicts', 'p50_ms', 'max_ms', 'left', 'reason (last)'], [5, 40, 26, 30, 8, 8, 5, 80]));
for (const busy of CONTEND) {
  const stop = busy ? L.contend(busy) : () => {};
  try {
    for (const c of CASES) {
      if (ONLY && !c.name.includes(ONLY)) continue;
      const ms = [];
      const verdicts = {};
      let reason = '';
      for (let r = 0; r < REPS; r++) {
        const t0 = performance.now();
        const res = diffTesting.run({ currentSrc: c.cur, proposedSrc: c.prop, fileSrc: c.cur, file: 'pkg/adv.py' });
        ms.push(performance.now() - t0);
        verdicts[res.verdict] = (verdicts[res.verdict] || 0) + 1;
        reason = String(res.reason || '').slice(0, 80);
      }
      const ok = Object.keys(verdicts).every(v => c.expect.split('|').includes(v));
      const st = L.stats(ms);
      console.log(L.row([busy, c.name, c.expect + (ok ? '' : ' !!'), JSON.stringify(verdicts), L.fmt(st.p50), L.fmt(st.max), harnessLeft(), reason], [5, 40, 26, 30, 8, 8, 5, 80]));
    }
  } finally {
    stop();
  }
}
