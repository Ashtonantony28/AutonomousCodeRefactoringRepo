'use strict';

// Change hunks between two versions of a source file: a line-level diff of
// the changed region, then a token-level diff inside each hunk, comments
// ignored. A hunk's `ranges` are the inserted/changed tokens in `after`;
// `deleted` the removed tokens in `before`; `gaps` the same tokens grouped by
// the stretch between two matched tokens they fall in ({ ins, del }). A hunk
// with no inserted token is a deletion: there is nothing in `after` to mutate.
// Every literal comes from `lexView`: a string is one token, a template
// literal or f-string is its text parts (each with its delimiters) and the
// tokens of its interpolations, a JS regex literal is its delimiters, body
// atoms and flags. Strings and numbers compare by value when only their
// spelling differs ('a' / "a", 120 / 0x78): a respelled literal is no change.
// A numeric token with no computable value (`0x1e+6000`, `6e3.toFixed`)
// compares by its text.

const MAX_CELLS = 4e6;
const NUM = String.raw`(?:\d|\.\d)(?:[\w.]|(?<=\d[eE])[+-])*`;
const JS_TOKEN = new RegExp(String.raw`[A-Za-z_$][\w$]*|${NUM}` +
  String.raw`|===|!==|\*\*=?|>>>=?|<<=?|>>=?|&&=?|\|\|=?|\?\?=?|\?\.|=>|\.\.\.|\+\+|--|[-+*/%&|^!<>=]=?|\S`, 'g');
const PY_TOKEN = new RegExp(String.raw`[A-Za-z_]\w*|${NUM}` +
  String.raw`|\*\*=?|\/\/=?|<<=?|>>=?|->|[-+*/%&|^!<>=:]=?|\S`, 'g');
const REGEX_ATOM = /\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|c[A-Za-z]|[pPk]\{[^}]*\}|k<[^>]*>|[\s\S])|\(\?(?:[:=!]|<[=!]|<[\w$]+>)|\{\d+(?:,\d*)?\}\??|[*+?]\?|[\s\S]/g;
const BEFORE_REGEX = new Set('return typeof instanceof in of new delete void throw case do else yield await'.split(' '));

const langOf = (file) => (/\.py$/i.test(file || '') ? 'python' : 'javascript');

// Comments, strings, template literals / f-strings and JS regex literals of
// src. -> { kept: src with comments blanked, code: kept with literal text
// (string contents, template/f-string text, regex bodies) blanked, lits }.
// lits: { kind: 'string' | 'template' | 'fstring' | 'regex', s, e }, with
// `parts` ([s, e, textStart, textEnd]) and `holes` ([s, e]) for templates
// and f-strings, `body`, `atoms` and `flags` ([s, e]) for regexes; nested
// literals are entries of their own.
function lexView(src, lang) {
  const n = src.length;
  const kept = src.split(''), code = src.split('');
  const lits = [];
  const blank = (arr, a, b) => { for (let k = a; k < b && k < n; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  const comment = (i, j) => { blank(kept, i, j); blank(code, i, j); return j; };
  const eol = (i) => { const j = src.indexOf('\n', i); return j < 0 ? n : j; };
  const isWord = (c) => /[\w$]/.test(c) || c > '\x7f';

  function regex(i) {
    let j = i + 1, cls = false;
    for (; j < n; j++) {
      const c = src[j];
      if (c === '\n') return 0;
      if (c === '\\') j++;
      else if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) break;
    }
    if (j >= n || j === i + 1) return 0;
    let f = j + 1;
    while (f < n && /[a-z]/i.test(src[f])) f++;
    const atoms = [];
    for (const m of src.slice(i + 1, j).matchAll(REGEX_ATOM)) atoms.push([i + 1 + m.index, i + 1 + m.index + m[0].length]);
    const flags = [];
    for (let k = j + 1; k < f; k++) flags.push([k, k + 1]);
    lits.push({ kind: 'regex', s: i, e: f, body: [i + 1, j], atoms, flags });
    blank(code, i + 1, j);
    return f;
  }

  function template(i) {
    const t = { kind: 'template', s: i, parts: [], holes: [] };
    lits.push(t);
    let ps = i, j = i + 1;
    const part = (pe, te) => { t.parts.push([ps, pe, ps + 1, te]); blank(code, ps + 1, te); };
    while (j < n) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') { part(j + 1, j); return (t.e = j + 1); } else if (src[j] === '$' && src[j + 1] === '{') {
        part(j + 2, j);
        const he = jsLex(j + 2, true);
        t.holes.push([j + 2, he]);
        ps = he;
        j = he + 1;
      } else j++;
    }
    part(n, n);
    return (t.e = n);
  }

  function jsLex(i, hole) {
    let depth = 0, value = false;
    for (let last = -1; i < n;) {
      if (i <= last) { i = last + 1; continue; }
      last = i;
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = comment(i, eol(i)); continue; }
      if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = comment(i, j < 0 ? n : j + 2); continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        const e = Math.min(n, j + 1);
        lits.push({ kind: 'string', s: i, e });
        blank(code, i + 1, j);
        i = e; value = true;
        continue;
      }
      if (c === '`') { i = template(i); value = true; continue; }
      if (c === '/' && !value) { const e = regex(i); if (e) { i = e; value = true; continue; } }
      if (isWord(c)) {
        let j = i;
        while (j < n && isWord(src[j])) j++;
        value = !BEFORE_REGEX.has(src.slice(i, j));
        i = j;
        continue;
      }
      if ((c === '+' || c === '-') && src[i + 1] === c) { i += 2; continue; }
      if (hole && c === '{') depth++;
      else if (hole && c === '}') { if (!depth) return i; depth--; }
      if (!/\s/.test(c)) value = c === ')' || c === ']' || c === '}';
      i++;
    }
    return i;
  }

  function pyString(i, plen, q) {
    let j = i + plen + q.length;
    while (j < n && !src.startsWith(q, j) && !(q.length === 1 && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
    const e = Math.min(n, src.startsWith(q, j) ? j + q.length : j);
    lits.push({ kind: 'string', s: i, e });
    blank(code, i + plen + q.length, j);
    return e;
  }

  function fString(i, plen, q) {
    const t = { kind: 'fstring', s: i, q: i + plen, parts: [], holes: [] };
    lits.push(t);
    let ps = i, ts = i + plen + q.length, j = ts, field = 0;
    const part = (pe, te) => { t.parts.push([ps, pe, ts, te]); blank(code, ts, te); };
    while (j < n) {
      if (!field && src.startsWith(q, j)) { part(j + q.length, j); return (t.e = j + q.length); }
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (q.length === 1 && c === '\n') break;
      if (c === '{' && !field && src[j + 1] === '{') { j += 2; continue; }
      if (c === '{') {
        part(j + 1, j);
        const he = pyLex(j + 1, true);
        t.holes.push([j + 1, he]);
        if (src[he] !== '}') field++;
        ps = he; ts = he + 1; j = he + 1;
        continue;
      }
      if (c === '}' && field) field--;
      else if (c === '}' && src[j + 1] === '}') j++;
      j++;
    }
    part(j, j);
    return (t.e = j);
  }

  function pyLex(i, hole) {
    let depth = 0;
    for (let last = -1; i < n;) {
      if (i <= last) { i = last + 1; continue; }
      last = i;
      const c = src[i];
      if (c === '#') { i = comment(i, eol(i)); continue; }
      if (isWord(c) || c === '"' || c === "'") {
        // A quote right after a word (`return"x"`) opens a string too.
        const m = (i === 0 || !isWord(src[i - 1]) || !isWord(c)) && /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
        if (m) { i = /f/i.test(m[1]) ? fString(i, m[1].length, m[2]) : pyString(i, m[1].length, m[2]); continue; }
        while (i < n && isWord(src[i])) i++;
        continue;
      }
      if (hole) {
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) { if (!depth && c === '}') return i; depth--; } else if (!depth && (c === ':' || (c === '!' && src[i + 1] !== '='))) return i;
      }
      i++;
    }
    return i;
  }

  if (lang === 'python') pyLex(0, false); else jsLex(0, false);
  return { kept: kept.join(''), code: code.join(''), lits: lits.sort((a, b) => a.s - b.s) };
}

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

// Comparison key of a token: a number's value (its text when that is NaN),
// a string's value when it has no escapes (and, in Python, no `f` prefix), else its text.
function valueKey(t, lang) {
  if (/^\.?\d/.test(t)) {
    const n = t.replace(/_/g, '');
    try {
      if (lang !== 'python') return /n$/.test(n) ? `\u0005${BigInt(n.slice(0, -1))}n` : /^0\d/.test(n) ? t : Number.isNaN(Number(n)) ? t : `\u0005${Number(n)}`;
      if (/^(?:0[xob][\da-f]+|\d+)$/i.test(n)) return `\u0005${BigInt(n)}`;
      return Number.isNaN(Number(n)) ? t : `\u0005${Number(n)}.0`;
    } catch { return t; }
  }
  const m = /^([rRbBuU]{0,2})('''|"""|'|")([^\\]*)\2$/.exec(t);
  return m && (lang === 'python' || (!m[1] && m[2].length === 1)) ? `\u0004${/b/i.test(m[1]) ? 'b' : ''}${m[3]}` : t;
}

// Tokens of v.kept[lo, hi) (v: a lexView with `at`, its literals by start);
// Python lines that start outside a literal get a leading indentation token.
// Regex atoms and flags are marked apart from code tokens of the same text.
function tokensOf(v, lo, hi, lang) {
  const code = v.kept;
  const re = new RegExp((lang === 'python' ? PY_TOKEN : JS_TOKEN).source, 'g');
  const out = [];
  if (lang === 'python') {
    let k = 0, reach = 0;
    for (const m of code.slice(lo, hi).matchAll(/^([ \t]*)(?=\S)/gm)) {
      const at = lo + m.index;
      for (; k < v.lits.length && v.lits[k].s < at; k++) reach = Math.max(reach, v.lits[k].e);
      if (at >= reach) out.push({ v: `\u0001${m[1].length}`, s: at, e: at + m[1].length });
    }
  }
  const push = (s, e, mark = '') => { if (s >= lo && s < hi) out.push({ v: mark + code.slice(s, Math.min(e, hi)), s, e: Math.min(e, hi) }); };
  const value = (s, e) => { if (s >= lo && s < hi) out.push({ v: e > hi ? code.slice(s, hi) : valueKey(code.slice(s, e), lang), s, e: Math.min(e, hi) }); };
  re.lastIndex = lo;
  let m;
  while ((m = re.exec(code)) && m.index < hi) {
    const lit = v.at.get(m.index);
    if (!lit) { value(m.index, m.index + m[0].length); continue; }
    if (lit.kind === 'string') value(lit.s, lit.e);
    else if (lit.kind === 'regex') {
      push(lit.s, lit.s + 1);
      for (const [a, b] of lit.atoms) push(a, b, '\u0002');
      push(lit.body[1], lit.body[1] + 1);
      for (const [a, b] of lit.flags) push(a, b, '\u0003');
    } else {
      lit.parts.forEach(([a, b], k) => {
        push(a, b);
        if (lit.holes[k]) out.push(...tokensOf(v, Math.max(lo, lit.holes[k][0]), Math.min(hi, lit.holes[k][1]), lang).filter(t => !/^\u0001/.test(t.v)));
      });
    }
    re.lastIndex = lit.e;
  }
  return out.sort((x, y) => x.s - y.s);
}

// lexView of src plus `at`: its literals by start.
function viewOf(src, lang) {
  const v = lexView(src, lang);
  v.at = new Map(v.lits.map(l => [l.s, l]));
  return v;
}

// A run of tokens only one side has (side 1: after, 0: before) between two
// matched tokens moves to the leftmost equivalent place where it is
// bracket-balanced and starts with an operator or separator, else the
// leftmost balanced one (else the rightmost): `.f(x)` inserted, not
// `f(x).`; `, g(y)`, not `g(y),`. pairs: matched index pairs, updated in place.
function slide(pairs, toks, side) {
  const joins = (k) => !/^[\w$'"`([{\u0001-\u0005]/.test(toks[k].v);
  const balanced = (u, v) => {
    let d = 0;
    for (let k = u; k < v; k++) { const c = toks[k].v; d += '([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0; if (d < 0) return false; }
    return !d;
  };
  for (let k = 0; k + 1 < pairs.length; k++) {
    let u = pairs[k][side] + 1, v = pairs[k + 1][side];
    if (v <= u || pairs[k + 1][1 - side] !== pairs[k][1 - side] + 1) continue;
    // Right as far as it goes, then back left.
    while (k + 2 < pairs.length && toks[u].v === toks[v].v && pairs[k + 2][side] === v + 1 && pairs[k + 2][1 - side] === pairs[k + 1][1 - side] + 1) {
      pairs[k + 1][side] = u;
      u++; v++; k++;
    }
    let best = 0, join = balanced(u, v) && joins(u) ? 0 : -1;
    for (let d = 1; k - d + 1 >= 0; d++) {
      const pk = pairs[k - d + 1];
      if (pk[side] !== u - d || (d > 1 && pairs[k - d + 2][1 - side] !== pk[1 - side] + 1) || toks[u - d].v !== toks[v - d].v) break;
      if (balanced(u - d, v - d)) { best = d; if (joins(u - d)) join = d; }
    }
    if (join >= 0) best = join;
    for (let d = 1; d <= best; d++) pairs[k - d + 1][side] = v - d;
  }
}

// Tokens of the whole file (once per view) that overlap the lines: a line
// inside or closing a literal gets the literal's own tokens.
function lineTokens(v, lines, lang) {
  if (!lines.length) return [];
  const t = v.toks || (v.toks = tokensOf(v, 0, v.kept.length, lang));
  const lo = lines[0].s, hi = lines[lines.length - 1].e;
  let a = 0, b = t.length;
  while (a < b) { const mid = (a + b) >> 1; if (t[mid].e > lo || t[mid].s >= lo) b = mid; else a = mid + 1; }
  let z = a;
  while (z < t.length && t[z].s < hi) z++;
  return t.slice(a, z);
}

// Common leading/trailing tokens are matched first (they are part of some
// LCS), so a small change in a long line costs a diff of the change only.
function tokenHunk(bv, av, b, a, lang) {
  const bt = lineTokens(bv, b, lang);
  const at = lineTokens(av, a, lang);
  let p = 0, q = 0;
  while (p < bt.length && p < at.length && bt[p].v === at[p].v) p++;
  while (q < bt.length - p && q < at.length - p && bt[bt.length - 1 - q].v === at[at.length - 1 - q].v) q++;
  const bm = bt.slice(p, bt.length - q), am = at.slice(p, at.length - q);
  const mid = lcs(bm.map(t => t.v), am.map(t => t.v));
  const pairs = [];
  for (let k = 0; k < p; k++) pairs.push([k, k]);
  for (const [x, y] of mid || []) pairs.push([x + p, y + p]);
  for (let k = q; k > 0; k--) pairs.push([bt.length - k, at.length - k]);
  slide(pairs, at, 1);
  slide(pairs, bt, 0);
  const mb = new Set(pairs.map(x => x[0])), ma = new Set(pairs.map(x => x[1]));
  const ranges = at.filter((t, j) => !ma.has(j)).map(t => [t.s, t.e]);
  const deleted = bt.filter((t, i) => !mb.has(i)).map(t => [t.s, t.e]);
  if (!ranges.length && !deleted.length) return null;
  const gaps = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [bt.length, at.length]]) {
    if (pi > i || pj > j) gaps.push({ ins: at.slice(j, pj).map(t => [t.s, t.e]), del: bt.slice(i, pi).map(t => [t.s, t.e]) });
    i = pi + 1; j = pj + 1;
  }
  const point = a.length ? a[0].s : null;
  const h = {
    start: ranges.length ? ranges[0][0] : point,
    end: ranges.length ? ranges[ranges.length - 1][1] : point,
    ranges,
    deleted,
    gaps,
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

// -> [{ start, end, ranges, deleted, gaps, deletion, line, capped? }] in source
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
  const bv = viewOf(before, lang), av = viewOf(after, lang);
  const bc = bv.kept, ac = av.kept;
  const bl = linesOf(bc, pre, before.length - suf, lang), al = linesOf(ac, pre, after.length - suf, lang);
  const lined = lcs(bl.map(l => l.key), al.map(l => l.key));
  const pairs = lined || [];
  pairs.push([bl.length, al.length]);
  const out = [];
  const lineAt = lineCounter(after);
  let i = 0, j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      const h = tokenHunk(bv, av, bl.slice(i, pi), al.slice(j, pj), lang);
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

module.exports = { changeHunks, lexView };
