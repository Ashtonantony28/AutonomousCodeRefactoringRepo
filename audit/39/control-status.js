'use strict';

// AUDIT-39 L1 (docs drift): CLAUDE.md says a kill must reproduce: "the same
// test fails a second mutant run and the suite then passes with the switch
// off". The executor only needs the killing test to pass in the control
// run; the control run itself may fail (another test failing). Here one test
// fails whenever the switch variable is set (mutant AND control runs: it
// checks the environment for REFACTOR_MUTANT*), so the suite never passes
// with the switch off, yet the edit is committed on the other test's kill.
// The kill itself is genuine (`n * 2` -> `2 * n` preserves behaviour), so this is
// drift between the documented rule and the code, not a false negative.
//
//   node audit/39/control-status.js
//
// FINDING when the edit is committed although no control run passed while
// CLAUDE.md still says the suite passes with the switch off (SG50 reworded it
// to the per-test rule: the killing test passes in the control).
// Temp state via audit/1/lib.js (test/helpers/env.js); stub client only.

const fs = require('fs');
const path = require('path');
const { e2e, UNANIMOUS } = require('../5/lib');

const L = (...l) => l.join('\n');
const cur = L('function twice(n) {', '  return n * 2;', '}');
const prop = L('function twice(n) {', '  return 2 * n;', '}');
const files = {
  'src/twice.js': L("'use strict';", cur, 'module.exports = { twice };', ''),
  'test/twice.test.js': L("'use strict';", "const test = require('node:test');", "const assert = require('node:assert');", "const m = require('../src/twice');", '',
    "test('twice', () => { assert.strictEqual(m.twice(2), 4); assert.strictEqual(m.twice(0), 0); });",
    "test('no stray refactor switches in the environment', () => { assert.ok(!Object.keys(process.env).some(k => /^REFACTOR_MUTANT/.test(k))); });", '')
};

(async () => {
  const quiet = console.log, qw = console.warn;
  console.log = () => {}; console.warn = () => {};
  let r;
  try { r = await e2e({ files, pkg: { scripts: { test: 'node --test' } }, file: 'src/twice.js', cur, prop, critic: UNANIMOUS }); } finally { console.log = quiet; console.warn = qw; }
  const o = r.proposal.test_outcome || {};
  const mut = o.mutation || {};
  const line = `status=${o.status} reason=${o.reason || '-'} killed=${mut.killed} by=${JSON.stringify(mut.killed_test)} runs=${mut.run} commit=${r.commit ? r.commit.slice(0, 12) : null}`;
  const doc = fs.readFileSync(path.join(__dirname, '../../CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
  if (r.commit && /suite then passes with the switch off/.test(doc)) {
    console.log(`FINDING L1: committed although the env test fails in every switch-on and switch-off run\n        ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`ok      ${r.commit ? 'committed on the killing test, as CLAUDE.md documents' : 'not committed'}\n        ${line}`);
  }
})();
