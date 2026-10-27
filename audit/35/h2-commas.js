'use strict';

// AUDIT-35 H2 structural commas outside the documented list commit on a sibling site.
// Runs the corpus entries S01,S02,S03,S04 end to end (audit/35/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/35/h2-commas.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'S01,S02,S03,S04'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
