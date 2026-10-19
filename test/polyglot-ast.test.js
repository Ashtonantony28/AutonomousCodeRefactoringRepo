'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const polyglot = require('../src/validation/polyglot-ast');

test('parses Python functions and imports', () => {
  const r = polyglot.parsePython('import os\nimport json\n\ndef foo(a, b):\n    return a + b\n');
  assert(r.functions.find(f => f.name === 'foo' && f.params === 2));
  assert(r.imports.includes('os') && r.imports.includes('json'));
});

test('flags Python signature drift via runChecks', () => {
  const r = polyglot.runChecks({
    file: 'mod.py',
    currentSrc: 'def foo(a, b):\n    return a+b\n',
    proposedSrc: 'def foo(a, b, c):\n    return a+b+c\n'
  });
  assert(r.checks.find(c => c.check_name === 'signature_drift' && c.passed === false));
});

test('parses Go functions and imports', () => {
  const r = polyglot.parseGo('package x\nimport "fmt"\n\nfunc Hello(a int) string { return "hi" }\n');
  assert(r.functions.find(f => f.name === 'Hello' && f.params === 1));
  assert(r.imports.includes('fmt'));
});

test('parses Ruby methods', () => {
  const r = polyglot.parseRuby('def hello(a, b)\n  a + b\nend\n');
  assert(r.functions.find(f => f.name === 'hello' && f.params === 2));
});
