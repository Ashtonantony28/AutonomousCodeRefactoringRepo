'use strict';

// Worker entry used by worker-cov-preload.js: flush V8 coverage before the
// real worker's Atomics.notify wakes the host (which then terminates us).
const v8 = require('v8');
const { workerData } = require('worker_threads');
const notify = Atomics.notify;
Atomics.notify = function (...args) {
  try { v8.takeCoverage(); } catch { /* coverage not enabled */ }
  return notify.apply(Atomics, args);
};
require(workerData.__real);
