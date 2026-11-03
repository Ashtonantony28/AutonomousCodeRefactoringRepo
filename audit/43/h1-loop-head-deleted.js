'use strict';

// AUDIT-43 H1: a loop head deleted (no inserted token) commits on the diff test alone.
require('./repro')([['run.js', '--only', 'D01,D02,D03,D04']]);
