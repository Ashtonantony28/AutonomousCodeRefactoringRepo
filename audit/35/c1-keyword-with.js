'use strict';

// AUDIT-35 C1 a `with` statement swapped for `if` is covered by the new if's own condition site.
// Runs the corpus entries K01,K02 end to end (audit/35/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/35/c1-keyword-with.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'K01,K02'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
