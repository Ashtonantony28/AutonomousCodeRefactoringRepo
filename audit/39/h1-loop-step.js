'use strict';

// AUDIT-39 H1: a JS loop replaced by one `?:` / `&&` step commits on the new
// operator's own site (K03, `while` -> `if`, stops).
// Runs: run.js --only K01,K02,K03 (unit rows: token-sites.js H1).
// Prints FINDING and exits 1 when the finding reproduces.
//
//   node audit/39/h1-loop-step.js

const { spawnSync } = require('child_process');
const path = require('path');
let bad = false;
for (const args of [["run.js","--only","K01,K02,K03"]]) {
  const r = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: 'inherit' });
  if (r.status !== 0) bad = true;
}
process.exit(bad ? 1 : 0);
