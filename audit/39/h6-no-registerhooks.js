'use strict';

// AUDIT-39 H6: on a node without module.registerHooks (simulated by
// audit/39/old-node.js) ES module loads are not seen and do not fail closed.
// Runs: load-probes.js H6, run.js --only O01.
// Prints FINDING and exits 1 when the finding reproduces.
//
//   node audit/39/h6-no-registerhooks.js

const { spawnSync } = require('child_process');
const path = require('path');
let bad = false;
for (const args of [["load-probes.js","H6"],["run.js","--only","O01"]]) {
  const r = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: 'inherit' });
  if (r.status !== 0) bad = true;
}
process.exit(bad ? 1 : 0);
