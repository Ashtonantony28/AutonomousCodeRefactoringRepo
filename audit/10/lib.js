'use strict';

// Shared harness for AUDIT-10 repros: the AUDIT-7 harness (temp
// REFACTOR_STATE_DIR / dashboard dir via test/helpers/env.js, stub client,
// quiet, report, runWith, proposals). No API calls; never touches state/ or
// dashboard/.
module.exports = require('../7/lib');
