'use strict';

// Worker side of diffTesting.run(): parses both versions, builds the inputs
// and runs the sandbox worker, all inside the caller's hard kill.

const { workerData } = require('worker_threads');

let result;
try {
  result = require('./diff-testing').prepareAndExecute(workerData.opts, workerData.deadline, workerData.progress);
} catch (err) {
  result = { verdict: 'inconclusive', reason: `diff test error: ${err && err.message}`, runs: 0 };
}
workerData.port.postMessage({ type: 'result', result });
const flag = new Int32Array(workerData.flag);
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
