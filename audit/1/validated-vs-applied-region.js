'use strict';

// The validators (critic, AST, diff test) judge proposal.current_code, but
// the executor replaces whatever region the anchor matcher's whitespace tier
// maps it to. Collapsing whitespace is not semantics-preserving (string
// literals, ASI after `return`, Python indentation), so the region actually
// replaced can differ in behaviour from the code that was validated.
//   node audit/1/validated-vs-applied-region.js
// Expected: apply_failed (anchor not verbatim) or a veto. Observed: gate
// passes (dry_run) and applyEdit rewrites a semantically different region.

const fs = require('fs');
const path = require('path');
const { makeRepo, throughGate, summary, rm } = require('./lib');
const { applyEdit } = require('../../src/runner/reverter');

const cases = [
  {
    id: 'W1 JS string literal whitespace',
    file: 'src/banner.js',
    src: "'use strict';\nfunction banner(name) {\n  return 'Total:    ' + name;\n}\nmodule.exports = { banner };\n",
    cur: "function banner(name) {\n  return 'Total: ' + name;\n}",
    prop: 'function banner(name) {\n  return `Total: ${name}`;\n}',
    run: (m) => JSON.stringify(m.banner(5))
  },
  {
    id: 'W2 JS ASI after return',
    file: 'src/sum.js',
    src: "'use strict';\nfunction total(a, b) {\n  return\n    a + b;\n}\nmodule.exports = { total };\n",
    cur: 'function total(a, b) {\n  return a + b;\n}',
    prop: 'function total(a, b) {\n  const s = a + b;\n  return s;\n}',
    run: (m) => JSON.stringify(m.total(1, 2))
  },
  {
    id: 'W3 Python block structure',
    file: 'calc/ops.py',
    src: 'def stats(xs):\n    total = 0\n    count = 0\n    for x in xs:\n        total += x\n        count += 1\n    return total, count\n',
    cur: '    for x in xs:\n        total += x\n    count += 1',
    prop: '    total += sum(xs)\n    count += 1',
    run: null
  }
];

function load(src) {
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src)(m, m.exports, require);
  return m.exports;
}

(async () => {
  for (const c of cases) {
    const repo = makeRepo({ [c.file]: c.src });
    try {
      const { proposal } = await throughGate({ repo, file: c.file, current: c.cur, proposed: c.prop });
      const s = summary(proposal);
      const before = fs.readFileSync(path.join(repo, c.file), 'utf8');
      console.log(`\n== ${c.id}`);
      console.log(`gate: status=${s.status} combined=${s.combined} dt=${s.diff_test} failed_checks=[${s.failed_checks}]`);
      const vr = proposal.validated_region;
      console.log(`validated on: ${vr ? `matched region (tier=${vr.tier})` : 'current_code (anchor did not resolve)'}`);
      let edit;
      try {
        edit = applyEdit({ repoRoot: repo, relPath: c.file, currentCode: c.cur, proposedCode: c.prop, expectedRegion: vr ? vr.text : null });
      } catch (err) {
        console.log(`RESULT: refused (tier=${err.tier} reason=${err.detail && err.detail.reason}): ${err.message}`);
        continue;
      }
      const after = fs.readFileSync(path.join(repo, c.file), 'utf8');
      console.log(`RESULT: ${vr && vr.text === before.slice(edit.matchStart, edit.matchEnd) ? 'validated on the applied region' : 'APPLIED A REGION THAT WAS NOT VALIDATED'}`);
      console.log(`verbatim in file: ${before.includes(c.cur)}; applied via tier=${edit.matchTier}`);
      console.log(`replaced region: ${JSON.stringify(before.slice(edit.matchStart, edit.matchEnd))}`);
      console.log(`validated as:    ${JSON.stringify(c.cur)}`);
      if (c.run) console.log(`behaviour: before=${c.run(load(before))} after=${c.run(load(after))}`);
      else console.log(`after:\n${after}`);
    } finally { rm(repo); }
  }
})();
