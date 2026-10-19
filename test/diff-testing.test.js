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

test('infinite loop in proposed is inconclusive via per-call timeout and returns within 3.5 s', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'function f(x) { return 1; }',
    proposedSrc: 'function f(x) { while (x === null) {} return 1; }'
  });
  assert(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /proposed side exceeded the 250 ms per-call timeout/);
  assert(r.duration_ms < 3500);
});

test('hard kill: proposed still running while current returned is inconclusive', () => {
  const t0 = Date.now();
  const r = run({
    currentSrc: 'function f(x) { return 1; }',
    proposedSrc: 'function f(x) { while (true) {} }',
    callTimeoutMs: 10000,
    hardKillMs: 600
  });
  assert(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /hard kill/);
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
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /per-call timeout/);
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
    currentSrc: 'function f(x) { if (typeof x === "number") return x; throw new TypeError("bad " + typeof x); }',
    proposedSrc: 'function f(x) { const t = typeof x; if (t === "number") return x; throw new TypeError(`bad ${t}`); }'
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

test('no callable function or constant is inconclusive', () => {
  const r = run({ currentSrc: 'if (a) b();', proposedSrc: 'if (a) c();' });
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

// --- SG11: inputs that exercise the code ------------------------------------

const fileOf = (code, exp) => `'use strict';\n${code}\nmodule.exports = { ${exp} };\n`;
const inFile = (cur, prop, exp, extra = {}) => run({ currentSrc: cur, proposedSrc: prop, fileSrc: fileOf(cur, exp), ...extra });

test('object inputs shaped by the properties the function reads', () => {
  const count = inFile('function count(o) {\n  return o.items.length;\n}', 'function count(o) {\n  return o.items.length + 1;\n}', 'count');
  assert.strictEqual(count.verdict, 'divergent', count.reason);
  assert.strictEqual(typeof count.counterexample.args[0], 'object');
  const role = inFile("function role(user) {\n  if (user && user.admin === true) return 'admin';\n  return 'user';\n}",
    "function role(user) {\n  if (user && user.admin) return 'admin';\n  return 'user';\n}", 'role');
  assert.strictEqual(role.verdict, 'divergent', role.reason);
  const destructured = run({
    currentSrc: 'function total({ items, tax }) { return items.reduce((s, x) => s + x.price, 0) * (1 + tax); }',
    proposedSrc: 'function total({ items, tax }) { return items.reduce((s, x) => s + x.price, 0) * (1 + tax) + 1; }'
  });
  assert.strictEqual(destructured.verdict, 'divergent', destructured.reason);
});

test('callback inputs: calls into callbacks are recorded and compared', () => {
  const r = run({
    currentSrc: 'function each(xs, cb) { if (!Array.isArray(xs)) return 0; xs.forEach((x) => cb(x)); return xs.length; }',
    proposedSrc: 'function each(xs, cb) { if (!Array.isArray(xs)) return 0; xs.forEach((x, i) => cb(x, i)); return xs.length; }'
  });
  assert.strictEqual(r.verdict, 'divergent', r.reason);
  const same = run({
    currentSrc: 'function apply(fn, x) { return fn(x); }',
    proposedSrc: 'function apply(fn, x) { const r = fn(x); return r; }'
  });
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
});

test('literals mined from both versions reach boundary cases', () => {
  const ge = run({ currentSrc: "function tier(n) { return n >= 1000 ? 'gold' : 'basic'; }", proposedSrc: "function tier(n) { return n > 1000 ? 'gold' : 'basic'; }" });
  assert.strictEqual(ge.verdict, 'divergent', ge.reason);
  const str = run({ currentSrc: "function isAdmin(r) { return r === 'superuser'; }", proposedSrc: "function isAdmin(r) { return r === 'superuser' || r === 'root'; }" });
  assert.strictEqual(str.verdict, 'divergent', str.reason);
});

test('promise callbacks, omitted defaulted args, fractional floats and string shapes', () => {
  const cases = [
    ['async function load(fetchFn, id) {\n  try {\n    return await fetchFn(id);\n  } catch (e) {\n    return null;\n  }\n}',
      'async function load(fetchFn, id) {\n  try {\n    return fetchFn(id);\n  } catch (e) {\n    return null;\n  }\n}'],
    ['async function save(store, key, v) {\n  await store.write(key, v);\n  return store.size();\n}',
      'async function save(store, key, v) {\n  store.write(key, v);\n  return store.size();\n}'],
    ['function paginate(items, size = 10) {\n  return items.slice(0, size);\n}', 'function paginate(items, size = 20) {\n  return items.slice(0, size);\n}'],
    ['function toCents(x) {\n  return Math.round(x * 100);\n}', 'function toCents(x) {\n  return Math.floor(x * 100);\n}'],
    ['function isEmail(s) {\n  return /^[^@\\s]+@[^@\\s]+\\.[a-z]+$/.test(s);\n}', 'function isEmail(s) {\n  return /^[^@\\s]+@[^@\\s]+$/.test(s);\n}']
  ];
  for (const [c, p] of cases) {
    const r = run({ currentSrc: c, proposedSrc: p });
    assert.strictEqual(r.verdict, 'divergent', `${p}: ${r.reason}`);
  }
});

test('arity covers the larger signature of the two versions', () => {
  const r = run({
    currentSrc: 'function add(a, b, c) { return Number(a) + Number(b) + (Number(c) || 0); }',
    proposedSrc: 'function add(a, b) { return Number(a) + Number(b); }'
  });
  assert.strictEqual(r.arity, 3);
  assert.strictEqual(r.verdict, 'divergent', r.reason);
});

test('both sides throwing on every input is inconclusive, never equivalent', () => {
  const r = run({ currentSrc: 'function f(x) { throw new Error("no"); }', proposedSrc: 'function f(x) {\n  throw new Error("no");\n}' });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /threw on every input/);
});

test('too few non-throwing runs is inconclusive', () => {
  const r = run({
    currentSrc: 'function f(x) { if (typeof x === "number") return x; throw new TypeError("bad"); }',
    proposedSrc: 'function f(x) { if (typeof x === "number") return x; throw new TypeError("bad"); /* same */ }',
    minValueRuns: 1000
  });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /only \d+ of \d+ runs returned/);
});

test('every changed callable in the region is tested (second function broken)', () => {
  const cur = 'function inc(x) {\n  return x + 1;\n}\nfunction twice(x) {\n  return x * 2;\n}';
  const prop = 'function inc(x) {\n  return (x + 1);\n}\nfunction twice(x) {\n  return x * 3;\n}';
  const r = inFile(cur, prop, 'inc, twice');
  assert.strictEqual(r.verdict, 'divergent', r.reason);
  assert.strictEqual(r.counterexample.target, 'twice');
  assert.match(r.function_name, /inc, twice/);
});

test('object-literal methods, getters and class accessors are tested', () => {
  const file = "'use strict';\nmodule.exports = {\n  half(x) {\n    return x / 2;\n  },\n  base: 10,\n  get double() {\n    return this.base * 2;\n  }\n};\n";
  const m = run({ currentSrc: '  half(x) {\n    return x / 2;\n  }', proposedSrc: '  half(x) {\n    return x / 3;\n  }', fileSrc: file });
  assert.strictEqual(m.verdict, 'divergent', m.reason);
  assert.strictEqual(m.function_name, 'module.exports.half');
  const g = run({ currentSrc: '  get double() {\n    return this.base * 2;\n  }', proposedSrc: '  get double() {\n    return this.base + 2;\n  }', fileSrc: file });
  assert.strictEqual(g.verdict, 'divergent', g.reason);
  const gSame = run({ currentSrc: '  get double() {\n    return this.base * 2;\n  }', proposedSrc: '  get double() {\n    return 2 * this.base;\n  }', fileSrc: file });
  assert.strictEqual(gSame.verdict, 'equivalent', gSame.reason);

  const cls = 'class Cart {\n  constructor(items) { this.items = items || []; }\n  get size() {\n    return this.items.length;\n  }\n}\nmodule.exports = Cart;\n';
  const c = run({ currentSrc: '  get size() {\n    return this.items.length;\n  }', proposedSrc: '  get size() {\n    return this.items.length - 1;\n  }', fileSrc: cls });
  assert.strictEqual(c.verdict, 'divergent', c.reason);
  assert.strictEqual(c.function_name, 'Cart.size');
  const ctor = run({ currentSrc: '  constructor(items) { this.items = items || []; }', proposedSrc: '  constructor(items) { this.items = items || null; }', fileSrc: cls });
  assert.strictEqual(ctor.verdict, 'divergent', ctor.reason);
});

test('instance methods get a `this` shaped by the fields they read', () => {
  const file = 'class Acct {\n  fee() {\n    return this.premium ? 0 : this.rate * 2;\n  }\n}\nmodule.exports = Acct;\n';
  const r = run({ currentSrc: '  fee() {\n    return this.premium ? 0 : this.rate * 2;\n  }', proposedSrc: '  fee() {\n    return this.premium === true ? 0 : this.rate * 2;\n  }', fileSrc: file });
  assert.strictEqual(r.verdict, 'divergent', r.reason);
  assert.strictEqual(typeof r.counterexample.this, 'object');
});

test('top-level require of a dependency loads with inert stubs', () => {
  const head = "'use strict';\nconst log = require('debug')('x');\nconst db = require('./db');\n";
  const cur = 'function dbl(x) {\n  log(x);\n  return x * 2;\n}';
  const file = `${head}${cur}\nmodule.exports = { dbl };\n`;
  const div = run({ currentSrc: cur, proposedSrc: 'function dbl(x) {\n  log(x);\n  return x * 3;\n}', fileSrc: file });
  assert.strictEqual(div.verdict, 'divergent', div.reason);
  const same = run({ currentSrc: cur, proposedSrc: 'function dbl(x) {\n  log(x);\n  return 2 * x;\n}', fileSrc: file });
  assert.strictEqual(same.verdict, 'equivalent', same.reason);

  const q = 'function find(id) {\n  return db.query("SELECT * FROM t WHERE id = ?", [id]);\n}';
  const qfile = `${head}${q}\nmodule.exports = { find };\n`;
  // Differences that flow through a stub are unknown, never equivalent and never a veto.
  const args = run({ currentSrc: q, proposedSrc: 'function find(id) {\n  return db.query("SELECT * FROM t WHERE id = ?", [String(id)]);\n}', fileSrc: qfile });
  assert.strictEqual(args.verdict, 'inconclusive', 'changed arguments to a dependency call');
  const dropped = run({ currentSrc: cur, proposedSrc: 'function dbl(x) {\n  return x * 2;\n}', fileSrc: file });
  assert.strictEqual(dropped.verdict, 'inconclusive', 'dropped dependency call');
  const lib = run({ currentSrc: q, proposedSrc: 'function find(id) {\n  return _.identity(id);\n}', fileSrc: qfile.replace("const db", "const _ = require('lodash');\nconst db") });
  assert.strictEqual(lib.verdict, 'inconclusive', 'switching to a library call is not a veto');
  const prim = run({ currentSrc: 'function port() {\n  return db.port * 2;\n}', proposedSrc: 'function port() {\n  return db.port + db.port;\n}', fileSrc: `${head}function port() {\n  return db.port * 2;\n}\nmodule.exports = { port };\n` });
  assert.notStrictEqual(prim.verdict, 'divergent', 'stub coercions are not evidence');
});

test('changed constants are compared by value', () => {
  const same = inFile('const TTL = 60 * 60;', 'const TTL = 3600;', 'TTL');
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
  const diff = inFile('const TTL = 3600;', 'const TTL = 3601;', 'TTL');
  assert.strictEqual(diff.verdict, 'divergent');
  const cfg = inFile("const CFG = { retries: 3, mode: 'fast' };", "const CFG = { retries: 3, mode: 'slow' };", 'CFG');
  assert.strictEqual(cfg.verdict, 'divergent');
  const snippet = run({ currentSrc: 'const x = 1;', proposedSrc: 'const x = 2;' });
  assert.strictEqual(snippet.verdict, 'divergent');
});

test('removing an exported function is divergent; inlining a private helper is not', () => {
  const curExp = 'exports.a = function (x) {\n  return x;\n};\nexports.b = function (x) {\n  return exports.a(x) + 1;\n};';
  const removed = run({ currentSrc: curExp, proposedSrc: 'exports.b = function (x) {\n  return x + 1;\n};', fileSrc: `'use strict';\n${curExp}\n` });
  assert.strictEqual(removed.verdict, 'divergent', removed.reason);
  const cur = 'function a(x) {\n  return x;\n}\nfunction b(x) {\n  return a(x) + 1;\n}';
  const inlined = run({ currentSrc: cur, proposedSrc: 'function b(x) {\n  return x + 1;\n}', fileSrc: `${cur}\nmodule.exports = { b };\n` });
  assert.strictEqual(inlined.verdict, 'equivalent', inlined.reason);
});

test('per-call timeout on identical code is never divergent', () => {
  const slow = 'function f(a) {\n  let s = 0; for (let i = 0; i < 3e6; i++) s += i % 7; return s + (a ? 1 : 0);\n}';
  for (let i = 0; i < 3; i++) {
    const r = run({ currentSrc: slow, proposedSrc: slow.replace('return s', 'return /* same */ s'), callTimeoutMs: 1 });
    assert.strictEqual(r.verdict, 'inconclusive', JSON.stringify(r));
    assert.match(r.reason, /per-call timeout/);
  }
});

test('comparison: -0, exact numbers, returned functions, error props, non-enumerable and symbol keys, long arrays, exported state', () => {
  const cases = [
    ['function f(x) { return -Number(x); }', 'function f(x) { return 0 - Number(x); }'],
    ['function f(x) { return 1700000000000 + (Number(x) || 0); }', 'function f(x) { return 1700000000000 + (Number(x) || 0) + 1; }'],
    ['function f(n) { return (x) => x + n; }', 'function f(n) { return (x) => x - n; }'],
    ["function f(x) { const e = new TypeError('bad'); e.code = 'E1'; if (x) throw e; return 0; }", "function f(x) { const e = new TypeError('bad'); e.code = 'E2'; if (x) throw e; return 0; }"],
    ["function f(x) { return Object.defineProperty({}, 'id', { value: 1 }); }", "function f(x) { return Object.defineProperty({}, 'id', { value: 2 }); }"],
    ["function f(x) { return { [Symbol.for('k')]: 'a' }; }", "function f(x) { return { [Symbol.for('k')]: 'b' }; }"],
    ['function f(x) { return Array.from({ length: 300 }, (_, i) => i); }', 'function f(x) { return Array.from({ length: 300 }, (_, i) => (i < 250 ? i : 0)); }']
  ];
  for (const [c, p] of cases) assert.strictEqual(run({ currentSrc: c, proposedSrc: p }).verdict, 'divergent', p);
  const cur = 'function track(x) {\n  seen.push(x);\n  return x;\n}';
  const st = run({ currentSrc: cur, proposedSrc: 'function track(x) {\n  return x;\n}', fileSrc: `const seen = [];\n${cur}\nmodule.exports = { track, seen };\n` });
  assert.strictEqual(st.verdict, 'divergent', st.reason);
});

test('engine TypeError wording on invalid inputs is not a divergence; user TypeError messages are', () => {
  const sum = run({
    currentSrc: 'function sum(xs) {\n  let s = 0;\n  for (let i = 0; i < xs.length; i++) s += xs[i];\n  return s;\n}',
    proposedSrc: 'function sum(xs) {\n  let s = 0;\n  for (const x of Array.from(xs)) s += x;\n  return s;\n}'
  });
  assert.strictEqual(sum.verdict, 'equivalent', JSON.stringify(sum.counterexample));
  const user = run({
    currentSrc: 'function f(x) { if (typeof x !== "number") throw new TypeError("expected number"); return x; }',
    proposedSrc: 'function f(x) { if (typeof x !== "number") throw new TypeError("number expected"); return x; }'
  });
  assert.strictEqual(user.verdict, 'divergent');
});

test('Math.random is seeded per call so identical code stays equivalent', () => {
  const r = run({ currentSrc: 'function roll(n) { return Math.floor(Math.random() * 6) + (n ? 1 : 0); }', proposedSrc: 'function roll(n) {\n  return Math.floor(Math.random() * 6) + (n ? 1 : 0);\n}' });
  assert.strictEqual(r.verdict, 'equivalent', r.reason);
});

test('snippet mode: proposed-only ReferenceError for a name absent from the file is divergent', () => {
  const fileSrc = "'use strict';\nfunction slug(s) {\n  return String(s)\n    .toLowerCase();\n}\nmodule.exports = { slug };\n";
  const cur = 'function slug(s) { return String(s).toLowerCase(); }';
  const prop = 'function slug(s) { return normalizeSlug(String(s).toLowerCase()); }';
  const r = run({ currentSrc: cur, proposedSrc: prop, fileSrc });
  assert.strictEqual(r.mode, 'snippet');
  assert.strictEqual(r.verdict, 'divergent', r.reason);
  const known = run({ currentSrc: cur, proposedSrc: prop, fileSrc: fileSrc + 'function normalizeSlug(s) { return s; }\n' });
  assert.strictEqual(known.verdict, 'inconclusive');
});
