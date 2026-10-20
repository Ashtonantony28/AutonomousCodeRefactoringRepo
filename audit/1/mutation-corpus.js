'use strict';

// AUDIT-1 mutation corpus. Every proposal below changes observable behaviour
// (return value, thrown error, side effect, or input mutation) for some input.
// Each is run through the real orchestrator gate with a maximally favourable
// stub critic (3/3 approve, p_preserves 0.9) in dry-run mode. A mutant whose
// status is `dry_run` reached the executor stage = ESCAPED. `vetoed` /
// `critic_rejected` = caught.
//
//   node audit/1/mutation-corpus.js           # table + escape rate
//   node audit/1/mutation-corpus.js --json    # machine-readable

const { makeRepo, throughGate, summary, rm } = require('./lib');

const fileOf = (body, exportsLine, pre = '') => `'use strict';\n${pre}\n${body}\n${exportsLine}\n`;

// { id, kind, cur, prop, pre?, exp?, pkg? }  (exp defaults to module.exports = { <fn name> })
const M = [
  { id: 'M01', kind: 'off-by-one loop bound',
    cur: 'function sum(arr) {\n  let s = 0;\n  for (let i = 0; i < arr.length; i++) s += arr[i];\n  return s;\n}',
    prop: 'function sum(arr) {\n  let s = 0;\n  for (let i = 0; i < arr.length - 1; i++) s += arr[i];\n  return s;\n}' },
  { id: 'M02', kind: 'flipped comparison (>= to >)',
    cur: 'function isAdult(age) {\n  return age >= 18;\n}',
    prop: 'function isAdult(age) {\n  return age > 18;\n}' },
  { id: 'M03', kind: 'flipped comparison (< to <=) in guard',
    cur: 'function withinLimit(n) {\n  if (n < 100) return true;\n  return false;\n}',
    prop: 'function withinLimit(n) {\n  if (n <= 100) return true;\n  return false;\n}' },
  { id: 'M04', kind: 'off-by-one slice',
    cur: 'function lastN(arr, n) {\n  return arr.slice(arr.length - n);\n}',
    prop: 'function lastN(arr, n) {\n  return arr.slice(arr.length - n - 1);\n}' },
  { id: 'M05', kind: 'dropped await inside try/catch',
    cur: 'async function load(fetchFn, id) {\n  try {\n    return await fetchFn(id);\n  } catch (e) {\n    return null;\n  }\n}',
    prop: 'async function load(fetchFn, id) {\n  try {\n    return fetchFn(id);\n  } catch (e) {\n    return null;\n  }\n}' },
  { id: 'M06', kind: 'dropped await before side effect',
    cur: 'async function save(store, key, v) {\n  await store.write(key, v);\n  return store.size();\n}',
    prop: 'async function save(store, key, v) {\n  store.write(key, v);\n  return store.size();\n}' },
  { id: 'M07', kind: 'swallowed error (throw -> return {})',
    cur: 'function parseConfig(text) {\n  return JSON.parse(text);\n}',
    prop: 'function parseConfig(text) {\n  try {\n    return JSON.parse(text);\n  } catch (e) {\n    return {};\n  }\n}' },
  { id: 'M08', kind: 'swallowed error (not-found throw -> null)',
    cur: "function getUser(db, id) {\n  const u = db.find(id);\n  if (!u) throw new Error('not found');\n  return u;\n}",
    prop: 'function getUser(db, id) {\n  const u = db.find(id);\n  if (!u) return null;\n  return u;\n}' },
  { id: 'M09', kind: 'catch rethrow -> catch swallow (same try count)',
    cur: "function readJson(text) {\n  try {\n    return JSON.parse(text);\n  } catch (e) {\n    throw new SyntaxError('bad config: ' + e.message);\n  }\n}",
    prop: 'function readJson(text) {\n  try {\n    return JSON.parse(text);\n  } catch (e) {\n    return undefined;\n  }\n}' },
  { id: 'M10', kind: 'changed exception type',
    cur: "function assertPositive(n) {\n  if (!(n > 0)) throw new RangeError('must be positive');\n  return n;\n}",
    prop: "function assertPositive(n) {\n  if (!(n > 0)) throw new Error('must be positive');\n  return n;\n}" },
  { id: 'M11', kind: 'dropped error.code',
    cur: "function requireNumber(x) {\n  if (typeof x !== 'number') {\n    const e = new TypeError('expected number');\n    e.code = 'ERR_INVALID_ARG';\n    throw e;\n  }\n  return x;\n}",
    prop: "function requireNumber(x) {\n  if (typeof x !== 'number') throw new TypeError('expected number');\n  return x;\n}" },
  { id: 'M12', kind: 'changed default (page size)',
    cur: 'function paginate(items, size = 10) {\n  return items.slice(0, size);\n}',
    prop: 'function paginate(items, size = 20) {\n  return items.slice(0, size);\n}' },
  { id: 'M13', kind: 'changed default option',
    cur: 'function fmt(n, opts = {}) {\n  const d = opts.decimals ?? 2;\n  return Number(n).toFixed(d);\n}',
    prop: 'function fmt(n, opts = {}) {\n  const d = opts.decimals ?? 3;\n  return Number(n).toFixed(d);\n}' },
  { id: 'M14', kind: 'changed default via ||  -> ?? (0 now honoured)',
    cur: 'function retries(opts) {\n  return (opts && opts.retries) || 3;\n}',
    prop: 'function retries(opts) {\n  return (opts && opts.retries) ?? 3;\n}' },
  { id: 'M15', kind: 'mutated input array (copy -> in-place sort)',
    cur: 'function sorted(arr) {\n  return [...arr].sort((a, b) => a - b);\n}',
    prop: 'function sorted(arr) {\n  return arr.sort((a, b) => a - b);\n}' },
  { id: 'M16', kind: 'mutated input object',
    cur: 'function withName(user) {\n  return Object.assign({}, user, { name: String(user.name).trim() });\n}',
    prop: 'function withName(user) {\n  user.name = String(user.name).trim();\n  return user;\n}' },
  { id: 'M17', kind: 'sign of zero (-x -> 0 - x)',
    cur: 'function negate(x) {\n  return -x;\n}',
    prop: 'function negate(x) {\n  return 0 - x;\n}' },
  { id: 'M18', kind: 'off-by-one on large number (epoch ms)',
    cur: 'function expiresAt(ttlMs) {\n  return 1700000000000 + ttlMs;\n}',
    prop: 'function expiresAt(ttlMs) {\n  return 1700000000000 + ttlMs + 1;\n}' },
  { id: 'M19', kind: 'returned closure behaviour',
    cur: 'function makeAdder(n) {\n  return (x) => x + n;\n}',
    prop: 'function makeAdder(n) {\n  return (x) => x - n;\n}' },
  { id: 'M20', kind: 'class method using instance state',
    cur: 'class Cart {\n  constructor(items) { this.items = items || []; }\n  total() {\n    return this.items.reduce((s, i) => s + i.price * i.qty, 0);\n  }\n}',
    prop: 'class Cart {\n  constructor(items) { this.items = items || []; }\n  total() {\n    return this.items.reduce((s, i) => s + i.price, 0);\n  }\n}',
    exp: 'module.exports = { Cart };' },
  { id: 'M21', kind: 'object-literal method in module.exports',
    cur: 'module.exports = {\n  area(r) {\n    return Math.PI * r * r;\n  }\n};',
    prop: 'module.exports = {\n  area(r) {\n    return 2 * Math.PI * r;\n  }\n};',
    exp: '' },
  { id: 'M22', kind: 'changed module constant',
    cur: 'const MAX_RETRIES = 3;', prop: 'const MAX_RETRIES = 5;',
    pre: '', exp: 'function retry(fn) { for (let i = 0; i < MAX_RETRIES; i++) { try { return fn(); } catch (e) { /* again */ } } return null; }\nmodule.exports = { retry, MAX_RETRIES };' },
  { id: 'M23', kind: 'file with top-level call into a dependency',
    pre: "const debug = require('debug')('app');",
    cur: 'function double(x) {\n  return x * 2;\n}',
    prop: 'function double(x) {\n  return x * 3;\n}', pkg: { dependencies: { debug: '^4.0.0' } } },
  { id: 'M24', kind: 'function calling a required module',
    pre: "const path = require('path');",
    cur: 'function ext(p) {\n  return path.extname(p);\n}',
    prop: 'function ext(p) {\n  return path.basename(p);\n}' },
  { id: 'M25', kind: 'dropped write to module state',
    pre: 'const cache = new Map();',
    cur: 'function remember(k, v) {\n  cache.set(k, v);\n  return v;\n}',
    prop: 'function remember(k, v) {\n  return v;\n}',
    exp: 'module.exports = { remember, cache };' },
  { id: 'M26', kind: 'removed path-traversal check (security)',
    cur: "function safePath(p) {\n  if (String(p).includes('..')) throw new Error('bad path');\n  return p;\n}",
    prop: 'function safePath(p) {\n  return p;\n}' },
  { id: 'M27', kind: 'weakened regex validation',
    cur: 'function isEmail(s) {\n  return /^[^@\\s]+@[^@\\s]+\\.[a-z]+$/.test(s);\n}',
    prop: 'function isEmail(s) {\n  return /^[^@\\s]+@[^@\\s]+$/.test(s);\n}' },
  { id: 'M28', kind: 'loose vs strict equality',
    cur: 'function isZero(x) {\n  return x === 0;\n}',
    prop: 'function isZero(x) {\n  return x == 0;\n}' },
  { id: 'M29', kind: 'rounding mode',
    cur: 'function toCents(x) {\n  return Math.round(x * 100);\n}',
    prop: 'function toCents(x) {\n  return Math.floor(x * 100);\n}' },
  { id: 'M30', kind: 'removed divide-by-zero guard',
    cur: "function ratio(a, b) {\n  if (b === 0) throw new Error('division by zero');\n  return a / b;\n}",
    prop: 'function ratio(a, b) {\n  return a / b;\n}' },
  { id: 'M31', kind: 'two functions in region, second one broken',
    cur: 'function inc(x) {\n  return x + 1;\n}\nfunction twice(x) {\n  return x * 2;\n}',
    prop: 'function inc(x) {\n  return (x + 1);\n}\nfunction twice(x) {\n  return x * 3;\n}',
    exp: 'module.exports = { inc, twice };' },
  { id: 'M32', kind: 'string trim semantics',
    cur: 'function isBlank(s) {\n  return s.length === 0;\n}',
    prop: 'function isBlank(s) {\n  return s.trim().length === 0;\n}' },
  { id: 'M33', kind: 'getter changed',
    cur: 'class Temp {\n  constructor(c) { this.c = c; }\n  get f() {\n    return this.c * 9 / 5 + 32;\n  }\n}',
    prop: 'class Temp {\n  constructor(c) { this.c = c; }\n  get f() {\n    return this.c * 9 / 5;\n  }\n}',
    exp: 'module.exports = { Temp };' },
  { id: 'M34', kind: 'async rejection type changed',
    cur: "async function fetchUser(id) {\n  if (id == null) throw new TypeError('id required');\n  return { id };\n}",
    prop: "async function fetchUser(id) {\n  if (id == null) throw new Error('id required');\n  return { id };\n}" },
  { id: 'M35', kind: 'array result beyond 200 elements',
    cur: 'function range(n) {\n  return Array.from({ length: Math.abs(n) * 10 }, (_, i) => i);\n}',
    prop: 'function range(n) {\n  return Array.from({ length: Math.abs(n) * 10 }, (_, i) => (i < 200 ? i : -i));\n}' },
  { id: 'M36', kind: 'nested result deeper than 8 levels',
    cur: 'function nest(x) {\n  let o = { v: x };\n  for (let i = 0; i < 10; i++) o = { o };\n  return o;\n}',
    prop: 'function nest(x) {\n  let o = { v: -x };\n  for (let i = 0; i < 10; i++) o = { o };\n  return o;\n}' }
];

function nameOf(m) {
  const mm = /(?:function|class)\s+(\w+)/.exec(m.cur);
  return mm ? mm[1] : null;
}

async function main() {
  const json = process.argv.includes('--json');
  const rows = [];
  for (const m of M) {
    const exp = m.exp != null ? m.exp : `module.exports = { ${nameOf(m)} };`;
    const repo = makeRepo({ 'src/mod.js': fileOf(m.cur, exp, m.pre || '') }, { pkg: m.pkg || {} });
    try {
      const { proposal } = await throughGate({ repo, file: 'src/mod.js', current: m.cur, proposed: m.prop });
      const s = summary(proposal);
      rows.push({ id: m.id, kind: m.kind, escaped: s.status === 'dry_run', ...s });
    } finally { rm(repo); }
  }
  const esc = rows.filter(r => r.escaped);
  if (json) { console.log(JSON.stringify({ total: rows.length, escaped: esc.length, rows }, null, 2)); return; }
  for (const r of rows) {
    console.log(`${r.id} ${r.escaped ? 'ESCAPED' : 'caught '} status=${r.status} combined=${r.combined} dt=${r.diff_test}${r.failed_checks.length ? ` failed_checks=${r.failed_checks.join(',')}` : ''}  -- ${r.kind}`);
  }
  console.log(`\nescape rate: ${esc.length}/${rows.length} = ${(100 * esc.length / rows.length).toFixed(1)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
