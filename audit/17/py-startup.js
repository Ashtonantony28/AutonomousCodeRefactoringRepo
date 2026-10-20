#!/usr/bin/env node
'use strict';

// Python test-run startup cost (SG25: every run is `<pytest's python> -m
// pytest`, coverage adds `-m coverage run`). Repo: F modules of ~KB each under
// pkg/, one test that imports all of them. Measures, per run (median of reps):
//   (a) `pytest -q` (the script) vs `<python> -m pytest -q` (SG25)
//   (b) the same with a fresh PYTHONPYCACHEPREFIX per run (what runTests does
//       for every run, mutant and control runs included) vs a reused one
//   (c) runTests() itself (plain run, as a mutant run) and the main-thread
//       stall of the first call (pytestInterpreter's spawnSync probes)
// FINDING when the fresh bytecode cache costs more than 1 s per run on the
// realistic repo (every mutant/control run pays it: 3 runs per kill), or when
// `-m pytest` is more than 20% slower than the script, or the first-call
// stall exceeds 1 s.
//
// usage: node audit/17/py-startup.js [--files 200,500] [--kb 20] [--reps 3]

const L = require('./lib');
const { spawnSync } = require('child_process');
const { runTests } = require(L.src('runner/test-runner'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const FILES = opt('--files', '200,500').split(',').map(Number);
const KB = Number(opt('--kb', 20));
const REPS = Number(opt('--reps', 3));

const pyDir = L.pytestWithCoverageDir();
if (pyDir) process.env.PATH = `${pyDir}:${process.env.PATH}`;
const pytestScript = spawnSync('sh', ['-c', 'command -v pytest'], { encoding: 'utf8' }).stdout.trim();
const py = (L.fs.readFileSync(pytestScript, 'utf8').match(/^#!\s*(\S+)(?:\s+(\S+))?/) || [])[1];

function gen(n) {
  const dir = L.tmpDir('a17-pystart');
  L.write(dir, 'pkg/__init__.py', '');
  L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\npythonpath = .\n');
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let j = 0; s.length < KB * 1024; j++) s += `def f${i}_${j}(a, b):\n    t = a * ${j % 9} - b\n    if t > ${j % 50}:\n        return t - 1\n    return t\n\n\n`;
    L.write(dir, `pkg/m${i}.py`, s);
  }
  L.write(dir, 'tests/test_all.py', `import importlib\n\ndef test_all():\n    for i in range(${n}):\n        m = importlib.import_module('pkg.m%d' % i)\n        assert m.__dict__['f%d_0' % i](3, 1) == -1\n`);
  L.gitInit(dir);
  return dir;
}

function timed(cmd, argv, cwd, env) {
  const t0 = performance.now();
  const r = spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited ${r.status}: ${(r.stdout + r.stderr).slice(-300)}`);
  return ms;
}

(async () => {
  console.log(`python ${py}; pytest script ${pytestScript}; modules of ~${KB} KB`);
  console.log(L.row(['files', 'MB', 'script_warm', 'm_warm', 'm_freshpyc', 'runTests', 'first_call_stall'], [6, 5, 12, 9, 11, 9, 16]));
  let first = true;
  for (const n of FILES) {
    const dir = gen(n);
    const mb = Number(require('child_process').execSync(`du -sk ${dir}/pkg`).toString().split('\t')[0]) / 1024;
    const warm = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a17-pyc-warm-'));
    const envWarm = { ...process.env, PYTHONPYCACHEPREFIX: warm };
    timed(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], dir, envWarm); // fill the warm cache
    const m = { script: [], mod: [], fresh: [], rt: [] };
    let stall = null;
    for (let r = 0; r < REPS; r++) {
      m.script.push(timed(pytestScript, ['-q', '-p', 'no:cacheprovider'], dir, envWarm));
      m.mod.push(timed(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], dir, envWarm));
      const fresh = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a17-pyc-fresh-'));
      m.fresh.push(timed(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], dir, { ...process.env, PYTHONPYCACHEPREFIX: fresh }));
      L.rm(fresh);
      const { r: rt, ms, stall: st } = await L.withStall(() => runTests({ repoRoot: dir }));
      if (rt.status !== 'passed') throw new Error(`runTests: ${rt.status} ${rt.stdout.slice(-300)}`);
      m.rt.push(ms);
      if (first) { stall = st; first = false; }
    }
    L.rm(warm);
    const s = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, L.median(v)]));
    console.log(L.row([n, L.fmt(mb, 1), L.fmt(s.script), L.fmt(s.mod), L.fmt(s.fresh), L.fmt(s.rt), stall == null ? '-' : L.fmt(stall)], [6, 5, 12, 9, 11, 9, 16]));
    L.check(`${n} modules: '-m pytest' within 20% of the pytest script`, s.mod <= s.script * 1.2 + 50, `${L.fmt(s.mod)} vs ${L.fmt(s.script)} ms`);
    L.check(`${n} modules: fresh bytecode cache per run costs <= 1 s`, s.fresh - s.mod <= 1000, `+${L.fmt(s.fresh - s.mod)} ms per run (runTests ${L.fmt(s.rt)} ms)`);
    if (stall != null) L.check('first runTests call main-thread stall <= 1 s', stall <= 1000, `${L.fmt(stall)} ms`);
    L.rm(dir);
  }
  L.finish();
})();
