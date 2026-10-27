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
      '  return [leaked, inner, env, typeof this.constructor.constructor("return this")().require];',
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
    currentSrc: 'function f(x) { if (x === 7) return x; throw new TypeError("bad"); }',
    proposedSrc: 'function f(x) { if (x === 7) return x; throw new TypeError("bad"); /* same */ }'
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

// --- SG15: diff-test reach, round 2 -------------------------------------------

// Splices `cur` into `pre` + `cur` + `exp` (exp defaults to exporting `name`
// or the first declared function/class); other options go to run().
const edit = (cur, prop, { pre = '', exp, name, ...opts } = {}) => run({
  currentSrc: cur,
  proposedSrc: prop,
  fileSrc: `'use strict';\n${pre}\n${cur}\n${exp !== undefined ? exp : `module.exports = { ${name || /(?:function|class)\s+(\w+)/.exec(cur)[1]} };`}\n`,
  ...opts
});

test('module-scope bindings are compared after every call and after load', () => {
  const log = edit('function record(evt) {\n  history.push(evt);\n  return evt;\n}', 'function record(evt) {\n  return evt;\n}',
    { pre: 'const history = [];\nfunction getHistory() { return history.slice(); }', exp: 'module.exports = { record, getHistory };' });
  assert.strictEqual(log.verdict, 'divergent', log.reason);
  assert.match(log.reason, /side effects differ/);
  const reg = edit("use({ name: 'core' });\nuse({ name: 'auth' });", "use({ name: 'core' });",
    { pre: 'const plugins = [];\nfunction use(p) { plugins.push(p); }\nfunction names() { return plugins.map((p) => p.name); }', exp: 'module.exports = { names };' });
  assert.strictEqual(reg.verdict, 'divergent', reg.reason);
  assert.strictEqual(reg.counterexample.phase, 'load');
});

test('a changed callable writing different module-scope state is at best inconclusive', () => {
  const r = edit('function set(k, v) {\n  db[k] = v;\n  delete cache[k];\n  return v;\n}', 'function set(k, v) {\n  db[k] = v;\n  return v;\n}',
    { pre: 'const db = {};\nconst cache = {};\nfunction get(k) { if (!(k in cache)) cache[k] = db[k]; return cache[k]; }', exp: 'module.exports = { get, set };' });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /set writes different module-scope state \(cache\)/);
  assert(r.runs > 0);
});

test('a dropped top-level statement next to a tidied function is never equivalent', () => {
  const r = edit('app.use(function limit(req) { return req; });\nfunction handler(req) {\n  const id = req.id;\n  return id;\n}',
    'function handler(req) {\n  const userId = req.id;\n  return userId;\n}', { pre: "const app = require('./app');", exp: 'module.exports = { handler, app };' });
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /top-level statement changed outside a located callable/);
  assert.match(r.reason, /load-time interactions with dependencies differ/);
  assert(r.runs > 0);
});

test('an object returned again by a later call is compared by identity', () => {
  const r = edit('function pool() {\n  if (!instance) instance = { conns: [] };\n  return instance;\n}', 'function pool() {\n  instance = { conns: [] };\n  return instance;\n}',
    { pre: 'let instance = null;' });
  assert.strictEqual(r.verdict, 'divergent', r.reason);
});

test('returned functions get shaped arguments, nested probes and their owner as this', () => {
  const cases = [
    ['function minAge(n) {\n  return (user) => user.age >= n;\n}', 'function minAge(n) {\n  return (user) => user.age > n;\n}'],
    ['function makeCart() {\n  return {\n    items: [],\n    add(item) {\n      this.items.push(item);\n      return this.items.length;\n    }\n  };\n}',
      'function makeCart() {\n  return {\n    items: [],\n    add(item) {\n      this.items.unshift(item);\n      return this.items.length;\n    }\n  };\n}'],
    ['function makeStats() {\n  return {\n    mean(xs) {\n      return xs.reduce((a, b) => a + b, 0) / xs.length;\n    }\n  };\n}',
      'function makeStats() {\n  return {\n    mean(xs) {\n      return xs.reduce((a, b) => a + b, 0) / (xs.length - 1);\n    }\n  };\n}'],
    ['function rgb(r) {\n  return (g) => (b) => (r << 16) | (g << 8) | b;\n}', 'function rgb(r) {\n  return (g) => (b) => (r << 16) | (g << 8) | (b & 0x7f);\n}'],
    ['function memo(fn) {\n  const cache = new Map();\n  return (...args) => {\n    const k = JSON.stringify(args);\n    if (!cache.has(k)) cache.set(k, fn(...args));\n    return cache.get(k);\n  };\n}',
      'function memo(fn) {\n  const cache = new Map();\n  return (...args) => {\n    const k = String(args[0]);\n    if (!cache.has(k)) cache.set(k, fn(...args));\n    return cache.get(k);\n  };\n}'],
    ['const k = (() => (x) => x * 2)();', 'const k = (() => (x) => x * 3)();']
  ];
  for (const [c, p] of cases) {
    const r = edit(c, p, { name: /(?:function|const)\s+(\w+)/.exec(c)[1] });
    assert.strictEqual(r.verdict, 'divergent', `${p}: ${r.reason}`);
  }
});

test('callables are located in prototype, assigned, defineProperty, field, anonymous-export, ESM-default, if-block and IIFE shapes', () => {
  const cases = [
    { pre: 'function Stack() { this.items = []; }', cur: 'Stack.prototype.peek = function () {\n  return this.items[this.items.length - 1];\n};',
      prop: 'Stack.prototype.peek = function () {\n  return this.items[0];\n};', exp: 'module.exports = { Stack };', label: 'Stack.peek' },
    { pre: 'const api = {};', cur: 'api.discount = function (price) {\n  return price > 100 ? price * 0.9 : price;\n};',
      prop: 'api.discount = function (price) {\n  return price >= 100 ? price * 0.9 : price;\n};', exp: 'module.exports = api;', label: 'api.discount' },
    { pre: 'let hits = 0;\nfunction hit() { hits++; }', cur: "Object.defineProperty(module.exports, 'hitCount', {\n  get() {\n    return hits;\n  }\n});",
      prop: "Object.defineProperty(module.exports, 'hitCount', {\n  get() {\n    return hits + 1;\n  }\n});", exp: 'module.exports.hit = hit;', label: 'module.exports.hitCount' },
    { cur: "class Fmt {\n  pct = (x) => Math.round(x * 100) + '%';\n}", prop: "class Fmt {\n  pct = (x) => Math.floor(x * 100) + '%';\n}", exp: 'module.exports = { Fmt };', label: 'Fmt.pct' },
    { cur: 'class Retry {\n  limit = 3;\n  shouldRetry(n) {\n    return n < this.limit;\n  }\n}', prop: 'class Retry {\n  limit = 5;\n  shouldRetry(n) {\n    return n < this.limit;\n  }\n}', exp: 'module.exports = { Retry };' },
    { cur: 'module.exports = function (a, b) {\n  return a - b;\n};', prop: 'module.exports = function (a, b) {\n  return b - a;\n};', exp: '', label: 'module.exports' },
    { cur: 'module.exports = class {\n  constructor(n) { this.n = n; }\n  half() {\n    return Math.floor(this.n / 2);\n  }\n};',
      prop: 'module.exports = class {\n  constructor(n) { this.n = n; }\n  half() {\n    return Math.ceil(this.n / 2);\n  }\n};', exp: '', label: 'module.exports.half' },
    { cur: 'module.exports = {\n  num: {\n    clamp(x, lo, hi) {\n      return Math.min(Math.max(x, lo), hi);\n    }\n  }\n};',
      prop: 'module.exports = {\n  num: {\n    clamp(x, lo, hi) {\n      return Math.min(Math.max(x, lo), hi - 1);\n    }\n  }\n};', exp: '' },
    { pre: 'const exp = {};', cur: "if (typeof exp === 'object') {\n  exp.double = function (x) {\n    return x * 2;\n  };\n}",
      prop: "if (typeof exp === 'object') {\n  exp.double = function (x) {\n    return x + x + 1;\n  };\n}", exp: 'module.exports = exp;', label: 'exp.double' },
    { cur: '(function () {\n  function inc(x) {\n    return x + 1;\n  }\n  module.exports = { inc };\n})();', prop: '(function () {\n  function inc(x) {\n    return x + 2;\n  }\n  module.exports = { inc };\n})();', exp: '' },
    { cur: 'class Range {\n  constructor(n) { this.n = n; }\n  *[Symbol.iterator]() {\n    for (let i = 0; i < this.n; i++) yield i;\n  }\n}',
      prop: 'class Range {\n  constructor(n) { this.n = n; }\n  *[Symbol.iterator]() {\n    for (let i = 0; i <= this.n; i++) yield i;\n  }\n}', exp: 'module.exports = { Range };', label: 'Range.[Symbol.iterator]' }
  ];
  for (const c of cases) {
    const r = edit(c.cur, c.prop, c);
    assert.strictEqual(r.verdict, 'divergent', `${c.prop}: ${r.reason}`);
    if (c.label) assert.strictEqual(r.function_name, c.label);
  }
  const esm = run({ currentSrc: 'export default function (x) {\n  return x * 2;\n}', proposedSrc: 'export default function (x) {\n  return x * 3;\n}', fileSrc: 'export default function (x) {\n  return x * 2;\n}\n' });
  assert.strictEqual(esm.verdict, 'divergent', esm.reason);
  assert.strictEqual(esm.function_name, 'module.exports.default');
});

test('targets beyond the cap and an exhausted time budget are inconclusive, never equivalent', () => {
  const fns = (changed) => Array.from({ length: 9 }, (_, i) => `function f${i + 1}(x) {\n  const ${changed ? 'result' : 'r'} = x * ${changed && i === 8 ? 10 : i + 1};\n  return ${changed ? 'result' : 'r'};\n}`).join('\n');
  const capped = run({ currentSrc: fns(false), proposedSrc: fns(true), fileSrc: `${fns(false)}\nmodule.exports = { ${Array.from({ length: 9 }, (_, i) => `f${i + 1}`).join(', ')} };\n` });
  assert.strictEqual(capped.verdict, 'inconclusive');
  assert.match(capped.reason, /1 changed callable\(s\) beyond the 8-target cap/);
  const slow = 'function score(n) {\n  let s = 0;\n  for (let i = 0; i < 2e5; i++) s = (s + i) % 7;\n  return n === 18 ? s + 1 : s;\n}';
  const budget = run({ currentSrc: slow, proposedSrc: slow.replace('n === 18', 'n === 19'), budgetMs: 40 });
  assert.strictEqual(budget.verdict, 'inconclusive', budget.reason);
  assert.match(budget.reason, /time budget reached after \d+ of \d+ inputs/);
});

test('equivalent needs a minimum of value-returning runs per target', () => {
  const cur = 'function a(x) {\n  return String(x);\n}\nfunction b(x) {\n  if (x === 1 || x === 2 || x === 3) return x;\n  throw new Error("no");\n}';
  const prop = 'function a(x) {\n  return `${x}`;\n}\nfunction b(x) {\n  if (x === 1 || x === 2 || x === 3) return x;\n  throw new Error("no");\n  // same\n}';
  // A budget no contended host reaches: the reason must be the value count.
  const r = inFile(cur, prop, 'a, b', { budgetMs: 20000, hardKillMs: 30000 });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /b: only \d+ of \d+ runs returned comparable values/);
});

test('boundary inputs from mined literals and regexes separate the versions', () => {
  const cases = [
    ['function isZip(s) {\n  return /^\\d{5}$/.test(s);\n}', 'function isZip(s) {\n  return /^\\d{5,}$/.test(s);\n}'],
    ['function isYes(s) {\n  return /^(y|yes)$/i.test(s);\n}', 'function isYes(s) {\n  return /^(y|yes)$/.test(s);\n}'],
    ["function slug(s) {\n  return String(s).trim().toLowerCase().replace(/\\s+/g, '-');\n}", "function slug(s) {\n  return String(s).trim().toLowerCase().replace(/\\s/g, '-');\n}"],
    ["function strip(p) {\n  return String(p).replace(/\\.\\.\\//g, '');\n}", "function strip(p) {\n  return String(p).replace('../', '');\n}"],
    ['function trusted(host) {\n  return /^api\\.example\\.com$/.test(host);\n}', 'function trusted(host) {\n  return /^api.example.com$/.test(host);\n}'],
    ['function clean(s) {\n  return String(s).trim();\n}', 'function clean(s) {\n  return String(s).trimEnd();\n}'],
    ['function toInt(s) {\n  return parseInt(s);\n}', 'function toInt(s) {\n  return parseInt(s, 10);\n}'],
    ["function head(s) {\n  return s.split(':', 2);\n}", "function head(s) {\n  return s.split(':');\n}"],
    ["function checkName(s) {\n  if (s.length > 255) throw new RangeError('name too long');\n  return s;\n}", "function checkName(s) {\n  if (s.length > 256) throw new RangeError('name too long');\n  return s;\n}"],
    ["function port(n) {\n  if (n < 1 || n > 65535) throw new RangeError('bad port');\n  return n;\n}", "function port(n) {\n  if (n < 1 || n > 65536) throw new RangeError('bad port');\n  return n;\n}"],
    ["function accept(payload) {\n  if (payload.items.length > 100) throw new RangeError('too many items');\n  return payload.items.length;\n}",
      "function accept(payload) {\n  if (payload.items.length > 1000) throw new RangeError('too many items');\n  return payload.items.length;\n}"],
    ['class Age {\n  constructor(n) { this.n = n; }\n  adult() {\n    return this.n >= 18;\n  }\n}', 'class Age {\n  constructor(n) { this.n = n; }\n  adult() {\n    return this.n > 18;\n  }\n}']
  ];
  for (const [c, p] of cases) {
    const r = edit(c, p);
    assert.strictEqual(r.verdict, 'divergent', `${p}: ${r.reason}`);
  }
});

test('dependency stubs return varied values so branches on their results are taken', () => {
  const size = edit("function sizeClass(p) {\n  const st = store.stat(p);\n  if (st.size > 1048576) return 'large';\n  return 'small';\n}",
    "function sizeClass(p) {\n  const st = store.stat(p);\n  if (st.size > 10485760) return 'large';\n  return 'small';\n}", { pre: "const store = require('./store');" });
  assert.strictEqual(size.verdict, 'divergent', size.reason);
  const status = edit("function exists(id) {\n  const res = client.head('/items/' + id);\n  if (res.status === 404) return false;\n  return true;\n}",
    "function exists(id) {\n  const res = client.head('/items/' + id);\n  if (res.status === 410) return false;\n  return true;\n}", { pre: "const client = require('./client');" });
  assert.strictEqual(status.verdict, 'divergent', status.reason);
});

test('an edit that changes references to host globals is inconclusive; Date is fixed', () => {
  const cases = [
    ["function cacheDir(home) {\n  return home + '/.cache';\n}", "function cacheDir(home) {\n  if (typeof process === 'object') return '/tmp/.cache';\n  return home + '/.cache';\n}", 'process'],
    ['function delayMs(n) {\n  return n * 1000;\n}', "function delayMs(n) {\n  if (typeof setTimeout === 'function') return n * 100;\n  return n * 1000;\n}", 'setTimeout'],
    ['function b64(s) {\n  return String(s);\n}', "function b64(s) {\n  if (typeof Buffer === 'function') return Buffer.from(String(s)).toString('base64');\n  return String(s);\n}", 'Buffer']
  ];
  for (const [c, p, g] of cases) {
    const r = edit(c, p);
    assert.strictEqual(r.verdict, 'inconclusive', p);
    assert.match(r.reason, new RegExp(`host globals the sandbox does not provide \\(${g}\\)`));
    assert(r.runs > 0);
  }
  const now = edit('function age(t) {\n  return Date.now() - t;\n}', 'function age(t) {\n  const n = Date.now();\n  return n - t;\n}', { pre: 'const START = new Date();' });
  assert.strictEqual(now.verdict, 'equivalent', now.reason);
});

test('inputs outside the original\'s evident domain are not generated; differences only there are inconclusive', () => {
  const benign = [
    ['function sum(xs) {\n  let s = 0;\n  for (let i = 0; i < xs.length; i++) s += xs[i];\n  return s;\n}', 'function sum(xs) {\n  let s = 0;\n  for (const x of xs) s += x;\n  return s;\n}'],
    ['function tail(s) {\n  return s.substr(1);\n}', 'function tail(s) {\n  return s.slice(1);\n}'],
    ['function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}', 'function total(xs) {\n  let t = 0;\n  for (const x of xs) t = t + x;\n  return t;\n}'],
    ['function keys(m) {\n  return Array.from(m.keys());\n}', 'function keys(m) {\n  return [...m.keys()];\n}'],
    ['class Box {\n  constructor(w) { this.w = w; }\n  area() {\n    return this.w * this.w;\n  }\n}', 'class Box {\n  constructor(w) { this.w = w; }\n  side() {\n    return this.w;\n  }\n  area() {\n    return this.side() * this.side();\n  }\n}']
  ];
  for (const [c, p] of benign) {
    const r = edit(c, p);
    assert.strictEqual(r.verdict, 'equivalent', `${p}: ${r.reason} ${JSON.stringify(r.counterexample || '')}`);
  }
  const ood = edit('function inner(o) {\n  return o.a.b;\n}', 'function inner(o) {\n  return o.a && o.a.b;\n}');
  assert.strictEqual(ood.verdict, 'inconclusive', ood.reason);
  assert.match(ood.reason, /current version rejects with a TypeError/);
});

// ---------- SG18: observable effects beyond JSON returns ----------

test('console output is recorded: a removed, added or changed log line is divergent; the same output is not', () => {
  const removed = edit("function transfer(a, b) {\n  console.log('transfer', a, b);\n  return a + b;\n}", 'function transfer(a, b) {\n  return a + b;\n}');
  assert.strictEqual(removed.verdict, 'divergent', removed.reason);
  assert.match(removed.reason, /side effects differ/);
  const leaked = edit("function connect(url, token) {\n  console.log('connecting', url);\n  return 1;\n}", "function connect(url, token) {\n  console.log('connecting', url, token);\n  return 1;\n}");
  assert.strictEqual(leaked.verdict, 'divergent', leaked.reason);
  const level = edit("function warnIt(x) {\n  console.log('bad', x);\n  return x;\n}", "function warnIt(x) {\n  console.warn('bad', x);\n  return x;\n}");
  assert.strictEqual(level.verdict, 'divergent', level.reason);
  const atLoad = edit('function f(x) {\n  return x;\n}', "console.info('loaded');\nfunction f(x) {\n  return x;\n}");
  assert.notStrictEqual(atLoad.verdict, 'equivalent', atLoad.reason);
  const same = edit("function hi(n) {\n  const msg = 'hi ' + n;\n  console.log(msg);\n  return n;\n}", "function hi(n) {\n  console.log('hi ' + n);\n  return n;\n}");
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
});

test('object metadata is compared: key order, frozen/sealed, getters, read-only, null prototype, registered symbols', () => {
  const cases = [
    ['function toRow(u) {\n  return { id: u.id, name: u.name };\n}', 'function toRow(u) {\n  return { name: u.name, id: u.id };\n}'],
    ['function defaults() {\n  return Object.freeze({ retries: 3 });\n}', 'function defaults() {\n  return { retries: 3 };\n}'],
    ["function roles() {\n  return ['user'];\n}", "function roles() {\n  return Object.freeze(['user']);\n}"],
    ['function opts() {\n  return Object.seal({ a: 1 });\n}', 'function opts() {\n  return Object.preventExtensions({ a: 1 });\n}'],
    ['function lazy() {\n  return { get v() { return 1; } };\n}', 'function lazy() {\n  return { v: 1 };\n}'],
    ["function ro() {\n  const o = {};\n  Object.defineProperty(o, 'k', { value: 1, enumerable: true });\n  return o;\n}", 'function ro() {\n  return { k: 1 };\n}'],
    ['function dict() {\n  return Object.create(null);\n}', 'function dict() {\n  return {};\n}'],
    ["function tag() {\n  return Symbol.for('app.tag');\n}", "function tag() {\n  return Symbol('app.tag');\n}"]
  ];
  for (const [c, p] of cases) {
    const r = edit(c, p);
    assert.strictEqual(r.verdict, 'divergent', `${p}: ${r.reason}`);
  }
  const sameShape = edit('function pair(a, b) {\n  const out = { a: a };\n  out.b = b;\n  return Object.freeze(out);\n}', 'function pair(a, b) {\n  return Object.freeze({ a, b });\n}');
  assert.strictEqual(sameShape.verdict, 'equivalent', sameShape.reason);
});

test('mutation of builtins or the global object is a side effect', () => {
  const cases = [
    ['function init() {\n  return true;\n}', 'function init() {\n  if (!Array.prototype.last) Array.prototype.last = function () { return this[this.length - 1]; };\n  return true;\n}'],
    ['function precise() {\n  return 0;\n}', 'function precise() {\n  Math.round = (x) => Math.floor(x + 0.5000001);\n  return 0;\n}'],
    ['function serial(o) {\n  return JSON.stringify(o);\n}', 'function serial(o) {\n  JSON.parse = (s) => s;\n  return JSON.stringify(o);\n}']
  ];
  for (const [c, p] of cases) {
    const r = edit(c, p);
    assert.strictEqual(r.verdict, 'divergent', `${p}: ${r.reason}`);
  }
  const sloppy = run({ currentSrc: 'function boot(x) {\n  cache = { x: x };\n  return x;\n}', proposedSrc: 'function boot(x) {\n  return x;\n}' });
  assert.strictEqual(sloppy.verdict, 'divergent', sloppy.reason);
});

test('a changed thrown error name is divergent', () => {
  const r = edit("function check(x) {\n  const e = new Error('bad');\n  if (x === 1) throw e;\n  return x;\n}",
    "function check(x) {\n  const e = new Error('bad');\n  if (x === 1) throw Object.setPrototypeOf(e, P);\n  return x;\n}",
    { pre: "const P = Object.create(Error.prototype, { name: { value: 'ValidationError' } });" });
  assert.strictEqual(r.verdict, 'divergent', r.reason);
});

test('host globals reached through globalThis, an alias or brackets, and clock reads, are inconclusive', () => {
  const cases = [
    ["function platform() {\n  return 'browser';\n}", "function platform() {\n  return typeof globalThis.process === 'object' ? 'node' : 'browser';\n}", ''],
    ['function isNode() {\n  return false;\n}', 'function isNode() {\n  return !!(g.process && g.process.versions);\n}', 'const g = globalThis;'],
    ['function later(f) {\n  return f;\n}', "function later(f) {\n  return globalThis['setTimeout'] ? 1 : f;\n}", ''],
    ["function phase() {\n  return 'beta';\n}", "function phase() {\n  return Date.now() > 1750000000000 ? 'ga' : 'beta';\n}", ''],
    ["function stamp(s) {\n  return '[2023] ' + s;\n}", "function stamp(s) {\n  return '[' + new Date().getFullYear() + '] ' + s;\n}", '']
  ];
  for (const [c, p, pre] of cases) {
    const r = edit(c, p, { pre });
    assert.strictEqual(r.verdict, 'inconclusive', `${p}: ${r.reason}`);
    assert.match(r.reason, /host globals the sandbox does not provide/);
  }
});

test('equivalent needs minValueRuns value-returning runs, repeating inputs when there are fewer', () => {
  const r = edit("function next() {\n  n++;\n  return n > 5 ? 'many' : 'few';\n}", "function next() {\n  n++;\n  return n > 6 ? 'many' : 'few';\n}", { pre: 'let n = 0;' });
  assert.strictEqual(r.verdict, 'divergent', r.reason);
  const same = edit('function one() {\n  return 1;\n}', 'function one() {\n  const x = 1;\n  return x;\n}');
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
  assert(same.runs >= 10, `runs=${same.runs}`);
  const low = run({ currentSrc: 'function one() {\n  return 1;\n}', proposedSrc: 'function one() {\n  return 1 + 0;\n}', minValueRuns: 4 });
  assert.strictEqual(low.verdict, 'equivalent', low.reason);
  assert(low.runs >= 4 && low.runs < 10, `runs=${low.runs}`);
});

test('boundary inputs: folded numeric constants, astral strings and -0', () => {
  const big = edit('function chunk(n) {\n  return Math.ceil(n / 1024);\n}', 'function chunk(n) {\n  return n > 2 ** 20 ? 1024 : Math.ceil(n / 1024);\n}');
  assert.strictEqual(big.verdict, 'divergent', big.reason);
  const astral = edit('function len(s) {\n  return [...s].length;\n}', 'function len(s) {\n  return s.length;\n}');
  assert.strictEqual(astral.verdict, 'divergent', astral.reason);
  const zero = edit("function fmt(n) {\n  return Object.is(n, -0) ? '-0' : String(n);\n}", 'function fmt(n) {\n  return String(n);\n}');
  assert.strictEqual(zero.verdict, 'divergent', zero.reason);
});

test('deletions: the result says whether the deleted code ran', () => {
  const ran = edit('function area(w, h) {\n  const unused = w * 2;\n  return w * h;\n}', 'function area(w, h) {\n  return w * h;\n}');
  assert.strictEqual(ran.verdict, 'equivalent', ran.reason);
  assert.strictEqual(ran.deletions_observed, true);
  const dead = edit('function id(x) {\n  if (false) {\n    const t = 1;\n  }\n  return x;\n}', 'function id(x) {\n  if (false) {\n  }\n  return x;\n}');
  assert.strictEqual(dead.verdict, 'equivalent', dead.reason);
  assert.strictEqual(dead.deletions_observed, false);
  const arrow = edit('const inc = (x) => (0, x + 1);', 'const inc = (x) => (x + 1);', { exp: 'module.exports = { inc };' });
  assert.strictEqual(arrow.deletions_observed, true, 'a deletion inside an expression body is probed in the body');
  const reorder = edit('function f(x) {\n  return x * 2;\n}', 'function f(x) {\n  return 2 * x;\n}');
  assert.strictEqual(reorder.deletions_observed, true, 'tokens deleted in a hunk that also inserts are probed too');
  const insertOnly = edit('function f(x) {\n  return x;\n}', 'function f(x) {\n  return x + 0;\n}');
  assert(!('deletions_observed' in insertOnly));
});

// ---------- SG20: bounded inputs, preparation inside the hard kill, deferred state ----------

const rowsFn = (lit, op) => `function sum(m) {\n  let s = 0;\n  for (const row of m) for (let i = 0; i < row.length; i++) s ${op} row[i];\n  if (s > ${lit}) return ${lit};\n  return s;\n}\nmodule.exports = { sum };\n`;

test('nested-row inputs grow linearly: a literal near 2000 stays in budget and is decided (AUDIT-9 C1)', () => {
  const cur = rowsFn(1999, '+='), prop = rowsFn(1999, '= s +');
  const t0 = performance.now();
  const r = run({ currentSrc: cur, proposedSrc: prop, fileSrc: cur });
  const ms = performance.now() - t0;
  assert(ms < 5000, `${ms} ms`);
  assert.strictEqual(r.verdict, 'equivalent', r.reason);
  assert(r.runs > 0);
});

test('a forced length also reaches the arrays inside an array: row-length boundaries separate the versions', () => {
  const cur = 'function f(m) {\n  let s = 0;\n  for (const row of m) { if (row.length > 1000) return -1; for (let i = 0; i < row.length; i++) s += row[i]; }\n  return s;\n}\nmodule.exports = { f };\n';
  const r = run({ currentSrc: cur, proposedSrc: cur.replace('> 1000', '> 1001'), fileSrc: cur });
  assert.strictEqual(r.verdict, 'divergent', r.reason);
});

test('the hard kill bounds input preparation too, and never reports a negative budget (AUDIT-9 L3)', () => {
  const cur = rowsFn(1999, '+='), prop = rowsFn(1999, '= s +');
  const t0 = performance.now();
  const r = run({ currentSrc: cur, proposedSrc: prop, fileSrc: cur, hardKillMs: 30 });
  assert(performance.now() - t0 < 1500);
  assert.strictEqual(r.verdict, 'inconclusive');
  assert.match(r.reason, /hard kill: (input preparation|sandbox) did not finish within 30 ms/);
  const hang = run({
    currentSrc: 'function f(x) { return 1; }\nmodule.exports = { f };',
    proposedSrc: 'function f(x) { if (x === 1) while (true) {} return 1; }\nmodule.exports = { f };',
    callTimeoutMs: 10000,
    hardKillMs: 1500
  });
  assert.match(hang.reason, /^hard kill: sandbox did not finish within 1500 ms \(after [1-9]\d* runs\)/);
  assert(hang.runs > 0);
});

test('large module state is compared once per target: equivalent edits stay equivalent, a state change is still divergent (AUDIT-9 H3)', () => {
  const data = `const table = [${Array.from({ length: 19000 }, (_, i) => i).join(', ')}];\nconst seen = [];\n`;
  const fn = (body) => `${data}function twice(x) {\n  if (typeof x !== 'number') return 0;\n  ${body}\n}\nmodule.exports = { twice, table, seen };\n`;
  const cur = fn('return x * 2;');
  const same = run({ currentSrc: cur, proposedSrc: fn('return x + x;'), fileSrc: cur });
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
  const writes = run({ currentSrc: cur, proposedSrc: fn('if (x === 1) seen.push(x);\n  return x * 2;'), fileSrc: cur });
  assert.strictEqual(writes.verdict, 'divergent', writes.reason);
  const big = run({ currentSrc: cur, proposedSrc: fn('if (x === 1) table[18999] = 0;\n  return x * 2;'), fileSrc: cur });
  assert.strictEqual(big.verdict, 'divergent', big.reason);
});

// ---------- SG22: deletions observed where they are evaluated; mid-run state ----------

test('a deletion is observed only if the deleted part itself ran: braceless branch, && operand, ternary branch (AUDIT-12 C1)', () => {
  const braceless = edit("function scale(n) {\n  if (typeof n === 'bigint') return n * 1000n;\n  return n * 1000;\n}", 'function scale(n) {\n  return n * 1000;\n}');
  assert.strictEqual(braceless.verdict, 'equivalent', braceless.reason);
  assert.strictEqual(braceless.deletions_observed, false, 'the if ran, its BigInt branch never did');
  const operand = edit("function norm(n) {\n  typeof n === 'bigint' && (n = Number(n));\n  return n;\n}", 'function norm(n) {\n  return n;\n}');
  assert.strictEqual(operand.verdict, 'equivalent', operand.reason);
  assert.strictEqual(operand.deletions_observed, false, 'the right side of && never ran');
  const ternary = edit("function fmt(n) {\n  return typeof n === 'bigint' ? n.toString() + 'n' : String(n);\n}", 'function fmt(n) {\n  return String(n);\n}');
  assert.strictEqual(ternary.verdict, 'equivalent', ternary.reason);
  assert.strictEqual(ternary.deletions_observed, false, 'the BigInt branch of the ternary never ran');
  const reached = edit('function twice(x) {\n  if (x === 0) return x * 2;\n  return x * 2;\n}', 'function twice(x) {\n  return x * 2;\n}');
  assert.strictEqual(reached.verdict, 'equivalent', reached.reason);
  assert.strictEqual(reached.deletions_observed, true, 'a braceless branch the inputs reach is observed');
});

test('deleted tokens in a hunk that also inserts are probed (AUDIT-12 C2)', () => {
  const r = edit("function scale(n) {\n  if (typeof n === 'bigint') {\n    return n * 1000n;\n  }\n  return n * 1000;\n}", 'function scale(n) {\n  return 1000 * n;\n}');
  assert.strictEqual(r.verdict, 'equivalent', r.reason);
  assert.strictEqual(r.deletions_observed, false);
});

test('large module state: a binding that differs mid-run is divergent even when it agrees after the last call (AUDIT-12 H4)', () => {
  const lastSeen = edit('function lookup(i) {\n  lastSeen = i;\n  return TABLE[i];\n}', 'function lookup(i) {\n  if (i) lastSeen = i;\n  return TABLE[i];\n}',
    { pre: 'const TABLE = Array.from({ length: 3000 }, (_, i) => i * 2);\nlet lastSeen = null;', exp: 'module.exports = { lookup, seen: () => lastSeen };' });
  assert.strictEqual(lastSeen.verdict, 'divergent', lastSeen.reason);
  const toggle = edit('function toggle(i) {\n  flags.debug = !flags.debug;\n  return NAMES[i];\n}', 'function toggle(i) {\n  flags.debug = true;\n  return NAMES[i];\n}',
    { pre: 'const NAMES = Array.from({ length: 3000 }, (_, i) => `n${i}`);\nconst flags = { debug: false };', exp: 'module.exports = { toggle, flags };' });
  assert.strictEqual(toggle.verdict, 'divergent', toggle.reason);
  const same = edit('function lookup(i) {\n  lastSeen = i;\n  return TABLE[i];\n}', 'function lookup(i) {\n  lastSeen = i;\n  const v = TABLE[i];\n  return v;\n}',
    { pre: 'const TABLE = Array.from({ length: 3000 }, (_, i) => i * 2);\nlet lastSeen = null;', exp: 'module.exports = { lookup, seen: () => lastSeen };' });
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
});

test('thousands of constant bindings: a later binding that differs mid-run is still divergent, unchanged ones cost nothing per call (AUDIT-14 H4)', () => {
  // 5,000 constants before `flag`: the per-call digest used to stop after
  // SMALL_TOTAL nodes, so `flag` was never looked at between calls.
  const pre = `${Array.from({ length: 5000 }, (_, i) => `const K_${i} = ${i % 101};`).join('\n')}\nlet calls = 0;\nlet flag = 0;\nfunction setFlag(v) { flag = v; }`;
  // ~0.7 s per side unloaded; the time limits only keep a loaded host from
  // ending it inconclusive (AUDIT-19 M1).
  const opts = { pre, exp: 'module.exports = { pick, readFlag: () => flag };', hardKillMs: 20_000, budgetMs: 10_000 };
  const cur = 'function pick(i) {\n  calls++;\n  return K_1 + i;\n}';
  const mid = edit(cur, 'function pick(i) {\n  calls++;\n  if (calls === 3) setFlag(1);\n  if (calls === 6) setFlag(0);\n  return K_1 + i;\n}', opts);
  assert.strictEqual(mid.verdict, 'divergent', mid.reason);
  const same = edit(cur, 'function pick(i) {\n  calls += 1;\n  const r = K_1 + i;\n  return r;\n}', opts);
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
});

test('oracle: named array properties and state read through prototype methods of returned instances', () => {
  const named = edit("function put(o, k, v) {\n  k === '__proto__' && (k = '_proto');\n  o[k] = v;\n  return o;\n}", 'function put(o, k, v) {\n  o[k] = v;\n  return o;\n}');
  assert.strictEqual(named.verdict, 'divergent', named.reason);
  const cls = (body) => `class Pool {\n  #max;\n  constructor(max) {\n    ${body}\n  }\n  capacity() {\n    return this.#max;\n  }\n}`;
  const priv = edit(cls('this.#max = Math.max(1, max);'), cls('this.#max = max;'), { exp: 'module.exports = { Pool };' });
  assert.strictEqual(priv.verdict, 'divergent', priv.reason);
  const same = edit(cls('this.#max = Math.max(1, max);'), cls('this.#max = Math.max(max, 1);'), { exp: 'module.exports = { Pool };' });
  assert.strictEqual(same.verdict, 'equivalent', same.reason);
});

// ---------- SG23: every rule that keeps a verdict from being `equivalent` is pinned (AUDIT-11 C1, C3) ----------

// ~8 ms per call here; the budgets below are far from what all runs need.
const SLOW = 'let s = 0;\n  for (let i = 0; i < 1e6; i++) s = (s + i) % 7;';

test('a target cut short by the time budget is inconclusive even with enough value runs (AUDIT-11 C1)', () => {
  const r = run({
    currentSrc: `function kind(x) {\n  ${SLOW}\n  return typeof x + s;\n}`,
    proposedSrc: `function kind(x) {\n  ${SLOW}\n  const t = typeof x;\n  return t + s;\n}`,
    budgetMs: 100, minValueRuns: 1, callTimeoutMs: 2000
  });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /kind: time budget reached after [1-9]\d* of \d+ inputs/);
});

test('every input run but too few value runs before the budget is inconclusive (AUDIT-11 C1)', () => {
  const r = run({
    currentSrc: `function slow() {\n  ${SLOW}\n  return s;\n}`,
    proposedSrc: `function slow() {\n  ${SLOW}\n  const r = s;\n  return r;\n}`,
    budgetMs: 200, minValueRuns: 100, callTimeoutMs: 2000
  });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /slow: (only \d+ of \d+ runs returned comparable values|time budget reached)/);
});

test('deferred module state too large to compare is inconclusive (AUDIT-11 C1)', () => {
  const r = edit("function twice(x) {\n  if (typeof x !== 'number') return 0;\n  return x * 2;\n}", "function twice(x) {\n  if (typeof x !== 'number') return 0;\n  return x + x;\n}", {
    pre: 'const TABLE = Array.from({ length: 3000 }, (_, i) => i);\nlet DEEP = {};\nfor (let i = 0; i < 40; i++) DEEP = { d: DEEP };',
    exp: 'module.exports = { twice, TABLE, DEEP };'
  });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /twice: module state too large to compare/);
});

test('no changed callable resolved (a removed private helper) is inconclusive (AUDIT-11 C1)', () => {
  const helper = 'function helper(x) {\n  return x + 1;\n}\n';
  const r = run({ currentSrc: helper, proposedSrc: '', fileSrc: `'use strict';\n${helper}function main(x) {\n  return x;\n}\nmodule.exports = { main };\n` });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /no changed callable could be resolved/);
});

test('a new top-level declaration with a side-effecting initialiser caps the verdict (AUDIT-11 C1)', () => {
  const cur = 'function inc(x) {\n  return x + 1;\n}';
  const r = edit(cur, `const added = registry.add('inc');\n${cur}`, {
    pre: 'const registry = (() => { const items = []; return { add: (x) => items.push(x), size: () => items.length }; })();',
    exp: 'module.exports = { inc };'
  });
  assert.strictEqual(r.verdict, 'inconclusive', r.reason);
  assert.match(r.reason, /top-level statement changed outside a located callable: "const added = registry\.add/);
});

test('crashes inside the oracle are inconclusive: preparation, sandbox, worker start (AUDIT-11 C3)', () => {
  const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
  const f = { currentSrc: 'function f(x) {\n  return x;\n}', proposedSrc: 'function f(x) {\n  return x + 0;\n}' };
  const prep = run({ ...f, arity: Infinity });
  assert.strictEqual(prep.verdict, 'inconclusive');
  assert.match(prep.reason, /^diff test error: /);
  const start = run({ ...f, minValueRuns: Symbol('uncloneable') });
  assert.strictEqual(start.verdict, 'inconclusive');
  assert.match(start.reason, /^worker failed to start: /);
  // The sandbox worker given a payload without targets throws in main().
  const sab = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  const w = new Worker(require.resolve('../src/validation/diff-sandbox-worker.js'), { workerData: { flag: sab, port: port2 }, transferList: [port2] });
  Atomics.wait(new Int32Array(sab), 0, 0, 10000);
  const m = receiveMessageOnPort(port1);
  w.terminate();
  port1.close();
  assert.strictEqual(m.message.result.verdict, 'inconclusive');
  assert.match(m.message.result.reason, /^sandbox error: /);
});

test('integer-width, prototype-key, tab and long-string boundaries are always tried (AUDIT-21 H1)', () => {
  const fn = (body) => `function f(n) {\n  return ${body};\n}\nmodule.exports = { f };`;
  for (const [cur, prop] of [
    ['Math.trunc(Number(n) || 0)', '(Number(n) || 0) | 0'],
    ['Math.floor(Math.abs(Number(n) || 0) / 2)', 'Math.abs(Number(n) || 0) >> 1'],
    ['Math.trunc(Math.abs(Number(n) || 0))', 'Math.abs(Number(n) || 0) >>> 0'],
    ["typeof ({ a: 1 })[n] === 'number'", 'n in { a: 1 }'],
    ['String(n).slice(0, 0x1000)', 'String(n).slice(-0x1000)'],
    ["String(n).replace(/\\t/g, ' ')", "String(n).replace(/\\t+/g, ' ')"]
  ]) {
    const r = run({ currentSrc: fn(cur), proposedSrc: fn(prop) });
    assert.strictEqual(r.verdict, 'divergent', `${prop}: ${r.reason}`);
  }
});
