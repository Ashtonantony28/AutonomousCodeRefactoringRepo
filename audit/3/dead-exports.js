'use strict';

// AUDIT-3: exported functions/constants of src/ modules that nothing in src/
// or bench/ references (tests excluded). Heuristic: an export counts as used
// when its name appears as a word in another non-test file. Informational.
//
//   node audit/3/dead-exports.js

require('./lib');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const a = path.join(d, e.name);
    if (e.isDirectory()) walk(a); else if (a.endsWith('.js')) files.push(a);
  }
})(path.join(ROOT, 'src'));
const others = [...files, ...fs.readdirSync(path.join(ROOT, 'bench')).map(f => path.join(ROOT, 'bench', f))];
const text = new Map(others.map(f => [f, fs.readFileSync(f, 'utf8')]));

const log = console.log; console.log = () => {};
const dead = [];
for (const f of files) {
  if (f.endsWith('diff-sandbox-worker.js')) continue; // worker entry, not a module
  let mod;
  try { mod = require(f); } catch { continue; }
  for (const name of Object.keys(mod)) {
    const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
    const usedElsewhere = [...text].some(([g, src]) => g !== f && re.test(src));
    // used inside its own module (besides the export line) counts as internal
    const own = text.get(f).split('\n').filter(l => re.test(l) && !/module\.exports|defineProperty\(module\.exports/.test(l)).length;
    if (!usedElsewhere) dead.push({ module: path.relative(ROOT, f), export: name, internal_uses: own });
  }
}
console.log = log;
// internal_uses <= 1 means only the definition itself: nothing in production calls it.
console.log('Exports never used by production code (only the definition; tests excluded):');
console.table(dead.filter(d => d.internal_uses <= 1));
console.log(`(${dead.length - dead.filter(d => d.internal_uses <= 1).length} more exports are used only inside their own module, i.e. exported for tests)`);
