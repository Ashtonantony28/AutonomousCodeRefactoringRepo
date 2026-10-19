'use strict';

// Re-runs the AUDIT-1 repros for the round-1 Critical/High findings and checks
// that each is fixed. Prints ok / FINDING per finding; exits 1 on any FINDING.
//   node audit/5/round1-recheck.js

const path = require('path');
const { spawnSync } = require('child_process');

const run = (script) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '1', script)], { encoding: 'utf8', timeout: 600_000 });
  return (r.stdout || '') + (r.stderr || '');
};

const CHECKS = [
  ['A1-C1 guard removal committed', 'e2e-commit.js', (o) => /commit=null/.test(o) && !/status=passed/.test(o)],
  ['A1-H1 anti-pattern checks cannot block', 'ast-checks-cannot-block.js', (o) => /RESULT: blocked/.test(o)],
  ['A1-H2 validated vs applied region', 'validated-vs-applied-region.js', (o) => (o.match(/RESULT: refused/g) || []).length === 3],
  ['A1-H3/H4 diff test equivalent on changed code', 'difftest-holes.js', (o) => !/verdict=equivalent/.test(o)],
  ['A1 corpus escape rate (was 21/36)', 'mutation-corpus.js', (o) => /escape rate: 0\/36/.test(o)]
];

let bad = 0;
for (const [name, script, ok] of CHECKS) {
  const out = run(script);
  const pass = ok(out);
  if (!pass) bad++;
  console.log(`${pass ? 'ok     ' : 'FINDING'} ${name}  (node audit/1/${script})`);
}
if (bad) { console.log(`FINDING: ${bad} round-1 C/H not fixed`); process.exit(1); }
console.log('ok');
