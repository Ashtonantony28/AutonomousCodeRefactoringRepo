#!/usr/bin/env node
'use strict';

// coverage.py evidence path of src/runner/test-runner.js: `python -m coverage
// run -m pytest` in pytest's interpreter, then `coverage json` through
// spawnSync (synchronous, its own 30 s timeout, outside the test timeout),
// then pyExercised. Generated pytest repos of N modules (50 of them ~197 KB),
// all imported by the tests. Compared with a plain run (no `edit`).
//
// usage: node audit/6/coverage-py.js [--files 50,200,500]

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const args = process.argv.slice(2);
const SIZES = (args.includes('--files') ? args[args.indexOf('--files') + 1] : '50,200,500').split(',').map(Number);

L.isolateState('covpy');
const { runTests, changedSpan, coverageTool } = require(L.src('runner/test-runner'));

function genPy(n) {
  const dir = L.tmpDir('pyrepo');
  fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
  fs.mkdirSync(path.join(dir, 'tests'));
  let test = 'import importlib\n\n\ndef test_all():\n';
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const target = i < 50 ? 197_000 : 1000 + ((i * 7919) % 40_000);
    let body = '';
    let j = 0;
    while (body.length + 120 < target) { body += `def f${i}_${j}(a, b):\n    t = a * ${j} + b\n    return t\n\n\n`; j++; }
    fs.writeFileSync(path.join(dir, 'pkg', `m${i}.py`), body);
    bytes += body.length;
    test += `    assert importlib.import_module('pkg.m${i}').f${i}_0(1, 2) == 2\n`;
  }
  fs.writeFileSync(path.join(dir, 'tests', 'test_all.py'), test);
  return { dir, bytes };
}

async function main() {
  console.log(L.row(['modules', 'MB', 'tool', 'plain_ms', 'cov_total_ms', 'cov_suite_ms', 'post_ms', 'stall_ms', 'status', 'exercised'], [8, 6, 12, 9, 13, 13, 8, 9, 8, 9]));
  for (const n of SIZES) {
    const { dir, bytes } = genPy(n);
    const plain = await L.timeAsync(() => runTests({ repoRoot: dir }));
    const rel = 'pkg/m0.py';
    const abs = path.join(dir, rel);
    const before = fs.readFileSync(abs, 'utf8');
    const after = before.replace('def f0_0(a, b):\n    t = a * 0 + b\n    return t', 'def f0_0(a, b):\n    return a * 0 + b');
    fs.writeFileSync(abs, after);
    const span = changedSpan(before, after);
    const tool = coverageTool(rel, { cmd: 'pytest' });
    const mon = L.stallMonitor(10);
    const cov = await L.timeAsync(() => runTests({ repoRoot: dir, edit: { file: rel, ...span } }));
    await new Promise(r => setTimeout(r, 30));
    const stall = mon.stop();
    const r = cov.r;
    console.log(L.row([n, (bytes / 1e6).toFixed(1), tool || 'none', L.fmt(plain.ms, 0), L.fmt(cov.ms, 0), L.fmt(r.execution_time_ms, 0), L.fmt(cov.ms - r.execution_time_ms, 0), L.fmt(stall.max, 0), r.status, r.coverage ? `${r.coverage.exercised} ${r.coverage.reason || ''}` : '-'], [8, 6, 12, 9, 13, 13, 8, 9, 8, 9]));
    L.rm(dir);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
