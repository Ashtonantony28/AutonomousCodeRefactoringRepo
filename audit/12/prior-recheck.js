'use strict';

// Re-runs the round-1/2/3 soundness repros. `ok` = the finding stays fixed
// (child exit 0). The AUDIT-8 corpus entries DM3, DM5, DM8 were left open by
// SG18 and are checked separately (child exit 1 = still escaping).
//
//   node audit/12/prior-recheck.js
// Prints FINDING (exit 1) if a prior repro regressed or DM3/DM5/DM8 still escape.

const { execFileSync } = require('child_process');
const path = require('path');
const repo = path.join(__dirname, '..', '..');

const SG18_ONLY = 'LG1,LG5,VS1,VS3,VS8,VS11,BI1,BI3,DM1,DM7,HG1,HG3,HG5,HG6,HG7';
const SG19_ONLY = 'PA1,PA3,PA6,PA10,PA13,PA16,PA18,PA23';
const CHECKS = [
  ['audit/8/prior-recheck.js'],                       // rounds 1-2 (9 scripts incl. audit/5/e2e-commit.js)
  ['audit/8/e2e-commit.js'],                          // A8-C1/C2: X1-X6 not committed
  ['audit/8/mutation-corpus.js', '--only', SG18_ONLY], // A8-H1/H2 accept list
  ['audit/8/mutation-corpus.js', '--only', SG19_ONLY], // A8-H3 accept list
  ['audit/5/mutation-corpus.js']                      // A5 corpus: 0/97 escapes
];

function run(args) {
  try {
    execFileSync(process.execPath, args, { cwd: repo, stdio: 'ignore', timeout: 900000 });
    return 0;
  } catch (e) { return e.status == null ? 1 : e.status; }
}

let bad = 0;
for (const args of CHECKS) {
  const code = run(args);
  console.log(`${code === 0 ? 'ok     ' : 'FINDING'}  node ${args.join(' ')} (exit ${code})`);
  if (code !== 0) bad++;
}
const dm = run(['audit/8/mutation-corpus.js', '--only', 'DM3,DM5,DM8']);
console.log(`${dm === 0 ? 'ok     ' : 'FINDING'}  node audit/8/mutation-corpus.js --only DM3,DM5,DM8 (exit ${dm}; exit 1 = still escaping)`);
if (bad) { console.log(`FINDING: ${bad} prior repro(s) regressed`); process.exit(1); }
if (dm !== 0) { console.log('FINDING: AUDIT-8 DM3/DM5/DM8 still escape (prior fixes otherwise hold)'); process.exit(1); }
console.log('ok');
