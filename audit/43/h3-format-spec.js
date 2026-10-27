'use strict';

// AUDIT-43 H3: a precision added to a format spec commits on the string's 'x added' kill.
require('./repro')([['token-sites.js', 'H3'], ['run.js', '--only', 'F01,F02,F03']]);
