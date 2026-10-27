'use strict';

// AUDIT-43 H5: a load throw caught by a passing test excuses the sibling test that fails on the missing module.
require('./repro')([['load-probes.js', 'M1'], ['run.js', '--only', 'M01,M02']]);
