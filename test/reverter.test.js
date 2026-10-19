'use strict';

const { rm } = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FileSnapshot, applyEdit } = require('../src/runner/reverter');
const { makeTempRepo } = require('./helpers/factories');

test('captures, applies via fuzzy match, and restores', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const targetFile = path.join(repo, 'idx2.js');
  const original = '  function f() {\n    return  1;\n  }\n';
  fs.writeFileSync(targetFile, original);
  const snap = new FileSnapshot(repo);
  snap.capture('idx2.js');
  const res = applyEdit({ repoRoot: repo, relPath: 'idx2.js', currentCode: 'function f() { return 1; }', proposedCode: 'function f() { return 2; }' });
  assert(fs.readFileSync(targetFile, 'utf8').includes('return 2'));
  assert(['whitespace', 'fuzzy', 'indent-shift'].includes(res.matchTier));
  snap.restoreAll();
  assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), original);
});
