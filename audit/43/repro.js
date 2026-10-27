'use strict';

// AUDIT-43 per-finding repro driver: runs the listed steps (load-probes rows,
// run.js corpus entries, token-sites rows) as child processes from the repo
// root, streams their output and exits 1 when any step reports a FINDING.
//   require('./repro')([['load-probes.js', 'U1'], ['run.js', '--only', 'U01,U02']]);

const path = require('path');
const { spawnSync } = require('child_process');

module.exports = function repro(steps) {
  const root = path.join(__dirname, '..', '..');
  let bad = 0;
  for (const [script, ...args] of steps) {
    console.log(`$ node audit/43/${script} ${args.join(' ')}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) bad++;
  }
  console.log(bad ? `FINDING: ${bad} step(s) reproduced` : 'ok');
  process.exitCode = bad ? 1 : 0;
};
