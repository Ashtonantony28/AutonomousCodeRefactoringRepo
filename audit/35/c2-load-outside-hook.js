'use strict';

// AUDIT-35 C2 module-load failures outside the hooked process count as kills (L02 is the control).
// Runs the corpus entries L01,L02,L03,L04 end to end (audit/35/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/35/c2-load-outside-hook.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'L01,L02,L03,L04'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
