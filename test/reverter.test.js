'use strict';

const { rm, copyFixture } = require('./helpers/env');
const { execFileSync } = require('child_process');
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

function hasPython() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('token-different anchor (< vs >) is not applied and carries detail.closest', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const file = path.join(repo, 'cmp.js');
  const original = 'function g(a, b, x) {\n  if (a < b) { return x; }\n  return 0;\n}\n';
  fs.writeFileSync(file, original);
  assert.throws(
    () => applyEdit({ repoRoot: repo, relPath: 'cmp.js', currentCode: 'if (a > b) { return x; }', proposedCode: 'if (a > b) { return null; }' }),
    (e) => /anchor match failed/.test(e.message) && Boolean(e.detail && e.detail.closest) && typeof e.detail.closest.score === 'number'
  );
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
});

test('254-char shared-prefix tie fails as ambiguous and leaves the file untouched', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const prefix = 'const v = ' + 'a'.repeat(243);
  const original = `${prefix}1\n${prefix}2\n`;
  fs.writeFileSync(path.join(repo, 'tie.js'), original);
  assert.throws(() => applyEdit({ repoRoot: repo, relPath: 'tie.js', currentCode: `${prefix}3`, proposedCode: `${prefix}4` }), /ambiguous/);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'tie.js'), 'utf8'), original);
});

test('py-basic: whitespace-tier edit of an indented method body keeps valid indentation', (t) => {
  const repo = copyFixture('py-basic');
  t.after(() => rm(repo));
  const rel = path.join('calc', 'accum.py');
  const currentCode = [
    'def add(self, value):',
    '  if value is None:',
    '    return self',
    '  self.items.append(value)',
    '  return self'
  ].join('\n');
  const proposedCode = [
    'def add(self, value):',
    '  if value is not None:',
    '    self.items.append(value)',
    '  return self'
  ].join('\n');
  const res = applyEdit({ repoRoot: repo, relPath: rel, currentCode, proposedCode });
  assert.strictEqual(res.matchTier, 'whitespace');
  assert.strictEqual(res.reindented, true);
  const after = fs.readFileSync(path.join(repo, rel), 'utf8');
  assert.strictEqual(after, [
    'class Accumulator:',
    '    def __init__(self):',
    '        self.items = []',
    '',
    '    def add(self, value):',
    '        if value is not None:',
    '            self.items.append(value)',
    '        return self',
    '',
    '    def total(self):',
    '        return sum(self.items)',
    ''
  ].join('\n'));
  if (!hasPython()) { t.diagnostic('python3 not found; skipped ast.parse and fixture test run'); return; }
  execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(repo, rel)]);
  execFileSync('python3', ['-c', 'import sys; sys.path.insert(0, "tests"); import test_accum, test_ops; test_accum.test_accumulator_skips_none(); test_ops.test_total()'], { cwd: repo });
});

test('tab-indented JS accepts an indent-shift edit and keeps tabs', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const original = 'class A {\n\tm(x) {\n\t\tif (x) {\n\t\t\treturn 1;\n\t\t}\n\t\treturn 0;\n\t}\n}\n';
  fs.writeFileSync(path.join(repo, 'tabs.js'), original);
  const res = applyEdit({
    repoRoot: repo,
    relPath: 'tabs.js',
    currentCode: '\tif (x) {\n\t\treturn 1;\n\t}',
    proposedCode: '\tif (x) {\n\t\treturn 2;\n\t}'
  });
  assert.strictEqual(res.matchTier, 'indent-shift');
  assert.strictEqual(res.matchDelta, 1);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'tabs.js'), 'utf8'),
    'class A {\n\tm(x) {\n\t\tif (x) {\n\t\t\treturn 2;\n\t\t}\n\t\treturn 0;\n\t}\n}\n');
});

test('fuzzy-tier edit is re-indented to the matched region', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const original = 'function outer() {\n    function f(x) {\n        return x*2;\n    }\n    return f;\n}\n';
  fs.writeFileSync(path.join(repo, 'fz.js'), original);
  const res = applyEdit({
    repoRoot: repo,
    relPath: 'fz.js',
    currentCode: 'function f(x) {\n  return x * 2;\n}\n',
    proposedCode: 'function f(x) {\n  return x * 3;\n}\n'
  });
  assert.strictEqual(res.matchTier, 'fuzzy');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'fz.js'), 'utf8'),
    'function outer() {\n    function f(x) {\n        return x * 3;\n    }\n    return f;\n}\n');
});

// ---- SG10

function writeIn(repo, rel, src) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), src);
}

test('applyEdit reports the region it replaced (matchedRegion)', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const original = 'const k = 1;\n  function f() {\n    return  1;\n  }\n';
  writeIn(repo, 'm.js', original);
  const res = applyEdit({ repoRoot: repo, relPath: 'm.js', currentCode: 'function f() { return 1; }', proposedCode: 'function f() { return 2; }' });
  assert.strictEqual(res.matchTier, 'whitespace');
  assert.strictEqual(res.matchedRegion, 'function f() {\n    return  1;\n  }');
  assert.strictEqual(res.matchedRegion, original.slice(res.matchStart, res.matchEnd));
});

test('applyEdit refuses (tier region) when the matched region is not the validated one', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const original = 'function f() {\n  return 1;\n}\n';
  writeIn(repo, 'v.js', original);
  assert.throws(
    () => applyEdit({ repoRoot: repo, relPath: 'v.js', currentCode: 'function f() { return 1; }', proposedCode: 'function f() { return 2; }', expectedRegion: 'function f() { return 1; }' }),
    (e) => e.tier === 'region' && e.detail.reason === 'region_changed' && e.detail.match_tier === 'whitespace'
  );
  assert.strictEqual(fs.readFileSync(path.join(repo, 'v.js'), 'utf8'), original);
  const ok = applyEdit({ repoRoot: repo, relPath: 'v.js', currentCode: 'function f() { return 1; }', proposedCode: 'function f() { return 2; }', expectedRegion: 'function f() {\n  return 1;\n}' });
  assert.strictEqual(ok.matchTier, 'whitespace');
});

test('applyEdit refuses whitespace-tier regions that behave differently (string, ASI, Python blocks) and leaves the file untouched', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const cases = [
    ['src/banner.js', "function banner(name) {\n  return 'Total:    ' + name;\n}\n", "function banner(name) {\n  return 'Total: ' + name;\n}", 'literal_whitespace'],
    ['src/sum.js', 'function total(a, b) {\n  return\n    a + b;\n}\n', 'function total(a, b) {\n  return a + b;\n}', 'asi_boundary'],
    ['calc/ops.py', 'def stats(xs):\n    total = 0\n    count = 0\n    for x in xs:\n        total += x\n        count += 1\n    return total, count\n', '    for x in xs:\n        total += x\n    count += 1', 'indentation'],
    ['cmd/main.go', 'func f() int {\n\treturn\n\t\tg()\n}\n', 'func f() int { return g() }', 'line_structure']
  ];
  for (const [rel, src, cur, reason] of cases) {
    writeIn(repo, rel, src);
    assert.throws(
      () => applyEdit({ repoRoot: repo, relPath: rel, currentCode: cur, proposedCode: 'x' }),
      (e) => /anchor match failed/.test(e.message) && e.tier === 'whitespace' && e.detail.reason === reason,
      rel
    );
    assert.strictEqual(fs.readFileSync(path.join(repo, rel), 'utf8'), src, rel);
  }
});

test('applyEdit: two reflowed copies are ambiguous at the whitespace tier and neither is edited', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const original = 'function f() {\n  return 1;\n}\nfunction g() {}\nfunction f() {\n    return 1;\n}\n';
  writeIn(repo, 'dup.js', original);
  assert.throws(
    () => applyEdit({ repoRoot: repo, relPath: 'dup.js', currentCode: 'function f() { return 1; }', proposedCode: 'function f() { return 2; }' }),
    (e) => e.tier === 'whitespace' && /ambiguous/.test(e.message) && e.detail.occurrences === 2
  );
  assert.strictEqual(fs.readFileSync(path.join(repo, 'dup.js'), 'utf8'), original);
});
