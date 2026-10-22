#!/usr/bin/env node
'use strict';

// AUDIT-33: SG42 binds each mutant switch to a random 16-letter value
// (`env`) and gives the control run another (`control`). Per-call and
// per-run cost:
//   * editMutants: one value pair per call (all mutants of an edit share the
//     hoisted read, so the mutant copies differ only by their switch), the
//     values are 16 lowercase letters and differ; editMutants time with the
//     random values vs a copy of the current src with fixed values;
//   * per run: the control run now sets the variable (was unset); the
//     switch compares one 16-letter string per module load (audit/25
//     switch-hot measures the hot path).
// FINDING when an edit's mutants carry different values, the control value
// equals the mutant value, or drawing the two values costs over 100 us per
// edit (editMutants random vs fixed is printed for information: the
// difference is within run-to-run noise).
//
// usage: node audit/33/switch-value.js [--reps 5]

const L = require('../29/lib');

const REPS = Number(L.opt('--reps', 5));
const cur = require(L.src('rl/bug-injector')).editMutants;

// The same src with the two random values fixed.
const dir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a33-sw-'));
L.fs.cpSync(L.path.join(L.REPO_ROOT, 'src'), L.path.join(dir, 'src'), { recursive: true });
L.fs.symlinkSync(L.path.join(L.REPO_ROOT, 'node_modules'), L.path.join(dir, 'node_modules'));
const f = L.path.join(dir, 'src/rl/bug-injector.js');
const text = L.fs.readFileSync(f, 'utf8');
const from = 'const [val, off] = [token(), token()];';
if (!text.includes(from)) throw new Error('fixed-value patch does not apply');
L.fs.writeFileSync(f, text.replace(from, "const [val, off] = ['abcdefghijklmnop', 'ponmlkjihgfedcba'];"));
const fixed = require(L.path.join(dir, 'src/rl/bug-injector')).editMutants;

function fixture(lang, hunks) {
  const js = lang === 'js';
  const b = [], e = [];
  for (let i = 0; i < 400; i++) {
    const l = js ? `function f${i}(a) { return a + ${i}; }` : `def f${i}(a):\n    return a + ${i}\n`;
    b.push(l); e.push(l);
  }
  for (let h = 0; h < hunks; h++) {
    b.push(js ? `function g${h}(x) { return x + 1; }` : `def g${h}(x):\n    return x + 1\n`);
    e.push(js ? `function g${h}(x) { return x * 2 - 1; }` : `def g${h}(x):\n    return x * 2 - 1\n`);
    b.push(js ? '// sep' : '# sep'); e.push(js ? '// sep' : '# sep');
  }
  return { before: b.join('\n') + '\n', edited: e.join('\n') + '\n', file: js ? 'src/a.js' : 'pkg/a.py' };
}

for (const lang of ['js', 'py']) {
  if (lang === 'py') L.pyPath();
  const fx = fixture(lang, 8);
  const t = { cur: [], fixed: [] };
  let r;
  for (let i = 0; i < REPS; i++) {
    let t0 = performance.now();
    r = cur(fx.edited, { file: fx.file, before: fx.before, max: 3 });
    t.cur.push(performance.now() - t0);
    t0 = performance.now();
    fixed(fx.edited, { file: fx.file, before: fx.before, max: 3 });
    t.fixed.push(performance.now() - t0);
  }
  const vals = new Set(r.map(m => Object.values(m.env)[0])), ctl = new Set(r.map(m => Object.values(m.control)[0]));
  const [v] = vals, [c] = ctl;
  const a = L.median(t.cur), b = L.median(t.fixed);
  console.log(`${lang}: ${r.length} mutants, values ${[...vals].join(',')} / control ${[...ctl].join(',')}; editMutants random ${L.ms(a)} vs fixed ${L.ms(b)}`);
  L.check(`${lang}: one switch value per edit, one control value`, r.length > 0 && vals.size === 1 && ctl.size === 1, `${vals.size} / ${ctl.size}`);
  L.check(`${lang}: values are 16 lowercase letters and differ`, /^[a-z]{16}$/.test(v) && /^[a-z]{16}$/.test(c) && v !== c, `${v} ${c}`);
}
const n = 100000, t0 = performance.now();
const crypto = require('crypto');
for (let i = 0; i < n; i++) [...crypto.randomBytes(16)].map(x => String.fromCharCode(97 + x % 26)).join('');
const us = (performance.now() - t0) * 1000 / n;
console.log(`token(): ${us.toFixed(2)} us per value, 2 per edit`);
L.check('two random values per edit cost under 100 us', 2 * us < 100, `${(2 * us).toFixed(1)} us`);
L.rm(dir);
L.finish();
