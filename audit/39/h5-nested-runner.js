'use strict';

// AUDIT-39 H5: a file process of a nested `node --test` that a test spawns counts as
// a runner's file process: its caught load failure is excused and the outer
// test's failure kills.
// Runs: load-probes.js H5, run.js --only N01.
// Prints FINDING and exits 1 when the finding reproduces.
//
//   node audit/39/h5-nested-runner.js

const { spawnSync } = require('child_process');
const path = require('path');
let bad = false;
for (const args of [["load-probes.js","H5"],["run.js","--only","N01"]]) {
  const r = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: 'inherit' });
  if (r.status !== 0) bad = true;
}
process.exit(bad ? 1 : 0);
