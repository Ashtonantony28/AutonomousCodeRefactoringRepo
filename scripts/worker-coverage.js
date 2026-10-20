'use strict';

// Preloaded by scripts/coverage.js (NODE_OPTIONS -r) and the entry of every
// wrapped diff-test worker. diffTesting.run() starts diff-prep-worker.js, which
// starts diff-sandbox-worker.js; both get `env: {}` (no NODE_V8_COVERAGE, so V8
// does not profile them) and are terminate()d (no dump written). Here they get
// the variable back and flush coverage right before signalling their parent.
const v8 = require('v8');
const wt = require('worker_threads');

const COV = process.env.NODE_V8_COVERAGE;
if (COV && !wt.Worker.covWrapped) {
  const Orig = wt.Worker;
  class CoverageWorker extends Orig {
    constructor(file, opts = {}) {
      const real = String(file);
      if (/diff-(sandbox|prep)-worker\.js$/.test(real)) {
        opts = { ...opts, env: { ...(opts.env || {}), NODE_V8_COVERAGE: COV }, workerData: { ...opts.workerData, covReal: real } };
        file = __filename;
      }
      super(file, opts);
    }
  }
  CoverageWorker.covWrapped = true;
  wt.Worker = CoverageWorker;
}

if (!wt.isMainThread && wt.workerData && wt.workerData.covReal && !globalThis.covEntered) {
  globalThis.covEntered = true;
  const notify = Atomics.notify;
  Atomics.notify = function (...args) {
    try { v8.takeCoverage(); } catch { /* coverage not enabled */ }
    return notify.apply(Atomics, args);
  };
  require(wt.workerData.covReal);
}
