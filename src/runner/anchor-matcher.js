'use strict';

// Aider-style 4-tier anchor matching for SEARCH/REPLACE edits.
// Tiers, tried in order; each must find exactly one location or the
// whole match fails (an ambiguous tier never falls through):
//   1. exact          — byte-identical substring search
//   2. indent-shift   — the anchor's lines appear verbatim under a different
//                       leading-whitespace prefix (spaces or tabs)
//   3. whitespace     — collapse all runs of whitespace to single spaces
//                       on both sides; map back to original byte ranges
//   4. fuzzy          — line-window similarity (bounded Levenshtein over
//                       collapsed text); accepted only when the window is
//                       token-identical to the anchor and no other window
//                       scores within `ambiguityMargin` of it; work-capped
//                       (`fuzzy_budget`)
// Whitespace and fuzzy matches are refused when the whitespace they ignore
// is significant in the region (see regionHazard).
//
// Returns { tier, start, end, ... } on success, throws AnchorError on
// failure with a descriptive reason and `detail` (so the orchestrator can
// fold it into failure_class / apply_failed).

class AnchorError extends Error {
  constructor(message, { tier, detail } = {}) {
    super(message);
    this.tier = tier;
    this.detail = detail;
  }
}

function isWs(code) {
  return code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));
}

function allIndexes(haystack, needle, limit = Infinity) {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1 && out.length < limit) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

const MAX_OCCURRENCES = 100;

function exactMatch(haystack, needle) {
  const idxs = allIndexes(haystack, needle, MAX_OCCURRENCES);
  if (!idxs.length) return null;
  if (idxs.length > 1) return { ambiguous: true, count: idxs.length };
  return { start: idxs[0], end: idxs[0] + needle.length };
}

// The needle is trimmed, so the matched range never swallows surrounding
// newlines/indentation: it starts and ends on non-whitespace characters.
function whitespaceMatch(haystack, needle) {
  const trimmed = needle.trim();
  if (!trimmed) return null;
  const H = haystack.replace(/\s+/g, ' ');
  const N = trimmed.replace(/\s+/g, ' ');
  const idxs = allIndexes(H, N, MAX_OCCURRENCES);
  if (!idxs.length) return null;
  if (idxs.length > 1) return { ambiguous: true, count: idxs.length };
  // Walk the original once to map collapsed offsets back to source offsets
  // (same mapping as collapseWithMap, without materializing it).
  const want0 = idxs[0];
  const want1 = idxs[0] + N.length - 1;
  let start = -1;
  let c = 0;
  let i = 0;
  while (i < haystack.length) {
    if (c === want0) start = i;
    if (c === want1) return { start, end: i + 1 };
    if (isWs(haystack.charCodeAt(i))) {
      while (i < haystack.length && isWs(haystack.charCodeAt(i))) i++;
    } else {
      i++;
    }
    c++;
  }
  return null;
}

function leadingWs(line) {
  return /^[ \t]*/.exec(line)[0];
}

function isBlank(line) {
  return !line.trim();
}

function commonIndentString(lines) {
  let common = null;
  for (const l of lines) {
    if (isBlank(l)) continue;
    const ws = leadingWs(l);
    if (common === null) { common = ws; continue; }
    let k = 0;
    while (k < common.length && k < ws.length && common[k] === ws[k]) k++;
    common = common.slice(0, k);
    if (!common) break;
  }
  return common || '';
}

// Back-compat numeric helper: smallest leading-whitespace width.
function commonLeftIndent(text) {
  return commonIndentString(text.split('\n')).length;
}

// Replace the leading `from` prefix of every non-blank line with `to`.
// Lines that do not carry the full prefix lose whatever leading
// whitespace they have and get `to`.
function shiftIndent(text, from, to) {
  if (from === to) return text;
  return text.split('\n').map((l) => {
    if (isBlank(l)) return l.length ? '' : l;
    const rest = l.startsWith(from) ? l.slice(from.length) : l.slice(leadingWs(l).length);
    return to + rest;
  }).join('\n');
}

function lineOffsets(lines) {
  const offs = new Array(lines.length);
  let o = 0;
  for (let i = 0; i < lines.length; i++) {
    offs[i] = o;
    o += lines[i].length + 1;
  }
  return offs;
}

// Start lines where the anchor's lines before its last one appear with
// only their leading whitespace changed (KMP over line keys), so the
// per-start check below runs only where it can succeed.
function* indentShiftStarts(hLines, nLines, L) {
  if (L < 1) { for (let i = 0; i < hLines.length; i++) yield i; return; }
  const key = (l) => l.trimStart();
  const ids = new Map();
  const pat = new Int32Array(L);
  for (let k = 0; k < L; k++) {
    const kk = key(nLines[k]);
    if (!ids.has(kk)) ids.set(kk, ids.size);
    pat[k] = ids.get(kk);
  }
  const fail = new Int32Array(L);
  for (let k = 1, q = 0; k < L; k++) {
    while (q && pat[k] !== pat[q]) q = fail[q - 1];
    if (pat[k] === pat[q]) q++;
    fail[k] = q;
  }
  for (let i = 0, q = 0; i < hLines.length; i++) {
    const id = ids.get(key(hLines[i]));
    const c = id === undefined ? -1 : id;
    while (q && c !== pat[q]) q = fail[q - 1];
    if (c === pat[q]) q++;
    if (q === L) { yield i - L + 1; q = fail[q - 1]; }
  }
}

// Find every location where the anchor's lines appear with their common
// leading whitespace replaced by some other whitespace string P (tabs or
// spaces). Matches start at a line boundary. More than one location —
// whether from the same P or different ones — is ambiguous.
function indentShiftMatch(haystack, needle) {
  const nLines = needle.split('\n');
  if (isBlank(nLines[0])) return null;
  const C = commonIndentString(nLines);
  const dl = nLines.map((l) => (isBlank(l) ? '' : l.slice(C.length)));
  const L = nLines.length - 1;
  const trailingEmpty = L > 0 && nLines[L] === '';
  const first = dl[0];
  const hLines = haystack.split('\n');
  const offs = lineOffsets(hLines);
  const found = [];
  for (const i of indentShiftStarts(hLines, nLines, L)) {
    const h = hLines[i];
    if (!h.endsWith(first)) continue;
    const P = h.slice(0, h.length - first.length);
    if (!/^[ \t]*$/.test(P)) continue;
    let ok = true;
    let end = offs[i] + h.length;
    for (let k = 1; k <= L; k++) {
      if (k === L && trailingEmpty) {
        if (i + k >= hLines.length) { ok = false; break; }
        end = offs[i + k];
        break;
      }
      const hk = hLines[i + k];
      if (hk === undefined) { ok = false; break; }
      if (isBlank(nLines[k])) {
        if (!isBlank(hk)) { ok = false; break; }
        end = offs[i + k] + hk.length;
        continue;
      }
      const want = P + dl[k];
      if (k === L ? !hk.startsWith(want) : hk !== want) { ok = false; break; }
      end = offs[i + k] + (k === L ? want.length : hk.length);
    }
    if (!ok) continue;
    found.push({ start: offs[i], end, indent: P });
  }
  if (!found.length) return null;
  if (found.length > 1) {
    return { ambiguous: true, count: found.length, deltas: [...new Set(found.map(f => f.indent.length - C.length))] };
  }
  const m = found[0];
  return { start: m.start, end: m.end, delta: m.indent.length - C.length, indent: m.indent, anchorIndent: C };
}

// Numeric shift kept for callers of the old API (spaces only).
function reindent(text, delta) {
  if (delta === 0) return text;
  if (delta > 0) return shiftIndent(text, '', ' '.repeat(delta));
  const trim = -delta;
  return text.split('\n').map((l) => {
    let k = 0;
    while (k < trim && k < l.length && l[k] === ' ') k++;
    return l.slice(k);
  }).join('\n');
}

function collapseWS(s) {
  return s.replace(/\s+/g, ' ').trim();
}

const TOKEN_RE = new RegExp([
  '[A-Za-z_$\\u00c0-\\uffff][\\w$\\u00c0-\\uffff]*',      // identifiers / keywords
  '\\d[\\w.]*',                                           // numbers
  '"(?:\\\\.|[^"\\\\\\n])*"?',                            // string literals
  "'(?:\\\\.|[^'\\\\\\n])*'?",
  '`(?:\\\\.|[^`\\\\])*`?',
  '>>>=|===|!==|\\*\\*=|<<=|>>=|>>>|\\.\\.\\.|\\?\\?=|&&=|\\|\\|=',
  '=>|==|!=|<=|>=|&&|\\|\\||\\?\\?|\\?\\.|\\+\\+|--|\\*\\*|<<|>>|->|::|//|[-+*/%&|^]=',
  '\\S'                                                   // any other punctuation
].join('|'), 'g');

function tokenize(s) {
  return s.match(TOKEN_RE) || [];
}

function tokensEqual(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false;
  return true;
}

// Levenshtein distance. With `maxDist`, only a diagonal band of width
// 2*maxDist+1 is computed and the result is capped at maxDist+1 (meaning
// "more than maxDist"), so cost is O(min(m,n) * maxDist) instead of O(m*n).
let rowA = new Int32Array(256);
let rowB = new Int32Array(256);
function levenshtein(a, b, maxDist = Infinity) {
  if (a === b) return 0;
  let m = a.length, n = b.length;
  if (m > n) { const t = a; a = b; b = t; m = a.length; n = b.length; }
  const k = Math.min(maxDist, n);
  if (n - m > k) return k + 1;
  if (m === 0) return n;
  const BIG = k + 1;
  if (rowA.length < n + 1) { rowA = new Int32Array(2 * (n + 1)); rowB = new Int32Array(2 * (n + 1)); }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= n; j++) prev[j] = j <= k ? j : BIG;
  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(n, i + k);
    cur[lo - 1] = lo - 1 === 0 ? (i <= k ? i : BIG) : BIG;
    let rowMin = cur[lo - 1];
    const ca = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = (j <= i - 1 + k ? prev[j] : BIG) + 1;
      const ins = cur[j - 1] + 1;
      let v = sub < del ? sub : del;
      if (ins < v) v = ins;
      if (v > BIG) v = BIG;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < n) cur[hi + 1] = BIG;
    if (rowMin >= BIG) return BIG;
    const t = prev; prev = cur; cur = t;
  }
  return prev[n] > BIG ? BIG : prev[n];
}

function similarity(a, b, minRatio = 0) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const max = Math.max(a.length, b.length);
  const k = Math.floor((1 - minRatio) * max);
  const lev = levenshtein(a, b, k);
  if (lev > k) return 0;
  return 1 - lev / max;
}

function charHist(s) {
  const h = new Int32Array(128);
  for (let i = 0; i < s.length; i++) h[Math.min(127, s.charCodeAt(i))]++;
  return h;
}

// Each edit changes the character multiset's L1 distance by at most 2, so
// ceil(L1/2) is a cheap lower bound on the Levenshtein distance.
const bagWork = new Int32Array(128);
function bagDistanceLowerBound(s, targetHist) {
  bagWork.set(targetHist);
  for (let i = 0; i < s.length; i++) bagWork[Math.min(127, s.charCodeAt(i))]--;
  let l1 = 0;
  for (let c = 0; c < 128; c++) l1 += bagWork[c] < 0 ? -bagWork[c] : bagWork[c];
  return Math.ceil(l1 / 2);
}

function trimBlankEdges(lines) {
  let s = 0, e = lines.length;
  while (s < e && isBlank(lines[s])) s++;
  while (e > s && isBlank(lines[e - 1])) e--;
  return lines.slice(s, e);
}

// Line-window fuzzy match. Windows of N = (non-blank-edged) anchor lines
// are scored by 1 - lev/maxLen over collapsed whitespace. Work is bounded:
// one O(n) pass keeps, per window, a q-gram count lower bound on the
// distance; only windows whose upper-bound score can still reach
// max(floor, best - margin) are scored, best bound first, identical windows
// once, with a growing band; and Levenshtein cells are capped at
// `maxCells` (-> { budget }).
// Returns:
//   null                                   nothing near the threshold
//   { below: true, closest }               best < minRatio
//   { ambiguous: true, closest, runnerUp } another non-overlapping window
//                                          within ambiguityMargin of best
//   { mismatch: true, closest }            best window not token-identical
//   { budget: true, closest, cells }       work cap hit before a decision
//   { start, end, score }                  accepted
const Q = 3;
const GRAM_BITS = 16;
const FUZZY_MAX_CELLS = 1e7;

function hash3(a, b, c) {
  return (Math.imul(a, 0x9E3779B1) ^ Math.imul(b, 0x85EBCA77) ^ Math.imul(c, 0xC2B2AE3D)) >>> (32 - GRAM_BITS);
}

function fuzzyMatch(haystack, needle, { minRatio = 0.85, ambiguityMargin = 0.02, maxCells = FUZZY_MAX_CELLS } = {}) {
  const nLines = trimBlankEdges(needle.split('\n'));
  if (!nLines.length) return null;
  const N = nLines.length;
  const anchorText = nLines.join('\n');
  const target = collapseWS(anchorText);
  const tlen = target.length;
  const hLines = haystack.split('\n');
  if (N > hLines.length) return null;
  const offs = lineOffsets(hLines);
  const cl = hLines.map(collapseWS);
  const floor = Math.max(0, minRatio - ambiguityMargin);

  // A window's text is its non-empty collapsed lines joined by ' '. Its
  // q-grams are each line's own plus, for every line but the first, those
  // spanning the join with the previous non-empty line.
  const cntT = new Int32Array(1 << GRAM_BITS);
  for (let i = 0; i + Q <= tlen; i++) cntT[hash3(target.charCodeAt(i), target.charCodeAt(i + 1), target.charCodeAt(i + 2))]++;
  const qT = Math.max(0, tlen - Q + 1);
  const L = hLines.length;
  const prevNE = new Int32Array(L);
  const nextNE = new Int32Array(L);
  for (let j = 0, last = -1; j < L; j++) { prevNE[j] = last; if (cl[j]) last = j; }
  for (let j = L - 1, next = L; j >= 0; j--) { nextNE[j] = next; if (cl[j]) next = j; }
  const cntW = new Int32Array(1 << GRAM_BITS);
  let shared = 0;
  const bump = (g, d) => {
    if (d > 0) { if (cntW[g] < cntT[g]) shared++; cntW[g]++; } else { cntW[g]--; if (cntW[g] < cntT[g]) shared--; }
  };
  const lineGrams = (j, d) => {
    const l = cl[j];
    for (let i = 0; i + Q <= l.length; i++) bump(hash3(l.charCodeAt(i), l.charCodeAt(i + 1), l.charCodeAt(i + 2)), d);
  };
  const jb = new Int32Array(2 * Q - 1);
  const joinGrams = (j, d) => {
    const p = cl[prevNE[j]], l = cl[j];
    const t = Math.min(Q - 1, p.length);
    let n = 0;
    for (let i = p.length - t; i < p.length; i++) jb[n++] = p.charCodeAt(i);
    jb[n++] = 32;
    for (let i = 0; i < Q - 1 && i < l.length; i++) jb[n++] = l.charCodeAt(i);
    for (let i = 0; i <= t && i + Q <= n; i++) bump(hash3(jb[i], jb[i + 1], jb[i + 2]), d);
  };
  const enter = (j, start) => { lineGrams(j, 1); if (cl[j] && prevNE[j] >= start) joinGrams(j, 1); };
  const lenPre = new Float64Array(L + 1);
  const nonEmptyPre = new Int32Array(L + 1);
  for (let j = 0; j < L; j++) {
    lenPre[j + 1] = lenPre[j] + cl[j].length;
    nonEmptyPre[j + 1] = nonEmptyPre[j] + (cl[j] ? 1 : 0);
  }

  // Pass 1: upper-bound score per window from the length and q-gram bounds
  // (every edit destroys at most Q of the anchor's q-grams).
  let cands = [];
  for (let j = 0; j < N - 1; j++) enter(j, 0);
  for (let i = 0; i + N <= L; i++) {
    enter(i + N - 1, i);
    if (cl[i] && cl[i + N - 1]) {
      const wlen = lenPre[i + N] - lenPre[i] + Math.max(0, nonEmptyPre[i + N] - nonEmptyPre[i] - 1);
      const maxLen = Math.max(wlen, tlen);
      const kFloor = Math.floor((1 - floor) * maxLen + 1e-9);
      const lb = Math.max(Math.abs(wlen - tlen), Math.ceil((qT - shared) / Q));
      if (lb <= kFloor) cands.push({ line: i, ub: 1 - lb / maxLen, lb, maxLen });
    }
    lineGrams(i, -1);
    if (cl[i] && nextNE[i] < i + N) joinGrams(nextNE[i], -1);
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.ub - a.ub || a.line - b.line);

  // Pass 2: score in bound order until no remaining window can matter.
  const targetHist = charHist(target);
  const lineId = new Map();
  const ids = new Int32Array(hLines.length);
  for (let j = 0; j < hLines.length; j++) {
    let id = lineId.get(cl[j]);
    if (id === undefined) { id = lineId.size; lineId.set(cl[j], id); }
    ids[j] = id;
  }
  const memo = new Map();
  let cells = 0;
  // Exact score of window c if it is >= minScore, else -1; null once the
  // work cap is hit. memo: exact score, or { below } (score < below).
  const evaluate = (c, minScore) => {
    const key = Array.prototype.join.call(ids.subarray(c.line, c.line + N), ',');
    const m = memo.get(key);
    if (typeof m === 'number') return m + 1e-12 >= minScore ? m : -1;
    if (m && m.below <= minScore) return -1;
    const k = Math.floor((1 - minScore) * c.maxLen + 1e-9);
    let w = cl[c.line];
    for (let j = c.line + 1; j < c.line + N; j++) if (cl[j]) w += ' ' + cl[j];
    if (bagDistanceLowerBound(w, targetHist) <= k) {
      // Growing band: windows that matter are usually close, so a narrow
      // band settles them; widen only while the distance may be <= k.
      for (let band = Math.min(k, Math.max(32, 2 * c.lb)); ; band = Math.min(k, band * 2)) {
        cells += Math.min(w.length, tlen) * (2 * band + 1);
        if (cells > maxCells) return null;
        const d = levenshtein(w, target, band);
        if (d <= band) {
          const sc = 1 - d / c.maxLen;
          memo.set(key, sc);
          return sc + 1e-12 >= minScore ? sc : -1;
        }
        if (band >= k) break;
      }
    }
    memo.set(key, { below: minScore });
    return -1;
  };
  const scored = [];
  const picked = [];
  const deferred = [];
  let best = null;
  const overlaps = (x, y) => Math.abs(x.line - y.line) < N;
  const span = (c) => {
    const lastLine = hLines[c.line + N - 1];
    const start = offs[c.line];
    const end = offs[c.line + N - 1] + lastLine.replace(/\s+$/, '').length;
    return { start, end, score: Number(c.score.toFixed(4)), line: c.line + 1 };
  };
  const budget = () => ({ budget: true, cells, closest: best ? span(best) : null });
  const need = () => Math.max(floor, best ? best.score - ambiguityMargin : 0);
  for (const c of cands) {
    if (c.ub + 1e-12 < need()) break;
    let sc;
    if (best && overlaps(c, best)) {
      // Overlapping the best window it is no runner-up; it only matters if
      // it beats the best (else revisited below if the best moves).
      if (c.ub <= best.score + 1e-12) { deferred.push(c); continue; }
      sc = evaluate(c, best.score + 1e-9);
      if (sc === null) return budget();
      if (sc < 0) { deferred.push(c); continue; }
    } else {
      sc = evaluate(c, need());
      if (sc === null) return budget();
      if (sc < 0) continue;
    }
    const s = { line: c.line, score: sc };
    scored.push(s);
    if (!best || sc > best.score) best = s;
    // Three mutually non-overlapping windows within the margin of a perfect
    // score: whichever window ends up best overlaps at most two of them.
    if (sc + 1e-12 >= 1 - ambiguityMargin && !picked.some(p => overlaps(p, s))) {
      picked.push(s);
      if (picked.length >= 3) {
        return { ambiguous: true, closest: span(best), runnerUp: span(picked.find(p => !overlaps(p, best))) };
      }
    }
  }
  for (const c of deferred) {
    if (overlaps(c, best) || c.ub + 1e-12 < need()) continue;
    const sc = evaluate(c, need());
    if (sc === null) return budget();
    if (sc >= 0) scored.push({ line: c.line, score: sc });
  }
  if (!best) return null;
  const closest = span(best);
  if (best.score < minRatio) return { below: true, closest };
  let runnerUp = null;
  for (const c of scored) {
    if (c === best || Math.abs(c.line - best.line) < N) continue;
    if (!runnerUp || c.score > runnerUp.score) runnerUp = c;
  }
  if (runnerUp && runnerUp.score >= best.score - ambiguityMargin - 1e-12) {
    return { ambiguous: true, closest, runnerUp: span(runnerUp) };
  }
  if (!tokensEqual(haystack.slice(closest.start, closest.end), anchorText)) {
    return { mismatch: true, closest };
  }
  return { start: closest.start, end: closest.end, score: best.score };
}

// ---- region safety for the whitespace and fuzzy tiers
//
// Those tiers accept a region whose whitespace differs from the anchor. That
// is only sound where whitespace is insignificant, so the region and the
// anchor are lexed and compared: literal and comment text must match, a line
// break may be added or removed only where it cannot change the parse (JS:
// not after return/throw/break/continue/yield/async, not before ++/--/=>;
// other languages: never), and Python lines must keep the same relative
// indentation structure.

function langOf(file) {
  if (/\.py$/i.test(file || '')) return 'python';
  if (!file || /\.(c|m)?(j|t)sx?$/i.test(file)) return 'js';
  return 'generic';
}

const PUNCT = ['>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '...', '??=', '&&=', '||=', '//=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '**', '<<', '>>', '->', '::', '//',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const RESTRICTED = new Set(['return', 'throw', 'break', 'continue', 'yield', 'async']);
const NO_BREAK_BEFORE = new Set(['++', '--', '=>']);
const IDENT_START = /[A-Za-z_$À-￿]/;
const IDENT_PART = /[\w$À-￿]/;

function scanQuoted(s, i, q) {
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') j += 2;
    else if (ch === q) return j + 1;
    else if (ch === '\n') return j;
    else j++;
  }
  return s.length;
}

function scanTriple(s, i) {
  const q = s.slice(i, i + 3);
  let j = i + 3;
  while (j < s.length) {
    if (s[j] === '\\') j += 2;
    else if (s.startsWith(q, j)) return j + 3;
    else j++;
  }
  return s.length;
}

function scanBraces(s, j) {
  let depth = 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '"' || ch === "'") j = scanQuoted(s, j, ch);
    else if (ch === '`') j = scanTemplate(s, j);
    else if (ch === '{') { depth++; j++; } else if (ch === '}') { j++; if (!--depth) return j; } else j++;
  }
  return s.length;
}

function scanTemplate(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') j += 2;
    else if (ch === '`') return j + 1;
    else if (ch === '$' && s[j + 1] === '{') j = scanBraces(s, j + 2);
    else j++;
  }
  return s.length;
}

function scanRegex(s, i) {
  let j = i + 1;
  let inClass = false;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\n') return -1;
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      j++;
      while (j < s.length && /[a-z]/i.test(s[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

function indentWidth(ws) {
  let w = 0;
  for (const ch of ws) w = ch === '\t' ? w + 8 - (w % 8) : w + 1;
  return w;
}

// -> [{ t, k: 'word'|'punct'|'str'|'comment', nl, ind }]. `nl`: a line break
// precedes the token; `ind`: its line's indentation width when it starts a
// line (first token: its leading whitespace), else -1.
function lexRegion(s, lang) {
  const py = lang === 'python';
  const toks = [];
  let i = 0;
  let wsStart = 0;
  const push = (end, k) => {
    const ws = s.slice(wsStart, i);
    const nl = ws.includes('\n');
    const lineStart = nl || !toks.length;
    toks.push({ t: s.slice(i, end), k, nl, ind: lineStart ? indentWidth(ws.slice(ws.lastIndexOf('\n') + 1)) : -1 });
    i = end;
    wsStart = end;
  };
  while (i < s.length) {
    const ch = s[i];
    if (isWs(s.charCodeAt(i))) { i++; continue; }
    const prev = toks[toks.length - 1];
    if (py ? ch === '#' : (ch === '/' && s[i + 1] === '/')) {
      const e = s.indexOf('\n', i);
      push(e < 0 ? s.length : e, 'comment');
    } else if (!py && ch === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      push(e < 0 ? s.length : e + 2, 'comment');
    } else if (py && (s.startsWith('"""', i) || s.startsWith("'''", i))) {
      push(scanTriple(s, i), 'str');
    } else if (ch === '"' || ch === "'") {
      push(scanQuoted(s, i, ch), 'str');
    } else if (!py && ch === '`') {
      push(scanTemplate(s, i), 'str');
    } else if (!py && ch === '/' && (!prev || (prev.k === 'punct' && !/^[)\]}]$|^(\+\+|--)$/.test(prev.t)) || (prev.k === 'word' && REGEX_AFTER.has(prev.t))) && scanRegex(s, i) > 0) {
      push(scanRegex(s, i), 'str');
    } else if (IDENT_START.test(ch) || /\d/.test(ch)) {
      let e = i + 1;
      const part = /\d/.test(ch) ? /[\w.]/ : IDENT_PART;
      while (e < s.length && part.test(s[e])) e++;
      push(e, 'word');
    } else {
      const op = PUNCT.find(p => s.startsWith(p, i) && (py || !p.startsWith('//')));
      push(i + (op ? op.length : 1), 'punct');
    }
  }
  return toks;
}

// Leading-whitespace width of the line `pos` sits on, or null when something
// other than whitespace precedes `pos` on that line.
function lineIndentAt(src, pos) {
  let k = pos;
  while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
  const lineStart = src.lastIndexOf('\n', k - 1) + 1;
  const before = src.slice(lineStart, k);
  return /^[ \t]*$/.test(before) ? indentWidth(before) : null;
}

// Why replacing `src[start, end)` on the strength of `anchor` would change
// behaviour, or null. -> { reason, detail }
function regionHazard(src, start, end, anchor, lang = 'js') {
  const r = lexRegion(src.slice(start, end), lang);
  const a = lexRegion(anchor, lang);
  const n = Math.min(r.length, a.length);
  const same = (x, y) => x.k === y.k && (x.k === 'comment' ? collapseWS(x.t) === collapseWS(y.t) : x.t === y.t);
  for (let i = 0; i < n; i++) {
    if (!same(r[i], a[i])) {
      const k = [r[i].k, a[i].k].includes('comment') ? 'comment' : [r[i].k, a[i].k].includes('str') ? 'str' : null;
      return {
        reason: k === 'comment' ? 'comment_boundary' : k === 'str' ? 'literal_whitespace' : 'token_mismatch',
        detail: `region has ${JSON.stringify(r[i].t.slice(0, 80))} where the anchor has ${JSON.stringify(a[i].t.slice(0, 80))}`
      };
    }
  }
  if (r.length !== a.length) return { reason: 'token_mismatch', detail: `region has ${r.length} tokens, anchor ${a.length}` };
  for (let i = 1; i < n; i++) {
    if (r[i].nl === a[i].nl) continue;
    const p = r[i - 1].t, t = r[i].t;
    const where = `line break ${r[i].nl ? 'in the file' : 'in the anchor'} between ${JSON.stringify(p.slice(0, 40))} and ${JSON.stringify(t.slice(0, 40))}`;
    if (lang !== 'js') return { reason: 'line_structure', detail: where };
    if (RESTRICTED.has(p) || NO_BREAK_BEFORE.has(t)) return { reason: 'asi_boundary', detail: where };
  }
  if (lang === 'python') {
    const pairs = [];
    const r0 = lineIndentAt(src, start);
    const a0 = a.length ? a[0].ind : -1;
    if (n && (r0 === null) !== (a0 < 0)) return { reason: 'indentation', detail: 'region and anchor disagree on whether the first line starts a line' };
    if (n && r0 !== null) pairs.push([a0, r0]);
    for (let i = 1; i < n; i++) if (r[i].nl) pairs.push([a[i].ind, r[i].ind]);
    const map = new Map();
    for (const [x, y] of pairs) {
      if (map.has(x) && map.get(x) !== y) return { reason: 'indentation', detail: `anchor indent ${x} maps to file indents ${map.get(x)} and ${y}` };
      map.set(x, y);
    }
    const keys = [...map.keys()].sort((x, y) => x - y);
    for (let i = 1; i < keys.length; i++) {
      if (map.get(keys[i]) <= map.get(keys[i - 1])) {
        return { reason: 'indentation', detail: `anchor indents ${keys[i - 1]} < ${keys[i]} but file indents ${map.get(keys[i - 1])} >= ${map.get(keys[i])}` };
      }
    }
  }
  return null;
}

function describeClosest(c) {
  return c ? ` (closest: line ${c.line}, offsets ${c.start}-${c.end}, score ${c.score})` : '';
}

function countLabel(n) {
  return n >= MAX_OCCURRENCES ? `${n}+` : String(n);
}

function refuseIfHazard(haystack, m, needle, lang, tier) {
  const h = regionHazard(haystack, m.start, m.end, needle, lang);
  if (!h) return;
  throw new AnchorError(`${tier}-tier match refused: ${h.reason} (${h.detail})`, {
    tier,
    detail: { reason: h.reason, detail: h.detail, start: m.start, end: m.end }
  });
}

// `lang` ('js' | 'python' | 'generic', see langOf) selects the
// whitespace-significance rules applied to whitespace and fuzzy matches.
function findAnchor(haystack, needle, { lang = 'js' } = {}) {
  if (!needle) throw new AnchorError('empty anchor', { tier: 'none' });

  // 1. exact
  let r = exactMatch(haystack, needle);
  if (r && !r.ambiguous) return { tier: 'exact', start: r.start, end: r.end };
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${countLabel(r.count)} locations (exact); ambiguous`, { tier: 'exact', detail: { occurrences: r.count } });
  }

  // 2. indent-shift (line-structure preserving, so tried before whitespace)
  r = indentShiftMatch(haystack, needle);
  if (r && !r.ambiguous) {
    return { tier: 'indent-shift', start: r.start, end: r.end, delta: r.delta, indent: r.indent, anchorIndent: r.anchorIndent };
  }
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${r.count} locations (indent-shift); ambiguous`, { tier: 'indent-shift', detail: { occurrences: r.count, deltas: r.deltas } });
  }

  // 3. whitespace-normalized
  r = whitespaceMatch(haystack, needle);
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${countLabel(r.count)} locations (whitespace-norm); ambiguous`, { tier: 'whitespace', detail: { occurrences: r.count } });
  }
  if (r) {
    refuseIfHazard(haystack, r, needle, lang, 'whitespace');
    return { tier: 'whitespace', start: r.start, end: r.end };
  }

  // 4. fuzzy
  r = fuzzyMatch(haystack, needle);
  if (r && r.budget) {
    throw new AnchorError(`fuzzy_budget: fuzzy anchor search stopped after ${r.cells} Levenshtein cells${describeClosest(r.closest)}`, { tier: 'fuzzy', detail: { reason: 'fuzzy_budget', cells: r.cells, closest: r.closest } });
  }
  if (r && r.ambiguous) {
    throw new AnchorError(`fuzzy anchor ambiguous: runner-up within 0.02 of best${describeClosest(r.closest)}`, { tier: 'fuzzy', detail: { closest: r.closest, runner_up: r.runnerUp } });
  }
  if (r && r.mismatch) {
    throw new AnchorError(`fuzzy anchor rejected: closest window is not token-identical to the anchor${describeClosest(r.closest)}`, { tier: 'fuzzy', detail: { closest: r.closest } });
  }
  if (r && !r.below) {
    refuseIfHazard(haystack, r, needle, lang, 'fuzzy');
    return { tier: 'fuzzy', start: r.start, end: r.end, score: r.score };
  }

  const closest = r && r.below ? r.closest : null;
  throw new AnchorError(`anchor not found at any tier${describeClosest(closest)}`, { tier: 'none', detail: { closest } });
}

// ---- replacement re-indentation (shared by indent-shift / whitespace / fuzzy)

function indentUnit(lines, base) {
  let minSpaces = Infinity;
  for (const l of lines) {
    if (isBlank(l)) continue;
    const ws = leadingWs(l);
    if (!ws.startsWith(base) || ws.length === base.length) continue;
    if (l.slice(ws.length).startsWith('*')) continue; // block-comment continuation
    const rel = ws.slice(base.length);
    if (rel[0] === '\t') return '\t';
    if (/^ +$/.test(rel) && rel.length >= 2) minSpaces = Math.min(minSpaces, rel.length);
  }
  return Number.isFinite(minSpaces) ? ' '.repeat(minSpaces) : null;
}

function fileIndentUnit(src) {
  const lines = src.split('\n', 5000);
  let tabs = 0, spaced = 0;
  const steps = new Map();
  let prev = 0;
  for (const l of lines) {
    if (isBlank(l)) continue;
    const ws = leadingWs(l);
    if (ws[0] === '\t') tabs++;
    else if (ws.length) spaced++;
    if (!ws.includes('\t') && !l.slice(ws.length).startsWith('*')) {
      const step = ws.length - prev;
      if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) || 0) + 1);
      prev = ws.length;
    }
  }
  if (tabs > spaced) return '\t';
  let best = null, bestN = 0;
  for (const [s, n] of steps) if (n > bestN) { best = s; bestN = n; }
  return best ? ' '.repeat(best) : null;
}

function convertRel(rel, from, to) {
  if (!rel || !from || !to || from === to) return rel;
  const levels = rel.length / from.length;
  if (Number.isInteger(levels) && from.repeat(levels) === rel) return to.repeat(levels);
  return rel;
}

// Re-indent `replacement` so it lands at the indentation of the region
// `match` selected in `src`. `anchor` is the current_code the match was
// made from (its first non-blank line defines the anchor's base indent).
function reindentReplacement(src, match, anchor, replacement) {
  if (!match || match.tier === 'exact') return replacement;
  if (match.tier === 'indent-shift') {
    return shiftIndent(replacement, match.anchorIndent || '', match.indent || '');
  }
  const repLines = trimBlankEdges(replacement.replace(/\s+$/, '').split('\n'));
  if (!repLines.length) return '';
  const lineStart = src.lastIndexOf('\n', match.start - 1) + 1;
  const before = src.slice(lineStart, match.start);
  const lineEnd = src.indexOf('\n', lineStart);
  const firstLine = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
  const targetBase = leadingWs(firstLine);
  const inline = /^[ \t]*$/.test(before);

  const aLines = anchor.split('\n');
  const aFirst = aLines.find(l => !isBlank(l)) || '';
  const anchorBase = leadingWs(aFirst);
  const regionLines = src.slice(lineStart, match.end).split('\n');
  const anchorUnit = indentUnit(aLines, anchorBase) || indentUnit(repLines, anchorBase);
  let targetUnit = indentUnit(regionLines, targetBase);
  if (!targetUnit) targetUnit = targetBase.includes('\t') ? '\t' : fileIndentUnit(src);

  const out = repLines.map((l) => {
    if (isBlank(l)) return '';
    const ws = leadingWs(l);
    const rest = l.slice(ws.length);
    const rel = ws.startsWith(anchorBase) ? ws.slice(anchorBase.length) : '';
    return targetBase + convertRel(rel, anchorUnit, targetUnit) + rest;
  });
  out[0] = inline ? out[0].slice(before.length) : out[0].slice(leadingWs(out[0]).length);
  return out.join('\n');
}

module.exports = {
  findAnchor,
  langOf,
  regionHazard,
  AnchorError,
  exactMatch,
  whitespaceMatch,
  indentShiftMatch,
  fuzzyMatch,
  similarity,
  levenshtein,
  collapseWS,
  tokenize,
  tokensEqual,
  shiftIndent,
  reindent,
  commonLeftIndent,
  reindentReplacement
};
