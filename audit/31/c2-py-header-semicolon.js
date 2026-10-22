'use strict';

// AUDIT-31 C2 Python ; after a multi-line / backslash-continued compound header
// Runs the corpus entries S05,S06 end to end (audit/31/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/31/c2-py-header-semicolon.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'S05,S06'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
