'use strict';

// AUDIT-39 H3: Python loads through importlib (import_module, reload,
// exec_module) are not logged, so a load failure kills (P02, an `import`
// statement, stops).
// Runs: load-probes.js H3, run.js --only P01,P02.
// Prints FINDING and exits 1 when the finding reproduces.
//
//   node audit/39/h3-py-importlib.js

const { spawnSync } = require('child_process');
const path = require('path');
let bad = false;
for (const args of [["load-probes.js","H3"],["run.js","--only","P01,P02"]]) {
  const r = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: 'inherit' });
  if (r.status !== 0) bad = true;
}
process.exit(bad ? 1 : 0);
