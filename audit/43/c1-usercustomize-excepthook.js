'use strict';

// AUDIT-43 C1: an operator usercustomize that sets sys.excepthook hides a child main module that raises.
require('./repro')([['load-probes.js', 'U1'], ['run.js', '--only', 'U01,U02']]);
