'use strict';

// Change hunks between two versions of a source file: a line-level diff of
// the changed region, then a token-level diff inside each hunk, comments
// ignored. A hunk's `ranges` are the inserted/changed tokens in `after`;
// `deleted` the removed tokens in `before`. A hunk with no inserted token is
// a deletion: there is nothing in `after` to mutate.

const { stripCode } = require('../validation/polyglot-ast');

const MAX_CELLS = 4e6;
const JS_TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|===|!==|\*\*=?|>>>=?|<<=?|>>=?|&&=?|\|\|=?|\?\?=?|\?\.|=>|\.\.\.|\+\+|--|[-+*/%&|^!<>=]=?|\S/g;
const PY_TOKEN = /[A-Za-z_]\w*|\d[\w.]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\*\*=?|\/\/=?|<<=?|>>=?|->|[-+*/%&|^!<>=:]=?|\S/g;

const langOf = (file) => (/\.py$/i.test(file || '') ? 'python' : 'javascript');

// Matched index pairs of a longest common subsequence, or null over the cap.
function lcs(a, b) {
  const n = a.length, m = b.length;
  if (n * m > MAX_CELLS) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return out;
}

// Lines of code[lo, hi) -> [{ s, e, key }] (absolute offsets).
function linesOf(code, lo, hi, lang) {
  const out = [];
  for (let s = lo; s < hi;) {
    let e = code.indexOf('\n', s);
    if (e < 0 || e > hi) e = hi;
    const text = code.slice(s, e);
    const key = lang === 'python' && text.trim() ? text.match(/^[ \t]*/)[0] + text.trim().replace(/\s+/g, ' ') : text.trim().replace(/\s+/g, ' ');
    out.push({ s, e, key });
    s = e + 1;
  }
  return out;
}

// Tokens of code[lo, hi); Python lines get a leading indentation token.
function tokensOf(code, lo, hi, lang) {
  const re = new RegExp((lang === 'python' ? PY_TOKEN : JS_TOKEN).source, 'g');
  const text = code.slice(lo, hi);
  const out = [];
  if (lang === 'python') {
    for (const m of text.matchAll(/^([ \t]*)(?=\S)/gm)) out.push({ v: `\u0001${m[1].length}`, s: lo + m.index, e: lo + m.index + m[1].length });
  }
  let m;
  while ((m = re.exec(text))) out.push({ v: m[0], s: lo + m.index, e: lo + m.index + m[0].length });
  return out.sort((x, y) => x.s - y.s);
}

// Common leading/trailing tokens are matched first (they are part of some
// LCS), so a small change in a long line costs a diff of the change only.
function tokenHunk(bc, ac, b, a, lang) {
  const bt = b.length ? tokensOf(bc, b[0].s, b[b.length - 1].e, lang) : [];
  const at = a.length ? tokensOf(ac, a[0].s, a[a.length - 1].e, lang) : [];
  let p = 0, q = 0;
  while (p < bt.length && p < at.length && bt[p].v === at[p].v) p++;
  while (q < bt.length - p && q < at.length - p && bt[bt.length - 1 - q].v === at[at.length - 1 - q].v) q++;
  const bm = bt.slice(p, bt.length - q), am = at.slice(p, at.length - q);
  const mid = lcs(bm.map(t => t.v), am.map(t => t.v));
  const pairs = mid || [];
  const mb = new Set(pairs.map(x => x[0])), ma = new Set(pairs.map(x => x[1]));
  const ranges = am.filter((t, j) => !ma.has(j)).map(t => [t.s, t.e]);
  const deleted = bm.filter((t, i) => !mb.has(i)).map(t => [t.s, t.e]);
  if (!ranges.length && !deleted.length) return null;
  const point = a.length ? a[0].s : null;
  const h = {
    start: ranges.length ? ranges[0][0] : point,
    end: ranges.length ? ranges[ranges.length - 1][1] : point,
    ranges,
    deleted,
    deletion: !ranges.length
  };
  if (!mid) h.capped = true;
  return h;
}

// Line number of offset i in s; offsets must not decrease between calls.
function lineCounter(s) {
  let at = 0, n = 1;
  return (i) => {
    for (let k = s.indexOf('\n', at); k >= 0 && k < i; k = s.indexOf('\n', k + 1)) { n++; at = k + 1; }
    return n;
  };
}

// -> [{ start, end, ranges, deleted, deletion, line, capped? }] in source
// order; `capped` marks a hunk whose diff was over MAX_CELLS (every token in
// it counts as changed).
function changeHunks(before, after, file) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return [];
  const lang = langOf(file);
  const max = Math.min(before.length, after.length);
  let pre = 0;
  while (pre < max && before[pre] === after[pre]) pre++;
  pre = before.lastIndexOf('\n', pre - 1) + 1;
  let suf = 0;
  while (suf < max - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  // Common suffix back to a line start.
  while (suf > 0 && before[before.length - suf - 1] !== '\n') suf--;
  const bc = stripCode(before, lang, { keepStrings: true }), ac = stripCode(after, lang, { keepStrings: true });
  const bl = linesOf(bc, pre, before.length - suf, lang), al = linesOf(ac, pre, after.length - suf, lang);
  const lined = lcs(bl.map(l => l.key), al.map(l => l.key));
  const pairs = lined || [];
  pairs.push([bl.length, al.length]);
  const out = [];
  const lineAt = lineCounter(after);
  let i = 0, j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      const h = tokenHunk(bc, ac, bl.slice(i, pi), al.slice(j, pj), lang);
      if (h) {
        if (h.start === null) h.start = h.end = pj < al.length ? al[pj].s : after.length - suf;
        h.line = lineAt(h.start);
        if (!lined) h.capped = true;
        out.push(h);
      }
    }
    i = pi + 1; j = pj + 1;
  }
  return out;
}

module.exports = { changeHunks };
