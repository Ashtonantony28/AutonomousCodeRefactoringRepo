'use strict';

// AUDIT-31 C1 for await (...); empty body is not a structural ; (S07 control: plain for)
// Runs the corpus entries S01,S07 end to end (audit/31/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/31/c1-for-await.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'S01,S07'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
