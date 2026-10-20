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

// ---------- SG14: Python lexical semantics checks ----------

function pyLex(cur, prop) {
  const out = {};
  for (const c of polyglot.runChecks({ file: 'm.py', currentSrc: cur, proposedSrc: prop }).checks) { assertCheckResult(c); out[c.check_name] = c; }
  return out;
}

test('Python lexical checks veto a removed raise / early-exit guard / narrowed except', () => {
  const g = pyLex('def safe(p):\n    if ".." in p:\n        raise ValueError("bad")\n    return p\n', 'def safe(p):\n    return p\n').guard_removal;
  assert.strictEqual(g.passed, false);
  assert.strictEqual(g.severity, 'veto');
  assert.match(g.detail, /raise 1 → 0, guard 1 → 0/);
  assert.strictEqual(pyLex('def f(x):\n    if x is None:\n        return 0\n    return x\n', 'def f(x):\n    return x or 0\n').guard_removal.passed, false);
  assert.strictEqual(pyLex('def f(x):\n    assert x > 0\n    return x\n', 'def f(x):\n    return x\n').guard_removal.passed, false);
  const ex = pyLex('def f(d, k):\n    try:\n        return d[k]\n    except KeyError:\n        return None\n', 'def f(d, k):\n    try:\n        return d[k]\n    except Exception as e:\n        return None\n').guard_removal;
  assert.match(ex.detail, /except KeyError changed/);
  assert.strictEqual(pyLex('def f(x):\n    if not x:\n        raise E()\n    return x\n', 'def f(x):\n    if not x: raise E()\n    return x\n').guard_removal.passed, true);
});

test('Python lexical checks veto changed comparison operators, condition literals and defaults', () => {
  const lost = (cur, prop) => { const c = pyLex(cur, prop).condition_change; return c.passed ? null : c.detail; };
  assert.match(lost('def f(s):\n    if len(s) > 255:\n        raise E()\n    return s\n', 'def f(s):\n    if len(s) > 256:\n        raise E()\n    return s\n'), /condition literal 255/);
  assert.match(lost('def f(s):\n    if s == "a":\n        return 1\n    return 2\n', 'def f(s):\n    if s == "b":\n        return 1\n    return 2\n'), /condition literal "a"/);
  assert.match(lost('def f(age):\n    return age >= 18\n', 'def f(age):\n    return age > 18\n'), /comparison >=/);
  assert.match(lost('def f(x):\n    return x == 0\n', 'def f(x):\n    return not x\n'), /comparison ==, compared literal 0/);
  assert.match(lost('def page(items, size=10):\n    return items[:size]\n', 'def page(items, size=20):\n    return items[:size]\n'), /default size 10/);
  assert.match(lost('def f(p):\n    if ".." in p:\n        return 1\n    return 0\n', 'def f(p):\n    if "." in p:\n        return 1\n    return 0\n'), /condition literal ".."/);
  // benign: loop -> builtin, comprehension, f-string, comments, renames
  assert.strictEqual(lost('def total(v):\n    r = 0\n    for x in v:\n        r = r + x\n    return r\n', 'def total(v):\n    return sum(v)\n'), null);
  assert.strictEqual(lost('def sq(xs):\n    out = []\n    for x in xs:\n        out.append(x * x)\n    return out\n', 'def sq(xs):\n    return [x * x for x in xs]\n'), null);
  assert.strictEqual(lost('def label(a, b):\n    return "{}: {}".format(a, b)\n', 'def label(a, b):\n    return f"{a}: {b}"\n'), null);
  assert.strictEqual(lost('def f(n):\n    if n > 3:  # > 4\n        return 1\n    return 0\n', 'def f(count):\n    if count > 3:\n        return 1\n    return 0\n'), null);
});

test('Python lexical checks judge only the edited region of the file, and only Python', () => {
  const file = 'def a(x):\n    if x > 1:\n        raise E()\n    return x\n\n\ndef b(y):\n    r = y + 1\n    return r\n';
  const cur = 'def b(y):\n    r = y + 1\n    return r\n';
  const start = file.indexOf(cur);
  const prop = 'def b(y):\n    return y + 1\n';
  const proposedSrc = file.slice(0, start) + prop;
  const checks = polyglot.runChecks({ file: 'm.py', currentSrc: file, proposedSrc, region: { start, endCurrent: start + cur.length, endProposed: start + prop.length } }).checks;
  assert(checks.every(c => c.passed), JSON.stringify(checks));
  assert.deepStrictEqual(checks.map(c => c.check_name).slice(-2), ['guard_removal', 'condition_change']);
  const go = polyglot.runChecks({ file: 'm.go', currentSrc: 'package x\nfunc A() int {\n\treturn 1\n}\n', proposedSrc: 'package x\nfunc A() int {\n\treturn 2\n}\n' }).checks;
  assert(!go.some(c => c.check_name === 'guard_removal' || c.check_name === 'condition_change'));
});

test('stripCode keepStrings blanks comments only', () => {
  assert.strictEqual(polyglot.stripCode('x = "a#b"  # c\n', 'python', { keepStrings: true }), 'x = "a#b"     \n');
  assert.strictEqual(polyglot.stripCode("a('//x') // y", 'javascript', { keepStrings: true }), "a('//x')     ");
});

// ---------- SG16: the polyglot signature_drift scan gets the JS bounds ----------

const PY_CUR = 'def normalize(a, b):\n    return float(a) + float(b)';
const PY_PROP = 'def normalize(a, b, c=0):\n    return float(a) + float(b) + c';
const pyDrift = (dir) => find(runAll({ proposal: makeProposal('core/util.py', PY_CUR, PY_PROP), repoRoot: dir }), 'signature_drift');

test('Python signature_drift stops at the first file with a call site', () => {
  const files = { 'core/util.py': `${PY_CUR}\n` };
  for (let i = 0; i < 20; i++) files[`p/m${i}.py`] = `from core.util import normalize\n\n\ndef use${i}(a, b):\n    return normalize(a, b)\n`;
  const c = pyDrift(tmpRepo(files));
  assert.strictEqual(c.passed, false);
  assert.strictEqual(c.severity, 'veto');
  assert.match(c.detail, /stops at the first call site/);
  assert.strictEqual((c.detail.match(/normalize in /g) || []).length, 1, c.detail);
});

test('Python signature_drift scans at most 200 files naming the function, says so, and scans files naming the edited module first', () => {
  const files = { 'core/util.py': `${PY_CUR}\n` };
  for (let i = 0; i < 205; i++) files[`m${i}.py`] = `# normalize\nx${i} = ${i}\n`;
  const dir = tmpRepo(files);
  const c = pyDrift(dir);
  assert.strictEqual(c.passed, true, c.detail);
  assert.match(c.detail, /capped at 200 files/);
  // Root files are walked before z/, so a scan in walk order would cap out first.
  fs.mkdirSync(path.join(dir, 'z'));
  fs.writeFileSync(path.join(dir, 'z', 'caller.py'), 'from core.util import normalize\n\nprint(normalize(1, 2))\n');
  const c2 = pyDrift(dir);
  assert.strictEqual(c2.passed, false, c2.detail);
  assert.match(c2.detail, /normalize in z\/caller\.py \(1\)/);
});

test('Python signature_drift over ~15 MB of files naming the function: repeat scans come from the strip cache', () => {
  const files = { 'core/util.py': `${PY_CUR}\n` };
  for (let i = 0; i < 150; i++) {
    let body = `# normalize is not called here\n\n\n`;
    for (let j = 0; body.length < 100_000; j++) body += `def f${i}_${j}(a, b):\n    t = a * ${j} + b\n    return t\n\n\n`;
    files[`p${i % 7}/m${i}.py`] = body;
  }
  const dir = tmpRepo(files);
  assert.strictEqual(pyDrift(dir).passed, true);
  const t0 = performance.now();
  const c = pyDrift(dir);
  const ms = performance.now() - t0;
  assert.strictEqual(c.passed, true, c.detail);
  assert(ms < 400, `warm runChecks took ${ms.toFixed(0)} ms`);
});

test('Python signature_drift strips at most 2 MB of files: a file over the cap is skipped, smaller ones are still scanned (AUDIT-9 H4)', () => {
  assert.strictEqual(polyglot.SCAN_MAX_BYTES, 2_000_000);
  const files = { 'core/util.py': `${PY_CUR}\n` };
  for (let i = 0; i < 4; i++) {
    let body = '# from core.util import normalize (not called)\n\n\n';
    for (let j = 0; body.length < 900_000; j++) body += `def g${i}_${j}(a, b):\n    return a * ${j} + b\n\n\n`;
    files[`big/m${i}.py`] = body;
  }
  const dir = tmpRepo(files);
  const t0 = performance.now();
  const c = pyDrift(dir);
  assert(performance.now() - t0 < 3000);
  assert.strictEqual(c.passed, true, c.detail);
  assert.match(c.detail, /2 MB mentioning the name; rest not checked/);
  fs.mkdirSync(path.join(dir, 'z'));
  fs.writeFileSync(path.join(dir, 'z', 'caller.py'), 'from core.util import normalize\n\nprint(normalize(1, 2))\n');
  const c2 = pyDrift(dir);
  assert.strictEqual(c2.passed, false, c2.detail);
  assert.match(c2.detail, /normalize in z\/caller\.py \(1\)/);
});
