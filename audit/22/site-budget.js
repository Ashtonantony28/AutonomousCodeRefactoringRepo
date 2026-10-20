#!/usr/bin/env node
'use strict';

// Per-token sites (SG26 use sites + SG30 literal / token sites) of realistic
// behaviour-preserving refactors against the 12-sites-per-hunk cap and the
// 60 s mutant budget. No suite is run: editMutants only. The audit/12
// executor-benign refactors (B01-B18) plus five larger ones (R1-R5, 8-25
// lines). For each: sites, mutants (shams), result, the suite runs a pass
// needs at least (3 per site: fail, fail again, control/sham) and the longest
// suite that fits those runs in 60 s (each run also has to start with its
// 2x suite + 1 s cap; the first mutant run starts after the main run).
// FINDING when a refactor of at most 25 lines is `capped` (reverted
// `mutation_budget` without a test run).
//
// usage: node audit/22/site-budget.js

const L = require('./lib');
const { editMutants } = require(L.src('rl/bug-injector'));

const B = require('fs').readFileSync(L.path.join(L.REPO_ROOT, 'audit', '12', 'executor-benign.js'), 'utf8');
// eslint-disable-next-line no-new-func
const CASES = new Function(`${B.slice(B.indexOf('const CASES'), B.indexOf('function filesFor'))}; return CASES;`)();

const R = [
  { id: 'R1', kind: 'switch -> lookup table', cur: "function code(s) {\n  switch (s) {\n    case 'ok': return 200;\n    case 'created': return 201;\n    case 'missing': return 404;\n    case 'denied': return 403;\n    default: return 500;\n  }\n}",
    prop: "const CODES = { ok: 200, created: 201, missing: 404, denied: 403 };\nfunction code(s) {\n  return Object.prototype.hasOwnProperty.call(CODES, s) ? CODES[s] : 500;\n}" },
  { id: 'R2', kind: 'extract helper (validation)', cur: "function parse(o) {\n  if (typeof o.name !== 'string' || o.name.length === 0) throw new Error('name');\n  if (typeof o.age !== 'number' || o.age < 0) throw new Error('age');\n  return { name: o.name.trim(), age: Math.floor(o.age) };\n}",
    prop: "function need(ok, what) {\n  if (!ok) throw new Error(what);\n}\nfunction parse(o) {\n  need(typeof o.name === 'string' && o.name.length > 0, 'name');\n  need(typeof o.age === 'number' && o.age >= 0, 'age');\n  return { name: o.name.trim(), age: Math.floor(o.age) };\n}" },
  { id: 'R3', kind: 'loop -> reduce (stats)', cur: 'function stats(xs) {\n  let min = Infinity, max = -Infinity, sum = 0;\n  for (const x of xs) {\n    if (x < min) min = x;\n    if (x > max) max = x;\n    sum += x;\n  }\n  return { min, max, mean: xs.length ? sum / xs.length : 0 };\n}',
    prop: 'function stats(xs) {\n  const sum = xs.reduce((a, x) => a + x, 0);\n  return { min: Math.min(...xs), max: Math.max(...xs), mean: xs.length ? sum / xs.length : 0 };\n}' },
  { id: 'R4', kind: 'callbacks -> async/await', cur: "function load(db, id, cb) {\n  db.get(id).then((row) => {\n    if (!row) return cb(new Error('missing ' + id));\n    cb(null, { id: row.id, tags: row.tags || [] });\n  }, cb);\n}",
    prop: "async function loadAsync(db, id) {\n  const row = await db.get(id);\n  if (!row) throw new Error(`missing ${id}`);\n  return { id: row.id, tags: row.tags ?? [] };\n}\nfunction load(db, id, cb) {\n  loadAsync(db, id).then((v) => cb(null, v), cb);\n}" },
  { id: 'R5', py: true, kind: 'python: loop -> comprehension with helper', cur: 'def summary(rows):\n    out = {}\n    for r in rows:\n        if r["qty"] > 0 and r["price"] >= 0:\n            k = r["sku"].upper()\n            out[k] = out.get(k, 0) + r["qty"] * r["price"]\n    return out\n',
    prop: 'def _ok(r):\n    return r["qty"] > 0 and r["price"] >= 0\n\n\ndef summary(rows):\n    out = {}\n    for r in filter(_ok, rows):\n        k = r["sku"].upper()\n        out[k] = out.get(k, 0) + r["qty"] * r["price"]\n    return out\n' }
];

const W = [4, 42, 6, 8, 7, 22, 9, 10];
console.log(L.row(['id', 'refactor', 'lines', 'sites', 'muts', 'result', 'min_runs', 'max_suite_s'], W));
for (const c of [...CASES, ...R]) {
  const file = c.py ? 'app/mod.py' : 'src/mod.js';
  const pre = c.py ? '' : "'use strict';\n";
  const tail = c.py ? '' : `\nmodule.exports = {};\n`;
  const before = pre + c.cur + '\n' + tail, after = pre + c.prop + '\n' + tail;
  const r = editMutants(after, { start: 0, end: after.length, file, max: 3, before, timeoutMs: 10_000 });
  const sites = new Set(r.map(m => `${m.site}${m.revert ? 'r' : ''}`)).size;
  const res = r.capped ? 'capped' : r.unchecked ? 'unchecked' : r.uncovered ? `uncovered ${r.uncovered.text}` : r.unmutated_ref ? `unmutated_ref ${r.unmutated_ref.name}` : sites ? 'mutants' : 'no sites';
  const shams = r.filter(m => m.sham).length;
  const runs = 3 * sites;
  const lines = c.prop.split('\n').length;
  // n runs of s seconds fit in 60 s with the 0.5 s start margin: n*s + 0.5 <= 60.
  const maxSuite = runs ? (60 - 0.5) / runs : NaN;
  console.log(L.row([c.id, c.kind.slice(0, 41), lines, sites, `${r.length}/${shams}`, res.slice(0, 21), runs || '-', runs ? L.fmt(maxSuite, 1) : '-'], W));
  if (lines <= 25) L.check(`${c.id} (${lines} lines): not capped`, !r.capped);
}
L.finish();
