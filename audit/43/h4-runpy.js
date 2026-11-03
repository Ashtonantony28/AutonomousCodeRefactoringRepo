'use strict';

// AUDIT-43 H4: Python runpy loads are not logged: a load failure counts as a kill.
require('./repro')([['load-probes.js', 'R1'], ['run.js', '--only', 'R01,R02']]);
