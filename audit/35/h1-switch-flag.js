'use strict';

// AUDIT-35 H1 the Python switch binding is a module attribute, True only in mutant runs (F02 is the control).
// Runs the corpus entries F01,F02 end to end (audit/35/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/35/h1-switch-flag.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'F01,F02'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
