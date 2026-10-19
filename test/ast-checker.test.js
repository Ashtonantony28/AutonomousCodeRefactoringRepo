'use strict';

const { rm } = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { runChecks, checkErrorHandlingRemoval } = require('../src/validation/ast-checker');
const { makeTempRepo, makeProposal } = require('./helpers/factories');

const repo = makeTempRepo();
test.after(() => rm(repo));

test('detects error handling removal', () => {
  const c = checkErrorHandlingRemoval({ currentSrc: 'try { foo(); } catch (e) {}', proposedSrc: 'foo();' });
  assert.strictEqual(c.passed, false);
});

test('passes when no try/catch removed', () => {
  const c = checkErrorHandlingRemoval({ currentSrc: 'x;', proposedSrc: 'y;' });
  assert.strictEqual(c.passed, true);
});

test('detects signature drift across the repo', () => {
  const proposal = makeProposal('index.js',
    'function add(a, b) {\n  try { return a + b; } catch (e) { return null; }\n}',
    'function add(a, b, c) {\n  return a + b + c;\n}'
  );
  const result = runChecks({ proposal, repoRoot: repo });
  assert(result.checks.find(c => c.check_name === 'signature_drift'));
});

test('detects new undeclared dependency', () => {
  const proposal = makeProposal('index.js',
    "const _ = require('lodash');",
    "const _ = require('lodash');\nconst chalk = require('chalk');"
  );
  const result = runChecks({ proposal, repoRoot: repo });
  const dep = result.checks.find(c => c.check_name === 'new_dependency');
  assert.strictEqual(dep.passed, false);
});
