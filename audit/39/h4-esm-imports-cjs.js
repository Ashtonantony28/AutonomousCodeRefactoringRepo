'use strict';

// AUDIT-39 H4: import() of a CommonJS source is compiled by node's ESM translator,
// not Module._compile, once module.registerHooks is in use: a caught load
// failure kills (E02, an ES module source, stops).
// Runs: load-probes.js H4, run.js --only E01,E02.
// Prints FINDING and exits 1 when the finding reproduces.
//
//   node audit/39/h4-esm-imports-cjs.js

const { spawnSync } = require('child_process');
const path = require('path');
let bad = false;
for (const args of [["load-probes.js","H4"],["run.js","--only","E01,E02"]]) {
  const r = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: 'inherit' });
  if (r.status !== 0) bad = true;
}
process.exit(bad ? 1 : 0);
