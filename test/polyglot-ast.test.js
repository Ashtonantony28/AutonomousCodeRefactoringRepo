'use strict';

const { rm } = require('./helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const polyglot = require('../src/validation/polyglot-ast');
const { assertCheckResult } = require('../src/contracts');
const { runChecks: runAll } = require('../src/validation/ast-checker');
const { makeProposal } = require('./helpers/factories');

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-poly-'));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), src);
  }
  test.after(() => rm(dir));
  return dir;
}

const find = (r, name) => r.checks.find(c => c.check_name === name);

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

test('parses async def and multi-line signatures with default commas', () => {
  const src = [
    'async def fetch(url, timeout=(1, 2)):',
    '    return url',
    '',
    'def build(',
    '    a: Dict[str, int],',
    "    sep=',',",
    '    *, opts={"x": 1, "y": 2}):',
    '    return a',
    ''
  ].join('\n');
  const r = polyglot.parsePython(src);
  assert.strictEqual(r.functions.find(f => f.name === 'fetch').params, 2);
  assert.strictEqual(r.functions.find(f => f.name === 'build').params, 3);
});

test('Python stdlib import is not a new dependency; undeclared third-party is; manifests declare', () => {
  const r = polyglot.runChecks({ file: 'm.py', currentSrc: 'def f():\n    return 1\n', proposedSrc: 'import json\nimport os.path\n\ndef f():\n    return json.loads("1")\n' });
  assert.strictEqual(find(r, 'new_dependency').passed, true);
  const bad = polyglot.runChecks({ file: 'm.py', currentSrc: 'x = 1\n', proposedSrc: 'import requests\nx = 1\n' });
  assert.strictEqual(find(bad, 'new_dependency').passed, false);
  const dir = tmpRepo({ 'requirements.txt': 'requests>=2.0\nPyYAML==6.0\n', 'pyproject.toml': '[project]\ndependencies = ["httpx>=0.27"]\n' });
  const ok = polyglot.runChecks({ file: 'm.py', repoRoot: dir, currentSrc: 'x = 1\n', proposedSrc: 'import requests\nimport yaml\nimport httpx\nx = 1\n' });
  assert.strictEqual(find(ok, 'new_dependency').passed, true);
});

test('Python drift with a repo root counts only callers outside the edit', () => {
  const cur = 'def total(values):\n    return sum(values)';
  const prop = 'def total(values, start):\n    return sum(values) + start';
  const lone = tmpRepo({ 'calc/ops.py': `${cur}\n` });
  const r1 = runAll({ proposal: makeProposal('calc/ops.py', cur, prop), repoRoot: lone });
  r1.checks.forEach(c => assertCheckResult(c));
  assert.strictEqual(find(r1, 'signature_drift').passed, true);
  const used = tmpRepo({ 'calc/ops.py': `${cur}\n`, 'app.py': 'from calc.ops import total\nprint(total([1]))\n' });
  const r2 = runAll({ proposal: makeProposal('calc/ops.py', cur, prop), repoRoot: used });
  assert.strictEqual(find(r2, 'signature_drift').passed, false);
});

test('polyglot error-handling check is not appended twice and ignores strings', () => {
  const cur = 'def f():\n    try:\n        return 1\n    except Exception:\n        return 0';
  const dir = tmpRepo({ 'm.py': `${cur}\n` });
  const r = runAll({ proposal: makeProposal('m.py', cur, 'def f():\n    s = "try:"\n    return 1'), repoRoot: dir });
  const eh = r.checks.filter(c => c.check_name === 'error_handling_removal');
  assert.strictEqual(eh.length, 1);
  assert.strictEqual(eh[0].passed, false);
});

test('Go return check uses body returns vs declared results', () => {
  const cur = 'package x\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n';
  const rt = (p) => find(polyglot.runChecks({ file: 'x.go', currentSrc: cur, proposedSrc: p }), 'return_type_change').passed;
  assert.strictEqual(rt('package x\n\nfunc Add(a, b int) int {\n\tfmt.Println(a + b)\n}\n'), false);
  assert.strictEqual(rt('package x\n\nfunc Add(a, b int) {\n\tfmt.Println(a + b)\n}\n'), false);
  assert.strictEqual(rt('package x\n\nfunc Add(a, b int) int {\n\ts := a + b\n\treturn s\n}\n'), true);
  const g = polyglot.parseGo('package x\nfunc (s *S) Do(f func(int) (int, error), n int) (int, error) {\n\treturn f(n)\n}\n');
  assert.deepStrictEqual([g.functions[0].name, g.functions[0].params, g.functions[0].resultCount], ['Do', 2, 2]);
});
