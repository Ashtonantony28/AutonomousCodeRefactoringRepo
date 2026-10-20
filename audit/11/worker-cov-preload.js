'use strict';

// AUDIT-11: loaded with `node -r` (NODE_OPTIONS) by audit/11/coverage.js, and
// again inside every wrapped worker (so a worker that starts a worker is
// covered too). Since SG20, diffTesting.run() starts diff-prep-worker.js
// (which loads diff-testing.js itself and builds the inputs) and that worker
// starts diff-sandbox-worker.js. Both are started with `env: {}` (hides
// NODE_V8_COVERAGE, so V8 would not profile them) and always terminate()d (a
// terminated isolate writes no dump). The wrapper hands the variable through
// and flushes coverage (v8.takeCoverage) right before the worker signals its
// parent. Nothing under src/ is modified.
const path = require('path');
const wt = require('worker_threads');

if (!wt.Worker.__audit11) {
  const Orig = wt.Worker;
  const WRAP = path.join(__dirname, 'worker-cov-wrapper.js');
  const COV = process.env.NODE_V8_COVERAGE;
  class CoverageWorker extends Orig {
    constructor(file, opts = {}) {
      const f = String(file);
      if (COV && /diff-(sandbox|prep)-worker\.js$/.test(f)) {
        opts = {
          ...opts,
          env: { ...(opts.env || {}), NODE_V8_COVERAGE: COV },
          workerData: { ...opts.workerData, __real: f }
        };
        file = WRAP;
      }
      super(file, opts);
    }
  }
  CoverageWorker.__audit11 = true;
  wt.Worker = CoverageWorker;
}
