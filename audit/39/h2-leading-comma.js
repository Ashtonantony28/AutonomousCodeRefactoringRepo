'use strict';

// AUDIT-39 H2: a `,` inserted before kept arguments / elements shifts them and
// commits on the inserted sibling's kill (S03, a split between kept tokens, stops).
// Runs: run.js --only S01,S02,S03 (unit rows: token-sites.js H2).
// Prints FINDING and exits 1 when the finding reproduces.
//
//   node audit/39/h2-leading-comma.js

const { spawnSync } = require('child_process');
const path = require('path');
let bad = false;
for (const args of [["run.js","--only","S01,S02,S03"]]) {
  const r = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: 'inherit' });
  if (r.status !== 0) bad = true;
}
process.exit(bad ? 1 : 0);
