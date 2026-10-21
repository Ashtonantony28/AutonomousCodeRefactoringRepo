#!/usr/bin/env node
'use strict';

// SG33 load-hook keys: the pytest plugin opens REFACTOR_LOAD_LOG in append
// mode and writes `P <key>` for every test whose phases all passed and every
// collector whose collection passed, on every run (main, mutant, control).
// The JS hook logs only on a module-body throw. loadFailed then reads and
// splits the whole log after the run, on the main thread.
// Suites: pytest with T trivial parametrized tests (T = 1k, 5k, 20k), with
// and without the plugin; node:test with F files, one of which catches a
// module-body throw (`assert.throws(() => require(...))`).
// Reports wall time on / off, log lines and bytes, and the log split time.
// FINDING when the plugin adds more than --max-pct (10%) and more than 250 ms
// to a suite, or the log exceeds --max-mb (8 MB).
//
// usage: node audit/25/hook-volume.js [--tests 1000,5000,20000] [--files 200] [--reps 3]

const L = require('./lib');
const { spawnSync, execFileSync } = require('child_process');

const TESTS = L.nums('--tests', '1000,5000,20000');
const FILES = Number(L.opt('--files', 200));
const REPS = Number(L.opt('--reps', 3));
const MAX_PCT = Number(L.opt('--max-pct', 10));
const MAX_MB = Number(L.opt('--max-mb', 8));

const hookDir = L.tmpDir('a25-hookvol');
L.fs.writeFileSync(L.path.join(hookDir, 'refactor_load_hook.py'), L.hookText('PY_LOAD_HOOK'));
L.fs.writeFileSync(L.path.join(hookDir, 'load-hook.js'), L.hookText('JS_LOAD_HOOK'));
const log = L.path.join(hookDir, 'load.log');

function run(dir, cmd, args, env) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd: dir, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ms: performance.now() - t0, status: r.status, err: (r.stderr || '').slice(-300) };
}

function logStats() {
  let text = '';
  try { text = L.fs.readFileSync(log, 'utf8'); } catch { /* none */ }
  const t0 = performance.now();
  const rows = text.split('\n').map(l => l.split('\t'));
  const passed = new Set(rows.filter(r => r[0] === 'P').map(r => r[1]));
  const ms = performance.now() - t0;
  return { lines: rows.length - 1, bytes: text.length, P: passed.size, T: rows.filter(r => r[0] === 'T').length, parse: ms };
}

const W = [16, 9, 9, 9, 7, 9, 10, 8];
console.log(L.row(['suite', 'off_ms', 'on_ms', 'delta', 'pct', 'lines', 'log_KB', 'split'], W));
function report(name, off, on, st) {
  const pct = ((on - off) / off) * 100;
  console.log(L.row([name, L.fmt(off), L.fmt(on), L.fmt(on - off), L.fmt(pct, 1), st.lines, L.fmt(st.bytes / 1024), L.fmt(st.parse, 1)], W));
  L.check(`${name}: hook adds <= ${MAX_PCT}% or <= 250 ms`, pct <= MAX_PCT || on - off <= 250, `+${L.fmt(on - off)} ms (${L.fmt(pct, 1)}%), ${st.lines} log lines`);
  L.check(`${name}: load log <= ${MAX_MB} MB`, st.bytes <= MAX_MB * 1048576, `${L.fmt(st.bytes / 1024)} KB`);
}

try {
  if (L.pyPath()) {
    const py = L.fs.readFileSync(execFileSync('sh', ['-c', 'command -v pytest'], { encoding: 'utf8' }).trim(), 'utf8').match(/^#!\s*(\S+)/)[1];
    for (const T of TESTS) {
      const dir = L.tmpDir('a25-hookvol-py');
      L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\n');
      L.write(dir, 'pkg/__init__.py', '');
      L.write(dir, 'pkg/m.py', 'def f(x):\n    return x + 1\n');
      // 20 modules, T tests in all: one key per test plus one per collector.
      for (let k = 0; k < 20; k++) {
        L.write(dir, `tests/test_m${k}.py`, `import pytest\nfrom pkg.m import f\n\n@pytest.mark.parametrize('i', range(${Math.ceil(T / 20)}))\ndef test_f(i):\n    assert f(i) == i + 1\n`);
      }
      const env = { PYTHONPYCACHEPREFIX: L.path.join(dir, '.pyc') };
      const t = { off: [], on: [] };
      let st = null;
      for (let r = 0; r < REPS; r++) {
        t.off.push(run(dir, py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], env).ms);
        L.rm(log);
        const on = run(dir, py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-p', 'refactor_load_hook'], { ...env, PYTHONPATH: hookDir, REFACTOR_LOAD_LOG: log });
        if (on.status !== 0) console.log(`  exit ${on.status}: ${on.err}`);
        t.on.push(on.ms);
        st = logStats();
      }
      report(`pytest ${T}`, L.median(t.off), L.median(t.on), st);
      L.rm(dir);
    }
  }
  // node:test, F files; file 0 catches a module-body throw on purpose (a T
  // line and, at exit 0, a P line, for that process only).
  const dir = L.tmpDir('a25-hookvol-js');
  L.write(dir, 'src/bad.js', "throw new Error('config missing');\n");
  L.write(dir, 'src/m.js', 'exports.f = (x) => x + 1;\n');
  for (let f = 0; f < FILES; f++) {
    L.write(dir, `test/t${f}.test.js`, `const test = require('node:test');\nconst assert = require('assert');\nconst { f } = require('../src/m');\n${f === 0 ? "test('bad', () => assert.throws(() => require('../src/bad')));\n" : ''}for (let i = 0; i < 25; i++) test('t' + i, () => assert.strictEqual(f(i), i + 1));\n`);
  }
  const t = { off: [], on: [] };
  let st = null;
  for (let r = 0; r < REPS; r++) {
    t.off.push(run(dir, process.execPath, ['--test'], { NODE_OPTIONS: '' }).ms);
    L.rm(log);
    t.on.push(run(dir, process.execPath, ['--test'], { NODE_OPTIONS: `"--require=${L.path.join(hookDir, 'load-hook.js')}"`, REFACTOR_LOAD_LOG: log }).ms);
    st = logStats();
  }
  report(`node:test ${FILES}f`, L.median(t.off), L.median(t.on), st);
  L.rm(dir);
} finally {
  L.rm(hookDir);
}
L.finish();
