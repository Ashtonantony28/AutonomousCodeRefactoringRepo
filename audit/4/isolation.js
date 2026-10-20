'use strict';

// AUDIT-4: does every test pass on its own? Runs each top-level test alone
// (`node --test --test-name-pattern=^<name>$ <file>`), which exposes tests
// that only pass because an earlier test in the same file left state behind
// (weights, calibration files, module globals).
//
//   node audit/4/isolation.js [test/file.test.js ...]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function run(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 << 20 });
}

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));

let total = 0;
const broken = [];
for (const file of files) {
  const full = run([file]);
  // single file: top-level tests are unindented "ok N - name"
  const names = [...full.stdout.matchAll(/^(?:not )?ok \d+ - (.*?)(?: # SKIP.*)?$/gm)].map(m => m[1]);
  for (const name of names) {
    total++;
    const r = run([`--test-name-pattern=^${esc(name)}$`, file]);
    const pass = (r.stdout.match(/^# pass (\d+)/m) || [])[1];
    const fail = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
    if (r.status !== 0 || pass === '0') {
      broken.push({ file, name, pass, fail });
      console.log(`FAILS ALONE  ${file} :: ${name}  (pass=${pass} fail=${fail})`);
    }
  }
}
console.log(`\n${total} top-level tests run in isolation; ${broken.length} fail alone`);
process.exitCode = broken.length ? 1 : 0;
