'use strict';

// AUDIT-30 M1 (TR-dupprefix): a module-body throw logged inside a node:test
// callback is excused only when every result named exactly like that test
// (or its `#n` duplicates) passed. Nothing pins the "exactly": with
// `id.startsWith(name)` a throw in a failing `describe('s')` body (suites have
// no per-test result) is excused by an unrelated passing test 'set'.
//
//   node audit/30/dupprefix.js
//
// Runs runTests on a small repo with the real src/ and with the mutant on a
// temp copy. Prints FINDING (exit 1) when the real code reports the load
// failure (collection_error) and the mutated copy loses it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FROM = "(id.startsWith(name + '#') && /^#\\d+$/.test(id.slice(name.length)))";
const TO = 'id.startsWith(name)';
const TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { describe, it } = test;
test('set', () => {});
describe('s', () => {
  let m;
  try { m = require('../src/config'); } catch (e) { throw new Error('setup: ' + e.message); }
  it('a', () => {});
});
test('f', () => assert.strictEqual(1, 2));
`;

function probe(srcRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit30-dp-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(dir, 'src/config.js'), "'use strict';\nif (!process.env.A30_KEY) throw new Error('A30_KEY required');\n");
    fs.writeFileSync(path.join(dir, 'test/a.test.js'), TEST);
    const code = `const { runTests } = require(${JSON.stringify(path.join(srcRoot, 'src/runner/test-runner.js'))});
      runTests({ repoRoot: ${JSON.stringify(dir)} }).then(r => console.log(JSON.stringify({ status: r.status, collection_error: r.collection_error || null, tests: r.tests })));`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 120_000 });
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout).slice(-300) }; }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const real = probe(ROOT);
console.log(`real code:    ${JSON.stringify(real)}`);
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'audit30-src-'));
let mut;
try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(copy, 'src'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  const f = path.join(copy, 'src/runner/test-runner.js');
  const text = fs.readFileSync(f, 'utf8');
  if (text.split(FROM).length !== 2) throw new Error('mutant pattern not found once');
  fs.writeFileSync(f, text.replace(FROM, () => TO));
  mut = probe(copy);
} finally {
  fs.rmSync(copy, { recursive: true, force: true });
}
console.log(`mutated copy: ${JSON.stringify(mut)}`);
if (real.collection_error === true && !mut.collection_error) {
  console.log('FINDING M1 TR-dupprefix: a load throw in a failing suite is excused by an unrelated passing test whose name it prefixes (full suite green: node audit/11/mutants.js TR-dupprefix)');
  process.exitCode = 1;
} else console.log('ok');
