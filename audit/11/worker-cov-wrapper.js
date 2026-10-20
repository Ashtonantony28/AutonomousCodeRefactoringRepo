'use strict';

// AUDIT-11: worker entry used by worker-cov-preload.js. Re-installs the
// preload in this isolate (the prep worker starts the sandbox worker),
// flushes V8 coverage right before the real worker's Atomics.notify wakes its
// parent (which then terminates this isolate), and loads the real file.
require('./worker-cov-preload.js');
const v8 = require('v8');
const { workerData } = require('worker_threads');

const notify = Atomics.notify;
Atomics.notify = function (...args) {
  try { v8.takeCoverage(); } catch { /* coverage not enabled */ }
  return notify.apply(Atomics, args);
};
require(workerData.__real);
