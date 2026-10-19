'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const diffTesting = require('../src/validation/diff-testing');
const { assertDiffTest } = require('../src/contracts');

function run(opts) {
  const r = diffTesting.run(opts);
  assertDiffTest(r);
  return r;
}

test('finds counterexample when proposed breaks semantics', () => {
  const r = run({
    currentSrc: 'module.exports.double = function double(x) { return x * 2; }',
    proposedSrc: 'module.exports.double = function double(x) { return x + 2; }',
    arity: 1
  });
  assert.strictEqual(r.verdict, 'divergent');
  assert(r.applicable);
  assert(r.mismatches > 0);
  assert(r.score < 1);
  assert(r.counterexample && r.counterexample.input);
});

test('passes equivalent rewrites', () => {
  const r = run({
    currentSrc: 'module.exports.id = function id(x) { return x; }',
    proposedSrc: 'module.exports.id = function id(x) {\n  return x;\n}',
    arity: 1
  });
  assert.strictEqual(r.verdict, 'equivalent');
  assert(r.applicable);
  assert.strictEqual(r.mismatches, 0);
  assert(r.score >= 0.99);
  assert(r.runs > 0);
});

test('infinite loop in proposed is divergent via per-call timeout and returns within 3.5 s', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'function f(x) { return 1; }',
    proposedSrc: 'function f(x) { while (x === null) {} return 1; }'
  });
  assert(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.verdict, 'divergent');
  assert.strictEqual(r.counterexample.proposed.kind, 'timeout');
  assert(r.duration_ms < 3500);
});

test('hard kill: proposed still running while current returned is divergent', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'function f(x) { return 1; }',
    proposedSrc: 'function f(x) { while (true) {} }',
    callTimeoutMs: 10000,
    hardKillMs: 600
  });
  assert(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.verdict, 'divergent');
  assert.strictEqual(r.counterexample.proposed.hard_kill, true);
});

test('hard kill: both sides hanging is inconclusive with a reason', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'function f(x) { while (true) {} }',
    proposedSrc: 'function f(x) { for (;;) {} }',
    callTimeoutMs: 10000,
    hardKillMs: 600
  });
  assert(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /hard kill/);
});

test('infinite promise chain is bounded by the per-call timeout', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'async function f(x) { return x; }',
    proposedSrc: 'async function f(x) { const g = () => Promise.resolve().then(g); await g(); }'
  });
  assert(Date.now() - t0 < 3500);
  assert.strictEqual(r.verdict, 'divergent');
});

test('input-mutating current vs non-mutating proposed returns within budget and is divergent', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'function f(a) { if (Array.isArray(a)) a.push(1); return 0; }',
    proposedSrc: 'function f(a) { return 0; }'
  });
  assert(Date.now() - t0 < 3000);
  assert.strictEqual(r.verdict, 'divergent');
  assert.deepStrictEqual(r.counterexample.args, [[]]);
});

test('each call gets a fresh copy of the inputs', () => {
  const r = run({
    currentSrc: 'function f(a) { if (Array.isArray(a)) { a.push(1); return a.length; } return -1; }',
    proposedSrc: 'function f(a) { if (Array.isArray(a)) { a.push(1); return a.length; } return -1; }'
  });
  assert.strictEqual(r.verdict, 'equivalent');
});

test('this.constructor.constructor escape cannot see host process, env or require', () => {
  const r = run({
    currentSrc: 'function f(x) { return ["undefined", "undefined", -1, "undefined"]; }',
    proposedSrc: [
      'var leaked = this.constructor.constructor("return typeof process")();',
      'var env = this.constructor.constructor("try { return Object.keys(process.env).length } catch (e) { return -1 }")();',
      'function f(x) {',
      '  var inner = this.constructor.constructor("return typeof process")();',
      '  return [leaked, inner, env, typeof globalThis.require];',
      '}'
    ].join('\n')
  });
  assert.strictEqual(r.verdict, 'equivalent', JSON.stringify(r.counterexample));
});

test('escape through a thrown error or console stays inside the sandbox', () => {
  const r = run({
    currentSrc: 'function f(x) { return "undefined"; }',
    proposedSrc: 'function f(x) { try { null.x } catch (e) { return e.constructor.constructor("return typeof process")() + console.log.constructor("return typeof process")().slice(9); } }'
  });
  assert.strictEqual(r.verdict, 'equivalent', JSON.stringify(r.counterexample));
});

test('undefined helper without fileSrc is inconclusive, not equivalent', () => {
  const r = run({
    currentSrc: 'function k(x) { return helper(x)*2; }',
    proposedSrc: 'function k(x) { return helper(x)+999; }'
  });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.strictEqual(r.applicable, false);
  assert.strictEqual(r.score, 0.5);
  assert.match(r.reason, /ReferenceError/);
});

test('undefined helper with fileSrc defining it is divergent', () => {
  const currentSrc = 'function k(x) { return helper(x)*2; }';
  const r = run({
    currentSrc,
    proposedSrc: 'function k(x) { return helper(x)+999; }',
    fileSrc: `function helper(x) { return Number(x) + 1; }\n${currentSrc}\nmodule.exports = { k };\n`
  });
  assert.strictEqual(r.mode, 'file');
  assert.strictEqual(r.verdict, 'divergent');
});

test('fileSrc splice is literal ($& in proposed code is not expanded)', () => {
  const currentSrc = 'function tag(x) { return "a" + x; }';
  const r = run({
    currentSrc,
    proposedSrc: 'function tag(x) { return "$&" + x; }',
    fileSrc: `${currentSrc}\nmodule.exports = tag;\n`
  });
  assert.strictEqual(r.verdict, 'divergent');
  assert.match(JSON.stringify(r.counterexample.proposed.value), /\$&/);
});

test('fileSrc with an equivalent edit using file-level helpers is equivalent', () => {
  const currentSrc = 'const k = (x) => helper(x) * 2;';
  const r = run({
    currentSrc,
    proposedSrc: 'const k = (x) => 2 * helper(x);',
    fileSrc: `'use strict';\nconst path = require('path');\nlet helper = (x) => (typeof x === 'number' ? x + 1 : 0);\n${currentSrc}\nmodule.exports = { k };\n`
  });
  assert.strictEqual(r.verdict, 'equivalent', JSON.stringify(r.counterexample));
});

test('const arrow functions are located and compared', () => {
  const r = run({ currentSrc: 'const k = (x) => x*2', proposedSrc: 'const k = (x) => x+2' });
  assert.strictEqual(r.verdict, 'divergent');
  assert.strictEqual(r.function_name, 'k');
});

test('let-bound function expressions are located', () => {
  const r = run({ currentSrc: 'let k = function (a, b) { return a + b; };', proposedSrc: 'let k = function (a, b) { return b + a; };' });
  assert.strictEqual(r.arity, 2);
  assert.notStrictEqual(r.verdict, 'inconclusive');
});

test('class methods: bare method snippet and method inside fileSrc', () => {
  const snip = run({ currentSrc: '  area(r) { return r * 2; }', proposedSrc: '  area(r) { return r * 3; }' });
  assert.strictEqual(snip.verdict, 'divergent');

  const file = 'class Shape {\n  area(r) { return r * r; }\n  scale(x) { return this.area(x) * 2; }\n}\nmodule.exports = Shape;\n';
  const r = run({ currentSrc: '  scale(x) { return this.area(x) * 2; }', proposedSrc: '  scale(x) { return 2 * this.area(x); }', fileSrc: file });
  assert.strictEqual(r.function_name, 'Shape.scale');
  assert.strictEqual(r.verdict, 'equivalent', JSON.stringify(r.counterexample));
});

test('ES module files are evaluated with imports stubbed', () => {
  const currentSrc = 'export function twice(x) { return x * 2; }';
  const r = run({
    currentSrc,
    proposedSrc: 'export function twice(x) { return x + x; }',
    fileSrc: `import path from 'path';\n${currentSrc}\nexport default twice;\n`
  });
  assert.strictEqual(r.mode, 'file');
  assert.notStrictEqual(r.verdict, 'inconclusive', r.reason);
});

test('proposed syntax error is divergent', () => {
  const r = run({ currentSrc: 'function f(x) { return x; }', proposedSrc: 'function f(x) { return x; ' });
  assert.strictEqual(r.verdict, 'divergent');
  assert.strictEqual(r.counterexample.phase, 'load');
  assert.match(r.reason, /SyntaxError/);
});

test('thrown errors compare by constructor name and message', () => {
  const same = run({
    currentSrc: 'function f(x) { throw new TypeError("bad " + typeof x); }',
    proposedSrc: 'function f(x) { const t = typeof x; throw new TypeError(`bad ${t}`); }'
  });
  assert.strictEqual(same.verdict, 'equivalent');
  const diff = run({
    currentSrc: 'function f(x) { throw new TypeError("bad"); }',
    proposedSrc: 'function f(x) { throw new RangeError("bad"); }'
  });
  assert.strictEqual(diff.verdict, 'divergent');
});

test('promises are awaited and their results compared', () => {
  const r = run({
    currentSrc: 'async function f(x) { return [x]; }',
    proposedSrc: 'async function f(x) { await null; return [x, 1]; }'
  });
  assert.strictEqual(r.verdict, 'divergent');
  assert.strictEqual(r.counterexample.current.async, true);
});

test('no callable function is inconclusive', () => {
  const r = run({ currentSrc: 'const x = 1;', proposedSrc: 'const x = 2;' });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.strictEqual(r.applicable, false);
});

test('memory bomb in proposed does not crash the host', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'function f(x) { return 1; }',
    proposedSrc: 'function f(x) { const a = []; for (;;) a.push(new Array(1e5).fill(x)); }'
  });
  assert(Date.now() - t0 < 3500);
  assert.notStrictEqual(r.verdict, 'equivalent');
});
