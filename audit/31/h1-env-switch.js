'use strict';

// AUDIT-31 H1 a test that reads the environment kills every switch mutant (E04 control)
// Runs the corpus entries E01,E02,E03,E04 end to end (audit/31/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/31/h1-env-switch.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'E01,E02,E03,E04'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
