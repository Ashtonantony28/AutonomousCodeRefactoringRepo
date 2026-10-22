'use strict';

// AUDIT-31 H2 while->if / elif->if covered by the new keyword's own negate_condition site
// Runs the corpus entries K01,K02,K03 end to end (audit/31/run.js --only).
// Prints FINDING and exits 1 when a witnessed semantics change is committed.
//
//   node audit/31/h2-keyword-swap.js

const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--only', 'K01,K02,K03'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
