'use strict';

// AUDIT-43 H2: a block guard turned into `c && a; b` commits on the `&&` kill; `b` leaves the guard.
require('./repro')([['token-sites.js', 'H2'], ['run.js', '--only', 'G01,G02,G03']]);
