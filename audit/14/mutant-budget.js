#!/usr/bin/env node
'use strict';

// A9-C2 / A9-H2 re-run with the diff test the orchestrator attaches. Since
// SG22 the executor accepts a deleted token only on an `equivalent` diff test
// that observed it (or a replacing stretch with a killed site); the audit/9
// scripts call runExecutor without `proposal.diff_test`, so their edit
// (`return a + b` -> `const sum = a + b; return sum`, which deletes `return`)
// is now reverted `tests_insensitive` before any mutant runs, whatever the
// suite. This wrapper attaches diffTesting.run's result, then runs the
// audit/9 script unchanged.
//
// usage: node audit/14/mutant-budget.js mutant-budget [audit/9 mutant-budget.js flags]
//        node audit/14/mutant-budget.js mutant-timing [audit/9 mutant-timing.js flags]

const L = require('./lib');
L.patchExecutorWithDiffTest();
const which = process.argv[2];
if (!['mutant-budget', 'mutant-timing'].includes(which)) {
  console.error('usage: node audit/14/mutant-budget.js mutant-budget|mutant-timing [flags]');
  process.exit(2);
}
process.argv.splice(2, 1);
console.log('(audit/14: executor calls carry the diff test the orchestrator would attach)');
require(`../9/${which}.js`);
