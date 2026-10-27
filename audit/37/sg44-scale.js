#!/usr/bin/env node
'use strict';

// AUDIT-37: SG44 separator work in bug-injector uncoveredToken
// (`structural()` -> `reach()` / `semiReach()` / `tupleNew()` / `seqs`) on
// separator-heavy edits under the 16-hunk / 32,000-char / 12-site caps, so
// editMutants reaches uncoveredToken. Each case runs editMutants on a copy of
// the current src and on a copy with one scan bounded, both instrumented to
// time uncoveredToken alone (globalThis.UT), and requires the same result.
//
//   py-tuple  L1: 16 hunks x 120 module-level `v = w` -> `v = w,` in a file
//             with --lines `aN, bN = N, 1` lines (2 top-level commas each).
//             Each inserted comma is beside kept code, so tupleNew() runs
//             `commaAt.get(-1).some(...)`: every top-level comma of the FILE,
//             not of the logical line. Fix: binary-search the line's slice.
//   py-semi   A33-M1 re-anchored on SG44's lineStart(): K `; pass` after the
//             closing bracket of a module-level literal of L lines; the walk
//             to the logical line's start runs per `;`. Fix: memoise per line.
//   js-reach  A33-L1 with SG44's reach(): 16 inserted functions of N
//             parameters. reach() calls fresh(i, i + 1) per character it
//             walks, and fresh() restarts its inserted-range cursor at 0.
//             Fix: binary-search the cursor.
//
// FINDING when uncoveredToken on the current src is more than 2x and 500 ms
// slower than the bounded copy (same result required).
//
// usage: node audit/37/sg44-scale.js [--cases py-tuple,py-semi,js-reach]
//          [--lines 25000,50000,85000] [--kb 2000] [--k 500] [--n 400] [--reps 2]

const L = require('../29/lib');

const CASES = L.list('--cases', 'py-tuple,py-semi,js-reach');
const LINES = L.nums('--lines', '25000,50000,85000');
const KB = L.nums('--kb', '2000');
const PYK = Number(L.opt('--k', 500));
const N = Number(L.opt('--n', 400));
const REPS = Number(L.opt('--reps', 2));

const TIMER = ['const bare = diffed && uncoveredToken(src, hunks, out, names, litToks, view, shape, lang);',
  'const _t0 = performance.now(); const bare = diffed && uncoveredToken(src, hunks, out, names, litToks, view, shape, lang); globalThis.UT = (globalThis.UT || 0) + performance.now() - _t0;'];
const PATCHES = {
  'py-tuple': [["if ((commaAt.get(o) || []).some(i => i !== a && s <= i && i < e && !fresh(i, i + 1))) return false;",
    '{ const C = commaAt.get(o) || []; let lo = 0, hi = C.length; while (lo < hi) { const m = (lo + hi) >> 1; if (C[m] < s) lo = m + 1; else hi = m; }\n      for (let j = lo; j < C.length && C[j] < e; j++) if (C[j] !== a && !fresh(C[j], C[j] + 1)) return false; }']],
  'py-semi': [["const lineStart = (a) => { let s = code.lastIndexOf('\\n', a - 1) + 1; while (s > 0 && depth.get(s)) s = code.lastIndexOf('\\n', s - 2) + 1; return s; };",
    "const LS = new Map(); const lineStart = (a) => { const s0 = code.lastIndexOf('\\n', a - 1) + 1; if (LS.has(s0)) return LS.get(s0); let s = s0; while (s > 0 && depth.get(s)) s = code.lastIndexOf('\\n', s - 2) + 1; LS.set(s0, s); return s; };"]],
  'js-reach': [['for (let c = a, i = 0; c < b; c++) {',
    'let i = 0; for (let h = ins.length; i < h;) { const m = (i + h) >> 1; if (ins[m][1] <= a) i = m + 1; else h = m; }\n    for (let c = a; c < b; c++) {']]
};

function copy(patches) {
  const dir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a37-src-'));
  L.fs.cpSync(L.path.join(L.REPO_ROOT, 'src'), L.path.join(dir, 'src'), { recursive: true });
  L.fs.symlinkSync(L.path.join(L.REPO_ROOT, 'node_modules'), L.path.join(dir, 'node_modules'));
  const f = L.path.join(dir, 'src/rl/bug-injector.js');
  let text = L.fs.readFileSync(f, 'utf8');
  for (const [from, to] of [TIMER, ...patches]) {
    // A bound already in src (SG46) leaves its patch nothing to replace.
    if (from !== TIMER[0] && !text.includes(from)) continue;
    if (text.split(from).length !== 2) throw new Error(`patch does not apply: ${from.slice(0, 60)}`);
    text = text.replace(from, () => to);
  }
  L.fs.writeFileSync(f, text);
  return dir;
}

function fixture(which, size) {
  if (which === 'py-tuple') {
    let head = 'w = 1\n';
    for (let i = 0; i < size; i++) head += `a${i}, b${i} = ${i}, 1\n`;
    let before = head, edited = head;
    for (let h = 0; h < 16; h++) {
      before += `# h${h}\n`; edited += `# h${h}\n`;
      for (let k = 0; k < 120; k++) { before += `v${h}_${k} = w\n`; edited += `v${h}_${k} = w,\n`; }
    }
    return { before, edited, file: 'pkg/big.py', label: `${size} lines, ${2 * size} top-level commas, 1920 inserted` };
  }
  if (which === 'py-semi') {
    let head = '';
    for (let i = 0; head.length < size * 512; i++) head += `def f${i}(a, b):\n    t = [a, b, ${i}]\n    return t[0] + t[1] * ${i}\n\n`;
    const lines = [];
    for (let i = 0, n = 0; n < size * 512; i++) { const l = `    ${i},`; lines.push(l); n += l.length + 1; }
    const lit = `DATA = [\n${lines.join('\n')}\n]`;
    return { before: head + lit + '\n', edited: head + lit + '; pass'.repeat(PYK) + '\n', file: 'pkg/big.py', label: `${size} KB, literal ${lines.length} lines, K=${PYK}` };
  }
  const before = 'function g(x) {\n' + Array.from({ length: 16 }, (_, h) => `  // h${h}\n  x = x + 1;\n`).join('') + '  return x;\n}\nmodule.exports = { g };\n';
  let edited = before;
  for (let h = 0; h < 16; h++) edited = edited.replace(`  // h${h}\n`, `  // h${h}\n  function k${h}(${Array.from({ length: N }, (_, i) => 'p' + i).join(', ')}) {}\n`);
  return { before, edited, file: 'src/a.js', label: `16 x ${N} params` };
}

const shape = (r) => (Array.isArray(r) ? (r.capped ? 'capped' : r.unchecked ? 'unchecked' : r.uncovered ? `uncovered ${JSON.stringify(r.uncovered.text)}@${r.uncovered.at}` : r.unmutated_ref ? 'unmutated_ref' : `${r.length} mutants`) : String(r));

console.log(`load ${L.fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}`);
console.log('case      fixture                                              editMutants cur / fix     uncoveredToken cur / fix   result');
for (const which of CASES) {
  if (which.startsWith('py')) L.pyPath();
  const dirs = { cur: copy([]), fix: copy(PATCHES[which]) };
  const fns = Object.fromEntries(Object.entries(dirs).map(([k, d]) => [k, require(L.path.join(d, 'src/rl/bug-injector')).editMutants]));
  const sizes = which === 'py-tuple' ? LINES : which === 'py-semi' ? KB : [N];
  for (const size of sizes) {
    const f = fixture(which, size);
    const t = { cur: [], fix: [] }, u = { cur: [], fix: [] }, res = {};
    for (let i = 0; i < REPS; i++) {
      for (const k of ['cur', 'fix']) {
        globalThis.UT = 0;
        const t0 = performance.now();
        res[k] = fns[k](f.edited, { file: f.file, before: f.before, max: 3 });
        t[k].push(performance.now() - t0); u[k].push(globalThis.UT);
      }
    }
    const [tc, tf, uc, uf] = [L.median(t.cur), L.median(t.fix), L.median(u.cur), L.median(u.fix)];
    console.log(`${which.padEnd(9)} ${f.label.padEnd(52)} ${L.ms(tc).padStart(9)} / ${L.ms(tf).padEnd(9)}   ${L.ms(uc).padStart(9)} / ${L.ms(uf).padEnd(9)}  ${shape(res.cur)}`);
    L.check(`${which} ${size}: same result as the bounded copy`, shape(res.cur) === shape(res.fix), `${shape(res.cur)} vs ${shape(res.fix)}`);
    L.check(`${which} ${size}: uncoveredToken within 2x / 500 ms of the bounded scan`, !(uc > 2 * uf && uc - uf > 500), `${Math.round(uc)} vs ${Math.round(uf)} ms`);
  }
  for (const d of Object.values(dirs)) L.rm(d);
}
L.finish();
