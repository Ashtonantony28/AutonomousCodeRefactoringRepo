'use strict';

// AUDIT-36 L3: doc drift from SG41 / SG42 in the in-code contracts of
// exported functions (src/ comments, which callers and tests read as the API):
//   a  control: CLAUDE.md and README describe the random switch value and
//      the control run that sets the same variable (SG42).
//   b  bug-injector `editMutants` header still says the switch variable is
//      "set to '1'" and that the control is "the same text with it unset";
//      the element shape line already lists `control`.
//   c  test-runner `tapResults` header still documents `{ tests, load } or
//      null`; it now also returns `suites` (only when any), which runTests
//      passes to `loadFailed(log, root, tests, suites)`.
//   d  CLAUDE.md says caught-load names are "compared as TAP writes them";
//      the ids are TAP names with `\#` / `\\` unescaped (SG41), and only
//      control characters stay as TAP writes them.
// Also checks the live behaviour each statement describes.
//   node audit/36/doc-drift.js

const fs = require('fs');
const path = require('path');
const L = require('../28/lib');
const { editMutants } = require('../../src/rl/bug-injector');
const { tapResults } = require('../../src/runner/test-runner');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const bi = read('src/rl/bug-injector.js'), tr = read('src/runner/test-runner.js');
const claude = read('CLAUDE.md'), readme = read('README.md');

const ms = editMutants('function f(n) {\n  return n + 2;\n}\n', { file: 'm.js', before: 'function f(n) {\n  return n + 1;\n}\n' });
const m = ms[0] || {};
const [[k, v] = []] = Object.entries(m.env || {});
const [[ck, cv] = []] = Object.entries(m.control || {});
console.log(`   live: env ${k}=${JSON.stringify(v)} control ${ck}=${JSON.stringify(cv)}`);
const tap = 'TAP version 13\n# Subtest: s\n    # Subtest: a\n    ok 1 - a\n      ---\n      duration_ms: 1\n      ...\n    1..1\nok 1 - s\n  ---\n  duration_ms: 1\n  type: \'suite\'\n  ...\n1..1\n';
const res = tapResults(tap);
console.log(`   live: tapResults keys=${JSON.stringify(Object.keys(res || {}))}`);

L.report('a control: CLAUDE.md / README describe the random value and the control setting it',
  /random 16-letter/.test(claude) && /random 16-letter/.test(readme) && /^[a-z]{16}$/.test(v) && k === ck && /^[a-z]{16}$/.test(cv) && cv !== v,
  `docs=${/random 16-letter/.test(claude) && /random 16-letter/.test(readme)} env=${v} control=${cv}`, 'documented and live');
L.report("b editMutants header says the switch is set to '1' and the control unsets it", !/set to '1'/.test(bi) && !/with it unset is the mutant's control/.test(bi),
  `"set to '1'": ${/set to '1'/.test(bi)}; "with it unset is the mutant's control": ${/with it unset is the mutant's control/.test(bi)}`,
  'the random `env` value and `control` (another random value) described');
const hdr = tr.slice(tr.indexOf('// Per-test results'), tr.indexOf('const LOAD_FRAME'));
L.report('c tapResults header omits `suites`', /suites/.test(hdr) || !(res && res.suites),
  `header documents "{ tests, load } or null"; live returns ${JSON.stringify(Object.keys(res || {}))}`, '`suites` documented');
L.report('d CLAUDE.md "names compared as TAP writes them" vs unescaped `#` / `\\` ids', !/names compared as TAP writes them/.test(claude),
  `CLAUDE.md: "names compared as TAP writes them"; tapResults("ok 1 - a \\\\#1") id=${JSON.stringify(Object.keys((tapResults('ok 1 - a \\#1\n  ---\n  ...\n') || { tests: {} }).tests))}`,
  'TAP names with `\\#` / `\\\\` unescaped, control characters as TAP writes them');
process.exit(L.exitCode());
