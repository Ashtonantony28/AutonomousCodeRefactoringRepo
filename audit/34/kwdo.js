'use strict';

// AUDIT-34 M1: SG42 swapped block keywords, `do` arm. `do { ... } while (c);`
// -> `if (c) { ... } while (c);` (the body no longer runs once whatever c
// is). The real code leaves the inserted `if` uncovered; with `do` dropped
// from BLOCK_KW (mutant BI-kwdo, survives the full suite) the `if` stands on
// its own condition / use sites. Shown at editMutants level: an executor
// repro needs a suite killing every site of `t < n` without exposing t >= n.
// test/bug-injector.test.js is then run on the mutated copy (SG43: the
// script had no way to report a test that pins the rule).
//
//   node audit/34/kwdo.js     # FINDING (exit 1) when the mutated copy covers the `if` and the tests stay green
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BI = 'src/rl/bug-injector.js';
const FROM = 'const BLOCK_KW = /^(?:if|elif|else|while|for|do)$/;';
const TO = 'const BLOCK_KW = /^(?:if|elif|else|while|for)$/;';
const before = 'function f(t, n) {\n  do { t += 1; } while (t < n);\n  return t;\n}\n';
const after = 'function f(t, n) {\n  if (t < n) { t += 1; } while (t < n);\n  return t;\n}\n';

function verdict(root) {
  const bi = require(path.join(root, BI));
  const ms = bi.editMutants(after, { file: 'src/x.js', before });
  return { uncovered: (ms.uncovered || {}).text || null, sites: ms.map(m => m.mutation) };
}

const real = verdict(ROOT);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit34-kwdo-'));
let mut, green;
try {
  for (const d of ['src', 'test']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const f = path.join(dir, BI), text = fs.readFileSync(f, 'utf8');
  if (text.split(FROM).length !== 2) throw new Error('BLOCK_KW pattern not found once');
  fs.writeFileSync(f, text.replace(FROM, TO));
  mut = verdict(dir);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  green = spawnSync(process.execPath, ['--test', 'test/bug-injector.test.js'], { cwd: dir, env, stdio: 'ignore', timeout: 900_000 }).status === 0;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`real code:    ${JSON.stringify(real)}`);
console.log(`mutated copy: ${JSON.stringify(mut)}`);
console.log(`test/bug-injector.test.js on the mutated copy: ${green ? 'green' : 'fails'}`);
const finding = real.uncovered !== 'if' || (!mut.uncovered && mut.sites.length > 0 && green);
console.log(finding ? 'FINDING M1 BI-kwdo: the `if` that replaced `do` stands on its own sites in the mutated copy and test/bug-injector.test.js stays green' : 'ok: a test kills the mutant');
process.exitCode = finding ? 1 : 0;
