'use strict';

// Loaded with `node -r` (via NODE_OPTIONS) by audit/4/worker-coverage.js.
// diff-testing.js always terminate()s its worker, and a terminated isolate
// never writes its NODE_V8_COVERAGE dump. This swaps the worker entry point
// for a wrapper that flushes coverage (v8.takeCoverage) just before the
// worker signals the host, then loads the real worker file unchanged.
const path = require('path');
const wt = require('worker_threads');
const Orig = wt.Worker;
const WRAP = path.join(__dirname, 'worker-cov-wrapper.js');

class CoverageWorker extends Orig {
  constructor(file, opts = {}) {
    if (String(file).endsWith('diff-sandbox-worker.js')) {
      // the real call passes env: {}, which also hides NODE_V8_COVERAGE from
      // the worker, so V8 would not profile it; hand that one variable through.
      opts = {
        ...opts,
        env: { ...(opts.env || {}), NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE },
        workerData: { ...opts.workerData, __real: String(file) }
      };
      file = WRAP;
    }
    super(file, opts);
  }
}
wt.Worker = CoverageWorker;
