'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diffTesting = require('../src/validation/diff-testing');
const { assertDiffTest } = require('../src/contracts');

// Python sources go through diffTesting.run with `file: *.py`.
function run(cur, prop, { pre = '', ...opts } = {}) {
  const r = diffTesting.run({ currentSrc: cur, proposedSrc: prop, fileSrc: `${pre}${cur}`, file: 'pkg/mod.py', ...opts });
  assertDiffTest(r);
  return r;
}

test('routes .py edits to the Python oracle: equivalent rewrite', () => {
  const r = run('def total(xs):\n    s = 0\n    for x in xs:\n        s += x\n    return s\n', 'def total(xs):\n    return sum(xs)\n');
  assert.strictEqual(r.verdict, 'equivalent');
  assert.strictEqual(r.applicable, true);
  assert(r.runs >= 10);
  assert.strictEqual(r.lang, 'python');
  assert.strictEqual(r.function_name, 'total');
  const js = diffTesting.run({ currentSrc: 'function f(x) { return x * 2; }', proposedSrc: 'function f(x) { return x + 2; }', file: 'a.js' });
  assert.strictEqual(js.verdict, 'divergent');
  assert.strictEqual(js.lang, undefined, 'JS edits stay on the JS oracle');
});

test('divergent on changed return values, with a counterexample', () => {
  const r = run('def net(gross, fee):\n    return gross - fee\n', 'def net(gross, fee):\n    return gross + fee\n');
  assert.strictEqual(r.verdict, 'divergent');
  assert(Array.isArray(r.counterexample.args));
  assert.strictEqual(r.counterexample.target, 'net');
});

test('compares exception types, stdout, argument mutation and module state', () => {
  assert.strictEqual(run('def need(x):\n    if x is None:\n        raise ValueError("x required")\n    return x\n',
    'def need(x):\n    if x is None:\n        raise TypeError("x required")\n    return x\n').verdict, 'divergent');
  const out = run('def charge(user, amt):\n    print("charge", user, amt)\n    return amt\n', 'def charge(user, amt):\n    return amt\n');
  assert.strictEqual(out.verdict, 'divergent');
  assert.match(out.counterexample.current.stdout, /charge/);
  assert.strictEqual(run('def ordered(xs):\n    return sorted(xs)\n', 'def ordered(xs):\n    xs.sort()\n    return xs\n').verdict, 'divergent');
  assert.strictEqual(run('def hit():\n    global CALLS\n    CALLS += 1\n    return CALLS\n', 'def hit():\n    global CALLS\n    return CALLS + 1\n', { pre: 'CALLS = 0\n' }).verdict, 'divergent');
  assert.strictEqual(run('def add(x, acc=None):\n    acc = [] if acc is None else acc\n    acc.append(x)\n    return acc\n',
    'def add(x, acc=[]):\n    acc.append(x)\n    return acc\n').verdict, 'divergent');
});

test('inputs are shaped by usage: defaults omitted, mined lengths, dict keys, slices', () => {
  assert.strictEqual(run('def page(items, size=10):\n    return items[:size]\n', 'def page(items, size=20):\n    return items[:size]\n').verdict, 'divergent');
  assert.strictEqual(run('def check(user):\n    if user.get("admin"):\n        return "full"\n    return "limited"\n',
    'def check(user):\n    if not user.get("admin"):\n        return "full"\n    return "limited"\n').verdict, 'divergent');
  assert.strictEqual(run('def ks(d):\n    return [k for k in d.keys()]\n', 'def ks(d):\n    return [k for k in d]\n').verdict, 'equivalent');
  assert.strictEqual(run('def first_neg(xs):\n    found = None\n    for x in xs:\n        if x < 0:\n            found = x\n            break\n    return found\n',
    'def first_neg(xs):\n    found = None\n    for x in xs:\n        if x < 0:\n            found = x\n            continue\n    return found\n').verdict, 'divergent');
});

test('methods, properties, constructors and changed constants', () => {
  const cls = (body) => `class Box:\n    def __init__(self, w):\n        self.w = w\n    def area(self):\n        return ${body}\n`;
  assert.strictEqual(run(cls('self.w * self.w'), cls('self.w ** 2')).verdict, 'equivalent');
  assert.strictEqual(run(cls('self.w * self.w'), cls('self.w * 2')).verdict, 'divergent');
  assert.strictEqual(run('class B:\n    def __init__(self, w):\n        self.w = w\n', 'class B:\n    def __init__(self, w):\n        self.w = abs(w)\n').verdict, 'divergent');
  assert.strictEqual(run('RATE = 0.1\n', 'RATE = 0.2\n').verdict, 'divergent');
  const same = run('RATE = 2 * 3\n', 'RATE = 6\n');
  assert.strictEqual(same.verdict, 'equivalent');
  assert.strictEqual(same.runs, 1);
});

test('a changed statement outside any callable, or nothing located, is inconclusive', () => {
  const r = run('if True:\n    LIMIT = 3\n', 'if True:\n    LIMIT = 4\n');
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.strictEqual(r.runs, 0);
  assert.strictEqual(r.lang, 'python');
  assert.match(r.reason, /no callable function or constant located in the edit; a top-level statement outside a located callable changed/);
});

test('infinite loop in proposed is inconclusive via the per-call timeout, within the hard kill', () => {
  const t0 = Date.now();
  const r = run('def f(x):\n    return 1\n', 'def f(x):\n    while True:\n        pass\n');
  assert(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /per-call timeout/);
});

test('hard kill bounds a sandbox that never reports', () => {
  const t0 = Date.now();
  const r = run('def f(x):\n    return 1\n', 'def f(x):\n    while True:\n        try:\n            while True:\n                pass\n        except BaseException:\n            pass\n',
    { hardKillMs: 700, budgetMs: 5000, callTimeoutMs: 5000 });
  assert(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /hard kill/);
});

test('sandbox refuses network, processes and writes outside its cwd', () => {
  const marker = path.join(os.tmpdir(), `pydt-escape-${process.pid}`);
  const r = run('def f(x):\n    return 1\n', `def f(x):\n    open(${JSON.stringify(marker)}, "w").write("x")\n    return 1\n`);
  assert.strictEqual(r.verdict, 'divergent');
  assert.strictEqual(r.counterexample.proposed.error.name, 'PermissionError');
  assert.strictEqual(fs.existsSync(marker), false);
  for (const body of ['import socket\n    socket.create_connection(("127.0.0.1", 9))', 'import os\n    os.system("true")', 'import subprocess\n    subprocess.run(["true"])']) {
    const s = run('def g(x):\n    return 1\n', `def g(x):\n    ${body}\n    return 1\n`);
    assert.notStrictEqual(s.verdict, 'equivalent', body);
  }
});

test('writes inside the sandbox cwd are compared between sides', () => {
  const r = run('def log_line(p, s):\n    with open(p, "a") as f:\n        f.write(s + "\\n")\n', 'def log_line(p, s):\n    with open(p, "w") as f:\n        f.write(s + "\\n")\n');
  assert.strictEqual(r.verdict, 'divergent');
});

test('non-stdlib imports are inert stubs: same interactions are comparable, different ones inconclusive', () => {
  const pre = 'import requests\n';
  assert.strictEqual(run('def f(u):\n    return requests.get(u).json()\n', 'def f(u):\n    r = requests.get(u)\n    return r.json()\n', { pre }).verdict, 'equivalent');
  const d = run('def f(u):\n    return requests.get(u, timeout=5)\n', 'def f(u):\n    return requests.get(u)\n', { pre });
  assert.strictEqual(d.verdict, 'inconclusive');
  assert.match(d.reason, /dependency stubs/);
});

test('clock / environment references changed by the edit are inconclusive; nondeterminism is never divergent', () => {
  const pre = 'import time\n';
  const c = run('def f(x):\n    return 1\n', 'def f(x):\n    return 1 if time.time() < 4e9 else 2\n', { pre });
  assert.strictEqual(c.verdict, 'inconclusive');
  assert.match(c.reason, /clock/);
  const n = run('def f(x):\n    return (time.perf_counter(), x)\n', 'def f(x):\n    t = time.perf_counter()\n    return (t, x)\n', { pre });
  assert.strictEqual(n.verdict, 'inconclusive');
});

test('proposed failing to parse or to load is divergent; snippet without context is not', () => {
  assert.strictEqual(run('def f(x):\n    return x\n', 'def f(x):\n    return x +\n').verdict, 'divergent');
  assert.strictEqual(run('def f(x):\n    return x\n', 'raise RuntimeError("boom")\ndef f(x):\n    return x + 0\n').verdict, 'divergent');
  const s = diffTesting.run({ currentSrc: 'def f(x):\n    return helper(x)\n', proposedSrc: 'def f(x):\n    return helper(x) + 0\n', file: 'm.py' });
  assert.strictEqual(s.verdict, 'inconclusive');
});

test('async functions and generators are compared by their results', () => {
  assert.strictEqual(run('async def f(x):\n    return x + 1\n', 'async def f(x):\n    return x + 2\n').verdict, 'divergent');
  assert.strictEqual(run('def f(n):\n    for i in range(n):\n        yield i\n', 'def f(n):\n    yield from range(n)\n').verdict, 'equivalent');
  assert.strictEqual(run('def f(n):\n    for i in range(n):\n        yield i\n', 'def f(n):\n    yield from range(n + 1)\n').verdict, 'divergent');
});

test('a deletion the probes saw run is observed; outside the domain differences are inconclusive', () => {
  const r = run('def f(x):\n    unused = 42\n    return x * 2\n', 'def f(x):\n    return x * 2\n');
  assert.strictEqual(r.verdict, 'equivalent');
  assert.strictEqual(r.deletions_observed, true);
  const ood = run('def f(xs):\n    return len(xs) + 1\n', 'def f(xs):\n    return len(xs) + 1 if xs is not None else 0\n');
  assert.strictEqual(ood.verdict, 'inconclusive');
  assert.match(ood.reason, /outside its domain/);
});

test('benign Python refactors are equivalent (AUDIT-8 NP*)', () => {
  const cases = [
    ['def sign(n):\n    if n < 0:\n        return "neg"\n    else:\n        return "pos"\n', 'def sign(n):\n    return "neg" if n < 0 else "pos"\n'],
    ['def missing(x):\n    return x == None\n', 'def missing(x):\n    return x is None\n'],
    ['def greet(n):\n    return "hi %s" % n\n', 'def greet(n):\n    return f"hi {n}"\n'],
    ['def indexed(xs):\n    out = []\n    for i in range(len(xs)):\n        out.append((i, xs[i]))\n    return out\n', 'def indexed(xs):\n    return list(enumerate(xs))\n'],
    ['def between(x):\n    return x > 0 and x < 10\n', 'def between(x):\n    return 0 < x < 10\n']
  ];
  for (const [cur, prop] of cases) assert.strictEqual(run(cur, prop).verdict, 'equivalent', prop);
});

// ---------- SG22 ----------

test('a deletion is observed only if the deleted expression ran: if-expression branch, and/or operand (AUDIT-12 C1)', () => {
  const ifexp = run('def note(s):\n    s = s[:3000] if len(s) > 3000 else s\n    return s.strip()\n', 'def note(s):\n    return s.strip()\n');
  assert.strictEqual(ifexp.verdict, 'equivalent', ifexp.reason);
  assert.strictEqual(ifexp.deletions_observed, false, 'the assignment ran, the slice branch never did');
  const operand = run('def norm(n):\n    n = isinstance(n, complex) and abs(n) or n\n    return n\n', 'def norm(n):\n    return n\n');
  assert.strictEqual(operand.verdict, 'equivalent', operand.reason);
  assert.strictEqual(operand.deletions_observed, false, 'abs(n) never ran');
  const mixed = run('def twice(x):\n    y = x * 2\n    return y\n', 'def twice(x):\n    return x * 2\n');
  assert.strictEqual(mixed.verdict, 'equivalent', mixed.reason);
  assert.strictEqual(mixed.deletions_observed, true, 'deleted tokens of a hunk that also inserts are probed and ran');
  const branch = run('def sign(n):\n    return -1 if n < 0 else 1\n', 'def sign(n):\n    if n < 0:\n        return -1\n    return 1\n');
  assert.strictEqual(branch.verdict, 'equivalent', branch.reason);
  assert.strictEqual(branch.deletions_observed, true, 'both branches of the deleted if-expression ran');
});

test('log records below WARNING and warnings are output (AUDIT-12 H1, Y7)', () => {
  const pre = 'import logging\nlog = logging.getLogger(__name__)\n\n\n';
  const r = run('def charge(user, amt):\n    log.info("charge %s %s", user, amt)\n    return amt\n', 'def charge(user, amt):\n    return amt\n', { pre });
  assert.strictEqual(r.verdict, 'divergent', r.reason);
  const same = run('def charge(user, amt):\n    log.debug("charge %s", user)\n    return amt\n', 'def charge(user, amt):\n    log.debug("charge %s", user)\n    total = amt\n    return total\n', { pre });
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
});

// ---------- SG23: every rule that keeps a verdict from being `equivalent` is pinned (AUDIT-11 C2, C3) ----------

const INLINE = ['def f(x):\n    y = x + 1\n    return y\n', 'def f(x):\n    return x + 1\n'];

test('module state after load that is not deterministic is inconclusive (AUDIT-11 C2)', () => {
  const r = run(...INLINE, { pre: 'import os\nTOKEN = os.urandom(8).hex()\n' });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /module state after load is not deterministic/);
});

test('load-time state differing only through dependency stubs is inconclusive (AUDIT-11 C2)', () => {
  const r = run("HOST = requests.get('a')\n", "HOST = requests.get('b')\n", { pre: 'import requests\n' });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /module-scope state after load differs through dependency stubs/);
});

test('a target cut short by the time budget is inconclusive even with enough value runs (AUDIT-11 C2)', () => {
  // Only the proposed side slows down (calls 13+, ~50 ms each), so it alone is
  // cut by its share of the budget; both current runs complete.
  const r = run('def f(n):\n    CALLS[0] += 1\n    y = n * 2\n    return y\n',
    'def f(n):\n    CALLS[0] += 1\n    if CALLS[0] > 12:\n        for _ in range(4_000_000):\n            pass\n    return n * 2\n',
    { pre: 'CALLS = [0]\n', budgetMs: 300, callTimeoutMs: 2000 });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /f: time budget reached after \d+ of \d+ runs/);
});

test('harness crashes are inconclusive and observe no deletion: bad output, harness error, a side dying before load (AUDIT-11 C2, C3)', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydt-fake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'python3');
  fs.writeFileSync(fake, '#!/bin/sh\ncat > /dev/null\necho not json\n', { mode: 0o755 });
  const parse = run(...INLINE, { python: fake });
  assert.strictEqual(parse.verdict, 'inconclusive');
  assert.match(parse.reason, /^python sandbox error: /);
  assert.strictEqual(parse.deletions_observed, false);
  const err = run(...INLINE, { budgetMs: 'not a number' });
  assert.strictEqual(err.verdict, 'inconclusive');
  assert.match(err.reason, /^harness error: TypeError/);
  assert.strictEqual(err.deletions_observed, false);
  const noload = run(...INLINE, { pre: 'import os\nos._exit(0)\n' });
  assert.strictEqual(noload.verdict, 'inconclusive');
  assert.strictEqual(noload.reason, 'a sandboxed side ended before loading the module');
});

// ---------- SG24: bounded work on large modules and deletions ----------

// Runs py_diff_harness.main in-process after `patch` (Python source); -> its result.
function harness(req, patch = '') {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydt-unit-'));
  try {
    const script = [
      'import json, sys', `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'src', 'validation'))})`,
      'import py_diff_harness as H', 'req = json.load(sys.stdin)', patch, 'print(json.dumps(H.main(req)))'
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-B', '-c', script], { cwd: dir, input: JSON.stringify({ workdir: dir, ...req }), encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const manyFns = (n, p = 'g') => Array.from({ length: n }, (_, i) => `def ${p}_${i}(a, b):\n    return a * ${i % 9} + b\n\n\n`).join('');

test('a deletion of many tokens deep in a module is mapped in one pass and probed where it runs (AUDIT-14 H1)', () => {
  // 20,000 deleted tokens 100 KB into the file, after astral characters
  // (UTF-16 offsets differ from Python's): the per-token rescan took ~10 s.
  let pre = '"""module \u{1F600} \u{1F680}"""\n\n\n';
  for (let i = 0; pre.length < 100000; i++) pre += manyFns(1, `g${i}`);
  const cur = `def target(a, b):\n    unused = [${Array.from({ length: 10000 }, (_, i) => i).join(', ')}]\n    if a > 3:\n        return a - b\n    return a + b\n`;
  const r = run(cur, 'def target(a, b):\n    if a > 3:\n        return a - b\n    return a + b\n', { pre, budgetMs: 4000, hardKillMs: 8000 });
  assert.strictEqual(r.verdict, 'equivalent', r.reason);
  assert.strictEqual(r.deletions_observed, true);
});

test('only callables on the edited lines are compared: unchanged ones are never dumped (AUDIT-14 H2)', () => {
  const cur = `${manyFns(300)}def target(a, b):\n    t = a * 7 + b\n    if t > 100:\n        return t - 100\n    return t\n\n\n${manyFns(300, 'h')}`;
  const prop = cur.replace('    if t > 100:\n        return t - 100\n    return t\n', '    return t - 100 if t > 100 else t\n');
  const r = harness({ current: cur, proposed: prop, modname: 'm' }, [
    'calls, real, main = [0], H.dump, H.main', 'def counted(n):', '    calls[0] += 1', '    return real(n)', 'H.dump = counted',
    'H.main = lambda req: dict(main(req), dumps=calls[0])'
  ].join('\n'));
  assert.strictEqual(r.verdict, 'equivalent', r.reason);
  assert(r.dumps <= 4, `dump() called ${r.dumps} times`);
});

// The third side (the current version again) is cut short by the budget.
const cutThird = (keep) => [
  'real, seen = H.run_side, [0]',
  'def cut(*a):',
  '    seen[0] += 1',
  '    res = real(*a)',
  '    if seen[0] == 3:',
  keep === null
    ? '        res.update(load=None, runs={}, hits=None, budget=False, killed=True, ended=False)'
    : `        res.update(runs={k: v for k, v in res['runs'].items() if k[1] < ${keep}}, hits=None, budget=True, ended=False)`,
  '    return res',
  'H.run_side = cut'
].join('\n');

test('a budget cut on the second current run is reported as a budget cut, not as stub differences (AUDIT-14 H2, L1)', () => {
  const [current, proposed] = INLINE;
  const r = harness({ current, proposed, modname: 'm' }, cutThird(5));
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /^f: time budget reached after 5 of \d+ runs$/);
  const unloaded = harness({ current, proposed, modname: 'm' }, cutThird(null));
  assert.strictEqual(unloaded.verdict, 'inconclusive');
  assert.match(unloaded.reason, /time budget reached before the second current run loaded the module/);
  assert.doesNotMatch(unloaded.reason, /not deterministic/);
});

test('input preparation that overruns the hard kill says so; Python never gets a 1 ms run (AUDIT-14 H1, L1)', () => {
  const r = run(...INLINE, { hardKillMs: 0.001 });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /^hard kill: input preparation did not finish within/);
});
