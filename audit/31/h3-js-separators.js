'use strict';

// AUDIT-31 H3 JS with (o); / same-line ; / comma splitting an operand carry the change
// Runs the corpus entries S02,S03,S04 end to end (audit/31/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/31/h3-js-separators.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'S02,S03,S04'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
