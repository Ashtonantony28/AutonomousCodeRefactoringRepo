'use strict';

// AUDIT-36 L1, L2: per-test ids after SG41 (`tapResults` unescapes `\#` and
// `\\`; `loadFailed` indexes `name` and `name#<n>`).
//   a   control: `issue #12` keeps its name; two tests `dup` -> `dup`, `dup#2`
//   L1a a test literally named `dup#2` beside two `dup` tests gets the id
//       `dup#2#2`, and `dup#2` (so `mutation.killed_test`) names the second
//       `dup`. Before SG41 the literal name read `dup\#2` and could not
//       collide with the duplicate marker.
//   L1b a caught load throw inside a passing test `parse` is not excused
//       (the run is a load failure) when an unrelated test literally named
//       `parse#1` failed, because `parse#1` is indexed under `parse` too.
//       Fails closed (no kill), never a wrong one.
//   L2  a test whose name holds a line or paragraph separator (U+2028,
//       U+2029) is missing from `tests` (the TAP line regex uses `.`, which
//       stops at those characters), and a suite with such a name drops out
//       of its children's ids. Fails closed (the test can never be a kill).
// Pure functions on strings plus one real `node --test` run in a temp dir.
//   node audit/36/tap-ids.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../28/lib');
const { tapResults, loadFailed } = require('../../src/runner/test-runner');

const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const hasSep = (s) => s.includes(LS) || s.includes(PS);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit36-tap-'));
try {
  // The test file spells the separators as JS escapes (backslash u 2028).
  const esc = (c) => '\\u' + c.charCodeAt(0).toString(16);
  fs.writeFileSync(path.join(dir, 't.test.js'), [
    "const { test, describe } = require('node:test');",
    "test('issue #12', () => {});",
    "test('dup', () => {});",
    "test('dup', () => {});",
    "test('dup#2', () => {});",
    `test('ls${esc(LS)}x', () => {});`,
    `describe('s${esc(PS)}y', () => { test('inner', () => {}); });`,
    ''
  ].join('\n'));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(dir, 't.test.js')], { cwd: dir, encoding: 'utf8' });
  const res = tapResults(r.stdout) || { tests: {} };
  const ids = Object.keys(res.tests);
  console.log(`   ids=${JSON.stringify(ids)} suites=${JSON.stringify(res.suites || {})}`);

  // L1b: loadFailed with a hook log row for a caught throw inside passing `parse`.
  const log = path.join(dir, 'load.log');
  fs.writeFileSync(log, `T\t1.1\t${path.join(dir, 'src', 'm.js')}\t${JSON.stringify('parse')}\n`);
  const alone = loadFailed(log, dir, { parse: 'pass', other: 'fail' });
  const beside = loadFailed(log, dir, { parse: 'pass', 'parse#1': 'fail', other: 'fail' });
  console.log(`   L1b: loadFailed(parse passed)=${alone}  with a failing test literally named "parse#1"=${beside}`);

  L.report('a control: `#` unescaped, duplicates numbered', ids.includes('issue #12') && ids.includes('dup') && ids.includes('dup#2'),
    JSON.stringify(ids.filter(i => /issue|dup/.test(i))), 'issue #12, dup, dup#2, ...');
  L.report('L1a a test literally named `dup#2` collides with the duplicate marker of `dup` (killed_test ambiguous)', !ids.includes('dup#2#2'),
    `ids ${JSON.stringify(ids.filter(i => /^dup/.test(i)))}: "dup#2" is the second "dup", the test named "dup#2" is "dup#2#2"`,
    'an id scheme no test name can produce for a duplicate (or the name kept as written)');
  L.report('L1b a failing test named `parse#1` makes a caught throw in passing `parse` a load failure', alone === false && beside === false,
    `alone=${alone} beside=${beside}`, 'false / false (the throw sits in `parse`, which passed)');
  const inner = ids.find(i => /inner/.test(i));
  L.report('L2 tests named with U+2028 / U+2029 are missing from tests (suite prefix lost)',
    ids.some(i => i.startsWith('ls') && hasSep(i)) && !!inner && hasSep(inner),
    `ids with a separator: ${ids.filter(hasSep).length}; "inner" id: ${JSON.stringify(inner)}`,
    'the U+2028 test present; "inner" carries its suite name');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(L.exitCode());
