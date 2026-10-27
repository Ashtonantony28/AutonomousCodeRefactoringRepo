'use strict';

// AUDIT-39 M-seminlr: BI-seminlr (audit/11) drops the line-break test of
// `semiReach` to the right, so a kept name on the same line right after an
// inserted `;` reads as a new statement. AUDIT-38 M1 found no load-bearing
// case; SG47 pinned `const x = t + s.v;` -> `const x = t; await s.v;`
// (test/bug-injector.test.js). This builds more: for each edit the real
// code must stop (`uncovered_token ';'`), and a mutated copy of src/ (in a
// temp dir under audit/39, removed after) must judge the edit on its
// sibling site only, which shows the rule is load-bearing for it.
//
//   node audit/39/seminlr.js
//
// FINDING when the real code does not stop. Pure functions; no API calls.

const fs = require('fs');
const path = require('path');
const { L, sites, report } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const FROM = 'if (d > 0) return r.nl && /^(?:';
const TO = 'if (d > 0) return /^(?:';

const J = (...b) => L("'use strict';", ...b, '');
const CASES = [
  ['`let x = a + b;` -> `let x = a; ++b;` (b read later)', 'src/x.js',
    J('function f(a, b) {', '  let x = a + b;', '  return x + b;', '}'), J('function f(a, b) {', '  let x = a; ++b;', '  return x + b;', '}')],
  ['`const x = t * s.v;` -> `const x = t; await s.v;`', 'src/x.js',
    J('async function f(t, s) {', '  const x = t * s.v;', '  return x;', '}'), J('async function f(t, s) {', '  const x = t; await s.v;', '  return x;', '}')],
  ['`const x = a - b;` -> `const x = a; !b - b;`', 'src/x.js',
    J('function f(a, b) {', '  const x = a - b;', '  return x;', '}'), J('function f(a, b) {', '  const x = a; !b - b;', '  return x;', '}')]
];

const dir = fs.mkdtempSync(path.join(__dirname, '.mut-'));
try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  const bi = path.join(dir, 'src', 'rl', 'bug-injector.js');
  const text = fs.readFileSync(bi, 'utf8');
  if (text.split(FROM).length !== 2) throw new Error('BI-seminlr pattern does not match once');
  fs.writeFileSync(bi, text.replace(FROM, TO));
  const mutated = require(bi).editMutants;
  const rows = CASES.map(([label, file, before, after]) => {
    const real = sites(file, before, after);
    const m = mutated(after, { file, before, max: 3 });
    const mStops = !!(m.uncovered || m.unmutated_ref || m.capped || m.unchecked || !m.length);
    const mJudged = [...new Set([...m].map(x => x.mutation))].join(', ');
    return {
      label, finding: !real.stopped,
      detail: `real: ${real.stopped ? `stops (uncovered=${JSON.stringify(real.uncovered)})` : `judged on ${real.judged.join(', ')}`}; ` +
        `BI-seminlr copy: ${mStops ? 'stops (rule not load-bearing here)' : `judged on ${mJudged} (load-bearing)`}`
    };
  });
  report(rows);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
