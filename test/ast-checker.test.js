'use strict';

const { rm } = require('./helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const ast = require('../src/validation/ast-checker');
const { assertCheckResult } = require('../src/contracts');
const { makeTempRepo, makeProposal } = require('./helpers/factories');

const { runChecks, checkErrorHandlingRemoval } = ast;

const repo = makeTempRepo();
test.after(() => rm(repo));

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-ast-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', dependencies: { lodash: '^4.0.0' } }));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), src);
  }
  test.after(() => rm(dir));
  return dir;
}

function check(result, name) {
  for (const c of result.checks) assertCheckResult(c);
  return result.checks.find(c => c.check_name === name);
}

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

test('removing all returns from an always-returning function fails return_type_change', () => {
  const cur = 'function f(x){ if(x){return 1;} else {return 2;} }';
  const prop = 'function f(x){ if(x){console.log(1);} else {console.log(2);} }';
  const dir = repoWith({ 'f.js': `${cur}\nmodule.exports = { f };\n` });
  const r = runChecks({ proposal: makeProposal('f.js', cur, prop), repoRoot: dir });
  const c = check(r, 'return_type_change');
  assert.strictEqual(c.passed, false);
  assert.match(c.detail, /all returns removed/);
});

test('return check handles switch, try/finally, brace-less if and nested blocks', () => {
  const r = (cur, prop) => ast.checkReturnTypeChange({ currentAst: ast.tryParse(cur), proposedAst: ast.tryParse(prop) });
  const sw = 'function s(k){ switch(k){ case 1: return "a"; default: return "b"; } }';
  assert.strictEqual(r(sw, sw).passed, true);
  assert.strictEqual(r(sw, 'function s(k){ switch(k){ case 1: return "a"; default: break; } }').passed, false);
  assert.strictEqual(r(sw, 'function s(k){ switch(k){ case 1: return "a"; } }').passed, false);
  const tr = 'function t(){ try { return work(); } catch (e) { return null; } finally { cleanup(); } }';
  assert.strictEqual(r(tr, tr).passed, true);
  assert.strictEqual(r(tr, 'function t(){ try { return work(); } catch (e) { log(e); } finally { cleanup(); } }').passed, false);
  const bl = 'function b(x){ if (x) return 1; else return 2; }';
  assert.strictEqual(r(bl, bl).passed, true);
  assert.strictEqual(r(bl, 'function b(x){ if (x) return 1; }').passed, false);
  assert.strictEqual(r(bl, 'function b(x){ { if (x) { return 1; } } return 2; }').passed, true);
  assert.strictEqual(r(bl, 'function b(x){ if (x) return 1; return; }').passed, false);
});

test('same-named functions are paired by position, not overwritten', () => {
  const cur = 'class A { get(x){ return x; } }\nclass B { get(x){ return x; } }';
  const prop = 'class A { get(x){ return x; } }\nclass B { get(x){ x++; } }';
  const c = ast.checkReturnTypeChange({ currentAst: ast.tryParse(cur), proposedAst: ast.tryParse(prop) });
  assert.strictEqual(c.passed, false);
  assert.match(c.detail, /B\.get/);
  const dup = 'function h(){ return 1; }\nfunction h(){ return 2; }';
  const c2 = ast.checkReturnTypeChange({ currentAst: ast.tryParse(dup), proposedAst: ast.tryParse('function h(){ return 1; }\nfunction h(){ go(); }') });
  assert.strictEqual(c2.passed, false);
});

test('arity change with no other callers passes signature drift', () => {
  const cur = 'function solo(a) {\n  return a;\n}';
  const prop = 'function solo(a, b) {\n  return a + (b || 0);\n}';
  const dir = repoWith({ 'lib.js': `${cur}\nmodule.exports = { solo };\n` });
  const c = check(runChecks({ proposal: makeProposal('lib.js', cur, prop), repoRoot: dir }), 'signature_drift');
  assert.strictEqual(c.passed, true, c.detail);
  assert.match(c.detail, /solo: 1→2 args; no call sites outside edit/);
});

test('arity change with an external caller fails signature drift', () => {
  const cur = 'function used(a) {\n  return a;\n}';
  const prop = 'function used(a, b) {\n  return a + b;\n}';
  const dir = repoWith({
    'lib.js': `${cur}\nmodule.exports = { used };\n`,
    'app.js': "const lib = require('./lib');\nconsole.log(lib.used(1));\n"
  });
  const c = check(runChecks({ proposal: makeProposal('lib.js', cur, prop), repoRoot: dir }), 'signature_drift');
  assert.strictEqual(c.passed, false);
  assert.match(c.detail, /used in app\.js \(1\)/);
});

test('same-file caller outside the edit counts; unrelated same-named functions do not', () => {
  const cur = 'function helper(a) {\n  return a;\n}';
  const prop = 'function helper(a, b) {\n  return a + b;\n}';
  const dir = repoWith({
    'lib.js': `${cur}\nfunction run() { return helper(1); }\nmodule.exports = { run };\n`,
    'other.js': 'function helper() { return 0; }\nhelper();\n'
  });
  const c = check(runChecks({ proposal: makeProposal('lib.js', cur, prop), repoRoot: dir }), 'signature_drift');
  assert.strictEqual(c.passed, false);
  assert.match(c.detail, /helper in lib\.js \(1\)/);
  assert.doesNotMatch(c.detail, /other\.js/);
});

test('renamed function that still has call sites is reported as drift', () => {
  const cur = 'function oldName(a) {\n  return a;\n}';
  const prop = 'function newName(a) {\n  return a;\n}';
  const dir = repoWith({ 'lib.js': `${cur}\nconsole.log(oldName(2));\n` });
  const c = check(runChecks({ proposal: makeProposal('lib.js', cur, prop), repoRoot: dir }), 'signature_drift');
  assert.strictEqual(c.passed, false);
  assert.match(c.detail, /oldName removed\/renamed \(new: newName\)/);
});

test('splice keeps $& and $` literal', () => {
  const full = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const proposed = "const b = '$&' + '$`' + \"$'\";";
  const s = ast.spliceSource(full, 'const b = 2;', proposed);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.src, `const a = 1;\n${proposed}\nconst c = 3;\n`);
  assert.deepStrictEqual([s.start, s.endCurrent, s.endProposed], [13, 25, 13 + proposed.length]);
});

test('current_code not found verbatim falls back to snippet-only checks and says so', () => {
  const dir = repoWith({ 'x.js': 'function x(a) { return a; }\n' });
  const r = runChecks({ proposal: makeProposal('x.js', 'function x(a){ return a; }', 'function x(a){ return a + 0; }'), repoRoot: dir });
  assert.strictEqual(r.splice.ok, false);
  for (const c of r.checks) { assertCheckResult(c); assert.match(c.detail, /snippet-only: current_code not found verbatim/); }
});

test('syntax error in proposed code is a parse veto', () => {
  const cur = 'function g(a){ return a + 1; }';
  const dir = repoWith({ 'g.js': `${cur}\n` });
  const r = runChecks({ proposal: makeProposal('g.js', cur, 'function g(a){ return a +; }'), repoRoot: dir });
  const c = check(r, 'parse');
  assert.strictEqual(c.passed, false);
  assert.strictEqual(c.severity, 'veto');
});

test('recovered parse errors veto only when newly introduced', () => {
  const dir = repoWith({ 'k.js': 'function k(a){ let x = 1; let x = 2; return a; }\n' });
  const same = runChecks({ proposal: makeProposal('k.js', 'return a;', 'return a + 0;'), repoRoot: dir });
  assert.strictEqual(same.checks.find(c => c.check_name === 'parse'), undefined);
  const dir2 = repoWith({ 'k.js': 'function k(a){ let x = 1; return a; }\n' });
  const added = runChecks({ proposal: makeProposal('k.js', 'return a;', 'let x = 2; return a;'), repoRoot: dir2 });
  const c = check(added, 'parse');
  assert.strictEqual(c.passed, false);
  assert.strictEqual(c.severity, 'veto');
});

test('try in a string literal or comment is not error handling', () => {
  const c = checkErrorHandlingRemoval({ currentSrc: 'const s = "try { }"; // try { x } .catch(', proposedSrc: 'const s = 1;' });
  assert.strictEqual(c.passed, true);
  assert.match(c.detail, /before=0/);
  assert.strictEqual(ast.countTryCatch('const s = "try { }"; /* p.catch(e) */'), 0);
  assert.strictEqual(ast.countTryCatch('p.catch(e => 0); try { a } catch {}'), 2);
});

test('node builtins are not new dependencies; score is passed/total', () => {
  const cur = 'function read() {\n  return 1;\n}';
  const prop = "const fs = require('fs');\nfunction read() {\n  return fs.existsSync('x') ? 1 : 1;\n}";
  const dir = repoWith({ 'r.js': `${cur}\n` });
  const r = runChecks({ proposal: makeProposal('r.js', cur, prop), repoRoot: dir });
  assert.strictEqual(check(r, 'new_dependency').passed, true);
  assert.strictEqual(r.score, r.checks.filter(c => c.passed).length / r.checks.length);
});

// SG9: the four CLAUDE.md anti-pattern checks veto on failure.
test('failing anti-pattern checks are vetoes; passing ones stay score', () => {
  const cur = "function load(p, opts) {\n  try {\n    return fs.readFileSync(p, opts.encoding || 'utf8');\n  } catch (e) {\n    return null;\n  }\n}";
  const prop = "function load(p) {\n  const axios = require('axios');\n  if (p) {\n    axios.get(p);\n  }\n}";
  const dir = repoWith({
    'src/loader.js': `'use strict';\nconst fs = require('fs');\n${cur}\nmodule.exports = { load };\n`,
    'src/app.js': "const { load } = require('./loader');\nmodule.exports = () => load('cfg.json', { encoding: 'utf8' });\n"
  });
  const r = runChecks({ proposal: makeProposal('src/loader.js', cur, prop), repoRoot: dir });
  for (const name of ['signature_drift', 'error_handling_removal', 'new_dependency', 'return_type_change']) {
    const c = check(r, name);
    assert.strictEqual(c.passed, false, name);
    assert.strictEqual(c.severity, 'veto', name);
  }
  const ok = runChecks({ proposal: makeProposal('index.js', 'function double(x) { return x * 2; }', 'function double(x) { const r = x * 2; return r; }'), repoRoot: repo });
  for (const c of ok.checks) assert.strictEqual(c.severity, 'score', c.check_name);
});

test('polyglot anti-pattern check failures are vetoes too', () => {
  const cur = 'def load(p):\n    try:\n        return open(p).read()\n    except OSError:\n        return None';
  const prop = 'def load(p):\n    return open(p).read()';
  const dir = repoWith({ 'm.py': `${cur}\n` });
  const c = check(runChecks({ proposal: makeProposal('m.py', cur, prop), repoRoot: dir }), 'error_handling_removal');
  assert.strictEqual(c.passed, false);
  assert.strictEqual(c.severity, 'veto');
});

// SG9: the signature_drift scan is bounded (word-boundary filter, file cap, parse cache).
function countParses(fn) {
  const babel = require('@babel/parser');
  const orig = babel.parse;
  const heads = [];
  babel.parse = function (src, opts) { heads.push(src.slice(0, 40)); return orig.call(this, src, opts); };
  try { fn(); } finally { babel.parse = orig; }
  return heads;
}

test('signature_drift parses only files naming the function on a word boundary, and caches parses', () => {
  const cur = 'function tally(a) {\n  return a;\n}';
  const prop = 'function tally(a, b) {\n  return a + (b || 0);\n}';
  const files = { 'lib.js': `${cur}\nmodule.exports = { tally };\n` };
  for (let i = 0; i < 5; i++) files[`near/n${i}.js`] = `// near${i}\nconst tallyTotal = 1;\nfunction untally() { return tallyTotal; }\n`;
  for (let i = 0; i < 3; i++) files[`word/w${i}.js`] = `// word${i}\nconst label = 'tally';\nmodule.exports = { label };\n`;
  const dir = repoWith(files);
  const proposal = makeProposal('lib.js', cur, prop);
  const first = countParses(() => assert.strictEqual(check(runChecks({ proposal, repoRoot: dir }), 'signature_drift').passed, true));
  assert.strictEqual(first.filter(s => s.startsWith('// near')).length, 0, 'substring-only matches are not parsed');
  assert.strictEqual(first.filter(s => s.startsWith('// word')).length, 3);
  const second = countParses(() => runChecks({ proposal, repoRoot: dir }));
  assert.strictEqual(second.filter(s => s.startsWith('// word')).length, 0, 'unchanged files come from the parse cache');
  fs.appendFileSync(path.join(dir, 'word/w0.js'), '// touched\n');
  const third = countParses(() => runChecks({ proposal, repoRoot: dir }));
  assert.strictEqual(third.filter(s => s.startsWith('// word')).length, 1, 'a changed file is re-parsed');
});

test('signature_drift scan is capped and says so; it stops at the first call site', () => {
  const cur = 'function capme(a) {\n  return a;\n}';
  const prop = 'function capme(a, b) {\n  return a + (b || 0);\n}';
  const files = { 'lib.js': `${cur}\nmodule.exports = { capme };\n` };
  for (let i = 0; i < 205; i++) files[`m/f${i}.js`] = `// mention${i}\nconst name = 'capme';\nmodule.exports = { name };\n`;
  const dir = repoWith(files);
  let c;
  const parsed = countParses(() => { c = check(runChecks({ proposal: makeProposal('lib.js', cur, prop), repoRoot: dir }), 'signature_drift'); });
  assert.strictEqual(c.passed, true, c.detail);
  assert.match(c.detail, /capped at 200 files/);
  assert.strictEqual(parsed.filter(s => s.startsWith('// mention')).length, 200);

  const callers = { 'lib.js': `${cur}\nmodule.exports = { capme };\n` };
  for (let i = 0; i < 20; i++) callers[`c/c${i}.js`] = `// caller${i}\nconst { capme } = require('../lib');\ncapme(${i});\n`;
  const dir2 = repoWith(callers);
  const parsed2 = countParses(() => { c = check(runChecks({ proposal: makeProposal('lib.js', cur, prop), repoRoot: dir2 }), 'signature_drift'); });
  assert.strictEqual(c.passed, false);
  assert.strictEqual(c.severity, 'veto');
  assert.strictEqual(parsed2.filter(s => s.startsWith('// caller')).length, 1, 'scan stops at the first file with a call site');
  assert.match(c.detail, /stops at the first call site/);
});
