#!/usr/bin/env node
'use strict';

// AUDIT-37 L3: why audit/11's BI-pyflag subset takes ~600 s. Under that
// mutant (the Python binding holds the comparison, `_k = ...get('K') ==
// 'v'`, and each switch reads `_k`), test/helpers/factories.js plainMutant()
// no longer finds the Python binding text, takes the JS branch and calls
// `close(i)`, whose `for (let d = 0; ; i++)` has no end-of-string bound: it
// spins forever (CPU-bound in test/bug-injector.test.js and
// test/executor.test.js; a CDP stack of the spinning process shows
// plainMutant). audit/11/mutants.js only ends it by its 600 s spawnSync
// timeout, which it then counts as a kill. No load hook is involved.
//
// Builds a real Python mutant with the current editMutants, rewrites it the
// way BI-pyflag's src would emit it, and calls plainMutant in a worker with a
// --ms deadline (default 5000). Also checks that the unmutated shape returns.
//
// usage: node audit/37/plain-mutant-hang.js [--ms 5000]

const L = require('../29/lib');
const { Worker } = require('worker_threads');

const MS = Number(L.opt('--ms', 5000));
L.pyPath();
const { editMutants } = require(L.src('rl/bug-injector'));
const before = 'def f(n):\n    return n + 1\n';
const edited = 'def f(n):\n    return n + 2\n';
const ms = editMutants(edited, { file: 'pkg/m.py', before, max: 1 });
if (!Array.isArray(ms) || !ms.length) { console.log('FINDING: no Python mutant built', JSON.stringify(ms)); process.exit(1); }
const m = ms[0];
const [[name, val]] = Object.entries(m.env), on = `_${name.toLowerCase()}`;
const flagged = { ...m, src: m.src.replace(`${on} = __import__('os').environ.get('${name}')`, `${on} = __import__('os').environ.get('${name}') == '${val}'`).split(`${on} == '${val}'`).join(on) };

function call(mut) {
  return new Promise((resolve) => {
    const w = new Worker(`const { parentPort, workerData } = require('worker_threads');
      const { plainMutant } = require(workerData.f);
      const t0 = Date.now(); let out; try { out = plainMutant(workerData.m); } catch (e) { out = 'threw ' + e.message; }
      parentPort.postMessage({ out, ms: Date.now() - t0 });`, { eval: true, workerData: { f: L.path.join(L.REPO_ROOT, 'test/helpers/factories.js'), m: mut } });
    const t = setTimeout(() => { w.terminate(); resolve({ hung: true }); }, MS);
    w.on('message', (r) => { clearTimeout(t); w.terminate(); resolve(r); });
    w.on('error', (e) => { clearTimeout(t); resolve({ out: 'error ' + e.message }); });
  });
}

(async () => {
  const a = await call(m);
  console.log(`current mutant: ${a.hung ? `still running after ${MS} ms` : `returned in ${a.ms} ms: ${JSON.stringify(a.out).slice(0, 80)}`}`);
  L.check('plainMutant returns on the current switch shape', !a.hung, '');
  const b = await call(flagged);
  console.log(`BI-pyflag shape: ${b.hung ? `still running after ${MS} ms (terminated)` : `returned in ${b.ms} ms: ${JSON.stringify(b.out).slice(0, 80)}`}`);
  L.check('plainMutant ends (returns or throws) on an unexpected switch shape', !b.hung, b.hung ? `no return within ${MS} ms: close() has no end-of-string bound` : '');
  L.finish();
})();
