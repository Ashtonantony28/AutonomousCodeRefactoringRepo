'use strict';

// AUDIT-43 C2: a worker thread that catches a load throw and exits 0 excuses it although the file process fails.
require('./repro')([['load-probes.js', 'W1'], ['run.js', '--only', 'W01,W02']]);
