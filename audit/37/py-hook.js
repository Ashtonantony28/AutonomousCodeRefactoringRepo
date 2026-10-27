#!/usr/bin/env node
'use strict';

// AUDIT-37: cost of the SG45 Python load hooks. runTests now writes
// refactor_load_core.py (the `__import__` wrapper), refactor_load_hook.py
// (the pytest plugin that keys it) and a sitecustomize.py to the run's temp
// dir on PYTHONPATH, so EVERY interpreter that keeps the environment (pytest
// itself and each child a test spawns) imports importlib.machinery /
// importlib.util, wraps __import__, installs an excepthook and scans sys.path
// for the sitecustomize it shadows (PathFinder.find_spec). Pre-SG45
// (--old-rev, default f70c1ef) only the pytest process had the wrapper.
// Generated pytest suites run as runTests runs them (`python3 -m pytest
// --junitxml=<f> --tb=short -p refactor_load_hook`, PYTHONPATH = hook dir,
// REFACTOR_LOAD_LOG set), under: no hook, the pre-SG45 hook and the current
// one. Median of --reps runs, interleaved.
//
//   spawn       one test spawning C `python3 -c 'import json'` children
//   spawn-path  as spawn, with P extra (empty) directories on PYTHONPATH
//   imports     one test module importing N small local modules
//   hot-import  one test calling a function with a function-level import M times
//
// FINDING when the current hooks make a suite more than 25% and 250 ms slower
// than the pre-SG45 hook, or a suite stops passing.
//
// usage: node audit/37/py-hook.js [--cases spawn,spawn-path,imports,hot-import]
//          [--c 200] [--p 100] [--n 2000] [--m 300000] [--reps 3] [--old-rev f70c1ef] [--nobytecode]

const L = require('../29/lib');
const { spawnSync } = require('child_process');

const C = Number(L.opt('--c', 200));
const P = Number(L.opt('--p', 100));
const N = Number(L.opt('--n', 2000));
const M = Number(L.opt('--m', 300000));
const REPS = Number(L.opt('--reps', 3));
const NOBC = process.argv.includes('--nobytecode');
const REV = L.opt('--old-rev', 'f70c1ef');
const CASES = L.list('--cases', 'spawn,spawn-path,imports,hot-import');

const range = (n) => Array.from({ length: n }, (_, i) => i);
const SPAWN = `import subprocess, sys\ndef test_spawn():\n    for _ in range(${C}):\n        subprocess.run([sys.executable, '-c', 'import json'], check=True)\n`;
const SUITES = {
  spawn: () => ({ 'tests/test_a.py': SPAWN }),
  'spawn-path': () => ({ 'tests/test_a.py': SPAWN, ...Object.fromEntries(range(P).map(i => [`extra/p${i}/.keep`, ''])) }),
  imports: () => ({
    ...Object.fromEntries(range(N).map(i => [`pkg/m${i}.py`, `def f(x):\n    return x + ${i}\n`])),
    'pkg/__init__.py': '',
    'tests/test_a.py': `${range(N).map(i => `from pkg import m${i}`).join('\n')}\ndef test_a():\n    assert m0.f(1) + m${N - 1}.f(0) == ${N}\n`
  }),
  'hot-import': () => ({
    'tests/test_a.py': `def g(x):\n    import json\n    return x + 1\ndef test_hot():\n    s = 0\n    for i in range(${M}):\n        s += g(i) - i\n    assert s == ${M}\n`
  })
};

const old = { core: null, hook: L.hookAt('PY_LOAD_HOOK', REV), site: null };
const cur = { core: L.hookText('PY_LOAD_CORE'), hook: L.hookText('PY_LOAD_HOOK'), site: L.hookText('PY_SITE') };
if (!old.hook || !cur.core || !cur.hook || !cur.site) { console.log('FINDING: hook text not found'); process.exit(1); }
const py = L.pyPath ? (L.pyPath(), 'python3') : 'python3';

function runOnce(dir, hookDir, extra) {
  const report = L.path.join(dir, 'junit.xml'), log = L.path.join(dir, 'load.log');
  try { L.fs.rmSync(log, { force: true }); } catch {}
  const env = { ...process.env, CI: '1', REFACTOR_LOAD_LOG: log, PYTHONPYCACHEPREFIX: L.path.join(dir, '.pyc') }; // as runTests (PYTHONPYCACHEPREFIX = its temp dir)
  if (NOBC) env.PYTHONDONTWRITEBYTECODE = '1'; else delete env.PYTHONDONTWRITEBYTECODE; // --nobytecode: as a CI image that sets it
  delete env.PYTHONPATH;
  const paths = [...extra, hookDir].filter(Boolean);
  if (paths.length) env.PYTHONPATH = paths.join(':');
  const args = ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${report}`, '--tb=short', ...(hookDir ? ['-p', 'refactor_load_hook'] : [])];
  const t0 = performance.now();
  const r = spawnSync(py, args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wall = performance.now() - t0;
  const pass = Number((r.stdout.match(/(\d+) passed/) || [])[1]);
  let rows = 0;
  try { rows = L.fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch {}
  return { wall, ok: r.status === 0, pass, rows, err: r.status === 0 ? '' : (r.stdout + r.stderr).slice(-400) };
}

console.log(`${spawnSync(py, ['-V'], { encoding: 'utf8' }).stdout.trim()}; C=${C} P=${P} N=${N} M=${M} reps=${REPS}; old hook = ${REV}; load ${L.fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}`);
console.log('case         none      old       cur       cur/old  cur-old   per child (cur-old)');
for (const name of CASES) {
  const dir = L.tmpDir(`a37-py-${name}`);
  for (const [rel, text] of Object.entries(SUITES[name]())) L.write(dir, rel, text);
  const hd = { none: null, old: L.path.join(dir, '.h-old'), cur: L.path.join(dir, '.h-cur') };
  L.write(hd.old, 'refactor_load_hook.py', old.hook);
  L.write(hd.cur, 'refactor_load_core.py', cur.core); L.write(hd.cur, 'refactor_load_hook.py', cur.hook); L.write(hd.cur, 'sitecustomize.py', cur.site);
  const extra = name === 'spawn-path' ? range(P).map(i => L.path.join(dir, `extra/p${i}`)) : [];
  const t = { none: [], old: [], cur: [] };
  let pass = null, ok = true, err = '';
  for (let i = 0; i < REPS; i++) {
    for (const k of Object.keys(t)) {
      const r = runOnce(dir, hd[k], extra);
      t[k].push(r.wall);
      if (!r.ok) { ok = false; err = err || `${k}: ${r.err}`; }
      if (pass === null) pass = r.pass; else if (r.pass !== pass) ok = false;
    }
  }
  const med = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, L.median(v)]));
  const ratio = med.cur / med.old, delta = med.cur - med.old;
  const per = /^spawn/.test(name) ? `${(delta / C).toFixed(2)} ms` : '';
  console.log(`${name.padEnd(12)} ${L.ms(med.none).padEnd(9)} ${L.ms(med.old).padEnd(9)} ${L.ms(med.cur).padEnd(9)} ${ratio.toFixed(2).padEnd(8)} ${L.ms(delta).padEnd(9)} ${per}`);
  L.check(`${name}: suites pass with every hook, same test count`, ok, err || `pass=${pass}`);
  L.check(`${name}: SG45 hooks within 25% / 250 ms of the pre-SG45 hook`, !(ratio > 1.25 && delta > 250), `cur/old ${ratio.toFixed(2)}, +${Math.round(delta)} ms`);
  L.rm(dir);
}
L.finish();
