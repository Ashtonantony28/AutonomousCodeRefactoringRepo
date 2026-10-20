'use strict';

// Re-runs the round-1 and round-2 soundness repros that MUST stay fixed, and
// checks the builders' edits to those scripts did not weaken them. Each child
// exits non-zero if its finding reproduced; here `ok` = finding stayed fixed.
//
//   node audit/8/prior-recheck.js
// Prints FINDING (exit 1) if any prior Critical/High reproduces or an
// expected-fixed audit/7 invariant regresses.

const { execFileSync } = require('child_process');
const path = require('path');
const repo = path.join(__dirname, '..', '..');

// [script, mustExitZero] — mustExitZero=true: finding must stay fixed (exit 0).
const CHECKS = [
  ['audit/1/e2e-commit.js', true],            // A1-C1 guard removal commit
  ['audit/1/mutation-corpus.js', true],       // A1 corpus (was 21/36)
  ['audit/5/round1-recheck.js', true],        // round-1 C/H re-run
  ['audit/5/e2e-commit.js', true],            // A5 C1-C3/H6: 0 committed
  ['audit/5/critic-edge-cases.js', true],     // A5-M2 jury dissent/edge cases
  ['audit/5/anchor-placement.js', true],      // A5 anchor/region (incl A6)
  ['audit/7/sample-identity.js', true],       // A7-H1 (edited by builders)
  ['audit/7/resume-worktree-gone.js', true],  // A7-H3 (edited by builders)
  ['audit/7/untested-failure-label.js', true] // A7-H2
];

let bad = 0;
for (const [script, mustZero] of CHECKS) {
  let code = 0;
  try {
    execFileSync(process.execPath, [script], { cwd: repo, stdio: 'ignore', timeout: 600000 });
  } catch (e) { code = e.status == null ? 1 : e.status; }
  const ok = mustZero ? code === 0 : code !== 0;
  console.log(`${ok ? 'ok    ' : 'FINDING'}  ${script} (exit ${code})`);
  if (!ok) bad++;
}
if (bad) { console.log(`FINDING: ${bad} prior repro(s) regressed`); process.exit(1); }
console.log('ok');
