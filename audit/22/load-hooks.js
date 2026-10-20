#!/usr/bin/env node
'use strict';

// SG30 M5 load hooks, cost per test run. Every run (main, mutant, control,
// sham) gets them:
//   JS: NODE_OPTIONS --require of a Module._compile wrapper, so every node
//       process of the suite loads it (npm, `node --test`'s per-file child
//       processes, node processes the tests spawn).
//   pytest: `-p refactor_load_hook`, a plugin replacing builtins.__import__
//       with a Python function, so every executed `import` statement (also
//       function-level imports in hot code) goes through it.
// The hook texts are taken from src/runner/test-runner.js; each suite is run
// alternately with and without the hook (--reps each), medians compared.
// Suites:
//   js-files:  `node --test` over F test files, each requiring M modules
//   js-spawn:  one test spawning K node child processes (a CLI suite)
//   py-import: pytest, T tests importing M modules
//   py-hot:    pytest, one test calling a function with a function-level
//              import 200,000 times
// FINDING when the hook adds more than --max-pct (default 10%) and more than
// 250 ms to a suite (the hook then costs more per mutant run than the
// 250 ms output drain the runner already allows).
//
// usage: node audit/22/load-hooks.js [--cases js-files,js-spawn,py-import,py-hot] [--reps 5] [--max-pct 10]

const L = require('./lib');
const { spawnSync } = require('child_process');

const CASES = L.list('--cases', 'js-files,js-spawn,py-import,py-hot');
const REPS = Number(L.opt('--reps', 5));
const MAX_PCT = Number(L.opt('--max-pct', 10));

const runnerSrc = L.fs.readFileSync(L.src('runner/test-runner.js'), 'utf8');
// eslint-disable-next-line no-new-func
const hookText = (name) => new Function(`return ${runnerSrc.match(new RegExp(`const ${name} = (\`[\\s\\S]*?\`);`))[1]}`)();
const JS_HOOK = hookText('JS_LOAD_HOOK');
const PY_HOOK = hookText('PY_LOAD_HOOK');

function measure(name, dir, cmd, args, hookEnv) {
  const base = { ...process.env, CI: '1' };
  delete base.NODE_OPTIONS;
  const times = { off: [], on: [] };
  let status = {};
  for (let k = 0; k < REPS; k++) {
    for (const mode of ['off', 'on']) {
      const env = mode === 'on' ? { ...base, ...hookEnv } : base;
      const t0 = performance.now();
      const r = spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      times[mode].push(performance.now() - t0);
      status[mode] = r.status;
      if (r.status !== 0 && k === 0) console.log(`  ${name} ${mode}: exit ${r.status} ${(r.stderr || '').slice(-300)}`);
    }
  }
  const off = L.median(times.off), on = L.median(times.on);
  const pct = ((on - off) / off) * 100;
  console.log(L.row([name, L.fmt(off), L.fmt(on), L.fmt(on - off), L.fmt(pct, 1), `${status.off}/${status.on}`], [22, 9, 9, 9, 7, 6]));
  L.check(`${name}: load hook adds <= ${MAX_PCT}% or <= 250 ms`, pct <= MAX_PCT || on - off <= 250, `+${L.fmt(on - off)} ms (${L.fmt(pct, 1)}%)`);
}

const hookDir = L.tmpDir('a22-hook');
L.fs.writeFileSync(L.path.join(hookDir, 'load-hook.js'), JS_HOOK);
L.fs.writeFileSync(L.path.join(hookDir, 'refactor_load_hook.py'), PY_HOOK);
const logFile = L.path.join(hookDir, 'load.log');
const jsEnv = { NODE_OPTIONS: `"--require=${L.path.join(hookDir, 'load-hook.js')}"`, REFACTOR_LOAD_LOG: logFile };

console.log(L.row(['suite', 'off_ms', 'on_ms', 'delta', 'pct', 'exit'], [22, 9, 9, 9, 7, 6]));
try {
  if (CASES.includes('js-files')) {
    for (const [F, M] of [[50, 20], [200, 50]]) {
      const dir = L.tmpDir('a22-hook-js');
      for (let m = 0; m < M; m++) L.write(dir, `src/m${m}.js`, `exports.f${m} = (x) => x + ${m};\n`);
      for (let f = 0; f < F; f++) {
        L.write(dir, `test/t${f}.test.js`, `const test = require('node:test');\nconst assert = require('assert');\nconst mods = [];\nfor (let m = 0; m < ${M}; m++) mods.push(require('../src/m' + m));\ntest('t${f}', () => assert.strictEqual(mods[1].f1(1), 2));\n`);
      }
      measure(`js-files ${F}x${M}`, dir, process.execPath, ['--test'], jsEnv);
      L.rm(dir);
    }
  }
  if (CASES.includes('js-spawn')) {
    const K = 100;
    const dir = L.tmpDir('a22-hook-spawn');
    L.write(dir, 'cli.js', 'console.log(Number(process.argv[2]) + 1);\n');
    L.write(dir, 'test/cli.test.js', `const test = require('node:test');\nconst assert = require('assert');\nconst { execFileSync } = require('child_process');\ntest('cli', () => { for (let i = 0; i < ${K}; i++) assert.strictEqual(execFileSync(process.execPath, ['cli.js', String(i)], { encoding: 'utf8' }).trim(), String(i + 1)); });\n`);
    measure(`js-spawn ${K} children`, dir, process.execPath, ['--test'], jsEnv);
    L.rm(dir);
  }
  const pyOk = (CASES.includes('py-import') || CASES.includes('py-hot')) && L.pyPath();
  const py = pyOk ? require(L.src('runner/test-runner')) && (() => {
    const head = L.fs.readFileSync(require('child_process').execFileSync('sh', ['-c', 'command -v pytest'], { encoding: 'utf8' }).trim(), 'utf8');
    return head.match(/^#!\s*(\S+)/)[1];
  })() : null;
  const pyEnv = (dir) => ({ PYTHONPATH: hookDir, REFACTOR_LOAD_LOG: logFile, PYTHONDONTWRITEBYTECODE: '', PYTHONPYCACHEPREFIX: L.path.join(dir, '.pyc') });
  if (py && CASES.includes('py-import')) {
    for (const [T, M] of [[2000, 200]]) {
      const dir = L.tmpDir('a22-hook-py');
      L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\n');
      L.write(dir, 'pkg/__init__.py', '');
      for (let m = 0; m < M; m++) L.write(dir, `pkg/m${m}.py`, `import json, os, re\n\ndef f(x):\n    return x + ${m}\n`);
      L.write(dir, 'tests/test_m.py', `import importlib\nimport pytest\n\n@pytest.mark.parametrize('i', range(${T}))\ndef test_m(i):\n    m = importlib.import_module('pkg.m%d' % (i % ${M}))\n    from pkg import m0\n    assert m.f(0) == i % ${M}\n`);
      // Both modes with the plugin flag present only in 'on' (as runTests adds it).
      measure(`py-import ${T}x${M}`, dir, 'sh', ['-c', `if [ -n "$REFACTOR_LOAD_LOG" ]; then exec ${py} -m pytest -q -p refactor_load_hook; else exec ${py} -m pytest -q; fi`], pyEnv(dir));
      L.rm(dir);
    }
  }
  if (py && CASES.includes('py-hot')) {
    const dir = L.tmpDir('a22-hook-pyhot');
    L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\n');
    L.write(dir, 'pkg/__init__.py', '');
    L.write(dir, 'pkg/m.py', 'def enc(x):\n    import json\n    from os import path\n    return len(path.join("a", str(x))) + len(json.__name__)\n');
    L.write(dir, 'tests/test_m.py', 'from pkg.m import enc\n\ndef test_hot():\n    assert sum(enc(i) for i in range(200000)) > 0\n');
    measure('py-hot 200k fn imports', dir, 'sh', ['-c', `if [ -n "$REFACTOR_LOAD_LOG" ]; then exec ${py} -m pytest -q -p refactor_load_hook; else exec ${py} -m pytest -q; fi`], pyEnv(dir));
    L.rm(dir);
  }
} finally {
  L.rm(hookDir);
}
L.finish();
