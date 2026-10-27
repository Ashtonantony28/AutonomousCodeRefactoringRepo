'use strict';

// AUDIT-39 C1: a JS `;` inserted at the start of a continuation line cuts the kept
// operand and commits (C02, the `;` at the end of the line above, stops).
// Runs: token-sites.js (C1 rows among the others), run.js --only C01,C02.
// Prints FINDING and exits 1 when the finding reproduces.
//
//   node audit/39/c1-semi-continuation.js

const { spawnSync } = require('child_process');
const path = require('path');
let bad = false;
for (const args of [["token-sites.js"],["run.js","--only","C01,C02"]]) {
  const r = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: 'inherit' });
  if (r.status !== 0) bad = true;
}
process.exit(bad ? 1 : 0);
