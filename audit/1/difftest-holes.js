'use strict';

// Differential-testing oracle holes: pairs that differ observably but are
// reported `equivalent` (score 1) or `inconclusive` (fail-open).
//   node audit/1/difftest-holes.js
// Expected for every row: verdict=divergent.

const diffTesting = require('../../src/validation/diff-testing');

const fileOf = (fn, exp) => `'use strict';\n${fn}\nmodule.exports = { ${exp} };\n`;

const cases = [
  // -- comparison holes (ser/deepEq in diff-sandbox-worker.js)
  { id: 'D1 -0 vs +0', cur: 'function neg(x) {\n  return -Number(x);\n}', prop: 'function neg(x) {\n  return 0 - Number(x);\n}',
    witness: [0] },
  { id: 'D2 relative tolerance 1e-9', cur: 'function at(x) {\n  return 1700000000000 + (Number(x) || 0);\n}', prop: 'function at(x) {\n  return 1700000000000 + (Number(x) || 0) + 1;\n}',
    witness: [0] },
  { id: 'D3 returned function', cur: 'function adder(n) {\n  return (x) => x + n;\n}', prop: 'function adder(n) {\n  return (x) => x - n;\n}',
    witness: [1], post: (f) => f(10) },
  { id: 'D4 error own props (code)', cur: "function chk(x) {\n  const e = new TypeError('bad');\n  e.code = 'E_ONE';\n  throw e;\n}", prop: "function chk(x) {\n  const e = new TypeError('bad');\n  e.code = 'E_TWO';\n  throw e;\n}",
    witness: [1], thrown: true },
  { id: 'D5 array tail > 200', cur: 'function r(n) {\n  return Array.from({ length: 300 }, (_, i) => i);\n}', prop: 'function r(n) {\n  return Array.from({ length: 300 }, (_, i) => (i < 200 ? i : 0));\n}',
    witness: [1] },
  { id: 'D6 depth > 8', cur: 'function d(x) {\n  let o = { v: 1 };\n  for (let i = 0; i < 9; i++) o = { o };\n  return o;\n}', prop: 'function d(x) {\n  let o = { v: 2 };\n  for (let i = 0; i < 9; i++) o = { o };\n  return o;\n}',
    witness: [1] },
  { id: 'D7 prototype / non-enumerable', cur: "function mk(x) {\n  const o = {};\n  Object.defineProperty(o, 'id', { value: 1, enumerable: false });\n  return o;\n}", prop: "function mk(x) {\n  const o = {};\n  Object.defineProperty(o, 'id', { value: 2, enumerable: false });\n  return o;\n}",
    witness: [1], post: (o) => o.id },
  { id: 'D8 symbol-keyed result', cur: "const K = Symbol.for('k');\nfunction tag(x) {\n  return { [K]: 'a' };\n}", prop: "const K = Symbol.for('k');\nfunction tag(x) {\n  return { [K]: 'b' };\n}",
    witness: [1], post: (o) => o[Symbol.for('k')] },
  { id: 'D9 module-level side effect', cur: 'const seen = [];\nfunction track(x) {\n  seen.push(x);\n  return x;\n}', prop: 'const seen = [];\nfunction track(x) {\n  return x;\n}',
    exp: 'track, seen', witness: [1], post: (_r, m) => m.seen.length },
  // -- input-generation holes: inputs are only primitives / small int arrays
  { id: 'D10 all calls throw same TypeError -> "equivalent"', cur: 'function count(o) {\n  return o.items.length;\n}', prop: 'function count(o) {\n  return o.items.length + 1;\n}',
    witness: [{ items: [] }] },
  { id: 'D11 needs object arg', cur: "function role(user) {\n  if (user && user.admin === true) return 'admin';\n  return 'user';\n}", prop: "function role(user) {\n  if (user && user.admin) return 'admin';\n  return 'user';\n}",
    witness: [{ admin: 'yes' }] },
  // -- fail-open inconclusive paths
  { id: 'D12 object-literal method', file: "'use strict';\nmodule.exports = {\n  half(x) {\n    return x / 2;\n  }\n};\n",
    cur: '  half(x) {\n    return x / 2;\n  }', prop: '  half(x) {\n    return x / 3;\n  }', witness: [6], member: 'half' },
  { id: 'D13 top-level dependency call', file: "'use strict';\nconst log = require('debug')('x');\nfunction dbl(x) {\n  return x * 2;\n}\nmodule.exports = { dbl };\n",
    cur: 'function dbl(x) {\n  return x * 2;\n}', prop: 'function dbl(x) {\n  return x * 3;\n}', witness: [2], skipEval: true },
  { id: 'D14 snippet mode, proposed-only ReferenceError', snippet: true,
    cur: 'function slug(s) {\n  return String(s).toLowerCase();\n}', prop: 'function slug(s) {\n  return normalizeSlug(String(s).toLowerCase());\n}', witness: ['A'] }
];

function load(src) {
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src)(m, m.exports, require);
  return m.exports;
}

function observe(c, src) {
  if (c.skipEval) return '(needs debug package)';
  try {
    const mod = load(src);
    const name = c.member || /function\s+(\w+)/.exec(c.cur)[1];
    let r;
    try { r = mod[name](...c.witness); } catch (e) { return `throw ${e.name} code=${e.code}`; }
    if (c.post) r = c.post(r, mod);
    const s = Object.is(r, -0) ? '-0' : JSON.stringify(r);
    return s.length > 60 ? '…' + s.slice(-40) : s;
  } catch (e) { return `load error ${e.message}`; }
}

let bad = 0;
for (const c of cases) {
  const exp = c.exp || c.member || /function\s+(\w+)/.exec(c.cur)[1];
  const fileSrc = c.snippet ? undefined : (c.file || fileOf(c.cur, exp));
  const r = diffTesting.run({ currentSrc: c.cur, proposedSrc: c.prop, fileSrc });
  const propFile = fileSrc ? fileSrc.replace(c.cur, () => c.prop) : null;
  const a = observe(c, fileSrc || fileOf(c.cur, exp));
  const b = observe(c, propFile || fileOf(c.prop, exp));
  if (r.verdict !== 'divergent') bad++;
  console.log(`${c.id.padEnd(52)} verdict=${r.verdict.padEnd(12)} runs=${String(r.runs).padEnd(3)} witness ${JSON.stringify(c.witness)}: current=${a} proposed=${b}${r.verdict === 'inconclusive' ? `  (${r.reason})` : ''}`);
}
console.log(`\n${bad}/${cases.length} observably different pairs not reported divergent`);
