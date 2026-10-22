#!/usr/bin/env node
'use strict';

// AUDIT-33: separator work in bug-injector uncoveredToken (`structural()`,
// `splits()`, `fresh()`) on separator-heavy edits that stay under the
// 16-hunk / 32,000-char / 12-site caps, so editMutants does reach
// uncoveredToken. Each case times editMutants on the current src and on a
// copy of the current src with one bounded rewrite of the scan, and checks
// both give the same result.
//
//   js-semi   add `;` to every statement of 16 hunks of a semicolon-less
//             file (a "add missing semicolons" refactor). For every inserted
//             `;` structural() runs /\b(?:else|do)$/ on code.slice(0, p + 1):
//             the whole prefix of the file. Fix: test a 16-char tail.
//   py-semi   K `; pass` inserted after the closing bracket of a module-level
//             literal of L lines. SG41's logical-line walk goes back line by
//             line to the literal's first line for every `;`. Fix: memoise
//             the walk per physical line start.
//   js-comma  16 hunks each inserting one function with a long parameter
//             list. SG41's splits() calls fresh() for the tokens around each
//             `,`; fresh() starts its inserted-range cursor at 0, so each
//             call is O(inserted ranges). Fix: binary-search the cursor.
//
// FINDING when the current code is more than 2x and 500 ms slower than the
// bounded copy on a case (same result required).
//
// usage: node audit/33/sep-scale.js [--cases js-semi,py-semi,js-comma] [--kb 100,500,2000] [--reps 2] [--k 1500]

const L = require('../29/lib');

const CASES = L.list('--cases', 'js-semi,py-semi,js-comma');
const KB = L.nums('--kb', '100,500,2000');
const REPS = Number(L.opt('--reps', 2));
const PYK = Number(L.opt('--k', 1500)); // py-semi: `; pass` count on the closing line

const PATCHES = {
  'js-semi': [
    "if (/\\b(?:else|do)$/.test(code.slice(0, p + 1))) return true;",
    "if (/\\b(?:else|do)$/.test(code.slice(Math.max(0, p - 15), p + 1))) return true;"
  ],
  'py-semi': [
    "let s = code.lastIndexOf('\\n', a - 1) + 1;\n      while (s > 0 && depth.get(s)) s = code.lastIndexOf('\\n', s - 2) + 1;",
    "let s = code.lastIndexOf('\\n', a - 1) + 1; const s0 = s; LLS = LLS || new Map();\n      if (LLS.has(s0)) s = LLS.get(s0); else { while (s > 0 && depth.get(s)) s = code.lastIndexOf('\\n', s - 2) + 1; LLS.set(s0, s); }"
  ],
  'js-comma': [
    'for (let c = a, i = 0; c < b; c++) {',
    'let i = 0; for (let h = ins.length; i < h;) { const m = (i + h) >> 1; if (ins[m][1] <= a) i = m + 1; else h = m; }\n    for (let c = a; c < b; c++) {'
  ]
};

function bounded(which) {
  const dir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a33-src-'));
  L.fs.cpSync(L.path.join(L.REPO_ROOT, 'src'), L.path.join(dir, 'src'), { recursive: true });
  L.fs.symlinkSync(L.path.join(L.REPO_ROOT, 'node_modules'), L.path.join(dir, 'node_modules'));
  const f = L.path.join(dir, 'src/rl/bug-injector.js');
  let text = L.fs.readFileSync(f, 'utf8');
  const [from, to] = PATCHES[which];
  if (!text.includes(from)) throw new Error(`patch for ${which} does not apply`);
  text = text.replace(from, to);
  if (which === 'py-semi') text = text.replace('function uncoveredToken(', 'let LLS;\nfunction uncoveredToken(').replace("const code = view.code, pair = new Map()", "LLS = null; const code = view.code, pair = new Map()");
  L.fs.writeFileSync(f, text);
  return dir;
}

function filler(lang, kb, semi) {
  const out = [];
  let size = 0;
  for (let i = 0; size < kb * 1024; i++) {
    const f = lang === 'js'
      ? `function f${i}(a, b) {\n  const t = [a, b, ${i}]${semi}\n  return t[0] + t[1] * ${i}${semi}\n}\n`
      : `def f${i}(a, b):\n    t = [a, b, ${i}]\n    return t[0] + t[1] * ${i}\n\n`;
    out.push(f);
    size += f.length;
  }
  return out.join('');
}

function fixture(which, kb) {
  if (which === 'js-semi') {
    // 16 hunks x 120 statements (the line diff caps at ~2,000 changed lines), each gains a `;`.
    const head = filler('js', kb, '');
    const b = ['function g(a) {', '  let e = a'], e = ['function g(a) {', '  let e = a'];
    for (let h = 0; h < 16; h++) {
      b.push(`  // h${h}`); e.push(`  // h${h}`);
      for (let k = 0; k < 120; k++) { b.push('  e = e + a'); e.push('  e = e + a;'); }
    }
    b.push('  return e', '}', 'module.exports = { g }'); e.push('  return e', '}', 'module.exports = { g }');
    return { before: head + b.join('\n') + '\n', edited: head + e.join('\n') + '\n', file: 'src/big.js', seps: 16 * 120 };
  }
  if (which === 'py-semi') {
    // A module-level literal of L lines (half the file), then K `; pass` on its closing line.
    const head = filler('py', kb / 2, '');
    const lines = [];
    let size = 0;
    for (let i = 0; size < kb * 512; i++) { const l = `    ${i},`; lines.push(l); size += l.length + 1; }
    const K = PYK;
    const lit = `DATA = [\n${lines.join('\n')}\n]`;
    return { before: head + lit + '\n', edited: head + lit + '; pass'.repeat(K) + '\n', file: 'pkg/big.py', seps: K, lines: lines.length };
  }
  // js-comma: 16 hunks, each one inserted function of 400 parameters (under 32,000 changed chars).
  const head = filler('js', kb, ';');
  const b = ['function g(a) {', '  let e = a;'], e = [...b];
  for (let h = 0; h < 16; h++) {
    b.push(`  // h${h}`, '  e = e + a;');
    e.push(`  // h${h}`, `  function h${h}(${Array.from({ length: 400 }, (_, i) => `p${i}`).join(', ')}) {}`, '  e = e + a;');
  }
  b.push('  return e;', '}', 'module.exports = { g };'); e.push('  return e;', '}', 'module.exports = { g };');
  return { before: head + b.join('\n') + '\n', edited: head + e.join('\n') + '\n', file: 'src/big.js', seps: 16 * 399 };
}

const shape = (r) => (Array.isArray(r) ? (r.capped ? 'capped' : r.unchecked ? 'unchecked' : r.uncovered ? `uncovered ${JSON.stringify(r.uncovered.text)}` : r.unmutated_ref ? 'unmutated_ref' : `${r.length} mutants`) : String(r));
const strip = (r) => JSON.stringify({ shape: shape(r), m: Array.isArray(r) ? r.map(m => [m.mutation, m.site, m.span]) : null });

const cur = require(L.src('rl/bug-injector')).editMutants;
console.log('case      size     seps    current     bounded     cur/bounded   result');
for (const which of CASES) {
  if (which === 'py-semi') L.pyPath();
  const dir = bounded(which);
  const fixed = require(L.path.join(dir, 'src/rl/bug-injector')).editMutants;
  for (const kb of KB) {
    const f = fixture(which, kb);
    const t = { cur: [], fix: [] }, res = {};
    for (let i = 0; i < REPS; i++) {
      for (const [k, fn] of [['cur', cur], ['fix', fixed]]) {
        const t0 = performance.now();
        res[k] = fn(f.edited, { file: f.file, before: f.before, max: 3 });
        t[k].push(performance.now() - t0);
      }
    }
    const c = L.median(t.cur), o = L.median(t.fix);
    console.log(`${which.padEnd(9)} ${String(Math.round(f.edited.length / 1024)).padStart(5)} KB ${String(f.seps).padStart(6)}  ${L.ms(c).padEnd(11)} ${L.ms(o).padEnd(11)} ${(c / o).toFixed(2).padStart(6)}        ${shape(res.cur)}${f.lines ? ` (literal ${f.lines} lines)` : ''}`);
    L.check(`${which} ${kb} KB: same result as the bounded copy`, strip(res.cur) === strip(res.fix), `${shape(res.cur)} vs ${shape(res.fix)}`);
    L.check(`${which} ${kb} KB: editMutants within 2x / 500 ms of the bounded scan`, !(c > 2 * o && c - o > 500), `${Math.round(c)} vs ${Math.round(o)} ms`);
  }
  L.rm(dir);
}
L.finish();
